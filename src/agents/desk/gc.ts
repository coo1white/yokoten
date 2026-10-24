// Sweep finished desks, keep what is not saved (#708).
//
// A desk is a clone or a worktree an agent worked in. It is finished when nothing in it
// can be lost: its commits are on the remote, its tip is on the default branch, no agent
// works there, and it has no change of its own. Then it goes, with its state folder and its
// line on the board's desk list. The main checkout and every desk a root holds stay.
//
// Roots: an open pull request's branch, commits on no remote branch, a change, an untracked
// file or an ignored file (but `node_modules` and the status file), an agent alive or its
// log changed in the last 24 hours, a process in a worktree, and the main checkout.
//
// Safe by default: a desk the marker can't decide on is listed, never removed. That is a
// fetch that failed, a branch on no remote, a default branch it can't read, and a folder
// that is not a git checkout. The sweep runs on its own, so a bug here must cost a list
// line, never a commit.
//
// A dry run reads only: it fetches nothing, so no remote-tracking ref changes.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { realPath } from '../../rules/guards.ts';
import { hideHome } from '../../rules/privacy.ts';
import { AGENT_STATUS_FILE, commonGitDir, DESK_LIST_FILE } from '../../run/hook.ts';

/** How long after its log changed an agent still counts as there. */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The file a running desk leaves in its git folder: the agent's process id. */
export const DESK_PID_FILE = 'yokoten-desk-pid';
/** How long one git call may take, in ms. A remote that hangs keeps the desk, and that is fine. */
const GIT_TIMEOUT_MS = 20000;
/**
 * How long the macOS process read may take, in ms. `lsof` lists every process, and a busy
 * machine can be slow. A short wait counts as "no process", which removes a live desk.
 */
const PROCESS_READ_TIMEOUT_MS = 20000;
/** The most state entries one desk reads before its state counts as active: a log is never this many. */
const STATE_ENTRY_LIMIT = 5000;

/** What the sweep does with one desk: remove it, keep it because a root holds it, or only list it. */
export type DeskDecision = 'remove' | 'keep' | 'list';

/** One desk and the marker's word on it. `reason` is plain words for the line it prints. */
export interface GcEntry {
  path: string;
  isMain: boolean;
  decision: DeskDecision;
  reason: string;
}

/** What a sweep needs from the caller, so a test can stand in for the clock, the processes and GitHub. */
export interface GcOptions {
  env: Env;
  /** The checkout the session runs in: always kept, even when it is not the main one. */
  keep?: string;
  /** Branches of open pull requests, `[]` when none can exist, or null when they can't be read. */
  openPullBranches?: string[] | null;
  now?: Date;
  isProcessAlive?: (pid: number) => boolean;
  /** Read only: change nothing, not even a remote-tracking ref. */
  isDryRun?: boolean;
}

/** What a sweep found and did. `removed` holds the paths that are gone. */
export interface GcResult {
  entries: GcEntry[];
  removed: string[];
  /** Desks that should have gone but could not: removal failed, so they stay. */
  failed: Array<{ path: string; reason: string }>;
  isDryRun: boolean;
}

