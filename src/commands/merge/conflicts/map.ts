// The conflict map (#909): every open change, the files it moves, the ones that collide
// with main and with each other, the moved paths a lease covers, and the hot paths. The
// guard reads the map this module writes and never builds one (record 0013): building runs
// git for every open change.
//
// A change is a pull request on the host, or a local branch when there is no host. The map
// never fetches. A pull request whose branch is not in this clone is left out, and one note
// says how many. That keeps GitHub, Gitea and a clone with no host on one path: the host
// names the changes, git says what they change.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { giteaGet, type GiteaGet, giteaTokenOf } from '../../../host/gitea.ts';
import { asText, type Gh, ghIn, isObject, OPEN_PULL_LIMIT, readOpenPulls } from '../../../host/github/index.ts';
import { hostOf } from '../../../host/hosts.ts';
import { type Env, loadConfig } from '../../../rules/config.ts';
import { gitConfig, readGit, runGit } from '../../../run/check.ts';
import { type Change, type Collision, type ConflictMap, MAP_FILE, MAP_MAX_AGE_MS } from './types.ts';

/** One open change the host named. The clone still has to say what it changes. */
export interface ListedChange {
  /** `pr:12`, or `branch:feature-x` when this clone's own branches are read. */
  id: string;
  /** What a person reads: `PR #12`. */
  label: string;
  /** The local branch of that name, or the branch itself. */
  branch: string;
  /** A draft on the host. GitHub's list gives no draft flag, so a GitHub draft says false here. */
  draft: boolean;
}

/** The changes to map: what a host listed, or null for this clone's branches. */
export interface OpenChanges {
  listed: ListedChange[] | null;
  /** Plain-words lines about what could not be read. */
  notes: string[];
}

/** Host reads a test gives, so it needs no gh and no network. */
export interface HostReads {
  /** gh, which lists the open pull requests on GitHub. */
  gh?: Gh;
  /** One Gitea API read, by path from its API root. */
  gitea?: GiteaGet;
}

/** How much waiting on a host is worth before the map falls back to this clone's branches. */
const HOST_TIMEOUT_MS = 10_000;

/** The most pairs that share a file that one map tries: a pair costs one merge-tree. */
export const PAIR_LIMIT = 200;

/** The page of open pull requests one Gitea read asks for. */
const GITEA_PAGE = 50;

/** The files git prints after a conflicted path list: messages, never paths. */
const MERGE_TREE_MESSAGE = /^(?:Auto-merging|CONFLICT|CONFLICTING|warning:)/;

/** One git read: what it printed and its exit status, or null when git gave no answer. */
export type GitRead = (args: string[]) => { out: string; status: number } | null;

/** A git read that answers with bytes, and treats exit 0 and 1 (a conflict) as answers. */
const gitReadIn =
  (root: string, env: Env): GitRead =>
  (args) => {
    try {
      const { stdout, status } = runGit(root, args, { env, okCodes: [0, 1], maxBuffer: 64 << 20 });
      return { out: stdout.toString('utf8'), status };
    } catch {
      return null;
    }
  };

/** The one way to build a map, and what to change. A test gives its own git, so it can count calls. */
export interface MapOptions {
  /** What a host listed, or null for this clone's branches. */
  listed: ListedChange[] | null;
  /** Git reads, for a test. */
  git?: GitRead;
  /** The time the map records, for a test. */
  now?: () => Date;
}

/** A map, and the plain-words notes that go with it. */
export interface MapBuild {
  map: ConflictMap;
  notes: string[];
}

/** `main` as this clone has it: the name a person knows, the revision git reads, and its commit. */
export interface MainRef {
  name: string;
  rev: string;
  commit: string;
}

const trimmed = (read: { out: string } | null): string => (read === null ? '' : read.out.trim());

/** A full commit id, or null when there is no such revision. */
function commitOf(git: GitRead, rev: string): string | null {
  const out = trimmed(git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]));
  return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
}

