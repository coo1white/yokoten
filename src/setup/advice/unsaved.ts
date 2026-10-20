// Work that is only on this machine (#365): uncommitted changes, commits not pushed,
// stashes, worktrees that are done or gone, a lock a crash left, a repo on a tmpfs. A
// power cut, a crash or a dead disk loses all of it, and nothing else tells the user.
//
// Two parts, so the snapshot (#366) and resume (#367) can reuse the first:
// `readUnsaved` reads the facts from git and the file system, and `unsavedNotes` turns
// them into notes. Both only read: no file, ref or worktree changes, and git runs with
// optional locks off, so `git status` does not even refresh the index.
//
// Cost: a fixed handful of git calls for the repo, and one `git status` per worktree.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type Finding, finding } from '../../rules/message.ts';

/** One worktree of the clone, as git lists it, with what is only in its folder. */
export interface WorktreeFacts {
  /** Absolute, as git prints it. */
  path: string;
  /** The branch's short name, or null when HEAD is detached (or the repo is bare). */
  branch: string | null;
  head: string | null;
  /** The first worktree git lists: the clone itself. */
  isMain: boolean;
  /** git still lists it, but its folder is gone (`git worktree prune` forgets it). */
  isMissing: boolean;
  isLocked: boolean;
  /** Changed, staged and untracked paths, relative to the worktree. Null when git can't read it. */
  changedFiles: string[] | null;
  /** When the oldest of those paths last changed, in ms since 1970. Null when none can be read. */
  oldestChange: number | null;
  /**
   * When its folder may not survive a restart: on a tmpfs (gone after a restart), or under
   * a temp folder (the system may empty it). `folder` is the mount point or the temp folder.
   */
  volatile: { kind: 'tmpfs' | 'temp'; folder: string } | null;
  /** Its own git folder: the common one for the clone, `worktrees/<name>` in it for a linked worktree. Null when git lost track. */
  gitDir: string | null;
  /** Its `index.lock`, when there is one. */
  indexLock: { path: string; modified: number } | null;
  /** On a detached HEAD: whether no branch, tag or remote holds that commit. Null when HEAD is on a branch, or git can't tell. */
  isHeadUnreferenced: boolean | null;
  /** On a detached HEAD: whether the default branch holds that commit. Null when HEAD is on a branch, or git can't tell. */
  isHeadInDefault: boolean | null;
  /** For a detached HEAD in the default branch: whether HEAD moved after the worktree was made (its reflog). Null when not read. */
  hasHeadMoved: boolean | null;
}

/** One local branch and where it stands against its upstream and the default branch. */
export interface BranchFacts {
  name: string;
  head: string;
  /** The upstream's short name (`origin/x`), or null when the branch has none. */
  upstream: string | null;
  /** The upstream's remote and branch, for the push command. */
  remote: string | null;
  remoteBranch: string | null;
  /** Commits not on the upstream. Null without an upstream, or when it is gone. */
  ahead: number | null;
  /** The branch has an upstream, but the remote branch is gone: most likely merged and deleted. */
  isGone: boolean;
  /** Commits not on the default branch. Null when there is no default branch, or git is too old to count. */
  aheadOfDefault: number | null;
  /**
   * Whether the branch moved after it was made (its reflog has more than one entry). Read
   * only for a branch with nothing off the default branch: it tells a merged branch from
   * one just made. Null when not read, or there is no reflog file.
   */
  hasMoved: boolean | null;
}

/** Everything `unsavedNotes` needs, read once. */
export interface UnsavedFacts {
  /** The worktree doctor runs in. */
  root: string;
  /** The git folder all worktrees share. */
  commonDir: string;
  /** The default branch, as a ref (`refs/remotes/origin/main`), and its tip. Null when there is none. */
  defaultRef: string | null;
  defaultTip: string | null;
  remotes: string[];
  worktrees: WorktreeFacts[];
  branches: BranchFacts[];
  stashes: number;
  /** True when the read stopped at its time budget: the facts are only what was read by then. */
  isPartial: boolean;
  /** Whether git works in this repo now: read only when a lock is found. Null when not read, or doctor can't tell. */
  isGitRunning: boolean | null;
}

/** How long a read may take, and the clock it is measured by (a test hands in its own). */
export interface TimeBudget {
  ms: number;
  clock?: () => number;
}

/** How readUnsaved reads the machine. A test hands in its own. */
export interface MachineReaders {
  /** The temp folders, which the system may empty on restart. By default YOKOTEN_TEMP_DIRS, else the system's temp folder and /tmp. */
  tempDirs?: string[];
  /** The text of /proc/mounts, or null where there is none (macOS, Windows). */
  readMounts?: () => string | null;
  /** The git processes running now, or null when they can't be read. */
  listProcesses?: () => GitProcess[] | null;
}

