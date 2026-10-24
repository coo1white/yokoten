// The pull request and issue of a GitHub Actions run, the CODEOWNERS file, and the
// findings of a check on the pull request page. The rules that judge them
// (src/rules/pr.ts) know no host; this is the GitHub half.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type Finding, finding, formatFinding, formatFindingMarks, place } from '../../rules/message.ts';
import type { CodeOwners, PullRequest } from '../../rules/pr.ts';
import { readGit } from '../../run/check.ts';
import { asText, type Gh, isObject, labelNames, repoOf, unread } from './planning.ts';

// A pull request as GitHub Actions describes it: the event file of the run. The event
// file holds the title, body, labels and milestone. The changed files come from git,
// between the base and the head commit of the pull request, so the checkout needs both
// (fetch-depth: 0).
//
// What can't be read is one finding, never a crash (#267): a missing or broken event file,
// or a commit the checkout does not have. Then `--json` still prints JSON, and the job
// summary still says why.

/** Why the CI event could not be checked. */
export interface Unreadable {
  problem: Finding;
}

export const EVENT_FIX = 'run it in a GitHub Actions job on a `pull_request` or `issues` event, or set GITHUB_EVENT_PATH to a readable event file';

/** The event of this run as an object, null when there is none, or why it can't be read. */
export function readEvent(env: Env): Record<string, unknown> | Unreadable | null {
  if (!env.GITHUB_EVENT_PATH) return null;
  let raw: string;
  try {
    raw = readFileSync(env.GITHUB_EVENT_PATH, 'utf8');
  } catch {
    return { problem: finding('ci-event', 'the CI event file (GITHUB_EVENT_PATH) can\'t be read', EVENT_FIX) };
  }
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return { problem: finding('ci-event', 'the CI event file (GITHUB_EVENT_PATH) is not valid JSON', EVENT_FIX) };
  }
  if (!isObject(event)) return { problem: finding('ci-event', 'the CI event file (GITHUB_EVENT_PATH) is not a JSON object', EVENT_FIX) };
  return event;
}

export const isUnreadable = (value: unknown): value is Unreadable => isObject(value) && 'problem' in value;

