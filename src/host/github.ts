// The GitHub adapter. Everything yokoten knows about GitHub's API lives in src/host/
// (record 0004); a rule or a step names what it needs in host-neutral words. The parts,
// in order:
// - the bot, and the title a `gh issue` or `gh pr` command sets;
// - the pull request and the issue of a CI run, and the CODEOWNERS file;
// - the findings of a check on the pull request page;
// - labels and milestones (the planning setup);
// - the server settings, read only.
//
// The bot: a GitHub App that pushes branches and opens pull requests for the lead, so
// the owner's account is never used for that. It signs in with one-hour tokens made from
// its private key.
//
// The token is handed to one command's environment and never printed: a printed token
// lands in the agent's transcript.

import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { docsLink, type Finding, finding, formatFinding, place } from '../rules/message.ts';
import { readLabelTier, type CodeOwners, type PullRequest } from '../rules/pr.ts';
import { homeOf, NO_HOME } from '../rules/privacy.ts';
import { readGit } from '../run/check.ts';
import { type Incident, terminalText } from '../run/learn.ts';

export interface BotConfig {
  appId: string;
  /** Path to the App's private key (.pem). */
  keyFile: string;
  /** The installation id; found from the repo when not set. */
  installation?: string;
  api: string;
}

/** The keys file, as the reports name it. */
export const KEYS_FILE = '~/.config/yokoten/keys.env';

/** The bot's own settings, the only names read from the keys file. */
const BOT_SETTINGS = ['YOKOTEN_BOT_APP_ID', 'YOKOTEN_BOT_KEY', 'YOKOTEN_BOT_INSTALLATION'];

/**
 * A value as a shell profile line gives it: quotes taken off, a ` # comment` after an
 * unquoted value dropped, and a leading `~/` or `$HOME/` made the home folder. Single
 * quotes keep `$HOME` as it is, and quotes keep `~`, as in a shell.
 */
export function shellValue(raw: string, home: string): string {
  const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw.trim());
  if (quoted?.[1] === "'") return quoted[2];
  if (quoted) return quoted[2].replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, home);
  return raw.replace(/(?:^|\s+)#.*$/, '').trim().replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

/**
 * The bot's settings in the keys file (#405): `NAME=value` lines, `export` and quotes
 * allowed. A session's environment often does not load this file, so the bot reads it
 * itself. Only the bot's own names are read; other keys in the file are never touched.
 * No HOME, no file: then nothing.
 */
export function readKeysFile(env: Env): Env {
  const home = homeOf(env);
  if (!home) return {};
  let text = '';
  try {
    text = readFileSync(join(home, '.config', 'yokoten', 'keys.env'), 'utf8');
  } catch {
    return {};
  }
  const found: Env = {};
  for (const line of text.split(/\r?\n/)) {
    const pair = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!pair || !BOT_SETTINGS.includes(pair[1])) continue;
    const value = shellValue(pair[2], home);
    if (value) found[pair[1]] = value;
  }
  return found;
}

/**
 * The bot's settings, or the reason they are not usable. The environment comes first,
 * then the keys file. `yokoten bot` and the road's bot step both read them here, so
 * they always agree (#405).
 */
export function botConfig(env: Env): BotConfig | string {
  const settings = { ...readKeysFile(env), ...Object.fromEntries(BOT_SETTINGS.filter((name) => env[name]).map((name) => [name, env[name]])) };
  const appId = settings.YOKOTEN_BOT_APP_ID;
  if (!appId) return `YOKOTEN_BOT_APP_ID is not set, in the environment or in ${KEYS_FILE}: the App ID from the App's settings page (step 3 of ${docsLink('server.md')})`;
  const keyFile = settings.YOKOTEN_BOT_KEY || defaultKeyFile(env);
  if (!keyFile) return `${NO_HOME}: set YOKOTEN_BOT_KEY to the key file's full path`;
  return {
    appId,
    keyFile,
    installation: settings.YOKOTEN_BOT_INSTALLATION || undefined,
    api: (env.YOKOTEN_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
  };
}

/** The key file's default place, or '' with no home (#356): never the system's home. */
const defaultKeyFile = (env: Env) => {
  const home = homeOf(env);
  return home ? join(home, '.config', 'yokoten', 'bot.pem') : '';
};

/**
 * What of the bot's setup is missing on this machine, in words, or null when it is all
 * here. Names a setting or a file, never a value. Reads no network.
 */
export function missingBotSetup(env: Env): string | null {
  const config = botConfig(env);
  if (typeof config !== 'string') return existsSync(config.keyFile) ? null : `the bot's key file is missing (${env.YOKOTEN_BOT_KEY || readKeysFile(env).YOKOTEN_BOT_KEY ? 'YOKOTEN_BOT_KEY' : '~/.config/yokoten/bot.pem'})`;
  const isKeyHere = existsSync(defaultKeyFile(env));
  return `${isKeyHere ? "the bot's key file is here, but " : ''}YOKOTEN_BOT_APP_ID is not set, in the environment or in ${KEYS_FILE}`;
}

/** A bot is set up on this machine: its App ID is set and its key file is there. Reads no network. */
export function hasBot(env: Env): boolean {
  return missingBotSetup(env) === null;
}

const b64url =(data: string | Buffer) => Buffer.from(data).toString('base64url');

/** A JWT that says "I am App `appId`", signed RS256, good for nine minutes (GitHub allows ten). */
export function appJwt(appId: string, keyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // Issued a minute back, in case this clock runs ahead of GitHub's.
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), createPrivateKey(keyPem));
  return `${header}.${payload}.${b64url(signature)}`;
}