/** Where to look for the default branch, first found wins. Local refs only: doctor never fetches. */
const DEFAULT_REFS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];

/** File systems that live in memory: a restart empties them. */
const MEMORY_FILE_SYSTEMS = ['tmpfs', 'ramfs'];

/** The git environment: no GIT_DIR or index from a hook that called doctor, and no optional locks. */
function gitEnv(env: Env): Env {
  const clean: Env = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete clean[key];
  return clean;
}

/** Runs git in `cwd` and returns its output, or null when it fails or the time is up. */
type GitRunner = ((cwd: string, args: string[]) => string | null) & { isStopped: () => boolean };

/**
 * A git runner. With a time budget, each call gets the time left as its timeout, and no
 * call starts once the time is up: a session must not wait on a cold disk.
 */
function makeGitRunner(env: Env, budget: TimeBudget | undefined): GitRunner {
  const clock = budget?.clock ?? Date.now;
  const start = clock();
  let isStopped = false;
  const run = (cwd: string, args: string[]): string | null => {
    const left = budget ? budget.ms - (clock() - start) : Infinity;
    if (isStopped || left <= 0) {
      isStopped = true;
      return null;
    }
    try {
      return execFileSync('git', ['--no-optional-locks', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, ...(budget ? { timeout: Math.ceil(left) } : {}) });
    } catch (error) {
      // A call killed by its timeout: the time is up.
      if (budget && (error as { signal?: string | null }).signal) isStopped = true;
      return null;
    }
  };
  return Object.assign(run, { isStopped: () => isStopped });
}

/** The worktrees from `git worktree list --porcelain -z`: one record per worktree, attributes split by NUL. */
export function parseWorktreeList(text: string): Pick<WorktreeFacts, 'path' | 'branch' | 'head' | 'isMain' | 'isMissing' | 'isLocked'>[] {
  return text
    .split('\0\0')
    .filter((record) => record.startsWith('worktree '))
    .map((record, index) => {
      const fields = record.split('\0');
      const value = (key: string) => fields.find((f) => f === key || f.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
      const branch = value('branch');
      return {
        path: value('worktree') ?? '',
        branch: branch ? branch.replace(/^refs\/heads\//, '') : null,
        head: value('HEAD'),
        isMain: index === 0,
        isMissing: fields.some((f) => f === 'prunable' || f.startsWith('prunable ')),
        isLocked: fields.some((f) => f === 'locked' || f.startsWith('locked ')),
      };
    });
}

/**
 * The paths in `git status --porcelain=v2 -z`. Ordinary (1), renamed (2, its old path in
 * the next field), unmerged (u) and untracked (?) entries; ignored files (!) are left out.
 */
export function parseStatus(text: string): string[] {
  const paths: string[] = [];
  const fields = text.split('\0');
  // The path follows a fixed count of space-separated fields, by entry kind.
  const before: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 };
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    const count = before[entry[0]];
    if (count === undefined) continue;
    paths.push(entry.split(' ').slice(count).join(' '));
    if (entry[0] === '2') i++; // the old path of a rename
  }
  return paths;
}

/** When the oldest of these paths changed, from their files; a deleted file has no time and is skipped. */
function findOldestChange(dir: string, paths: string[]): number | null {
  let oldest: number | null = null;
  for (const path of paths) {
    try {
      const modified = statSync(join(dir, path)).mtimeMs;
      if (oldest === null || modified < oldest) oldest = modified;
    } catch {
      // deleted, or gone since git looked
    }
  }
  return oldest;
}

/** The mount point of a tmpfs that holds `dir`, from /proc/mounts; null on any other file system. */
export function findTmpfs(dir: string, mounts: string | null): string | null {
  if (!mounts) return null;
  // /proc/mounts writes a space in a path as \040.
  const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
  let best: { point: string; type: string } | null = null;
  for (const line of mounts.split('\n')) {
    const [, rawPoint, type] = line.split(' ');
    if (!rawPoint || !type) continue;
    const point = unescape(rawPoint);
    // /proc/mounts lists real paths; a memory file system's point is also read through links
    // (never a disk's: a dead network mount would hang the read).
    const under = (folder: string) => folder === '/' || dir === folder || dir.startsWith(`${folder}/`);
    const isUnder = under(point) || (MEMORY_FILE_SYSTEMS.includes(type) && under(realPathOf(point)));
    if (isUnder && (!best || point.length >= best.point.length)) best = { point, type };
  }
  return best && MEMORY_FILE_SYSTEMS.includes(best.type) ? best.point : null;
}