/** The commit is in this checkout. A value that is not a commit id counts as missing. */
function hasCommit(root: string, sha: string, env: Env): boolean {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  try {
    execFileSync('git', ['--no-replace-objects', 'cat-file', '-e', `${sha}^{commit}`], { cwd: root, env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The two commits have a common commit here, so `base...head` can be read. */
function hasMergeBase(root: string, base: string, head: string, env: Env): boolean {
  try {
    execFileSync('git', ['--no-replace-objects', 'merge-base', base, head], { cwd: root, env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const COMMITS_FIX = 'use `fetch-depth: 0` in actions/checkout, so the checkout has the whole history';
export const SHA_FIX = 'run it in a GitHub Actions job on a `pull_request` event, whose base.sha and head.sha are the commits to compare';

/** Which of the event's base and head commit ids are empty, missing or not text, as one finding, or null. */
function shasProblem(base: string, head: string): Finding | null {
  const missing = [['base', base], ['head', head]].filter(([, sha]) => !sha).map(([name]) => name);
  if (missing.length === 2) return finding('pr-commits', 'the pull request\'s base and head commits are missing from the event', SHA_FIX);
  if (missing.length === 1) return finding('pr-commits', `the pull request's ${missing[0]} commit is missing from the event`, SHA_FIX);
  return null;
}

/** Why `base...head` can't be read in this checkout, or null when it can. `fix` says how to get the commits. */
function commitsProblem(root: string, base: string, head: string, env: Env, fix: string = COMMITS_FIX): Finding | null {
  const missing = [['base', base], ['head', head]].filter(([, sha]) => !hasCommit(root, sha, env)).map(([name]) => name);
  if (missing.length === 2) return finding('pr-commits', 'the pull request\'s base and head commits are not in this checkout', fix);
  if (missing.length === 1) return finding('pr-commits', `the pull request's ${missing[0]} commit is not in this checkout`, fix);
  if (!hasMergeBase(root, base, head, env)) return finding('pr-commits', 'the pull request\'s base and head commits have no common commit in this checkout', fix);
  return null;
}

export type PullRequestRead = PullRequest & { base: string; head: string; numstat: string; /** The head branch, '' when the host does not say. */ branch: string };

/** The pull request of this run, null when the run is not for one, or why it can't be read. */
export function readPullRequest(root: string, env: Env): PullRequestRead | Unreadable | null {
  const event = readEvent(env);
  if (event === null || isUnreadable(event)) return event;
  const pr = event.pull_request;
  if (!isObject(pr)) return null;
  const base = isObject(pr.base) ? asText(pr.base.sha) : '';
  const head = isObject(pr.head) ? asText(pr.head.sha) : '';
  const branch = isObject(pr.head) ? asText(pr.head.ref) : '';
  const problem = shasProblem(base, head) ?? commitsProblem(root, base, head, env);
  if (problem) return { problem };
  return withDiff(root, { title: asText(pr.title), body: asText(pr.body), labels: labelNames(pr.labels), milestone: milestoneTitle(pr.milestone), author: isObject(pr.user) ? asText(pr.user.login) : '' }, base, head, env, branch);
}

export const milestoneTitle = (milestone: unknown): string | null => (isObject(milestone) && typeof milestone.title === 'string' ? milestone.title : null);

/** The pull request with the files git lists between `base` and `head`. Both commits must be here. */
function withDiff(root: string, fields: Omit<PullRequest, 'files' | 'deleted'>, base: string, head: string, env: Env, branch = ''): PullRequestRead {
  // A diff git can't give throws a GitReadError, and the check stops on it (#403).
  const diff = (...options: string[]) => readGit(root, ['diff', ...options, `${base}...${head}`], { env }).toString('utf8');
  return {
    ...fields,
    files: diff('--name-only', '-z').split('\0').filter(Boolean),
    deleted: diff('--name-only', '--diff-filter=D', '-z').split('\0').filter(Boolean),
    base,
    head,
    numstat: diff('--numstat', '-z'),
    branch,
  };
}

/**
 * The pull request number in a number (`12`) or a pull request URL
 * (`https://github.com/owner/name/pull/12`), or null. A URL is read only as data: its
 * address is never printed.
 */
export function pullRequestNumber(text: string): string | null {
  const clean = text.trim();
  if (/^[1-9]\d*$/.test(clean)) return clean;
  try {
    const url = new URL(clean);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The fields and diff of one gh answer, or one finding when it can't be read. */
function pullRequestFromGh(root: string, pr: unknown, number: string, fix: string, env: Env): PullRequestRead | Unreadable {
  if (!isObject(pr)) return { problem: finding('pr-read', `gh gave no pull request ${number}`, 'check the number, then run it again') };
  const base = asText(pr.baseRefOid);
  const head = asText(pr.headRefOid);
  const problem = shasProblem(base, head) ?? commitsProblem(root, base, head, env, fix);
  if (problem) return { problem };
  return withDiff(root, { title: asText(pr.title), body: asText(pr.body), labels: labelNames(pr.labels), milestone: milestoneTitle(pr.milestone), author: ghAuthor(pr.author) }, base, head, env, asText(pr.headRefName));
}

/**
 * Pull request `reference` read through gh (#377), so a lead can run `check --pr <number>`
 * in a repo without CI. The reference may be the number or the pull request's URL. The
 * commits come from this clone; when one is missing, the fix says what to fetch. What
 * can't be read is one finding, as in CI.
 */
export function readNumberedPullRequest(root: string, gh: Gh, reference: string, env: Env): PullRequestRead | Unreadable {
  const number = pullRequestNumber(reference);
  if (number === null) return { problem: finding('pr-read', `"${reference}" is not a pull request number or URL`, 'give the number alone, such as `yokoten check --pr 12`, or its URL') };
  let pr: unknown;
  try {
    pr = JSON.parse(gh(['pr', 'view', number, '--json', 'title,body,labels,milestone,author,baseRefOid,headRefOid,headRefName']));
  } catch (err) {
    // gh says this when the repo has no such pull request: a wrong number, not a network problem.
    if (/Could not resolve to a PullRequest/i.test(String((err as { stderr?: string }).stderr || (err as Error).message))) {
      return { problem: finding('pr-read', `no pull request ${number} in ${originRepo(root, env) ?? 'this repo'}`, 'check the number with `gh pr list`, then run it again') };
    }
    const why = unread(err);
    return { problem: finding('pr-read', `pull request ${number} can't be read: ${why.unread}`, why.fix) };
  }
  // No branch name goes into the hint, so nothing in it needs quoting for a shell.
  return pullRequestFromGh(root, pr, number, `run \`git fetch origin\` and \`git fetch origin pull/${number}/head\`, then run it again`, env);
}

/**
 * The pull request of the current branch read through gh, so `yokoten check --pr` can run
 * the CI rules before a push (#615). Null when this branch has no open pull request.
 */
export function readBranchPullRequest(root: string, gh: Gh, env: Env): PullRequestRead | Unreadable | null {
  let pr: unknown;
  try {
    pr = JSON.parse(gh(['pr', 'view', '--json', 'title,body,labels,milestone,author,baseRefOid,headRefOid,headRefName']));
  } catch (err) {
    const said = String((err as { stderr?: string }).stderr || (err as Error).message);
    if (/no (?:open )?pull requests? found|no pull requests? for branch/i.test(said)) return null;
    const why = unread(err);
    return { problem: finding('pr-read', `the pull request for this branch can't be read: ${why.unread}`, why.fix) };
  }
  return pullRequestFromGh(root, pr, 'this branch', 'run `git fetch origin`, then run it again', env);
}

/** One open pull request the sync may update: its number, its branch, and the base branch. */
export interface OpenPull {
  number: number;
  branch: string;
  base: string;
  isFork: boolean;
}

/** The most open pull requests `pr sync` reads: enough for one team's open work. */
export const OPEN_PULL_LIMIT = 100;

/** The open pull requests, and whether gh stopped at the limit so the list may be cut. */
export interface OpenPullList {
  pulls: OpenPull[];
  isCut: boolean;
}

/** Why gh could not list the open pull requests, in words a beginner can act on. */
function openPullsFailed(err: unknown): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
  const reason = unread(err).unread;
  return `gh can't list the open pull requests (${reason}): check the network and \`gh auth login\``;
}

/**
 * The open pull requests of `repo`, read through gh (#432): the ones whose branches the
 * sync can update. A pull request from a fork is kept and marked, since its branch is not
 * on origin. A row without a number or branch is skipped. The list says when it stopped at
 * the limit, so a caller can report that some pull requests were not read. Or why the list
 * can't be read.
 */
export function readOpenPulls(gh: Gh, repo: string): OpenPullList | string {
  let rows: unknown;
  try {
    rows = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PULL_LIMIT), '--json', 'number,headRefName,baseRefName,isCrossRepository']));
  } catch (err) {
    return openPullsFailed(err);
  }
  if (!Array.isArray(rows)) return 'gh gave no pull request list: run it again';
  const pulls: OpenPull[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number < 1) continue;
    const branch = asText(row.headRefName);
    const base = asText(row.baseRefName);
    if (!branch || !base) continue;
    pulls.push({ number: row.number, branch, base, isFork: row.isCrossRepository === true });
  }
  return { pulls, isCut: rows.length >= OPEN_PULL_LIMIT };
}

/**
 * The author login as the CI event names it. gh names an app `app/<name>`, where the event
 * has `<name>[bot]`; the rules match the event's form, such as dependabot[bot].
 */
function ghAuthor(author: unknown): string {
  if (!isObject(author)) return '';
  const login = asText(author.login);
  if (login.startsWith('app/')) return `${login.slice('app/'.length)}[bot]`;
  return author.is_bot === true && login && !login.endsWith('[bot]') ? `${login}[bot]` : login;
}

/** "owner/name" of the origin remote, or null. */
function originRepo(root: string, env: Env): string | null {
  try {
    return repoOf(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

// GitHub reads CODEOWNERS from the first of these places, on the pull request's base
// branch. yokoten reads it from the same commit, so a pull request can't edit the file
// to lower its own tier. Without a base commit (a local run), it reads the working tree.
export const CODEOWNERS_PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** The CODEOWNERS file at the base commit, or in the working tree when `base` is empty; null when there is none. */
export function readCodeOwners(root: string, base: string, env: Env): CodeOwners | null {
  if (base) {
    // Which places the base commit has, then the first one's text. A read git can't answer
    // throws a GitReadError: no answer is never "no CODEOWNERS", which would lower the tier (#403).
    const have = new Set(readGit(root, ['ls-tree', '-z', '--name-only', base, '--', ...CODEOWNERS_PLACES], { env }).toString('utf8').split('\0'));
    const place = CODEOWNERS_PLACES.find((p) => have.has(p));
    return place === undefined ? null : { text: readGit(root, ['show', `${base}:${place}`], { env }).toString('utf8'), from: 'the base branch' };
  }
  for (const place of CODEOWNERS_PLACES) {
    const file = join(root, place);
    if (existsSync(file)) return { text: readFileSync(file, 'utf8'), from: 'the working tree' };
  }
  return null;
}

/**
 * The files a branch changes since it left `base`, as `check --pr` reads them from a pull
 * request (#406): one `git diff --name-status` of `base...head`, run locally. A rename
 * counts as its new path, as `--name-only` gives it. Null when git can't read either ref.
 */
export function readBranchFiles(root: string, base: string, head: string, env: Env): { files: string[]; deleted: string[] } | null {
  let out: string;
  try {
    out = execFileSync('git', ['--no-replace-objects', 'diff', '--name-status', '-z', '--end-of-options', `${base}...${head}`], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const files: string[] = [];
  const deleted: string[] = [];
  const parts = out.split('\0');
  for (let at = 0; at < parts.length - 1; ) {
    const status = parts[at++];
    // A rename or a copy names the old path, then the new one.
    const path = /^[RC]/.test(status) ? parts[(at += 2) - 1] : parts[at++];
    files.push(path);
    if (status === 'D') deleted.push(path);
  }
  return { files, deleted };
}

// An issue as GitHub Actions describes it: the event file of an `issues` run. The rule
// that judges its title (checkIssueTitle in src/rules/pr.ts) knows no host.

/** The issue of this run (its title and label names), null when the run is not for one, or why the event can't be read. */
export function readIssue(env: Env): { title: string; labels: string[] } | Unreadable | null {
  const event = readEvent(env);
  if (event === null || isUnreadable(event)) return event;
  const issue = event.issue;
  // A comment on a pull request carries it as an `issue` too; that title follows the pull request rule.
  if (!isObject(issue) || issue.pull_request) return null;
  return { title: asText(issue.title), labels: labelNames(issue.labels) };
}

// The findings of a check on the pull request page (#91), so a beginner need not open the
// log. The scope stops at yokoten's own check results: this repeats no other review bot
// and reviews no code a second time. Two parts, and neither needs a token:
// - an annotation per finding: a line on stdout, `::error file=…,line=…,title=…::message`,
//   shown on that line of the diff (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands);
// - Markdown appended to the file named by GITHUB_STEP_SUMMARY, shown on the run's page.
// Each carries the rule's link (#94): the annotation in its message, the summary on the id.
// Both are made from the finding's own text, so they hold no private value (core rule 11).

/** This run is a GitHub Actions job. */
export const isGitHubActions = (env: Env): boolean => env.GITHUB_ACTIONS === 'true';

// GitHub shows at most 10 annotations of each kind per step, and 50 per job. The rest
// are in the log and the summary, so more lines would only make the log longer.
const MAX_ANNOTATIONS = 50;
const MAX_SUMMARY_ROWS = 50;

// A workflow command ends at a newline, and its properties at `,` and `::`; GitHub's
// runner decodes these escapes.
const escapeData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text: string) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * One finding as a workflow command: `error` for a problem, `warning` for a note. When
 * `isPlaceAFile` is false (a `check --history` place is a commit or a blob), the place
 * goes into the message instead of `file` and `line`.
 */
export function annotation(f: Finding, level: 'error' | 'warning' | 'notice', isPlaceAFile = true): string {
  const properties: string[] = [];
  const file = isPlaceAFile ? f.file : undefined;
  if (file !== undefined) properties.push(`file=${escapeProperty(file)}`);
  if (file !== undefined && f.line !== undefined) properties.push(`line=${f.line}`);
  properties.push(`title=${escapeProperty(`yokoten ${f.id}`)}`);
  const message = formatFinding(file === undefined ? f : { id: f.id, what: f.what, why: f.why, fix: f.fix, docs: f.docs, grade: f.grade, ignored: f.ignored });
  return `::${level} ${properties.join(',')}::${escapeData(message)}`;
}

/**
 * The annotations for one check: problems first, then the ignores a pull request adds
 * (#616), as notices the reviewer sees, then the other notes. At most 50.
 */
export function annotations(problems: Finding[], notes: Finding[], isPlaceAFile = true): string[] {
  const isNotice = (f: Finding) => f.id === 'ignore-added';
  const all = [
    ...problems.map((f) => annotation(f, 'error', isPlaceAFile)),
    ...notes.filter(isNotice).map((f) => annotation(f, 'notice', isPlaceAFile)),
    ...notes.filter((f) => !isNotice(f)).map((f) => annotation(f, 'warning', isPlaceAFile)),
  ];
  return all.slice(0, MAX_ANNOTATIONS);
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// A backslash first, or `a\|b` would close the cell; `<` because the summary is HTML.
const cell = (text: string) =>
  text.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;');
// The rule's id links to where it is explained (#94), when there is a link.
const ruleCell = (f: Finding) => (f.docs === undefined ? cell(f.id) : `[${cell(f.id)}](${cell(f.docs)})`);
const row = (f: Finding) =>
  `| ${cell(place(f).replace(/: $/, ''))} | ${ruleCell(f)} | ${cell(f.what + formatFindingMarks(f))} | ${cell(capitalize(f.why))} | ${cell(capitalize(f.fix))} |`;
const TABLE_HEAD = ['| Place | Rule | What | Why | Fix |', '|-------|------|------|-----|-----|'];

/**
 * The job summary for one check, as Markdown: a heading with the result, a table of the
 * problems, and the notes in their own section. At most 50 rows; it says how many more.
 */
export function stepSummary(name: string, problems: Finding[], notes: Finding[]): string {
  const count = problems.length;
  const lines = [`### ${name}: ${count ? `${count} problem${count === 1 ? '' : 's'}` : 'ok'}`, ''];
  let room = MAX_SUMMARY_ROWS;
  const table = (findings: Finding[]) => {
    const shown = findings.slice(0, room);
    room -= shown.length;
    lines.push(...TABLE_HEAD, ...shown.map(row));
    if (findings.length > shown.length) lines.push('', `And ${findings.length - shown.length} more. The job log lists them all.`);
    lines.push('');
  };
  if (count) table(problems);
  if (notes.length) {
    lines.push(`#### Notes (${notes.length}): these never fail the check`, '');
    if (room) table(notes);
    else lines.push(`The job log lists them.`, '');
  }
  return `${lines.join('\n')}\n`;
}

// One comment per pull request (#615). The `pr` workflow's comment job posts the
// findings of `check --pr`, edits that same comment on every run, and deletes it when
// the check passes. A local run never gets here: only GitHub Actions with --comment
// calls this module.
//
// The comment is found by a hidden marker, so an edit follows the same comment however
// many runs there are. Its text is the same summary the job page shows; a finding never
// carries a private value or text from the pull request (core rule 11).
//
// The token is sent only over https (or to this machine, for tests). No message names
// the token or the API's address.

/** The hidden line that marks yokoten's comment. */
export const CHECK_COMMENT_MARKER = '<!-- yokoten check --pr -->';

/** What the comment job did, and why when it failed. Never holds a token. */
export interface CommentOutcome {
  action: 'created' | 'updated' | 'deleted' | 'none' | 'failed';
  problem?: string;
}

/** How long one API call waits. */
const API_TIMEOUT_MS = 15000;

/** The comment's body for one check: the marker, the summary, and how it behaves. */
export function checkComment(name: string, problems: Finding[], notes: Finding[]): string {
  const summary = stepSummary(name, problems, notes).trimEnd();
  return `${CHECK_COMMENT_MARKER}\n${summary}\n\nThis comment is edited on each run. It is removed when the check passes.\n`;
}

/** The API's address can carry a token: https, or plain http to this machine only. */
function isSafeApi(api: string): boolean {
  try {
    const url = new URL(api);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

interface Place {
  api: string;
  token: string;
  repo: string;
  number: number;
}

const PLACE_FIX = 'run it in a pull_request job with `GITHUB_TOKEN: ${{ github.token }}` and `pull-requests: write`';

/** The repo, number, token and API of this run, or why they can't be read. */
function placeOf(env: Env): Place | string {
  const token = env.GITHUB_TOKEN;
  if (!token) return `GITHUB_TOKEN is not set, so the comment can't be posted; ${PLACE_FIX}`;
  const event = readEvent(env);
  if (event === null) return `there is no CI event file (GITHUB_EVENT_PATH), so the pull request is not named; ${PLACE_FIX}`;
  if (isUnreadable(event)) return `the CI event file (GITHUB_EVENT_PATH) can't be read, so the pull request is not named; ${PLACE_FIX}`;
  const pr = isObject(event.pull_request) ? event.pull_request : {};
  const number = pr.number;
  const repo = isObject(event.repository) ? asText(event.repository.full_name) : asText(env.GITHUB_REPOSITORY);
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return `the CI event names no pull request number; ${PLACE_FIX}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return `the CI event names no repository; ${PLACE_FIX}`;
  const api = (env.YOKOTEN_GITHUB_API || env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  if (!isSafeApi(api)) return 'the GitHub API address is not https, so the token is not sent; set GITHUB_API_URL or YOKOTEN_GITHUB_API to an https address';
  return { api, token, repo, number };
}

/** One API call with the token in the header. The answer is JSON, or null for an empty one. */
async function call(place: Place, method: string, route: string, body?: unknown): Promise<{ status: number; answer: unknown }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${place.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'yokoten',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${place.api}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  let answer: unknown = null;
  if (res.status !== 204) {
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
  }
  return { status: res.status, answer };
}

/** The pull request's first comment that carries yokoten's marker, or null. */
function markerComment(comments: unknown): { id: number; body: string } | null {
  if (!Array.isArray(comments)) return null;
  for (const comment of comments) {
    if (!isObject(comment) || typeof comment.id !== 'number') continue;
    const body = asText(comment.body);
    if (body.startsWith(CHECK_COMMENT_MARKER)) return { id: comment.id, body };
  }
  return null;
}

/**
 * Keep one comment on the pull request: create it, edit it, or delete it when `body` is
 * null. A failed call returns `failed` and never throws, so a comment problem never
 * changes the check's result.
 */
export async function upsertPullRequestComment(env: Env, body: string | null): Promise<CommentOutcome> {
  const place = placeOf(env);
  if (typeof place === 'string') return { action: 'failed', problem: place };
  try {
    const list = await call(place, 'GET', `/repos/${place.repo}/issues/${place.number}/comments?per_page=100`);
    if (list.status !== 200) return { action: 'failed', problem: `GitHub answered ${list.status} when the comments were read` };
    const found = markerComment(list.answer);
    if (body === null) {
      if (!found) return { action: 'none' };
      const removed = await call(place, 'DELETE', `/repos/${place.repo}/issues/comments/${found.id}`);
      if (removed.status !== 204 && removed.status !== 200) return { action: 'failed', problem: `GitHub answered ${removed.status} when the comment was removed` };
      return { action: 'deleted' };
    }
    if (found) {
      const edited = await call(place, 'PATCH', `/repos/${place.repo}/issues/comments/${found.id}`, { body });
      if (edited.status !== 200) return { action: 'failed', problem: `GitHub answered ${edited.status} when the comment was edited` };
      return { action: 'updated' };
    }
    const made = await call(place, 'POST', `/repos/${place.repo}/issues/${place.number}/comments`, { body });
    if (made.status !== 201) return { action: 'failed', problem: `GitHub answered ${made.status} when the comment was made` };
    return { action: 'created' };
  } catch {
    return { action: 'failed', problem: 'GitHub gave no answer when the comment was posted' };
  }
}
