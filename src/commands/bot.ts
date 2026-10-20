// `yokoten bot -- <gh or git command>`: runs it as the GitHub App, after checking its title.

import { execFileSync, spawnSync } from 'node:child_process';
import { botConfig, botEnv, botProgram, installationToken, repoOf } from '../host/github.ts';
import { DEFAULTS, loadConfig } from '../rules/config.ts';
import { checkCommandTitle } from '../rules/pr.ts';
import { args, bullets, env, parse, print, requireRoot, rootOf, usage } from './shared.ts';

async function bot(command: string[]): Promise<number> {
  // gh and git only (#295): a wrapper such as `env gh` or `sh -c` would run a title unchecked.
  if (command.length && !botProgram(command[0])) {
    print([`yokoten bot: runs gh and git only; run \`${command[0]}\` without the bot`], process.stderr);
    return 1;
  }
  // The title first: a bad title is refused before anything is sent, so it never needs a rename.
  const root = rootOf(process.cwd());
  const titleProblems = checkCommandTitle(command, root ? loadConfig(root) : DEFAULTS);
  if (titleProblems.length) {
    print([`yokoten bot: ${titleProblems.length} problem(s) in the title; nothing was sent. Fix the title and run it again:`, ...bullets(titleProblems)], process.stderr);
    return 1;
  }
  const config = botConfig(env);
  if (typeof config === 'string') {
    print([`yokoten bot: ${config}`], process.stderr);
    return 1;
  }
  if (!command.length) {
    print(['yokoten bot: no command. Example: yokoten bot -- gh pr create --fill'], process.stderr);
    return 1;
  }
  if (!requireRoot(process.cwd())) return 1;
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const repo = repoOf(remote);
  if (!repo) {
    print(['yokoten bot: the origin remote is not a GitHub repo'], process.stderr);
    return 1;
  }
  const token = await installationToken(config, repo);
  const [file, ...rest] = command;
  const result = spawnSync(file, rest, { stdio: 'inherit', env: botEnv(env, token) });
  // A command that never ran, or that a signal ended, says so (#282). Only the file and the
  // code or signal are named: never the token or the environment.
  if (result.error) {
    print([`yokoten bot: could not run ${file}: ${(result.error as NodeJS.ErrnoException).code ?? result.error.message.split('\n')[0]}`], process.stderr);
    return 1;
  }
  if (result.signal) {
    print([`yokoten bot: ${file} was ended by ${result.signal}`], process.stderr);
    return 1;
  }
  return result.status ?? 1;
}

export function runBot(): number | Promise<number> {
  // No options of its own: everything after `--` is the command, passed on unchanged.
  const end = args.indexOf('--');
  const options = parse('bot', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(options);
  return bot(end === -1 ? [] : args.slice(end + 1));
}
