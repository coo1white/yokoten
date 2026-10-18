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
import { type Finding, formatFinding, place } from '../rules/message.ts';
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

interface Event {
  pull_request?: {
    title?: string;
    body?: string | null;
    labels?: { name?: string }[];
    milestone?: { title?: string } | null;
    base?: { sha?: string };
    head?: { sha?: string };
  };
}

/** The pull request of this run, or null when the run is not for one. */
export function readPullRequest(root: string, env: Env): (PullRequest & { base: string; head: string; numstat: string }) | null {
  if (!env.GITHUB_EVENT_PATH) return null;
  const event: Event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) return null;
  const base = pr.base?.sha ?? '';
  const head = pr.head?.sha ?? '';
  const files = base && head ? execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean) : [];
  const numstat = base && head ? execFileSync('git', ['diff', '--numstat', '-z', `${base}...${head}`], { cwd: root, encoding: 'utf8' }) : '';
  return {
    title: pr.title ?? '',
    body: pr.body ?? '',
    files,
    labels: (pr.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    milestone: pr.milestone?.title ?? null,
    base,
    head,
    numstat,
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

/** The issue of this run (its title and label names), or null when the run is not for one. */
export function readIssue(env: Env): { title: string; labels: string[] } | null {
  if (!env.GITHUB_EVENT_PATH) return null;
  const event: { issue?: { title?: string; labels?: { name?: string }[]; pull_request?: unknown } } = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const issue = event.issue;
  // A comment on a pull request carries it as an `issue` too; that title follows the pull request rule.
  if (!issue || issue.pull_request) return null;
  return { title: issue.title ?? '', labels: (issue.labels ?? []).map((l) => l.name ?? '').filter(Boolean) };
}

// The findings of a check on the pull request page (#91), so a beginner need not open the
// log. Two parts, and neither needs a token:
// - an annotation per finding: a line on stdout, `::error file=…,line=…,title=…::message`,
//   shown on that line of the diff (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands);
// - Markdown appended to the file named by GITHUB_STEP_SUMMARY, shown on the run's page.
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
  const message = formatFinding(file === undefined ? f : { id: f.id, what: f.what, why: f.why, fix: f.fix });
  return `::${level} ${properties.join(',')}::${escapeData(message)}`;
}

/** The annotations for one check: problems first, then notes, at most 50. */
export function annotations(problems: Finding[], notes: Finding[], isPlaceAFile = true): string[] {
  const all = [...problems.map((f) => annotation(f, 'error', isPlaceAFile)), ...notes.map((f) => annotation(f, 'warning', isPlaceAFile))];
  return all.slice(0, MAX_ANNOTATIONS);
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const cell = (text: string) => text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;');
const row = (f: Finding) => `| ${cell(place(f).replace(/: $/, ''))} | ${cell(f.what)} | ${cell(capitalize(f.why))} | ${cell(capitalize(f.fix))} |`;
const TABLE_HEAD = ['| Place | What | Why | Fix |', '|-------|------|-----|-----|'];

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

// The planning setup (#10): labels and milestones, read and made through `gh`, so
// yokoten uses the owner's own sign-in and holds no token. `Gh` runs one gh command and
// returns its stdout; it throws when gh fails. Tests pass a fake, so they never reach GitHub.

export type Gh = (args: string[]) => string;

/** Runs the real gh in `cwd`. */
export const ghIn =
  (cwd: string): Gh =>
  (args) =>
    execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export interface Planning {
  /** "owner/name". */
  repo: string;
  labels: string[];
  milestones: { title: string; open: boolean }[];
}

/** The repo's labels and milestones, or the reason gh can't read them. */
export function readPlanning(gh: Gh): Planning | string {
  let repo: string;
  try {
    repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
    return 'gh can\'t read this repo: run `gh auth login`, and check that the origin remote is on GitHub';
  }
  const lines = (text: string) => text.split('\n').filter(Boolean);
  const labels = lines(gh(['label', 'list', '--limit', '1000', '--json', 'name', '--jq', '.[].name']));
  const milestones = lines(gh(['api', '--paginate', `repos/${repo}/milestones?state=all&per_page=100`, '--jq', '.[] | "\\(.state) \\(.title)"'])).map((l) => {
    const [state, ...title] = l.split(' ');
    return { title: title.join(' '), open: state === 'open' };
  });
  return { repo, labels, milestones };
}

export function createLabel(gh: Gh, label: { name: string; color: string; description: string }): void {
  gh(['label', 'create', label.name, '--color', label.color, '--description', label.description]);
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

  return { repo, defaultBranch, mergeMethods, deleteBranchOnMerge: info.delete_branch_on_merge ?? null, branch, tags, security, forgotten };
}
