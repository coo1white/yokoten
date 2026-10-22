// `yokoten bot -- <gh or git command>`: runs it as the GitHub App, after checking its title
// and, for a pull request, its body.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { botConfig, botEnv, botProgram, type Gh, installationToken, readApprovalState, readBranchFiles, readCodeOwners, readIssueMilestone, readRepoLabelNames, repoOf } from '../host/github.ts';
import { DEFAULTS, type Env, loadConfig } from '../rules/config.ts';
import type { Finding } from '../rules/message.ts';
import { type CommandIssueLabels, type CommandLabels, type CommandMilestone, checkApprovalFreshness, checkCommandTitle, checkIssueLabels, checkOwnedTier, checkPullRequestBody, noMilestoneFinding, readCommandBody, readCommandIssueLabels, readCommandLabels, readCommandMilestone } from '../rules/pr.ts';
import { bullets, type Invocation, type Output, parse, print, readInput, requireRoot, rootOf, usage } from './shared.ts';

async function bot(invocation: Invocation, command: string[]): Promise<number> {
  const { env, cwd } = invocation;
  // gh and git only (#295): a wrapper such as `env gh` or `sh -c` would run a title unchecked.
  if (command.length && !botProgram(command[0])) {
    print(invocation, [`yokoten bot: runs gh and git only; run \`${command[0]}\` without the bot`], invocation.stderr);
    return 1;
  }
  // The title first: a bad title is refused before anything is sent, so it never needs a rename.
  const root = rootOf(cwd, env);
  const titleProblems = checkCommandTitle(command, root ? loadConfig(root) : DEFAULTS);
  if (titleProblems.length) {
    print(invocation, [`yokoten bot: ${titleProblems.length} problem(s) in the title; nothing was sent. Fix the title and run it again:`, ...bullets(titleProblems)], invocation.stderr);
    return 1;
  }
  // Then a pull request's body (#406), by the body rules of `check --pr`. A body for this
  // branch, or one `--head` or `gh pr edit <branch>` names, is checked before anything is sent.
  const body = root ? readPendingBody(invocation, command, root) : null;
  if (body && !isLookup(body) && refuseBody(invocation, checkBody(body, localBranch(body), env))) return 1;
  // Then the labels of `gh pr create` (#422): a tier label the body contradicts is refused.
  const labels = root ? readPendingLabels(command, root, body, env) : null;
  if (labels?.problems.length) {
    print(invocation, [`yokoten bot: ${labels.problems.length} problem(s) in the labels; nothing was sent. Fix the labels and run it again:`, ...bullets(labels.problems)], invocation.stderr);
    return 1;
  }
  // Then the labels of `gh issue create` (#544): checked below, once the token can
  // list the repo's labels. A bad issue is refused, never sent; its labels are not
  // added, as no line of the command names the type.
  const pendingIssue = root ? readPendingIssueLabels(command, root, env) : null;
  const config = botConfig(env);
  if (typeof config === 'string') {
    print(invocation, [`yokoten bot: ${config}`], invocation.stderr);
    return 1;
  }
  if (!command.length) {
    print(invocation, ['yokoten bot: no command. Example: yokoten bot -- gh pr create --fill'], invocation.stderr);
    return 1;
  }
  if (!requireRoot(invocation, cwd)) return 1;
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, env, encoding: 'utf8' });
  const repo = repoOf(remote);
  if (!repo) {
    print(invocation, ['yokoten bot: the origin remote is not a GitHub repo'], invocation.stderr);
    return 1;
  }
  const token = await installationToken(config, repo);
  const [file, ...given] = command;
  // The type and tier labels the command leaves out, by the names the repo has (#422).
  const withLabels = labels?.missing.length ? addArgs(given, chooseLabels(invocation, labels, file, botEnv(env, token)).flatMap((name) => ['--label', name])) : given;
  // A new pull request with no milestone takes its linked issue's (#512): one `gh issue view`.
  const wanted = body && !isLookup(body) ? readCommandMilestone(command, body.text) : null;
  const milestone = wanted ? chooseMilestone(invocation, wanted, ghWith(file, cwd, botEnv(env, token))) : null;
  if (milestone === false) return 1;
  const rest = milestone ? addArgs(withLabels, ['--milestone', milestone]) : withLabels;
  if (pendingIssue) {
    const issueProblems = checkIssueLabels(pendingIssue.labels, readRepoLabelNames(ghWith(file, cwd, botEnv(env, token))));
    if (issueProblems.length) {
      print(invocation, [`yokoten bot: ${issueProblems.length} problem(s) in the labels; nothing was sent. Fix the labels and run it again:`, ...bullets(issueProblems)], invocation.stderr);
      return 1;
    }
  }
  // `gh pr edit <number or URL>`: one `gh pr view` with the same token names its branches.
  if (body && isLookup(body) && refuseBody(invocation, checkBody(body, lookupBranch(body, file, botEnv(env, token), env), env))) return 1;
  // A `gh pr merge` of a tier A pull request needs the owner's Approve on its head
  // (#612): the merge is refused when the Approve is older, or can't be checked.
  if (file === 'gh' && isPrMerge(rest)) {
    const stopped = refuseStaleMerge(invocation, ghWith(file, cwd, botEnv(env, token)), cwd, env, repo, rest);
    if (stopped) return 1;
  }
  // A body read from standard input was used up by the check, so gh gets it the same way.
  const input = body?.input;
  const { stdin, stdout, stderr } = invocation;
  const piped = input ?? (stdin.fd === null ? (stdin.text ?? '') : undefined);
  // `gh pr status` shows the Approve check too (#612), so the lead sees a stale Approve
  // before trying to merge. Its output is captured to add the lines after gh's table.
  if (file === 'gh' && showsPrStatus(rest)) {
    return runPrStatus(invocation, file, rest, { cwd, token, origin: repo, piped });
  }
  const result = spawnSync(file, rest, { cwd, stdio: [piped === undefined ? (stdin.fd ?? 'pipe') : 'pipe', childStream(stdout), childStream(stderr)], input: piped, env: botEnv(env, token), maxBuffer: 1 << 30 });
  // What gh said, for a stream that is not the process's own: written as it is, as a terminal would show it.
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  // A command that never ran, or that a signal ended, says so (#282). Only the file and the
  // code or signal are named: never the token or the environment.
  if (result.error) {
    print(invocation, [`yokoten bot: could not run ${file}: ${(result.error as NodeJS.ErrnoException).code ?? result.error.message.split('\n')[0]}`], invocation.stderr);
    return 1;
  }
  if (result.signal) {
    print(invocation, [`yokoten bot: ${file} was ended by ${result.signal}`], invocation.stderr);
    return 1;
  }
  return result.status ?? 1;
}

