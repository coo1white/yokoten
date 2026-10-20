// `yokoten bot -- <gh or git command>`: runs it as the GitHub App, after checking its title
// and, for a pull request, its body.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { botConfig, botEnv, botProgram, installationToken, readBranchFiles, readCodeOwners, repoOf } from '../host/github.ts';
import { DEFAULTS, type Env, loadConfig } from '../rules/config.ts';
import type { Finding } from '../rules/message.ts';
import { type CommandLabels, checkCommandTitle, checkOwnedTier, checkPullRequestBody, readCommandBody, readCommandLabels } from '../rules/pr.ts';
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
  // Then a pull request's body (#406), by the body rules of `check --pr`. A body for this
  // branch, or one `--head` or `gh pr edit <branch>` names, is checked before anything is sent.
  const body = root ? readPendingBody(command, root) : null;
  if (body && !isLookup(body) && refuseBody(checkBody(body, localBranch(body)))) return 1;
  // Then the labels of `gh pr create` (#422): a tier label the body contradicts is refused.
  const labels = root ? readPendingLabels(command, root, body) : null;
  if (labels?.problems.length) {
    print([`yokoten bot: ${labels.problems.length} problem(s) in the labels; nothing was sent. Fix the labels and run it again:`, ...bullets(labels.problems)], process.stderr);
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
  const [file, ...given] = command;
  // The type and tier labels the command leaves out, by the names the repo has (#422).
  const rest = labels?.missing.length ? addLabels(given, chooseLabels(labels, file, botEnv(env, token))) : given;
  // `gh pr edit <number or URL>`: one `gh pr view` with the same token names its branches.
  if (body && isLookup(body) && refuseBody(checkBody(body, lookupBranch(body, file, botEnv(env, token))))) return 1;
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

/** A pull request body a command is about to set, read and not yet checked. */
interface PendingBody {
  root: string;
  text: string;
  /** The body as read from standard input, which gh then gets the same way. */
  input?: string;
  base: string | null;
  head: string | null;
  repo: string | null;
}

/**
 * The body `gh pr create` or `gh pr edit` sets, read from the command, a file or standard
 * input. Null when there is none, the repo has no yokoten.json, the command names another
 * repo, or the file can't be read (gh then says why, and sends nothing).
 */
function readPendingBody(command: string[], root: string): PendingBody | null {
  const found = readCommandBody(command);
  if (!found || !existsSync(join(root, 'yokoten.json')) || !isOrigin(root, found.repo)) return null;
  try {
    if ('text' in found.body) return { root, text: found.body.text, base: found.base, head: found.head, repo: found.repo };
    const input = found.body.file === '-' ? readFileSync(0, 'utf8') : undefined;
    return { root, text: input ?? readFileSync(found.body.file, 'utf8'), input, base: found.base, head: found.head, repo: found.repo };
  } catch {
    return null;
  }
}

/** Whether `--repo` names this repo's origin, or no repo at all. */
function isOrigin(root: string, repo: string | null): boolean {
  if (repo === null) return true;
  let origin: string | null = null;
  try {
    origin = repoOf(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // no origin: the named repo is another one
  }
  return origin?.toLowerCase() === repo.replace(/^(https?:\/\/)?github\.com\//, '').toLowerCase();
}

/**
 * The labels `gh pr create` leaves out, and the problems with those it gives, by `check
 * --pr` (#422). Null when the repo has no yokoten.json, or the command names another repo.
 */
function readPendingLabels(command: string[], root: string, body: PendingBody | null): CommandLabels | null {
  if (!existsSync(join(root, 'yokoten.json'))) return null;
  const labels = readCommandLabels(command, body?.text ?? null);
  return labels && isOrigin(root, labels.repo) ? labels : null;
}

/**
 * For each missing label, the first name the repo has, from one `gh label list` with the
 * bot's token. A label the repo does not have is said plainly and left out; the bot never
 * creates one. When gh can't list the labels, the best name is used, and gh says the rest.
 */
function chooseLabels(labels: CommandLabels, gh: string, ghEnv: Env): string[] {
  const list = spawnSync(gh, ['label', 'list', '--json', 'name', '--limit', '1000', ...(labels.repo ? ['--repo', labels.repo] : [])], { encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  let names: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(list.stdout ?? '');
    if (list.status === 0 && Array.isArray(parsed)) names = parsed.map((label: { name?: unknown }) => String(label?.name ?? ''));
  } catch {
    // gh said no list: use the best names
  }
  if (!names) return labels.missing.map(([best]) => best);
  const known = new Map(names.map((name) => [name.toLowerCase(), name]));
  const chosen: string[] = [];
  for (const wanted of labels.missing) {
    const found = wanted.map((name) => known.get(name.toLowerCase())).find((name) => name !== undefined);
    if (found !== undefined) chosen.push(found);
    else print([`yokoten bot: note: the repo has no label \`${wanted[0]}\`, so the pull request gets none; create it on GitHub, or pass another with --label. \`check --pr\` asks for it`], process.stderr);
  }
  return chosen;
}

/** The gh arguments with one `--label` for each name, before any `--`. */
function addLabels(args: string[], names: string[]): string[] {
  const end = args.indexOf('--');
  const added = names.flatMap((name) => ['--label', name]);
  return end === -1 ? [...args, ...added] : [...args.slice(0, end), ...added, ...args.slice(end)];
}

/** Whether the pull request is named by a number or a URL, so gh must say its branches. */
const isLookup = (body: PendingBody): boolean => body.head !== null && /^\d+$|^https?:/.test(body.head);

/** The branches to compare, or why the body is checked without the changed files. */
type Branch = { base: string; head: string; files?: ReturnType<typeof readBranchFiles> } | { why: string };

/** This branch, or the one `--head` or `gh pr edit <branch>` names, against origin/<base>. */
function localBranch(body: PendingBody): Branch {
  // Another owner's branch (`owner:branch`) is not here to compare.
  if (body.head?.includes(':')) return { why: `\`${body.head}\` is another owner's branch` };
  return { base: `origin/${body.base ?? 'main'}`, head: body.head ?? 'HEAD' };
}

/**
 * The branches of the pull request `gh pr edit <number or URL>` names, from one `gh pr view`
 * with the bot's token (#406). The edit goes to the network anyway. A branch that is not
 * here yet is fetched from origin, quietly.
 */
function lookupBranch(body: PendingBody, gh: string, ghEnv: Env): Branch {
  const view = spawnSync(gh, ['pr', 'view', body.head ?? '', '--json', 'headRefName,baseRefName', ...(body.repo ? ['--repo', body.repo] : [])], { cwd: body.root, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  let refs: { headRefName?: unknown; baseRefName?: unknown } = {};
  try {
    refs = JSON.parse(view.stdout ?? '');
  } catch {
    // said below
  }
  if (view.status !== 0 || typeof refs.headRefName !== 'string' || typeof refs.baseRefName !== 'string') {
    return { why: `gh could not say the branches of pull request \`${body.head}\`` };
  }
  const base = body.base ?? refs.baseRefName;
  const branch = { base: `origin/${base}`, head: `origin/${refs.headRefName}` };
  const files = readBranchFiles(body.root, branch.base, branch.head);
  if (files) return { ...branch, files };
  spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', refs.headRefName, base], { cwd: body.root, stdio: 'ignore' });
  return branch;
}

/** The problems with a body: every body rule of `check --pr` when the branch's files can be read, else the body alone, with a note. */
function checkBody(body: PendingBody, branch: Branch): { problems: Finding[]; note?: string } {
  const config = loadConfig(body.root);
  const files = 'why' in branch ? null : (branch.files ?? readBranchFiles(body.root, branch.base, branch.head));
  if ('why' in branch || !files) {
    const why = 'why' in branch ? branch.why : `git can't compare ${branch.head} with ${branch.base}`;
    return { problems: checkPullRequestBody({ body: body.text, files: [] }, config), note: `${why}, so the body was checked without the changed files; CI checks the rest` };
  }
  const pr = { body: body.text, ...files };
  const problems = checkPullRequestBody(pr, config);
  const owned = checkOwnedTier(pr, readCodeOwners(body.root, branch.base));
  if (owned) problems.push(owned);
  return { problems };
}

/** Prints the problems with a body the way the title check does, or its note. True when it refuses. */
function refuseBody({ problems, note }: { problems: Finding[]; note?: string }): boolean {
  if (problems.length) {
    print([`yokoten bot: ${problems.length} problem(s) in the body; nothing was sent. Fix the body and run it again:`, ...bullets(problems)], process.stderr);
    return true;
  }
  if (note) print([`yokoten bot: note: ${note}`], process.stderr);
  return false;
}

export function runBot(): number | Promise<number> {
  // No options of its own: everything after `--` is the command, passed on unchanged.
  const end = args.indexOf('--');
  const options = parse('bot', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(options);
  return bot(end === -1 ? [] : args.slice(end + 1));
}