/** Reads /proc/mounts on Linux. Elsewhere there is none, and the tmpfs case says nothing. */
function readProcMounts(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return readFileSync('/proc/mounts', 'utf8');
  } catch {
    return null;
  }
}

/** A git process that runs now, and its working folder when the system says (Linux); null when it doesn't. */
export interface GitProcess {
  cwd: string | null;
}

/** git's helpers that run for hours and never hold an index.lock. */
const isDaemon = (args: string) => /--daemon\b/.test(args);

/**
 * The git processes running now, daemons left out: /proc on Linux (with each one's
 * working folder), `ps` on other Unix systems, `tasklist` on Windows. Null when they
 * can't be read.
 */
function listGitProcesses(): GitProcess[] | null {
  try {
    if (process.platform === 'linux') {
      const found: GitProcess[] = [];
      for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
        try {
          if (!isGitProcess(readFileSync(`/proc/${pid}/comm`, 'utf8').trim())) continue;
          if (isDaemon(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '))) continue;
        } catch {
          continue; // ended while we looked
        }
        let cwd: string | null = null;
        try {
          cwd = readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          // another user's process: its folder is hidden
        }
        found.push({ cwd });
      }
      return found;
    }
    if (process.platform === 'win32') {
      const text = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return text.split(/\r?\n/).filter((line) => isGitProcess(line.split('","')[0].replace(/^"/, ''))).map(() => ({ cwd: null }));
    }
    const text = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return text
      .split('\n')
      .filter((line) => isGitProcess(line.trim().split(' ')[0].split('/').pop() ?? '') && !isDaemon(line))
      .map(() => ({ cwd: null }));
  } catch {
    return null;
  }
}

/** Whether a process name is git or one of its helpers (git-remote-https, git.exe). */
export const isGitProcess = (name: string): boolean => /^git(\.exe|-[\w-]+(\.exe)?)?$/i.test(name);

/**
 * Whether git works in this repo now: true when a git process runs in one of its folders,
 * false when none can, null when a git process runs and its folder is unknown.
 */
export function isGitWorkingIn(folders: string[], processes: GitProcess[] | null): boolean | null {
  if (processes === null) return null;
  const isInside = (cwd: string) => folders.some((folder) => cwd === folder || cwd.startsWith(`${folder}${sep}`));
  if (processes.some((p) => p.cwd !== null && isInside(p.cwd))) return true;
  return processes.some((p) => p.cwd === null) ? null : false;
}

/** Each worktree's own git folder: the clone's is the common one, a linked worktree's is under `worktrees/<name>/`. */
function readGitDirs(commonDir: string): Map<string, string> {
  const dirs = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(join(commonDir, 'worktrees'));
  } catch {
    return dirs; // no linked worktrees
  }
  for (const name of names) {
    const gitDir = join(commonDir, 'worktrees', name);
    try {
      // `gitdir` holds the path of the worktree's .git file.
      dirs.set(dirname(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim()), gitDir);
    } catch {
      // a broken entry; `git worktree prune` deals with it
    }
  }
  return dirs;
}

/** The index.lock in a git folder, when there is one. */
function findIndexLock(gitDir: string): { path: string; modified: number } | null {
  const path = join(gitDir, 'index.lock');
  try {
    return { path, modified: statSync(path).mtimeMs };
  } catch {
    return null; // no lock: the usual case
  }
}

/** Whether a reflog file has more than one entry: the ref moved after it was made. Null when there is no file (it expired, or a reftable repo). */
function readHasMoved(reflog: string): boolean | null {
  try {
    return readFileSync(reflog, 'utf8').trim().split('\n').filter(Boolean).length > 1;
  } catch {
    return null;
  }
}

/** The commits that `heads` reach and `exclude` don't, in one `git rev-list`. Null when git fails. */
function listCommitsOutside(root: string, heads: string[], exclude: string[], git: GitRunner): Set<string> | null {
  const text = git(root, ['rev-list', ...heads, '--not', ...exclude]);
  return text === null ? null : new Set(text.split('\n').filter(Boolean));
}

/** The local branches and their upstreams, from one `git for-each-ref`; also which default ref is there, and whether a stash is. */
function readRefs(root: string, git: GitRunner): { branches: BranchFacts[]; tips: Map<string, string>; targets: Map<string, string>; hasStash: boolean } | null {
  const format = ['%(refname)', '%(symref)', '%(objectname)', '%(upstream)', '%(upstream:track,nobracket)', '%(upstream:remotename)', '%(upstream:remoteref)'].join('%00');
  const text = git(root, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/stash', ...DEFAULT_REFS.filter((ref) => ref.startsWith('refs/remotes/'))]);
  if (text === null) return null;
  const branches: BranchFacts[] = [];
  const tips = new Map<string, string>();
  const targets = new Map<string, string>();
  let hasStash = false;
  for (const line of text.split('\n')) {
    const [ref, target, head, upstream, track, remote, remoteRef] = line.split('\0');
    if (!ref) continue;
    tips.set(ref, head);
    if (target) targets.set(ref, target);
    if (ref === 'refs/stash') hasStash = true;
    if (!ref.startsWith('refs/heads/')) continue;
    const isGone = track === 'gone';
    const ahead = upstream && !isGone ? Number(/ahead (\d+)/.exec(track)?.[1] ?? 0) : null;
    branches.push({
      name: ref.slice('refs/heads/'.length),
      head,
      upstream: upstream ? upstream.replace(/^refs\/remotes\//, '') : null,
      remote: remote || null,
      remoteBranch: remoteRef ? remoteRef.replace(/^refs\/heads\//, '') : null,
      ahead,
      isGone,
      aheadOfDefault: null,
      hasMoved: null,
    });
  }
  return { branches, tips, targets, hasStash };
}

/**
 * How many commits each branch has that the default branch does not, in one call:
 * `%(ahead-behind:)` needs git 2.41; older git gives merged (0) or not known (null).
 */
function readAheadOfDefault(root: string, tip: string, git: GitRunner): Map<string, number | null> {
  const counts = new Map<string, number | null>();
  const text = git(root, ['for-each-ref', `--format=%(refname:short)%00%(ahead-behind:${tip})`, 'refs/heads']);
  if (text !== null) {
    for (const line of text.split('\n')) {
      const [name, numbers] = line.split('\0');
      if (name) counts.set(name, Number(numbers.split(' ')[0]));
    }
    return counts;
  }
  if (git.isStopped()) return counts;
  const merged = git(root, ['for-each-ref', '--format=%(refname:short)', `--merged=${tip}`, 'refs/heads']);
  for (const name of merged?.split('\n') ?? []) if (name) counts.set(name, 0);
  return counts;
}

/** The temp folders from YOKOTEN_TEMP_DIRS (empty turns the check off), else the system's own and /tmp. */
export function findTempDirs(env: Env, platform: string = process.platform): string[] {
  if (env.YOKOTEN_TEMP_DIRS !== undefined) return env.YOKOTEN_TEMP_DIRS.split(delimiter).filter(Boolean);
  return [...new Set([tmpdir(), ...(platform === 'win32' ? [] : ['/tmp'])])];
}

/**
 * A path with its links resolved, as git prints it. On macOS the temp folder is under /var,
 * a link to /private/var, and git prints /private/var: compare and relativize only real
 * paths. A path that is gone (a missing worktree) keeps its name under its nearest real parent.
 */
export function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPathOf(parent), basename(path));
  }
}

/** Whether `path` is `folder` or inside it. */
const isInside = (path: string, folder: string) => {
  const inside = relative(folder, path);
  return !inside.startsWith('..') && !isAbsolute(inside);
};

/**
 * The facts about work only on this machine, for the clone that holds `root`. Read only.
 * Null when git can't read the repo. With `budget`, it stops when the time is up and
 * returns what it read, with `isPartial`: the costly reads, one per worktree, come last.
 */
export function readUnsaved(root: string, { env, budget, readMounts = readProcMounts, listProcesses = listGitProcesses, tempDirs = findTempDirs(env) }: { env: Env; budget?: TimeBudget } & MachineReaders): UnsavedFacts | null {
  const git = makeGitRunner(gitEnv(env), budget);
  const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  const list = commonDir ? git(root, ['worktree', 'list', '--porcelain', '-z']) : null;
  const refs = list !== null ? readRefs(root, git) : null;
  if (!commonDir || list === null || !refs) {
    if (!git.isStopped()) return null;
    // Out of time before the basics: say so, with nothing else.
    return { root, commonDir: commonDir ?? '', defaultRef: null, defaultTip: null, remotes: [], worktrees: [], branches: [], stashes: 0, isPartial: true, isGitRunning: null };
  }
  const remotes = git(root, ['remote'])?.split('\n').filter(Boolean) ?? [];
  const stashes = refs.hasStash ? (git(root, ['stash', 'list', '--format=%H'])?.split('\n').filter(Boolean).length ?? 0) : 0;
  const found = DEFAULT_REFS.find((ref) => refs.tips.has(ref));
  // origin/HEAD names the branch it points at: say origin/main, not origin/HEAD.
  const defaultRef = found ? (refs.targets.get(found) ?? found) : null;
  const defaultTip = found ? (refs.tips.get(found) ?? null) : null;
  if (defaultTip) {
    const counts = readAheadOfDefault(root, defaultTip, git);
    for (const branch of refs.branches) {
      branch.aheadOfDefault = counts.get(branch.name) ?? null;
      if (branch.aheadOfDefault === 0) branch.hasMoved = readHasMoved(join(commonDir, 'logs', 'refs', 'heads', branch.name));
    }
  }
  const gitDirs = readGitDirs(commonDir);
  const listed = parseWorktreeList(list);
  // Detached HEADs: two calls for all of them, never one per worktree.
  const detached = listed.filter((worktree) => !worktree.branch && worktree.head && !/^0+$/.test(worktree.head)).map((worktree) => worktree.head as string);
  const onNoRef = detached.length ? listCommitsOutside(root, detached, ['--branches', '--tags', '--remotes'], git) : null;
  const offDefault = detached.length && defaultTip ? listCommitsOutside(root, detached, [defaultTip], git) : null;
  const mounts = readMounts();
  const temps = tempDirs.map(realPathOf);
  const worktrees = listed.map((worktree): WorktreeFacts => {
    const gitDir = worktree.isMain ? commonDir : (gitDirs.get(worktree.path) ?? null);
    const isMissing = worktree.isMissing || !existsSync(worktree.path);
    const isDetached = !worktree.branch && worktree.head !== null && detached.includes(worktree.head);
    const isHeadInDefault = isDetached && offDefault ? !offDefault.has(worktree.head as string) : null;
    // A bare clone lists itself with no branch and no HEAD: there is no folder to read.
    const status = isMissing || worktree.head === null ? null : git(worktree.path, ['status', '--porcelain=v2', '-z', '--untracked-files=normal']);
    const changedFiles = status === null ? null : parseStatus(status);
    const real = realPathOf(worktree.path);
    const tmpfs = isMissing ? null : findTmpfs(real, mounts);
    // The temp folder as it was handed in: the user knows it by that name.
    const temp = isMissing ? undefined : tempDirs.find((_, index) => isInside(real, temps[index]));
    return {
      ...worktree,
      gitDir,
      isMissing,
      changedFiles,
      oldestChange: changedFiles ? findOldestChange(worktree.path, changedFiles) : null,
      indexLock: gitDir ? findIndexLock(gitDir) : null,
      isHeadUnreferenced: isDetached && onNoRef ? onNoRef.has(worktree.head as string) : null,
      isHeadInDefault,
      hasHeadMoved: isHeadInDefault && gitDir ? readHasMoved(join(gitDir, 'logs', 'HEAD')) : null,
      volatile: tmpfs ? { kind: 'tmpfs', folder: tmpfs } : temp ? { kind: 'temp', folder: temp } : null,
    };
  });
  const hasLock = worktrees.some((worktree) => worktree.indexLock);
  const folders = [commonDir, ...worktrees.map((worktree) => worktree.path)].flatMap((folder) => [folder, realPathOf(folder)]);
  return {
    root,
    commonDir,
    defaultRef,
    defaultTip,
    remotes,
    worktrees,
    branches: refs.branches,
    stashes,
    isPartial: git.isStopped(),
    isGitRunning: hasLock ? isGitWorkingIn(folders, listProcesses()?.map((p) => ({ cwd: p.cwd === null ? null : realPathOf(p.cwd) })) ?? null) : null,
  };
}

/**
 * A path as the user reads it: relative inside the root, from ~ inside the home, relative
 * when it is near (`../x`, `../../x`), else as it is. Never the full home path.
 */
export function showPath(given: string, givenRoot: string, givenHome: string | undefined): string {
  const slashes = (text: string) => text.split(sep).join('/');
  // git prints real paths; the root and home may be reached through a link (macOS /var).
  const [path, root, home] = [realPathOf(given), realPathOf(givenRoot), givenHome && realPathOf(givenHome)];
  const inside = relative(root, path);
  if (inside === '') return '.';
  if (!inside.startsWith('..') && !isAbsolute(inside)) return slashes(inside);
  if (home) {
    const fromHome = relative(home, path);
    if (fromHome === '') return '~';
    if (!fromHome.startsWith('..') && !isAbsolute(fromHome)) return `~/${slashes(fromHome)}`;
  }
  return inside.split(sep).filter((part) => part === '..').length <= 2 ? slashes(inside) : path;
}

/** An age in plain words: "5 minutes", "3 hours", "2 days". */
export function showAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [count, unit] = minutes < 120 ? [minutes, 'minute'] : minutes < 48 * 60 ? [Math.round(minutes / 60), 'hour'] : [Math.round(minutes / 1440), 'day'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** At session start, uncommitted changes count only once the oldest is this old: work going on now is not forgotten. */
export const SESSION_CHANGE_AGE = 60 * 60_000;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A command in backticks. */
const code = (text: string) => `\`${text}\``;

/** A folder from ~ when it is in the home, else as it is: a mount point or temp folder is above the repo. */
function showFolder(folder: string, home: string | undefined): string {
  if (!home || !isInside(folder, home)) return folder;
  const fromHome = relative(home, folder);
  return fromHome ? `~/${fromHome.split(sep).join('/')}` : '~';
}

/** Where a folder that may not survive a restart is, in words: "under the temp folder (/tmp), which …". */
function describePlace(volatile: { kind: 'tmpfs' | 'temp'; folder: string }, home: string | undefined): string {
  const folder = showFolder(volatile.folder, home);
  return volatile.kind === 'tmpfs' ? `on a tmpfs (${folder}), which is gone after a restart` : `under the temp folder (${folder}), which the system may empty on restart`;
}

const VOLATILE_IDS = { tmpfs: 'repo-on-tmpfs', temp: 'repo-in-temp-folder' } as const;

/** The branches whose commits are only on this machine: the same test the branch notes use. */
function isBranchAtRisk(branch: BranchFacts, facts: UnsavedFacts): boolean {
  if (!facts.remotes.length) return true;
  return !!branch.ahead || (!branch.upstream && branch.aheadOfDefault !== 0 && branch.head !== facts.defaultTip);
}

/** Whether a worktree holds work only on this machine: changed files, branch commits no remote has, or a detached HEAD no branch holds. */
function isWorktreeAtRisk(worktree: WorktreeFacts, facts: UnsavedFacts): boolean {
  if (worktree.changedFiles?.length || worktree.isHeadUnreferenced) return true;
  const branch = worktree.branch ? facts.branches.find((known) => known.name === worktree.branch) : undefined;
  return !!branch && isBranchAtRisk(branch, facts);
}

/**
 * The notes, one per thing to save, each with the one command that saves it. A session
 * gets only what is at risk: no worktree to tidy, and no change from the last hour.
 *
 * A worktree on a tmpfs or under a temp folder is named only when it holds work at risk,
 * in that work's own note. The rest get one line in full doctor, and none in a session.
 * The clone itself there always gets a note: that is how the repo is set up.
 */
export function unsavedNotes(facts: UnsavedFacts, { home, now = Date.now(), platform = process.platform as string, session = false }: { home: string | undefined; now?: number; platform?: string; session?: boolean }): Finding[] {
  const notes: Finding[] = [];
  const show = (path: string) => showPath(path, facts.root, home);
  const defaultName = facts.defaultRef?.replace(/^refs\/(heads|remotes)\//, '') ?? 'the default branch';
  const remote = facts.remotes.includes('origin') ? 'origin' : (facts.remotes[0] ?? 'origin');
  const present = facts.worktrees.filter((worktree) => !worktree.isMissing);
  const volatileAtRisk = present.filter((worktree) => worktree.volatile && isWorktreeAtRisk(worktree, facts));
  // The worktrees whose place is already said in one of their notes.
  const told = new Set<string>();
  /** The place of an at-risk worktree, the first time one of its notes asks; then nothing. */
  const placeOf = (worktree: WorktreeFacts | undefined): string | null => {
    if (!worktree?.volatile || !volatileAtRisk.includes(worktree) || told.has(worktree.path)) return null;
    told.add(worktree.path);
    return describePlace(worktree.volatile, home);
  };
  if (session) {
    // One line per kind when two or more at-risk worktrees are there: the scale, before the details.
    for (const kind of ['tmpfs', 'temp'] as const) {
      const trees = volatileAtRisk.filter((worktree) => worktree.volatile?.kind === kind);
      if (trees.length < 2) continue;
      const folder = showFolder((trees[0].volatile as { folder: string }).folder, home);
      const where = kind === 'tmpfs' ? `on a tmpfs (${folder})` : `under the temp folder (${folder})`;
      notes.push(finding(VOLATILE_IDS[kind], `${trees.length} worktrees ${where} hold unsaved work, and a restart may empty that folder`, 'save them first: `yokoten doctor` lists the command for each'));
    }
  }
  for (const worktree of present) {
    const files = worktree.changedFiles;
    if (!files?.length) continue;
    const age = worktree.oldestChange === null ? null : now - worktree.oldestChange;
    if (session && (age === null || age < SESSION_CHANGE_AGE)) continue;
    const where = show(worktree.path);
    const since = age === null ? '' : `, the oldest changed ${showAge(age)} ago`;
    const place = placeOf(worktree);
    notes.push(finding('uncommitted-changes', `${where} has ${plural(files.length, 'uncommitted file')}${since}${place ? `, and is ${place}` : ''}`, `commit them: ${code(`git -C ${where} add -A && git -C ${where} commit`)}, then push`));
  }
  // A branch exists once there is a commit. A read that stopped early may not have read the remotes.
  if (!facts.remotes.length && facts.branches.length && !facts.isPartial) {
    notes.push(finding('unpushed-commits', 'this repo has no remote, so every commit is still only on this machine', `add one and push: ${code('git remote add origin <url>')}, then ${code('git push -u origin --all')}`));
  } else {
    for (const branch of facts.branches) {
      if (!isBranchAtRisk(branch, facts)) continue;
      const worktree = present.find((tree) => tree.branch === branch.name);
      const place = placeOf(worktree);
      const also = place && worktree ? `; ${worktree.isMain ? 'the repo' : `its worktree ${show(worktree.path)}`} is ${place}` : '';
      // A branch made from origin/main tracks it: its commits go to a branch of its own, never to main.
      if (branch.ahead && branch.remoteBranch === branch.name) {
        notes.push(finding('unpushed-commits', `branch ${branch.name} has ${plural(branch.ahead, 'commit')} not pushed to ${branch.upstream}; a commit not pushed is still only on this machine${also}`, code(`git push ${branch.remote ?? remote} ${branch.name}`)));
      } else if (branch.ahead) {
        notes.push(finding('unpushed-commits', `branch ${branch.name} has ${plural(branch.ahead, 'commit')} not on ${branch.upstream}, and no branch of its own on the remote, so they are still only on this machine${also}`, code(`git push -u ${branch.remote ?? remote} ${branch.name}`)));
      } else {
        const count = branch.aheadOfDefault ? `${plural(branch.aheadOfDefault, 'commit')} not on ${defaultName}` : `commits not on ${defaultName}`;
        notes.push(finding('unpushed-commits', `branch ${branch.name} has ${count} and no upstream, so they are still only on this machine${also}`, code(`git push -u ${remote} ${branch.name}`)));
      }
    }
  }
  for (const worktree of present) {
    if (!worktree.isHeadUnreferenced) continue;
    const where = show(worktree.path);
    const place = placeOf(worktree);
    notes.push(finding('unpushed-commits', `worktree ${where} has commits on a detached HEAD that no branch holds, so they are still only on this machine${place ? `; it is ${place}` : ''}`, `give them a branch and push it: ${code(`git -C ${where} switch -c <name>`)}, then ${code(`git -C ${where} push -u ${remote} <name>`)}`));
  }
  // The clone itself always: a repo set up there loses everything on restart.
  const main = present.find((worktree) => worktree.isMain);
  if (main?.volatile && !told.has(main.path)) {
    told.add(main.path);
    const push = facts.remotes.length ? `push every branch now: ${code(`git push --all ${remote}`)}` : 'add a remote and push every branch now';
    const place = main.volatile.kind === 'tmpfs' ? `on a tmpfs (${showFolder(main.volatile.folder, home)}), so everything here is gone after a restart` : describePlace(main.volatile, home);
    notes.push(finding(VOLATILE_IDS[main.volatile.kind], `this repo is ${place}`, `${push}; then clone it again in a folder that lasts`));
  }
  if (!session) {
    // At-risk worktrees whose note a session hid (or no remote folded): say the place on its own.
    for (const worktree of volatileAtRisk.filter((tree) => !told.has(tree.path))) {
      told.add(worktree.path);
      notes.push(finding(VOLATILE_IDS[(worktree.volatile as { kind: 'tmpfs' | 'temp' }).kind], `${show(worktree.path)} holds work only on this machine, and is ${describePlace(worktree.volatile as { kind: 'tmpfs' | 'temp'; folder: string }, home)}`, 'save it: commit and push, then make it again in a folder that lasts'));
    }
    // The rest hold nothing at risk: one line per kind, for the next worktree made there.
    for (const kind of ['tmpfs', 'temp'] as const) {
      const clean = present.filter((worktree) => !worktree.isMain && worktree.volatile?.kind === kind && !told.has(worktree.path));
      if (!clean.length) continue;
      const folders = [...new Set(clean.map((worktree) => showFolder((worktree.volatile as { folder: string }).folder, home)))].join(', ');
      const where = kind === 'tmpfs' ? `on a tmpfs (${folders})` : `under the temp folder (${folders})`;
      const count = clean.length === 1 ? `1 worktree is ${where}; it holds no unsaved work` : `${clean.length} worktrees are ${where}; none holds unsaved work`;
      notes.push(finding(VOLATILE_IDS[kind], `${count}, but new work there may be lost on restart`, 'make new worktrees in a folder that lasts'));
    }
  }
  if (facts.stashes) {
    notes.push(finding('stashes', `there ${facts.stashes === 1 ? 'is 1 stash' : `are ${facts.stashes} stashes`}, and a stash is only on this machine`, `turn each into a branch and push it: ${code('git stash branch <name>')}, then ${code(`git push -u ${remote} <name>`)}`));
  }
  for (const worktree of facts.worktrees) {
    if (!worktree.indexLock || worktree.isMissing) continue;
    const lock = show(worktree.indexLock.path);
    if (facts.isGitRunning === false) {
      notes.push(finding('stale-index-lock', `${lock} is left from a crash: no git process is running`, `delete it: ${code(`${platform === 'win32' ? 'del' : 'rm'} ${lock}`)}`));
    } else if (facts.isGitRunning === null) {
      notes.push(finding('stale-index-lock', `${lock} is there, and doctor can't tell whether a git process is using it`, 'wait for git to finish; if the file stays, check for a running git process first', { why: 'git changes nothing in this worktree while the file is there' }));
    }
  }
  if (session) return notes;
  const branches = new Map(facts.branches.map((branch) => [branch.name, branch]));
  for (const worktree of facts.worktrees) {
    if (worktree.isMain || worktree.isMissing || worktree.isLocked || realPathOf(worktree.path) === realPathOf(facts.root) || worktree.changedFiles?.length !== 0) continue;
    if (!worktree.branch) {
      // A detached HEAD in the default branch's history, moved since the worktree was made.
      if (worktree.isHeadInDefault && worktree.hasHeadMoved) notes.push(finding('finished-worktree', `worktree ${show(worktree.path)} (detached HEAD) is in ${defaultName}'s history`, `remove it: ${code(`git worktree remove ${show(worktree.path)}`)}`));
      continue;
    }
    const branch = branches.get(worktree.branch);
    if (!branch) continue;
    // A branch just made from an older main looks merged too; only one that moved since was worked on.
    const isMerged = branch.aheadOfDefault === 0 && branch.hasMoved === true;
    if (!isMerged && !branch.isGone) continue;
    const where = show(worktree.path);
    const why = isMerged ? `is merged into ${defaultName}` : `has lost its upstream ${branch.upstream}, so it was most likely merged`;
    notes.push(finding('finished-worktree', `worktree ${where} (branch ${branch.name}) ${why}`, `remove it: ${code(`git worktree remove ${where}`)}; the branch stays`));
  }
  const missing = facts.worktrees.filter((worktree) => worktree.isMissing && !worktree.isLocked);
  if (missing.length) {
    notes.push(finding('missing-worktree', `git still lists ${plural(missing.length, 'worktree')} whose folder is gone: ${missing.map((worktree) => show(worktree.path)).join(', ')}`, code('git worktree prune')));
  }
  return notes;
}

const CONTROL_TREE: WorktreeFacts = { path: '/r', branch: 'b', head: '1', isMain: false, isMissing: false, isLocked: false, changedFiles: [], oldestChange: null, gitDir: null, indexLock: null, isHeadUnreferenced: null, isHeadInDefault: null, hasHeadMoved: null, volatile: null };
const CONTROL_BRANCH: BranchFacts = { name: 'b', head: '1', upstream: 'origin/b', remote: 'origin', remoteBranch: 'b', ahead: null, isGone: true, aheadOfDefault: 1, hasMoved: null };

/**
 * A clone with one of each kind of work only on this machine, as facts: doctor's self-test
 * and the message tests feed it to `unsavedNotes`, and expect a note of every kind.
 */
export const UNSAVED_CONTROL: UnsavedFacts = {
  root: '/r',
  commonDir: '/r/.git',
  defaultRef: 'refs/remotes/origin/main',
  defaultTip: '0',
  remotes: ['origin'],
  stashes: 1,
  isPartial: false,
  isGitRunning: false,
  worktrees: [
    { ...CONTROL_TREE, isMain: true, branch: 'main', changedFiles: ['a'], oldestChange: 0, gitDir: '/r/.git', indexLock: { path: '/r/.git/index.lock', modified: 0 } },
    { ...CONTROL_TREE, path: '/w', volatile: { kind: 'temp', folder: '/' } },
    { ...CONTROL_TREE, path: '/t', volatile: { kind: 'tmpfs', folder: '/' } },
    { ...CONTROL_TREE, path: '/x', isMissing: true },
    { ...CONTROL_TREE, path: '/d', branch: null, head: '2', isHeadUnreferenced: true, isHeadInDefault: false },
  ],
  branches: [CONTROL_BRANCH, { ...CONTROL_BRANCH, name: 'main', upstream: 'origin/main', remoteBranch: 'main', ahead: 1, isGone: false }],
};
