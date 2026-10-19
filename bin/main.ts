// yokoten: carry what one project learned into every project. bin/yokoten.ts turns on
// the compile cache, then loads this file (#286). This file reads the command and hands it
// to its module in src/commands/, one per command or small group (#330).

import { runAdopt, runDoctor, runExplain } from '../src/commands/advice.ts';
import { runBot } from '../src/commands/bot.ts';
import { runCheck } from '../src/commands/check.ts';
import { runHook } from '../src/commands/hook.ts';
import { runChangelog, runLearn } from '../src/commands/learn.ts';
import { runInit, runInstall, runUninstall, runUpdate } from '../src/commands/setup.ts';
import { args, cmd, parse, print, printJsonError, say, usage } from '../src/commands/shared.ts';
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
  'Start: `yokoten install` once on this machine, then `yokoten init` in your project.',
  'Run `yokoten <command> --help` for its options and an example.',
  '--json on check, doctor, hook, explain and adopt: data on stdout,',
  'for an agent or a script.',
  'Exit codes: 0 ok, 1 problems found or a usage error, 2 the hook blocked the tool call',
  'or the end of the turn.',
].join('\n');

/** An unknown command: the closest one when it is near, or else the list. Exit 1. */
function unknownCommand(name: string): number {
  const near = closestWord(name, COMMANDS.map((command) => command.name));
  const hint = near ? `Did you mean "${near}"?` : `Commands: ${COMMANDS.map((command) => command.name).join(', ')}.`;
  print([`yokoten: unknown command "${name}". ${hint} Run \`yokoten help\`.`], process.stderr);
  return 1;
}

/**
 * True when the command line asks for help: `--help` or `-h` among its own words. For
 * `bot`, only the words before `--` count: after it, they belong to the command it runs.
 */
function isHelpAsked(words: string[]): boolean {
  const end = words.indexOf('--');
  return (end === -1 ? words : words.slice(0, end)).some((word) => HELP_OPTIONS.includes(word));
}

function main(): number | Promise<number> {
  // `<command> --help` prints that command's help and does nothing else (#207).
  const command = cmd === undefined ? undefined : findCommand(cmd);
  if (command && isHelpAsked(args)) {
    print(commandHelp(command));
    return 0;
  }
  switch (cmd) {
    case 'hook':
      return runHook();
    case 'check':
      return runCheck();
    case 'changelog':
      return runChangelog();
    case 'learn':
      return runLearn();
    case 'doctor':
      return runDoctor();
    case 'explain':
      return runExplain();
    case 'adopt':
      return runAdopt();
    case 'init':
      return runInit();
    case 'update':
      return runUpdate();
    case 'bot':
      return runBot();
    case 'install':
      return runInstall();
    case 'uninstall':
      return runUninstall();
    case 'version': {
      const options = parse('version');
      if (typeof options === 'string') return usage(options);
      print([VERSION]);
      return 0;
    }
    case '--version':
    case '-v':
      print([VERSION]);
      return 0;
    case 'help': {
      const options = parse('help');
      if (typeof options === 'string') return usage(options);
      const [name] = options.positional;
      if (name === undefined) break;
      const named = findCommand(name);
      if (!named) return unknownCommand(name);
      print(commandHelp(named));
      return 0;
    }
    case undefined:
    case '--help':
    case '-h':
      break;
    default:
      return unknownCommand(cmd);
  }
  print([HELP]);
  return 0;
}

// Exit 1, not 2, on an error: a broken guard should be seen, not block every tool call.
Promise.resolve()
  .then(main)
  .then(
    (code) => {
      process.exitCode = code;
    },
    (err: Error) => {
      printJsonError(String(err?.message ?? err).split('\n')[0]);
      say(`yokoten ${cmd}: ${err.message}\n`, process.stderr);
      process.exitCode = 1;
    },
  );
