// yokoten: carry what one project learned into every project. bin/yokoten.ts turns on
// the compile cache, then loads this file (#286). This file reads the command and hands it
// to its module in src/commands/, one per command or small group (#330). Each module is
// imported only when its command runs, so a guard call never loads doctor or init (#408).
//
// Loading this file runs nothing. bin/yokoten.mjs calls `runFromProcess`, which makes the one
// invocation from the process; a test calls `main` with its own, in-process (#475).

import { withHome } from '../src/rules/privacy.ts';
import { type Invocation, parse, print, printJsonError, say, usage } from '../src/commands/shared.ts';
import { closestWord, COMMANDS, commandHelp, findCommand, HELP_OPTIONS, commandList } from '../src/run/cli.ts';
import { VERSION } from '../src/setup/files.ts';

// The help comes from one table, the same one the parser reads (#207).
const HELP = [
  `yokoten ${VERSION}`,
  '',
  'Usage: yokoten <command> [options]',
  '',
  ...commandList(),
  '',
  "Start: run `yokoten` with no command in your project. It installs what is missing.",
  'It adds the rules to the project and shows the next step.',
  'To run each step yourself, use `yokoten install`, then `yokoten init`.',
  'Run `yokoten <command> --help` for its options and an example.',
  '--json on check, doctor, hook, explain and adopt: data on stdout,',
  'for an agent or a script.',
  'Exit codes: 0 ok, 1 problems found or a usage error, 2 the hook blocked the tool call',
  'or the end of the turn.',
].join('\n');

/** An unknown command: the closest one when it is near, or else the list. Exit 1. */
function unknownCommand(invocation: Invocation, name: string): number {
  const near = closestWord(name, COMMANDS.map((command) => command.name));
  const hint = near ? `Did you mean "${near}"?` : `Commands: ${COMMANDS.map((command) => command.name).join(', ')}.`;
  print(invocation, [`yokoten: unknown command "${name}". ${hint} Run \`yokoten help\`.`], invocation.stderr);
  return 1;
}

/**
 * True when the command line asks for help: `--help` or `-h` among its own words. For
 * `bot` and `desk`, only the words before `--` count: after it, they belong to the command it runs.
 */
function isHelpAsked(words: string[]): boolean {
  const end = words.indexOf('--');
  return (end === -1 ? words : words.slice(0, end)).some((word) => HELP_OPTIONS.includes(word));
}

function dispatch(invocation: Invocation): number | Promise<number> {
  const { command: cmd, args } = invocation;
  // `<command> --help` prints that command's help and does nothing else (#207).
  const command = cmd === undefined ? undefined : findCommand(cmd);
  if (command && isHelpAsked(args)) {
    print(invocation, commandHelp(command));
    return 0;
  }
  switch (cmd) {
    case 'hook': {
      // The tool-call guard's worker, which bin/yokoten.mjs started before this file loaded (#408).
      const guard = args.includes('--stop') ? undefined : import('../src/run/hook.ts').then((m) => m.takeGuard());
      return Promise.all([guard, import('../src/commands/hook.ts')]).then(([started, m]) => m.runHook(invocation, started));
    }
    case 'worker':
      return import('../src/commands/hook.ts').then((m) => m.runWorker(invocation));
    case 'desk':
      return import('../src/commands/hook.ts').then((m) => m.runDesk(invocation));
    case 'msg':
      return import('../src/commands/advice/messages.ts').then((m) => m.runMsg(invocation));
    case 'check':
      return import('../src/commands/check.ts').then((m) => m.runCheck(invocation));
    case 'redact':
      return import('../src/commands/check.ts').then((m) => m.runRedact(invocation));
    case 'marks':
      return import('../src/commands/check.ts').then((m) => m.runMarks(invocation));
    case 'changelog':
      return import('../src/commands/learn.ts').then((m) => m.runChangelog(invocation));
    case 'learn':
      return import('../src/commands/learn.ts').then((m) => m.runLearn(invocation));
    case 'doctor':
      return import('../src/commands/advice/doctor.ts').then((m) => m.runDoctor(invocation));
    case 'explain':
      return import('../src/commands/advice/doctor.ts').then((m) => m.runExplain(invocation));
    case 'adopt':
      return import('../src/commands/advice/doctor.ts').then((m) => m.runAdopt(invocation));
    case 'init':
      return import('../src/commands/setup.ts').then((m) => m.runInit(invocation));
    case 'update':
      return import('../src/commands/setup.ts').then((m) => m.runUpdate(invocation));
    case 'bot':
      return import('../src/commands/bot.ts').then((m) => m.runBot(invocation));
    case 'board':
      return import('../src/commands/advice/board/server.ts').then((m) => m.runBoard(invocation));
    case 'install':
      return import('../src/commands/setup.ts').then((m) => m.runInstall(invocation));
    case 'uninstall':
      return import('../src/commands/setup.ts').then((m) => m.runUninstall(invocation));
    case 'version': {
      const options = parse('version', args);
      if (typeof options === 'string') return usage(invocation, options);
      print(invocation, [VERSION]);
      return 0;
    }
    case '--version':
    case '-v':
      print(invocation, [VERSION]);
      return 0;
    case 'help': {
      const options = parse('help', args);
      if (typeof options === 'string') return usage(invocation, options);
      const [name] = options.positional;
      if (name === undefined) break;
      const named = findCommand(name);
      if (!named) return unknownCommand(invocation, name);
      print(invocation, commandHelp(named));
      return 0;
    }
    case undefined:
      // No command in a project is not an error: it is the start (#548).
      return import('../src/commands/setup.ts').then((m) => m.runStart(invocation));
    case '--help':
    case '-h':
      break;
    default:
      return unknownCommand(invocation, cmd);
  }
  print(invocation, [HELP]);
  return 0;
}

/** Where an error line starts: the command, or `yokoten` alone when there is none (#548). */
export const errorLabel = (command: string | undefined): string => `yokoten${command ? ` ${command}` : ''}`;

/** Run one command line, and give its exit code. Exit 1, not 2, on an error: a broken guard should be seen, not block every tool call. */
export function main(invocation: Invocation): Promise<number> {
  return Promise.resolve(invocation)
    .then(dispatch)
    .catch((err: Error) => {
      printJsonError(invocation, String(err?.message ?? err).split('\n')[0]);
      // No command (the one-command start, #548) has no name to print: never "yokoten undefined".
      say(invocation, `${errorLabel(invocation.command)}: ${err.message}\n`, invocation.stderr);
      return 1;
    });
}

/** Run the command line this process was started with. Only here are process.argv, process.env, process.cwd() and the streams read. */
export function runFromProcess(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  // The one place HOME falls back to the system's home (#356): every module below reads it from env.
  // stdin is read by its fd; its stream is made only when a command reads it (see Input).
  const stdin = {
    fd: 0,
    text: null,
    get stream() {
      return process.stdin;
    },
  };
  const invocation: Invocation = { command, args, env: withHome(process.env), cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, stdin, script: process.argv[1] ?? 'yokoten' };
  return main(invocation).then((code) => {
    process.exitCode = code;
  });
}
