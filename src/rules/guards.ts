// The rules an agent works under. Each check returns null to let the action go on, or a
// finding: what it stops, why, and what the agent does instead.
//
// `env` is the guard's own environment, which the session sets and the agent cannot change.
// The command text is never read for it: `YOKOTEN_FIX_TASK=0 git commit` inside a command
// changes nothing. A session is the lead unless whoever started it set YOKOTEN_ROLE=worker
// (the dispatch skill does, for each worker it starts).
//
// This is a guard against mistakes and drift, not a lock. It reads command text, so a
// command built up in pieces gets past it. The lock is on the server: branch protection,
// CODEOWNERS, and a release token the agents do not hold.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Config, Env } from './config.ts';
import { matcher } from './config.ts';
import { type Finding, finding } from './message.ts';

/** A file edit, by path relative to the repo root. */
export function checkEdit(path: string, { config, env }: { config: Config; env: Env }): Finding | null {
  if (env.YOKOTEN_FIX_TASK === '1' && matcher(config.tests)(path)) {
    return finding('test-file', `${path} is a test file, and this is a fix task (YOKOTEN_FIX_TASK=1)`, 'if the test is wrong, stop and say so in your report');
  }
  if (env.YOKOTEN_ROLE === 'worker' && matcher(config.leadOnly)(path)) {
    return finding('lead-only', `${path} is lead-only (yokoten.json "leadOnly")`, 'stop and hand the change to the lead');
  }
  return null;
}

/**
 * A shell command, as the agent wrote it. `config` brings the programs the project blocks
 * (yokoten.json "commands.block"); without it, only the core rules apply. `cwd` is the
 * folder the command runs in, by default this process's: a change to core.hooksPath reads
 * that repo's setting and hooks.
 */
export function checkCommand(command: string, options: { env: Env; config?: Pick<Config, 'commands'>; cwd?: string }): Finding | null {
  // The reader is not a full parser. Whatever goes wrong inside it, the command is refused,
  // never let through: an error here must not open the guard.
  try {
    return checkEachCommand(command, options);
  } catch {
    return finding('unreadable-command', 'yokoten could not read this command', 'split it into simpler commands, one per call');
  }
}

function checkEachCommand(command: string, { env, config, cwd = process.cwd() }: { env: Env; config?: Pick<Config, 'commands'>; cwd?: string }): Finding | null {
  for (const words of commandWords(command)) {
    const reason = checkGit(words, { env, config, cwd }) ?? checkHooksEnvironment(words) ?? checkPublish(words, env) ?? checkBlocked(words, config?.commands.block ?? {});
    if (reason) return reason;
  }
  return null;
}

const RELEASE_FIX = 'if the owner asked for this, they start a new session with YOKOTEN_RELEASE_APPROVAL=1 (`YOKOTEN_RELEASE_APPROVAL=1 claude`); do not look for another way';
const release = (what: string) => finding('release', what, RELEASE_FIX);

const base = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
const isGit = (word: string) => /(^|[/\\])git(\.exe)?$/.test(word);
// Git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source']);

// Each check looks for its program anywhere in the command, so a prefix such as FOO=1,
// sudo, env, command, exec, time, nice, nohup, timeout or xargs does not hide it.
function checkGit(words: string[], { env, config, cwd }: { env: Env; config?: Pick<Config, 'commands'>; cwd: string }): Finding | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  const settings: string[] = [];
  const fromEnvironment: string[] = []; // --config-env name=VARIABLE
  // The folder git works in: `-C` moves it. With --git-dir or --work-tree, the guard
  // does not know the repo, so it is null.
  let directory: string | null = cwd;
  let i = start + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C' && directory !== null) directory = resolve(directory, words[i + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(words[i])) directory = null;
    if (words[i] === '-c') settings.push(words[i + 1] ?? '');
    if (words[i] === '--config-env') fromEnvironment.push(words[i + 1] ?? '');
    if (words[i].startsWith('--config-env=')) fromEnvironment.push(words[i].slice('--config-env='.length));
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);

  const hooks = checkHooksSettings(settings, fromEnvironment);
  if (hooks) return hooks;
  if (settings.some((s) => /^push\.followtags/i.test(s)) && !env.YOKOTEN_RELEASE_APPROVAL) {
    return release('git -c push.followTags pushes tags');
  }
  // `git -c alias.x='!cmd' x` runs cmd through a shell.
  for (const s of settings) {
    const alias = /^alias\.[^=]*=!(.*)$/is.exec(s);
    const reason = alias && checkCommand(alias[1], { env, config, cwd });
    if (reason) return reason;
  }
  if (sub === 'push') {
    if (!env.YOKOTEN_RELEASE_APPROVAL) {
      const tagFlag = args.find((a) => ['--tags', '--follow-tags', '--mirror'].includes(a));
      if (tagFlag) return release(`git push ${tagFlag} pushes tags`);
      const tagRef = args.find((a) => /(^|[:+])(refs\/tags\/|v\d)/.test(a));
      if (tagRef) return release(`git push ${tagRef} pushes a release tag`);
    }
    const force = args.find((a) => a === '--force' || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'));
    if (force) return finding('force-push', `git push ${force} forces the push`, 'use --force-with-lease, which stops when the remote has work you have not seen');
  }
  const skip = args.includes('--no-verify') ? '--no-verify' : sub === 'commit' ? args.find((a) => /^-[a-z]*n[a-z]*$/i.test(a)) : undefined;
  if (skip) return finding('skip-check', `git ${sub} ${skip} skips the commit check`, 'fix what the check reports instead');
  if (sub === 'config') return checkConfig(args, directory);
  return null;
}

