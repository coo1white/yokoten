// The GitHub adapter. Everything yokoten knows about GitHub's API lives in src/host/
// (record 0004); a rule or a step names what it needs in host-neutral words. Two parts:
// the bot, and the pull request of a CI run.
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
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { type Finding, finding, formatFinding, place } from '../rules/message.ts';
import type { CodeOwners, PullRequest } from '../rules/pr.ts';

export interface BotConfig {
  appId: string;
  /** Path to the App's private key (.pem). */
  keyFile: string;
  /** The installation id; found from the repo when not set. */
  installation?: string;
  api: string;
}

/** The bot's settings from the environment, or the reason they are not usable. */
export function botConfig(env: Env): BotConfig | string {
  const appId = env.YOKOTEN_BOT_APP_ID;
  if (!appId) return 'YOKOTEN_BOT_APP_ID is not set: the App ID from the App\'s settings page (docs/server.md, step 3)';
  return {
    appId,
    keyFile: env.YOKOTEN_BOT_KEY || join(env.HOME || homedir(), '.config', 'yokoten', 'bot.pem'),
    installation: env.YOKOTEN_BOT_INSTALLATION || undefined,
    api: (env.YOKOTEN_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
  };
}

/** A bot is set up on this machine: its App ID is set and its key file is there. Reads no network. */
export function hasBot(env: Env): boolean {
  const config = botConfig(env);
  return typeof config !== 'string' && existsSync(config.keyFile);
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

/** The title a `gh issue` or `gh pr` command is about to set, and its labels. */
export interface CommandTitle {
  kind: 'issue' | 'pr';
  title: string;
  labels: string[];
}

// The gh options of `issue`/`pr` `create`/`edit` that take a value. Their value is
// skipped, so a body of `-t` is not read as the title option.
const VALUE_OPTIONS = new Set([
  '--body', '-b', '--body-file', '-F', '--assignee', '-a', '--milestone', '-m', '--project', '-p', '--repo', '-R', '--template', '-T',
  '--base', '-B', '--head', '-H', '--reviewer', '-r', '--recover', '--remove-label', '--add-assignee', '--remove-assignee',
  '--add-project', '--remove-project', '--add-reviewer', '--remove-reviewer',
]);
const LABEL_OPTIONS = new Set(['--label', '-l', '--add-label']);

/**
 * The title that `gh issue create`, `gh issue edit`, `gh pr create` or `gh pr edit` sets
 * with `--title X`, `--title=X`, `-t X` or `-tX` (#117). Null for any other command, or
 * when no title is given (`--fill`): CI checks that title. As in gh, the last one wins.
 */
export function readCommandTitle(command: string[]): CommandTitle | null {
  const [file, kind, verb, ...rest] = command;
  if (!file || file.split(/[\\/]/).pop() !== 'gh') return null;
  if ((kind !== 'issue' && kind !== 'pr') || (verb !== 'create' && verb !== 'edit')) return null;
  let title: string | null = null;
  const labels: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index];
    if (word === '--') break;
    const equals = word.startsWith('--') ? word.indexOf('=') : -1;
    const name = equals > 0 ? word.slice(0, equals) : /^-[a-zA-Z]./.test(word) ? word.slice(0, 2) : word;
    const attached = equals > 0 ? word.slice(equals + 1) : name !== word ? word.slice(2) : null;
    const isTitle = name === '--title' || name === '-t';
    if (!isTitle && !LABEL_OPTIONS.has(name) && !VALUE_OPTIONS.has(name)) continue;
    const value = attached ?? rest[++index];
    if (value === undefined) break;
    if (isTitle) title = value;
    else if (LABEL_OPTIONS.has(name)) labels.push(...value.split(',').map((label) => label.trim()).filter(Boolean));
  }
  return title === null ? null : { kind, title, labels };
}

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