/** git in `folder`, trimmed text. Throws when git fails; callers turn that into "can't decide". */
function gitAt(folder: string, args: string[], env: Env): string {
  // A sweep never asks for a password: no terminal is there to answer.
  const quiet = { ...env, GIT_TERMINAL_PROMPT: '0' };
  return execFileSync('git', args, { cwd: folder, env: quiet, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).trim();
}

/** Whether `pid` names a process that is alive. EPERM means someone's process: it is alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The agent's process id a running desk wrote, or null. A worktree has no such file: `yokoten desk` starts clones. */
function deskPid(desk: string): number | null {
  let gitDir = join(desk, '.git');
  try {
    if (!lstatSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const pid = Number.parseInt(readFileSync(join(gitDir, DESK_PID_FILE), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Whether a log under `<desk>.state` changed within `windowMs` of `now`. Only files count:
 * making the folder is not work, and a state folder whose log is older than the window is
 * just a copy of a login. The walk stops at the first fresh file. Past the entry limit the
 * answer is active: a folder that big may hide a fresh log, and a doubt keeps the desk.
 */
export function stateIsActive(desk: string, now: number, windowMs: number): boolean {
  const root = `${desk}.state`;
  const deadline = now - windowMs;
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const folder = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++seen > STATE_ENTRY_LIMIT) return true;
      const path = join(folder, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (stats.isFile() && stats.mtimeMs >= deadline) return true;
    }
  }
  return false;
}

/**
 * Every desk this repo knows: the worktrees git lists (the main checkout first) and the
 * clones on the board's desk list. Duplicates count once.
 */
export function findDeskCandidates(root: string, env: Env): Array<{ path: string; isMain: boolean }> {
  const found: Array<{ path: string; isMain: boolean }> = [];
  const seen = new Set<string>();
  const add = (path: string, isMain: boolean) => {
    const real = realPath(path);
    if (seen.has(real)) return;
    seen.add(real);
    found.push({ path, isMain });
  };
  // The session's own checkout is a root even when git can't list the worktrees.
  add(root, true);
  try {
    const list = gitAt(root, ['worktree', 'list', '--porcelain'], env);
    let first = true;
    for (const line of list.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      add(line.slice('worktree '.length), first);
      first = false;
    }
  } catch {
    // No list: the desk list below still names clones, and the session's checkout stays kept.
  }
  const common = commonGitDir(root);
  if (common) {
    let text = '';
    try {
      text = readFileSync(join(common, DESK_LIST_FILE), 'utf8');
    } catch {
      // No list yet: there are no clones from `yokoten desk`.
    }
    for (const line of text.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      if (existsSync(line)) add(line, false);
    }
  }
  return found;
}

/** The branch HEAD names, or null when HEAD is detached or unreadable. */
function currentBranch(desk: string, env: Env): string | null {
  try {
    return gitAt(desk, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env) || null;
  } catch {
    return null;
  }
}

/** The remote branches and the tips of the default branches, as the plan sees them. */
interface RemoteView {
  /** The branch name of every branch on a remote. */
  branches: Set<string>;
  /** The commit of each remote's default branch. */
  defaults: Set<string>;
}

const emptyRemoteView = (): RemoteView => ({ branches: new Set(), defaults: new Set() });

/** Add the branch names and default tips that `main` or `master` name, when no HEAD does. */
function addFallbackDefaults(view: RemoteView, tips: Map<string, string>): void {
  if (view.defaults.size) return;
  for (const name of ['main', 'master']) {
    const tip = tips.get(name);
    if (tip) view.defaults.add(tip);
  }
}

/** Add what local remote-tracking refs say: `%(refname) %(objectname)`, one per line. */
function addLocalRefs(view: RemoteView, text: string): void {
  const tips = new Map<string, string>();
  for (const line of text.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const ref = line.slice(0, space);
    const hash = line.slice(space + 1).trim();
    const name = remoteBranchName(ref);
    if (name === null) {
      if (ref.endsWith('/HEAD') && hash) view.defaults.add(hash);
      continue;
    }
    view.branches.add(name);
    if (!tips.has(name)) tips.set(name, hash);
  }
  addFallbackDefaults(view, tips);
}

/** Add what `git ls-remote --symref --heads` says: `<hash>\trefs/heads/<name>`. */
function addLsRemoteRefs(view: RemoteView, text: string): void {
  let defaultName: string | null = null;
  const tips = new Map<string, string>();
  for (const line of text.split('\n')) {
    const symref = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
    if (symref) {
      defaultName = symref[1];
      continue;
    }
    const match = /^([0-9a-f]+)\trefs\/heads\/(.+)$/.exec(line);
    if (match) tips.set(match[2], match[1]);
  }
  for (const name of tips.keys()) view.branches.add(name);
  const defaultTip = defaultName === null ? undefined : tips.get(defaultName);
  if (defaultTip) view.defaults.add(defaultTip);
  else addFallbackDefaults(view, tips);
}

/**
 * What the remotes say now, or a reason the desk can't be read. A fetch updates the remote
 * refs; a dry run uses `git ls-remote` instead, so no ref changes (#708).
 */
function readRemoteView(desk: string, env: Env, isDryRun: boolean): RemoteView | string {
  let remotes: string[] = [];
  try {
    remotes = gitAt(desk, ['remote'], env).split('\n').map((name) => name.trim()).filter(Boolean);
  } catch {
    return 'git can not read it';
  }
  if (!remotes.length) return 'it has no remote';
  const view = emptyRemoteView();
  if (isDryRun) {
    try {
      for (const remote of remotes) addLsRemoteRefs(view, gitAt(desk, ['ls-remote', '--symref', '--heads', remote], env));
    } catch {
      return 'its remote could not be read';
    }
    return view;
  }
  try {
    gitAt(desk, ['fetch', '--all', '--prune', '--quiet'], env);
  } catch {
    return 'its remote could not be read';
  }
  try {
    addLocalRefs(view, gitAt(desk, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], env));
  } catch {
    return 'git can not read its remote branches';
  }
  return view;
}

/**
 * The paths `git status` names with a change, an untracked file or an ignored file, in NUL
 * form, or null when git can't read them. An ignored file can hold work too, so it counts.
 */
function changedPaths(desk: string, env: Env): string[] | null {
  let text: string;
  try {
    // `matching` names an ignored folder once, so a huge `node_modules` is not walked.
    // No optional lock: a dry run may not even refresh the index.
    text = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'], { cwd: desk, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS });
  } catch {
    return null;
  }
  const paths: string[] = [];
  for (const field of text.split('\0')) {
    // A record is `XY path`. A rename's second field is the old path, with no `XY`.
    if (field.length > 3 && /^[ MADRCU?!]{2} /.test(field)) paths.push(field.slice(3));
  }
  return paths;
}

/** Whether a change matters: `node_modules` and the status file are clutter, not work. */
function matters(path: string): boolean {
  const parts = path.split('/');
  if (parts.includes('node_modules')) return false;
  return parts[parts.length - 1] !== AGENT_STATUS_FILE;
}

/** The branch a remote-tracking ref names, `main` for `refs/remotes/origin/main`, or null. */
function remoteBranchName(ref: string): string | null {
  const prefix = 'refs/remotes/';
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const name = rest.slice(slash + 1);
  return name === 'HEAD' ? null : name;
}

/**
 * Whether `HEAD` is an ancestor of `commit`; null when git can't say (for example, a dry
 * run sees a remote commit that this clone does not have yet).
 */
function isAncestor(desk: string, commit: string, env: Env): boolean | null {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', commit], { cwd: desk, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'ignore'], timeout: GIT_TIMEOUT_MS });
    return true;
  } catch (error) {
    // Exit 1 means "not an ancestor"; anything else means git could not answer.
    return (error as { status?: number }).status === 1 ? false : null;
  }
}

/**
 * Whether a process works inside `folder`, or null when this machine won't say. Linux reads
 * `/proc`; macOS asks `lsof`; another system answers null, and the log and pid roots still
 * decide the desk.
 */
function hasProcessIn(folder: string, env: Env): boolean | null {
  const target = realPath(folder);
  const inFolder = (path: string) => path === target || path.startsWith(target + sep);
  // A process names the real path, and that path may differ from the one we hold.
  const inside = (path: string) => inFolder(path) || inFolder(realPath(path));
  try {
    if (process.platform === 'linux' && existsSync('/proc')) {
      for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let cwd = '';
        try {
          cwd = readlinkSync(`/proc/${name}/cwd`);
        } catch {
          continue;
        }
        if (inside(cwd)) return true;
      }
      return false;
    }
    if (process.platform === 'darwin') {
      // An absolute path when it is there: a session's PATH may leave out /usr/sbin.
      // `lsof` may also exit 1 after listing a partial answer, so its text still counts.
      const lsof = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
      const answer = spawnSync(lsof, ['-a', '-d', 'cwd', '-w', '-F', 'n'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROCESS_READ_TIMEOUT_MS });
      const out = answer.stdout ?? '';
      if (!out) return answer.error ? null : false;
      return out.split('\n').some((line) => line.startsWith('n') && inside(line.slice(1)));
    }
    return null;
  } catch {
    return null;
  }
}

/** The desks that one marker check keeps, and the ones it removes. */
function deskEntry(desk: string, isMain: boolean, root: string, options: GcOptions): GcEntry {
  const verdict = (decision: DeskDecision, reason: string): GcEntry => ({ path: desk, isMain, decision, reason });
  const keep = options.keep === undefined ? root : options.keep;
  if (realPath(desk) === realPath(keep)) return verdict('keep', 'the checkout this session runs in');
  if (isMain) return verdict('keep', 'the main checkout');
  try {
    if (!statSync(desk).isDirectory()) return verdict('list', 'it is not a folder');
  } catch {
    return verdict('list', 'it is gone');
  }
  let isWorktree = false;
  try {
    isWorktree = !lstatSync(join(desk, '.git')).isDirectory();
  } catch {
    return verdict('list', 'it is not a git checkout');
  }
  const pid = deskPid(desk);
  const isAlive = options.isProcessAlive ?? isPidAlive;
  if (pid !== null && isAlive(pid)) return verdict('keep', 'an agent is working there');
  // A worktree has no pid file of its own: any process whose folder is in it keeps it.
  // When this machine won't say, the log root below still holds a working agent.
  if (isWorktree && hasProcessIn(desk, options.env) === true) return verdict('keep', 'a process is running there');
  const now = options.now ?? new Date();
  if (stateIsActive(desk, now.getTime(), ACTIVE_WINDOW_MS)) return verdict('keep', 'its log changed in the last 24 hours');
  const remote = readRemoteView(desk, options.env, options.isDryRun === true);
  if (typeof remote === 'string') return verdict('list', remote);
  const branch = currentBranch(desk, options.env);
  if (branch === null) return verdict('list', 'no branch is checked out');
  const changes = changedPaths(desk, options.env);
  if (changes === null) return verdict('list', 'git can not read its changes');
  if (changes.some(matters)) return verdict('keep', 'it has changes that are not saved');
  let unpushed = 0;
  try {
    unpushed = Number.parseInt(gitAt(desk, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], options.env) || '0', 10);
  } catch {
    return verdict('list', 'it has no commits yet');
  }
  if (unpushed > 0) return verdict('keep', 'it has commits on no remote branch');
  // The branch names match exactly: a ref of another branch that ends with this name is
  // not this branch.
  if (!remote.branches.has(branch)) return verdict('list', 'its branch is on no remote');
  // Merged means the tip is on the default branch. A stacked branch sits on another
  // remote branch, and that is not merged.
  let isMerged: boolean | null = remote.defaults.size ? false : null;
  let sawUnknown = false;
  for (const commit of remote.defaults) {
    const answer = isAncestor(desk, commit, options.env);
    if (answer === true) {
      isMerged = true;
      break;
    }
    if (answer === null) sawUnknown = true;
  }
  if (isMerged !== true && sawUnknown) isMerged = null;
  if (isMerged === null) return verdict('list', 'its default branch could not be read');
  if (!isMerged) return verdict('keep', 'its branch is not merged');
  if (options.openPullBranches === undefined || options.openPullBranches === null) return verdict('list', 'the open pull requests could not be read');
  if (options.openPullBranches.includes(branch)) return verdict('keep', 'an open pull request');
  return verdict('remove', 'it is merged and on the remote');
}