/**
 * The branch this clone compares against: local `main` first, then `origin/main`, then the
 * branch `origin/HEAD` names. Null when this clone has no main at all, which no map can do.
 */
export function mainRef(root: string, env: Env, git: GitRead = gitReadIn(root, env)): MainRef | null {
  for (const rev of ['refs/heads/main', 'refs/remotes/origin/main']) {
    const commit = commitOf(git, rev);
    if (commit) return { name: 'main', rev, commit };
  }
  const head = trimmed(git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']));
  const prefix = 'refs/remotes/origin/';
  if (!head.startsWith(prefix)) return null;
  const commit = commitOf(git, head);
  return commit === null ? null : { name: head.slice(prefix.length), rev: head, commit };
}

const uniqueSorted = (paths: string[]): string[] => [...new Set(paths)].sort();

/**
 * The files one branch changes against main, from `git diff --name-status -M`. A rename
 * lists both paths and moves the old one. A delete of a file on main counts as a move too:
 * a split deletes the old file and adds new ones, and git calls that no rename.
 */
export function changedPaths(git: GitRead, main: string, head: string): { files: string[]; moves: string[] } | null {
  const answer = git(['diff', '--name-status', '-M', '-z', `${main}...${head}`]);
  if (answer === null || answer.status !== 0) return null;
  const words = answer.out.split('\0');
  const files: string[] = [];
  const moves: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const status = words[i] ?? '';
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const from = words[++i] ?? '';
      const to = words[++i] ?? '';
      if (to) files.push(to);
      // A copy leaves the old path alone, so only a rename moves it.
      if (kind === 'R' && from) {
        files.push(from);
        moves.push(from);
      }
      continue;
    }
    const path = words[++i] ?? '';
    if (!path) continue;
    files.push(path);
    if (kind === 'D') moves.push(path);
  }
  return { files: uniqueSorted(files), moves: uniqueSorted(moves) };
}

/**
 * The paths `merge-tree` could not merge, from its output: the tree id, then one path a
 * line, then a blank line and git's messages. Empty when the two merge cleanly.
 */
export function conflictedPaths(output: string): string[] {
  const lines = output.split('\n');
  if (!/^[0-9a-f]{40,64}$/.test(trimmed({ out: lines[0] ?? '' }))) return [];
  const paths: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line || MERGE_TREE_MESSAGE.test(line)) break;
    paths.push(line);
  }
  return paths;
}

/** The conflicts of two heads, or null when git could not tell. Nothing is checked out. */
export function mergeTree(git: GitRead, a: string, b: string): string[] | null {
  if (!a || !b) return null;
  const answer = git(['merge-tree', '--write-tree', '--name-only', a, b]);
  if (answer === null || (answer.status !== 0 && answer.status !== 1)) return null;
  return conflictedPaths(answer.out);
}

/**
 * The pairs worth a merge-tree: the two changes share a file. A pair that shares none can
 * never conflict, so it is never merged, which is what keeps a map of 29 changes quick.
 */