/** The environment for one command run as the bot: gh reads GH_TOKEN, and git asks gh. */
export function botEnv(env: Env, token: string): Env {
  // Added after any git config already passed this way. The empty value clears other
  // credential helpers for github.com, so git cannot fall back to the owner's login.
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const key = 'credential.https://github.com.helper';
  return {
    ...env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: key,
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: key,
    [`GIT_CONFIG_VALUE_${n + 1}`]: '!gh auth git-credential',
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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The label names; a label that is not an object with a name is skipped. */
const labelNames = (labels: unknown): string[] => (Array.isArray(labels) ? labels.map((l) => (isObject(l) ? asText(l.name) : '')).filter(Boolean) : []);

const EVENT_FIX = 'run it in a GitHub Actions job on a `pull_request` or `issues` event, or set GITHUB_EVENT_PATH to a readable event file';

/** The event of this run as an object, null when there is none, or why it can't be read. */
function readEvent(env: Env): Record<string, unknown> | Unreadable | null {
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

const isUnreadable = (value: unknown): value is Unreadable => isObject(value) && 'problem' in value;

/** The commit is in this checkout. A value that is not a commit id counts as missing. */
function hasCommit(root: string, sha: string): boolean {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The two commits have a common commit here, so `base...head` can be read. */
function hasMergeBase(root: string, base: string, head: string): boolean {
  try {
    execFileSync('git', ['merge-base', base, head], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const COMMITS_FIX = 'use `fetch-depth: 0` in actions/checkout, so the checkout has the whole history';
const SHA_FIX = 'run it in a GitHub Actions job on a `pull_request` event, whose base.sha and head.sha are the commits to compare';

/** Which of the event's base and head commit ids are empty, missing or not text, as one finding, or null. */
function shasProblem(base: string, head: string): Finding | null {
  const missing = [['base', base], ['head', head]].filter(([, sha]) => !sha).map(([name]) => name);
  if (missing.length === 2) return finding('pr-commits', 'the pull request\'s base and head commits are missing from the event', SHA_FIX);
  if (missing.length === 1) return finding('pr-commits', `the pull request's ${missing[0]} commit is missing from the event`, SHA_FIX);
  return null;
}

/** Why `base...head` can't be read in this checkout, or null when it can. */
function commitsProblem(root: string, base: string, head: string): Finding | null {
  const missing = [['base', base], ['head', head]].filter(([, sha]) => !hasCommit(root, sha)).map(([name]) => name);
  if (missing.length === 2) return finding('pr-commits', 'the pull request\'s base and head commits are not in this checkout', COMMITS_FIX);
  if (missing.length === 1) return finding('pr-commits', `the pull request's ${missing[0]} commit is not in this checkout`, COMMITS_FIX);
  if (!hasMergeBase(root, base, head)) return finding('pr-commits', 'the pull request\'s base and head commits have no common commit in this checkout', COMMITS_FIX);
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
  const problem = shasProblem(base, head) ?? commitsProblem(root, base, head);
  if (problem) return { problem };
  const diff = (...options: string[]) => execFileSync('git', ['diff', ...options, `${base}...${head}`], { cwd: root, encoding: 'utf8' });
  return {
    title: asText(pr.title),
    body: asText(pr.body),
    files: diff('--name-only', '-z').split('\0').filter(Boolean),
    deleted: diff('--name-only', '--diff-filter=D', '-z').split('\0').filter(Boolean),
    labels: labelNames(pr.labels),
    milestone: isObject(pr.milestone) && typeof pr.milestone.title === 'string' ? pr.milestone.title : null,
    base,
    head,
    numstat: diff('--numstat', '-z'),
  };
}

// GitHub reads CODEOWNERS from the first of these places, on the pull request's base
// branch. yokoten reads it from the same commit, so a pull request can't edit the file
// to lower its own tier. Without a base commit (a local run), it reads the working tree.
const CODEOWNERS_PLACES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** The CODEOWNERS file at the base commit, or in the working tree when `base` is empty; null when there is none. */
export function readCodeOwners(root: string, base: string): CodeOwners | null {
  for (const place of CODEOWNERS_PLACES) {
    if (base) {
      try {
        const text = execFileSync('git', ['show', `${base}:${place}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return { text, from: 'the base branch' };
      } catch {
        continue; // not at this place in the base commit
      }
    }
    const file = join(root, place);
    if (existsSync(file)) return { text: readFileSync(file, 'utf8'), from: 'the working tree' };
  }
  return null;
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

/** Runs the real gh in `cwd`. */
export const ghIn =
  (cwd: string): Gh =>
  (args) =>
    execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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
}

/** Why gh failed, in words a beginner can act on. */
export function unread(err: unknown): Unread {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { unread: 'gh is not installed', fix: 'get it from https://cli.github.com, then run `gh auth login`' };
  const said = String((err as { stderr?: string }).stderr || (err as Error).message);
  if (/HTTP 401|gh auth login|not logged in/i.test(said)) return { unread: 'gh is not signed in', fix: 'run `gh auth login`' };
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
    allow_squash_merge?: boolean;
    allow_merge_commit?: boolean;
    allow_rebase_merge?: boolean;
    delete_branch_on_merge?: boolean;
    security_and_analysis?: Record<string, { status?: string } | undefined>;
  };
  const info = attempt(() => api<Repo>(`repos/${repo}`));
  if ('unread' in info) return info;
  const defaultBranch = info.default_branch ?? 'main';
  // GitHub sends the merge settings only to an admin.
  const methods: [string, boolean | undefined][] = [['squash', info.allow_squash_merge], ['merge', info.allow_merge_commit], ['rebase', info.allow_rebase_merge]];
  const mergeMethods = methods.some(([, on]) => on === undefined) ? null : methods.filter(([, on]) => on).map(([name]) => name);

  const branch = attempt((): BranchRules => {
    const rules = api<Rule[]>(`repos/${repo}/rules/branches/${encodeURIComponent(defaultBranch)}`) ?? [];
    const of = (type: string) => rules.filter((r) => r.type === type);
    const pr = of('pull_request').map((r) => r.parameters ?? {});
    return {
      pullRequest: pr.length > 0,
      codeOwnerReview: pr.some((p) => p.require_code_owner_review === true),
      mergeMethods: [...new Set(pr.flatMap((p) => (Array.isArray(p.allowed_merge_methods) ? (p.allowed_merge_methods as string[]) : [])))],
      requiredChecks: of('required_status_checks').flatMap((r) => ((r.parameters?.required_status_checks ?? []) as { context?: string }[]).map((c) => c.context ?? '')).filter(Boolean),
      noForcePush: of('non_fast_forward').length > 0,
      noDeletion: of('deletion').length > 0,
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

  const planning = readPlanning(gh, repo);

  return { repo, defaultBranch, mergeMethods, deleteBranchOnMerge: info.delete_branch_on_merge ?? null, branch, tags, security, forgotten, planning };
}