/** The marker's word on every desk of this repo. It changes nothing. */
export function planSweep(root: string, options: GcOptions): GcEntry[] {
  return findDeskCandidates(root, options.env).map((candidate) => deskEntry(candidate.path, candidate.isMain, root, options));
}

/** Remove a desk: the worktree through git, the clone through the filesystem. Throws when it can't. */
function removeDesk(desk: string, root: string, env: Env): void {
  let isWorktree = false;
  try {
    isWorktree = !lstatSync(join(desk, '.git')).isDirectory();
  } catch {
    // No git folder: treat it as a clone and remove the folder.
  }
  if (isWorktree) {
    // No --force: git refuses a worktree it sees as busy, and the desk stays. That is the safe way.
    gitAt(root, ['worktree', 'remove', desk], env);
  } else {
    rmSync(desk, { recursive: true, force: true });
  }
  // The session's state is next to the desk, not in it, so it goes on its own.
  const state = `${desk}.state`;
  if (existsSync(state)) rmSync(state, { recursive: true, force: true });
}

/** Drop the removed desks' lines from the board's desk list in the repo's git folder. */
function rewriteDeskList(root: string, removed: string[]): void {
  const common = commonGitDir(root);
  if (!common) return;
  const list = join(common, DESK_LIST_FILE);
  let text: string;
  try {
    text = readFileSync(list, 'utf8');
  } catch {
    return;
  }
  const gone = new Set(removed.map((path) => realPath(path)));
  const kept = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !gone.has(realPath(line)));
  try {
    writeFileSync(list, kept.length ? `${kept.join('\n')}\n` : '');
  } catch {
    // A list that can't be written costs a stale board line, never work.
  }
}