export function pairsToTry(changes: Change[]): [Change, Change][] {
  const pairs: [Change, Change][] = [];
  for (let i = 0; i < changes.length; i++) {
    const a = changes[i] as Change;
    const files = new Set(a.files);
    for (let j = i + 1; j < changes.length; j++) {
      const b = changes[j] as Change;
      if (b.files.some((path) => files.has(path))) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** The top folder of a path: `changes/909-x.md` gives `changes`, and `README.md` gives ''. */
const folderOf = (path: string): string => {
  const end = path.indexOf('/');
  return end < 0 ? '' : path.slice(0, end);
};

/**
 * A folder where every change adds its own new file: `changes/` and translations. No change
 * touches more than one path there, and no two changes touch the same path. Different files
 * in such a folder are not a sign of a collision.
 */
function isLooseFolder(changes: Change[], folder: string, touched: Map<string, Set<string>>): boolean {
  if (folder === '') return false;
  for (const change of changes) {
    const there = change.files.filter((path) => folderOf(path) === folder);
    if (there.length > 1) return false;
    if (there.some((path) => (touched.get(path)?.size ?? 0) > 1)) return false;
  }
  return true;
}

/**
 * The paths worth a look before a merge: a path an open change moves or deletes, or one
 * that three or more changes touch. A path in a one-file-per-change folder never gets
 * here by a count, since no two changes touch the same file in it.
 */
export function hotPaths(changes: Change[]): string[] {
  const touched = new Map<string, Set<string>>();
  const moved = new Set<string>();
  for (const change of changes) {
    for (const path of change.files) {
      const ids = touched.get(path) ?? new Set<string>();
      ids.add(change.id);
      touched.set(path, ids);
    }
    for (const path of change.moves) moved.add(path);
  }
  const hot = new Set<string>(moved);
  for (const [path, ids] of touched) {
    if (ids.size < 3 || isLooseFolder(changes, folderOf(path), touched)) continue;
    hot.add(path);
  }
  return [...hot].sort();
}

/** The paths an open change moves, and the change that moves each; a draft leases nothing. */
export function leases(changes: Change[]): Record<string, string> {
  const leased: Record<string, string> = {};
  for (const change of changes) {
    if (change.draft) continue;
    for (const path of change.moves) leased[path] ??= change.id;
  }
  return Object.fromEntries(Object.entries(leased).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Pull requests first, by number, then branches by name: the same map for the same work. */
function byChangeOrder(a: Change, b: Change): number {
  const numberOf = (change: Change): number | null => {
    const found = /^pr:(\d+)$/.exec(change.id)?.[1];
    return found === undefined ? null : Number(found);
  };
  const left = numberOf(a);
  const right = numberOf(b);
  if (left !== null && right !== null) return left - right;
  if (left !== null) return -1;
  if (right !== null) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether `a` comes before `b` in the map's order. */
export const beforeChange = (a: Change, b: Change): boolean => byChangeOrder(a, b) < 0;

/** This clone's branches, main left out: what a repo with no host calls its open changes. */
export function localChanges(main: MainRef, git: GitRead): ListedChange[] {
  const out = trimmed(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && name !== main.name)
    .map((name) => ({ id: `branch:${name}`, label: `branch ${name}`, branch: name, draft: false }));
}

const one = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Build the map. `main` and every change are read with merge-tree, in this clone, with no
 * checkout and no merge. A pair is tried only when it shares a file. A plain string is the
 * reason a map can't be built at all.
 */
export function buildMap(root: string, env: Env, options: MapOptions): MapBuild | string {
  const git = options.git ?? gitReadIn(root, env);
  const main = mainRef(root, env, git);
  if (main === null) return 'this clone has no main branch, so there is nothing to compare the open changes with';

  const notes: string[] = [];
  const wanted = options.listed ?? localChanges(main, git);
  const commits = new Map<string, string>();
  const changes: Change[] = [];
  let skipped = 0;
  let unknown = 0;
  let unknownPairs = 0;
  for (const listed of wanted) {
    const commit = commitOf(git, `refs/heads/${listed.branch}`);
    const paths = commit === null ? null : changedPaths(git, main.commit, commit);
    if (commit === null || paths === null) {
      skipped++;
      continue;
    }
    // A branch with nothing to merge is neither open work nor a collision.
    if (!paths.files.length) continue;
    const mainConflicts = mergeTree(git, main.commit, commit);
    if (mainConflicts === null) unknown++;
    commits.set(listed.id, commit);
    changes.push({
      id: listed.id,
      label: listed.label,
      branch: listed.branch,
      head: commit.slice(0, 8),
      draft: listed.draft,
      files: paths.files,
      moves: paths.moves,
      mainConflicts,
    });
  }
  changes.sort(byChangeOrder);

  const pairs = pairsToTry(changes);
  const collisions: Collision[] = [];
  for (const [a, b] of pairs.slice(0, PAIR_LIMIT)) {
    const files = mergeTree(git, commits.get(a.id) ?? '', commits.get(b.id) ?? '');
    if (files === null) {
      unknownPairs++;
      continue;
    }
    if (files.length) collisions.push({ first: a.id, second: b.id, files });
  }

  if (skipped) notes.push(`${one(skipped, 'open change')} ${skipped === 1 ? 'is' : 'are'} not in this clone, so the map leaves ${skipped === 1 ? 'it' : 'them'} out`);
  if (unknown) notes.push(`git could not tell whether ${one(unknown, 'change')} conflict${unknown === 1 ? 's' : ''} with main`);
  if (unknownPairs) notes.push(`git could not tell whether ${one(unknownPairs, 'pair')} of changes conflict`);
  if (pairs.length > PAIR_LIMIT) notes.push(`${one(pairs.length, 'pair')} of changes share a file, and the map tried the first ${PAIR_LIMIT}`);

  const map: ConflictMap = {
    version: 1,
    builtAt: (options.now?.() ?? new Date()).toISOString(),
    main: main.commit.slice(0, 8),
    changes,
    collisions,
    leased: leases(changes),
    hot: hotPaths(changes),
  };
  return { map, notes };
}

/**
 * The open changes: the host's pull requests when it can name them, else this clone's
 * branches. A host that can't be read is a note, never a failure: a map of the branches
 * this clone has still says what collides.
 */
export async function openChanges(root: string, env: Env, reads: HostReads = {}): Promise<OpenChanges> {
  const host = hostOf(gitConfig(root, 'remote.origin.url', env), loadConfig(root).host);
  const local = "so this map reads this clone's branches";
  if (host.kind === 'github') {
    const list = readOpenPulls(reads.gh ?? ghIn(root, env, HOST_TIMEOUT_MS), host.repo);
    if (typeof list === 'string') return { listed: null, notes: [`${list}, ${local}`] };
    const listed = list.pulls.map((pull) => ({ id: `pr:${pull.number}`, label: `PR #${pull.number}`, branch: pull.branch, draft: pull.isDraft }));
    return { listed, notes: list.isCut ? [`only the first ${OPEN_PULL_LIMIT} open pull requests were read`] : [] };
  }
  if (host.kind === 'gitea') {
    const token = giteaTokenOf(env);
    if (reads.gitea === undefined && !token) return { listed: null, notes: [`no Gitea token is set (GITEA_TOKEN), ${local}`] };
    try {
      const answer = await (reads.gitea ?? giteaGet(host.api, token))(`/repos/${host.repo}/pulls?state=open&limit=${GITEA_PAGE}`);
      if (answer.status !== 200 || !Array.isArray(answer.body)) {
        return { listed: null, notes: [`the host answered ${answer.status} for its open pull requests, ${local}`] };
      }
      const listed: ListedChange[] = [];
      for (const row of answer.body) {
        if (!isObject(row)) continue;
        const number = row.number;
        const branch = asText(isObject(row.head) ? row.head.ref : '');
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || !branch) continue;
        listed.push({ id: `pr:${number}`, label: `PR #${number}`, branch, draft: row.draft === true });
      }
      return { listed, notes: listed.length >= GITEA_PAGE ? [`only the first ${GITEA_PAGE} open pull requests were read`] : [] };
    } catch {
      // A read that throws names no server and no token: the note stays plain (core rule 11).
      return { listed: null, notes: [`this host could not be read, ${local}`] };
    }
  }
  // A host with no adapter (a name yokoten does not know) reads this clone's branches, and one
  // note says why the list is short. A folder on this machine (no name) is not a host: no note.
  const isUnknownHost = host.kind === 'other' && host.name !== '';
  return { listed: null, notes: isUnknownHost ? [`this host has no adapter, ${local}`] : [] };
}

/** The file the map lives in: MAP_FILE inside this clone's git folder, or null when there is none. */
export function mapPath(root: string, env: Env): string | null {
  try {
    const common = readGit(root, ['rev-parse', '--git-common-dir'], { env }).toString('utf8').trim();
    return common ? resolve(root, common, MAP_FILE) : null;
  } catch {
    return null;
  }
}

/** Write the map where the guard reads it. Null when it was written, else why it was not. */
export function writeMap(root: string, env: Env, map: ConflictMap): string | null {
  const file = mapPath(root, env);
  if (file === null) return 'this clone has no git folder, so the map was not kept';
  try {
    mkdirSync(dirname(file), { recursive: true });
    // A reader never sees half a map: the new one replaces the old one in one step.
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(map, null, 2)}\n`);
    renameSync(temp, file);
    return null;
  } catch {
    return 'the map was not kept: this clone\'s git folder could not be written';
  }
}

/** What a reader of the map found. */
export type MapState =
  /** No map, or one a newer yokoten wrote: build one. */
  | { kind: 'missing' }
  /** A map, but older than MAP_MAX_AGE_MS: the guard allows, and the doctor says so. */
  | { kind: 'stale'; map: ConflictMap }
  | { kind: 'ready'; map: ConflictMap };

const isTextArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Read a change from a cache a person could have edited: every field checked, never trusted. */
function isChange(value: unknown): value is Change {
  if (!isObject(value)) return false;
  const mainConflicts = value.mainConflicts;
  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.head === 'string' &&
    typeof value.draft === 'boolean' &&
    isTextArray(value.files) &&
    isTextArray(value.moves) &&
    (mainConflicts === null || isTextArray(mainConflicts))
  );
}

function isCollision(value: unknown): value is Collision {
  return isObject(value) && typeof value.first === 'string' && typeof value.second === 'string' && isTextArray(value.files);
}

/** Whether a parsed file is a map this version reads: its version, its time, and its shapes. */
export function isMap(value: unknown): value is ConflictMap {
  if (!isObject(value) || value.version !== 1) return false;
  if (typeof value.builtAt !== 'string' || Number.isNaN(Date.parse(value.builtAt))) return false;
  if (typeof value.main !== 'string' || !Array.isArray(value.changes) || !Array.isArray(value.collisions) || !isTextArray(value.hot)) return false;
  if (!isObject(value.leased)) return false;
  return (
    value.changes.every(isChange) &&
    value.collisions.every(isCollision) &&
    Object.values(value.leased).every((id) => typeof id === 'string')
  );
}

/**
 * What the cache holds. A map from a version this yokoten does not know, a broken file, or
 * a time in the future reads as missing: a guard never acts on a map it can't trust.
 */
export function readMapState(root: string, env: Env, now: number = Date.now()): MapState {
  const file = mapPath(root, env);
  if (file === null || !existsSync(file)) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { kind: 'missing' };
  }
  if (!isMap(parsed)) return { kind: 'missing' };
  const built = Date.parse(parsed.builtAt);
  // A map from the future follows a clock that moved back, so its age means nothing.
  if (built > now + 60_000) return { kind: 'missing' };
  return now - built > MAP_MAX_AGE_MS ? { kind: 'stale', map: parsed } : { kind: 'ready', map: parsed };
}

/** The map, when it is one this yokoten knows and it is not stale; otherwise null. */
export function readMap(root: string, env: Env, now: number = Date.now()): ConflictMap | null {
  const state = readMapState(root, env, now);
  return state.kind === 'ready' ? state.map : null;
}

/** The branch name of a change, for a message about one the map holds. */
export const branchOf = (map: ConflictMap, id: string): string | undefined => map.changes.find((change) => change.id === id)?.branch;