// ---- The hooks setting (#114) ----
//
// git runs the commit check from core.hooksPath. Reading the setting is fine. Any value
// but .githooks can turn the check off: for good with `git config`, or for one command with
// `git -c`, `--config-env` or GIT_CONFIG_KEY_n. Keys are case-insensitive, as in git.
// A value the guard cannot see (from a variable) blocks.
//
// `git config` in the repo's own config may also set the value already set, or a folder
// whose pre-commit runs `yokoten check` (#217): husky's `.husky/_`, or a folder
// `yokoten init` kept.

const HOOKS_DIR = '.githooks';
const HOOKS_FIX = 'leave it as it is; another folder is fine once its pre-commit runs `yokoten check` (`yokoten init` adds it there)';
const isHooksPath = (key: string) => key.trim().toLowerCase() === 'core.hookspath';
const hooksPath = (what: string, fix = HOOKS_FIX) => finding('hooks-path', what, fix);

// `git -c core.hooksPath=<value>` and `--config-env core.hooksPath=<VARIABLE>`.
function checkHooksSettings(settings: string[], fromEnvironment: string[]): Finding | null {
  if (fromEnvironment.some((s) => isHooksPath(s.split('=')[0]))) {
    return hooksPath('git --config-env core.hooksPath sets the hooks folder from a variable, which can skip the commit check');
  }
  for (const setting of settings) {
    const equals = setting.indexOf('=');
    const key = equals === -1 ? setting : setting.slice(0, equals);
    if (isHooksPath(key) && (equals === -1 || setting.slice(equals + 1) !== HOOKS_DIR)) {
      return hooksPath('git -c core.hooksPath with a value other than .githooks skips the commit check for that command');
    }
  }
  return null;
}

// `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=x git commit` does
// what `git -c` does, and so does GIT_CONFIG_PARAMETERS, the variable `-c` itself sets.
// An assignment counts when it stands before the program, after env, sudo or export, or
// anywhere before a git word. So `grep GIT_CONFIG_KEY_0=core.hooksPath file` is a read.
const ASSIGNERS = new Set(['env', 'sudo', 'doas', 'export', 'declare', 'typeset', 'readonly', 'local']);
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function checkHooksEnvironment(words: string[]): Finding | null {
  for (const [index, word] of words.entries()) {
    const variable = /^GIT_CONFIG_(KEY_(\d+)|PARAMETERS)=(.*)$/is.exec(word);
    if (!variable) continue;
    const isPrefix = words.slice(0, index).every((w) => isAssignment(w) || w.startsWith('-') || ASSIGNERS.has(base(w)));
    if (!isPrefix && !words.slice(index + 1).some(isGit)) continue;
    const [, name, number, setting] = variable;
    if (name.toUpperCase() === 'PARAMETERS') {
      if (setting.toLowerCase().includes('core.hookspath')) return hooksPath('GIT_CONFIG_PARAMETERS names core.hooksPath, which can skip the commit check');
      continue;
    }
    if (!isHooksPath(setting)) continue;
    const valueName = `git_config_value_${number}=`;
    const value = words.find((w) => w.toLowerCase().startsWith(valueName));
    if (value?.slice(valueName.length) !== HOOKS_DIR) {
      return hooksPath(`GIT_CONFIG_KEY_${number} names core.hooksPath with a value other than .githooks, which skips the commit check`);
    }
  }
  return null;
}

// `git config` options that take the next word as their value.
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l', 'get', 'list']);
const CONFIG_REMOVES = new Set(['--unset', '--unset-all', 'unset', '--edit', '-e', 'edit']);
const CONFIG_SECTIONS = new Set(['--rename-section', '--remove-section', 'rename-section', 'remove-section']);
// git 2.46 and later also takes a subcommand: `git config get|list|set|unset|...`.
const CONFIG_SUBCOMMANDS = new Set(['get', 'list', 'set', 'unset', 'edit', 'rename-section', 'remove-section']);

// Splits `git config` arguments into options and plain words. The old form (`isOldForm`)
// reads options only before the first plain word: `git config core.hooksPath --local`
// sets the value "--local". The subcommand form reads options anywhere.
function splitConfig(args: string[], isOldForm: boolean): { options: string[]; plain: string[] } {
  const options: string[] = [];
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((isOldForm && plain.length > 0) || !args[i].startsWith('-') || args[i] === '-') plain.push(args[i]);
    else if (args[i] === '--') {
      plain.push(...args.slice(i + 1));
      break;
    } else {
      options.push(args[i]);
      if (CONFIG_VALUE_OPTIONS.has(args[i])) i++;
    }
  }
  return { options, plain };
}