/** The process's own stream by its fd, so gh writes to it straight; else a pipe, copied after (#475). */
const childStream = (stream: Output): number | 'pipe' => (typeof stream.fd === 'number' ? stream.fd : 'pipe');

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
function readPendingBody(invocation: Invocation, command: string[], root: string): PendingBody | null {
  const found = readCommandBody(command);
  if (!found || !existsSync(join(root, 'yokoten.json')) || !isOrigin(root, found.repo, invocation.env)) return null;
  try {
    if ('text' in found.body) return { root, text: found.body.text, base: found.base, head: found.head, repo: found.repo };
    const input = found.body.file === '-' ? readInput(invocation.stdin) : undefined;
    return { root, text: input ?? readFileSync(resolve(invocation.cwd, found.body.file), 'utf8'), input, base: found.base, head: found.head, repo: found.repo };
  } catch {
    return null;
  }
}

/** Whether `--repo` names this repo's origin, or no repo at all. */
function isOrigin(root: string, repo: string | null, env: Env): boolean {
  if (repo === null) return true;
  let origin: string | null = null;
  try {
    origin = repoOf(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // no origin: the named repo is another one
  }
  return origin?.toLowerCase() === repo.replace(/^(https?:\/\/)?github\.com\//, '').toLowerCase();
}

/**
 * The labels `gh pr create` leaves out, and the problems with those it gives, by `check
 * --pr` (#422). Null when the repo has no yokoten.json, or the command names another repo.
 */
function readPendingLabels(command: string[], root: string, body: PendingBody | null, env: Env): CommandLabels | null {
  if (!existsSync(join(root, 'yokoten.json'))) return null;
  const labels = readCommandLabels(command, body?.text ?? null);
  return labels && isOrigin(root, labels.repo, env) ? labels : null;
}

/**
 * The labels a `gh issue create` command gives, or null when the repo has no
 * yokoten.json, the command names another repo, or it is no issue create (#544).
 */
function readPendingIssueLabels(command: string[], root: string, env: Env): CommandIssueLabels | null {
  if (!existsSync(join(root, 'yokoten.json'))) return null;
  const found = readCommandIssueLabels(command);
  return found && isOrigin(root, found.repo, env) ? found : null;
}

/**
 * For each missing label, the first name the repo has, from one `gh label list` with the
 * bot's token. A label the repo does not have is said plainly and left out; the bot never
 * creates one. When gh can't list the labels, the best name is used, and gh says the rest.
 */
function chooseLabels(invocation: Invocation, labels: CommandLabels, gh: string, ghEnv: Env): string[] {
  const list = spawnSync(gh, ['label', 'list', '--json', 'name', '--limit', '1000', ...(labels.repo ? ['--repo', labels.repo] : [])], { cwd: invocation.cwd, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
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
    else print(invocation, [`yokoten bot: note: the repo has no label \`${wanted[0]}\`, so the pull request gets none; create it on GitHub, or pass another with --label. \`check --pr\` asks for it`], invocation.stderr);
  }
  return chosen;
}

/** The gh arguments with `added` before any `--`. */
function addArgs(args: string[], added: string[]): string[] {
  const end = args.indexOf('--');
  return end === -1 ? [...args, ...added] : [...args.slice(0, end), ...added, ...args.slice(end)];
}

/** Runs the gh the command names, with the bot's token. It throws when gh fails. */
const ghWith =
  (file: string, cwd: string, ghEnv: Env): Gh =>
  (args) =>
    execFileSync(file, args, { cwd, env: ghEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * The milestone of the first linked issue that has one (#512). False, after saying why,
 * when every linked issue was read and none has one. Null, with a note, when gh can't read
 * an issue: a network hiccup never stops a post, and `check --pr` still asks for it.
 */
function chooseMilestone(invocation: Invocation, wanted: CommandMilestone, gh: Gh): string | null | false {
  const unread: number[] = [];
  for (const issue of wanted.issues) {
    const milestone = readIssueMilestone(gh, issue, wanted.repo);
    if (milestone) return milestone;
    if (milestone === undefined) unread.push(issue);
  }
  if (unread.length) {
    const named = unread.map((issue) => `#${issue}`).join(', ');
    print(invocation, [`yokoten bot: note: gh could not read the milestone of issue ${named}, so the pull request gets none; pass --milestone. \`check --pr\` asks for it`], invocation.stderr);
    return null;
  }
  print(invocation, ['yokoten bot: 1 problem(s) in the milestone; nothing was sent. Fix the command and run it again:', ...bullets([noMilestoneFinding(wanted.issues)])], invocation.stderr);
  return false;
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
function lookupBranch(body: PendingBody, gh: string, ghEnv: Env, env: Env): Branch {
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
  const files = readBranchFiles(body.root, branch.base, branch.head, env);
  if (files) return { ...branch, files };
  spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', refs.headRefName, base], { cwd: body.root, env, stdio: 'ignore' });
  return branch;
}

/** The problems with a body: every body rule of `check --pr` when the branch's files can be read, else the body alone, with a note. */
function checkBody(body: PendingBody, branch: Branch, env: Env): { problems: Finding[]; note?: string } {
  const config = loadConfig(body.root);
  const files = 'why' in branch ? null : (branch.files ?? readBranchFiles(body.root, branch.base, branch.head, env));
  if ('why' in branch || !files) {
    const why = 'why' in branch ? branch.why : `git can't compare ${branch.head} with ${branch.base}`;
    return { problems: checkPullRequestBody({ body: body.text, files: [] }, config), note: `${why}, so the body was checked without the changed files; CI checks the rest` };
  }
  const pr = { body: body.text, ...files };
  const problems = checkPullRequestBody(pr, config);
  const owned = checkOwnedTier(pr, readCodeOwners(body.root, branch.base, env));
  if (owned) problems.push(owned);
  return { problems };
}

/** Prints the problems with a body the way the title check does, or its note. True when it refuses. */
function refuseBody(invocation: Invocation, { problems, note }: { problems: Finding[]; note?: string }): boolean {
  if (problems.length) {
    print(invocation, [`yokoten bot: ${problems.length} problem(s) in the body; nothing was sent. Fix the body and run it again:`, ...bullets(problems)], invocation.stderr);
    return true;
  }
  if (note) print(invocation, [`yokoten bot: note: ${note}`], invocation.stderr);
  return false;
}

/** The gh options that take a value, by long name, for `pr merge` and `pr status`. */
const PR_VALUE_OPTIONS = new Set(['--repo', '--body', '--body-file', '--subject', '--author-email', '--match-head-commit', '--jq', '--template']);
/** The short forms of those: R, b, F, q, t. */
const PR_VALUE_SHORTS = new Map([['R', '--repo'], ['b', '--body'], ['F', '--body-file'], ['q', '--jq'], ['t', '--template']]);

/** A gh command split into plain words and valued options: a value is never read as a word. */
function splitGhArgs(args: string[]): { words: string[]; options: [string, string][] } {
  const words: string[] = [];
  const options: [string, string][] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      words.push(word);
      continue;
    }
    if (word.startsWith('--')) {
      const cut = word.indexOf('=');
      const name = cut === -1 ? word : word.slice(0, cut);
      if (!PR_VALUE_OPTIONS.has(name)) continue;
      options.push([name, cut === -1 ? (args[++index] ?? '') : word.slice(cut + 1)]);
      continue;
    }
    // A short word: a value letter takes the rest of the word, or the next word.
    const mapped = PR_VALUE_SHORTS.get(word[1]);
    if (mapped === undefined) continue;
    const rest = word.slice(2).replace(/^=/, '');
    options.push([mapped, rest || (args[++index] ?? '')]);
  }
  return { words, options };
}

/** "owner/name" with no URL, path or case left in it, for comparing repos. */
const normalizeRepoName = (name: string): string => name.trim().replace(/^(?:https?:\/\/)?github\.com\//i, '').replace(/\.git\/?$/, '').toLowerCase();

/** Whether the gh command merges a pull request: `pr merge ...`. */
const isPrMerge = (args: string[]): boolean => {
  const { words } = splitGhArgs(args);
  return words[0] === 'pr' && words[1] === 'merge';
};

/** Whether the gh command lists pull requests as a table: `pr status` with no format option. */
const showsPrStatus = (args: string[]): boolean => {
  const { words, options } = splitGhArgs(args);
  if (words[0] !== 'pr' || words[1] !== 'status' || words.length > 2 || args.includes('--json')) return false;
  return !options.some(([name]) => name === '--jq' || name === '--template');
};

/** The `--repo` value of a gh command, or null when it names none. */
const repoFlag = (args: string[]): string | null => splitGhArgs(args).options.filter(([name]) => name === '--repo').at(-1)?.[1] ?? null;

/** The number in a `gh pr view` answer, or null. Never throws. */
function viewedNumber(gh: Gh, args: string[]): number | null {
  try {
    const viewed: unknown = JSON.parse(gh(args));
    if (typeof viewed === 'object' && viewed !== null && typeof (viewed as { number?: unknown }).number === 'number') return (viewed as { number: number }).number;
  } catch {
    // said below
  }
  return null;
}

/** The pull request a `gh pr merge` names: its number and repo, or why it can't be read. */
function mergeRequest(gh: Gh, args: string[], origin: string | null): { number: number; repo: string } | { unsure: string } {
  const { words } = splitGhArgs(args);
  const flag = repoFlag(args);
  const repo = flag ?? origin;
  if (!repo) return { unsure: 'no repo is named and this checkout names no origin' };
  if (flag && origin && normalizeRepoName(flag) !== normalizeRepoName(origin)) return { unsure: `${flag} is not this checkout, so its commits are not here` };
  const repoArgs = flag ? ['--repo', flag] : [];
  const target = words[2];
  if (target === undefined) {
    const number = viewedNumber(gh, ['pr', 'view', '--json', 'number', ...repoArgs]);
    return number === null ? { unsure: 'gh could not say the pull request of this branch' } : { number, repo };
  }
  const digits = /^(\d+)$/.exec(target);
  if (digits) return { number: Number(digits[1]), repo };
  const fromUrl = /\/pull\/(\d+)(?:[/#?]|$)/.exec(target);
  if (fromUrl) return { number: Number(fromUrl[1]), repo };
  if (words.length > 3) return { unsure: 'more than one pull request is named; merge one at a time' };
  // A branch: gh says its pull request's number.
  const number = viewedNumber(gh, ['pr', 'view', target, '--json', 'number', ...repoArgs]);
  return number === null ? { unsure: `gh could not say the pull request of branch \`${target}\`` } : { number, repo };
}

/**
 * Why pull request `number` must not merge yet, or null when it may: not tier A, or the
 * owner's Approve is on its head, or only base merges came after it with the same own
 * diff. What gh or git can't answer is a refusal too: fail closed.
 */
function approvalRefusal(gh: Gh, root: string, env: Env, number: number, repo: string): string | null {
  const state = readApprovalState(gh, root, env, number, repo);
  if ('unsure' in state) return `could not check the owner's Approve (${state.unsure}); ask the owner to approve again`;
  if (state.tier !== 'A') return null;
  const problem = checkApprovalFreshness(state);
  return problem ? problem.what : null;
}

/** Refuses a `gh pr merge` the Approve check stops. True when it refused. */
function refuseStaleMerge(invocation: Invocation, gh: Gh, cwd: string, env: Env, origin: string | null, args: string[]): boolean {
  const found = mergeRequest(gh, args, origin);
  if ('unsure' in found) {
    print(invocation, [`yokoten bot: could not check the owner's Approve (${found.unsure}); nothing was merged. Ask the owner to approve again`], invocation.stderr);
    return true;
  }
  const refusal = approvalRefusal(gh, cwd, env, found.number, found.repo);
  if (!refusal) return false;
  print(invocation, [`yokoten bot: ${refusal}. Nothing was merged`], invocation.stderr);
  return true;
}

/**
 * Runs `gh pr status`, shows its table as gh wrote it, then the Approve check for every
 * open pull request, so the lead sees a stale Approve before trying to merge. Only what
 * must not merge gets a line.
 */
function runPrStatus(invocation: Invocation, file: string, args: string[], run: { cwd: string; token: string; origin: string | null; piped: string | undefined }): number {
  const { stdout, stderr } = invocation;
  const env = botEnv(invocation.env, run.token);
  const gh = ghWith(file, run.cwd, env);
  const shown = spawnSync(file, args, { cwd: run.cwd, stdio: [run.piped === undefined ? (invocation.stdin.fd ?? 'pipe') : 'pipe', 'pipe', 'pipe'], input: run.piped, env, maxBuffer: 1 << 30 });
  if (shown.stdout) stdout.write(shown.stdout);
  if (shown.stderr) stderr.write(shown.stderr);
  if (shown.error) {
    print(invocation, [`yokoten bot: could not run ${file}: ${(shown.error as NodeJS.ErrnoException).code ?? shown.error.message.split('\n')[0]}`], invocation.stderr);
    return 1;
  }
  if (shown.signal) {
    print(invocation, [`yokoten bot: ${file} was ended by ${shown.signal}`], invocation.stderr);
    return 1;
  }
  if (shown.status !== 0) return shown.status ?? 1;
  const flag = repoFlag(args);
  let listed: unknown;
  try {
    listed = JSON.parse(gh(['pr', 'list', '--json', 'number', '--state', 'open', '--limit', '100', ...(flag ? ['--repo', flag] : [])]));
  } catch {
    return 0;
  }
  if (!Array.isArray(listed)) return 0;
  const lines: string[] = [];
  for (const entry of listed) {
    const number = typeof entry === 'object' && entry !== null ? (entry as { number?: unknown }).number : null;
    if (typeof number !== 'number') continue;
    const refusal = approvalRefusal(gh, run.cwd, invocation.env, number, flag ?? run.origin ?? '');
    if (refusal) lines.push(`- #${number}: ${refusal}`);
  }
  if (lines.length) print(invocation, ['yokoten bot: these need a new owner Approve before they merge:', ...lines]);
  return 0;
}

export function runBot(invocation: Invocation): number | Promise<number> {
  const { args } = invocation;
  // No options of its own: everything after `--` is the command, passed on unchanged.
  const end = args.indexOf('--');
  const options = parse('bot', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(invocation, options);
  return bot(invocation, end === -1 ? [] : args.slice(end + 1));
}