/** Mark and sweep: remove what no root holds, and list what the marker can't decide. */
export function sweepFinishedDesks(root: string, options: GcOptions): GcResult {
  const entries = planSweep(root, options);
  const removed: string[] = [];
  const failed: GcResult['failed'] = [];
  if (!options.isDryRun) {
    for (const entry of entries) {
      if (entry.decision !== 'remove') continue;
      try {
        removeDesk(entry.path, root, options.env);
        removed.push(entry.path);
      } catch (error) {
        const reason = (error as Error).message.split('\n')[0].trim() || 'removal failed';
        failed.push({ path: entry.path, reason });
        entry.decision = 'list';
        entry.reason = `it could not be removed (${reason})`;
      }
    }
    if (removed.length) rewriteDeskList(root, removed);
  }
  return { entries, removed, failed, isDryRun: options.isDryRun === true };
}

/** The lines a sweep prints: one per desk, and one that says how many. Nothing when there are no desks. */
export function sweepLines(result: GcResult, env: Env = {}): string[] {
  if (!result.entries.length) return [];
  const toRemove = result.entries.filter((entry) => entry.decision === 'remove').length;
  const kept = result.entries.filter((entry) => entry.decision === 'keep').length;
  const listed = result.entries.filter((entry) => entry.decision === 'list').length;
  const verb = result.isDryRun ? 'would remove' : 'removed';
  const parts = [`${toRemove} to remove`, `${kept} kept`, `${listed} to check by hand`];
  const head = `yokoten gc: ${parts.join(', ')}.${result.isDryRun ? ' Nothing is removed: this is a dry run.' : ''}`;
  const lines = result.entries.map((entry) => {
    if (entry.decision === 'remove') return `  ${verb} ${entry.path}: ${entry.reason}`;
    if (entry.decision === 'keep') return `  kept ${entry.path}: ${entry.reason}`;
    return `  check ${entry.path}: ${entry.reason}`;
  });
  // A path in the home folder shows as `~` (core rule 11).
  return hideHome([head, ...lines].join('\n'), env).split('\n');
}