// `git config`: a read passes; a change to core.hooksPath passes only to .githooks, or as
// checkHooksFolder allows. `directory` is the folder git works in, or null when unknown.
function checkConfig(args: string[], directory: string | null): Finding | null {
  let { options, plain } = splitConfig(args, true);
  const subcommand = CONFIG_SUBCOMMANDS.has(plain[0]) ? plain[0] : undefined;
  if (subcommand) {
    const rest = splitConfig(plain.slice(1), false);
    options = [...options, ...rest.options];
    plain = rest.plain;
  }
  const actions = subcommand ? [subcommand] : options;
  const section = actions.find((a) => CONFIG_SECTIONS.has(a));
  if (section) {
    return plain.some((w) => w.toLowerCase() === 'core') ? hooksPath(`git config ${section} core changes core.hooksPath, which turns off the commit check`) : null;
  }
  if (!isHooksPath(plain[0] ?? '')) return null;
  const remove = actions.find((a) => CONFIG_REMOVES.has(a));
  if (remove) return hooksPath(`git config ${remove} core.hooksPath turns off the commit check`);
  if (actions.some((a) => CONFIG_READS.has(a))) return null;
  // A set: `git config <key> <value>`, --add, --replace-all or `git config set`.
  // With no value and no action, it is a read.
  const value = plain[1];
  const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
  if (value === undefined && !isSet) return null;
  if (value === HOOKS_DIR) return null;
  if (value === undefined) return hooksPath('git config set core.hooksPath with no value turns off the commit check');
  return checkHooksFolder(value, options, directory);
}

// Config that is not this repo's own: a change there reaches other repos, or none.
const OTHER_SCOPES = new Set(['--global', '--system', '-f', '--file', '--blob']);

// A new core.hooksPath in the repo's own config passes when it is the value already set,
// or when the folder's pre-commit runs `yokoten check`.
function checkHooksFolder(value: string, options: string[], directory: string | null): Finding | null {
  const scope = options.find((o) => OTHER_SCOPES.has(o.split('=')[0]));
  if (scope) return hooksPath(`git config ${scope} core.hooksPath changes the hooks folder outside this repo's own config, which can turn off the commit check`);
  const root = directory === null ? null : readGit(directory, ['rev-parse', '--show-toplevel']);
  if (root === null) return hooksPath('changing core.hooksPath where the guard cannot find the repo can turn off the commit check');
  if (readGit(root, ['config', '--get', 'core.hooksPath']) === value) return null;
  const file = hookFile(root, value);
  if (file === null) return hooksPath(`core.hooksPath ${value} is outside this repo, so the commit check does not run`);
  if (runsCheck(readText(join(root, file)))) return null;
  return hooksPath(`core.hooksPath ${value} turns off the commit check: ${file} does not run \`yokoten check\``, `add \`yokoten check\` to ${file} (\`yokoten init\` adds it), then set core.hooksPath again`);
}

/**
 * The pre-commit file git runs for this core.hooksPath, relative to the repo root, or null
 * when the folder is outside the repo. husky's folder (`.husky/_`, or `.husky` before
 * husky 9) runs `.husky/pre-commit`.
 */
export function hookFile(root: string, setting: string): string | null {
  const folder = relative(root, resolve(root, setting)).split('\\').join('/');
  if (folder === '..' || folder.startsWith('../') || isAbsolute(folder)) return null;
  if (folder === '.husky' || folder.startsWith('.husky/')) return '.husky/pre-commit';
  return folder ? `${folder}/pre-commit` : 'pre-commit';
}

