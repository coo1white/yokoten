// `yokoten` with no command, `init`, `update`, `install` and `uninstall`: they write yokoten into a project or a machine.

import { existsSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { ghIn } from '../host/github/index.ts';
import { loadConfig } from '../rules/config.ts';
import { homeOf, NO_HOME } from '../rules/privacy.ts';
import { formatFinding } from '../rules/message.ts';
import { init, trust, undoTrust, updateCoreRules } from '../setup/init.ts';
import { type Ask, install, isMachineSetUp, uninstall } from '../setup/install.ts';
import { readOriginUrl, setUpPlanning } from '../setup/plan.ts';
import { type Invocation, noRootFinding, type Output, parse, print, requireRoot, rootOf, usage } from './shared.ts';

/**
 * `yokoten` with no command: the one command that gets a project running (#548). It installs
 * on the machine when that is missing, adds the rules to this project when that is missing,
 * and ends with the road, so a beginner reads the next step and nothing else. Each step is
 * already safe by default: install writes its own files, and init only adds (#120, record 0014).
 */
export async function runStart(invocation: Invocation): Promise<number> {
  const { env, cwd } = invocation;
  const root = rootOf(cwd, env);
  // Outside a project yokoten writes nothing: the first step is git's, not ours.
  if (!root) {
    const missing = noRootFinding(cwd, env);
    print(invocation, [
      `yokoten: ${formatFinding(missing)}.`,
      'A project starts with git: run `git init` here, then `yokoten` again.',
      'Run `yokoten help` to see every command.',
    ], invocation.stderr);
    return 1;
  }
  // No home folder means no place to install into (#548). Say it the way install does,
  // instead of letting a path throw: a beginner reads one plain line, not a stack trace.
  if (!homeOf(env)) {
    print(invocation, [`${NO_HOME}. Set HOME to your home folder's full path and run \`yokoten\` again.`], invocation.stderr);
    return 1;
  }
  // Each step that ran reports whether it is done: an install that failed is not "Setup is done" (#548).
  const stepResults: boolean[] = [];
  if (!isMachineSetUp(env)) {
    print(invocation, ['yokoten is not installed on this machine yet: installing it once for every project.']);
    const done = install(env, { cwd, gh: ghIn(cwd, env, 3000), ask: askWhenTerminal(invocation) });
    print(invocation, done.lines);
    stepResults.push(done.ok);
  }
  if (!hasProjectRules(root)) {
    print(invocation, ['This project has no yokoten rules yet: adding them now, and never overwriting a file of yours.']);
    const done = init(root, env, undefined, { ask: askWhenTerminal(invocation) });
    print(invocation, done.lines);
    stepResults.push(done.ok);
  }
  // After two reports, a reader needs to know that the road below is the point of it all.
  if (stepResults.length && stepResults.every((isOk) => isOk)) print(invocation, ['Setup is done. Here is where this project is now:']);
  return (await import('./advice/doctor.ts')).runDoctor(invocation);
}

/** True when init has already put the rules in this project. */
const hasProjectRules = (root: string): boolean =>
  existsSync(resolve(root, 'AGENTS.md')) && existsSync(resolve(root, 'yokoten.json'));

/**
 * Whether someone is at the terminal. Trust has no question, so this is what makes its
 * write the person's decision rather than a pipe's (#661).
 */
const isAtTerminal = (invocation: Invocation): boolean => invocation.stdin.stream.isTTY === true && invocation.stdout.isTTY === true;

/**
 * The terminal to ask on, or undefined in a pipe, a hook or CI (#433): an asked question
 * with nobody there would stop the command.
 */
const askWhenTerminal = (invocation: Invocation): Ask | undefined => {
  const { stdin, stdout } = invocation;
  return stdin.fd !== null && stdin.stream.isTTY && stdout.isTTY ? askOnTerminal(stdout, stdin.fd) : undefined;
};

export function runInit(invocation: Invocation): number {
  const options = parse('init', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  if (options.flags.has('--yes') && !options.flags.has('--github')) return usage(invocation, '--yes goes with --github');
  if (options.flags.has('--remove-default-labels') && !options.flags.has('--github')) return usage(invocation, '--remove-default-labels goes with --github');
  if (options.flags.has('--board') && !options.flags.has('--github')) return usage(invocation, '--board goes with --github');
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  // Checked before anything is written (#205): a typo never becomes a new folder.
  if (!existsSync(dir)) {
    print(invocation, [`yokoten init: ${options.positional[0]} does not exist; nothing was written. Create it and run \`git init\` there first.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  // Read first: a broken yokoten.json stops init before it writes a file.
  const { areas } = loadConfig(root);
  // The tests job is asked first (#550): only with a terminal on stdin and stdout, as install asks.
  const ask = askWhenTerminal(invocation);
  const done = init(root, invocation.env, undefined, { noCi: options.flags.has('--no-ci'), ask });
  print(invocation, done.lines);
  // The host is changed only when asked (#10): it is a remote, and other people see it.
  // Without --yes, init only reads it and says what it would do, or what it skipped.
  const planning = setUpPlanning(ghIn(root, invocation.env), readOriginUrl(root, invocation.env), {
    apply: options.flags.has('--yes'),
    removeDefaults: options.flags.has('--remove-default-labels'),
    areas,
    board: options.flags.has('--board'),
  });
  // --github --yes asked for changes on GitHub; a skip made none, so it fails (#208).
  const isRefused = planning.skipped && options.flags.has('--yes');
  print(invocation, planning.lines, planning.ok && !isRefused ? invocation.stdout : invocation.stderr);
  if (isRefused) print(invocation, ['yokoten init: --github --yes changed nothing on GitHub (the reason is above). The project files are as listed above.'], invocation.stderr);
  return planning.ok && !isRefused && done.ok ? 0 : 1;
}

export function runTrust(invocation: Invocation): number {
  const options = parse('trust', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // A person turns the guard on (#661): a pipe, a hook or CI has nobody to decide, and an
  // agent that ran the command would change the trust in its user's own settings.
  if (!isAtTerminal(invocation)) {
    print(invocation, [
      'yokoten trust: a person runs this at a terminal, because it changes the trust in your own agent settings.',
      'Nothing was written. Run `yokoten trust` in your terminal.',
    ], invocation.stderr);
    return 1;
  }
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print(invocation, [`yokoten trust: ${options.positional[0]} does not exist; nothing was written.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const done = options.flags.has('--undo') ? undoTrust(root, invocation.env) : trust(root, invocation.env);
  print(invocation, done.lines);
  return done.ok ? 0 : 1;
}

export function runUpdate(invocation: Invocation): number {
  // Its own command, not an init flag: init promises to add only, never to overwrite (#120).
  const options = parse('update', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print(invocation, [`yokoten update: ${options.positional[0]} does not exist; nothing to update.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const { ok, lines } = updateCoreRules(root, { write: options.flags.has('--write') });
  print(invocation, [`yokoten update: ${lines[0]}`, ...lines.slice(1)], ok ? invocation.stdout : invocation.stderr);
  return ok ? 0 : 1;
}

/**
 * Ask one question on the terminal and read one line back, or null at end of input. Install
 * is synchronous, so it reads stdin a byte at a time; it is used only when stdin is a terminal.
 */
const askOnTerminal = (stdout: Output, fd: number): Ask => (question) => {
  stdout.write(`${question} `);
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let count: number;
    try {
      count = readSync(fd, byte, 0, 1, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      return null;
    }
    if (count === 0) return bytes.length ? Buffer.from(bytes).toString('utf8') : null;
    if (byte[0] === 10) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    bytes.push(byte[0]);
  }
};

export function runInstall(invocation: Invocation): number {
  const options = parse('install', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // The PATH question needs someone to answer it: never in a pipe, a hook or CI (#433).
  const ask = askWhenTerminal(invocation);
  // gh may reach the network for the login: three seconds at most.
  const done = install(invocation.env, { cwd: invocation.cwd, gh: ghIn(invocation.cwd, invocation.env, 3000), ask });
  print(invocation, done.lines);
  return done.ok ? 0 : 1;
}

export function runUninstall(invocation: Invocation): number {
  const options = parse('uninstall', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const done = uninstall(invocation.env);
  print(invocation, done.lines);
  return done.ok ? 0 : 1;
}