/** "owner/name" from a GitHub remote URL (https or ssh), or null. */
export function repoOf(remote: string): string | null {
  return remote.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

// The title a gh command sets is read in rules/pr.ts, where the guard reads it too (#391).
export { type BotProgram, botProgram, type CommandTitle, readCommandTitle, type UnreadableTitle } from '../rules/pr.ts';

/** An installation token for `repo`, good for one hour. */
export async function installationToken(config: BotConfig, repo: string): Promise<string> {
  const jwt = appJwt(config.appId, readFileSync(config.keyFile, 'utf8'));
  const call = async (method: string, path: string) => {
    const res = await fetch(`${config.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'yokoten' },
    });
    if (!res.ok) throw new Error(`GitHub said ${res.status} to ${method} ${path}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as { id?: number; token?: string };
  };
  const id = config.installation ?? (await call('GET', `/repos/${repo}/installation`)).id;
  const { token } = await call('POST', `/app/installations/${id}/access_tokens`);
  if (!token) throw new Error('GitHub sent no token');
  return token;
}

// `node --test` sets NODE_TEST_CONTEXT for the test files it starts. A `node --test` that
// inherits it reports to that parent run instead, and exits 0 even when a test fails (#168).

/** A copy of `env` that a child `node --test` cannot mistake for a parent test run's. */
export function cleanChildEnv(env: Env): Env {
  const clean = { ...env };
  delete clean.NODE_TEST_CONTEXT;
  return clean;
}

/** The environment for one command run as the bot: gh reads GH_TOKEN, and git asks gh.
 * TZ is always UTC (#488): gh sends it as the Time-Zone header, and GitHub writes that
 * zone into the commits it makes, such as a merge. The command may run tests (a push
 * hook, npm test), so it gets a clean child env (#168). */
export function botEnv(env: Env, token: string): Env {
  // Added after any git config already passed this way. The empty value clears other
  // credential helpers for github.com, so git cannot fall back to the owner's login.
  const count = Number(env.GIT_CONFIG_COUNT) || 0;
  const key = 'credential.https://github.com.helper';
  return {
    ...cleanChildEnv(env),
    TZ: 'UTC',
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: '',
    [`GIT_CONFIG_KEY_${count + 1}`]: key,
    [`GIT_CONFIG_VALUE_${count + 1}`]: '!gh auth git-credential',
  };
}

// A pull request as GitHub Actions describes it: the event file of the run. The rule that
// judges it (src/rules/pr.ts) knows no host; this part is the GitHub half.
//
// The event file holds the title, body, labels and milestone. The changed files come from
// git, between the base and the head commit of the pull request, so the checkout needs
// both (fetch-depth: 0).
//
// What can't be read is one finding, never a crash (#267): a missing or broken event file,
// or a commit the checkout does not have. Then `--json` still prints JSON, and the job
// summary still says why.

/** Why the CI event could not be checked. */
export interface Unreadable {
  problem: Finding;
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The label names; a label that is not an object with a name is skipped. */
export const labelNames = (labels: unknown): string[] => (Array.isArray(labels) ? labels.map((l) => (isObject(l) ? asText(l.name) : '')).filter(Boolean) : []);

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

export type PullRequestRead = PullRequest & { base: string; head: string; numstat: string };

/** The pull request of this run, null when the run is not for one, or why it can't be read. */
export function readPullRequest(root: string, env: Env): PullRequestRead | Unreadable | null {
  const event = readEvent(env);
  if (event === null || isUnreadable(event)) return event;
  const pr = event.pull_request;
  if (!isObject(pr)) return null;
  const base = isObject(pr.base) ? asText(pr.base.sha) : '';
  const head = isObject(pr.head) ? asText(pr.head.sha) : '';
  const problem = shasProblem(base, head) ?? commitsProblem(root, base, head, env);
  if (problem) return { problem };
  return withDiff(root, { title: asText(pr.title), body: asText(pr.body), labels: labelNames(pr.labels), milestone: milestoneTitle(pr.milestone), author: isObject(pr.user) ? asText(pr.user.login) : '' }, base, head, env);
}

export const milestoneTitle = (milestone: unknown): string | null => (isObject(milestone) && typeof milestone.title === 'string' ? milestone.title : null);

/** The pull request with the files git lists between `base` and `head`. Both commits must be here. */
function withDiff(root: string, fields: Omit<PullRequest, 'files' | 'deleted'>, base: string, head: string, env: Env): PullRequestRead {
  // A diff git can't give throws a GitReadError, and the check stops on it (#403).
  const diff = (...options: string[]) => readGit(root, ['diff', ...options, `${base}...${head}`], { env }).toString('utf8');
  return {
    ...fields,
    files: diff('--name-only', '-z').split('\0').filter(Boolean),
    deleted: diff('--name-only', '--diff-filter=D', '-z').split('\0').filter(Boolean),
    base,
    head,
    numstat: diff('--numstat', '-z'),
  };
}

/**
 * Pull request `number` read through gh (#377), so a lead can run `check --pr <number>` in a
 * repo without CI. The commits come from this clone; when one is missing, the fix says
 * what to fetch. What can't be read is one finding, as in CI.
 */
export function readNumberedPullRequest(root: string, gh: Gh, number: string, env: Env): PullRequestRead | Unreadable {
  if (!/^[1-9]\d*$/.test(number)) return { problem: finding('pr-read', `"${number}" is not a pull request number`, 'give the number alone, such as `yokoten check --pr 12`') };
  let pr: unknown;
  try {
    pr = JSON.parse(gh(['pr', 'view', number, '--json', 'title,body,labels,milestone,author,baseRefOid,headRefOid']));
  } catch (err) {
    // gh says this when the repo has no such pull request: a wrong number, not a network problem.
    if (/Could not resolve to a PullRequest/i.test(String((err as { stderr?: string }).stderr || (err as Error).message))) {
      return { problem: finding('pr-read', `no pull request ${number} in ${originRepo(root, env) ?? 'this repo'}`, 'check the number with `gh pr list`, then run it again') };
    }
    const why = unread(err);
    return { problem: finding('pr-read', `pull request ${number} can't be read: ${why.unread}`, why.fix) };
  }
  if (!isObject(pr)) return { problem: finding('pr-read', `gh gave no pull request ${number}`, 'check the number, then run it again') };
  const base = asText(pr.baseRefOid);
  const head = asText(pr.headRefOid);
  // No branch name goes into the hint, so nothing in it needs quoting for a shell.
  const fetch = `run \`git fetch origin\` and \`git fetch origin pull/${number}/head\`, then run it again`;
  const problem = shasProblem(base, head) ?? commitsProblem(root, base, head, env, fetch);
  if (problem) return { problem };
  return withDiff(root, { title: asText(pr.title), body: asText(pr.body), labels: labelNames(pr.labels), milestone: milestoneTitle(pr.milestone), author: ghAuthor(pr.author) }, base, head, env);
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
// log. Two parts, and neither needs a token:
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
export function annotation(f: Finding, level: 'error' | 'warning', isPlaceAFile = true): string {
  const properties: string[] = [];
  const file = isPlaceAFile ? f.file : undefined;
  if (file !== undefined) properties.push(`file=${escapeProperty(file)}`);
  if (file !== undefined && f.line !== undefined) properties.push(`line=${f.line}`);
  properties.push(`title=${escapeProperty(`yokoten ${f.id}`)}`);
  const message = formatFinding(file === undefined ? f : { id: f.id, what: f.what, why: f.why, fix: f.fix, docs: f.docs });
  return `::${level} ${properties.join(',')}::${escapeData(message)}`;
}

/** The annotations for one check: problems first, then notes, at most 50. */
export function annotations(problems: Finding[], notes: Finding[], isPlaceAFile = true): string[] {
  const all = [...problems.map((f) => annotation(f, 'error', isPlaceAFile)), ...notes.map((f) => annotation(f, 'warning', isPlaceAFile))];
  return all.slice(0, MAX_ANNOTATIONS);
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// A backslash first, or `a\|b` would close the cell; `<` because the summary is HTML.
const cell = (text: string) =>
  text.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;');
// The rule's id links to where it is explained (#94), when there is a link.
const ruleCell = (f: Finding) => (f.docs === undefined ? cell(f.id) : `[${cell(f.id)}](${cell(f.docs)})`);
const row = (f: Finding) =>
  `| ${cell(place(f).replace(/: $/, ''))} | ${ruleCell(f)} | ${cell(f.what)} | ${cell(capitalize(f.why))} | ${cell(capitalize(f.fix))} |`;
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

// The planning setup (#10): labels and milestones, read and changed through `gh`, so
// yokoten uses the owner's own sign-in and holds no token. `Gh` runs one gh command and
// returns its stdout; it throws when gh fails. Tests pass a fake, so they never reach GitHub.
// Every call names the repo, so gh never guesses it from another remote.

export type Gh = (args: string[]) => string;

/** Runs the real gh in `cwd`, with `env`. With `timeout` (ms), a call that takes longer is stopped and throws. */
export const ghIn =
  (cwd: string, env: Env, timeout?: number): Gh =>
  (args) =>
    execFileSync('gh', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });

/**
 * True when the GitHub account `owner` is an organization, false when it is a user, and
 * null when gh can't tell: not installed, not signed in, or no answer (#313). One call.
 * A bare `@org` is not a valid CODEOWNERS owner: GitHub wants a person or `@org/team`.
 */
export function isOrganization(gh: Gh, owner: string): boolean | null {
  try {
    const type = gh(['api', `users/${owner}`, '--jq', '.type']).trim();
    return type === 'Organization' ? true : type === 'User' ? false : null;
  } catch {
    return null;
  }
}

/**
 * True when GitHub says `repo` ("owner/name") is private, false when it is public, and
 * null when gh can't tell (#377). One call. A private repo pays for its Actions minutes.
 */
export function isPrivateRepo(gh: Gh, repo: string): boolean | null {
  try {
    const said = gh(['api', `repos/${repo}`, '--jq', '.private']).trim();
    return said === 'true' ? true : said === 'false' ? false : null;
  } catch {
    return null;
  }
}

/**
 * The milestone title of issue `number`, from one `gh issue view` (#512): null when the
 * issue has none, undefined when gh can't read it. `repo` is the `--repo` value, if any.
 */
export function readIssueMilestone(gh: Gh, number: number, repo: string | null): string | null | undefined {
  try {
    const said: unknown = JSON.parse(gh(['issue', 'view', String(number), '--json', 'milestone', ...(repo ? ['--repo', repo] : [])]));
    if (!isObject(said) || !('milestone' in said)) return undefined;
    const milestone = said.milestone;
    if (milestone === null) return null;
    return isObject(milestone) && typeof milestone.title === 'string' && milestone.title ? milestone.title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The login gh is signed in with, or null: gh not installed, not signed in, or no answer
 * (#390). Used only to add it to the private marks; it is never printed.
 */
export function readLogin(gh: Gh): string | null {
  try {
    const login = gh(['api', 'user', '--jq', '.login']).trim();
    return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login) ? login : null;
  } catch {
    return null;
  }
}

/**
 * The logins gh is signed in with, from its hosts.yml on this machine, with no network
 * call (#392): `user:` under each host. GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh, then
 * ~/.config/gh, as gh looks. None when the file is missing.
 */
export function readLocalLogins(env: Env): string[] {
  const home = homeOf(env);
  const dir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'gh') : home ? join(home, '.config', 'gh') : null);
  if (!dir) return [];
  try {
    const text = readFileSync(join(dir, 'hosts.yml'), 'utf8');
    return [...new Set([...text.matchAll(/^\s+user:\s*["']?([A-Za-z0-9][A-Za-z0-9-]*)["']?\s*$/gm)].map((match) => match[1]))];
  } catch {
    return [];
  }
}

/**
 * The label names of the repo gh works in (`gh label list`), or null when gh can't
 * list them: not installed, not signed in, or no answer. A check that needs them then
 * reads without them, never as a failure.
 */
export function readRepoLabelNames(gh: Gh): string[] | null {
  try {
    const parsed: unknown = JSON.parse(gh(['label', 'list', '--json', 'name', '--limit', '1000']));
    if (!Array.isArray(parsed)) return null;
    return parsed.map((label) => (isObject(label) ? asText(label.name) : '')).filter(Boolean);
  } catch {
    return null;
  }
}

/** A label as the host keeps it. `color` is six hex digits, with no `#`. */
export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Planning {
  /** "owner/name". */
  repo: string;
  labels: Label[];
  milestones: { title: string; open: boolean }[];
}

/** The labels and milestones of `repo` ("owner/name"), or why gh can't read them. */
export function readPlanning(gh: Gh, repo: string): Planning | Unread {
  try {
    const lines = (path: string, jq: string) => gh(['api', '--paginate', path, '--jq', jq]).split('\n').filter(Boolean);
    // One JSON object per line, so a description with a space or a comma stays whole.
    const labels = lines(`repos/${repo}/labels?per_page=100`, '.[] | {name, color, description} | tojson').map((line) => JSON.parse(line) as Partial<Label>);
    const milestones = lines(`repos/${repo}/milestones?state=all&per_page=100`, '.[] | "\\(.state) \\(.title)"')
      .map((line) => {
        const [state, ...title] = line.split(' ');
        return { title: title.join(' '), open: state === 'open' };
      });
    return { repo, labels: labels.map((l) => ({ name: l.name ?? '', color: l.color ?? '', description: l.description ?? '' })).filter((l) => l.name), milestones };
  } catch (err) {
    return unread(err);
  }
}

export function createLabel(gh: Gh, repo: string, label: Label): void {
  gh(['label', 'create', label.name, '-R', repo, '--color', label.color, '--description', label.description]);
}

/** Sets the colour and description of the label called `name`, which keeps its name. */
export function editLabel(gh: Gh, repo: string, name: string, label: Label): void {
  gh(['label', 'edit', name, '-R', repo, '--color', label.color, '--description', label.description]);
}

/** Deletes a label. The host also takes it off every issue and pull request. */
export function deleteLabel(gh: Gh, repo: string, name: string): void {
  gh(['label', 'delete', name, '-R', repo, '--yes']);
}

export function createMilestone(gh: Gh, repo: string, title: string): void {
  gh(['api', '--method', 'POST', `repos/${repo}/milestones`, '-f', `title=${title}`]);
}

// The optional board (#156): a GitHub Project linked to the repo. Projects need the gh
// token's `project` scope, which `gh auth login` does not ask for. The views and the
// built-in workflows have no API, so the owner sets them by hand; doctor lists them.

/** A board, as the host numbers it under its owner. */
export interface Board {
  number: number;
  title: string;
}

/** What to run when the gh token has no `project` scope. */
export const PROJECT_SCOPE_FIX = 'run `gh auth refresh -s project`';

/** gh failed because the token lacks a scope (GraphQL and `gh project` say it differently). */
export function isScopeMissing(err: unknown): boolean {
  return /required scopes|INSUFFICIENT_SCOPES|read:project/i.test(String((err as { stderr?: string }).stderr || (err as Error).message));
}

/** Why gh can't read the boards: a missing scope has its own fix. */
export function boardUnread(err: unknown): Unread {
  return isScopeMissing(err) ? { unread: 'the gh token has no `project` scope', fix: PROJECT_SCOPE_FIX } : unread(err);
}

const LINKED_BOARDS = 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { projectsV2(first: 100) { nodes { number title } } } }';

/** The boards linked to `repo`, or why gh can't read them. */
export function readLinkedBoards(gh: Gh, repo: string): Board[] | Unread {
  const [owner, name] = repo.split('/');
  try {
    const text = gh(['api', 'graphql', '-f', `query=${LINKED_BOARDS}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
    const data = JSON.parse(text || '{}') as { data?: { repository?: { projectsV2?: { nodes?: Partial<Board>[] } } } };
    return (data.data?.repository?.projectsV2?.nodes ?? []).filter((b) => typeof b.number === 'number').map((b) => ({ number: b.number!, title: b.title ?? '' }));
  } catch (err) {
    return boardUnread(err);
  }
}

/** The open boards of `owner` (a user or an organization), linked or not. */
export function readOwnerBoards(gh: Gh, owner: string): Board[] | Unread {
  try {
    const data = JSON.parse(gh(['project', 'list', '--owner', owner, '--format', 'json', '--limit', '100']) || '{}') as { projects?: Partial<Board>[] };
    return (data.projects ?? []).filter((b) => typeof b.number === 'number').map((b) => ({ number: b.number!, title: b.title ?? '' }));
  } catch (err) {
    return boardUnread(err);
  }
}

/** The board's Status field: its id and its option names, or null when it has none. */
export function readStatusField(gh: Gh, owner: string, number: number): { id: string; options: string[] } | null {
  const data = JSON.parse(gh(['project', 'field-list', String(number), '--owner', owner, '--format', 'json']) || '{}') as {
    fields?: { id?: string; name?: string; options?: { name?: string }[] }[];
  };
  const field = data.fields?.find((f) => f.name === 'Status' && Array.isArray(f.options));
  return field?.id ? { id: field.id, options: (field.options ?? []).map((o) => o.name ?? '') } : null;
}

/** Makes a board owned by `owner`, and returns its number. */
export function createBoard(gh: Gh, owner: string, title: string): number {
  const made = JSON.parse(gh(['project', 'create', '--owner', owner, '--title', title, '--format', 'json'])) as { number?: number };
  if (typeof made.number !== 'number') throw new Error('gh made the board but did not say its number');
  return made.number;
}

/** Links board `number` of the repo's owner to `repo` ("owner/name"). */
export function linkBoard(gh: Gh, repo: string, number: number): void {
  const [owner, name] = repo.split('/');
  gh(['project', 'link', String(number), '--owner', owner, '--repo', name]);
}

const SET_OPTIONS = 'mutation($field: ID!) { updateProjectV2Field(input: {fieldId: $field, singleSelectOptions: [OPTIONS]}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }';
const OPTION_COLORS = ['GRAY', 'BLUE', 'YELLOW', 'GREEN', 'PURPLE', 'ORANGE', 'RED', 'PINK'];

/**
 * Replaces the options of a single-select field. The host forgets which item had which
 * option, so this is only for a board yokoten has just made.
 */
export function setFieldOptions(gh: Gh, fieldId: string, options: string[]): void {
  const list = options.map((name, index) => `{name: ${JSON.stringify(name)}, color: ${OPTION_COLORS[index % OPTION_COLORS.length]}, description: ""}`).join(', ');
  gh(['api', 'graphql', '-f', `query=${SET_OPTIONS.replace('OPTIONS', list)}`, '-f', `field=${fieldId}`]);
}

// The server settings (#7): what the owner sets once per repo, read through `gh api`.
// Read only: nothing here changes a setting. A part gh can't read is an `Unread`, never
// a crash, so doctor says it could not check and goes on.

/** Why a part could not be read, and what to do. */
export interface Unread {
  unread: string;
  fix: string;
}

/** The rules that apply to the default branch, from every active ruleset. */
export interface BranchRules {
  pullRequest: boolean;
  codeOwnerReview: boolean;
  /** Merge methods the rules allow; empty when they do not limit them. */
  mergeMethods: string[];
  requiredChecks: string[];
  noForcePush: boolean;
  noDeletion: boolean;
  /** The approving reviews a merge needs: the most any ruleset, or the old branch protection, asks for; null when no ruleset asks and the old protection can't be read. */
  approvals: number | null;
}

/** Each security switch: on, off, or null when gh can't see it. */
export interface Security {
  secretScanning: boolean | null;
  pushProtection: boolean | null;
  privateReporting: boolean | null;
  dependabotAlerts: boolean | null;
}

export interface ServerSettings {
  repo: string;
  defaultBranch: string;
  /** Whether the repo is private, or null when GitHub did not say. */
  isPrivate: boolean | null;
  /** Whether a workflow may approve a pull request (an Actions setting), or null without admin rights. */
  actionsCanApprove: boolean | null;
  /** Merge methods the repo allows, or null without admin rights. */
  mergeMethods: string[] | null;
  deleteBranchOnMerge: boolean | null;
  branch: BranchRules | Unread;
  /** A ruleset on v* tags limits creation, update and deletion. */
  tags: boolean | Unread;
  security: Security;
  /** Branches with no open pull request, apart from the default branch. */
  forgotten: string[] | Unread;
  /** The labels and milestones (#10), for the road's stage 2. Left out by a reader that does not need them. */
  planning?: Planning | Unread;
  /** The boards linked to the repo (#156), so doctor can list what to set by hand. */
  boards?: Board[] | Unread;
  /** The organization that owns the repo, from the same repo read; null for a user. Left out when unknown (#313). */
  org?: string | null;
}

/** Why gh failed, in words a beginner can act on. */
export function unread(err: unknown): Unread {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { unread: 'gh is not installed', fix: 'get it from https://cli.github.com, then run `gh auth login`' };
  if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') return { unread: 'GitHub took too long to answer', fix: 'check the network, then run doctor again' };
  const said = String((err as { stderr?: string }).stderr || (err as Error).message);
  if (/HTTP 401|gh auth login|not logged in/i.test(said)) return { unread: 'gh is not signed in', fix: 'run `gh auth login`' };
  if (/Upgrade to GitHub Pro/i.test(said)) return { unread: 'rulesets need GitHub Pro on a private repo', fix: 'make the repo public, or upgrade to GitHub Pro (or Team for an organization)' };
  if (/HTTP 40[34]/.test(said)) return { unread: 'GitHub said no (403 or 404)', fix: 'sign in to gh as a repo admin; on a private repo, rulesets need GitHub Pro' };
  return { unread: 'gh could not reach GitHub', fix: 'check the network, then run doctor again' };
}

type Rule = { type?: string; parameters?: Record<string, unknown> };
type Ruleset = { id?: number; target?: string; enforcement?: string; conditions?: { ref_name?: { include?: string[] } }; rules?: Rule[] };

/** The server settings of `repo` ("owner/name"), or why gh can't read the repo at all. */
export function readServer(gh: Gh, repo: string): ServerSettings | Unread {
  const api = <T>(path: string): T => JSON.parse(gh(['api', path]) || 'null') as T;
  const lines = (path: string, jq: string) => gh(['api', '--paginate', path, '--jq', jq]).split('\n').filter(Boolean);
  const attempt = <T>(read: () => T): T | Unread => {
    try {
      return read();
    } catch (err) {
      return unread(err);
    }
  };
  type Repo = {
    default_branch?: string;
    private?: boolean;
    permissions?: { admin?: boolean };
    allow_squash_merge?: boolean;
    allow_merge_commit?: boolean;
    allow_rebase_merge?: boolean;
    delete_branch_on_merge?: boolean;
    security_and_analysis?: Record<string, { status?: string } | undefined>;
    owner?: { login?: string; type?: string };
  };
  const info = attempt(() => api<Repo>(`repos/${repo}`));
  if ('unread' in info) return info;
  const defaultBranch = info.default_branch ?? 'main';
  // GitHub sends the merge settings only to an admin.
  const methods: [string, boolean | undefined][] = [['squash', info.allow_squash_merge], ['merge', info.allow_merge_commit], ['rebase', info.allow_rebase_merge]];
  const admin = info.permissions?.admin === true;
  const mergeMethods = methods.some(([, on]) => on === undefined) ? null : methods.filter(([, on]) => on).map(([name]) => name);

  const branch = attempt((): BranchRules => {
    const rules = api<Rule[]>(`repos/${repo}/rules/branches/${encodeURIComponent(defaultBranch)}`) ?? [];
    const of = (type: string) => rules.filter((r) => r.type === type);
    const pr = of('pull_request').map((r) => r.parameters ?? {});
    // The old branch protection, which only an admin can read: a 404 to an admin means none, any other failure is unknown.
    const oldApprovals = (): number | null => { try { return api<{ required_approving_review_count?: number }>(`repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection/required_pull_request_reviews`)?.required_approving_review_count ?? 0; } catch (err) { return admin && /HTTP 404/.test(String((err as { stderr?: string }).stderr || (err as Error).message)) ? 0 : null; } };
    const ruled = Math.max(0, ...pr.map((p) => Number(p.required_approving_review_count) || 0));
    const old = oldApprovals();
    return {
      pullRequest: pr.length > 0,
      codeOwnerReview: pr.some((p) => p.require_code_owner_review === true),
      mergeMethods: [...new Set(pr.flatMap((p) => (Array.isArray(p.allowed_merge_methods) ? (p.allowed_merge_methods as string[]) : [])))],
      requiredChecks: of('required_status_checks').flatMap((r) => ((r.parameters?.required_status_checks ?? []) as { context?: string }[]).map((c) => c.context ?? '')).filter(Boolean),
      noForcePush: of('non_fast_forward').length > 0,
      noDeletion: of('deletion').length > 0,
      approvals: old === null ? (ruled >= 1 ? ruled : null) : Math.max(ruled, old),
    };
  });

  const tags = attempt(() => {
    const sets = api<Ruleset[]>(`repos/${repo}/rulesets?targets=tag&includes_parents=true&per_page=100`) ?? [];
    return sets
      .filter((s) => s.target === 'tag' && s.enforcement === 'active' && s.id !== undefined)
      .map((s) => api<Ruleset>(`repos/${repo}/rulesets/${s.id}`))
      .some((s) => {
        const include = s.conditions?.ref_name?.include ?? [];
        const types = new Set((s.rules ?? []).map((r) => r.type));
        return include.some((p) => ['~ALL', 'refs/tags/v*', 'v*'].includes(p)) && ['creation', 'update', 'deletion'].every((t) => types.has(t));
      });
  });

  // security_and_analysis is sent only to an admin; without it, a switch is unknown.
  const sa = info.security_and_analysis;
  const status = (key: string) => (sa?.[key]?.status ? sa[key]?.status === 'enabled' : null);
  const reporting = attempt(() => api<{ enabled?: boolean }>(`repos/${repo}/private-vulnerability-reporting`)?.enabled === true);
  // 204 when on, 404 when off; but 404 also means "not allowed to see", so only an admin learns "off".
  let alerts: boolean | null = null;
  try {
    gh(['api', `repos/${repo}/vulnerability-alerts`]);
    alerts = true;
  } catch (err) {
    if (sa && /HTTP 404/.test(String((err as { stderr?: string }).stderr || (err as Error).message))) alerts = false;
  }
  const security: Security = {
    secretScanning: status('secret_scanning'),
    pushProtection: status('secret_scanning_push_protection'),
    privateReporting: typeof reporting === 'boolean' ? reporting : null,
    dependabotAlerts: alerts,
  };

  const forgotten = attempt(() => {
    const open = new Set(lines(`repos/${repo}/pulls?state=open&per_page=100`, '.[].head.label'));
    const owner = repo.split('/')[0];
    return lines(`repos/${repo}/branches?per_page=100`, '.[].name').filter((b) => b !== defaultBranch && !open.has(`${owner}:${b}`));
  });

  // With this Actions setting on, a workflow the bot pushes could approve the bot's own pull request.
  const actions = attempt(() => api<{ can_approve_pull_request_reviews?: boolean }>(`repos/${repo}/actions/permissions/workflow`)?.can_approve_pull_request_reviews);
  const actionsCanApprove = typeof actions === 'boolean' ? actions : null;

  const planning = readPlanning(gh, repo);
  const boards = readLinkedBoards(gh, repo);

  const org = info.owner?.type === 'Organization' ? (info.owner.login ?? repo.split('/')[0]) : info.owner?.type === 'User' ? null : undefined;

  return { repo, defaultBranch, isPrivate: info.private ?? null, actionsCanApprove, mergeMethods, deleteBranchOnMerge: info.delete_branch_on_merge ?? null, branch, tags, security, forgotten, planning, boards, ...(org === undefined ? {} : { org }) };
}

// An incident issue for `yokoten learn` (#77), read through `gh issue view`, so it uses
// the owner's own sign-in and holds no token. A number names an issue of this repo; a URL
// names one in any repo. Read only.

const ISSUE_REFERENCE = /^(\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)$/;

/** The issue's number, title, body, URL and labels, or the reason gh can't read it. */
export function readIncident(gh: Gh, reference: string): Incident | string {
  if (!ISSUE_REFERENCE.test(reference)) return `${reference} is not an issue: give its number, or a URL like https://github.com/owner/repo/issues/12`;
  let text: string;
  try {
    text = gh(['issue', 'view', reference, '--json', 'number,title,body,url,labels']);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
    const reason = terminalText(String((err as { stderr?: string }).stderr || '').split('\n')[0].trim());
    return `gh can't read issue ${reference}${reason ? ` (${reason})` : ''}: run \`gh auth login\`, and check the number and the repo`;
  }
  const issue = JSON.parse(text) as { number?: unknown; title?: unknown; body?: unknown; url?: unknown; labels?: unknown };
  // The number names the draft's folder (lessons/incident-<n>), so only a whole number will do.
  const { number } = issue;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return `gh gave no issue number for ${reference}: it must be a whole number above 0`;
  // gh's JSON is checked, not cast: a null or odd title, body, url or label must not crash the draft.
  const { title, body, url, labels } = issue;
  if (typeof title !== 'string') return `gh gave no title for ${reference}`;
  return {
    number,
    title,
    body: typeof body === 'string' ? body : '',
    url: typeof url === 'string' ? url : '',
    labels: (Array.isArray(labels) ? labels : [])
      .map((label: unknown) => (label as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === 'string' && name !== ''),
  };
}

// The pull requests for `yokoten board` (#601), read through `gh pr list`, so it uses
// the owner's own sign-in and holds no token. Open, merged and closed, newest first.
// Read only.

/** The most pull requests the board reads: enough for one team's open and recent work. */
const BOARD_PULL_LIMIT = 30;

/** One pull request on the board: its number, title, branch, and each stage. */
export interface BoardPull {
  number: number;
  title: string;
  branch: string;
  url: string;
  /** Merged, closed, a draft, or open. */
  stage: 'merged' | 'closed' | 'draft' | 'open';
  /** The checks: pass, fail, still running, or none. A fail wins over running. */
  checks: 'pass' | 'fail' | 'running' | 'none';
  /** The tier from its labels (A, B or C), or '' when it has none. */
  tier: '' | 'A' | 'B' | 'C';
  /** The review: approved, changes asked, waiting for the owner, or none asked. */
  review: 'approved' | 'changes' | 'waiting' | 'none';
}

/** A check conclusion that keeps the pull request green. Any other conclusion on a completed run turns it red, so an unknown one never shows green. */
const PASSED_CHECK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'CANCELLED']);

/** The checks of one pull request, from gh's statusCheckRollup. Each check counts by its latest run, so a green rerun clears an old failure. A fail wins over running. */
function rollupState(rollup: unknown): BoardPull['checks'] {
  const entries = Array.isArray(rollup) ? rollup.filter(isObject) : [];
  if (!entries.length) return 'none';
  const latest = keepLatestRuns(entries);
  if (latest.some((entry) => entry.status === 'COMPLETED' && !(typeof entry.conclusion === 'string' && PASSED_CHECK.has(entry.conclusion)))) return 'fail';
  if (latest.some((entry) => typeof entry.status === 'string' && entry.status !== 'COMPLETED')) return 'running';
  return 'pass';
}

/** One run's time: completedAt, else startedAt, else NaN when neither parses. */
function readRunTime(entry: Record<string, unknown>): number {
  for (const key of ['completedAt', 'startedAt']) {
    const value = entry[key];
    if (typeof value !== 'string' || !value) continue;
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return time;
  }
  return NaN;
}

/**
 * One run per check name: the latest by run time. An entry with no name is its own
 * check, since nothing says it reruns another. A dateless run never beats a dated one;
 * ties keep file order.
 */
function keepLatestRuns(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byName = new Map<string, Record<string, unknown>>();
  const nameless: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (typeof name !== 'string' || !name) {
      nameless.push(entry);
      continue;
    }
    const seen = byName.get(name);
    if (seen === undefined) {
      byName.set(name, entry);
      continue;
    }
    const seenTime = readRunTime(seen);
    const entryTime = readRunTime(entry);
    if (Number.isNaN(entryTime)) continue;
    if (Number.isNaN(seenTime) || entryTime > seenTime) byName.set(name, entry);
  }
  return [...byName.values(), ...nameless];
}

/** The tier from the label names, by the same rule as CI, or '' when there is none. */
function pullTier(labels: string[]): BoardPull['tier'] {
  const tier = labels.map(readLabelTier).find((found) => found !== null);
  return tier === 'A' || tier === 'B' || tier === 'C' ? tier : '';
}

/** One row of `gh pr list --json` as a board pull, or null when it has no number. */
function parseBoardPull(row: unknown): BoardPull | null {
  if (!isObject(row) || typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number <= 0) return null;
  const review = asText(row.reviewDecision);
  return {
    number: row.number,
    title: asText(row.title),
    branch: asText(row.headRefName),
    url: asText(row.url),
    stage: asText(row.state) === 'MERGED' ? 'merged' : asText(row.state) === 'CLOSED' ? 'closed' : row.isDraft === true ? 'draft' : 'open',
    checks: rollupState(row.statusCheckRollup),
    tier: pullTier(labelNames(row.labels)),
    review: review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes' : review === 'REVIEW_REQUIRED' ? 'waiting' : 'none',
  };
}

/** The pull requests of `repo` ("owner/name"), or the reason gh can't read them. */
export function readBoardPulls(gh: Gh, repo: string): BoardPull[] | string {
  let text: string;
  try {
    text = gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(BOARD_PULL_LIMIT), '--json', 'number,title,headRefName,state,reviewDecision,isDraft,statusCheckRollup,labels,url']);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
    const reason = terminalText(String((err as { stderr?: string }).stderr || '').split('\n')[0].trim());
    return `gh can't list the pull requests${reason ? ` (${reason})` : ''}: run \`gh auth login\`, and check the repo`;
  }
  let pulls: unknown;
  try {
    pulls = JSON.parse(text);
  } catch {
    return 'gh gave no pull request list: run it again';
  }
  if (!Array.isArray(pulls)) return 'gh gave no pull request list: run it again';
  return pulls.map(parseBoardPull).filter((pull): pull is BoardPull => pull !== null);
}