/** A line of this script, not a comment, runs `yokoten check` (by any path, or `yokoten.ts`). */
export const runsCheck = (script: string): boolean =>
  script.split(/\r?\n/).some((line) => !line.trimStart().startsWith('#') && /\byokoten(\.ts)?["']?\s+check\b/.test(line));

// What git prints, trimmed, or null when it fails.
function readGit(directory: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// A word anywhere after the program counts, so an option in between (`npm --tag x publish`)
// does not hide it. `npm run publish` blocks too: the script may well publish.
function checkPublish(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_RELEASE_APPROVAL) return null;
  const after = (names: string[]) => {
    const i = words.findIndex((w) => names.includes(base(w).replace(/\.(exe|cmd)$/i, '')));
    return i === -1 ? [] : words.slice(i + 1);
  };
  const gh = after(['gh']);
  const sub = gh.indexOf('release');
  if (sub !== -1 && gh.slice(sub + 1).some((a) => ['create', 'upload', 'edit'].includes(a))) return release('gh release publishes a release');
  if (after(['npm', 'pnpm', 'yarn']).includes('publish')) return release('this publishes a package');
  return null;
}

// ---- Programs the project blocks (#192) ----
//
// yokoten.json "commands.block" names programs no agent runs here, each with its reason.
// Only a program counts, so `echo python` and `cat python.md` pass. A command can run
// more than one program, and `findPrograms` lists each:
//
// - the first word after assignments (FOO=1), redirects (`>out`, `2>&1`, `< in`) and
//   shell keywords (`then`, `do`, `!`);
// - after a launcher that runs the next word as a program (env, sudo, nice, timeout,
//   xargs, stdbuf, setsid, busybox and the others in LAUNCHERS), the word after its
//   options;
// - the program after `find ... -exec`, `-execdir`, `-ok` and `-okdir`;
// - the programs of the string `env -S` splits.
//
// A shell string (`bash -c '...'`, `ssh host '...'`, `flock f -c '...'`) is read by
// commandWords. A case pattern (`python3)`) is no command: the reader drops it.

// Shell keywords before a program: `if x`, `then x`, `do x`, `! x`. `time` is a launcher.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac', '!', '{', '}', '(']);
// A loop or case head names a variable and data, not a program: `for f in a b`.
const HEADS = new Set(['for', 'select', 'case', 'in']);

// Each launcher, with the options that take the next word as their value, and how many
// plain words come before the program (timeout's duration, chrt's priority, taskset's mask).
const LAUNCHERS: Record<string, { options: string[]; operands?: number }> = {
  env: { options: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  sudo: { options: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'] },
  doas: { options: ['-u', '-C'] },
  pkexec: { options: ['--user'] },
  command: { options: [] },
  exec: { options: ['-a'] },
  time: { options: ['-f', '--format', '-o', '--output'] },
  nice: { options: ['-n', '--adjustment'] },
  nohup: { options: [] },
  setsid: { options: [] },
  timeout: { options: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  xargs: { options: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'] },
  stdbuf: { options: ['-i', '-o', '-e'] },
  unbuffer: { options: [] },
  busybox: { options: [] },
  chrt: { options: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'], operands: 1 },
  ionice: { options: ['-c', '--class', '-n', '--classdata'] },
  taskset: { options: [], operands: 1 },
  numactl: { options: ['-N', '-m', '-C', '-p', '-i', '--cpunodebind', '--membind', '--physcpubind', '--preferred', '--interleave'] },
  chroot: { options: [], operands: 1 },
  flock: { options: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'], operands: 1 },
  faketime: { options: [], operands: 1 },
  fakeroot: { options: ['-l', '--lib', '--faked', '-s', '-i'] },
  eatmydata: { options: [] },
  nocache: { options: [] },
  catchsegv: { options: [] },
  strace: { options: ['-o', '-e', '-p', '-s', '-u', '-E', '-a', '-b', '-I', '-O', '-S', '-P', '-X'] },
  ltrace: { options: ['-o', '-e', '-p', '-s', '-u', '-a', '-n', '-l'] },
  firejail: { options: [] },
  proxychains: { options: ['-f'] },
  proxychains4: { options: ['-f'] },
  torsocks: { options: ['-u', '-p', '-a', '-P'] },
  'xvfb-run': { options: ['-n', '--server-num', '-e', '--error-file', '-f', '--auth-file', '-p', '--xauth-protocol', '-s', '--server-args', '-w', '--wait'] },
  caffeinate: { options: ['-t', '-w'] },
};
// find runs the program after each of these.
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// A redirect: `>out`, `2>&1`, `&>>log`, `<in`, or one with its file in the next word (`> out`).
const REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(?:>>|<<<|<>|>\||[<>]&|[<>])(.*)$/s;

/** How many words the redirect at `index` takes: 0 when the word is no redirect. */
function redirectLength(words: string[], index: number): number {
  const redirect = REDIRECT.exec(words[index] ?? '');
  if (!redirect) return 0;
  return redirect[1] === '' && index + 1 < words.length ? 2 : 1;
}

/** The index of the first word at or after `index` that is not an assignment, a redirect or a keyword. */
function skipPrefix(words: string[], index: number): number {
  while (index < words.length) {
    if (isAssignment(words[index]) || KEYWORDS.has(words[index])) index++;
    else if (redirectLength(words, index) > 0) index += redirectLength(words, index);
    else break;
  }
  return index;
}

/** A program's name: no folder and no .exe. */
const programName = (word: string) => base(word).replace(/\.exe$/i, '');

// The string `env -S` splits into a command, from the option at `index`, or undefined.
// A long option may be cut short, as getopt allows: `--split`, `--s`.
function splitString(words: string[], index: number): string | undefined {
  const option = words[index];
  const long = /^--(s[a-z-]*)(?:=(.*))?$/s.exec(option);
  if (long && 'split-string'.startsWith(long[1])) return long[2] ?? words[index + 1];
  const short = /^-[a-zA-Z]*S(.*)$/s.exec(option);
  if (short) return short[1] || words[index + 1];
  return undefined;
}

// At most this many programs from one command: a longer list is refused (see checkBlocked).
const MAX_PROGRAMS = 256;

/** The words that name the programs a command runs, in order. */
function findPrograms(words: string[]): string[] {
  const programs: string[] = [];
  // commandWords reads `bash -c 'x'` again as `-c x`: the shell's options come first.
  const start = words.findIndex((word) => !word.startsWith('-'));
  if (start === -1) return programs;
  const findAt = programAt(words, start, programs);
  // find runs the program after each -exec, -execdir, -ok and -okdir. One pass over the
  // words finds them all, a find inside a find too, without reading any word twice.
  if (findAt !== -1) {
    for (let action = findAt + 1; action < words.length && programs.length <= MAX_PROGRAMS; action++) {
      if (FIND_ACTIONS.has(words[action])) programAt(words, action + 1, programs);
    }
  }
  return programs;
}

// Adds the program of the command that starts at `index` to `programs`, after
// assignments, redirects, keywords and launchers, and the programs of an `env -S`
// string. Returns the index of the program when it is find, or -1.
function programAt(words: string[], index: number, programs: string[]): number {
  while (index < words.length) {
    index = skipPrefix(words, index);
    if (index >= words.length || HEADS.has(words[index])) return -1;
    const name = programName(words[index]);
    if (!Object.hasOwn(LAUNCHERS, name)) {
      programs.push(words[index]);
      return name === 'find' ? index : -1;
    }
    const launcher = LAUNCHERS[name];
    index++;
    // `command -v x` only says where x is; it does not run it.
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[index] ?? '')) return -1;
    while (index < words.length && words[index].startsWith('-')) {
      const split = name === 'env' ? splitString(words, index) : undefined;
      if (split !== undefined) {
        for (const command of commandWords(split)) for (const program of findPrograms(command)) programs.push(program);
      }
      index += launcher.options.includes(words[index]) ? 2 : 1;
    }
    index += launcher.operands ?? 0;
  }
  return -1;
}

function checkBlocked(words: string[], blockList: Record<string, string>): Finding | null {
  const programs = findPrograms(words);
  if (programs.length > MAX_PROGRAMS && Object.keys(blockList).length > 0) {
    return finding('unreadable-command', `yokoten could not read this command: it runs more than ${MAX_PROGRAMS} programs`, 'split it into simpler commands, one per call');
  }
  const name = programs.map(programName).find((program) => Object.hasOwn(blockList, program));
  if (name === undefined) return null;
  const reason = blockList[name].trim().replace(/\.+$/, '');
  return finding('blocked-command', `\`${name}\` is blocked in this project`, 'use the project\'s own stack instead; yokoten.json "commands.block" lists what is blocked', { why: reason });
}

// ---- Reading bash ----
//
// A small reader for everyday bash, not a full parser. It turns command text into a list
// of commands, each a list of words.
//
// - Quotes: '...', "..." (with \ escapes), $'...' and $"..." are part of one word. A
//   separator inside them does not cut the command.
// - Separators: ; & && || | |& ( ) { } and line ends. A \ before a line end joins lines.
//   A group `{ ...; }` or subshell `( ... )` stays open until its } or ).
// - A case pattern (`a|b)` after `case x in` or `;;`) is dropped: it names values.
// - A word that starts with # begins a comment, to the line end.
// - $(...), `...`, <(...) and >(...) run, so their text is read as commands, even in "...".
// - A heredoc body is data, unless a shell reads it (see `bodies`).
// - A shell, eval or ssh runs a string, so the words after it are read again as commands
//   (see `runString`).
//
// When the text is unclear, the guard blocks rather than guesses. An unclosed quote is
// dropped and the rest is read as plain words, so `echo 'x; npm publish` still blocks.
// Functions and aliases are not followed.

const MAX_DEPTH = 8;
const isShell = (word: string) => /^(?:ba|da|z|k|c|tc|fi|pw)?sh(?:\.exe)?$/.test(base(word));
// Programs that run a later word through a shell, beside the shells. A pattern means only
// with that option: sudo and doas pass their words to a program unless given -s or -i,
// and env unless given -S. xargs, nohup, time and the like run a program, not a shell
// string, so their words are already checked where they stand.
const RUNNERS: Record<string, RegExp | null> = {
  eval: null, ssh: null, su: null, runuser: null, watch: null, script: null, flock: null, parallel: null, tmux: null, screen: null,
  sudo: /^(-[a-zA-Z]*[si]|--shell|--login)/, doas: /^-[a-zA-Z]*s/, env: /^(-[a-zA-Z]*S|--s)/,
};

// Where a shell or a runner stands in the command, or -1. Anywhere counts: `find -exec sh
// -c`, `xargs sh -c` and `sudo bash -c` all run a string.
function runnerAt(words: string[]): number {
  return words.findIndex((w, i) => {
    if (isShell(w)) return true;
    const name = base(w);
    if (!Object.hasOwn(RUNNERS, name)) return false;
    const option = RUNNERS[name];
    return option === null || words.slice(i + 1).some((a) => option.test(a));
  });
}

// ssh options that take a value, in the same word (-p22) or the next (-p 22).
const SSH_VALUE_OPTIONS = 'BbcDEeFIiJLlmOoPpQRSWw';
// flock options that take a value. -c (--command) takes the shell string.
const FLOCK_VALUE_OPTIONS = 'wE';

// The text a runner at `at` hands to a shell. For most it is every word after the runner.
// ssh runs the words after its options and the host (`ssh -p 22 host 'x'`), and flock the
// string after -c (`flock f -c 'x'`) or the command after its file (`flock f x`).
function runString(words: string[], at: number): string {
  const name = base(words[at]);
  if (name === 'ssh') return words.slice(sshCommand(words, at + 1)).join(' ');
  if (name === 'flock') return flockCommand(words, at + 1);
  return words.slice(at + 1).join(' ');
}

// The index of the first word after ssh's options and host.
function sshCommand(words: string[], index: number): number {
  while (index < words.length && words[index].startsWith('-') && words[index] !== '-') {
    if (words[index] === '--') return index + 2;
    const option = words[index];
    const value = [...option.slice(1)].findIndex((letter) => SSH_VALUE_OPTIONS.includes(letter));
    // A value option last in its word takes the next word: `-tp 22`.
    index += value !== -1 && value === option.length - 2 ? 2 : 1;
  }
  return index + 1;
}

// flock's command: the string after -c or --command, before or after the file, or the
// words after the file.
function flockCommand(words: string[], index: number): string {
  let file = false;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith('--')) {
      const command = /^--command(?:=(.*))?$/s.exec(word);
      if (command) return command[1] ?? words[index + 1] ?? '';
      if (/^--(wait|timeout|conflict-exit-code)$/.test(word)) index++;
    } else if (word.startsWith('-') && word.length > 1) {
      for (let letter = 1; letter < word.length; letter++) {
        const rest = word.slice(letter + 1);
        if (word[letter] === 'c') return rest || (words[index + 1] ?? '');
        if (FLOCK_VALUE_OPTIONS.includes(word[letter])) {
          if (!rest) index++;
          break;
        }
      }
    } else if (!file) file = true;
    else return words.slice(index).join(' ');
  }
  return '';
}

/** Every command the text runs, as lists of words. Text that runs inside a command is listed too. */
export function commandWords(text: string, depth = 0): string[][] {
  const out: string[][] = [];
  read(text, 0, '', depth, out);
  return out;
}

interface Heredoc {
  delim: string;
  strip: boolean;
  quoted: boolean;
  /** The index, on its line, of the command that holds the <<. */
  cmd: number;
  /** The groups open around it, outermost first. */
  groups: Group[];
}

// A group `{ ...; }` or a subshell `( ... )`. What its commands print goes where the group
// sends it, so a heredoc body inside may reach a shell after the group: `{ cat <<EOF; } | bash`.
interface Group {
  kind: '(' | '{';
  /** The index, on the current line, of its first command, and of the one after it once closed. */
  from: number;
  to: number;
  /** Bodies of heredocs inside it that wait for where the group's output goes. */
  bodies: string[];
}

// Reads commands from `start` until `closer` (`)` or a backtick) or the end, and adds them
// to `out`. Returns the index after the closer, or -1 if a closer was wanted and not found.
function read(text: string, start: number, closer: string, depth: number, out: string[][]): number {
  // Too deep to follow: fall back to the rough cut, which finds more than is there.
  if (depth > MAX_DEPTH) {
    out.push(...rough(text.slice(start)));
    return text.length;
  }
  const nested = (s: string) => out.push(...commandWords(s, depth + 1));
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let isQuoted = false; // the word has a quote or a \ in it, so it is no keyword: `'case'`, `\case`
  let caseAt = -1; // where `case` stands in words, when it starts the command
  let line: string[][] = []; // the commands so far on this line, for heredocs
  let pipes: boolean[] = []; // for each of them, whether it pipes into the next
  let pending: Heredoc[] = [];
  let piped: string[] | null = null; // the command before a |
  const groups: Group[] = []; // the groups open now, outermost first
  let closed: Group | null = null; // a group that just closed, until we see where it sends its output
  let carried: string[] = []; // heredoc bodies a closed group pipes on, waiting for the command that reads them
  let cases = 0; // how many `case ... in` are open
  let isPattern = false; // reading a case pattern, up to its )
  let alternative = 0; // words in the pattern since the last |: more than one is no pattern

  const endWord = () => {
    const ended = inWord ? word : null;
    const isKeyword = !isQuoted;
    if (ended !== null) words.push(ended);
    word = '';
    inWord = false;
    isQuoted = false;
    if (ended === null) return;
    if (isPattern && ++alternative > 1) isPattern = false; // `a b)` is no pattern: read it as a command
    if (!isKeyword) return;
    const isFirst = words.slice(0, -1).every((w) => KEYWORDS.has(w));
    if (ended === 'esac' && isFirst && cases > 0) {
      cases--;
      isPattern = false;
    } else if (ended === 'case' && isFirst) {
      caseAt = words.length - 1;
    } else if (ended === 'in' && !isPattern) {
      // `case $x in`: what comes next is a pattern, not a command.
      if (caseAt !== -1 && words.length - 1 === caseAt + 2) {
        endCommand();
        cases++;
        isPattern = true;
        alternative = 0;
      }
    }
  };
  // Where a group that just closed sends the bodies inside it, and whether this command
  // reads bodies a group piped on. A body that reaches no reader stays data.
  const settle = (pipe: boolean) => {
    if (carried.length > 0 && words.length > 0) {
      const reads = readsCommands(words);
      if (reads) for (const body of carried) nested(body);
      if (reads || !pipe) carried = [];
    }
    if (closed) {
      if (pipe) {
        carried.push(...closed.bodies);
        // For the bodies read at this line's end: the group's commands pipe on, too.
        for (let i = closed.from; i < closed.to; i++) pipes[i] = true;
      } else groups.at(-1)?.bodies.push(...closed.bodies);
      closed = null;
    }
  };
  // The end of the text or of a substitution. Bodies that still wait for a reader, after a
  // pipe to nothing or in a group that never closed, are read as commands, not guessed.
  const finish = () => {
    endCommand();
    for (const body of [...carried, ...groups.flatMap((group) => group.bodies)]) nested(body);
  };
  const endCommand = (pipe = false) => {
    endWord();
    line.push(words);
    pipes.push(pipe);
    settle(pipe);
    if (words.length === 0) return;
    out.push(words);
    const at = runnerAt(words);
    if (at !== -1) {
      // `bash -c 'x'`, `eval "x"`, `ssh host 'x'`: read the string it runs as commands.
      nested(runString(words, at));
      // `echo 'npm publish' | bash`: the words before the pipe are the shell's input.
      if (piped) nested(piped.slice(1).join(' ').replace(/\\n/g, '\n'));
    }
    piped = pipe ? words : null;
    words = [];
    caseAt = -1;
  };

  let index = start;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    // A separator inside what looked like a pattern means it was none: the words so far, and
    // every command before, are read as commands. Only words since the last cut are dropped.
    const isCut = character === ';' || character === '&' || (character === '|' && next === '|') || ((character === '\n' || character === '(') && (inWord || words.length > 0));
    if (isPattern && isCut) isPattern = false;
    if (isPattern && (character === ')' || character === '|' || character === '(')) endWord();
    if (isPattern && (character === ')' || character === '|' || character === '(')) {
      // A case pattern, `a|b)` or `(a)`, names values, not programs. The commands come after the ).
      if (character === ')') {
        words = [];
        caseAt = -1;
        isPattern = false;
      }
      alternative = 0;
      index++;
      continue;
    }
    if (closer && character === closer && !(character === ')' && groups.at(-1)?.kind === '(')) {
      finish();
      return index + 1;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      endWord();
      index++;
    } else if (character === '\n') {
      endCommand();
      index = pending.length ? bodies(text, index + 1, pending, { line, pipes, groups }, depth, out) : index + 1;
      pending = [];
      line = [];
      pipes = [];
      for (const group of groups) group.from = 0;
    } else if (character === '#' && !inWord) {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '\\') {
      if (next !== '\n') {
        word += next ?? character;
        isQuoted = true;
        inWord = true;
      }
      index += 2;
    } else if (character === "'" || (character === '$' && next === "'")) {
      // '...' is as written. $'...' takes \ escapes, so \' does not close it.
      const ansi = character === '$';
      const open = ansi ? index + 1 : index;
      const end = ansi ? closeAnsi(text, open + 1) : text.indexOf("'", open + 1);
      if (end === -1) index = open + 1; // unclosed: drop the quote and read on
      else {
        const body = text.slice(open + 1, end);
        word += ansi ? body.replace(/\\(.)/gs, '$1') : body;
        isQuoted = true;
        inWord = true;
        index = end + 1;
      }
    } else if (character === '"' || (character === '$' && next === '"')) {
      const open = character === '$' ? index + 1 : index;
      const quoted = readDouble(text, open + 1, depth, out);
      if (!quoted) index = open + 1; // unclosed: drop the quote and read on
      else {
        word += quoted.value;
        isQuoted = true;
        inWord = true;
        index = quoted.end;
      }
    } else if ((character === '$' || character === '<' || character === '>') && next === '(') {
      // $(...), $((...)), <(...) and >(...): the inside runs on its own.
      const end = read(text, index + 2, ')', depth + 1, out);
      if (end === -1) {
        endCommand(); // unclosed: cut here and read on
        index += 2;
      } else {
        word += text.slice(index, end);
        inWord = true;
        index = end;
      }
    } else if (character === '`') {
      const end = read(text, index + 1, '`', depth + 1, out);
      inWord = true;
      index = end === -1 ? index + 1 : end;
    } else if (character === '(' && next === '(') {
      // (( maths )): read the inside on its own, so a << there is a shift, not a heredoc.
      endWord();
      const end = read(text, index + 1, ')', depth + 1, out);
      if (end === -1) endCommand();
      index = end === -1 ? index + 1 : end;
    } else if (character === '(' || (character === '{' && !inWord && /\s/.test(next ?? ''))) {
      // A subshell or a group cuts like a separator, and is open until its ) or }.
      endCommand();
      groups.push({ kind: character, from: line.length, to: 0, bodies: [] });
      index++;
    } else if ((character === ')' && groups.at(-1)?.kind === '(') || (character === '}' && !inWord && /[\s;|&)<>]|^$/.test(next ?? '') && groups.at(-1)?.kind === '{')) {
      endCommand();
      closed = groups.pop() ?? null;
      if (closed) closed.to = line.length;
      index++;
    } else if (character === ';' && cases > 0 && (next === ';' || next === '&')) {
      // `;;`, `;&` and `;;&` end a case item: a pattern comes next.
      endCommand();
      isPattern = true;
      alternative = 0;
      index += next === ';' && text[index + 2] === '&' ? 3 : 2;
    } else if (character === ')' || character === ';' || (character === '}' && !inWord && /[\s;]|^$/.test(next ?? ''))) {
      // A brace inside a word (${x}, a{b,c}) does not cut.
      endCommand();
      index++;
    } else if (character === '&') {
      if (next === '>' || word.endsWith('>')) {
        // &> and >& are redirects, not separators.
        word += character;
        inWord = true;
        index++;
      } else {
        endCommand();
        index += next === '&' ? 2 : 1;
      }
    } else if (character === '|') {
      endCommand(next !== '|');
      index += next === '|' || next === '&' ? 2 : 1;
    } else if (character === '<' && next === '<' && text[index + 2] === '<') {
      // A here-string is one more word. A shell that reads it is a runner, so it is read.
      endWord();
      words.push('<<<');
      index += 3;
    } else if (character === '<' && next === '<' && !word.endsWith('<')) {
      endWord();
      const doc = heredoc(text, index + 2, line.length, [...groups]);
      if (doc) {
        pending.push(doc.doc);
        index = doc.end;
      } else {
        words.push('<<'); // no word after it: bash calls that an error; read on
        index += 2;
      }
    } else {
      word += character;
      inWord = true;
      index++;
    }
  }
  finish();
  return closer ? -1 : text.length;
}

// The end of a $'...' string: the next ' without a \ before it.
function closeAnsi(text: string, i: number): number {
  for (; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === "'") return i;
  }
  return -1;
}

// Reads "..." from after the opening quote. $(...) and `...` inside it run, so they are
// read as commands. Returns the word's text and the index after the closing quote, or null
// when it never closes. With `toEnd` there is no closing quote: it reads a heredoc body.
function readDouble(text: string, index: number, depth: number, out: string[][], toEnd = false): { value: string; end: number } | null {
  let value = '';
  while (index < text.length) {
    const character = text[index];
    if (character === '"' && !toEnd) return { value, end: index + 1 };
    if (character === '\\') {
      // In "...", \ escapes only $ ` " \ and a line end. Before anything else it stays.
      const n = text[index + 1] ?? '';
      if (n && '$`"\\'.includes(n)) value += n;
      else if (n !== '\n') value += character + n;
      index += 2;
    } else if ((character === '$' && text[index + 1] === '(') || character === '`') {
      const from = character === '`' ? index + 1 : index + 2;
      const end = read(text, from, character === '`' ? '`' : ')', depth + 1, out);
      if (end === -1) return null;
      value += text.slice(index, end);
      index = end;
    } else {
      value += character;
      index++;
    }
  }
  return toEnd ? { value, end: index } : null;
}

// Reads the word after << or <<-. A quoted word means the body is not expanded.
function heredoc(text: string, index: number, cmd: number, groups: Group[]): { doc: Heredoc; end: number } | null {
  const strip = text[index] === '-';
  if (strip) index++;
  while (text[index] === ' ' || text[index] === '\t') index++;
  let delim = '';
  let quoted = false;
  while (index < text.length && !/[\s;&|()<>]/.test(text[index])) {
    const character = text[index];
    if (character === "'" || character === '"') {
      const end = text.indexOf(character, index + 1);
      if (end === -1) return null;
      delim += text.slice(index + 1, end);
      quoted = true;
      index = end + 1;
    } else if (character === '\\') {
      delim += text[index + 1] ?? '';
      quoted = true;
      index += 2;
    } else {
      delim += character;
      index++;
    }
  }
  return delim ? { doc: { delim, strip, quoted, cmd, groups }, end: index } : null;
}

// Reads the heredoc bodies that start at `index`, in order, and returns the index after the
// last one. A body is data, unless a shell or runner reads it (#196): the program of the
// command that holds the <<, or of a command it pipes into (`cat <<EOF | bash`). The
// program is found after assignments, keywords and launchers (see readsCommands), so
// `then bash <<EOF` and `env X=1 bash -s <<EOF` count, and `cat > sh <<EOF` or
// `node - <<EOF` do not. A pipe left open at the line end (`cat <<EOF |`) counts too: its
// reader is on a later line. A group that closed on the line pipes its commands on
// (`{ cat <<EOF; } | bash`). Then the body is read as commands. A body in a group still
// open waits in the group: where the group sends its output decides (see `settle` in read).
// An unquoted body still runs $(...) and `...`, so those are read too. A body with no end
// line runs to the end of the text, as in bash.
function bodies(text: string, index: number, docs: Heredoc[], { line, pipes, groups }: { line: string[][]; pipes: boolean[]; groups: Group[] }, depth: number, out: string[][]): number {
  for (const doc of docs) {
    const lines: string[] = [];
    while (index < text.length) {
      let nl = text.indexOf('\n', index);
      if (nl === -1) nl = text.length;
      const ln = text.slice(index, nl);
      index = nl + 1;
      if ((doc.strip ? ln.replace(/^\t+/, '') : ln).replace(/\r$/, '') === doc.delim) break;
      lines.push(ln);
    }
    const body = lines.join('\n');
    let last = doc.cmd;
    while (pipes[last] && last + 1 < line.length) last++;
    const readers = line.slice(doc.cmd, last + 1);
    const isOpenPipe = readers.length > 1 && readers[readers.length - 1].length === 0;
    if (isOpenPipe || readers.some(readsCommands)) {
      out.push(...commandWords(body, depth + 1));
      continue;
    }
    if (!doc.quoted) readDouble(body, 0, depth, out, true);
    doc.groups.findLast((group) => groups.includes(group))?.bodies.push(body);
  }
  return Math.min(index, text.length);
}

// Programs that read their input as data, never as commands.
const DATA_READERS = new Set([
  'cat', 'tee', 'node', 'deno', 'bun', 'gh', 'git', 'yokoten', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq',
  'jq', 'yq', 'tr', 'cut', 'less', 'more', 'diff', 'patch', 'base64', 'xxd', 'od', 'column', 'fold', 'fmt', 'nl', 'paste', 'rev', 'iconv',
  'gzip', 'xz', 'zstd', 'bzip2', 'tar', 'curl', 'wget', 'mail', 'mailx', 'sendmail', 'pbcopy', 'xclip', 'wl-copy', 'clip', 'sponge',
  'read', 'mapfile', 'readarray', 'true', ':',
]);

// Whether a command reads its input as commands. The program is found after assignments,
// shell keywords and launchers (`then bash`, `stdbuf -oL bash`). When it is one of
// DATA_READERS, only a shell or runner up to it counts, so `cat > sh <<EOF` and
// `node x.ts --shell bash <<EOF` are data, and `sudo -s` still counts. When it is not, the
// guard does not know what the program does with its input, so a shell or runner anywhere
// in the command counts: `mystery-launcher bash <<EOF` is refused rather than guessed.
function readsCommands(words: string[]): boolean {
  const program = findPrograms(words)[0];
  if (program === undefined || !DATA_READERS.has(programName(program))) return runnerAt(words) !== -1;
  const at = words.indexOf(program);
  return runnerAt(withoutRedirects(at === -1 ? words : words.slice(0, at + 1))) !== -1;
}

// The words with each redirect and its file taken out: `> sh cat` names no shell.
function withoutRedirects(words: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; ) {
    const length = redirectLength(words, index);
    if (length === 0) kept.push(words[index]);
    index += length || 1;
  }
  return kept;
}

// The old cut: quotes become spaces, then cut at ; | & ( ) and line ends. It finds more
// than is there, so it is only the fallback when nesting is too deep to follow.
function rough(text: string): string[][] {
  return text
    .replace(/['"`]/g, ' ')
    .split(/[;|&()\r\n]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}
