// `yokoten bot -- <gh or git command>`: runs it as the GitHub App, after checking its title
// and, for a pull request, its body.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { botConfig, botEnv, botProgram, installationToken, readBranchFiles, readCodeOwners, repoOf } from '../host/github.ts';
import { DEFAULTS, loadConfig } from '../rules/config.ts';
import type { Finding } from '../rules/message.ts';
import { checkCommandTitle, checkOwnedTier, checkPullRequestBody, readCommandBody } from '../rules/pr.ts';
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
  // Then a pull request's body (#406), by the body rules of `check --pr`, against this branch.
  const body = root ? checkCommandBody(command, root) : null;
  if (body?.problems.length) {
    print([`yokoten bot: ${body.problems.length} problem(s) in the body; nothing was sent. Fix the body and run it again:`, ...bullets(body.problems)], process.stderr);
    return 1;
  }
  if (body?.note) print([`yokoten bot: note: ${body.note}`], process.stderr);
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
  // A body read from standard input was used up by the check, so gh gets it the same way.
  const input = body?.input;
  const result = spawnSync(file, rest, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input, env: botEnv(env, token) });
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

/** The problems in a pull request body a command sets; a note when only the body itself was checked; and the body read from standard input. */
interface BodyCheck {
  problems: Finding[];
  note?: string;
  input?: string;
}

/**
 * The body rules of `check --pr` on the body `gh pr create` or `gh pr edit` sets (#406),
 * against the files this branch changes since its base, and the base's CODEOWNERS. All local:
 * one git diff and one read of CODEOWNERS. Null when there is no body to check, the repo
 * has no yokoten.json, or the command names another repo.
 */
function checkCommandBody(command: string[], root: string): BodyCheck | null {
  const found = readCommandBody(command);
  if (!found || !existsSync(join(root, 'yokoten.json'))) return null;
  if (found.repo !== null) {
    let origin: string | null = null;
    try {
      origin = repoOf(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
      // no origin: the named repo is another one
    }
    if (origin?.toLowerCase() !== found.repo.replace(/^(https?:\/\/)?github\.com\//, '').toLowerCase()) return null;
  }
  let text: string;
  let input: string | undefined;
  try {
    if ('text' in found.body) text = found.body.text;
    else if (found.body.file === '-') text = input = readFileSync(0, 'utf8');
    else text = readFileSync(found.body.file, 'utf8');
  } catch {
    return null; // gh says why it can't read the file, and sends nothing
  }
  // The branch: the current one, or the one `--head` or `gh pr edit <branch>` names. A number,
  // a URL or another owner's branch can't be matched without the network, so only the body
  // itself is checked then.
  const head = found.head === null ? 'HEAD' : /^\d+$|^https?:|:/.test(found.head) ? null : found.head;
  const base = `origin/${found.base ?? 'main'}`;
  const branch = head === null ? null : readBranchFiles(root, base, head);
  const config = loadConfig(root);
  if (!branch) {
    const why = head === null ? `\`${found.head}\` is not a local branch` : `git can't compare ${head} with ${base}`;
    return { problems: checkPullRequestBody({ body: text, files: [] }, config), note: `${why}, so the body was checked without the changed files; CI checks the rest`, input };
  }
  const pr = { body: text, ...branch };
  const problems = checkPullRequestBody(pr, config);
  const owned = checkOwnedTier(pr, readCodeOwners(root, base));
  if (owned) problems.push(owned);
  return { problems, input };
}

export function runBot(): number | Promise<number> {
  // No options of its own: everything after `--` is the command, passed on unchanged.
  const end = args.indexOf('--');
  const options = parse('bot', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(options);
  return bot(end === -1 ? [] : args.slice(end + 1));
}
