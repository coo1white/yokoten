// `yokoten bot -- <gh or git command>`: runs it as the GitHub App, after checking its title.

import { execFileSync, spawnSync } from 'node:child_process';
import { botConfig, botEnv, botProgram, installationToken, readCommandTitle, repoOf } from '../host/github.ts';
import { DEFAULTS, loadConfig } from '../rules/config.ts';
import { finding, type Finding } from '../rules/message.ts';
import { checkIssueTitle, checkPullRequestTitle } from '../rules/pr.ts';
import { args, bullets, env, parse, print, requireRoot, rootOf, usage } from './shared.ts';

/**
 * Problems with the title a bot command is about to set (#117), by the rules CI uses:
 * `check --issue` for an issue, the title part of `check --pr` for a pull request. No
 * title in the command, no problems. A run-together short flag it can't read is a problem
 * (#290), so the title is never sent unchecked. It reads no token and no network.
 */
function checkCommandTitle(command: string[]): Finding[] {
  const found = readCommandTitle(command);
  if (!found) return [];
  if ('unreadable' in found) {
    const id = found.kind === 'issue' ? 'issue-title' : 'pr-title';
    return [finding(id, `title: can't read the title in \`${found.unreadable}\``, 'write --title on its own', { why: 'the bot checks the title before it sends anything' })];
  }
  const root = rootOf(process.cwd());
  const config = root ? loadConfig(root) : DEFAULTS;
  return found.kind === 'issue' ? checkIssueTitle(found.title, config, found.labels) : checkPullRequestTitle(found.title, config);
}

async function bot(command: string[]): Promise<number> {
  // gh and git only (#295): a wrapper such as `env gh` or `sh -c` would run a title unchecked.
  if (command.length && !botProgram(command[0])) {
    print([`yokoten bot: runs gh and git only; run \`${command[0]}\` without the bot`], process.stderr);
    return 1;
  }
  // The title first: a bad title is refused before anything is sent, so it never needs a rename.
  const titleProblems = checkCommandTitle(command);
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
