// The gh command, the repo address, and the planning setup: labels, milestones and
// boards. Everything here reads or changes GitHub through `gh`, so yokoten uses the
// owner's own sign-in and holds no token.

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeOf } from '../../rules/privacy.ts';

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The label names; a label that is not an object with a name is skipped. */
export const labelNames = (labels: unknown): string[] => (Array.isArray(labels) ? labels.map((l) => (isObject(l) ? asText(l.name) : '')).filter(Boolean) : []);

/** "owner/name" from a GitHub remote URL (https or ssh), or null. */
export function repoOf(remote: string): string | null {
  return remote.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

/** The web page of `owner/name`. */
export function repoPageOf(repo: string): string {
  return `https://github.com/${repo}`;
}

export type Gh = (args: string[]) => string;

/** Runs the real gh in `cwd`, with `env`. With `timeout` (ms), a call that takes longer is stopped and throws. */
export const ghIn =
  (cwd: string, env: Env, timeout?: number): Gh =>
  (args) =>
    execFileSync('gh', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });

/**
 * gh that may answer later, so a server keeps answering while GitHub is slow (#688). A
 * Gh that answers at once fits too. `signal` stops a call nobody waits for any more.
 */
export type GhLater = (args: string[], signal?: AbortSignal) => string | Promise<string>;

/**
 * Runs the real gh in `cwd`, with `env`, without blocking. With `timeout` (ms), a call
 * that takes longer is stopped. A failed call rejects with gh's code and stderr, as
 * ghIn throws them.
 */
export const ghLaterIn =
  (cwd: string, env: Env, timeout?: number): GhLater =>
  (args, signal) =>
    new Promise((done, failed) => {
      const child = execFile('gh', args, { cwd, env, encoding: 'utf8', timeout, signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) failed(Object.assign(err, { stderr }));
        else done(stdout);
      });
      child.stdin?.end();
    });

/** Why a part could not be read, and what to do. */
export interface Unread {
  unread: string;
  fix: string;
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
