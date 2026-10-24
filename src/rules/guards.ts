// The rules an agent works under. Each check returns null to let the action go on, or a
// finding: what it stops, why, and what the agent does instead.
//
// `env` is the guard's own environment, which the session sets and the agent cannot change.
// The command text is never read for it: `YOKOTEN_FIX_TASK=0 git commit` inside a command
// changes nothing. A session is the lead unless whoever started it set YOKOTEN_ROLE=worker
// (the dispatch skill does, for each worker it starts), or the lead marked its worktree (#555).
//
// This is a guard against mistakes and drift, not a lock. It reads command text, so a
// command built up in pieces gets past it. The lock is on the server: branch protection,
// CODEOWNERS, and a release token the agents do not hold.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, globSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, type Stats, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { Config, Env } from './config.ts';
import { loadConfig, matcher } from './config.ts';
import { WORKTREES_DIR } from './layout.ts';
import { type Finding, finding, noteWork } from './message.ts';
import { checkCommandTitle } from './pr.ts';
import { type CommandFiles, checkPost, type GhCommand, ghIndex, homeIn, homeOf, hostApiValues, isBotProgram, PIPE_READERS, type Risk, withoutReadPipe } from './privacy/index.ts';

/** A file edit, by path relative to the repo root. */
export function checkEdit(path: string, { config, env }: { config: Config; env: Env }): Finding | null {
  // A file in a worker worktree reads from that worktree (#571); the message keeps the path as given.
  const inWorktree = stripWorktreeRoot(path);
  if (env.YOKOTEN_FIX_TASK === '1' && matcher(config.tests)(inWorktree)) {
    return finding('test-file', `${path} is a test file, and this is a fix task (YOKOTEN_FIX_TASK=1)`, 'if the test is wrong, stop and say so in your report');
  }
  if (env.YOKOTEN_ROLE === 'worker' && isLeadOnly(inWorktree, config.leadOnly) && !isGranted(inWorktree, env)) {
    return finding('lead-only', `${path} is lead-only (yokoten.json "leadOnly")`, LEAD_ONLY_FIX);
  }
  return null;
}

/**
 * `path` (from the repo root, forward slashes) as the worker worktree holding it sees
 * it: each `.worktrees/<name>/` prefix reads as that worktree's root, so
 * `.worktrees/571-x/AGENTS.md` is `AGENTS.md`, still lead-only (#571). A path that is the
 * worktrees folder or a worktree itself stays as it is.
 */
export function stripWorktreeRoot(path: string): string {
  const prefix = `${WORKTREES_DIR}/`;
  while (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return path;
    path = rest.slice(slash + 1);
  }
  return path;
}

const LEAD_ONLY_FIX = 'stop and hand the change to the lead: say in your report what to change in it, or ask the lead to start you with YOKOTEN_LEAD_ONLY_OK=<path>';

// ---- The worker mark (#555) ----
//
// Some runtimes pass their hooks only a few variables, so YOKOTEN_ROLE is lost (Muse Code).
// The lead marks a worker's worktree instead (`yokoten worker mark <dir>`): a file in the
// worktree's own git folder (`.git/worktrees/<name>/`), outside the files an agent edits.
// The guard finds it through the `.git` file, with no git process (#408). The mark only adds
// the worker role, never takes it away. Removing the worktree removes the mark.
// The mark also keeps the worktree's path on the worker list (#566), outside the worktree,
// so moving `.git` away does not lose the role; `yokoten worker unmark` clears it.
//
// It fails closed: a `.git` that is not a folder (a linked worktree's or a submodule's) and
// can't be read as a small file, or that names a git folder that is gone or can't be read,
// makes the session a worker. A worker's plain ways to change the mark are refused (see
// checkWorkerWrites). Like the rest of the guard this reads text, so it is no lock: the lock
// is the server, and credentials kept away from the worker.

/** The mark's file name, in the worktree's own git folder. */
export const WORKER_MARK = 'yokoten-worker';

/** The file in a checkout's git folder that holds a worker's done-when command. */
export const DONE_WHEN_FILE = 'yokoten-done-when';

// ---- The worker list (#566) ----
//
// The mark in the git folder goes with the worktree: moving `.git` away takes it too.
// So `worker mark` also keeps the marked worktree's path in a file outside every
// worktree, under yokoten's config folder. The guard treats a folder on that list, or
// inside one, as a worker's, whether or not `.git` is still there. Removing the worktree
// (`git worktree remove`) leaves an entry whose folder is gone; the guard skips those,
// and the next mark drops them. `worker unmark` clears an entry outright.

/** The file that lists marked worktree paths, under yokoten's config folder. */
export function workersFile(env: Env): string {
  return join(homeIn(env), '.config', 'yokoten', 'workers');
}

// ---- yokoten's config folder (#591) ----
//
// The worker list and the bot's keys are in `~/.config/yokoten`. A worker that clears the
// list loses its role, as with the mark (#555), so a worker's plain ways to change that
// folder are refused too: see checkWorkerWrites and checkWorkerMarkEdit. Reads pass.

/** yokoten's config folder, which holds the worker list and the bot's keys; null with no home folder. */
export function configFolder(env: Env): string | null {
  const home = homeOf(env);
  return home ? join(home, '.config', 'yokoten') : null;
}

/** The stop log's name, in yokoten's config folder (#621). */
export const STOPS_FILE = 'stops.jsonl';
/** The file that says the owner turned the stop log off (#621). */
export const STOPS_OFF_FILE = 'stops-off';

/** The stop log in yokoten's config folder, or null with no home folder. Nothing reads it from the project (#621). */
export function stopsFile(env: Env): string | null {
  const folder = configFolder(env);
  return folder ? join(folder, STOPS_FILE) : null;
}

/** The file that marks the stop log off, or null with no home folder (#621). */
export function stopsOffFile(env: Env): string | null {
  const folder = configFolder(env);
  return folder ? join(folder, STOPS_OFF_FILE) : null;
}

const CONFIG_FIX = "leave yokoten's config folder (~/.config/yokoten) as it is: only the lead changes the worker list and the bot's keys; if your task needs a change there, stop and tell the lead";
const configFinding = (what: string) => finding('worker-mark', what, CONFIG_FIX);

// Text that names yokoten's config folder or the worker list.
const NAMES_CONFIG = /\.config[\\/]+yokoten|yokoten[\\/]+workers/i;

/**
 * Whether a command names yokoten's config folder or the worker list, in text or by a glob
 * that can match `.config/yokoten` or `yokoten/workers`. A pair of bare globs (`*` `/` `*`)
 * names nothing.
 */
function namesConfigFolder(command: string): boolean {
  if (NAMES_CONFIG.test(command)) return true;
  for (const word of command.split(/[\s'"`;|&<>()=:]+/)) {
    const parts = word.split(/[\\/]+/);
    for (let at = 0; at + 1 < parts.length; at++) {
      const pair = [parts[at], parts[at + 1]];
      if (!pair.some((part) => /[a-z]/i.test(part))) continue;
      if (globMatches(pair[0], '.config') && globMatches(pair[1], 'yokoten')) return true;
      if (globMatches(pair[0], 'yokoten') && globMatches(pair[1], 'workers')) return true;
    }
  }
  return false;
}

/**
 * `path` with a leading `~`, `$HOME` or `${HOME}` read as `home`, and a leading `~+` (the
 * shell's `$PWD`) as `folder`; as it is when that one is unknown.
 */
function withHomeRead(path: string, home: string | null, folder: string | null = null): string {
  if (folder !== null && /^~\+(?=[\\/]|$)/.test(path)) return folder + path.slice(2);
  if (home === null) return path;
  const lead = /^(~|\$HOME|\$\{HOME\})(?=[\\/]|$)/.exec(path);
  return lead ? home + path.slice(lead[0].length) : path;
}

/** The folders a path may not be, be in, or hold: the config folder as written and by real path. */
function configForms(config: string): string[][] {
  return [...new Set([config, realPath(config)])].map((form) => form.split(/[\\/]+/).filter(Boolean));
}

/**
 * Whether the absolute `path` is yokoten's config folder, inside it, or a folder that holds
 * it (`~/.config`, `~`). It is compared by real path, so a symlink counts. A glob part
 * (`yoko*`, `{yokoten,x}`) counts when it can match the folder's part in the same place.
 */
function touchesConfig(path: string, forms: string[][]): boolean {
  for (const form of braceForms(path, 0)) {
    const parts = form.split(/[\\/]+/).filter(Boolean);
    const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
    const candidates =
      firstGlob === -1
        ? [parts, realPath(form).split(/[\\/]+/).filter(Boolean)]
        : [parts, [...realPath(`/${parts.slice(0, firstGlob).join('/')}`).split(/[\\/]+/).filter(Boolean), ...parts.slice(firstGlob)]];
    for (const candidate of candidates) {
      for (const config of forms) {
        const shared = Math.min(candidate.length, config.length);
        let isMatch = true;
        for (let at = 0; at < shared && isMatch; at++) isMatch = globMatches(candidate[at], config[at].toLowerCase());
        if (isMatch) return true;
      }
    }
  }
  return false;
}

// A part of a path the guard can't read: a variable, `${...}`, `$(...)` or `...`.
const UNKNOWN_PART = /\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]/g;
// What an unknown part may be: any name, a dot name too (`*` alone skips those).
const ANY_PART = '{*,.*}';

/** Whether a path whose start can't be read goes on with `.config` and, if more, `yokoten` (`$H/.c*`, `$H/.config/yo*`). */
function hasConfigTail(path: string): boolean {
  const parts = path.split(/[\\/]+/);
  return parts.some((part, at) => /[a-z]/i.test(part) && globMatches(part, '.config') && (at + 1 === parts.length || !parts[at + 1] || globMatches(parts[at + 1], 'yokoten')));
}

type ConfigContext = { folder: string | null; command: string; words: string[]; home: string | null; forms: string[][] };

/**
 * For a worker: why `target` may change yokoten's config folder (#591), or null. `does` is
 * what the command does to it; `shown` is the path as the command wrote it. `~`, `$HOME` and `${HOME}` are read as home; any other
 * unknown part (`$X`, `$(...)`) may be any name. A target whose start can't be read (`$H/...`,
 * `~user`, a relative path from an unknown folder) counts when the command, its words with
 * quotes taken off, or the target itself names the config folder or the worker list.
 */
function configTargetRefusal(target: string, context: ConfigContext, { does = 'changes', shown = target } = {}): Finding | null {
  const { folder, command, words, home, forms } = context;
  const expanded = withHomeRead(target, home, folder);
  const globbed = expanded.replace(UNKNOWN_PART, ANY_PART);
  const isStartRead = !globbed.startsWith(ANY_PART) && !globbed.startsWith('~') && !/[$`]/.test(globbed) && (folder !== null || isAbsolute(globbed));
  if (isStartRead && forms.length) {
    const full = resolve(folder ?? '/', globbed);
    return touchesConfig(full, forms) ? configFinding(`this command ${does} ${shown}, which is or holds yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`) : null;
  }
  const isNamed = namesConfigFolder(command) || namesConfigFolder(words.join(' ')) || namesConfigFolder(globbed) || (!isStartRead && hasConfigTail(globbed));
  return isNamed ? configFinding(`this command ${does} ${shown}, a path yokoten can't read, and names yokoten's config folder, where the worker list is kept`) : null;
}

/** What the workers file starts with: what it is, and what clears an entry. */
const WORKERS_HEADER = `# yokoten workers: worktree paths the lead marked as workers' (#566).
# One absolute path per line. The guard treats a folder on this list, or inside one, as a
# worker's, even when its .git is gone. \`git worktree remove\` or \`yokoten worker unmark\`
# clears an entry. Lines starting with # are comments.
`;

/** The marked worktree paths on the worker list. Empty when the file is missing. */
export function loadWorkerPaths(env: Env): string[] {
  let text: string;
  try {
    text = readFileSync(workersFile(env), 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** Whether `path` names a folder that is still there. */
function isFolderThere(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether `folder` is on the worker list, or inside a listed worktree (#566): the
 * listed entry, or null. Entries whose folders are gone (a removed worktree) never match.
 */
export function listedWorker(folder: string, env: Env): string | null {
  const full = realPath(folder);
  for (const entry of loadWorkerPaths(env)) {
    const base = realPath(resolve(entry));
    if (!isFolderThere(base)) continue;
    if (full === base || full.startsWith(base + sep)) return entry;
  }
  return null;
}

/** Keep `path` on the worker list, dropping entries whose folders are gone. */
export function addWorkerPath(env: Env, path: string): void {
  const here = realPath(path);
  const kept = loadWorkerPaths(env).filter((entry) => realPath(entry) !== here && isFolderThere(realPath(entry)));
  mkdirSync(dirname(workersFile(env)), { recursive: true });
  writeFileSync(workersFile(env), `${WORKERS_HEADER}${[...kept, here].join('\n')}\n`);
}

/** Drop the worker list entries at, inside, or around `path`. */
export function removeWorkerPath(env: Env, path: string): void {
  const base = realPath(path);
  const kept = loadWorkerPaths(env).filter((entry) => {
    const other = realPath(entry);
    return other !== base && !base.startsWith(other + sep) && !other.startsWith(base + sep);
  });
  mkdirSync(dirname(workersFile(env)), { recursive: true });
  writeFileSync(workersFile(env), `${WORKERS_HEADER}${kept.length ? `${kept.join('\n')}\n` : ''}`);
}

/** The largest `.git` file read: a real one is one line. */
const DOT_GIT_LIMIT = 4096;

/**
 * What the `.git` at or above `folder` says, with no git process: `folder`, a main checkout's
 * git folder (it holds the `HEAD`, `objects` and `refs` git needs); `file`, the git folder a
 * linked worktree's or a submodule's `.git` names (it may be gone); `broken`, a `.git` that is
 * no folder and no small readable file with a gitdir line, a folder the guard cannot read, or
 * a folder that kept the worker's own files but lost what git needs; null outside a checkout.
 */
export type GitLink = { kind: 'folder' | 'file'; top: string; gitDir: string } | { kind: 'broken'; top: string } | null;

export function gitLinkAbove(folder: string): GitLink {
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    let stats: Stats | undefined;
    try {
      stats = lstatSync(dotGit);
    } catch (error) {
      // Gone is the usual answer: walk up. Anything else, the guard can't tell.
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { kind: 'broken', top: dir };
    }
    if (stats) {
      if (stats.isDirectory() || (stats.isSymbolicLink() && isFolder(dotGit))) {
        const isGit = gitFolderState(dotGit);
        if (isGit === 'yes') return { kind: 'folder', top: dir, gitDir: dotGit };
        if (isGit === 'broken') return { kind: 'broken', top: dir };
        // An empty `.git` is not a checkout: walk on past it (#746).
      } else {
        const text = readSmallFile(dotGit);
        const line = text === null ? null : /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text);
        return line ? { kind: 'file', top: dir, gitDir: resolve(dir, line[1]) } : { kind: 'broken', top: dir };
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Whether a `.git` folder is one git would use. `broken` when the guard can't read it, or when
 * the folder carries the worker's own files but git would not use it: a desk must not become
 * its parent's checkout (#746). The caller then fails closed. No git process runs.
 */
function gitFolderState(gitDir: string): 'yes' | 'no' | 'broken' {
  try {
    if (isGitFolder(gitDir)) return 'yes';
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'broken';
  }
  for (const name of [WORKER_MARK, DONE_WHEN_FILE]) {
    try {
      statSync(join(gitDir, name));
      return 'broken';
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'broken';
    }
  }
  return 'no';
}

/**
 * Whether git itself would use this folder: `HEAD` a regular file (not a symlink) whose text is
 * a `ref:` line or a commit sha, plus `objects` and `refs` folders. Git ignores anything less
 * and walks up to the parent checkout, so the guard must too (#746). A reftable store is not
 * checked: git still writes a `HEAD` line beside it, and no git here has `--ref-format`.
 */
function isGitFolder(gitDir: string): boolean {
  const head = join(gitDir, 'HEAD');
  if (!lstatSync(head).isFile()) return false;
  const text = readSmallFile(head)?.trim() ?? '';
  if (!/^ref:[ \t]*\S/.test(text) && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(text)) return false;
  return statSync(join(gitDir, 'objects')).isDirectory() && statSync(join(gitDir, 'refs')).isDirectory();
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// A regular file of at most DOT_GIT_LIMIT bytes, or null. It is opened without waiting, and
// checked after the open: a FIFO or a device named `.git` never blocks the guard.
function readSmallFile(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > DOT_GIT_LIMIT) return null;
    const buffer = Buffer.alloc(stats.size);
    const read = readSync(fd, buffer, 0, stats.size, 0);
    return buffer.toString('utf8', 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Why the checkout at or above `folder` makes a session a worker: `mark`, its git folder
 * holds the mark (a worktree's, or a marked clone's own `.git`, #672) or its path is on the
 * worker list (#566); `broken`, its `.git` or the git folder it names can't be read, so the
 * guard fails closed; null, it does not (an unmarked main checkout or worktree, no checkout). `env` finds the worker list; without a
 * home folder there is no list, and only the mark counts.
 */
export function workerMarkAt(folder: string, env: Env = {}): 'mark' | 'broken' | null {
  const link = gitLinkAbove(folder);
  if (link === null) return listedWorker(folder, env) ? 'mark' : null;
  if (link.kind === 'broken') return 'broken';
  if (link.kind === 'folder') {
    // A plain clone the lead marked, such as a desk (#672): the mark is in its own `.git`.
    // Muse Code drops YOKOTEN_ROLE from its hooks, so there this file alone makes a worker.
    try {
      statSync(join(link.gitDir, WORKER_MARK));
      return 'mark';
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'broken';
    }
    return listedWorker(folder, env) ? 'mark' : null;
  }
  try {
    statSync(join(link.gitDir, WORKER_MARK));
    return 'mark';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'broken';
  }
  // No mark: the git folder itself must be there and readable, or the guard can't tell.
  try {
    if (!statSync(link.gitDir).isDirectory()) return 'broken';
    accessSync(link.gitDir, constants.R_OK | constants.X_OK);
  } catch {
    return 'broken';
  }
  return listedWorker(folder, env) ? 'mark' : null;
}

/** Whether the checkout at or above `folder` makes a session a worker: the mark, the worker list, or a link the guard can't read. */
export const hasWorkerMark = (folder: string, env: Env = {}): boolean => workerMarkAt(folder, env) !== null;

/**
 * The one place that decides a worker (#555): `env` when YOKOTEN_ROLE=worker, `mark` when
 * any of `folders` is in a marked worktree (or on the worker list, #566, or one whose
 * link can't be read), else null. The tool guard, the stop check, the commit check and
 * the session start all ask here.
 */
export function workerRole(env: Env, folders: string[]): 'env' | 'mark' | null {
  if (env.YOKOTEN_ROLE === 'worker') return 'env';
  return [...new Set(folders)].some((folder) => hasWorkerMark(folder, env)) ? 'mark' : null;
}

/** `env` with YOKOTEN_ROLE=worker when `workerRole` says so; else `env` as it is. */
export function withWorkerMark(env: Env, folders: string[]): Env {
  return workerRole(env, folders) === 'mark' ? { ...env, YOKOTEN_ROLE: 'worker' } : env;
}

/**
 * What a refusal adds when the worker role came from the mark (#555): why this session is a
 * worker, and where the lead works. `folders` are the ones `workerRole` read.
 */
export function markNote(folders: string[], env: Env = {}): string {
  for (const folder of new Set(folders)) {
    const why = workerMarkAt(folder, env);
    if (why === null) continue;
    const link = gitLinkAbove(folder);
    const main = link?.kind === 'file' ? mainCheckout(link.gitDir) : null;
    const lead = main ? `the lead works in the main checkout, ${main}` : 'the lead works in the main checkout';
    if (why === 'broken') return `yokoten treats this session as a worker because the .git link in ${link?.top ?? folder} can't be read; ${lead}`;
    if (link?.kind === 'folder' && existsSync(join(link.gitDir, WORKER_MARK))) {
      return `this clone (${link.top}) carries the worker mark, so every agent in it is a worker whatever YOKOTEN_ROLE says; the lead works outside it`;
    }
    if (link?.kind === 'file') return `this worktree (${link?.top ?? folder}) carries the worker mark, so every agent in it is a worker whatever YOKOTEN_ROLE says; ${lead}`;
    return `this folder (${folder}) is on the worker list, so every agent in it is a worker whatever YOKOTEN_ROLE says; ${lead}`;
  }
  return '';
}

// The main checkout of a linked worktree's git folder, from its `commondir`, or null.
function mainCheckout(gitDir: string): string | null {
  const common = readSmallFile(join(gitDir, 'commondir'))?.trim();
  if (!common) return null;
  const dir = resolve(gitDir, common);
  return basename(dir) === '.git' ? dirname(dir) : dir;
}

/** The git folders a worker in `folder` may not change: its own, and the shared one, by real path. */
function protectedGitDirs(folder: string): string[] {
  const link = gitLinkAbove(folder);
  if (link === null || link.kind === 'broken') return [];
  const common = link.kind === 'file' ? readSmallFile(join(link.gitDir, 'commondir'))?.trim() : undefined;
  return [...new Set([link.gitDir, ...(common ? [resolve(link.gitDir, common)] : [])].map(realPath))];
}

const MARK_FIX = 'leave the git folder and the worker mark as they are; if your task needs them, stop and tell the lead';
const markFinding = (what: string) => finding('worker-mark', what, MARK_FIX);

// Whether the shell glob `pattern` matches `name`, case aside: `*`, `?`, `[...]` and `{a,b}`
// as bash reads them. A leading dot is matched only by a dot, as with bash's dotglob off.
// It evaluates the glob, so `.gi?` is `.git`; it does not guess at text.
function globMatches(pattern: string, name: string): boolean {
  if (pattern.toLowerCase() === name) return true;
  if (!/[*?[{]/.test(pattern)) return false;
  return braceForms(pattern, 0).some((form) => {
    if (name.startsWith('.') && !form.startsWith('.') && !form.startsWith('\\.')) return false;
    let source = '';
    for (let at = 0; at < form.length; at++) {
      const char = form[at];
      if (char === '\\' && at + 1 < form.length) source += escapeRegExp(form[++at]);
      else if (char === '*') source += '.*';
      else if (char === '?') source += '.';
      else if (char === '[') {
        const close = form.indexOf(']', at + 2);
        if (close === -1) source += '\\[';
        else {
          const inner = form.slice(at + 1, close).replace(/^[!^]/, '^').replace(/\\/g, '\\\\');
          source += `[${inner}]`;
          at = close;
        }
      } else source += escapeRegExp(char);
    }
    try {
      return new RegExp(`^${source}$`, 'is').test(name);
    } catch {
      return true; // a class the guard can't read may match
    }
  });
}

// The words a brace expansion makes, at most 64; `{a,b}` with no nesting.
function braceForms(pattern: string, depth: number): string[] {
  const brace = /\{([^{}]*,[^{}]*)\}/.exec(pattern);
  if (!brace || depth > 6) return [pattern];
  const head = pattern.slice(0, brace.index);
  const tail = pattern.slice(brace.index + brace[0].length);
  return brace[1].split(',').flatMap((part) => braceForms(`${head}${part}${tail}`, depth + 1)).slice(0, 64);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Text that names a git folder: the mark, a `.git` part, git's options and variables for one.
const NAMES_GIT_DIR = new RegExp(`${WORKER_MARK}|(^|[\\s'"=:/\\\\(\`;&|<>])\\.git(?=$|[\\s'"/\\\;&|)\`<>])|--(absolute-)?git-(dir|common-dir|path)\\b|\\bGIT_(DIR|COMMON_DIR)\\b|gitdir`, 'i');

/** Whether `name`, one part of a path as the shell reads it (a glob too), can be `.git`. */
const mayBeDotGit = (name: string) => globMatches(name, '.git');

// Where a path, or a command's text, breaks into parts: folders, words, substitutions.
const PATH_BREAKS = /[\s/\\()'"`$;|&<>=:]+/;

/**
 * Whether `path`, as written, may name a `.git` folder or the worker mark: a part that can be
 * `.git`, the mark by name, or a glob that can be the mark in a path the guard can't read
 * (`$(...)/yokoten-w*`) or in a git folder's `worktrees`. A glob alone (`rm dist/*`) is not.
 */
function mayBeGitPath(path: string): boolean {
  const parts = path.split(PATH_BREAKS).filter(Boolean);
  if (parts.some((part) => mayBeDotGit(part) || part.toLowerCase() === WORKER_MARK)) return true;
  const unread = /[$`]/.test(path) || parts.some((part) => part.toLowerCase() === 'worktrees');
  return unread && parts.some((part) => globMatches(part, WORKER_MARK));
}

/**
 * Whether a command names a git folder or the mark, in text or by a glob that can match one.
 * A glob for the mark needs a letter of its own: a bare `*` names nothing.
 */
const namesGitDir = (command: string) =>
  NAMES_GIT_DIR.test(command) || command.split(PATH_BREAKS).some((part) => mayBeDotGit(part) || (/[a-z]/i.test(part) && globMatches(part, WORKER_MARK)));

// Programs that change files beyond WRITERS: their plain words are their files. ln also
// names the file it links to.
const MARK_WRITERS = new Set(['chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'touch', 'mkdir', 'mkfifo', 'mknod', 'rsync', 'ln']);
// Programs that run code given to them: what that code changes is not read.
const RUNS_CODE = /^(python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|osascript|pwsh|powershell|sh|bash|zsh|dash|ksh|fish)$/;
const FIND_WRITES = /^-(delete|fprint0?|fprintf|fls)$/;

/**
 * For a worker: a command that writes, moves, removes, links or changes the mode of a file in
 * a git folder, or redirects into one (#555), or null. A read that names `.git` passes
 * (`grep --exclude-dir=.git`, `find . -path ./.git -prune`, `grep GIT_DIR`). A target counts
 * when it may be a `.git` folder or the mark (see mayBeGitPath), when its real path is in the
 * worker's own git folders, and when the guard can't read it (`$(...)`, `$x`, `xargs rm`,
 * `find -exec rm`, inline code) in a command that names a git folder. The same holds for
 * yokoten's config folder, where the worker list is kept (#591): see configTargetRefusal.
 */
function checkWorkerWrites(words: string[], { folder, near = folder, command, env = {} }: { folder: string | null; near?: string | null; command: string; env?: Env }): Finding | null {
  const known = new Map<string, string | null>();
  const targets = writeTargets(words, folder, (dir) => gitRootAbove(dir, known)).map((target) => target.path);
  const names: string[] = [];
  const writes = (name: string) => Object.hasOwn(WRITERS, name) || MARK_WRITERS.has(name) || RUNS_CODE.test(name);
  // The folders a find that writes starts in, with its arguments; the folders git works in.
  const finds: { starts: string[]; args: string[] }[] = [];
  const gitFolders: { path: string; written: string }[] = [];
  const home = homeOf(env);
  // A find's start folders: the find loop below decides whether it reaches a git folder.
  const findStarts = new Set<string>();
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    const name = programName(program);
    names.push(name);
    const args = withoutShellRedirects(words, at + 1);
    if (MARK_WRITERS.has(name)) targets.push(...plainArgs(args));
    // A hard link to a file is that file: `cp -l list w` then `: > w` empties the list.
    if (name === 'link' || (name === 'cp' && args.some((arg) => arg === '--link' || /^-[A-Za-z]*l[A-Za-z]*$/.test(arg)))) targets.push(...plainArgs(args, COPY_VALUES));
    if (name === 'find') {
      const found = findWrites(args, writes);
      if (found) {
        finds.push(found);
        targets.push(...found.starts);
        for (const start of found.starts) findStarts.add(start);
      }
    }
    if (isGit(program)) {
      gitFolders.push(...gitWorkFolders(args, folder, home), ...gitEnvironmentFolders(command, folder, home));
      if (near !== folder) gitFolders.push(...gitWorkFolders(args, near, home), ...gitEnvironmentFolders(command, near, home));
    }
  }
  // Files the guard can't see: a program fed by xargs or find, a find that writes, inline code.
  const fed = words.some((word) => programName(word) === 'xargs') || names.includes('find');
  const codeRuns = names.some((name) => RUNS_CODE.test(name));
  const fedWrite = fed && names.some(writes);
  const findWrite = names.includes('find') && words.some((word) => FIND_WRITES.test(word));
  const blind = codeRuns || fedWrite || findWrite;
  const isConfigNamed = () => namesConfigFolder(command) || namesConfigFolder(words.join(' '));
  // A find the guard can read, and that keeps `.git` out of the action, is not blind (#744).
  const findIsRead = folder !== null && !codeRuns && !fedWrite && finds.length > 0 && finds.every(({ args: findArgs }) => findSparesGitTree(findArgs, folder, home));
  if (blind && !findIsRead && namesGitDir(command)) return markFinding("this command names a git folder, and yokoten can't read which files it changes there");
  if (blind && isConfigNamed()) return configFinding("this command names yokoten's config folder, where the worker list is kept, and yokoten can't read which files it changes there");
  const config = configFolder(env);
  const context: ConfigContext = { folder, command, words, home, forms: config === null ? [] : configForms(config) };
  for (const { path, written } of gitFolders) {
    const refusal = configTargetRefusal(path, context, { does: 'runs git in', shown: written });
    if (refusal) return refusal;
  }
  let dirs: string[] | undefined;
  // A find that writes, started at or above a git folder, may reach the mark unless its
  // names keep it away (`find . -name '*.log' -delete`).
  for (const { starts, args } of finds) {
    if (folder === null || !mayReachGitFolder(args)) continue;
    // Any `-o` used to count as reaching the mark. A prune or an exclusion that really
    // keeps the walk out of `.git` does not (#744), so the mark rule stands down.
    if (findSparesGitTree(args, folder, home)) continue;
    dirs ??= protectedGitDirs(folder);
    const top = gitLinkAbove(folder);
    const held = [...dirs, ...(top ? [realPath(join(top.top, '.git'))] : [])];
    for (const start of starts) {
      if (/[$`~]/.test(start)) continue;
      const full = realPath(resolve(folder, start));
      const inside = full.endsWith(sep) ? full : full + sep;
      if (held.some((dir) => dir === full || dir.startsWith(inside))) return markFinding(`this command changes files under ${start}, which holds a git folder, where the worker mark is kept`);
    }
  }
  for (const written of targets) {
    const refusal = configTargetRefusal(written, context);
    if (refusal) return refusal;
    if (mayBeGitPath(written)) return markFinding(`this command changes ${written}, which may be a .git folder or the worker mark`);
    // `$PWD` and `~+` are the folder the command runs in, `~` and `$HOME` the home folder (#672).
    const target = folder === null ? written : withHomeRead(written.replace(/^(\$PWD|\$\{PWD\})(?=[\\/]|$)/, folder), home, folder);
    if (/[$`]/.test(target)) {
      if (namesGitDir(command)) return markFinding(`this command changes ${written}, a path yokoten can't read, and names a git folder`);
      continue;
    }
    if (folder === null && !isAbsolute(target)) continue;
    dirs ??= folder === null ? [] : protectedGitDirs(folder);
    if (!dirs.length) continue;
    const full = realPath(resolve(folder ?? '/', target));
    if (dirs.some((dir) => full === dir || full.startsWith(dir + sep))) return markFinding(`this command changes ${written}, which is inside a git folder, where the worker mark is kept`);
    // A folder that holds the git folder: removing or replacing it drops the mark (#672).
    if (findStarts.has(written)) continue;
    const top = gitLinkAbove(folder ?? '/');
    const held = [...dirs, ...(top ? [realPath(join(top.top, '.git'))] : [])];
    const inside = full.endsWith(sep) ? full : full + sep;
    if (held.some((dir) => dir.startsWith(inside))) return markFinding(`this command changes ${written}, which holds a git folder, where the worker mark is kept`);
  }
  return null;
}

// find's options before its start folders, and the actions that pick or join what it matches.
const FIND_LEAD_OPTIONS = /^-([HLP]|O\d*)$/;
const FIND_NAME_TESTS = new Set(['-name', '-iname']);
const FIND_PATH_TESTS = new Set(['-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']);
const FIND_JOINS = new Set(['-o', '-or', '!', '-not', ',']);

/**
 * A find's start folders (`.` when it names none) and its arguments, when it writes: an
 * action in FIND_WRITES, or -exec and its kin running a writer. Null for a find that reads.
 */
function findWrites(args: string[], writes: (name: string) => boolean): { starts: string[]; args: string[] } | null {
  const isWriting = args.some((arg, at) => FIND_WRITES.test(arg) || (FIND_ACTIONS.has(arg) && writes(programName(args[at + 1] ?? ''))));
  if (!isWriting) return null;
  let at = 0;
  while (at < args.length && (FIND_LEAD_OPTIONS.test(args[at]) || args[at] === '-D')) at += args[at] === '-D' ? 2 : 1;
  const starts: string[] = [];
  for (; at < args.length && !/^[-(!),]/.test(args[at]); at++) starts.push(args[at]);
  return { starts: starts.length ? starts : ['.'], args };
}

/**
 * Whether a find that writes may reach `.git` or the mark below its start: unless every
 * name test (`-name`, `-path`, ...) is one that can't match them, with no `-o` or `!` to
 * turn it around. find's `*` matches a leading dot too.
 */
function mayReachGitFolder(args: string[]): boolean {
  if (args.some((arg) => FIND_JOINS.has(arg))) return true;
  let isNamed = false;
  for (const [at, arg] of args.entries()) {
    const pattern = args[at + 1] ?? '';
    if (FIND_NAME_TESTS.has(arg)) {
      isNamed = true;
      if ([WORKER_MARK, '.git'].some((name) => globMatches(`_${pattern}`, `_${name}`))) return true;
    }
    if (FIND_PATH_TESTS.has(arg)) {
      isNamed = true;
      if (namesGitDir(pattern) || !/[a-z]/i.test(pattern)) return true;
    }
  }
  return !isNamed;
}

/**
 * The folders git works in from its words after `git`, each with the path as written: each
 * `-C` (from the one before), or with none the folder the command runs in (after a `cd`; `.`
 * when unknown), `--work-tree` and `--git-dir`, and the folder `git init` or `git clone`
 * makes. A path the guard can't read is kept as written.
 */
function gitWorkFolders(args: string[], folder: string | null, home: string | null): { path: string; written: string }[] {
  const folders: { path: string; written: string }[] = [];
  let base = folder;
  const place = (path: string) => {
    const expanded = withHomeRead(path, home, base);
    if (/[$`]/.test(expanded) || expanded.startsWith('~')) return path;
    return base === null ? (isAbsolute(expanded) ? expanded : path) : resolve(base, expanded);
  };
  let at = 0;
  for (; at < args.length && args[at].startsWith('-'); at++) {
    const [option, joined] = args[at].split(/=(.*)/s);
    const value = joined ?? args[at + 1] ?? '';
    if (option === '-C') {
      const placed = place(value);
      folders.push({ path: placed, written: value });
      base = isAbsolute(placed) ? placed : null;
    } else if (option === '--work-tree' || option === '--git-dir') folders.push({ path: place(value), written: value });
    if (joined === undefined && GIT_VALUE_OPTIONS.has(option)) at++;
  }
  if (!args.slice(0, at).some((arg) => arg === '-C')) folders.push({ path: folder ?? '.', written: folder === null ? '.' : withHomeShown(folder, home) });
  const sub = args[at];
  if (sub === 'init' || sub === 'clone') {
    for (const arg of args.slice(at + 1)) {
      const [option, joined] = arg.split(/=(.*)/s);
      if (!arg.startsWith('-')) folders.push({ path: place(arg), written: arg });
      else if (option === '--separate-git-dir' && joined !== undefined) folders.push({ path: place(joined), written: joined });
    }
  }
  return folders;
}

// GIT_WORK_TREE= and GIT_DIR= anywhere in a command: before git, after `env`, or in an `export`.
const GIT_FOLDER_SETTING = /(?:^|[\s;&|(])GIT_(?:WORK_TREE|DIR)\+?=("[^"]*"|'[^']*'|[^\s;&|)]*)/g;

/** The folders the command's GIT_WORK_TREE and GIT_DIR settings name, placed from `folder` (#591). */
function gitEnvironmentFolders(command: string, folder: string | null, home: string | null): { path: string; written: string }[] {
  const folders: { path: string; written: string }[] = [];
  for (const [, value] of command.matchAll(GIT_FOLDER_SETTING)) {
    const written = /^["']/.test(value) ? value.slice(1, -1) : value;
    const expanded = withHomeRead(written, home, folder);
    const isRead = !/[$`]/.test(expanded) && !expanded.startsWith('~') && (folder !== null || isAbsolute(expanded));
    folders.push({ path: isRead ? resolve(folder ?? '/', expanded) : written, written: written || '""' });
  }
  return folders;
}

/** `path` with the home folder shown as `~`, so a message never prints it. */
function withHomeShown(path: string, home: string | null): string {
  if (home === null) return path;
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

// ---- The worker's box (#591) ----
//
// Each review of the target reader found a new bash spelling past it (`$'\x2e'`, a glob in
// a `cd`, GIT_WORK_TREE set by `read`, `git diff --output`, LESSOPEN). The guard stops
// reading grammar for a worker and boxes it instead, by a small set of what is allowed:
// a `cd` only to a plain path inside its worktree, no `$'...'` or `${...@...}`, environment
// settings only from a short list, git with no option before its subcommand, and no
// output option on git, less or file. A command that still names the home config folder
// passes only when every program in it is a plain reader. Like the rest of the guard this
// reads text: a script the worker writes and then runs is out of its reach (issue #589).

/** The settings a worker may put before a command or export: none of them moves a folder or runs code. */
const WORKER_SETTINGS = new Set(['TZ', 'CI', 'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR', 'DEBUG', 'LANG', 'LC_ALL']);
const DECLARERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
const FOLDER_MOVERS = new Set(['cd', 'pushd', 'popd']);
const VARIABLE_SETTERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'eval', 'source', '.']);
// A plain path: letters, digits, `.`, `_`, `/`, `-`, and `~` only as home at the start.
const PLAIN_PATH = /^(~(?=\/|$))?[A-Za-z0-9._/-]*$/;
// git options a worker may give before the subcommand: none of them moves a folder.
const GIT_PLAIN_OPTIONS = new Set(['--no-pager', '-P', '--version', '--help']);
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
const GIT_CONFIG_WRITES = /^(--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e|set|unset|rename-section|remove-section|edit)$/;
const BOX_FIX = 'work inside your worktree with plain paths and no extra settings; if your task needs more, stop and ask the lead';
const boxFinding = (what: string) => finding('worker-mark', what, BOX_FIX);

/** Whether `name` is a long option `--x` that is `full`, an abbreviation of it, or longer (`--outp`, `--output-directory`). */
function isLongOption(word: string, full: string): boolean {
  if (!word.startsWith('--')) return false;
  const name = word.slice(2).split('=')[0].toLowerCase();
  return name.length > 0 && (full.startsWith(name) || name.startsWith(full));
}

/** Whether `word` is a group of short options (`-Ro`) with any of `letters` in it. */
const hasShortOption = (word: string, letters: string) => /^-[^-]/.test(word) && [...letters].some((letter) => word.slice(1).includes(letter));

/**
 * The first setting in `words` that a worker may not make, from `start` to `limit`: before
 * a command, after `env`, `sudo` or another launcher, or in export/declare/readonly/typeset/
 * local. An option to `env`, or a folder option to `sudo`, counts too. Null when all pass.
 */
function workerSettingAt(words: string[], start: number, limit = words.length): string | null {
  let index = start;
  while (index < limit) {
    for (;;) {
      const word = words[index];
      if (word === undefined || index >= limit) return null;
      if (isAssignment(word)) {
        if (!WORKER_SETTINGS.has(word.slice(0, word.indexOf('=')).replace(/\+$/, ''))) return word;
        index++;
      } else if (KEYWORDS.has(word)) index++;
      else if (redirectLength(words, index) > 0) index += redirectLength(words, index);
      else break;
    }
    if (HEADS.has(words[index])) return null;
    const name = programName(words[index]);
    if (DECLARERS.has(name)) {
      for (const arg of words.slice(index + 1, limit)) {
        const setting = arg.split('=')[0].replace(/\+$/, '');
        if (arg.startsWith('-') || !/^[A-Za-z_]\w*$/.test(setting) || !WORKER_SETTINGS.has(setting)) return arg;
      }
      return null;
    }
    if (!Object.hasOwn(LAUNCHERS, name)) return null;
    index++;
    if (name === 'env' && index < limit && words[index].startsWith('-')) return words[index];
    while (index < limit && words[index].startsWith('-')) {
      const option = words[index];
      if (['sudo', 'doas'].includes(name) && (option.startsWith('--c') || hasShortOption(option, 'D'))) return option;
      index += LAUNCHERS[name].options.includes(option) ? 2 : 1;
    }
    index += LAUNCHERS[name].operands ?? 0;
  }
  return null;
}

/** The command's text with quoted parts left out, for the characters that start a subshell. */
const withoutQuoted = (command: string) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');

/**
 * For a worker: why the command leaves the box, or null. `cwd` is the folder the command
 * starts in; the worktree is the checkout at or above it.
 */
function checkWorkerBox(command: string, commands: string[][], { cwd, env }: { cwd: string | null; env: Env }): Finding | null {
  if (/\$'/.test(command)) return boxFinding("a worker can't use $'...' strings, which can spell any path; write the path plainly");
  if (/\$\{[^}]*@/.test(command)) return boxFinding("a worker can't use ${...@...} expansions, which can run or rename text; write the value plainly");
  if (/\$\{?OLDPWD\b/.test(command)) return boxFinding("a worker can't use $OLDPWD, which may be any folder; write the path plainly");
  if (commands.some((words) => words.some((word) => /^~([+-]?\d|-($|[\\/]))/.test(word)))) {
    return boxFinding("a worker can't use ~N, ~+N, ~-N or ~- (the directory stack); write the path plainly");
  }
  // Reads may name these; a command that does more than read may not.
  const pathWords = commands.filter((words) => !onlyReads(words)).flatMap((words) => words.map((word) => REDIRECT.exec(word)?.[1] ?? word));
  if (pathWords.some((word) => /^~[A-Za-z_]/.test(word.replace(/^[^=]*=/, '')))) {
    return boxFinding("a worker can't use ~name (another account's home); write the path plainly");
  }
  // These lead to a process's own folders, and the guard's process is not the shell's.
  if (pathWords.some((word) => /(^|[=/])(proc\/[^/]+\/(cwd|root|fd)|proc\/self|dev\/fd)(\/|$)/.test(word))) {
    return boxFinding("a worker can't use /proc/<id>/cwd, /proc/<id>/root, /proc/self or /dev/fd paths, which lead to another folder; write the path plainly");
  }
  const home = homeOf(env);
  const config = configFolder(env);
  // The box starts where the shell is: a shell already in or above the config folder has none.
  if (cwd !== null && config !== null && touchesConfig(resolve(cwd), configForms(config))) {
    return boxFinding("this shell is in or above yokoten's config folder (~/.config/yokoten); a worker works inside its worktree, so ask the lead to start you there");
  }
  const link = cwd === null ? null : gitLinkAbove(cwd);
  const box = cwd === null ? null : realPath(link ? link.top : cwd);
  let folder = cwd;
  const movesFolder = commands.some((words) => findPrograms(words).some((program) => FOLDER_MOVERS.has(programName(program))));
  // A cd in a subshell, a pipe or the background leaves the guard unsure where the next one starts.
  if (movesFolder && /[(){}`]|(^|[^|])\|(?!\|)|(^|[^&>])&(?![&>])/.test(withoutQuoted(command))) {
    return boxFinding("a worker's cd may not run in a subshell, a pipe or the background; run it on its own, joined with && or ;");
  }
  const forms = config === null ? [] : configForms(config);
  // A reader that follows symlinks, piped into xargs, could hand a config-folder path to a
  // writer the guard never sees spelled out.
  const hasXargs = commands.some((words) => words.some((word) => programName(word) === 'xargs'));
  const followsLinks = (words: string[]) => {
    const has = (name: string) => words.some((word) => programName(word) === name);
    if (has('find') && words.some((word) => /^-(H|L|follow)$/.test(word))) return true;
    if (['grep', 'egrep', 'fgrep', 'rg'].some(has) && words.some((word) => hasShortOption(word, 'R') || isLongOption(word, 'dereference-recursive'))) return true;
    return has('ls') && words.some((word) => hasShortOption(word, 'L'));
  };
  if (hasXargs && commands.some(followsLinks)) {
    return configFinding("a worker can't pipe a symlink-following read (find -L, grep -R, ls -L) into xargs: it could hand a writer a path inside yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept");
  }
  for (const words of commands) {
    const reach = configReach(words, { folder, home, forms });
    if (reach !== null) return reach;
    const setting = workerSettingAt(words, 0);
    if (setting !== null) return boxFinding(`a worker can't set ${setting.split('=')[0].replace(/\+$/, '')}: only ${[...WORKER_SETTINGS].join(', ')} may be set, so no setting moves a folder or runs a program`);
    for (const action of words.flatMap((word, at) => (FIND_ACTIONS.has(word) ? [at + 1] : []))) {
      const inner = workerSettingAt(words, action);
      if (inner !== null) return boxFinding(`a worker can't set ${inner.split('=')[0].replace(/\+$/, '')}: only ${[...WORKER_SETTINGS].join(', ')} may be set`);
    }
    let from = 0;
    for (const program of findPrograms(words)) {
      const at = words.indexOf(program, from);
      if (at === -1) continue;
      from = at + 1;
      const name = programName(program);
      const args = withoutShellRedirects(words, at + 1);
      if (FOLDER_MOVERS.has(name)) {
        // pushd and popd keep a stack of folders the guard does not follow; cd does the same job.
        if (name !== 'cd') return boxFinding(`a worker can't use ${name}, whose folder stack yokoten does not follow; run cd on its own`);
        if (args.some((arg) => /^-[LP]*P[LP]*$/.test(arg))) return boxFinding("a worker's cd may not use -P, which follows a link before a later ..; run cd without it");
        const paths = args.filter((arg) => !/^-L+$/.test(arg));
        const target = paths[0];
        if (paths.length !== 1 || target === '-' || target.startsWith('-') || !PLAIN_PATH.test(target) || target === '') {
          return boxFinding(`a worker's ${name} takes one plain path inside its worktree (letters, digits, . _ / - and a leading ~), not ${paths.join(' ') || 'no path'}`);
        }
        const expanded = target.startsWith('~') ? (home === null ? null : home + target.slice(1)) : target;
        const full = expanded === null ? null : isAbsolute(expanded) ? expanded : folder === null ? null : resolve(folder, expanded);
        const real = full === null ? null : realPath(full);
        if (real === null || box === null || (real !== box && !real.startsWith(box + sep))) {
          return boxFinding(`a worker's ${name} stays inside its worktree; ${target} is outside it, or yokoten can't tell where it goes`);
        }
        folder = full;
        continue;
      }
      if (isGit(program)) {
        let index = 0;
        while (GIT_PLAIN_OPTIONS.has(args[index] ?? '')) index++;
        if (args[index]?.startsWith('-')) return boxFinding(`a worker's git takes no ${args[index]} before the subcommand: it can move the folder git works in`);
        if (args.some((arg) => isLongOption(arg, 'output'))) return boxFinding('a worker\'s git may not write its output to a file (--output); print it instead');
        const sub = args[index];
        const rest = args.slice(index + 1);
        const isWrite = rest.some((arg) => GIT_CONFIG_WRITES.test(arg));
        // `git config user.name` with one name and no value reads it, as --get does.
        const isNameRead = plainArgs(rest).length === 1 && !rest.some((arg) => /^-/.test(arg) && !['--global', '--local', '--system', '--worktree', '--show-origin', '-z', '--null'].includes(arg));
        const isConfigRead = rest[0] === 'get' || rest[0] === 'list' || (!isWrite && (rest.some((arg) => GIT_CONFIG_READS.has(arg)) || isNameRead));
        if (sub === 'config' && !isConfigRead) return boxFinding('a worker\'s git config only reads (--get, --get-all, --list); the lead changes settings');
      }
      // Programs that set a variable named by a word, not by `NAME=`: the settings list can't see them.
      if (VARIABLE_SETTERS.has(name) || (name === 'printf' && args.some((arg) => hasShortOption(arg, 'v')))) {
        return boxFinding(`a worker can't run ${name}${name === 'printf' ? ' -v' : ''}, which can set any variable, git's and the shell's too; write values plainly`);
      }
      if (name === 'less' && args.some((arg) => arg.startsWith('+') || hasShortOption(arg, 'oO') || isLongOption(arg, 'log-file'))) {
        return boxFinding("a worker's less may not write a log file or run start-up commands (-o, -O, --log-file, +)");
      }
      if (name === 'file' && args.some((arg) => hasShortOption(arg, 'C') || isLongOption(arg, 'compile'))) return boxFinding("a worker's file may not compile a magic file (-C)");
      if (name === 'alias' && args.some((arg) => arg.includes('='))) return boxFinding("a worker can't define an alias, which can run any program under another name; run the program by its own name");
      if (folder !== null && forms.length && symlinkTargetReach(name, args, folder, home, forms)) {
        return configFinding(`a worker's ${name} may not make a link that leads into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`);
      }
      if (name === 'set' && args.some((arg, index) => /^[-+][A-Za-z]*P/.test(arg) || (args[index - 1] === '-o' && arg === 'physical'))) {
        return boxFinding("a worker can't turn on the shell's physical mode (set -P, set -o physical), where cd follows a link before a later ..");
      }
      if (name === 'hash' && args.some((arg) => hasShortOption(arg, 'p'))) return boxFinding("a worker can't run hash -p, which points a name at another program; run the program by its own path");
      if (name === 'enable' && args.some((arg) => arg.startsWith('-'))) return boxFinding('a worker can\'t turn a builtin on or off (enable with an option); run the program by its own name');
      if (['chmod', 'chown', 'chgrp'].includes(name) && args.some((arg) => hasShortOption(arg, 'LH') || isLongOption(arg, 'dereference'))) {
        return configFinding(`a worker's ${name} may not follow symlinks (-L, -H): a link can lead into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`);
      }
      if (name === 'find' && args.some((arg) => /^-(L|follow)$/.test(arg)) && args.some((arg) => FIND_WRITES.test(arg) || FIND_ACTIONS.has(arg))) {
        return configFinding("a worker's find that changes files or runs a program may not follow symlinks (-L, -follow): a link can lead into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept");
      }
    }
  }
  return null;
}

// ---- A worker's command aimed at the home config folder (#591) ----

// The home config folder by `~`, `$HOME` or `${HOME}`, a path that climbs out with `..`, or the worker list.
const POINTS_AT_CONFIG = /(~|\$HOME|\$\{HOME\})[/\\]+\.config(?=[/\\]|$|[\s;&|)`<>'"])|\.\.[/\\](?:[^\s'"`;&|<>]*[/\\])?\.config(?=[/\\]|$|[\s;&|)`<>'"])|yokoten[/\\]+workers/i;
// Programs that only read and run nothing else.
const PLAIN_READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'stat', 'file', 'grep', 'egrep', 'fgrep', 'rg', 'less', 'find', 'git', 'cd', 'pwd', 'echo', 'tr', 'true']);
const GIT_READS = new Set(['status', 'log', 'diff', 'show']);

/** Whether the text names the home config folder: as POINTS_AT_CONFIG, or by the home path itself. */
function namesHomeConfig(text: string, home: string | null): boolean {
  if (POINTS_AT_CONFIG.test(text)) return true;
  if (home === null) return false;
  const tidy = text.replace(/[/\\]+(\.[/\\]+)*/g, '/').toLowerCase();
  return tidy.includes(`${home.replace(/[/\\]+/g, '/').toLowerCase()}/.config`);
}

/**
 * Whether every program in `words` only reads: PLAIN_READERS, a find that runs and deletes
 * nothing, `rg` without `--pre`, and git with only status, log, diff or show; and the words
 * redirect into no file.
 */
function onlyReads(words: string[]): boolean {
  if (writesFile(words)) return false;
  for (const program of findPrograms(words)) {
    const name = programName(program);
    if (!PLAIN_READERS.has(name)) return false;
    const args = words.slice(words.indexOf(program) + 1);
    if (name === 'find' && args.some((arg) => FIND_WRITES.test(arg) || FIND_ACTIONS.has(arg))) return false;
    if (name === 'rg' && args.some((arg) => /^--pre(=|$)/.test(arg))) return false;
    if (name === 'git' && !GIT_READS.has(args.find((arg) => !GIT_PLAIN_OPTIONS.has(arg)) ?? '')) return false;
  }
  return true;
}

/**
 * The real path of `raw` (absolute, or relative to `base`) the way the kernel resolves it:
 * one component at a time, following each symlink before any later `..` is applied. Node's
 * resolve and realpathSync collapse `..` first, so `link/../x` would slip past the symlink.
 */
function kernelReal(raw: string, base: string | null): string {
  const seed = isAbsolute(raw) ? '' : base === null ? '' : realPath(base);
  let cur = '/';
  const seen = new Set<string>();
  for (const part of `${seed}/${raw}`.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    cur = cur === '/' ? `/${part}` : `${cur}/${part}`;
    try {
      if (lstatSync(cur).isSymbolicLink() && !seen.has(cur)) {
        seen.add(cur);
        const target = readlinkSync(cur);
        const to = isAbsolute(target) ? target : resolve(dirname(cur), target);
        try {
          cur = realpathSync(to);
        } catch {
          cur = to;
        }
      }
    } catch {
      // a part that is not on disk yet: keep walking by name.
    }
  }
  return cur;
}

// Folders a glob the guard expands never walks into, so it stays fast in a big repo.
const SKIP_IN_GLOB = (path: string) => /(^|[\\/])(node_modules|\.git)$/.test(path);

// A glob character in a path or one of its parts.
const HAS_GLOB = /[*?[\]{}]/;

/** Whether the real `path` is yokoten's config folder, is inside it, or holds it (case aside). */
function touchesConfigReal(path: string, forms: string[][]): boolean {
  const cand = path.split(/[\\/]+/).filter(Boolean);
  for (const config of forms) {
    const shared = Math.min(cand.length, config.length);
    let isMatch = shared > 0 || cand.length === config.length;
    for (let at = 0; at < shared && isMatch; at++) isMatch = cand[at].toLowerCase() === config[at].toLowerCase();
    if (isMatch) return true;
  }
  return false;
}

/**
 * Whether `cand` (a path string, maybe a glob) reaches yokoten's config folder, resolved the
 * way the kernel would (kernelReal), so a symlink the worktree holds, a `..` after it, or a
 * glob that matches it all count. A glob is expanded against `folder` (dotfiles as bash
 * leaves them): its literal start, its matches, and, when it matches nothing, its directory's
 * matches with the plain file name are each resolved.
 */
function reachesConfig(cand: string, folder: string | null, forms: string[][]): boolean {
  const touches = (raw: string) => touchesConfigReal(kernelReal(raw, folder), forms);
  if (!HAS_GLOB.test(cand)) return touches(cand);
  const parts = cand.split(/[\\/]+/);
  const firstGlob = parts.findIndex((part) => HAS_GLOB.test(part));
  const prefix = parts.slice(0, firstGlob).join('/');
  if (prefix && touches(prefix)) return true;
  const expand = (pattern: string) => {
    try {
      return { ok: true, matches: globSync(pattern, { ...(isAbsolute(cand) ? {} : { cwd: folder ?? '.' }), exclude: SKIP_IN_GLOB }) };
    } catch {
      return { ok: false, matches: [] as string[] }; // a glob the guard can't expand may reach the folder
    }
  };
  const direct = expand(cand);
  if (!direct.ok) return true;
  if (direct.matches.some((match) => touches(match))) return true;
  // A glob does not descend a symlinked folder, so when the last part is a glob the folder it
  // sits in is checked by its real path: a link to the config folder makes every name under
  // it count, matched or not.
  const base = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  if (dir && HAS_GLOB.test(base)) {
    const dirs = HAS_GLOB.test(dir) ? expand(dir) : { ok: true, matches: [dir] };
    if (!dirs.ok) return true;
    if (dirs.matches.some((match) => touches(match))) return true;
  }
  // A plain name under a globbed folder: resolve each matched folder with it, since a glob
  // does not descend a symlinked folder and the name may not be on disk yet.
  if (dir && HAS_GLOB.test(dir) && !HAS_GLOB.test(base)) {
    const dirs = expand(dir);
    if (!dirs.ok) return true;
    return dirs.matches.some((match) => touches(`${match}/${base}`));
  }
  return false;
}

/**
 * The path strings a worker's word may aim at, with `$PWD` read as `folder` and `~`, `$HOME`
 * and `~+` read too: a redirect target, a long option's `=value`, each suffix of an attached
 * short option (`-olink/workers`), an assignment's value, or the word itself. A value the
 * guard can't read (`$x`) or an unresolved `~` is left out.
 */
function pathCandidates(word: string, folder: string | null, home: string | null): string[] {
  const target = REDIRECT.exec(word)?.[1] ?? word;
  const out: string[] = [];
  // A part the guard can't read may be empty or any name, so the path is tried both ways:
  // with the part left out, and with the part as a glob.
  const add = (text: string) => {
    if (!text) return;
    const pwd = (value: string) => (folder === null ? value : value.replace(/^(\$PWD|\$\{PWD\})(?=[\\/]|$)/, folder));
    const read = (value: string) => withHomeRead(pwd(value), home, folder);
    // A `...` split across words (`echo link`/x) leaves a stray backtick: its side is unknown.
    const halves = (value: string) => (value.split('`').length % 2 === 0 ? value.replace(/^[^`]*`(?=[^`]*$)/, '$U').replace(/`[^`]*$/, '$U') : value);
    const unknown = (value: string) => value.replace(/\$\{?PWD\}?(?=[\\/]|$)/g, '\0').replace(UNKNOWN_PART, '').replace(/\0/g, '$PWD');
    for (const form of new Set([read(unknown(halves(text))), read(halves(text)).replace(UNKNOWN_PART, ANY_PART)])) {
      const expanded = form.replace(/\*\*+/g, '*'); // bash has no globstar unless it is set
      if (!expanded || /[$`]/.test(expanded) || expanded.startsWith('~') || (folder === null && !isAbsolute(expanded))) continue;
      out.push(expanded);
    }
  };
  if (target.startsWith('--')) {
    const eq = target.indexOf('=');
    if (eq !== -1) add(target.slice(eq + 1));
  } else if (target.startsWith('-')) {
    for (let at = 1; at < target.length; at++) add(target.slice(at));
  } else if (isAssignment(target)) {
    add(target.slice(target.indexOf('=') + 1));
  } else {
    add(target);
  }
  return out;
}

/**
 * For `ln -s` or `cp -s`: whether a link it makes would lead into yokoten's config folder. A
 * link's target is read from the folder the link sits in, so each target is resolved from the
 * last word and from its parent (the last word may be a folder or the link's own name), and
 * from a `-t` folder. A target the guard can't read counts.
 */
function symlinkTargetReach(name: string, args: string[], folder: string, home: string | null, forms: string[][]): boolean {
  const makesLinks = name === 'ln' ? args.some((arg) => hasShortOption(arg, 's') || isLongOption(arg, 'symbolic')) : name === 'cp' && args.some((arg) => hasShortOption(arg, 's') || isLongOption(arg, 'symbolic-link'));
  if (!makesLinks) return false;
  // -t and -S take a value, attached (-tdir) or next, alone or in a group (-st dir).
  const plain: string[] = [];
  const into: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--') {
      plain.push(...args.slice(at + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const isTarget = isLongOption(arg, 'target-directory');
      if (isTarget || isLongOption(arg, 'suffix')) {
        const value = eq === -1 ? (args[++at] ?? '') : arg.slice(eq + 1);
        if (isTarget) into.push(value);
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      const letter = [...arg.slice(1)].findIndex((char) => char === 't' || char === 'S');
      if (letter !== -1) {
        const rest = arg.slice(letter + 2);
        const value = rest || (args[++at] ?? '');
        if (arg[letter + 1] === 't') into.push(value);
      }
    } else plain.push(arg);
  }
  // With one plain word, the link is made in the current folder under the target's name.
  const targets = into.length || plain.length === 1 ? plain : plain.slice(0, -1);
  const bases = into.length ? into : plain.length === 1 ? ['.'] : plain.length ? [plain[plain.length - 1], dirname(plain[plain.length - 1])] : [];
  return targets.some((target) => {
    const read = withHomeRead(target.replace(/^(\$PWD|\$\{PWD\})(?=[\\/]|$)/, folder), home, folder);
    if (/[$`~*?[\]{}]/.test(read)) return true; // a target the guard can't read counts
    return bases.some((base) => touchesConfigReal(kernelReal(read, resolve(folder, base)), forms));
  });
}

// Options that make a writer walk into a folder (recursively): -r, -R, -a (archive), and
// rsync's -K, which writes through a linked folder.
const RECURSES = (args: string[]) => args.some((arg) => hasShortOption(arg, 'rRaK') || isLongOption(arg, 'recursive') || isLongOption(arg, 'archive') || isLongOption(arg, 'keep-dirlinks'));

/**
 * Whether the real folder `root` holds a symlink whose real path reaches yokoten's config
 * folder. It walks at most 6 folders deep and 5,000 entries, skips .git and node_modules, and
 * never follows a link while walking; past those limits it answers no.
 */
function holdsConfigLink(root: string, forms: string[][]): boolean {
  let left = 5000;
  const queue: [string, number][] = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift() as [string, number];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // not a readable folder: nothing to walk.
    }
    for (const entry of entries) {
      if (--left < 0) return false;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (touchesConfigReal(kernelReal(path, null), forms)) return true;
      } else if (entry.isDirectory() && depth < 6 && entry.name !== '.git' && entry.name !== 'node_modules') {
        queue.push([path, depth + 1]);
      }
    }
  }
  return false;
}

/**
 * For a worker: a word of a command that does more than read (see onlyReads) whose path is
 * yokoten's config folder, is in it, or holds it, by real path (#591). So a program that no
 * writer list knows (`gzip`, `sort -o`, `npm --prefix`, `git archive -o`) can't reach the
 * folder through a symlink in the worktree, `~+` or a glob. Each word counts, an option's
 * `=value` and a setting's value too. A part the guard can't read (`$x`) may be empty or
 * any name, so it counts when any name in its place reaches the folder. `folder` is where
 * the words run.
 */
function configReach(words: string[], { folder, home, forms }: { folder: string | null; home: string | null; forms: string[][] }): Finding | null {
  if (!forms.length || onlyReads(words)) return null;
  const names = (shown: string) =>
    `this command does more than read and works on ${shown}, which ${/[$\`]/.test(shown) ? 'may be or hold' : 'is or holds'} yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`;
  for (const word of words) {
    if (word.includes('\n')) continue;
    for (const cand of pathCandidates(word, folder, home)) {
      if (reachesConfig(cand, folder, forms)) return configFinding(names(REDIRECT.exec(word)?.[1] ?? word));
    }
  }
  // A recursive writer whose folder holds a symlink that leaves the worktree for the config folder.
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (PLAIN_READERS.has(programName(program))) continue;
    const args = withoutShellRedirects(words, at + 1);
    if (!RECURSES(args)) continue;
    for (const arg of plainArgs(args)) {
      if (/[$`]/.test(arg) || HAS_GLOB.test(arg) || arg.startsWith('~')) continue;
      if (holdsConfigLink(kernelReal(arg, folder), forms)) {
        return configFinding(`this command runs recursively in ${arg}, which holds a link into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`);
      }
    }
  }
  return null;
}

/**
 * For a worker: a command that names the home config folder (`~/.config`, `$HOME/.config`,
 * the home path, a `..` path) or the worker list, read case aside and with quotes and
 * backslashes taken off, unless each program in it is a plain reader: PLAIN_READERS, a find
 * that runs and deletes nothing, `rg` without `--pre`, and git with only status, log, diff
 * or show. One with a substitution or a file redirect never passes. A repo's own
 * `.config/` folder is not the home one, and passes.
 */
function checkWorkerPointers(command: string, commands: string[][], env: Env): Finding | null {
  const home = homeOf(env);
  const bare = command.replace(/['"\\]/g, '');
  if (![command, bare].some((text) => namesHomeConfig(text, home) || namesConfigFolder(text))) return null;
  const refusal = finding(
    'worker-mark',
    "a worker can't run commands that point at yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept, unless every program in it only reads",
    "run plain reads only there (cat, ls, grep, git status): only the lead changes the worker list and the bot's keys; if your task needs more, stop and tell the lead",
  );
  if (/\$\(|`|[<>]\(/.test(command)) return refusal;
  return commands.every(onlyReads) ? null : refusal;
}

/**
 * For a worker: an edit inside a git folder, or of the mark (#555), or null. `path` is
 * absolute. It is compared by real path too, so a symlink to a git folder counts; `folder` is
 * where the worker works, whose git folders count wherever they are. `env` finds yokoten's
 * config folder, where the worker list is kept (#591): an edit inside it counts too.
 */
export function checkWorkerMarkEdit(path: string, folder?: string, env: Env = {}): Finding | null {
  const what = 'this edit is inside a .git folder, where the worker mark is kept';
  const full = realPath(path);
  const config = configFolder(env);
  if (config !== null) {
    // Case aside, as in the command check: on macOS and Windows the names fold case.
    const edited = [full, resolve(path)].map((form) => form.toLowerCase());
    for (const base of new Set([resolve(config), realPath(config)].map((form) => form.toLowerCase()))) {
      if (edited.some((form) => form === base || form.startsWith(base + sep))) {
        return configFinding("this edit is inside yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept");
      }
    }
  }
  for (const form of [path, full]) {
    const parts = form.split(/[/\\]+/);
    if (parts.some((part) => part.toLowerCase() === '.git') || parts.at(-1)?.toLowerCase() === WORKER_MARK) return markFinding(what);
  }
  const dirs = folder === undefined ? [] : protectedGitDirs(folder);
  if (dirs.some((dir) => full === dir || full.startsWith(dir + sep))) return markFinding(what);
  return null;
}

/**
 * A worker's edit inside a team folder (#674): `<repo>.team/{agents,outbox,lead}`, next to a
 * checkout named `<repo>`. Outside a desk nothing else fences it, and an edit there would
 * speak for another agent. A desk's agent sends with `yokoten msg send`. Any other folder
 * whose name ends in `.team` is not a team folder.
 */
export function checkTeamEdit(path: string): Finding | null {
  for (const form of new Set([resolve(path), realPath(path)])) {
    const parts = form.split(sep);
    for (let at = 1; at + 1 < parts.length; at++) {
      const name = parts[at];
      if (!name.toLowerCase().endsWith('.team') || name.length <= '.team'.length || !TEAM_PARTS.has(parts[at + 1].toLowerCase())) continue;
      const checkout = [...parts.slice(0, at), name.slice(0, -'.team'.length), '.git'].join(sep) || sep;
      if (existsSync(checkout)) return finding('lead-only', 'this edit is inside a team folder (<repo>.team), where the agents\' messages and the roster are kept', 'send with `yokoten msg send <to> <text>` from a desk, or report to the lead');
    }
  }
  return null;
}

// The parts of a team folder (agents/desk/team/team.ts).
const TEAM_PARTS = new Set(['agents', 'outbox', 'lead']);

// Cancelling a run, an alias, and a command the host did not ship (#650). The host adapter
// owns the command names, the routes and the finding text. Both roles hear it before the
// worker's own send rule: the fix is to ask the owner, and the lead cannot do it either.

/** What a host adapter says about its own commands. The guard calls these and does not know the host. */
export interface HostCommands {
  hostRunRemoval(words: string[]): Finding | undefined;
  hostAlias(words: string[]): Finding | undefined;
  hostHiddenCommand(words: string[]): Finding | undefined;
  /** A gh command that prints its token (#668). */
  hostTokenReveal(words: string[]): Finding | undefined;
  /** A gh command that turns a workflow off (#668). */
  hostWorkflowOff(words: string[]): Finding | undefined;
}

/** The host adapter's checks, once it has loaded. Until then a `gh` command is refused, never let through. */
let hostCommands: HostCommands | undefined;

/** The host adapter registers its command checks, once: a second registration is refused. */
export function useHostCommands(commands: HostCommands): void {
  if (hostCommands && hostCommands !== commands) throw new Error('the host command checks are already registered');
  hostCommands = commands;
}

function hostRunRemoval(words: string[]): Finding | null {
  if (!hostCommands) {
    // A caller that never loaded src/host/gh-commands.ts must not turn the run rule off.
    return ghIndex(words, findProgramPlaces(words)) === -1 ? null : finding('run-remove', "the guard's GitHub command rules did not load, so it cannot read this `gh` command", 'start the session again; if it happens again, report it as a yokoten bug');
  }
  return hostCommands.hostRunRemoval(words) ?? null;
}

function hostAlias(words: string[]): Finding | null {
  return hostCommands?.hostAlias(words) ?? null;
}

function hostHiddenCommand(words: string[]): Finding | null {
  return hostCommands?.hostHiddenCommand(words) ?? null;
}

function hostTokenReveal(words: string[]): Finding | null {
  return hostCommands?.hostTokenReveal(words) ?? null;
}

function hostWorkflowOff(words: string[]): Finding | null {
  return hostCommands?.hostWorkflowOff(words) ?? null;
}

// ---- What a worker sends (#555) ----
//
// A worker commits in its worktree and reports; the lead reviews, then pushes and posts. So
// for a worker the guard refuses, past `git push`: `yokoten bot` in any form, `git send-pack`,
// `git subtree push`, an alias (`git config alias.*`, `git -c alias.*`), gh's pull request
// writes, and gh's `api` with a write method or fields. A GraphQL query that reads passes.

const SEND_FIX = 'commit in your worktree and report; the lead pushes after review';
const sends = (what: string) => finding('worker-push', what, SEND_FIX);
const YOKOTEN_CLI = /^yokoten(\.ts|\.js|\.mjs|\.cjs)?$/i;
// Programs that run another program's script or package: `node bin/yokoten.ts`, `npx yokoten`.
const SCRIPT_RUNNERS = new Set(['node', 'nodejs', 'npx', 'bunx', 'bun', 'deno', 'tsx', 'pnpm', 'pnpx', 'yarn', 'npm']);
const PR_WRITES = new Set(['create', 'merge', 'edit', 'close', 'comment', 'review', 'ready', 'reopen']);

/** For a worker: a command that pushes or posts for the lead, or null. */
function checkWorkerSends(words: string[]): Finding | null {
  const places = findProgramPlaces(words);
  let from = 0;
  for (const place of places) {
    // The program's own index. An `env -S` program has none, so the word is looked up.
    const at = place.index >= 0 ? place.index : words.indexOf(place.word, from);
    if (at < 0) continue;
    from = at + 1;
    const name = programName(place.word);
    const cli = YOKOTEN_CLI.test(name) ? at : SCRIPT_RUNNERS.has(name) ? words.findIndex((word, index) => index > at && YOKOTEN_CLI.test(programName(word))) : -1;
    if (cli !== -1 && words.slice(cli + 1).find((word) => !word.startsWith('-')) === 'bot') {
      return sends('`yokoten bot` runs a command as the bot, which pushes and posts for the lead');
    }
  }
  const at = ghIndex(words, places);
  if (at === -1) return null;
  const args = withoutShellRedirects(words, at + 1);
  const plain = plainArgs(args, ['-R', '--repo', '--hostname']);
  if (plain[0] === 'pr' && PR_WRITES.has(plain[1] ?? '')) return sends(`gh pr ${plain[1]} changes a pull request on the host`);
  if (plain[0] === 'api') return checkGhApi(args.slice(args.indexOf('api') + 1));
  return null;
}

/**
 * For a worker: `yokoten worker unmark`, which would clear its own worker mark (#566),
 * or null. The role is the session's own, set from its folders before the command runs,
 * so a `cd` away inside the command never evades it. Only the lead unmarks a worktree.
 */
function checkWorkerUnmark(words: string[]): Finding | null {
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    const name = programName(program);
    const cli = YOKOTEN_CLI.test(name) ? at : SCRIPT_RUNNERS.has(name) ? words.findIndex((word, index) => index > at && YOKOTEN_CLI.test(programName(word))) : -1;
    if (cli === -1) continue;
    const plain = plainArgs(withoutShellRedirects(words, cli + 1));
    if (plain[0] === 'worker' && plain[1] === 'unmark') {
      return finding('worker-mark', '`yokoten worker unmark` clears a worker mark, and only the lead unmarks a worktree', 'commit in your worktree and report; the lead unmarks after review, from its own checkout');
    }
    // A worker that marks the lead's checkout makes the lead a worker too (#672).
    if (plain[0] === 'worker' && plain[1] === 'mark') {
      return finding('worker-mark', '`yokoten worker mark` sets a worker mark, and only the lead marks a worktree or a clone', 'commit in your worktree and report; the lead marks checkouts, from its own');
    }
  }
  return null;
}

/** gh's `api`: a write method, or fields (gh then sends a POST), except a GraphQL query that reads. */
function checkGhApi(args: string[]): Finding | null {
  let method: string | undefined;
  let endpoint: string | undefined;
  const fields: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '-X' || word === '--method') method = args[++index] ?? '';
    else if (word.startsWith('--method=')) method = word.slice('--method='.length);
    else if (/^-X./.test(word)) method = word.slice(2);
    else if (['-f', '-F', '--field', '--raw-field'].includes(word)) fields.push(args[++index] ?? '');
    else if (/^--(raw-)?field=/.test(word)) fields.push(word.slice(word.indexOf('=') + 1));
    else if (/^-[fF]./.test(word)) fields.push(word.slice(2));
    else if (word === '--input' || word.startsWith('--input=')) {
      fields.push('@');
      if (word === '--input') index++;
    } else if (hostApiValues().has(word)) index++;
    else if (!word.startsWith('-') && endpoint === undefined) endpoint = word;
  }
  if (method !== undefined) return ['GET', 'HEAD'].includes(method.toUpperCase()) ? null : sends(`gh's \`api --method ${method}\` writes to the host`);
  if (!fields.length) return null;
  // A GraphQL read sends its query as a field. A mutation, or a query the guard can't read, counts.
  const isRead = endpoint === 'graphql' && fields.every((field) => field !== '@' && !(/^query=/.test(field) && /^query=[@$`]|\bmutation\b/i.test(field)));
  return isRead ? null : sends('`gh` `api` with fields sends a POST, which writes to the host');
}

// On macOS and Windows a file name is the same file in any case: `agents.md` is AGENTS.md.
const FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** Whether yokoten.json "leadOnly" matches the path, in any case where file names ignore it. */
export function isLeadOnly(path: string, leadOnly: string[], foldsCase = FOLDS_CASE): boolean {
  return matcher(leadOnly, { foldsCase })(path);
}

/**
 * Whether the lead lets this worker change a lead-only path: YOKOTEN_LEAD_ONLY_OK, a
 * comma-separated list of paths from the repo root, set when the worker starts. An entry
 * with a `*` is a glob, as in yokoten.json (`*` alone grants every lead-only file); any
 * other entry is that one path. `\` reads as `/`, a trailing `/` and a leading `./` are
 * dropped, and an empty entry counts for nothing.
 */
export function isGranted(path: string, env: Env, foldsCase = FOLDS_CASE): boolean {
  const entries = (env.YOKOTEN_LEAD_ONLY_OK ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const same = (entry: string) => (foldsCase ? entry.toLowerCase() === path.toLowerCase() : entry === path);
  return entries.some((entry) => (entry.includes('*') ? matcher([entry], { foldsCase })(path) : same(entry)));
}

/**
 * A shell command, as the agent wrote it. `config` brings the programs the project blocks
 * (yokoten.json "commands.block"); without it, only the core rules apply. `cwd` is the
 * folder the command runs in, null when it is not known: a change to core.hooksPath reads
 * that repo's setting and hooks. `titles` turns on the title check for gh issues and pull
 * requests: the hook sets it in a repo with a yokoten.json, never in the user-level hook,
 * since another project's titles follow its own rules. `repos` are the repos whose file rules
 * the hook applies to an edit (see `judge`): a worker's shell write is checked against the
 * same ones, and against a repo with a yokoten.json it finds above the file.
 */
export function checkCommand(command: string, options: { env: Env; config?: GuardConfig; cwd: string | null; titles?: boolean; repos?: RuledRepo[] }): Finding | null {
  // The reader is not a full parser. Whatever goes wrong inside it, the command is refused,
  // never let through: an error here must not open the guard.
  const outerAnswers = gitAnswers;
  try {
    gitAnswers = outerAnswers ?? new Map();
    const isWorker = options.env.YOKOTEN_ROLE === 'worker';
    // The file rules are looked up once per call, and only for a worker.
    const rules = isWorker ? fileRules(options.repos ?? []) : undefined;
    return withBudget(command.length, () => checkEachCommand(command, { ...options, rules }));
  } catch {
    return finding('unreadable-command', 'yokoten could not read this command', 'split it into simpler commands, one per call');
  } finally {
    gitAnswers = outerAnswers;
  }
}

// `cwd` is null when the guard cannot tell which repo git works in.
type GuardConfig = Pick<Config, 'commands'> & Partial<Pick<Config, 'privacy' | 'areas'>>;

/** A repo whose file rules apply, by its root, with its yokoten.json "leadOnly". */
export type RuledRepo = { root: string; leadOnly: string[] };

type EachOptions = { env: Env; config?: GuardConfig; cwd: string | null; titles?: boolean; rules?: FileRules };

function checkEachCommand(command: string, { env, config, cwd, titles = false, rules }: EachOptions): Finding | null {
  const commands = commandWords(command);
  // Where a gh command reads a relative body file: the folder, followed through each cd.
  let postCwd = cwd;
  // The same, with a bare relative `cd` read as written, not through CDPATH: where git most
  // likely runs, for the worker's config-folder check (#591).
  let nearCwd = cwd;
  // Where the line starts: a gh post after a cd keeps an allow only within this repo (#447).
  const from = cwd;
  // A command that moves to another folder or repo (`cd x && git config ...`, GIT_DIR=)
  // may change the hooks setting of a repo the guard does not look at.
  if (commands.some(movesRepo)) cwd = null;
  // What the rest of the command may do to a file gh reads (#439).
  const heredoc = heredocPost(command, commands);
  const writers = commands.filter((words) => !writesNoFile(words));
  // Anything but plain words may run code; after a cd, `..` goes up from the real folder.
  // A read-only pipe at the end is left out first (#498).
  const plainText = heredoc === undefined ? withoutStdin(withoutReadPipe(command), commands) : '';
  const plainAt = heredoc === undefined ? plainBreak(plainText) : -1;
  const fills = heredoc === undefined && (plainAt !== -1 || !tildesPlain(command, commands));
  const movesFolder = commands.some((words) => ['cd', 'pushd', 'popd'].includes(words[0] ?? ''));
  // The words have lost their quotes: a quote or \ next to any ~ makes a ~ folder unsure (#465).
  const isTildeQuoted = QUOTED_TILDE.test(command);
  // A download piped into a shell, eval, or a `$` program runs code nobody read (#560, #734, #745).
  const piped = checkPipeToShell(command);
  if (piped) return piped;
  const token = checkTokenUse(command, commands);
  if (token) return token;
  // Rules that refuse any form of a setting or a write (#361, #664). They answer after the
  // rest, which name the case more exactly; the first one found is kept.
  let later: Finding | null = null;
  for (const words of commands) {
    const mayWrite = heredoc !== undefined || fills || writesFile(words) || isUnsure(words) || writers.some((other) => other !== words);
    // The name is built only on a refusal (#498).
    const saw = (isMarked: (word: string) => boolean) => writeRisk(words, { heredoc, plainText, plainAt, fills, writers, isMarked });
    const reason =
      checkGit(words, { env, config, cwd, rules }) ??
      // Before the worker's own send rule: the fix is to ask the owner, and the lead cannot do it either (#650).
      hostRunRemoval(words) ??
      hostAlias(words) ??
      hostHiddenCommand(words) ??
      hostWorkflowOff(words) ??
      // A worker hears its own rule first: what it may not send, its own unmark, and the git folder (#555, #566).
      (env.YOKOTEN_ROLE === 'worker' ? (checkWorkerSends(words) ?? checkWorkerUnmark(words) ?? checkWorkerWrites(words, { folder: postCwd, near: nearCwd, command, env })) : null) ??
      // An alias runs another command under a new name: refused, not parsed (#560).
      // For a worker the worker rule already answers, with its own id.
      checkShellAlias(words, env) ??
      // Removing the .git folder throws away every commit (#560). A find that deletes
      // with nothing keeping it out of .git is the same loss (#573, #744). For a worker
      // the mark rule above already answers, with its own id.
      checkRemoveGit(words, postCwd, env) ??
      checkHooksEnvironment(words) ??
      checkPublish(words, env) ??
      checkBlocked(words, config?.commands.block ?? {}) ??
      checkPosted(words, { env, config, cwd: postCwd, from, command, titles, files: { heredoc, mayWrite, saw, movesFolder } }) ??
      (rules ? checkLeadOnlyWrites(words, { env, rules, folder: postCwd }) : null);
    if (reason) return reason;
    later ??=
      checkGitConfigEnvironment(words) ??
      // The likely folder, read as written: a write there is refused, never let through.
      checkGitSetupWrites(words, { folder: nearCwd, from, env }) ??
      // A changed home folder hides the private marks (#664).
      checkHomeSetting(words, env) ??
      // Git's own ways to lose uncommitted work, a stash, the reflog or the default branch
      // (#828). It answers last among the late rules, so a command that also points at the
      // config folder or sets the folder git works in keeps its own rule (#591).
      checkGitLoseWork(words, postCwd, env);
    postCwd = folderAfter(words, postCwd, { env, isTildeQuoted });
    nearCwd = folderAfter(words, nearCwd, { env, isTildeQuoted, isCdPathSkipped: true });
  }
  // A worker's changed home, before the box: the box would answer first and hide this fix (#739).
  const worker = env.YOKOTEN_ROLE === 'worker' ? (checkWorkerRealHome(commands) ?? checkWorkerBox(command, commands, { cwd: from, env }) ?? checkWorkerPointers(command, commands, env)) : null;
  return worker ?? later;
}

/**
 * What a release refusal tells the agent to do. `start` is the command that starts the agent
 * with the approval, when the caller knows the agent (#350): the hook passes it in. Without
 * one, as here, the message names no agent.
 */
export function releaseFix(start?: string): string {
  const session = start ? `a new session with ${start}` : 'a new session of their agent with YOKOTEN_RELEASE_APPROVAL=1';
  return `if the owner asked for this, they start ${session}; do not look for another way`;
}
const release = (what: string) => finding('release', what, releaseFix());

// `git tag` alone, `git tag -l` and `git tag --contains` only read. Deleting a local tag
// (`-d`) and verifying one (`-v`) publish nothing. Every other `git tag` writes a tag,
// which the owner alone creates (record 0028): `git push --follow-tags` would publish it.
const TAG_READ_FLAGS = new Set(['-l', '--list', '-d', '--delete', '-v', '--verify']);
// These choose what a listing matches, so git stays in listing mode after one.
const TAG_READ_OPTIONS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
// `--sort`, `--format` and `--column` only change how a listing prints. With a name,
// git still creates the tag, so they must not mark the command as a read (#873).
// `--sort` and `--format` take their value as the next word, or after `=`.
const TAG_VALUE_OPTIONS = new Set(['-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup', '--trailer', '--sort', '--format']);
// A combined short flag keeps its letters: `git tag -ln v1` lists, because `-n` only shapes
// the listing. A writing letter in the group (`-af`) still makes the command a write (#873).
const TAG_SHORT_GROUP = /^-[a-zA-Z]{2,}$/;
function isTagRead(arg: string): boolean {
  if (TAG_READ_FLAGS.has(arg) || /^-n\d*$/.test(arg)) return true;
  if (TAG_READ_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`))) return true;
  return TAG_SHORT_GROUP.test(arg) && /[ldv]/.test(arg.slice(1)) && !/[asf]/.test(arg.slice(1));
}
const TAG_WRITE_OPTIONS = new Set(['--annotate', '--sign', '--force']);

/** The name a `git tag` command creates, or null when its words name no tag. */
function tagNameOf(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    if (TAG_VALUE_OPTIONS.has(args[index])) index++;
    else if (!args[index].startsWith('-')) return args[index];
  }
  return null;
}

function createsTag(args: string[]): boolean {
  if (args.some(isTagRead)) return false;
  const isWriteFlag = args.some((arg) => TAG_WRITE_OPTIONS.has(arg) || /^-[a-zA-Z]*[asf]/.test(arg));
  return tagNameOf(args) !== null || isWriteFlag;
}

const MOVERS = new Set(['cd', 'pushd', 'popd']);
function movesRepo(words: string[]): boolean {
  // The options of an env or sudo are read once: an env word among them (`-/env`) would
  // read the same options again, to the same end.
  const readTo = { env: 0, sudo: 0 };
  for (const [index, word] of words.entries()) {
    if (/^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/.test(word) || word === '--worktree') return true;
    const name = programName(word);
    if ((name !== 'env' && name !== 'sudo') || index < readTo[name]) continue;
    const moved = changesFolder(name, words, index + 1);
    if (moved === true) return true;
    readTo[name] = moved;
  }
  return findPrograms(words).some((program) => MOVERS.has(programName(program)));
}

// `env -C dir`, `env --chdir=dir` (or cut short, `--ch`), `env -iC dir`, `sudo -D dir`,
// `sudo --chdir=dir`: the launcher runs its program elsewhere. Returns true, or the index
// after the launcher's options.
function changesFolder(name: 'env' | 'sudo', words: string[], index: number): true | number {
  const short = name === 'env' ? /^-[a-zA-RT-Z]*C/ : /^-[a-zA-Z]*D/;
  for (; index < words.length && words[index].startsWith('-'); index += LAUNCHERS[name].options.includes(words[index]) ? 2 : 1) {
    const long = /^--(c[a-z]*)(?:=|$)/.exec(words[index]);
    if ((long && 'chdir'.startsWith(long[1])) || short.test(words[index])) return true;
    if (name === 'env' && splitString(words, index) !== undefined) return index;
  }
  return index;
}

const base = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
const isGit = (word: string) => /(^|[/\\])git(\.exe)?$/.test(word);
// Git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source']);

// Each check looks for its program anywhere in the command, so a prefix such as FOO=1,
// sudo, env, command, exec, time, nice, nohup, timeout or xargs does not hide it.
function checkGit(words: string[], { env, config, cwd, rules }: { env: Env; config?: Pick<Config, 'commands'>; cwd: string | null; rules?: FileRules }): Finding | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  const settings: string[] = [];
  const fromEnvironment: string[] = []; // --config-env name=VARIABLE
  // The folder git works in: `-C` moves it. With --git-dir or --work-tree, the guard
  // does not know the repo, so it is null.
  let directory: string | null = cwd;
  let i = start + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C' && directory !== null) directory = resolve(directory, words[i + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(words[i])) directory = null;
    if (words[i] === '-c') settings.push(words[i + 1] ?? '');
    if (words[i] === '--config-env') fromEnvironment.push(words[i + 1] ?? '');
    if (words[i].startsWith('--config-env=')) fromEnvironment.push(words[i].slice('--config-env='.length));
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const argsAt = i + 1;
  const args = words.slice(argsAt);

  const hooks = checkHooksSettings(settings, fromEnvironment);
  if (hooks) return hooks;
  if (settings.some((s) => /^push\.followtags/i.test(s)) && !env.YOKOTEN_RELEASE_APPROVAL) {
    return release('git -c push.followTags pushes tags');
  }
  // `git -c alias.x=...` makes an alias, which can run another command under a new name:
  // refused, not parsed, so the guard never reads a hidden command as safe (#560). For a
  // worker the worker rule below still answers first, with its own id.
  const aliasSetting = [...settings, ...fromEnvironment].find((text) => /^alias\./i.test(text.trim()));
  if (aliasSetting && env.YOKOTEN_ROLE !== 'worker') {
    return aliasFinding(`git with \`${aliasSetting.split('=')[0].trim()}\` makes an alias, which can run another command under a new name`);
  }
  for (const s of settings) {
    const alias = /^alias\.[^=]*=!(.*)$/is.exec(s);
    const reason = alias && checkEachCommand(alias[1], { env, config, cwd, rules });
    if (reason) return reason;
  }
  if (env.YOKOTEN_ROLE === 'worker') {
    const reason = checkWorkerGit(words, { options: words.slice(start + 1, argsAt - 1), settings: [...settings, ...fromEnvironment], sub, args: withoutShellRedirects(words, argsAt) });
    if (reason) return reason;
  }
  if (sub === 'push') {
    if (!env.YOKOTEN_RELEASE_APPROVAL) {
      const tagFlag = args.find((a) => ['--tags', '--follow-tags', '--mirror'].includes(a));
      if (tagFlag) return release(`git push ${tagFlag} pushes tags`);
      const tagRef = args.find((a) => /(^|[:+])(refs\/tags\/|v\d)/.test(a));
      if (tagRef) return release(`git push ${args.join(' ')} pushes a release tag`);
    }
    const force = args.find((a) => a === '--force' || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'));
    if (force) return finding('force-push', `git push ${force} forces the push`, 'use --force-with-lease, which stops when the remote has work you have not seen');
    // A worker commits in its worktree; the lead reviews and pushes (#555).
    if (env.YOKOTEN_ROLE === 'worker') return sends('a worker does not push');
    const pushed = findPushedDeletes(withoutShellRedirects(words, argsAt));
    const gone = pushed?.find((name) => isDefaultBranch(name, directory, env));
    if (gone !== undefined) return deleteBranchFinding(`\`git push\` deletes the default branch \`${gone}\` on the remote`);
  }
  if (sub === 'tag' && !env.YOKOTEN_RELEASE_APPROVAL) {
    const tagArgs = withoutShellRedirects(words, argsAt);
    if (createsTag(tagArgs)) {
      const tag = tagNameOf(tagArgs);
      // Name the tag, as the branch's #828 message did; a form whose name the guard cannot
      // read still refuses, with the whole command as the word it names (#873).
      if (tag !== null) {
        return finding('release', `creating the tag ${tag}`, `if the owner asked for this, they run \`git tag ${quoteShellWord(tag)}\` themselves, or start a new session with YOKOTEN_RELEASE_APPROVAL=1; do not look for another way`);
      }
      return release(`git tag ${tagArgs.join(' ')} creates a tag`);
    }
  }
  if (sub === 'reset' && args.some((arg) => isGitLongOption(arg, '--hard'))) {
    return finding('hard-reset', 'git reset --hard throws away uncommitted work', 'commit or stash the work first; to undo a commit, use `git revert`');
  }
  if (sub === 'branch') {
    const names = findDeletedBranches(withoutShellRedirects(words, argsAt));
    const gone = names?.find((name) => isDefaultBranch(name, directory, env));
    if (gone !== undefined) return deleteBranchFinding(`\`git branch\` deletes the default branch \`${gone}\``);
  }
  if (sub === 'update-ref') {
    const ref = findDeletedRef(withoutShellRedirects(words, argsAt));
    if (ref !== null && isDefaultBranch(ref, directory, env)) return deleteBranchFinding(`\`git update-ref -d ${ref}\` deletes the default branch directly`);
  }
  const skip = args.includes('--no-verify') ? '--no-verify' : sub === 'commit' ? args.find((a) => /^-[a-z]*n[a-z]*$/i.test(a)) : undefined;
  if (skip) return finding('skip-check', `git ${sub} ${skip} skips the commit check`, 'fix what the check reports instead');
  if (sub === 'config') return checkConfig(withoutShellRedirects(words, argsAt), directory, env);
  return null;
}

/**
 * For a worker: git's ways to push, to make an alias that can hide a push, to work in another
 * git folder, and to change a worktree (#555), or null. `start` is git's word; `options` its
 * own options, before the subcommand.
 */
function checkWorkerGit(words: string[], { options, settings, sub, args }: { options: string[]; settings: string[]; sub: string | undefined; args: string[] }): Finding | null {
  if (words.some((word) => /^GIT_(DIR|COMMON_DIR)=/.test(word)) || options.some((word) => /^--git-dir(=|$)/.test(word))) {
    return markFinding('git with GIT_DIR or --git-dir works in another git folder, where the worker mark may be');
  }
  // Removing or moving its worktree removes a worker's mark, and a new one has none.
  if (sub === 'worktree' && args[0] !== 'list') return markFinding(`git worktree ${args[0] ?? ''} changes a worktree, which carries the worker mark`);
  if (sub === 'send-pack') return sends('git send-pack pushes');
  if (sub === 'subtree' && args.find((arg) => !arg.startsWith('-')) === 'push') return sends('git subtree push pushes');
  if (settings.some((setting) => /^alias\./i.test(setting.trim()))) return sends('git -c alias.* makes an alias, which can run a push under another name');
  if (sub === 'config' && args.some((arg) => /^alias\./i.test(arg)) && !args.some((arg) => CONFIG_READS.has(arg))) {
    return sends('git config alias.* sets an alias in the config every worktree shares, which can run a push under another name');
  }
  return null;
}

// ---- Commands that lose work (#560) ----
//
// An alias runs another command under a new name, removing .git throws away every
// commit, deleting the default branch throws away the line every branch builds on,
// and a download piped into a shell runs code nobody read. Each refusal names the
// safe way instead. For a worker the worker rules above still answer first.

const ALIAS_FIX = 'run the full command instead of making an alias, so the guard can check it';
const aliasFinding = (what: string) => finding('alias', what, ALIAS_FIX);

/** The `alias` program defines a shortcut, so a later command runs what the guard cannot see. For a worker the worker rule answers first, with its own id. */
function checkShellAlias(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_ROLE === 'worker') return null;
  const runs = findPrograms(words).some((program) => programName(program) === 'alias');
  return runs ? aliasFinding('`alias` defines a shortcut, so a later command runs what the guard cannot see') : null;
}

const REMOVE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'shred']);
const REMOVE_GIT_FIX = 'delete only the files you mean (a tracked file with `git rm <path>`); to start over, clone the repo again';

/** `rm` and friends on a path that can be `.git`, and a `find` that deletes with nothing keeping it out (#573, #744). For a worker the mark rule answers first. */
function checkRemoveGit(words: string[], cwd: string | null, env: Env): Finding | null {
  const home = homeOf(env);
  let from = 0;
  // A find's arguments run to the end of this command. The parse reads every find
  // nested in them. Parsing those again would re-read the tail once per find (#744).
  let coveredUntil = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (at < coveredUntil) continue;
    const name = programName(program);
    const args = withoutShellRedirects(words, at + 1);
    if (REMOVE_PROGRAMS.has(name)) {
      const targets = plainArgs(args);
      const target = targets.find((word) => word.split(PATH_BREAKS).filter(Boolean).some(mayBeDotGit));
      if (target !== undefined) {
        return finding('remove-git', `\`${name}\` would delete \`${target}\``, REMOVE_GIT_FIX);
      }
      // `.` is the checkout and `..` holds it: one word removes every file and every commit (#828).
      const whole = targets.find((word) => isCheckoutPath(word, cwd));
      if (whole !== undefined) {
        return finding('delete-checkout', `\`${name}\` on \`${whole}\` would delete the whole checkout, including every file and every commit`, DELETE_CHECKOUT_FIX);
      }
    }
    if (name === 'find') {
      if (findRemovesGit(args, cwd, home)) {
        return finding('remove-git', '`find` would delete files, and nothing keeps it out of `.git`', REMOVE_GIT_FIX);
      }
      coveredUntil = words.length;
    }
  }
  return null;
}

// ---- Git calls that throw work or history away (#828) ----
//
// Each call below loses work that has one copy only: the checkout or the folder that
// holds it, untracked files, uncommitted edits, a saved stash, the reflog that makes
// undo possible, or the commits of the default branch. Git reads any unique prefix of a
// long option (`--har` is `--hard`, `--del` is `--delete`), so the guard reads options
// the same way and refuses a form it cannot tell apart. These answer after the worker's
// own rules, so a worker that names its mark or the config folder hears that rule first.

const DELETE_CHECKOUT_FIX = 'delete only the files you mean, by name';
const DISCARD_WORK_FIX = 'keep the work first (`git stash` saves it), or commit it; do not throw it away';
const ERASE_HISTORY_FIX = 'leave the history as it is; if you need to roll back, ask the owner first';
const MOVE_BRANCH_FIX = 'leave the default branch where it is, and put the change on a new branch (`git switch -c <name>`)';
// The short options of checkout and switch that take a value, so `-bfoo` names a branch
// and holds no `-f` (#847).
const CHECKOUT_VALUE_SHORT = new Set(['b', 'B', 'c', 'C']);

/** Whether `word` is the long option `name` as git reads it: a unique prefix counts (`--har`, `--del`). */
function isGitLongOption(word: string, name: string): boolean {
  const given = word.split('=', 1)[0];
  return given.startsWith('--') && given.length > 2 && name.startsWith(given);
}

/**
 * The first short-option word in `args` that holds `flag`, or undefined. A combined word
 * keeps its letters, so `-qf` holds `-f` (#847). A letter in `valued` takes the rest of the
 * word as its value, so `-bfoo` names a branch and holds no `f`.
 */
function findShortFlag(args: string[], flag: string, valued: Set<string>): string | undefined {
  for (const word of args) {
    if (word === '--') break;
    if (word.startsWith('--') || !word.startsWith('-') || word === '-') continue;
    for (const letter of word.slice(1)) {
      if (letter === flag) return word;
      if (valued.has(letter)) break;
    }
  }
  return undefined;
}

/** A word a shell can run as it is: anything else goes inside single quotes. */
function quoteShellWord(word: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * Whether git's long option `name` is set to `value`, written `--name=value`, `--name value`,
 * or shortened. Git keeps the last value when an option is given twice, so the last one counts.
 */
function gitOptionIs(args: string[], name: string, value: string): boolean {
  let last: string | undefined;
  for (const [at, word] of args.entries()) {
    if (!isGitLongOption(word, name)) continue;
    last = word.includes('=') ? word.slice(word.indexOf('=') + 1) : args[at + 1];
  }
  return last === value;
}

/**
 * Whether `git clean` would only list what it means to remove. Git reads the words in order:
 * `-e <pattern>` (or `-e<pattern>`, also at the end of a cluster such as `-fde`) takes the
 * next word as a pattern, and the last of `--dry-run` and `--no-dry-run` decides. A value is
 * never a flag, so `git clean -fd -e --dry-run` deletes (#847).
 */
function isCleanDryRun(args: string[]): boolean {
  let isDryRun = false;
  for (let at = 0; at < args.length; at++) {
    const word = args[at];
    if (word === '--') break;
    if (word.startsWith('--')) {
      if (isGitLongOption(word, '--no-dry-run')) isDryRun = false;
      else if (isGitLongOption(word, '--dry-run')) isDryRun = true;
      // `--exclude=<pattern>` carries its value; a bare `--exclude` takes the next word.
      else if (isGitLongOption(word, '--exclude') && !word.includes('=')) at++;
      continue;
    }
    if (!word.startsWith('-') || word === '-') continue;
    const letters = word.slice(1);
    for (const [index, flag] of [...letters].entries()) {
      if (flag === 'e') {
        // `-e<pattern>` carries its value; a bare `-e` ends the word and takes the next one.
        if (index === letters.length - 1) at++;
        break;
      }
      if (flag === 'n') isDryRun = true;
    }
  }
  return isDryRun;
}

/**
 * Whether `path` is the folder the command runs in, or one that holds it: removing it removes
 * the checkout. `.` and `..` are read as the shell reads them, so `src/a/..` is `src`.
 */
function isCheckoutPath(path: string, cwd: string | null): boolean {
  if (cwd !== null) {
    const target = resolve(cwd, path);
    return target === cwd || cwd.startsWith(target.endsWith(sep) ? target : `${target}${sep}`);
  }
  // Without the folder, a path that still ends in `..` after its own parts cancel is as close
  // to the checkout as the guard can tell, so it answers the safe way.
  const parts = path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  return parts.length === 0 || parts[parts.length - 1] === '..';
}

/** The git call's subcommand and arguments, and the folder it works in (null when unknown). */
function readGitCall(words: string[], cwd: string | null): { sub: string; args: string[]; directory: string | null } | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  let directory = cwd;
  let at = start + 1;
  while (at < words.length && words[at].startsWith('-')) {
    if (words[at] === '-C' && directory !== null) directory = resolve(directory, words[at + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(words[at])) directory = null;
    at += GIT_VALUE_OPTIONS.has(words[at]) ? 2 : 1;
  }
  const sub = words[at];
  return sub === undefined ? null : { sub, args: withoutShellRedirects(words, at + 1), directory };
}

/** The ways a git call throws away work or history that exists in one place only (#828). */
function checkGitLoseWork(words: string[], cwd: string | null, env: Env): Finding | null {
  const call = readGitCall(words, cwd);
  if (call === null) return null;
  const { sub, args, directory } = call;
  // A plain word, in order, after the options. A path is not an option.
  const plain = plainArgs(args);

  // Untracked files have no other copy. A dry run removes nothing, so it passes.
  if (sub === 'clean' && !isCleanDryRun(args)) {
    return finding('discard-work', '`git clean` deletes every file you have not committed, and no other copy of them exists', DISCARD_WORK_FIX);
  }

  // A whole-tree checkout or restore throws away every uncommitted edit. `restore --staged`
  // alone only unstages, which is the way back from `git add`, so it passes.
  if (sub === 'checkout' || sub === 'switch' || sub === 'restore') {
    const stagedOnly = sub === 'restore'
      && args.some((arg) => isGitLongOption(arg, '--staged') || /^-[A-Za-z]*S[A-Za-z]*$/.test(arg))
      && !args.some((arg) => isGitLongOption(arg, '--worktree') || /^-[A-Za-z]*W[A-Za-z]*$/.test(arg));
    // A forced checkout or switch writes over uncommitted edits, whichever revision it names.
    // With a path after `--`, it writes over that path alone (#847).
    const forceFlag = (sub === 'checkout' || sub === 'switch')
      ? findShortFlag(args, 'f', CHECKOUT_VALUE_SHORT)
        ?? args.find((arg) => isGitLongOption(arg, '--force') || isGitLongOption(arg, '--discard-changes'))
      : undefined;
    if (forceFlag !== undefined) {
      const separator = args.indexOf('--');
      const paths = separator < 0 ? [] : args.slice(separator + 1).filter((word) => word !== '');
      if (paths.length > 0) {
        return finding('discard-work', `\`git ${sub} ${forceFlag} -- ${paths.join(' ')}\` writes over the uncommitted edits in ${paths.map((path) => `\`${path}\``).join(', ')}`, DISCARD_WORK_FIX);
      }
      return finding('discard-work', `\`git ${sub} ${forceFlag}\` writes over every uncommitted edit in the checkout`, DISCARD_WORK_FIX);
    }
    const whole = plain.find((word) => word === ':/' || isCheckoutPath(word, directory));
    if (whole !== undefined && !stagedOnly) {
      return finding('discard-work', `\`git ${sub} ${whole}\` throws away every uncommitted edit in the checkout`, DISCARD_WORK_FIX);
    }
  }

  // A saved stash is the guard's own way back before a reset. Clearing or dropping it removes that.
  if (sub === 'stash' && (plain[0] === 'clear' || plain[0] === 'drop')) {
    return finding('discard-work', `\`git stash ${plain[0]}\` destroys saved work that has no other copy`, DISCARD_WORK_FIX);
  }

  // Erasing unreachable commits and the reflog takes away the usual way back. Git reads
  // `--prune=all` and `--expire=all` as "now" too, and keeps the last of two values.
  const erases = (sub === 'gc' && (gitOptionIs(args, '--prune', 'now') || gitOptionIs(args, '--prune', 'all')))
    || (sub === 'prune' && (gitOptionIs(args, '--expire', 'now') || gitOptionIs(args, '--expire', 'all')))
    || (sub === 'reflog' && (plain[0] === 'expire' || plain[0] === 'delete'))
    || sub === 'filter-branch'
    || sub === 'filter-repo';
  if (erases) {
    return finding('erase-history', `\`git ${sub}\` erases the history at once, and the old commits are the usual way back`, ERASE_HISTORY_FIX);
  }

  // Moving the default branch back drops the commits every other branch builds on.
  if (sub === 'update-ref') {
    const reads = args.some((arg) => arg === '-l' || isGitLongOption(arg, '--verify') || isGitLongOption(arg, '--list'));
    const stdin = args.some((arg) => isGitLongOption(arg, '--stdin'));
    const ref = reads ? undefined : stdin ? '--stdin' : plain[0];
    if (ref !== undefined && (ref === '--stdin' || isDefaultBranch(ref, directory, env))) {
      return finding('move-default-branch', stdin ? '`git update-ref --stdin` writes refs the guard cannot read, and can move the default branch' : `\`git update-ref ${ref}\` moves the default branch`, MOVE_BRANCH_FIX);
    }
  }
  if (sub === 'branch' && args.some((arg) => /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || isGitLongOption(arg, '--force'))) {
    const name = plain[0];
    if (name !== undefined && isDefaultBranch(name, directory, env)) {
      return finding('move-default-branch', `\`git branch -f ${name}\` moves the default branch`, MOVE_BRANCH_FIX);
    }
  }
  if (sub === 'checkout' || sub === 'switch') {
    const forced = sub === 'checkout'
      ? args.some((arg) => /^-[A-Za-z]*B[A-Za-z]*$/.test(arg))
      : args.some((arg) => /^-[A-Za-z]*C[A-Za-z]*$/.test(arg) || isGitLongOption(arg, '--force-create'));
    const name = plain[0];
    if (forced && name !== undefined && isDefaultBranch(name, directory, env)) {
      return finding('move-default-branch', `\`git ${sub}\` moves the default branch \`${name}\``, MOVE_BRANCH_FIX);
    }
  }
  return null;
}

// ---- A find that deletes, and .git (#744) ----
//
// `find . -delete` and `find . -exec rm` walk into `.git` and remove the history.
// The guard refuses that unless something keeps the walk out: a prune of `.git`,
// an exclusion such as `-not -path '*/.git/*'`, or a start folder that cannot hold
// this repo's `.git` (`find dist -delete`). No test, or only tests that can match
// `.git`, is refused. A name or path whose characters name git storage (`objects`,
// `refs`, `*.idx`) but match no sample is refused too: the guard reads those
// characters, not the glob grammar. When the guard cannot tell, it refuses.
//
// `-delete` turns depth on, and GNU find then refuses to run a prune at all, so the
// prune form deletes nothing. An explicit `-depth` or `-d` is different: prune stops
// working and the other branch can wipe `.git`. The guard treats only that explicit
// depth as turning prune off.

/** One node of a find expression. */
type FindNode =
  | { kind: 'or' | 'and' | 'comma'; left: FindNode; right: FindNode }
  | { kind: 'not'; inner: FindNode }
  | { kind: 'name' | 'path'; pattern: string }
  | { kind: 'regex' }
  | { kind: 'type'; letters: string }
  | { kind: 'unknown' }
  | { kind: 'prune' }
  | { kind: 'harm'; recursive: boolean }
  | { kind: 'pass' }
  | { kind: 'fail' }
  | { kind: 'exec'; harms: boolean; recursive: boolean };

/** What a node does to one file find would visit. `isTrue` is null when the guard cannot tell. */
interface FindEffect {
  isTrue: boolean | null;
  harms: boolean;
  recursive: boolean;
  prunes: boolean;
  selects: boolean;
}

/** A parsed find: its starts, its expression, and whether the actions can delete. */
interface FindParsed {
  ok: boolean;
  starts: string[];
  node: FindNode;
  forcesDepth: boolean;
  harms: boolean;
  unsure: boolean;
  targetsGit: boolean;
  maxDepth: number | null;
  minDepth: number | null;
  pathPatterns: string[];
  /** Finds run by `-exec` and its kin. Each is parsed once, inside this walk (#744). */
  innerFinds: FindParsed[];
}

/** One sample under `.git`, as find would print it. */
interface GitProbe {
  path: string;
  base: string;
  depth: number;
  isDir: boolean;
  isGitDir: boolean;
}

/** Where a start sits relative to this repo's `.git`. */
type GitHold = 'no' | 'unsure' | { root: string };

const FIND_GLOBAL_VALUES = new Set(['-maxdepth', '-mindepth', '-regextype']);
const FIND_DEPTH_OPTIONS = new Set(['-depth', '-d']);
const FIND_PRINTS = new Set(['-print', '-print0', '-ls', '-quit']);
const FIND_FILE_ACTIONS = new Set(['-fprint', '-fprint0', '-fls']);
const FIND_OR = new Set(['-o', '-or']);
const FIND_AND = new Set(['-a', '-and']);
// Files and folders a real checkout keeps. A test that matches one can reach the history.
// The loose object (empty blob, two hex characters then the rest), the pack index and
// the other refs are samples too: a pattern can name them without writing `.git`.
const GIT_FILE_TAILS = [
  'HEAD', 'config', 'index', 'packed-refs', 'COMMIT_EDITMSG', 'description',
  'objects/pack/pack-1.pack', 'objects/pack/pack-1.idx', 'objects/e6/9de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  'refs/heads/main', 'refs/heads/master', 'refs/tags/sample-tag', 'refs/remotes/origin/HEAD',
  'hooks/pre-commit', 'logs/HEAD', 'info/exclude', 'worktrees/wt/HEAD',
];
const GIT_DIR_TAILS = [
  '', 'objects', 'objects/pack', 'objects/e6', 'refs', 'refs/heads', 'refs/tags',
  'refs/remotes', 'refs/remotes/origin', 'hooks', 'logs', 'info', 'worktrees', 'worktrees/wt',
];
// Words under `.git` that a pattern can name without matching a sample (`refs/heads/develop`).
// Exact file names the samples already cover (`config`, `index`) stay off this list.
const GIT_STORAGE_PARTS = new Set(['objects', 'refs', 'hooks', 'logs', 'pack', 'worktrees', 'heads', 'tags', 'remotes', 'origin']);
// Pack side files. `.idx` is the index; the rest sit beside the pack.
const GIT_STORAGE_SUFFIXES = ['.idx', '.pack', '.rev', '.bitmap', '.keep', '.mtimes', '.promisor'];

/** Whether a find that deletes can remove this repo's history. A parse the guard cannot finish refuses only when the line looks like a delete. */
function findRemovesGit(args: string[], cwd: string | null, home: string | null): boolean {
  let parsed: FindParsed;
  try {
    parsed = parseFindArgs(args, 'history');
  } catch {
    return looksLikeGitDelete(args);
  }
  return findParsedRemoves(parsed, args, cwd, home);
}

/** Whether this parsed find, or a find it runs, can remove the history. */
function findParsedRemoves(parsed: FindParsed, args: string[], cwd: string | null, home: string | null): boolean {
  if (!parsed.ok) return looksLikeGitDelete(args);
  if (parsed.targetsGit) return true;
  for (const inner of parsed.innerFinds) {
    if (findParsedRemoves(inner, args, cwd, home)) return true;
  }
  if (parsed.unsure) return startMayHold(parsed.starts, cwd, home);
  if (!parsed.harms) return false;
  return expressionSpares(parsed, cwd, home, 'history') !== true;
}

/**
 * Whether a find that writes keeps every git file, and the worker mark, out of its
 * actions. True only when the guard is sure. Callers use it to stand down, never to
 * add a refusal (`find . -fprint out` stays refused).
 */
function findSparesGitTree(args: string[], cwd: string, home: string | null): boolean {
  try {
    const parsed = parseFindArgs(args, 'tree');
    if (!parsed.ok || parsed.targetsGit || parsed.unsure || !parsed.harms) return false;
    return expressionSpares(parsed, cwd, home, 'tree') === true;
  } catch {
    return false;
  }
}

/** Whether any start may contain this repo's `.git`. An unreadable start counts. */
function startMayHold(starts: string[], cwd: string | null, home: string | null): boolean {
  for (const start of starts) {
    if (gitHold(start, cwd, home) !== 'no') return true;
  }
  return false;
}

/** Whether the expression leaves every sample under `.git` unharmed. Null when it cannot tell. */
function expressionSpares(parsed: FindParsed, cwd: string | null, home: string | null, mode: 'history' | 'tree'): boolean | null {
  for (const start of parsed.starts) {
    const hold = gitHold(start, cwd, home);
    if (hold === 'unsure') return null;
    if (hold === 'no') continue;
    const probes = gitProbes(hold.root, start, mode);
    if (hasUnsampledGitPath(parsed, probes)) return null;
    if (probesHarmed(parsed, probes)) return false;
  }
  return true;
}

/** The `.git` of the checkout that holds `cwd`, or null when there is none. A broken one is unsure. */
function repoGitDir(cwd: string): string | 'unsure' | null {
  const link = gitLinkAbove(cwd);
  if (link === null) return null;
  if (link.kind === 'broken') return 'unsure';
  return link.gitDir;
}

/**
 * The printed path of this repo's `.git` when `start`'s walk includes it, `no` when
 * the walk cannot reach it (`dist`, `src`), and `unsure` when the path cannot be read.
 * A start that names `.git` itself (`find .git`, `find src/.git`) always holds that folder.
 */
function gitHold(start: string, cwd: string | null, home: string | null): GitHold {
  const expanded = withHomeRead(start, home, cwd);
  if (/[$`~]/.test(expanded)) return 'unsure';
  // A glob the shell expands (`l*`, `*`) names children, and a child is not this repo's
  // `.git`. A component that can be `.git`, or a glob the guard cannot place, stays unsure.
  if (/[*?[{]/.test(expanded)) {
    const globParts = expanded.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
    if (isAbsolute(expanded) || globParts.includes('..') || globParts.some((part) => mayBeDotGit(part))) return 'unsure';
    return globParts.length > 0 ? 'no' : 'unsure';
  }
  const parts = expanded.split(/[\\/]+/);
  const gitAt = parts.findIndex((part) => part === '.git');
  if (gitAt !== -1) {
    const root = parts.slice(0, gitAt + 1).join('/');
    return { root: root || '.git' };
  }
  const meaningful = parts.filter((part) => part !== '' && part !== '.');
  const isHere = meaningful.length === 0;
  if (!isHere && !isAbsolute(expanded) && !meaningful.includes('..')) return 'no';
  if (cwd === null) return 'unsure';
  const gitDir = repoGitDir(cwd);
  if (gitDir === null) return 'no';
  if (gitDir === 'unsure') return 'unsure';
  const startAbs = resolve(cwd, expanded);
  const reaches = startAbs === gitDir || isInsidePath(gitDir, startAbs) || isInsidePath(startAbs, gitDir);
  if (!reaches) return 'no';
  return { root: printedGit(expanded, startAbs, gitDir) };
}

/** Whether `inner` is strictly inside `outer`. The filesystem root holds every path. */
function isInsidePath(inner: string, outer: string): boolean {
  if (outer === sep) return inner.startsWith(sep) && inner.length > sep.length;
  const prefix = outer.endsWith(sep) ? outer : outer + sep;
  return inner.startsWith(prefix);
}

/** The path find prints for the git folder, from the start text the user wrote. */
function printedGit(start: string, startAbs: string, gitDir: string): string {
  const prefix = start.replace(/\/+$/, '') || '.';
  if (startAbs === gitDir || isInsidePath(startAbs, gitDir)) {
    const inside = relative(gitDir, startAbs).split(sep).join('/');
    if (inside === '') return prefix;
    const suffix = `/${inside}`;
    return prefix.endsWith(suffix) ? prefix.slice(0, -suffix.length) : prefix;
  }
  const relativeGit = relative(startAbs, gitDir).split(sep).join('/');
  if (prefix === '.') return relativeGit === '.git' ? './.git' : `./${relativeGit}`;
  return `${prefix}/${relativeGit}`;
}

/** Samples of the git folder find would visit from `start`, plus the worker mark in tree mode. */
function gitProbes(root: string, start: string, mode: 'history' | 'tree'): GitProbe[] {
  const tails = [
    ...GIT_DIR_TAILS.map((tail) => ({ tail, isDir: true, isGitDir: tail === '' })),
    ...GIT_FILE_TAILS.map((tail) => ({ tail, isDir: false, isGitDir: false })),
    ...(mode === 'tree' ? [WORKER_MARK, `worktrees/wt/${WORKER_MARK}`].map((tail) => ({ tail, isDir: false, isGitDir: false })) : []),
  ];
  return tails.map(({ tail, isDir, isGitDir }) => {
    const path = tail === '' ? root : `${root}/${tail}`;
    const slash = tail.lastIndexOf('/');
    const base = tail === '' ? '.git' : tail.slice(slash + 1);
    return { path, base, depth: depthBelow(start, path), isDir, isGitDir };
  });
}

/** How many steps `printed` sits below the starting point find was given. */
function depthBelow(start: string, printed: string): number {
  const prefix = start.replace(/\/+$/, '') || '.';
  if (prefix === '.') {
    const body = printed.startsWith('./') ? printed.slice(2) : printed;
    if (body === '' || body === '.') return 0;
    return body.split('/').filter(Boolean).length;
  }
  if (printed === prefix) return 0;
  const lead = `${prefix}/`;
  if (printed.startsWith(lead)) return printed.slice(lead.length).split('/').filter(Boolean).length;
  return printed.split('/').filter(Boolean).length;
}

/** A `-name` or `-path` test that selects a delete. */
interface HarmPattern {
  kind: 'name' | 'path';
  pattern: string;
}

/**
 * Whether a pattern can reach git storage the samples do not cover, so the guard cannot tell.
 * A `-path` that names `.git` and matches nothing is refused, prune or not.
 * A delete whose characters name storage (`objects`, `*.idx`) but match no sample is refused
 * too, unless a prune keeps the walk out or no interior sample is visited.
 */
function hasUnsampledGitPath(parsed: FindParsed, probes: GitProbe[]): boolean {
  for (const pattern of parsed.pathPatterns) {
    const namesDotGit = /[$`]/.test(pattern) || pattern.split(/[\\/]+/).some((part) => mayBeDotGit(part));
    if (!namesDotGit) continue;
    if (!probes.some((probe) => findGlobMatches(pattern, probe.path))) return true;
  }
  if (gitDirPruned(parsed, probes) || !interiorVisited(parsed, probes)) return false;
  for (const item of harmPatterns(parsed.node)) {
    if (!namesGitStorage(item.pattern)) continue;
    const read = (probe: GitProbe) => (item.kind === 'name' ? probe.base : probe.path);
    if (!probes.some((probe) => findGlobMatches(item.pattern, read(probe)))) return true;
  }
  return false;
}

/** Whether the git folder itself is pruned, so the walk never enters it. An explicit depth turns prune off. */
function gitDirPruned(parsed: FindParsed, probes: GitProbe[]): boolean {
  const gitDir = probes.find((probe) => probe.isGitDir);
  if (!gitDir || parsed.forcesDepth || !probeIsVisited(gitDir, parsed)) return false;
  return evalFind(parsed.node, gitDir).prunes;
}

/** Whether any sample inside the git folder is visited. A shallow `-maxdepth` visits none. */
function interiorVisited(parsed: FindParsed, probes: GitProbe[]): boolean {
  return probes.some((probe) => !probe.isGitDir && probeIsVisited(probe, parsed));
}

/** Whether `pattern`'s own characters name git storage. A safe suffix (`.log`, `.ts`) does not. */
function namesGitStorage(pattern: string): boolean {
  if (/[$`]/.test(pattern)) return true;
  return pattern.split(/[\\/]+/).filter(Boolean).some((part) => partNamesGitStorage(part));
}

/**
 * One path component. A dotted tail that is not a git ending allows the name.
 * `?`, a class, a brace, or a star inside the word is grammar, so the guard cannot tell.
 */
function partNamesGitStorage(part: string): boolean {
  const lower = part.toLowerCase();
  const tail = /[^*?[\]{}\\]+$/.exec(lower)?.[0] ?? '';
  if (tail.includes('.') && !GIT_STORAGE_SUFFIXES.some((suffix) => tail.endsWith(suffix))) return false;
  if (/[?[{}]/.test(lower)) return true;
  const core = lower.replace(/^\*+/, '').replace(/\*+$/, '');
  if (core.includes('*')) return true;
  if (core === '') return false;
  if (GIT_STORAGE_PARTS.has(core)) return true;
  return GIT_STORAGE_SUFFIXES.some((suffix) => core.endsWith(suffix));
}

/** Name and path tests that sit on a delete, so they choose what is removed. A negated test excludes. */
function harmPatterns(node: FindNode): HarmPattern[] {
  switch (node.kind) {
    case 'and': {
      const found = [...harmPatterns(node.left), ...harmPatterns(node.right)];
      if (nodeHarms(node.right)) found.push(...testPatterns(node.left, false));
      if (nodeHarms(node.left)) found.push(...testPatterns(node.right, false));
      return found;
    }
    case 'or':
    case 'comma':
      return [...harmPatterns(node.left), ...harmPatterns(node.right)];
    case 'not':
      return harmPatterns(node.inner);
    default:
      return [];
  }
}

/** Name and path tests in `node`. `isNegated` drops a test that only excludes. */
function testPatterns(node: FindNode, isNegated: boolean): HarmPattern[] {
  switch (node.kind) {
    case 'name':
    case 'path':
      return isNegated ? [] : [{ kind: node.kind, pattern: node.pattern }];
    case 'and':
    case 'or':
    case 'comma':
      return [...testPatterns(node.left, isNegated), ...testPatterns(node.right, isNegated)];
    case 'not':
      return testPatterns(node.inner, !isNegated);
    default:
      return [];
  }
}

/** Whether `node` deletes a file it selects. */
function nodeHarms(node: FindNode): boolean {
  switch (node.kind) {
    case 'harm':
      return true;
    case 'exec':
      return node.harms;
    case 'and':
    case 'or':
    case 'comma':
      return nodeHarms(node.left) || nodeHarms(node.right);
    case 'not':
      return nodeHarms(node.inner);
    default:
      return false;
  }
}

/** find's `*` matches a leading dot and a slash. A pattern the guard cannot read counts as a match. */
function findGlobMatches(pattern: string, text: string): boolean {
  if (/[$`]/.test(pattern)) return true;
  // globMatches compares a lower-case name, so `HEAD` matches `HEAD`.
  return globMatches(`_${pattern}`, `_${text.toLowerCase()}`);
}

/** Whether any sample is deleted, or the git folder itself is selected or removed recursively. */
function probesHarmed(parsed: FindParsed, probes: GitProbe[]): boolean {
  const gitDir = probes.find((probe) => probe.isGitDir);
  let skipInterior = false;
  if (gitDir && probeIsVisited(gitDir, parsed) && evalFind(parsed.node, gitDir).prunes && !parsed.forcesDepth) skipInterior = true;
  if (!skipInterior) {
    for (const probe of probes) {
      if (probe.isGitDir || !probeIsVisited(probe, parsed)) continue;
      if (evalFind(parsed.node, probe).harms) return true;
    }
  }
  if (!gitDir || !probeIsVisited(gitDir, parsed)) return false;
  const effect = evalFind(parsed.node, gitDir);
  // A plain `-delete` of the folder, with its contents spared, cannot remove a non-empty `.git`.
  return effect.harms && (effect.recursive || effect.selects);
}

/** Whether find visits `probe` under `-maxdepth` and `-mindepth`. */
function probeIsVisited(probe: GitProbe, parsed: FindParsed): boolean {
  if (parsed.minDepth !== null && probe.depth < parsed.minDepth) return false;
  if (parsed.maxDepth !== null && probe.depth > parsed.maxDepth) return false;
  return true;
}

/** What `node` does to `probe`. AND and OR follow find's short-circuit; an unknown side still runs the other. */
function evalFind(node: FindNode, probe: GitProbe): FindEffect {
  switch (node.kind) {
    case 'pass':
      return { isTrue: true, harms: false, recursive: false, prunes: false, selects: false };
    case 'fail':
      return { isTrue: false, harms: false, recursive: false, prunes: false, selects: false };
    case 'prune':
      return { isTrue: true, harms: false, recursive: false, prunes: true, selects: false };
    case 'harm':
      return { isTrue: null, harms: true, recursive: node.recursive, prunes: false, selects: false };
    case 'exec':
      return { isTrue: null, harms: node.harms, recursive: node.recursive, prunes: false, selects: false };
    case 'unknown':
      return { isTrue: null, harms: false, recursive: false, prunes: false, selects: false };
    case 'regex':
      return { isTrue: null, harms: false, recursive: false, prunes: false, selects: true };
    case 'name':
    case 'path': {
      const matched = findGlobMatches(node.pattern, node.kind === 'name' ? probe.base : probe.path);
      return { isTrue: matched, harms: false, recursive: false, prunes: false, selects: matched };
    }
    case 'type': {
      const letter = probe.isDir ? 'd' : 'f';
      const known = node.letters.length > 0 && [...node.letters].every((item) => 'bcdpfls'.includes(item));
      if (!known) return { isTrue: null, harms: false, recursive: false, prunes: false, selects: false };
      const matched = node.letters.includes(letter);
      return { isTrue: matched, harms: false, recursive: false, prunes: false, selects: matched };
    }
    case 'not': {
      const inner = evalFind(node.inner, probe);
      return { ...inner, isTrue: inner.isTrue === null ? null : !inner.isTrue };
    }
    case 'and':
      return evalJoin(node, probe, false);
    case 'or':
      return evalJoin(node, probe, true);
    case 'comma': {
      const left = evalFind(node.left, probe);
      const right = evalFind(node.right, probe);
      return combineEffects(left, right, right.isTrue);
    }
  }
}

/** AND (`keep`) or OR. A side known to decide the result is not run; an unknown side is. */
function evalJoin(node: { left: FindNode; right: FindNode }, probe: GitProbe, isOr: boolean): FindEffect {
  const left = evalFind(node.left, probe);
  if (left.isTrue === isOr) return left;
  const right = evalFind(node.right, probe);
  if (left.isTrue === !isOr) return combineEffects(left, right, right.isTrue);
  const isTrue = right.isTrue === isOr ? isOr : null;
  return combineEffects(left, right, isTrue);
}

/** The two sides of one operator, as one effect. `isTrue` is the value find keeps. */
function combineEffects(left: FindEffect, right: FindEffect, isTrue: boolean | null): FindEffect {
  return {
    isTrue,
    harms: left.harms || right.harms,
    recursive: (left.harms && left.recursive) || (right.harms && right.recursive),
    prunes: left.prunes || right.prunes,
    selects: left.selects || right.selects,
  };
}

interface FindCursor { at: number }

/** One empty parse, before any word is read. */
function blankFindParsed(): FindParsed {
  return {
    ok: true, starts: [], node: { kind: 'pass' }, forcesDepth: false, harms: false, unsure: false, targetsGit: false, maxDepth: null, minDepth: null, pathPatterns: [], innerFinds: [],
  };
}

/** The find expression in `args`, or `ok: false` when a word does not fit. */
function parseFindArgs(args: string[], mode: 'history' | 'tree'): FindParsed {
  const parsed = blankFindParsed();
  const cursor: FindCursor = { at: 0 };
  const node = readFind(args, cursor, parsed, mode);
  if (!parsed.ok || node === null || cursor.at !== args.length) parsed.ok = false;
  else parsed.node = node;
  return parsed;
}

/**
 * The find at `cursor`, through its expression. A nested find stops before the
 * `-exec` terminator that belongs to the find which runs it.
 */
function readFind(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  while (cursor.at < args.length && parsed.ok) {
    const word = args[cursor.at];
    if (FIND_LEAD_OPTIONS.test(word)) cursor.at++;
    else if (word === '-D') cursor.at += 2;
    else if (FIND_GLOBAL_VALUES.has(word)) takeGlobal(args, cursor, parsed);
    else if (FIND_DEPTH_OPTIONS.has(word)) {
      parsed.forcesDepth = true;
      cursor.at++;
    } else break;
  }
  while (cursor.at < args.length && !isExprWord(args[cursor.at]) && !isActionTerminator(args, cursor.at)) parsed.starts.push(args[cursor.at++]);
  if (parsed.starts.length === 0) parsed.starts.push('.');
  if (!parsed.ok) return null;
  if (cursor.at >= args.length || isActionTerminator(args, cursor.at)) return parsed.node;
  const node = parseComma(args, cursor, parsed, mode);
  if (!parsed.ok || node === null) return null;
  parsed.node = node;
  return node;
}

/** A find run by `-exec`, parsed in place. `ok` is false when its words do not end on the terminator. */
function parseNestedFind(args: string[], cursor: FindCursor, mode: 'history' | 'tree'): FindParsed {
  const inner = blankFindParsed();
  const node = readFind(args, cursor, inner, mode);
  if (!inner.ok || node === null) {
    inner.ok = false;
    return inner;
  }
  inner.node = node;
  if (!isAtActionEnd(args, cursor.at)) inner.ok = false;
  return inner;
}

/** Whether `word` begins a test or an action, not a start folder. */
function isExprWord(word: string): boolean {
  return word.startsWith('-') || word === '(' || word === ')' || word === '!' || word === ',';
}

/** `-maxdepth`, `-mindepth` and `-regextype`, before the paths or inside the expression. */
function takeGlobal(args: string[], cursor: FindCursor, parsed: FindParsed): void {
  const option = args[cursor.at];
  const value = args[cursor.at + 1];
  if (value === undefined) {
    parsed.ok = false;
    return;
  }
  cursor.at += 2;
  if (option === '-regextype') return;
  if (!/^\d+$/.test(value)) {
    parsed.ok = false;
    return;
  }
  const depth = Number(value);
  // Two limits: assume the one that visits more, so a delete is not let through.
  if (option === '-maxdepth') parsed.maxDepth = parsed.maxDepth === null ? depth : Math.max(parsed.maxDepth, depth);
  else parsed.minDepth = parsed.minDepth === null ? depth : Math.min(parsed.minDepth, depth);
}

/** Comma, the weakest join: both sides run, and the right side's truth is kept. */
function parseComma(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  return parseJoined(args, cursor, parsed, mode, parseOr, (word) => word === ',');
}

/** OR. `-o` and `-or` bind less tightly than AND. */
function parseOr(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  return parseJoined(args, cursor, parsed, mode, parseAnd, (word) => FIND_OR.has(word));
}

/** AND, written or implicit between two tests. */
function parseAnd(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  let left = parseNot(args, cursor, parsed, mode);
  while (parsed.ok && left !== null && cursor.at < args.length) {
    const word = args[cursor.at];
    if (FIND_AND.has(word)) cursor.at++;
    else if (!startsPrimary(word)) break;
    const before = cursor.at;
    const right = parseNot(args, cursor, parsed, mode);
    if (!parsed.ok || right === null) return null;
    if (cursor.at === before) {
      parsed.ok = false;
      return null;
    }
    left = { kind: 'and', left, right };
  }
  return left;
}

/**
 * A chain of one join. `lower` parses the tighter level, `isJoin` the operator.
 * The kind is comma, or, or whatever `lower` already built for AND.
 */
function parseJoined(
  args: string[],
  cursor: FindCursor,
  parsed: FindParsed,
  mode: 'history' | 'tree',
  lower: (args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree') => FindNode | null,
  isJoin: (word: string) => boolean,
): FindNode | null {
  let left = lower(args, cursor, parsed, mode);
  while (parsed.ok && left !== null && cursor.at < args.length && isJoin(args[cursor.at])) {
    const kind = args[cursor.at] === ',' ? 'comma' : 'or';
    cursor.at++;
    const right = lower(args, cursor, parsed, mode);
    if (right === null) return null;
    left = { kind, left, right };
  }
  return left;
}

/** `!` and `-not`, tighter than AND. */
function parseNot(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  if (!parsed.ok || cursor.at >= args.length) return null;
  const word = args[cursor.at];
  if (word !== '!' && word !== '-not') return parsePrimary(args, cursor, parsed, mode);
  cursor.at++;
  const inner = parseNot(args, cursor, parsed, mode);
  return inner === null ? null : { kind: 'not', inner };
}

/** Whether the next word can start a test, so AND is implicit. */
function startsPrimary(word: string | undefined): boolean {
  if (word === undefined || word === ')' || word === ',' || FIND_OR.has(word) || FIND_AND.has(word)) return false;
  return word === '(' || word === '!' || word === '-not' || word.startsWith('-');
}

/** One test, action, or parenthesised group. */
function parsePrimary(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  if (!parsed.ok || cursor.at >= args.length) return null;
  const word = args[cursor.at];
  if (word === '(') {
    cursor.at++;
    const inner = parseComma(args, cursor, parsed, mode);
    if (inner === null || args[cursor.at] !== ')') {
      parsed.ok = false;
      return null;
    }
    cursor.at++;
    return inner;
  }
  if (FIND_ACTIONS.has(word)) return parseExec(args, cursor, parsed, mode);
  if (word === '-delete') {
    cursor.at++;
    parsed.harms = true;
    return { kind: 'harm', recursive: false };
  }
  if (word === '-prune') {
    cursor.at++;
    return { kind: 'prune' };
  }
  if (FIND_DEPTH_OPTIONS.has(word)) {
    cursor.at++;
    parsed.forcesDepth = true;
    return { kind: 'pass' };
  }
  if (FIND_GLOBAL_VALUES.has(word)) {
    takeGlobal(args, cursor, parsed);
    return parsed.ok ? { kind: 'pass' } : null;
  }
  if (FIND_PRINTS.has(word) || word === '-true') {
    cursor.at++;
    return { kind: 'pass' };
  }
  if (word === '-false') {
    cursor.at++;
    return { kind: 'fail' };
  }
  if (FIND_NAME_TESTS.has(word) || word === '-lname' || word === '-ilname') return parsePattern(args, cursor, parsed, 'name', word === '-lname' || word === '-ilname');
  if (word === '-path' || word === '-ipath' || word === '-wholename' || word === '-iwholename') return parsePattern(args, cursor, parsed, 'path', false);
  if (word === '-regex' || word === '-iregex') return parsePattern(args, cursor, parsed, 'regex', false);
  if (word === '-type' || word === '-xtype') return parseType(args, cursor, parsed, word === '-xtype');
  if (FIND_FILE_ACTIONS.has(word) || word === '-fprintf') return parseFileAction(args, cursor, parsed, mode, word === '-fprintf' ? 2 : 1);
  if (!word.startsWith('-')) {
    parsed.ok = false;
    return null;
  }
  // A test the guard does not know. Take a following value so the next test still lines up.
  cursor.at++;
  const next = args[cursor.at];
  if (next !== undefined && !next.startsWith('-') && next !== '(' && next !== ')' && next !== ',' && next !== '!') cursor.at++;
  return { kind: 'unknown' };
}

/** `-name` or `-path` and its pattern. A symlink-target test (`-lname`) stays unknown. */
function parsePattern(args: string[], cursor: FindCursor, parsed: FindParsed, kind: 'name' | 'path' | 'regex', isUnknown: boolean): FindNode | null {
  const pattern = args[cursor.at + 1];
  if (pattern === undefined) {
    parsed.ok = false;
    return null;
  }
  cursor.at += 2;
  if (kind === 'regex') return { kind: 'regex' };
  if (kind === 'path') parsed.pathPatterns.push(pattern);
  if (isUnknown) return { kind: 'unknown' };
  return { kind, pattern };
}

/** `-type` and its letter. `-xtype` follows symlinks, which the guard does not. */
function parseType(args: string[], cursor: FindCursor, parsed: FindParsed, isUnknown: boolean): FindNode | null {
  const letters = args[cursor.at + 1];
  if (letters === undefined) {
    parsed.ok = false;
    return null;
  }
  cursor.at += 2;
  return isUnknown ? { kind: 'unknown' } : { kind: 'type', letters };
}

/** `-fprint` and its kin. In tree mode they count as a write, so the mark rule does not stand down. */
function parseFileAction(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree', values: number): FindNode | null {
  if (cursor.at + values >= args.length) {
    parsed.ok = false;
    return null;
  }
  cursor.at += 1 + values;
  if (mode === 'history') return { kind: 'pass' };
  parsed.harms = true;
  return { kind: 'harm', recursive: false };
}

/** The command after `-exec` and its kin, up to `;` or `{} +`, with nested finds kept whole. */
function parseExec(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  cursor.at++;
  const findAt = indexOfLaunchedFind(args, cursor.at);
  if (findAt !== -1) {
    // The program is find. Parse it in this walk. A chain of `find -exec find`
    // is then one read, not a fresh read of the tail for every find (#744).
    cursor.at = findAt + 1;
    const inner = parseNestedFind(args, cursor, mode);
    if (!inner.ok) {
      parsed.ok = false;
      return null;
    }
    parsed.innerFinds.push(inner);
    if (cursor.at < args.length) cursor.at++;
    return { kind: 'exec', harms: false, recursive: false };
  }
  const command = readAction(args, cursor);
  if (command === null) {
    parsed.ok = false;
    return null;
  }
  const removal = execEffect(command, mode);
  if (removal.unsure) parsed.unsure = true;
  if (removal.targetsGit) parsed.targetsGit = true;
  if (removal.harmsMatch) parsed.harms = true;
  return { kind: 'exec', harms: removal.harmsMatch, recursive: removal.recursive };
}

/** Whether `words[index]` ends an `-exec` action: `;`, or `+` right after `{}`. */
function isActionTerminator(words: string[], index: number): boolean {
  const word = words[index];
  return word === ';' || (word === '+' && words[index - 1] === '{}');
}

/** Whether the action's command is over: no words left, or the terminator is next. */
function isAtActionEnd(words: string[], index: number): boolean {
  return index >= words.length || isActionTerminator(words, index);
}

/**
 * The index of `find` when the action at `start` is launchers and then `find`.
 * `-1` when the program is anything else, so the ordinary action reader runs.
 */
function indexOfLaunchedFind(args: string[], start: number): number {
  let index = start;
  while (index < args.length && !isActionTerminator(args, index)) {
    const name = programName(args[index]);
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(args[index + 1] ?? '')) return -1;
    if (!Object.hasOwn(LAUNCHERS, name)) return name === 'find' ? index : -1;
    const launcher = LAUNCHERS[name];
    index++;
    while (index < args.length && !isActionTerminator(args, index) && args[index].startsWith('-')) {
      index += launcher.options.includes(args[index]) ? 2 : 1;
    }
    const operands = launcher.operands ?? 0;
    for (let count = 0; count < operands && index < args.length && !isActionTerminator(args, index); count++) index++;
  }
  return -1;
}

/** The words of one find action. Null when the terminator is missing. Inner actions keep theirs. */
function readAction(words: string[], cursor: FindCursor): string[] | null {
  const command: string[] = [];
  let nested = 0;
  while (cursor.at < words.length) {
    const word = words[cursor.at];
    if (FIND_ACTIONS.has(word)) {
      nested++;
      command.push(word);
      cursor.at++;
      continue;
    }
    const closes = isActionTerminator(words, cursor.at);
    if (closes && nested > 0) {
      nested--;
      command.push(word);
      cursor.at++;
      continue;
    }
    if (closes) {
      cursor.at++;
      return command;
    }
    command.push(word);
    cursor.at++;
  }
  // The shell's own `;` already ended the command, so the action runs to here.
  return nested === 0 ? command : null;
}

/** What an `-exec` command removes. A writer or a shell harms the tree even when it is not `rm`. */
interface Removal {
  harmsMatch: boolean;
  recursive: boolean;
  unsure: boolean;
  targetsGit: boolean;
}

/** An empty removal: the command deletes nothing the guard can see. */
function blankRemoval(): Removal {
  return { harmsMatch: false, recursive: false, unsure: false, targetsGit: false };
}

/** Fold `extra` into `result`. */
function mergeRemoval(result: Removal, extra: Removal): void {
  result.harmsMatch ||= extra.harmsMatch;
  result.recursive ||= extra.recursive;
  result.unsure ||= extra.unsure;
  result.targetsGit ||= extra.targetsGit;
}

/** `command`'s removal, plus, in tree mode, any writer or shell it runs. */
function execEffect(command: string[], mode: 'history' | 'tree'): Removal {
  const removal = commandRemoval(command, 0);
  if (mode !== 'tree' || removal.harmsMatch) return removal;
  const writes = findProgramPlaces(command).some((place) => {
    const name = programName(place.word);
    return Object.hasOwn(WRITERS, name) || MARK_WRITERS.has(name) || RUNS_CODE.test(name);
  });
  if (writes) removal.harmsMatch = true;
  return removal;
}

/** Whether `words` runs `rm` on the file find is visiting, or on a path that can be `.git`. */
function commandRemoval(words: string[], depth: number): Removal {
  const result = blankRemoval();
  if (depth > 4) {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
    return result;
  }
  const places = findProgramPlaces(words);
  if (places.length === 0 && words.some((word) => /[$`]/.test(word))) {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
    return result;
  }
  for (const place of places) {
    const name = programName(place.word);
    if (/[$`]/.test(name)) {
      result.unsure = true;
      result.harmsMatch = true;
      result.recursive = true;
      continue;
    }
    if (REMOVE_PROGRAMS.has(name)) mergeRemoval(result, rmRemoval(words, place.index));
    else if (isShell(place.word) || Object.hasOwn(RUNNERS, name)) mergeRemoval(result, shellRemoval(words, place.index, depth));
  }
  return result;
}

/** `rm` at `index`: a match operand deletes the file find visits; a `.git` operand is named outright. */
function rmRemoval(words: string[], index: number): Removal {
  const result = blankRemoval();
  const name = programName(words[index] ?? '');
  const args = words.slice(index + 1);
  const recursive = name === 'rm' && rmIsRecursive(args);
  const valued = name === 'shred' ? ['-n', '--iterations', '-s', '--size'] : [];
  for (const operand of plainArgs(args, valued)) {
    if (operand.split(PATH_BREAKS).filter(Boolean).some(mayBeDotGit)) result.targetsGit = true;
    if (operand.includes('{}') || /[$`*?[{]/.test(operand)) {
      result.harmsMatch = true;
      if (recursive) result.recursive = true;
    }
  }
  return result;
}

/** Whether `rm`'s options descend into folders (`-r`, `-R`, `--recursive`). */
function rmIsRecursive(args: string[]): boolean {
  for (const word of args) {
    if (word === '--') break;
    if (word === '--recursive') return true;
    if (word.startsWith('--')) continue;
    if (/^-[^-]*[rR]/.test(word)) return true;
  }
  return false;
}

/** A shell or a runner at `index`. A script the guard can read is checked; anything else may run `rm`. */
function shellRemoval(words: string[], index: number, depth: number): Removal {
  const result = blankRemoval();
  const script = isShell(words[index] ?? '') ? shellScript(words, index) : runString(words, index);
  if (script === null || script === '') {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
    return result;
  }
  // A script with no removal and no substitution cannot touch `.git`.
  if (!/[$`]/.test(script) && !/(?:^|[^A-Za-z0-9_])(rm|rmdir|unlink|shred)(?:$|[^A-Za-z0-9_])/.test(script)) return result;
  try {
    for (const command of commandWords(script)) mergeRemoval(result, commandRemoval(command, depth + 1));
  } catch {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
  }
  return result;
}

/** The script after a shell's `-c`, or null when the shell reads a file or its input instead. */
function shellScript(words: string[], index: number): string | null {
  let at = index + 1;
  while (at < words.length && words[at].startsWith('-') && !/^-[a-zA-Z]*c/.test(words[at])) {
    if (words[at] === '--') return null;
    at++;
  }
  const flag = words[at];
  if (flag === undefined) return null;
  const cluster = /^-[a-zA-Z]*c(.*)$/s.exec(flag);
  if (!cluster) return null;
  return cluster[1] || (words[at + 1] ?? '');
}

/** Whether a find the parser could not read still looks like a delete, so the guard refuses it. */
function looksLikeGitDelete(args: string[]): boolean {
  if (args.includes('-delete')) return true;
  for (let index = 0; index < args.length; index++) {
    if (!FIND_ACTIONS.has(args[index])) continue;
    const cursor: FindCursor = { at: index + 1 };
    const command = readAction(args, cursor);
    const removal = commandRemoval(command ?? args.slice(index + 1), 0);
    if (removal.harmsMatch || removal.targetsGit || removal.unsure) return true;
    // No terminator, and nothing here removes: not this rule (`find . -exec env` repeated).
    if (command === null) return false;
    index = cursor.at - 1;
  }
  return false;
}

const DELETE_BRANCH_FIX = 'delete only the branch you mean (`git branch -d <branch>`), and leave the default branch alone';
const deleteBranchFinding = (what: string) => finding('delete-default-branch', what, DELETE_BRANCH_FIX);

/** The branches a `git branch -d`, `-D` or `--delete` (or a shortened `--del`) removes, or null when it removes none. */
function findDeletedBranches(args: string[]): string[] | null {
  const deletes = args.some((arg) => isGitLongOption(arg, '--delete') || (/^-[A-Za-z]+$/.test(arg) && /[dD]/.test(arg)));
  return deletes ? plainArgs(args) : null;
}

/** The branches a `git push --delete` (or `-d`, or a shortened `--del`) or `git push <remote> :<branch>` deletes, or null. */
function findPushedDeletes(args: string[]): string[] | null {
  if (args.includes('-d') || args.some((arg) => isGitLongOption(arg, '--delete'))) return plainArgs(args).map((name) => name.replace(/^:/, ''));
  const colon = plainArgs(args).filter((name) => name.startsWith(':')).map((name) => name.slice(1));
  return colon.length > 0 ? colon : null;
}

/** The ref a `git update-ref -d <ref>` deletes, or null. */
function findDeletedRef(args: string[]): string | null {
  if (!args.includes('-d')) return null;
  const refs = plainArgs(args, ['-m', '--message']);
  return refs.length > 0 ? refs[0] : null;
}

/**
 * The default branch: what refs/remotes/origin/HEAD names, else main and master.
 */
function readDefaultBranches(dir: string | null, env: Env): Set<string> {
  if (dir !== null) {
    const head = readGit(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD'], env);
    const branch = head === null ? undefined : /^refs\/remotes\/[^/]+\/(.+)$/.exec(head)?.[1];
    if (branch) return new Set([branch]);
  }
  return new Set(['main', 'master']);
}

/** Whether `name` is the default branch, as a bare name or under refs/heads/. */
function isDefaultBranch(name: string, dir: string | null, env: Env): boolean {
  const branches = readDefaultBranches(dir, env);
  const short = name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name;
  return branches.has(name) || branches.has(short);
}

const PIPE_SHELL_FIX = 'save it first (`curl -fsSL <url> -o <file>`), read it, then run it (`sh <file>`)';
// A download written to a pipe: curl and wget, plus wget2, aria2c and fetch (#574).
const DOWNLOAD_PROGRAMS = new Set(['curl', 'wget', 'wget2', 'aria2c', 'fetch']);

/** A pipeline that feeds a download into a shell, `eval`, or a program word that is not plain text runs code nobody read (#560, #574, #734, #745). */
function checkPipeToShell(command: string): Finding | null {
  for (const pipeline of splitPipelines(command)) {
    const segments = splitPipeSegments(pipeline);
    if (segments.length < 2) continue;
    // The first download in the segments so far: one pass, so a long pipeline reads in
    // linear time. A shell in the first segment has nothing before it, so it passes.
    let downloader: string | undefined;
    let downloadUrl: string | undefined;
    for (const segment of segments) {
      const commands = commandWords(segment);
      const programs = commands.flatMap(findPrograms).map(programName);
      const shell = findPipeShell(programs, commands, segment);
      if (shell !== undefined && downloader !== undefined) {
        const download = downloadUrl === undefined ? 'a download' : `the download ${downloadUrl}`;
        return finding('pipe-to-shell', `\`${downloader} | ${shell}\` runs ${download} without letting you read it first`, PIPE_SHELL_FIX);
      }
      if (downloader === undefined) {
        const program = programs.find((name) => DOWNLOAD_PROGRAMS.has(name.toLowerCase()));
        if (program !== undefined) {
          downloader = program;
          downloadUrl = /(?:https?|ftp):\/\/[^\s'"|;)]+/.exec(segment)?.[0];
        }
      }
    }
  }
  return null;
}

/**
 * The program that would run this segment as a shell.
 * A `$(…)`, backticks or `<(…)` inherits the pipe, so the nested command can run the download (#734).
 * A program word that is not plain text can become a shell too, so it is refused (#745).
 */
function findPipeShell(programs: string[], commands: string[][], segment: string): string | undefined {
  const first = programs[0];
  if (first !== undefined && isPipeShell(first)) return first;
  // `sudo -s` reads stdin wherever it sits, including inside a substitution.
  for (const words of commands) {
    const runner = findShellRunner(words);
    if (runner !== undefined) return runner;
  }
  const substitutions = scanSubstitutions(segment);
  if (substitutions.live) {
    // `bash -c "$(cat)"`: `$(cat)` is read first, so the shell is not the first program.
    const nested = programs.find((program) => isPipeShell(program));
    if (nested !== undefined) return nested;
    // `$x`, or a substitution that never closes, may be a shell. The guard cannot tell, so it refuses.
    const hidden = programs.find(isHiddenProgram);
    if (hidden !== undefined) return hidden;
    if (substitutions.unclosed) return 'sh';
  }
  // No shell name was written out. A prefix or a `$` name can still expand into one.
  return findUnplainProgram(commands);
}

/** A program whose name is still a `$` value or a substitution, so it may be a shell. */
const isHiddenProgram = (name: string) => name.startsWith('$') || name.includes('`') || name.includes('<(') || name.includes('>(');

// After a download, a program word may hold only these characters. The guard allows
// characters and does not read the shell's grammar: `s$(echo h)`, `$sh` and `sh*` are
// not plain, so they are refused, and so is `eval` with any argument (#734, #745).
const PLAIN_PROGRAM = /^[A-Za-z0-9._/-]+$/;
// The inside of `$((1+2))`. commandWords lists it as its own command. It is math, not a program.
const ARITHMETIC_BODY = /\$\(\(([0-9]+(?:[+\-*/%][0-9]+)*)\)\)/g;

/** Program words `$((…))` lists beside the real command, such as `1+2` from `echo $((1+2))`. */
function findArithmeticBodies(commands: string[][]): Set<string> {
  const bodies = new Set<string>();
  for (const words of commands) {
    for (const word of words) {
      spend(word.length);
      ARITHMETIC_BODY.lastIndex = 0;
      for (let match = ARITHMETIC_BODY.exec(word); match !== null; match = ARITHMETIC_BODY.exec(word)) bodies.add(match[1]);
    }
  }
  return bodies;
}

/**
 * A program word that is not plain text, or `eval` with an argument.
 * The word is the text before expansion, path included, so `/bin/s$(echo h)` is refused.
 */
function findUnplainProgram(commands: string[][]): string | undefined {
  const arithmetic = findArithmeticBodies(commands);
  for (const words of commands) {
    spend(words.length);
    if (words.length === 1 && arithmetic.has(words[0])) continue;
    for (const place of findProgramPlaces(words)) {
      if (!PLAIN_PROGRAM.test(place.word)) return place.word;
    }
    if (hasEvalArgument(words)) return 'eval';
  }
  return undefined;
}

/** Whether `eval` has an argument, so it runs that argument as a command. A redirect is not one. */
function hasEvalArgument(words: string[]): boolean {
  for (const place of findProgramPlaces(words)) {
    if (place.index < 0 || programName(place.word).toLowerCase() !== 'eval') continue;
    let index = place.index + 1;
    while (index < words.length && redirectLength(words, index) > 0) index += redirectLength(words, index);
    if (index < words.length) return true;
  }
  return false;
}

// Whether a substitution in `text` runs, and whether one never closes.
// Single quotes and `$'…'` hide it. `<(…)` and `>(…)` do not run inside `"…"`. `$((…))` is arithmetic.
// A backslash and a newline inside `"…"` are removed before the shell parses.
interface SubstitutionScan {
  live: boolean;
  unclosed: boolean;
}

/** The index after a backslash and a newline. The shell removes that pair before it parses. */
function skipContinuation(text: string, index: number): number {
  const start = index;
  while (text[index] === '\\' && text[index + 1] === '\n') index += 2;
  spend(index - start);
  return index;
}

function scanSubstitutions(text: string): SubstitutionScan {
  spend(text.length);
  let live = false;
  let quote = '';
  let ansi = false;
  let inWord = false;
  let backtick = false;
  const kinds: Array<'run' | 'skip'> = [];
  // `at` stays on the last character of the opener. The loop then steps past it.
  const open = (kind: 'run' | 'skip', at: number, width: number) => {
    kinds.push(kind);
    if (kind === 'run') live = true;
    return at + width - 1;
  };
  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    const next = text[at + 1] ?? '';
    if (ansi) {
      if (character === '\\') at++;
      else if (character === "'") ansi = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      // `"$\⏎(sh)"` is `"$(sh)"`. The pair is not an escape of the next character.
      if (character === '\\' && next === '\n') {
        at++;
        continue;
      }
      if (character === '\\' && '$`"\\'.includes(next)) {
        at++;
        continue;
      }
      if (character === '"') {
        quote = '';
        continue;
      }
      if (character === '`') {
        live = true;
        backtick = !backtick;
      } else if (character === '$') {
        const opened = skipContinuation(text, at + 1);
        if (text[opened] === '(') {
          if (text[opened + 1] === '(') {
            kinds.push('skip', 'skip');
            at = opened + 1;
          } else at = open('run', opened, 1);
        }
      } else if (character === '(') kinds.push('skip');
      else if (character === ')' && kinds.length > 0) kinds.pop();
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      inWord = false;
      continue;
    }
    if (!inWord && character === '#') {
      while (at < text.length && text[at] !== '\n') at++;
      continue;
    }
    if (character === '\\') {
      at++;
      inWord = true;
      continue;
    }
    if (character === '$' && next === "'") {
      ansi = true;
      at++;
      inWord = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === '`') {
      live = true;
      backtick = !backtick;
    } else if ((character === '$' || character === '<' || character === '>') && next === '(') {
      if (character === '$' && text[at + 2] === '(') {
        kinds.push('skip', 'skip');
        at += 2;
      } else at = open('run', at, 2);
    } else if (character === '(') kinds.push('skip');
    else if (character === ')' && kinds.length > 0) kinds.pop();
    inWord = true;
  }
  return { live, unclosed: backtick || kinds.includes('run') };
}

/** Whether `name` is a shell. `powershell` stays beside `isShell`, which names `pwsh` (#574). */
function isPipeShell(name: string): boolean {
  const folded = name.toLowerCase();
  return folded === 'powershell' || isShell(folded);
}

/**
 * `sudo -s`, `sudo -i` or `doas -s` reads stdin as a shell when no program follows.
 * The flag meaning is `RUNNERS`. A later program is that program, so `sudo tee` passes.
 */
function findShellRunner(words: string[]): string | undefined {
  spend(words.length);
  let index = skipPrefix(words, 0);
  while (index < words.length) {
    if (HEADS.has(words[index])) return undefined;
    const name = programName(words[index]);
    const folded = name.toLowerCase();
    if (!Object.hasOwn(LAUNCHERS, folded)) return undefined;
    const launcher = LAUNCHERS[folded];
    const shellFlag = folded === 'sudo' || folded === 'doas' ? RUNNERS[folded] : null;
    index++;
    let readsShell = false;
    while (index < words.length && words[index].startsWith('-')) {
      if (shellFlag !== null && shellFlag.test(words[index])) readsShell = true;
      index += launcher.options.includes(words[index]) ? 2 : 1;
    }
    index += launcher.operands ?? 0;
    // A redirect names a file. `sudo -s > saved` still reads the pipe as a shell.
    while (index < words.length && redirectLength(words, index) > 0) index += redirectLength(words, index);
    if (readsShell && index >= words.length) return name;
  }
  return undefined;
}

/** The command's pipelines: cut at ; && || and line ends, outside quotes and groups. */
function splitPipelines(command: string): string[] {
  const pipelines: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  const push = () => {
    pipelines.push(current);
    current = '';
  };
  for (let at = 0; at < command.length; at++) {
    spend(1);
    const character = command[at];
    const next = command[at + 1] ?? '';
    if (quote === "'") {
      current += character;
      if (character === "'") quote = '';
    } else if (quote === '"') {
      current += character;
      if (character === '\\' && at + 1 < command.length) current += command[++at];
      else if (character === '"') quote = '';
    } else if (character === '\\') {
      current += character;
      if (at + 1 < command.length) current += command[++at];
    } else if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === '(') {
      depth++;
      current += character;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if ((character === ';' || character === '\n' || character === '\r') && depth === 0) {
      push();
    } else if ((character === '&' && next === '&') || (character === '|' && next === '|')) {
      if (depth === 0) {
        push();
        at++;
      } else current += character;
    } else current += character;
  }
  pipelines.push(current);
  return pipelines;
}

/** One pipeline's pipe segments: cut at | and |&, outside quotes. */
function splitPipeSegments(pipeline: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote = '';
  for (let at = 0; at < pipeline.length; at++) {
    spend(1);
    const character = pipeline[at];
    if (quote !== '') {
      current += character;
      if (character === '\\' && quote === '"' && at + 1 < pipeline.length) current += pipeline[++at];
      else if (character === quote) quote = '';
    } else if (character === '\\') {
      current += character;
      if (at + 1 < pipeline.length) current += pipeline[++at];
    } else if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === '|') {
      if (pipeline[at + 1] === '|') {
        current += '||';
        at++;
      } else {
        segments.push(current);
        current = '';
        if (pipeline[at + 1] === '&') at++;
      }
    } else current += character;
  }
  segments.push(current);
  return segments;
}

// ---- The hooks setting (#114) ----
//
// git runs the commit check from core.hooksPath. Reading the setting is fine. Any value
// but .githooks can turn the check off: for good with `git config`, or for one command with
// `git -c`, `--config-env` or GIT_CONFIG_KEY_n. Keys are case-insensitive, as in git.
// A value the guard cannot see (from a variable) blocks.
//
// `git config` in the repo's own config may also set the value already set, or a folder
// whose pre-commit runs `yokoten check` (#217): husky's `.husky/_`, or a folder
// `yokoten init` kept.

const HOOKS_DIR = '.githooks';
const HOOKS_FIX = 'leave it as it is; another folder is fine once its pre-commit runs `yokoten check` (`yokoten init` adds it there)';
const isHooksPath = (key: string) => key.trim().toLowerCase() === 'core.hookspath';
const hooksPath = (what: string, fix = HOOKS_FIX) => finding('hooks-path', what, fix);

// An include (`include.path`, `includeIf.<condition>.path`) reads another config file,
// which can set core.hooksPath without naming it (#358). Section and key are
// case-insensitive; the condition is not, and does not matter here.
const isInclude = (key: string) => /^include(if\..*)?\.path$/is.test(key.trim());
const includes = (what: string) =>
  hooksPath(`${what} reads another config file, which can set core.hooksPath and turn off the commit check`, 'set the setting you need by name, so the guard can check it');

// `git -c core.hooksPath=<value>` and `--config-env core.hooksPath=<VARIABLE>`.
function checkHooksSettings(settings: string[], fromEnvironment: string[]): Finding | null {
  if (fromEnvironment.some((s) => isHooksPath(s.split('=')[0]))) {
    return hooksPath('git --config-env core.hooksPath sets the hooks folder from a variable, which can skip the commit check');
  }
  const fromVariable = fromEnvironment.map((s) => s.split('=')[0]).find(isInclude);
  if (fromVariable) return includes(`git --config-env ${fromVariable}`);
  const include = settings.map((s) => s.split('=')[0]).find(isInclude);
  if (include) return includes(`git -c ${include}`);
  for (const setting of settings) {
    const equals = setting.indexOf('=');
    const key = equals === -1 ? setting : setting.slice(0, equals);
    if (isHooksPath(key) && (equals === -1 || setting.slice(equals + 1) !== HOOKS_DIR)) {
      return hooksPath('git -c core.hooksPath with a value other than .githooks skips the commit check for that command');
    }
  }
  return null;
}

// `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=x git commit` does
// what `git -c` does, and so does GIT_CONFIG_PARAMETERS, the variable `-c` itself sets.
// An assignment counts when it stands before the program, after env, sudo or export, or
// anywhere before a git word. So `grep GIT_CONFIG_KEY_0=core.hooksPath file` is a read.
// `NAME+=value` counts as `NAME=value`. A key that names core.hooksPath is refused
// whatever value goes with it: any GIT_CONFIG_KEY_n is refused below anyway (#361).
const ASSIGNERS = new Set(['env', 'sudo', 'doas', 'export', 'declare', 'typeset', 'readonly', 'local']);
// `NAME+=value` adds to a setting: it is an assignment too.
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);

function checkHooksEnvironment(words: string[]): Finding | null {
  const lastGit = words.findLastIndex(isGit);
  let isPrefix = true; // every word before this one is an assignment, an option or an assigner
  for (const [index, word] of words.entries()) {
    const variable = /^GIT_CONFIG_(KEY_(\d+)|PARAMETERS)(\+?)=(.*)$/is.exec(word);
    const wasPrefix = isPrefix;
    isPrefix = isPrefix && (isAssignment(word) || word.startsWith('-') || ASSIGNERS.has(base(word)));
    if (!variable) continue;
    if (!wasPrefix && lastGit <= index) continue;
    const [, name, number, adds, setting] = variable;
    if (name.toUpperCase() === 'PARAMETERS') {
      if (setting.toLowerCase().includes('core.hookspath')) return hooksPath('GIT_CONFIG_PARAMETERS names core.hooksPath, which can skip the commit check');
      if (/include(if\.[^=]*)?\.path/i.test(setting)) return includes('GIT_CONFIG_PARAMETERS with an include');
      continue;
    }
    if (adds) return hooksPath(`GIT_CONFIG_KEY_${number}+= adds to a key yokoten can't see, which may make core.hooksPath and skip the commit check`);
    if (isInclude(setting)) return includes(`GIT_CONFIG_KEY_${number} ${setting.trim()}`);
    if (isHooksPath(setting)) return hooksPath(`GIT_CONFIG_KEY_${number} names core.hooksPath, which can skip the commit check`);
  }
  return null;
}

// ---- Settings an agent may not make (#361, #664) ----
//
// Some variables change what the commit check reads. HOME and USERPROFILE move the home
// folder, where the private marks are; GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and
// GIT_CONFIG_COUNT/KEY_n/VALUE_n give git settings the guard does not read one by one. A
// name counts as set:
// - for one program, by an assignment just before it, also after env, sudo or another
//   launcher: `HOME=x git commit`, `env HOME=x gh issue create`;
// - for the rest of the line, by an assignment with no program after it, by export,
//   declare and the like, by read, mapfile, printf -v, getopts, let, a for or select
//   loop, and by `${NAME:=x}` or `${NAME=x}`.
// A setting for the rest of the line is refused. A setting for one program is refused when
// that program is git, gh, yokoten, or a shell or eval that runs another line. Before any
// other program it passes: `HOME=$(mktemp -d) npm test` keeps a test away from your files.
// The guard reads names, not grammar: an indirect name (`export $name=x`) gets past.

/** A name a command sets, and the index of the one program it is set for (null: the rest of the line). */
type Setting = { name: string; program: number | null };

// Programs that run another command line, so a setting before them reaches git too.
const RUNS_LINES = /^(sh|bash|zsh|dash|ksh|mksh|fish|eval|source|\.|xargs|exec|su|sudo|doas|env|nohup|setsid|script)$/;
const isYokotenWord = (word: string) => /^yokoten(\.[cm]?[jt]s)?$/i.test(base(word));
// read, mapfile and readarray set every name after them; printf only the one after -v.
const NAME_READERS = new Set(['read', 'mapfile', 'readarray']);
const nameOf = (word: string) => word.slice(0, word.indexOf('=')).replace(/\+$/, '');

function settingsIn(words: string[]): Setting[] {
  const settings: Setting[] = [];
  const programs: number[] = [];
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    programs.push(at);
    from = at + 1;
  }
  // For each word: the program right after it, when only assignments, options and
  // launchers stand between them. One pass from the end keeps it linear.
  const isProgram = new Set(programs);
  const programAfter: number[] = new Array(words.length).fill(-1);
  let next = -1;
  for (let index = words.length - 1; index >= 0; index--) {
    if (isProgram.has(index)) {
      next = index;
      continue;
    }
    programAfter[index] = next;
    const word = words[index];
    if (!isAssignment(word) && !word.startsWith('-') && !Object.hasOwn(LAUNCHERS, programName(word))) next = -1;
  }
  let isPrefix = true; // every word before this one is an assignment, an option or an assigner
  for (const [index, word] of words.entries()) {
    const wasPrefix = isPrefix;
    isPrefix = isPrefix && (isAssignment(word) || word.startsWith('-') || ASSIGNERS.has(base(word)));
    if (isAssignment(word)) {
      if (programAfter[index] !== -1) settings.push({ name: nameOf(word), program: programAfter[index] });
      else if (wasPrefix) settings.push({ name: nameOf(word), program: null });
    }
    // `${NAME:=x}` and `${NAME=x}` set NAME wherever they stand.
    for (const [, name] of word.matchAll(/\$\{([A-Za-z_]\w*):?=/g)) settings.push({ name, program: null });
  }
  for (const at of programs) {
    const name = programName(words[at]);
    // The tail is long inside `find -exec find`. Copy it only for a program that reads names.
    if (!NAME_READERS.has(name) && name !== 'let' && name !== 'printf' && name !== 'getopts') continue;
    const args = words.slice(at + 1);
    if (NAME_READERS.has(name)) args.forEach((arg) => settings.push({ name: arg.replace(/^-[A-Za-z]*a/, ''), program: null }));
    if (name === 'let') args.filter(isAssignment).forEach((arg) => settings.push({ name: nameOf(arg), program: null }));
    if (name === 'printf') {
      args.forEach((arg, index) => {
        if (arg === '-v' && index + 1 < args.length) settings.push({ name: args[index + 1], program: null });
        else if (/^-v./.test(arg)) settings.push({ name: arg.slice(2), program: null });
      });
    }
    // `getopts optstring name`: the second plain word.
    if (name === 'getopts') {
      const plain = args.filter((arg) => !arg.startsWith('-'));
      if (plain[1] !== undefined) settings.push({ name: plain[1], program: null });
    }
  }
  // `for NAME in ...` and `select NAME in ...`: only the name slot.
  const head = words.findIndex((word) => !KEYWORDS.has(word));
  if ((words[head] === 'for' || words[head] === 'select') && words[head + 1] !== undefined) settings.push({ name: words[head + 1], program: null });
  return settings;
}

/**
 * The settings in `words` whose name passes `isNamed`, that the rule refuses: see above.
 * `guards` replaces the usual program test (git, gh, yokoten, a shell). A setting for the
 * rest of the line is refused when `includeRest` is set, which it is unless a caller says
 * the script never reaches the check.
 */
function refusedSetting(words: string[], isNamed: (name: string) => boolean, guards?: (at: number) => boolean, includeRest = true): string | null {
  const settings = settingsIn(words).filter((setting) => isNamed(setting.name));
  if (settings.length === 0) return null;
  const lastYokoten = words.findLastIndex(isYokotenWord);
  const runsGuarded = guards ?? ((at: number) => isGit(words[at]) || ['gh', 'yokoten'].includes(programName(words[at])) || RUNS_LINES.test(programName(words[at])) || lastYokoten >= at);
  return settings.find((setting) => (includeRest && setting.program === null) || (setting.program !== null && runsGuarded(setting.program)))?.name ?? null;
}

// git's config variables (#361). GIT_CONFIG_PARAMETERS is read above, for core.hooksPath.
const GIT_CONFIG_NAME = /^GIT_CONFIG_(GLOBAL|SYSTEM|COUNT|KEY_\d+|VALUE_\d+)$/i;

function checkGitConfigEnvironment(words: string[]): Finding | null {
  const name = refusedSetting(words, (setting) => GIT_CONFIG_NAME.test(setting));
  if (name === null) return null;
  const shown = name.toUpperCase().replace(/_\d+$/, '_n');
  const what = /_(GLOBAL|SYSTEM)$/.test(shown) ? 'points git at another config file' : 'sets git settings yokoten does not read one by one';
  return hooksPath(`${shown} ${what}, which can set core.hooksPath and skip the commit check`, 'run git without it; to set one setting for one command, use `git -c <name>=<value>`, which the guard can check');
}

// ---- Shell writes to git's config and hooks (#361) ----
//
// `git config` is read setting by setting above. A shell write to the same files is not:
// `printf '[core]\nhooksPath=x' >> .git/config`, `sed -i` on it, or `rm`/`chmod -x` on
// `.githooks/pre-commit` can each turn the commit check off. So a command that names
// `.git/config`, `.git/commondir`, `.git/hooks` or `.githooks` as a file it writes is
// refused, for lead and worker: a redirect, the files of the writers in WRITERS (cp, mv,
// tee, sed -i, rm, ln, install, truncate, patch, vim, tar -C, ...) and of chmod and the
// rest of MARK_WRITERS. `mkdir` passes, and so do the lead's `git checkout` and
// `git restore`, which bring back the committed hook. A path is placed from the likely
// folder, so `cd .git && echo >> config` is refused, and one in another repo (`/tmp/x/.git`)
// passes. A path with a glob (`*?[{`) is refused when it could reach into `.git` or `.githooks`.
// A read (`cat .git/config`, `git config --get`) writes nothing and passes.
const GIT_SETUP_FILE = /(^|\/)\.git(\/?$|\/config(\.worktree)?$|\/hooks(\/|$)|\/commondir$|\/worktrees\/[^/]+\/(config\.worktree|commondir)$)|(^|\/)\.githooks(\/|$)/i;
const GIT_SETUP_FIX = 'change a git setting with `git config <name> <value>`, and a hook with your edit tool or `yokoten init`, so the guard can check it';

// Whether a path, as text, may be git's config or hooks; with a glob, whether it could match one.
function namesGitSetup(path: string): boolean {
  const plain = posix.normalize(path.replace(/\\/g, '/'));
  if (GIT_SETUP_FILE.test(plain)) return true;
  if (!HAS_GLOB.test(plain)) return false;
  return braceForms(plain, 0).some((form) => {
    const parts = form.split('/');
    return parts.some((part, at) =>
      // A glob for the .git folder itself (`chmod 000 .gi?`) is left to the other rules.
      (HAS_GLOB.test(part) && ((at < parts.length - 1 && globMatches(part, '.git')) || globMatches(part, '.githooks'))) ||
      (/^\.git(hooks)?$/i.test(part) && parts.slice(at + 1).some((rest) => HAS_GLOB.test(rest))) ||
      GIT_SETUP_FILE.test(form));
  });
}

const isInside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

function checkGitSetupWrites(words: string[], { folder, from, env }: { folder: string | null; from: string | null; env: Env }): Finding | null {
  const known = new Map<string, string | null>();
  const isWorker = env.YOKOTEN_ROLE === 'worker';
  const targets = writeTargets(words, folder, (dir) => gitRootAbove(dir, known), { keepsRestores: isWorker }).map((target) => target.path);
  const findStarts = (args: string[]) => findWrites(args, (writer) => Object.hasOwn(WRITERS, writer) || Object.hasOwn(SETUP_WRITERS, writer) || MARK_WRITERS.has(writer) || RUNS_CODE.test(writer))?.starts ?? [];
  let at = 0;
  // Set when the outer find's tail has a write. Nested finds then add their own start folders.
  let findTailWrites = false;
  let findTailRead = false;
  for (const program of findPrograms(words)) {
    const index = words.indexOf(program, at);
    if (index === -1) continue;
    at = index + 1;
    const name = programName(program);
    const isMarkWriter = name !== 'mkdir' && MARK_WRITERS.has(name);
    const isSetupWriter = Object.hasOwn(SETUP_WRITERS, name);
    if (isMarkWriter || isSetupWriter) {
      const args = withoutShellRedirects(words, index + 1);
      if (isMarkWriter) targets.push(...plainArgs(args));
      if (isSetupWriter) targets.push(...SETUP_WRITERS[name](args));
    }
    // A find that writes changes files under where it starts: `find .githooks -exec rm {} +`.
    // Its tail holds every nested find. Read that tail once, unless it writes.
    if (name !== 'find') continue;
    if (!findTailRead) {
      findTailRead = true;
      const starts = findStarts(withoutShellRedirects(words, index + 1));
      findTailWrites = starts.length > 0;
      targets.push(...starts);
      continue;
    }
    if (findTailWrites) targets.push(...findStarts(withoutShellRedirects(words, index + 1)));
  }
  if (targets.length === 0) return null;
  // The repo the command starts in, and its git folders: a placed path outside them all is
  // another repo's file, such as a test repo in /tmp.
  const root = from === null ? null : gitRootAbove(from, known);
  const held = root === null ? [] : [realPath(root), ...protectedGitDirs(from ?? root)];
  const home = homeOf(env);
  const target = targets.find((path) => {
    const expanded = /^~(?=[\\/]|$)/.test(path) ? (home === null ? null : join(home, path.slice(1))) : path;
    const isPlaced = expanded !== null && !/[$`]/.test(path) && (folder !== null || isAbsolute(expanded));
    if (!isPlaced || held.length === 0) return namesGitSetup(path);
    const full = realPath(resolve(folder ?? '/', expanded));
    const holders = held.filter((dir) => isInside(full, dir));
    if (holders.length === 0) return false;
    // Inside the work tree, the path from its root; inside a git folder, the path in `.git`.
    const inside = (dir: string) => relative(dir, full).split(sep).join('/');
    return holders.some((dir) => namesGitSetup(dir === held[0] ? inside(dir) || '.' : posix.join('.git', inside(dir)))) || namesGitSetup(path);
  });
  return target === undefined ? null : hooksPath(`this command changes ${target}, which holds git's settings or the commit check`, GIT_SETUP_FIX);
}

// ---- The home folder (#664) ----
//
// The commit check and the guard for gh posts read the private marks from the home folder:
// HOME, or USERPROFILE on Windows when HOME is not set. `HOME=/tmp/x git commit` would make
// them look in another folder, find no marks and pass. So the guard refuses these names
// where the settings rule above does. Names on Windows ignore case, so `home=` counts too.
// Reading $HOME is fine. For the lead, XDG_CONFIG_HOME moves nothing these checks read, so
// it passes. A worker may not set it before the commit check: see checkWorkerRealHome (#739).
const HOME_NAMES = new Set(['HOME', 'USERPROFILE']);
const HOME_FIX = 'run the command without changing the home folder; yokoten reads the private marks from your own home';

function checkHomeSetting(words: string[], env: Env): Finding | null {
  const name = refusedSetting(words, (setting) => HOME_NAMES.has(setting.toUpperCase()));
  if (name !== null) return finding('home-folder', `this command sets ${name}, which moves where yokoten finds your private marks`, HOME_FIX);
  // A worker unsets only when the script reaches the commit check: see checkWorkerRealHome.
  if (env.YOKOTEN_ROLE === 'worker') return null;
  const cleared = clearedHomeName(words, HOME_NAMES);
  return cleared === null ? null : finding('home-folder', `this command unsets ${cleared}, which moves where yokoten finds your private marks`, HOME_FIX);
}

/**
 * A home name this command clears, or null (#739). `unset NAME` holds for the rest of the
 * line, like `export`. `env -u NAME` clears it for the one program after `env`, and only
 * when that program is git, gh, yokoten or a shell. `env -u HOME npm test` stays allowed.
 */
function clearedHomeName(words: string[], names: Set<string>): string | null {
  const isHome = (name: string) => names.has(name.toUpperCase());
  const fromUnset = (args: string[]): string | null => {
    for (const arg of args) {
      if (!arg.startsWith('-') && isHome(arg)) return arg;
    }
    return null;
  };
  // env's own options, from the word after `env` to the program it runs. A cluster is read
  // here: findPrograms does not treat `-iu` as `-u`, so `env -iu HOME git` would hide git.
  const readEnv = (start: number): { cleared: string | null; program: number | null } => {
    let cleared: string | null = null;
    let index = start;
    while (index < words.length) {
      const word = words[index];
      if (isAssignment(word)) {
        index += 1;
        continue;
      }
      if (!word.startsWith('-')) return { cleared, program: index };
      const inline = /^--unset=(.*)$/.exec(word);
      if (inline) {
        if (cleared === null && isHome(inline[1])) cleared = inline[1];
        index += 1;
        continue;
      }
      if (word === '--unset') {
        const next = words[index + 1] ?? '';
        if (cleared === null && isHome(next)) cleared = next;
        index += next === '' ? 1 : 2;
        continue;
      }
      // `-u NAME`, `-uNAME`, and a cluster whose last flag is `u` (`-iuHOME`, `-iu HOME`).
      const cluster = /^-([a-zA-Z]*)u(.*)$/.exec(word);
      if (cluster) {
        const rest = cluster[2];
        if (rest === '') {
          const next = words[index + 1] ?? '';
          if (cleared === null && isHome(next)) cleared = next;
          index += next === '' ? 1 : 2;
        } else {
          if (cleared === null && isHome(rest)) cleared = rest;
          index += 1;
        }
        continue;
      }
      // These take the next word. Skipping it keeps a later `-u HOME` visible.
      if (word === '-C' || word === '--chdir' || word === '-S' || word === '--split-string') {
        index += index + 1 < words.length ? 2 : 1;
        continue;
      }
      index += 1;
    }
    return { cleared, program: null };
  };
  const lastYokoten = words.findLastIndex(isYokotenWord);
  const guarded = (at: number) => isGit(words[at]) || ['gh', 'yokoten'].includes(programName(words[at])) || RUNS_LINES.test(programName(words[at])) || lastYokoten >= at;
  // One pass over the programs, then one pass over the words before the last of them.
  // Reading every earlier word once per program made `find -exec find` take quadratic time.
  let lastProgram = -1;
  for (const place of findProgramPlaces(words)) {
    if (place.index === -1) continue;
    if (place.index > lastProgram) lastProgram = place.index;
    if (programName(place.word) === 'unset') {
      const cleared = fromUnset(words.slice(place.index + 1));
      if (cleared !== null) return cleared;
    }
  }
  for (let cursor = 0; cursor < lastProgram; cursor++) {
    if (programName(words[cursor]) !== 'env') continue;
    const read = readEnv(cursor + 1);
    if (read.cleared !== null && read.program !== null && guarded(read.program)) return read.cleared;
  }
  return null;
}

// A worker's home before the commit check (#739). HOME and USERPROFILE move the marks file.
// XDG_CONFIG_HOME is the same door for a worker: the desk already refuses other settings, and
// this one must say why, before git commit, yokoten check, or a shell that runs them. The
// lead's XDG_CONFIG_HOME is left alone. The box still refuses every other setting.
// A shell script file is the same door with the assignment hidden in the file. The guard
// reads the command, not the file, so a worker's `bash file` or `sh file` is refused.
// `bash -c` stays, because that text is in the command.
const REAL_HOME_NAMES = new Set(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']);
const REAL_HOME_FIX = 'the commit check needs the real home; in a desk, the runner commits for you (issue #736)';
// Shell flags that do not name a file and do not take a value. `s` reads stdin, which the
// reader already has when the text is in the command. Anything else may name a file.
const SHELL_FLAG = /^-[euxnvfhlips]+$/;
const SHELL_LONG_FLAGS = new Set(['--posix', '--noprofile', '--norc', '--login', '--noediting', '--restricted', '--help', '--version']);

/** Whether the program at `at` is git commit, yokoten check, or a shell that can run them. */
function runsCommitCheck(words: string[], at: number): boolean {
  const program = words[at];
  if (RUNS_LINES.test(programName(program))) return true;
  if (isGit(program)) return gitParts(withoutShellRedirects(words, at + 1), null).sub === 'commit';
  const tail = words.slice(at);
  return tail.some(isYokotenWord) && tail.includes('check');
}

/** Whether any program in `words` is git commit, yokoten check, or a shell that can run them. */
function commandReachesCheck(words: string[]): boolean {
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (runsCommitCheck(words, at)) return true;
  }
  return false;
}

/** Whether `word` is a shell that can run a script file, in any case (`Bash`, `rbash`, `mksh`). */
function isScriptShell(word: string): boolean {
  const name = programName(word).toLowerCase();
  return isShell(name) || name === 'mksh' || name === 'rbash';
}

/**
 * Whether a shell's arguments hide the script (#739). `bash -c text` and `--command` are in
 * the command, so they are not hidden. A file operand, an input redirect (`< file`, not a
 * heredoc) and an option the guard does not know (`--rcfile`, `-o`) are hidden: the guard
 * cannot tell whether that file sets HOME, so it refuses.
 */
function shellOperandsHide(args: string[]): boolean {
  let index = 0;
  let inline = false;
  while (index < args.length) {
    const arg = args[index];
    if (REDIRECT.test(arg)) {
      const operator = REDIRECT_OPERATOR.exec(arg)?.[0] ?? '';
      if (operator.includes('<') && !operator.includes('<<') && !inline) return true;
      index += redirectLength(args, index) || 1;
      continue;
    }
    if (arg === '--') {
      if (!inline) return true;
      index += 1;
      continue;
    }
    if (arg === '-c' || arg === '--command') {
      const script = args[index + 1] ?? '';
      if (script === '' || REDIRECT.test(script)) return true;
      inline = true;
      index += 2;
      continue;
    }
    if (arg.startsWith('--command=')) {
      if (arg.length === '--command='.length) return true;
      inline = true;
      index += 1;
      continue;
    }
    // `-lc`, `-cecho hi`: `c` ends the flags, or the rest of the word is the script text.
    const cluster = /^-(?:[euxnvfhlips]*)c(.*)$/s.exec(arg);
    if (cluster && !arg.startsWith('--')) {
      const rest = cluster[1];
      if (rest === '') {
        const script = args[index + 1] ?? '';
        if (script === '' || REDIRECT.test(script)) return true;
        index += 2;
      } else index += 1;
      inline = true;
      continue;
    }
    if (SHELL_FLAG.test(arg) || SHELL_LONG_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-') || !inline) return true;
    index += 1;
  }
  return false;
}

/** Whether `words` runs a shell script the guard cannot read. The lead is not asked. */
function shellHidesScript(words: string[]): boolean {
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (isScriptShell(program) && shellOperandsHide(words.slice(at + 1))) return true;
  }
  return false;
}

/**
 * For a worker: a home setting that would hide the private marks from the commit check, or
 * null. A setting for the rest of the line counts only when this script reaches that check,
 * so `HOME+=x; rm` stays with the worker box (#591). A shell script file counts too: the
 * guard cannot read it, so it refuses instead of guessing.
 */
function checkWorkerRealHome(commands: string[][]): Finding | null {
  const reaches = commands.some(commandReachesCheck);
  for (const words of commands) {
    const name = refusedSetting(words, (setting) => REAL_HOME_NAMES.has(setting.toUpperCase()), (at) => runsCommitCheck(words, at), reaches);
    if (name !== null) return finding('home-folder', `this command sets ${name}, so the commit check would not see your private marks`, REAL_HOME_FIX);
    if (reaches) {
      const cleared = clearedHomeName(words, REAL_HOME_NAMES);
      if (cleared !== null) return finding('home-folder', `this command unsets ${cleared}, so the commit check would not see your private marks`, REAL_HOME_FIX);
    }
    if (shellHidesScript(words)) return finding('home-folder', 'this command runs a shell script yokoten cannot read, so the commit check might not see your private marks', REAL_HOME_FIX);
  }
  return null;
}

// A shell redirect is no argument to git: `git config core.hooksPath 2>/dev/null` reads
// the setting (#351). Only a redirect the reader saw with no quote in it is taken out, so
// `git config core.hooksPath '>x'` still sets the value ">x". Words that never went through
// the reader (an `env -S` string, the rough cut) have no marks, and keep every word.
const unquotedRedirects = new WeakMap<string[], Set<number>>();
// The word lists the reader made: in them, a redirect with no mark is quoted text.
const readWords = new WeakSet<string[]>();

// The words of `words` from `from` on, with each unquoted redirect and its file taken out.
export function withoutShellRedirects(words: string[], from: number): string[] {
  const marks = unquotedRedirects.get(words);
  const kept: string[] = [];
  for (let index = from; index < words.length; ) {
    const length = marks?.has(index) ? redirectLength(words, index) : 0;
    if (length === 0) kept.push(words[index]);
    index += length || 1;
  }
  return kept;
}

// `git config` options that take the next word as their value.
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l', 'get', 'list']);
const CONFIG_REMOVES = new Set(['--unset', '--unset-all', 'unset']);
const CONFIG_EDITS = new Set(['--edit', '-e', 'edit']);
const CONFIG_SECTIONS = new Set(['--rename-section', '--remove-section', 'rename-section', 'remove-section']);
// git 2.46 and later also takes a subcommand: `git config get|list|set|unset|...`.
const CONFIG_SUBCOMMANDS = new Set(['get', 'list', 'set', 'unset', 'edit', 'rename-section', 'remove-section']);

// Every long option of `git config`, old form and subcommands, git 2.43 to 2.51.
const CONFIG_LONG_OPTIONS = [
  ...CONFIG_VALUE_OPTIONS, ...CONFIG_READS, ...CONFIG_REMOVES, ...CONFIG_EDITS, ...CONFIG_SECTIONS,
  '--global', '--system', '--local', '--worktree', '--replace-all', '--add', '--fixed-value', '--bool', '--int',
  '--bool-or-int', '--bool-or-str', '--path', '--expiry-date', '--null', '--name-only', '--includes',
  '--show-origin', '--show-scope', '--show-names', '--all', '--regexp', '--append',
].filter((option) => option.startsWith('--'));
// Short options that take a value: in `-fx` the rest of the word is the value.
const CONFIG_SHORT_VALUES = 'ft';

// An option as git reads it (#358). git takes a long option by any start of its name
// (`--ed` is --edit); a start several options share is each of them, since git refuses
// it anyway. Short options join (`-ef x` is `-e -f x`). `takesNext`: the next word is a value.
function readConfigOption(word: string): { names: string[]; takesNext: boolean } {
  if (word.startsWith('--')) {
    const [name, ...value] = word.split('=');
    const exact = CONFIG_LONG_OPTIONS.includes(name);
    const matches = exact ? [name] : CONFIG_LONG_OPTIONS.filter((option) => option.startsWith(name));
    const names = matches.length > 0 ? matches : [name];
    return { names: value.length > 0 ? names.map((n) => `${n}=${value.join('=')}`) : names, takesNext: value.length === 0 && names.some((n) => CONFIG_VALUE_OPTIONS.has(n)) };
  }
  const names: string[] = [];
  for (const [index, letter] of [...word.slice(1)].entries()) {
    names.push(`-${letter}`);
    if (CONFIG_SHORT_VALUES.includes(letter)) return { names, takesNext: index === word.length - 2 };
  }
  return { names, takesNext: false };
}

// Splits `git config` arguments into options and plain words. The old form (`isOldForm`)
// reads options only before the first plain word: `git config core.hooksPath --local`
// sets the value "--local". The subcommand form reads options anywhere.
function splitConfig(args: string[], isOldForm: boolean): { options: string[]; plain: string[] } {
  const options: string[] = [];
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((isOldForm && plain.length > 0) || !args[i].startsWith('-') || args[i] === '-') plain.push(args[i]);
    else if (args[i] === '--') {
      plain.push(...args.slice(i + 1));
      break;
    } else {
      const { names, takesNext } = readConfigOption(args[i]);
      options.push(...names);
      if (takesNext) i++;
    }
  }
  return { options, plain };
}

// `git config`: a read passes; a change to core.hooksPath passes only to .githooks, or as
// checkHooksFolder allows. `directory` is the folder git works in, or null when unknown.
function checkConfig(args: string[], directory: string | null, env: Env): Finding | null {
  let { options, plain } = splitConfig(args, true);
  const subcommand = CONFIG_SUBCOMMANDS.has(plain[0]) ? plain[0] : undefined;
  if (subcommand) {
    const rest = splitConfig(plain.slice(1), false);
    options = [...options, ...rest.options];
    plain = rest.plain;
  }
  const actions = subcommand ? [subcommand] : options;
  // An editor can change any setting, core.hooksPath too, and the guard cannot see what
  // it writes: `GIT_EDITOR="sed -i ..." git config --edit` (#358). In any scope.
  const edit = actions.find((a) => CONFIG_EDITS.has(a));
  if (edit) {
    return hooksPath(
      `git config ${edit} opens a config file in an editor, which can change core.hooksPath and turn off the commit check`,
      'read a setting with `git config --get <key>`, and change one by name (`git config <key> <value>`), so the guard can check it',
    );
  }
  const section = actions.find((a) => CONFIG_SECTIONS.has(a));
  if (section) {
    if (plain.some((w) => w.toLowerCase() === 'core')) return hooksPath(`git config ${section} core changes core.hooksPath, which turns off the commit check`);
    // `--rename-section x include` makes the settings of x an include.
    const include = plain.slice(1).find((w) => isInclude(`${w}.path`));
    return include ? includes(`git config ${section} to ${include}`) : null;
  }
  const key = plain[0] ?? '';
  // `git config alias.x=...` defines an alias, which can run another command under a
  // new name: refused, not parsed (#560). A read passes. For a worker the worker rule
  // in checkGit still answers first, with its own id.
  if (/^alias\./i.test(key)) {
    const value = plain[1];
    const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
    const removes = actions.some((a) => CONFIG_REMOVES.has(a));
    const isRead = actions.some((a) => CONFIG_READS.has(a)) || (value === undefined && !isSet && !removes);
    return isRead ? null : aliasFinding(`\`git config ${key}\` changes an alias, which can run another command under a new name`);
  }
  if (!isHooksPath(key) && !isInclude(key)) return null;
  const remove = actions.find((a) => CONFIG_REMOVES.has(a));
  if (remove) return isInclude(key) ? null : hooksPath(`git config ${remove} core.hooksPath turns off the commit check`);
  if (actions.some((a) => CONFIG_READS.has(a))) return null;
  // A set: `git config <key> <value>`, --add, --replace-all or `git config set`.
  // With no value and no action, it is a read.
  const value = plain[1];
  const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
  if (value === undefined && !isSet) return null;
  if (isInclude(key)) return includes(`git config ${key}`);
  if (value === HOOKS_DIR) return null;
  if (value === undefined) return hooksPath('git config set core.hooksPath with no value turns off the commit check');
  return checkHooksFolder(value, options, directory, env);
}

// Config that is not this repo's own: a change there reaches other repos, or none.
// --worktree writes the config of the worktree git works in, which may not be this one.
const OTHER_SCOPES = new Set(['--global', '--system', '-f', '--file', '--blob', '--worktree']);

// A new core.hooksPath in the repo's own config passes when it is the value already set,
// or when git runs the folder's pre-commit (an executable file whose first line names sh,
// bash, dash or zsh) and the script runs `yokoten check` (for husky, .husky/pre-commit).
function checkHooksFolder(value: string, options: string[], directory: string | null, env: Env): Finding | null {
  const scope = options.find((o) => OTHER_SCOPES.has(o.split('=')[0]));
  if (scope) return hooksPath(`git config ${scope} core.hooksPath changes the hooks folder outside this repo's own config, which can turn off the commit check`);
  // git expands these, and the guard does not: it cannot tell which folder they name.
  if (value.startsWith('~') || value.startsWith('%(')) return hooksPath(`core.hooksPath ${value} names a folder git expands, which the guard cannot check`);
  const root = directory === null ? null : readGit(directory, ['rev-parse', '--show-toplevel'], env);
  if (root === null) return hooksPath('changing core.hooksPath where the guard cannot find the repo can turn off the commit check');
  if (readGit(root, ['config', '--get', 'core.hooksPath'], env) === value) return null;
  const file = hookFile(root, value);
  if (file === null) return hooksPath(`core.hooksPath ${value} is outside this repo, so the commit check does not run`);
  // git runs the folder's own pre-commit only when it is an executable file; husky's
  // `.husky/_/pre-commit` then runs `.husky/pre-commit`, with `sh -e`.
  const folder = hooksFolder(root, value);
  const runs = `${folder}/pre-commit`.replace(/^\//, '');
  const notRun = hookNotRun(join(root, runs));
  if (notRun) return hooksPath(`core.hooksPath ${value} turns off the commit check: git does not run ${runs}, ${notRun}`, `make ${runs} an executable shell script (\`yokoten init\` sets it up), then set core.hooksPath again`);
  const isHusky = folder === '.husky/_';
  const notHusky = isHusky ? notHuskys(root) : null;
  if (notHusky) return hooksPath(`core.hooksPath ${value} may not run the commit check: ${notHusky}`, 'run `npx husky` to write husky\'s own files, then set core.hooksPath again');
  if (runsCheck(readText(join(root, file)), isHusky)) return null;
  return hooksPath(`core.hooksPath ${value} turns off the commit check: ${file} does not run \`yokoten check\``, `add \`yokoten check\` to ${file} (\`yokoten init\` adds it), then set core.hooksPath again`);
}

// The shells a hook may name on its first line, directly or through /usr/bin/env (also
// `env -S`). A file with no #! line git runs with sh.
const SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s*)?|\/(?:[\w.+-]+\/)*)(?:sh|bash|dash|zsh)(?:[ \t].*)?$/;

// Why git would not run the hook file at `path` as a shell script, or null when it would.
function hookNotRun(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return 'which is not a file';
  } catch {
    return 'which does not exist';
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return 'which is not executable';
    }
  }
  const first = readText(path).split(/\r?\n/, 1)[0];
  return !first.startsWith('#!') || SHEBANG.test(first) ? null : 'whose first line does not name sh, bash, dash or zsh';
}

// husky 9's own files in `.husky/_`: each hook sources `h` from its folder, and `h` runs
// `.husky/<hook>` with `sh -e` (or sources it after `set -e`) and fails when it fails.
// Any other `.husky/_/pre-commit` or `h` may not run `.husky/pre-commit` at all.
const HUSKY_HOOK = new Set(['. "${0%/*}/h"', '. "$(dirname "$0")/h"']);
// The sha256 of each `h` husky 9.0.1 to 9.1.7 writes, without its comments, blank lines and indents.
const HUSKY_H = new Set([
  'b4b605f02218e49f92d437c0a447422cf962979c9805ec0722fd73bb12fc14ca', // 9.0.1
  '4cfec33fb6483d59ef799858e8ae5df0dfc98454ea386145c8382024076e9566', // 9.0.2 to 9.0.5
  '0ee76fc9c7a5dbce7cede4a7c6d99683c5e817164d5d86366541f008577daaa1', // 9.0.6
  '60898241f581d3f63d82dc61e43edbebcce35969496d446eadc3fba0854963ad', // 9.0.7 to 9.0.10
  '38db74aaa760471c57f52d64b89894a2a66098045068776c01fdde3518cdf8fb', // 9.0.11
  '035106e41eb342267fe34024d2aaebf81588523b28d46714283a273f62abdfa5', // 9.1.0 and 9.1.1
  'b4d32bb43592bfdc3a4077f47985f69777539e69ed16907148044b1d2b54f6ea', // 9.1.2
  '237b908c80bcad80439474bb49def6559697dbabee6cb2d6f6c969f354886d81', // 9.1.3 to 9.1.7
]);
const shellLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

// Why `.husky/_` in `root` is not husky's own, or null when it is.
function notHuskys(root: string): string | null {
  const hook = shellLines(readText(join(root, '.husky', '_', 'pre-commit')));
  if (hook.length !== 1 || !HUSKY_HOOK.has(hook[0])) return '.husky/_/pre-commit is not the one husky writes';
  const h = shellLines(readText(join(root, '.husky', '_', 'h'))).join('\n');
  if (!HUSKY_H.has(createHash('sha256').update(h).digest('hex'))) return '.husky/_/h is missing, or is not the one a husky 9 release writes';
  return null;
}

/**
 * The pre-commit file git runs for this core.hooksPath, relative to the repo root, or null
 * when the folder is outside the repo. husky's folder (`.husky/_`, or `.husky` before
 * husky 9) runs `.husky/pre-commit`. Any other folder runs its own pre-commit.
 */
export function hookFile(root: string, setting: string): string | null {
  const folder = hooksFolder(root, setting);
  if (folder === null) return null;
  if (folder === '.husky' || folder === '.husky/_') return '.husky/pre-commit';
  return folder ? `${folder}/pre-commit` : 'pre-commit';
}

// The hooks folder, relative to the repo root ('' for the root), or null when outside it.
function hooksFolder(root: string, setting: string): string | null {
  const folder = relative(root, resolve(root, setting)).split('\\').join('/');
  return folder === '..' || folder.startsWith('../') || isAbsolute(folder) ? null : folder;
}

// A line that runs the check and stops the commit when it fails, in the shapes yokoten
// writes or knows: `exec node "bin/yokoten.ts" check --staged`, `npx yokoten check || exit 1`,
// `pnpm exec yokoten check`, `npx lint-staged && npx yokoten check`, and the guarded form
// `[ -f <cli> ] || { echo '...' >&2; exit 1; }; node <cli> check` (with `2>/dev/null` after
// the `]`, as `yokoten init` writes it).
//
// The program is yokoten itself: `yokoten`, `yokoten.ts` or `yokoten.mjs` (#408), bare or quoted, or under
// node_modules/.bin, bin/ or .yokoten/. `./fake-yokoten` is some other program. The check
// takes only --staged and --json (`check --pr` reads a pull request, not the commit). After
// it comes nothing, a `;`, or `|| exit` with no code, a code not 0, or `$?`.
const CLI = String.raw`(?:yokoten(?:\.ts|\.mjs)?|(?:\./)?(?:node_modules/\.bin/yokoten|bin/yokoten(?:\.ts|\.mjs)?|\.yokoten/(?:bin/)?yokoten(?:\.ts|\.mjs)?))`;
const PROGRAM = String.raw`(?:"${CLI}"|'${CLI}'|${CLI})`;
const RUNNER = String.raw`(?:(?:npx(?:\s+--no-install|\s+--no(?:\s+--)?)?|pnpm\s+exec|yarn|bunx)\s+)?(?:node\s+)?`;
const CHECK_TAIL = String.raw`\s+check(?:\s+--(?:staged|json))*(?<stop>\s*\|\|\s*exit(?:\s+(?:[1-9]\d*|\$\?))?)?(?:\s*;)?$`;
// Commands before the check with `&&`: they cannot end the script (no exit, exec, source).
const NOT_BEFORE = String.raw`(?!(?:exit|return|exec|eval|source|trap|kill|set|shift|break|continue|alias|unset|builtin|command|\.)(?:\s|$))`;
const BEFORE = String.raw`(?<before>(?:${NOT_BEFORE}[\w./@:=+-]+(?:\s+[\w./@:=+-]+)*\s*&&\s*)+)?`;
const CHECK_LINE = new RegExp(String.raw`^${BEFORE}(?<exec>exec\s+)?${RUNNER}${PROGRAM}${CHECK_TAIL}`);
const GUARDED_LINE = new RegExp(String.raw`^\[ -f (?<cli>${PROGRAM}) \](?: 2>/dev/null)? \|\| \{ echo '[^']*'(?: >&2)?; exit [1-9]\d*; \}; node \k<cli>${CHECK_TAIL}`);
// Shell words that open and close a block: a line inside one may never run.
const OPENERS = new Set(['if', 'while', 'until', 'for', 'case', 'select']);
const CLOSERS = new Set(['fi', 'done', 'esac']);

/**
 * This pre-commit script runs `yokoten check` and fails the commit when the check fails:
 * a line in one of the shapes above, at the top level (not inside an `if`, a loop, a group,
 * a quote, a heredoc, or after `||`, `&&` or `|` on the line before), with no `exit` or
 * `return` (but `exit 1`), `exec` or heredoc before it. A line with no `exec` and no
 * `|| exit` is the last command, or follows `set -e` (and no `set +e`). `startsStrict`:
 * the script runs with `sh -e`, as husky 9 runs `.husky/pre-commit`.
 */
export function runsCheck(script: string, startsStrict = false): boolean {
  return withBudget(
    script.length,
    () => {
      const lines = scriptLines(script);
      let depth = 0;
      let isStrict = startsStrict; // set -e: a failed command stops the script
      for (const [index, line] of lines.entries()) {
        const shape = CHECK_LINE.exec(line) ?? GUARDED_LINE.exec(line);
        if (shape && depth === 0) {
          const { before, exec, stop } = shape.groups ?? {};
          const isLast = index === lines.length - 1;
          // After `a &&`, a failed `a` skips the check: exec and set -e do not help.
          if (stop !== undefined || isLast || (before === undefined && (exec !== undefined || isStrict))) return true;
        }
        if (leaves(line)) return false;
        if (/(?:^|[;&|({]\s*)set\s+(?:\+[a-zA-Z]*e|\+o\s+errexit)/.test(line)) isStrict = false;
        else if (depth === 0 && /^set\s+(?:-[a-zA-Z]*e|-o\s+errexit)/.test(line)) isStrict = true;
        depth += blockDepth(line);
        if (depth < 0) return false;
      }
      return false;
    },
    true,
  );
}

// Whether a line may end the script, or hand it to a heredoc, before a later line runs.
// `exit 1` and `|| exit $?` stop the commit, so they do not count.
function leaves(line: string): boolean {
  if (line.includes('<<')) return true;
  const rest = line.replace(/\|\|\s*(?:exit|return)\s+\$\?/g, '').replace(/(?<![\w.-])(?:exit|return)\s+[1-9]\d*(?![\w$])/g, '');
  return /(?<![\w.-])(?:exec|exit|return)(?![\w.-])/.test(rest);
}

// The script's command lines, as the shell reads them: a \ before a line end joins the
// lines, a quote stays open across lines, a comment is dropped, and a line after one that
// ends in `||`, `&&` or `|` belongs to it. Blank lines are left out.
function scriptLines(script: string): string[] {
  const lines: string[] = [];
  let goesOn = false; // the last line ends in ||, && or | (or |&), so the next one joins it
  const add = (text: string) => {
    const line = text.trim();
    if (line === '') return;
    if (goesOn) lines[lines.length - 1] += ` ${line}`;
    else lines.push(line);
    goesOn = line.endsWith('|') || line.endsWith('&&') || line.endsWith('|&');
  };
  let line = '';
  let quote = ''; // the open quote: ', " or $'
  for (let at = 0; at < script.length; at++) {
    spend(1);
    const character = script[at];
    const next = script[at + 1] ?? '';
    if (quote === "'") {
      line += character;
      if (character === "'") quote = '';
    } else if (character === '\\' && (next === '\n' || (next === '\r' && script[at + 2] === '\n')) && quote !== "$'") {
      at += next === '\r' ? 2 : 1; // the line goes on
    } else if (character === '\\') {
      line += character + next;
      at++;
    } else if (quote) {
      line += character;
      if ((quote === '"' && character === '"') || (quote === "$'" && character === "'")) quote = '';
    } else if (character === "'" || character === '"') {
      quote = character;
      line += character;
    } else if (character === '$' && next === "'") {
      quote = "$'";
      line += "$'";
      at++;
    } else if (character === '#' && /^$|[\s;&|()]$/.test(line.slice(-1))) {
      while (at + 1 < script.length && script[at + 1] !== '\n') at++;
    } else if (character === '\n') {
      add(line);
      line = '';
    } else line += character;
  }
  add(line);
  return lines;
}

// How many blocks a line opens, less those it closes: keywords that lead a command, and
// ( and { and their closers outside quotes, ${...} and $(...).
function blockDepth(line: string): number {
  let depth = 0;
  for (const words of commandWords(line)) {
    for (const word of words) {
      if (OPENERS.has(word)) depth++;
      else if (CLOSERS.has(word)) depth--;
      else if (!KEYWORDS.has(word)) break;
    }
  }
  for (const character of withoutSubstitutions(withoutQuotes(line))) {
    if (character === '(' || character === '{') depth++;
    else if (character === ')' || character === '}') depth--;
  }
  return depth;
}

// The line without its '...' and "..." strings (a " string takes \ escapes). An unclosed
// quote stays as it is. Once a quote finds no end, no later one of its kind does, so each
// kind is looked for to the end of the line at most once.
function withoutQuotes(line: string): string {
  let out = '';
  const closes = new Set(["'", '"']); // the kinds that may still close
  for (let at = 0; at < line.length; at++) {
    const character = line[at];
    const end = closes.has(character) ? closeQuote(line, at) : -1;
    if (end !== -1) at = end;
    else {
      closes.delete(character);
      out += character;
    }
  }
  return out;
}

// The index of the quote that closes the one at `at`, or -1.
function closeQuote(line: string, at: number): number {
  if (line[at] === "'") return line.indexOf("'", at + 1);
  for (let i = at + 1; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') return i;
  }
  return -1;
}

// The text without ${...} and $(...) (also $((...)) and more parens): from the opener to the
// first } or ), with the run of ) after it. An opener with no closer after it stays, and
// then no later opener of its kind has one either.
function withoutSubstitutions(text: string): string {
  let out = '';
  const closes = new Set(['}', ')']); // the closers still found further on
  for (let at = 0; at < text.length; at++) {
    const closer = text[at] !== '$' ? '' : text[at + 1] === '{' ? '}' : text[at + 1] === '(' ? ')' : '';
    const end = closes.has(closer) ? text.indexOf(closer, at + 2) : -1;
    if (end === -1) {
      closes.delete(closer);
      out += text[at];
      continue;
    }
    at = end;
    if (closer === ')') while (text[at + 1] === ')') at++;
  }
  return out;
}

// What git prints, trimmed, or null when it fails. Within one checkCommand each question
// goes to git once: a command that sets core.hooksPath many times starts git twice, not
// twice for each.
let gitAnswers: Map<string, string | null> | null = null;

function readGit(directory: string, args: string[], env: Env): string | null {
  const key = [directory, ...args].join('\0');
  if (gitAnswers?.has(key)) return gitAnswers.get(key) ?? null;
  let answer: string | null;
  try {
    answer = execFileSync('git', args, { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    answer = null;
  }
  gitAnswers?.set(key, answer);
  return answer;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The visibility a `gh repo` call ends up with: `--visibility[=]x`, `--public`, `--private`; the last one wins. */
function visibilityOf(args: string[]): string | undefined {
  let value: string | undefined;
  for (const [at, word] of args.entries()) {
    if (word.startsWith('--visibility=')) value = word.slice('--visibility='.length);
    else if (word === '--visibility') value = args[at + 1];
    else if (word === '--public') value = 'public';
    else if (word === '--private' || word === '--internal') value = 'private';
  }
  return value;
}

// A word anywhere after the program counts, so an option in between (`npm --tag x publish`)
// does not hide it. `npm run publish` blocks too: the script may well publish.
function checkPublish(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_RELEASE_APPROVAL) return null;
  const after = (names: string[]) => {
    const i = words.findIndex((w) => names.includes(base(w).replace(/\.(exe|cmd)$/i, '')));
    return i === -1 ? [] : words.slice(i + 1);
  };
  const gh = after(['gh']);
  const sub = gh.indexOf('release');
  if (sub !== -1 && gh.slice(sub + 1).some((a) => ['create', 'upload', 'edit'].includes(a))) return release('gh release publishes a release');
  const repo = gh.indexOf('repo');
  const repoCall = repo === -1 ? '' : gh[repo + 1] ?? '';
  // gh keeps the last value when a visibility flag comes twice, so the last one counts.
  if ((repoCall === 'create' || repoCall === 'edit') && visibilityOf(gh.slice(repo + 2)) === 'public') {
    return release(repoCall === 'create' ? 'creating a public repo' : 'making the repo public');
  }
  if (after(['npm', 'pnpm', 'yarn']).includes('publish')) return release('this publishes a package');
  return null;
}

// What a gh command posts (#391). The title of an issue or a pull request gets the title
// check `yokoten bot` runs, so plain gh can't open one CI then fails. Then the text (an
// issue, a pull request, a comment, a release note) gets the privacy check: see privacy.ts.
// The privacy check comes first: a title is checked by it too, and a leak matters more.
function checkPosted(
  words: string[],
  { env, config, cwd, from, command, titles, files }: { env: Env; config?: Partial<Pick<Config, 'privacy' | 'areas'>>; cwd: string | null; from: string | null; command: string; titles: boolean; files: CommandFiles },
): Finding | null {
  const at = ghIndex(words, findProgramPlaces(words));
  if (at === -1) return null;
  const gh = ghCommand(words, at);
  const leak = checkPost(gh, { env, privacy: config?.privacy, cwd, from, command, files });
  if (leak || !titles) return leak;
  const [title] = checkCommandTitle([words[at], ...gh.args], config ?? {});
  return title ?? null;
}

// The words after gh without the shell's redirects, and what a `< file` or a `<<<` feeds
// to its stdin. Only an unquoted `<` counts: `--body "<"` is text. The reader does not mark
// a here-string, so any `<<<` counts: read wrongly, it only adds text to scan.
function ghCommand(words: string[], at: number): GhCommand {
  const marks = unquotedRedirects.get(words);
  const gh: GhCommand = { args: withoutShellRedirects(words, at + 1) };
  for (let index = at + 1; index < words.length; index++) {
    if (!marks?.has(index) && !words[index].startsWith('<<<')) continue;
    const redirect = /^0?(<<<|<)(?![<>&])(.*)$/s.exec(words[index]);
    if (!redirect) continue;
    const target = redirect[2] || words[index + 1];
    if (target === undefined) continue;
    if (redirect[1] === '<<<') gh.hereString = target;
    else gh.stdinFile = target;
  }
  return gh;
}

// ---- A body file the same command writes (#439) ----
//
// The guard runs before the command, so a file the command writes on its way to gh is not
// there yet. It follows one shape only, the whole command:
//
//   cat > body.md <<'EOF' && gh issue create --title "..." --body-file body.md
//   ...the body...
//   EOF
//
// The path is plain (letters, digits, . _ / -, or a leading ~/), the delimiter is a name in
// single quotes, the body ends at the first line that is the delimiter, and the gh line passes
// isPlainCommand. The guard then checks the heredoc's text, and the file on disk too when there
// is one, in case cat can't replace it. In any other command, a file on disk is trusted only
// when the whole command is plain and every other command surely writes no file; otherwise
// the command is refused (record 0014).

const HEREDOC_POST = /^cat[ \t]+>[ \t]*((?:~\/)?[A-Za-z0-9._/][A-Za-z0-9._/-]*)[ \t]+<<'([A-Za-z_]\w*)'[ \t]*&&[ \t]*(gh[ \t][^\n]*)$/;

/** The path and text of `cat > path <<'EOF' && gh …`, when that is the whole command; otherwise undefined. */
function heredocPost(command: string, commands: string[][]): { path: string; text: string } | undefined {
  const end = command.indexOf('\n');
  const first = end === -1 ? null : HEREDOC_POST.exec(command.slice(0, end));
  if (!first || !isPlainCommand(first[3])) return undefined;
  const [, path, delimiter] = first;
  const lines = command.slice(end + 1).split('\n');
  const close = lines.indexOf(delimiter);
  // Nothing after the delimiter line but one line end.
  if (close === -1 || lines.length > close + 2 || (lines.length === close + 2 && lines[close + 1] !== '')) return undefined;
  // The reader agrees: cat writes the path, then gh runs, and nothing else.
  const [cat, post] = commands;
  const writes = cat?.[0] === 'cat' && ((cat.length === 3 && cat[1] === '>' && cat[2] === path) || (cat.length === 2 && cat[1] === `>${path}`));
  if (commands.length !== 2 || !writes || post[0] !== 'gh') return undefined;
  return { path, text: lines.slice(0, close).join('\n') };
}

// Commands that surely write no file (#439). Each list allows; anything else may write.
// Shell variables that change what bash runs or where it looks: setting one is not plain.
const SHELL_SPECIAL = /^(?:PS\d|PROMPT_\w*|HOME|PATH|CDPATH|IFS|ENV|BASH\w*|SHELLOPTS|BASHOPTS|TMOUT|HIST\w*|histchars|MAIL\w*|GLOBIGNORE|FIGNORE|EXECIGNORE|OLDPWD|PWD|OPTIND|OPTERR|POSIXLY_CORRECT|INPUTRC|TIMEFORMAT|FUNCNEST|COMP\w*|TMPDIR|SHELL|BROWSER|LD_\w*|DYLD_\w*|NODE_\w*|GIT_\w*|GH_\w*|LANG|LC_\w*)$/;
// The only variables an `export` or a command's own `X=1 cmd` may set. TZ only as
// TZ=UTC (#488): gh sends it as its Time-Zone header, so UTC keeps merges on UTC.
const EXPORTS = new Set(['GH_REPO', 'GH_HOST', 'NODE_USE_ENV_PROXY']);
const NAME_VALUE = /^([A-Za-z_]\w*)=/s;

/**
 * Whether a word sets a variable the guard trusts next to a gh post: a name in EXPORTS,
 * or TZ to UTC. A bare `export TZ` names a value the guard can't see, so it is refused.
 */
function isTrustedVariable(word: string): boolean {
  const name = NAME_VALUE.exec(word)?.[1] ?? word;
  if (EXPORTS.has(name)) return true;
  return name === 'TZ' && word.slice('TZ='.length) === 'UTC';
}
// `set` only for these: errexit, nounset and pipefail.
const SET_FLAGS = /^[-+][eu]+$/;
// Characters the shell takes as written outside quotes.
const PLAIN = /[A-Za-z0-9 \t._/=:,@%+-]/;
// Characters that are not literal inside "...": a value, a substitution, an escape, history.
const DOUBLE_QUOTED_SPECIAL = /[$`\\!]/;

// Whether the shell surely takes this command as written (#439): one line of plain words,
// joined only by ; and &&. Outside quotes it allows only PLAIN characters: no \, $, backticks,
// < or > (so no heredoc, redirect or substitution), no ( ) { } |, lone &, #, *, ? or [. A ~
// only starts a word, alone or before a /. Inside "..." it refuses only $, backticks, \ and !.
// The guard does not follow bash's grammar any further than this: anything else makes a
// body file on disk unsure. One pass over the text.
export function isPlainCommand(text: string): boolean {
  return plainBreak(text) === -1;
}

// Where the text stops being plain (see isPlainCommand): the index of the first character
// the guard does not trust, the text's length for a quote left open, or -1 when it is plain.
function plainBreak(text: string): number {
  let quote = ''; // '' outside quotes, or ' or "
  let wordStart = true;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\n' || character === '\r') return index;
    if (quote === "'") {
      if (character === "'") quote = '';
    } else if (quote === '"') {
      if (character === '"') quote = '';
      else if (DOUBLE_QUOTED_SPECIAL.test(character)) return index;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === '&') {
      if (text[index + 1] !== '&') return index;
      index++;
    } else if (character === '~') {
      // `~+`, `~-`, `~1`, `~user` and `~'/x'` are not $HOME: only `~` and `~/` are.
      if (!wordStart || !/^(?:[/ \t;&]|$)/.test(text[index + 1] ?? '')) return index;
    } else if (character !== ';' && !PLAIN.test(character)) return index;
    wordStart = quote === '' && /[ \t;&]/.test(character);
  }
  return quote === '' ? -1 : text.length;
}

// ---- Naming what may write a body file (#498) ----
//
// A refusal names what the guard saw, so the agent knows what to leave out. The name only
// reports; the checks above decide.

const VARIABLE_RISK = 'a variable other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC set for a command';
const SHELL_VARIABLE_RISK = 'a shell variable, such as PATH or IFS, that changes what bash runs';
const TILDE_RISK = 'a `~` that may not be your home folder';
// The word after a `|`, to name the program.
const PIPE_TARGET = /[ \t]*([^\s|;&<>()'"`$\\]*)/y;
const SHOWN_PROGRAM = /^[\w.+-]{1,40}$/;

/** What may change a body file on disk before the gh in `words` reads it, or undefined (#439). */
// `plainText` is the command as the plain check reads it, and `plainAt` where it stops being
// plain (-1: all plain, so the `~` check failed). A word that holds a private mark is not
// named (`isMarked`).
type RiskInput = { heredoc?: object; plainText: string; plainAt: number; fills: boolean; writers: string[][]; isMarked: (word: string) => boolean };

function writeRisk(words: string[], { heredoc, plainText, plainAt, fills, writers, isMarked }: RiskInput): Risk | undefined {
  if (heredoc !== undefined) return { what: 'a `cat >` heredoc' };
  if (fills && hasSedValue(plainText)) return SED_VALUE_RISK;
  if (fills) return { what: plainAt === -1 ? TILDE_RISK : breakName(plainText, plainAt, isMarked) };
  if (writesFile(words)) return { what: 'a redirect into a file' };
  if (isUnsure(words)) return { what: variableRisk(words) };
  const other = writers.find((command) => command !== words);
  return other && writerRisk(other, isMarked);
}

function breakName(text: string, at: number, isMarked: (word: string) => boolean): string {
  if (at >= text.length) return 'a quote that is not closed';
  const character = text[at];
  const next = text[at + 1] ?? '';
  switch (character) {
    case '$':
      return next === '(' ? 'a command substitution `$(…)`' : 'a `$` value the shell fills in';
    case '`':
      return 'a command substitution in backquotes';
    case '|':
      return next === '|' ? 'a `||`' : pipeName(text, at, isMarked);
    case '>':
    case '<':
      return `a redirect \`${character}\``;
    case '&':
      return 'a `&` that runs a command in the background';
    case '(':
    case ')':
      return 'a subshell `( … )`';
    case '{':
    case '}':
      return 'a `{ … }` group or brace expansion';
    case '\n':
      return 'a second line';
    case '\r':
      return 'a carriage return';
    case '\\':
      return 'a backslash';
    case '!':
      return 'a `!` inside "..."';
    case '~':
      return TILDE_RISK;
    case '#':
      return 'a `#` comment';
    case '[':
      if (/^[ \t]/.test(next) && (at === 0 || /[ \t;&]/.test(text[at - 1]))) return 'a `[ … ]` test';
      return 'a pattern `[` the shell expands';
    case '*':
    case '?':
      return `a pattern \`${character}\` the shell expands`;
  }
  return 'a character the guard does not trust';
}

const SED_VALUE_RISK: Risk = { what: 'a `$` value in a `sed` command', fix: 'type the value into the sed script in place of the `$`, or leave out the pipe' };

// Whether a sed after a pipe holds a `$`. This only picks the name, so it splits at every
// `|`, quoted or not: the pipe scan has already refused the command.
function hasSedValue(text: string): boolean {
  return text.split('|').some((part, index) => index > 0 && /^[ \t]*sed[ \t]/.test(part) && part.includes('$'));
}

function pipeName(text: string, at: number, isMarked: (word: string) => boolean): string {
  PIPE_TARGET.lastIndex = at + 1;
  const program = base(PIPE_TARGET.exec(text)?.[1] ?? '');
  if (PIPE_READERS.has(program)) return `a pipe to \`${program}\` that does not end the line in plain words`;
  return SHOWN_PROGRAM.test(program) && !isMarked(program) ? `a pipe to \`${program}\`` : 'a pipe';
}

function variableRisk(words: string[]): string {
  return words.every((word) => NAME_VALUE.test(word)) ? SHELL_VARIABLE_RISK : VARIABLE_RISK;
}

// A command that may write a file, by name.
function writerRisk(words: string[], isMarked: (word: string) => boolean): Risk {
  const at = ownVariables(words);
  if (at === -1) return { what: variableRisk(words) };
  if (writesFile(words)) return { what: 'a redirect into a file' };
  const program = base(words[at] ?? '');
  if (program === 'sed' && words.some((word) => word.includes('$'))) {
    return SED_VALUE_RISK;
  }
  if (program === 'sed') return { what: 'a `sed` with `-i`, `-f` or a script other than s/…/…/' };
  if (program === 'uniq') return { what: 'a `uniq` with a second file, which it writes' };
  if (PIPE_READERS.has(program)) return { what: `a \`${program}\` with an option that may write a file` };
  if (MOVERS.has(program)) return { what: `a \`${program}\` the guard can't follow` };
  if (program === 'export') return { what: 'an `export` of a name other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC' };
  if (isMarked(program)) return { what: 'a command' };
  return { what: SHOWN_PROGRAM.test(program) ? `a \`${program}\`` : 'a command the guard does not know' };
}

// A lone gh that reads its body from a file, `gh … --body-file - < body.md` (#391): the scan
// skips that one < at the end, since the file it names is the one checked.
function withoutStdin(command: string, commands: string[][]): string {
  const at = command.indexOf('<');
  if (commands.length !== 1 || at === -1 || at !== command.lastIndexOf('<')) return command;
  return /^[ \t]*[A-Za-z0-9._/-]+[ \t]*$/.test(command.slice(at + 1)) ? command.slice(0, at) : command;
}

// A word that starts with ~ is the folder of a cd or pushd, or the file after -F,
// --body-file or --notes-file (#439), or the yokoten of a `yokoten bot --` (#498), as in
// `node ~/x/bin/yokoten.ts bot -- gh …`. It is `~` or starts `~/`: the guard reads only those
// as $HOME. The words have lost their quotes, so a '~ or "~ in the command makes any ~
// word unsure: bash does not expand a quoted ~.
function tildesPlain(command: string, commands: string[][]): boolean {
  const isQuoted = /['"]~/.test(command);
  return commands.every((words) =>
    words.every(
      (word, index) =>
        !word.startsWith('~') ||
        (!isQuoted &&
          (word === '~' || word.startsWith('~/')) &&
          ((index === 1 && ['cd', 'pushd'].includes(words[0])) || ['-F', '--body-file', '--notes-file'].includes(words[index - 1] ?? '') || isBotCallAt(words, index))),
    ),
  );
}

// Whether the word at `index` is the yokoten of `yokoten bot --` or `node yokoten.ts bot --`,
// after only the command's own variables. Which yokoten runs does not change the file gh reads.
function isBotCallAt(words: string[], index: number): boolean {
  if (!isBotProgram(words[index]) || words[index + 1] !== 'bot' || words[index + 2] !== '--') return false;
  const start = ownVariables(words);
  return index === start || (index === start + 1 && words[start] === 'node');
}

/** Whether a command's own variables may change what it runs (#439). */
function isUnsure(words: string[]): boolean {
  return ownVariables(words) === -1;
}

// Where the program starts after a command's own `X=1` words, or -1 when one of them sets a
// variable outside EXPORTS. A command of assignments only gives its length.
function ownVariables(words: string[]): number {
  let at = 0;
  while (at < words.length && NAME_VALUE.test(words[at])) at++;
  if (at === words.length) return words.every((word) => !SHELL_SPECIAL.test(NAME_VALUE.exec(word)?.[1] ?? '')) ? at : -1;
  return words.slice(0, at).every(isTrustedVariable) ? at : -1;
}

/**
 * Whether a command surely writes no file, so a body file on disk is still the one gh posts
 * (#439): no redirect into a file, no word that may run code, and either plain assignments
 * (a substitution in one is a command of its own, checked the same way) or a read in
 * `readsOnly`, maybe through `yokoten bot --`. Anything else may write one.
 */
function writesNoFile(words: string[]): boolean {
  if (writesFile(words) || isUnsure(words)) return false;
  const at = ownVariables(words);
  return at === words.length || readsOnly(words.slice(at));
}

function readsOnly(words: string[]): boolean {
  const [program = '', sub = '', action = ''] = words;
  const args = words.slice(1);
  switch (program) {
    case 'true':
    case ':':
    case 'echo':
      return true;
    case 'printf':
      return !args.some((arg) => arg.startsWith('-v'));
    case 'test':
    case '[':
      return !args.includes('-v');
    case 'set':
      return args.length > 0 && args.every((arg, index) => SET_FLAGS.test(arg) || (/^[-+]o$/.test(arg) && args[index + 1] === 'pipefail') || (arg === 'pipefail' && /^[-+]o$/.test(args[index - 1] ?? '')));
    case 'export':
      return args.length > 0 && args.every(isTrustedVariable);
    case 'cd':
    case 'pushd':
      // A bare cd goes home, `cd -` to OLDPWD, and `pushd +1` round the stack: not followed.
      return args.length === 1 && !/^[-+]/.test(args[0]);
    case 'popd':
      return true;
    // The programs a read-only pipe may feed (#498). These have no option that writes a file.
    case 'tail':
    case 'head':
    case 'grep':
    case 'cut':
    case 'wc':
    case 'tr':
      return true;
    // These have one, so each word is checked. A word with a `$` may hold an option.
    case 'sort':
      return args.every((arg) => !arg.includes('$') && (!arg.startsWith('-') || SORT_OPTION.test(arg) || SORT_LONG_OPTIONS.has(arg)));
    case 'uniq':
      // `uniq input output` writes output; a lone `-` is the input.
      return args.every((arg) => !arg.includes('$') && (!arg.startsWith('-') || UNIQ_OPTION.test(arg))) && args.filter((arg) => arg === '-' || !arg.startsWith('-')).length <= 1;
    case 'sed':
      return sedReadsOnly(args);
    case 'gh':
      // `--web` opens a browser, which runs a program.
      return ['pr', 'issue', 'repo', 'run'].includes(sub) && ['view', 'list', 'checks'].includes(action) && !args.some((arg) => /^--web(=|$)/.test(arg) || /^-[A-Za-z]*w/.test(arg));
    case 'git':
      // Most git commands run repo config (fsmonitor, textconv, gpg); these few do not.
      if (sub === 'rev-parse') return args.slice(1).every((arg) => !arg.startsWith('--output'));
      if (sub === 'config') return words.length === 4 && action === '--get' && !words[3].startsWith('-');
      if (sub === 'remote') return words.length === 4 && action === 'get-url';
      return false;
  }
  // `yokoten bot -- x`, `node bin/yokoten.ts bot -- x`
  const bot = program === 'node' ? 1 : 0;
  if (isBotProgram(words[bot] ?? '') && words[bot + 1] === 'bot' && words[bot + 2] === '--') return readsOnly(words.slice(bot + 3));
  return false;
}

// sort's options that write nothing and run nothing: no -o, -T or --compress-program (#498).
// Flags, then at most one key (`-rk2,2n`) or one `-t`: the flags hold no `k` or `t`, so the parts
// can't overlap and the test stays linear (CodeQL found the older form exponential).
const SORT_OPTION = /^-[bdfghiMnRrsuVz]*(?:t.?|k[\d.,bdfghiMnRrV]*)?$/;
const SORT_LONG_OPTIONS = new Set(['--reverse', '--numeric-sort', '--unique', '--human-numeric-sort', '--version-sort', '--ignore-case', '--stable']);
const UNIQ_OPTION = /^-[cdDiuz]*(?:[fsw]\d*)?$/;
// sed's options that write nothing: no -i, --in-place or -f (a script from a file).
const SED_OPTION = /^-[nErsuz]+$/;
const SED_LONG_OPTIONS = new Set(['--posix', '--debug', '--sandbox', '--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data']);

// Whether a sed only prints (#498): the options above, and scripts that are only
// s/…/…/ commands, joined by `;`, with no w or e flag. Any other script is refused,
// since `w` writes a file and `e` runs one. A `$` anywhere is refused: bash fills in a
// value before sed reads the script, and a value can hold the delimiter and then `w`.
function sedReadsOnly(args: string[]): boolean {
  if (args.some((arg) => arg.includes('$'))) return false;
  let hasScript = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-e' || arg.startsWith('--expression=')) {
      const script = arg === '-e' ? args[++index] : arg.slice('--expression='.length);
      if (script === undefined || !isSubstitution(script)) return false;
      hasScript = true;
    } else if (arg.startsWith('-')) {
      if (!SED_OPTION.test(arg) && !SED_LONG_OPTIONS.has(arg)) return false;
    } else if (!hasScript) {
      if (!isSubstitution(arg)) return false;
      hasScript = true;
    }
  }
  return hasScript;
}

// Whether a sed script is only s/…/…/ commands, joined by `;`. Flags: g, p, i, I, m, M, digits.
function isSubstitution(script: string): boolean {
  let index = 0;
  for (;;) {
    if (script[index] !== 's') return false;
    const delimiter = script[index + 1] ?? '';
    if (!delimiter || /[\s\\$A-Za-z0-9]/.test(delimiter)) return false;
    index += 2;
    for (let part = 0; part < 2; part++) {
      while (index < script.length && script[index] !== delimiter) index += script[index] === '\\' ? 2 : 1;
      if (script[index] !== delimiter) return false;
      index++;
    }
    while (index < script.length && /[gpiImM0-9]/.test(script[index])) index++;
    if (index === script.length) return true;
    if (script[index] !== ';') return false;
    index++;
    while (script[index] === ' ') index++;
  }
}

// Whether a command's own redirects write a file: `gh … > body.md` empties it before gh reads it.
function writesFile(words: string[]): boolean {
  for (const index of unquotedRedirects.get(words) ?? []) {
    const redirect = WRITE_REDIRECT.exec(words[index]);
    const path = redirect && (redirect[2] || words[index + 1]);
    if (path && path !== '/dev/null' && !(redirect[1] === '>&' && /^(\d+|-)$/.test(path))) return true;
  }
  return false;
}

// A quote or backslash before or after a ~: bash then does not read that ~ as the home folder.
const QUOTED_TILDE = /[\\'"]~|~[\\'"]/;

// The folder after a `cd` or `pushd` with a plain path, or null when the guard can't tell:
// a variable, a substitution, `cd -`, `popd`, a ~ that was quoted (`isTildeQuoted`, #465):
// bash keeps a quoted ~ as a folder named ~, or a bare relative folder (#559): bash
// searches CDPATH for one, and CDPATH may be set in the shell without being exported.
// Any other command leaves the folder as it was.
function folderAfter(words: string[], folder: string | null, { env, isTildeQuoted, isCdPathSkipped = false }: { env: Env; isTildeQuoted: boolean; isCdPathSkipped?: boolean }): string | null {
  const name = programName(words[0] ?? '');
  if (name === 'popd') return null;
  if (name !== 'cd' && name !== 'pushd') return folder;
  const target = words.slice(1).find((word) => !/^-[LPe@]+$/.test(word));
  if (target === undefined) return env.HOME ?? null;
  if (target === '-' || /[$`*?[]/.test(target) || /^~[^/]/.test(target)) return null;
  if (target.startsWith('~') && isTildeQuoted) return null;
  const path = target.startsWith('~') ? (env.HOME ? join(env.HOME, target.slice(1)) : null) : target;
  if (path === null) return null;
  if (isAbsolute(path)) return path;
  // Only `/`, `./`, `../` and `.` and `..` alone say where a relative `cd` goes: bash
  // searches CDPATH for the rest, even with a `/` inside (`cd sub/dir`).
  // `isCdPathSkipped` reads it as written instead: the likely folder, never a sure one.
  if (!isCdPathSkipped && target !== '.' && target !== '..' && !target.startsWith('./') && !target.startsWith('../')) return null;
  return folder === null ? null : resolve(folder, path);
}

// ---- Lead-only files a worker's command writes (#402) ----
//
// The edit guard stops a worker's edit tool on a lead-only file. A shell write gets the
// same answer here: a redirect (`>`, `>>`, `&>`, `<>`, `>&file`), the files of the common
// writers in WRITERS, git's own writes (checkout, restore, rm, mv, apply), and the files
// a `git commit` would commit. A read (`cat`, `grep`, `sed -n`) writes nothing and passes.
// The commit check refuses the same commit only when the session has YOKOTEN_ROLE=worker,
// so for a subagent named worker the guard is what stops it. Like the rest of the guard
// it reads text: a target from a variable or stdin (`xargs rm`, `find -exec ... {}`,
// `git apply < x.patch`), or a script's own writes, gets past it.
//
// The rules apply where the edit guard's do: in the repos the hook rules (`judge`), and in
// a repo with a yokoten.json above the file. A worker in any other repo is not stopped.

/**
 * A file a command writes, as written, and the folder it is relative to (null: unknown).
 * `isUnread`: the path is a patch whose files the guard could not read, so what it writes
 * is unknown.
 */
type WriteTarget = { path: string; from: string | null; isUnread?: boolean };

/** The largest patch the guard reads for the files it names. */
const PATCH_LIMIT = 1 << 20;

// A redirect that writes its file. `>&2` copies a stream; `>&file` writes a file.
const WRITE_REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(>>|>\||<>|>&|>)(.*)$/s;

const UNSURE_FOLDER_FIX = 'write the file by its full path, or first move to a folder the guard can read (an absolute folder, `./`, `../` or `~`), then write again';

// Whether a write target may be anywhere: a relative path from an unknown folder (#559).
// A `~` that names home is read as home, as in `ruled` below; anything else relative stays
// unsure, so unsure means refused wherever the folder is used.
function isUnsureTarget(target: WriteTarget, env: Env): boolean {
  if (target.from !== null || target.path === '' || target.path === '-') return false;
  const expanded = /^~(?=\/|$)/.test(target.path) && env.HOME ? join(env.HOME, target.path.slice(1)) : target.path;
  return !isAbsolute(expanded);
}

function checkLeadOnlyWrites(words: string[], { env, rules, folder }: { env: Env; rules: FileRules; folder: string | null }): Finding | null {
  // A folder counts when a lead-only file may be in it: `rm -r .github`.
  // A file in a worker worktree matches from that worktree (#571), as an edit does; the message keeps the full path.
  const stopped = (target: WriteTarget): string | null => {
    const ruled = rules.ruled(target, env);
    if (!ruled) return null;
    const inWorktree = stripWorktreeRoot(ruled.path);
    const matches = (path: string) => isLeadOnly(path, ruled.leadOnly);
    return (matches(inWorktree) || matches(`${inWorktree}/-`)) && !isGranted(inWorktree, env) ? ruled.path : null;
  };
  for (const target of writeTargets(words, folder, rules.rootOf)) {
    if (target.isUnread) {
      if (target.from === null && target.path !== '' && target.path !== '-') {
        return finding('lead-only', `this command applies ${target.path}, and yokoten can't tell which files it changes from an unknown folder`, UNSURE_FOLDER_FIX);
      }
      if (target.from !== null && rules.isRuled(target.from)) {
        return finding('lead-only', `this command applies ${base(target.path)}, and yokoten can't read which files it changes`, `apply a patch file under 1 MB, so the guard can read it, or ${LEAD_ONLY_FIX}`);
      }
      continue;
    }
    if (isUnsureTarget(target, env)) {
      return finding('lead-only', `this command writes ${target.path}, and yokoten can't tell which file that is from an unknown folder`, UNSURE_FOLDER_FIX);
    }
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this command writes ${path}, which is lead-only (yokoten.json "leadOnly")`, LEAD_ONLY_FIX);
  }
  for (const target of commitTargets(words, folder, rules.rootOf, env)) {
    if (isUnsureTarget(target, env)) {
      return finding('lead-only', `this commit changes ${target.path}, and yokoten can't tell which file that is from an unknown folder`, UNSURE_FOLDER_FIX);
    }
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this commit changes ${path}, which is lead-only (yokoten.json "leadOnly")`, `unstage it with \`git restore --staged ${path}\`, then ${LEAD_ONLY_FIX}`);
  }
  return null;
}

/**
 * The real path, through symlinks. git reports the repo root's real path, and a tool may
 * send a path through a symlink (on macOS, /var is /private/var). A file that does not
 * exist yet takes the real path of its nearest existing folder.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(realPath(parent), basename(path));
  }
}

/**
 * `ruled`: a target's path from its repo's root, and that repo's lead-only list; null when
 * no file rules apply. `rootOf`: the git root at or above a folder, from the same walks.
 */
type FileRules = {
  ruled: (target: WriteTarget, env: Env) => { path: string; leadOnly: string[] } | null;
  rootOf: (folder: string) => string | null;
  isRuled: (folder: string) => boolean;
};

/**
 * The file rules for one guard call. A file takes the deepest of `repos` that holds it, as
 * in `judge`; with the folder unknown, a relative path is taken as written, in the first
 * (the session's repo). A file outside them all takes the repo above it, found by one walk
 * up to its `.git`, when that repo has a yokoten.json. Walks and configs are kept for the
 * call, so a second file in the same folders reads nothing again.
 */
function fileRules(repos: RuledRepo[]): FileRules {
  const rootAbove = new Map<string, string | null>(); // folder → the git root above it
  const leadOnlyAt = new Map<string, string[] | null>(); // git root → its list, null without yokoten.json
  const rootOf = (folder: string) => gitRootAbove(folder, rootAbove);
  // Roots and files are compared by real path, as for an edit: a symlink to AGENTS.md is
  // AGENTS.md, and on macOS /var is /private/var. The roots are read once, on first use.
  let realRepos: RuledRepo[] | null = null;
  const ruled: FileRules['ruled'] = ({ path, from }, env) => {
    if (path === '' || path === '-') return null;
    const expanded = /^~(?=\/|$)/.test(path) && env.HOME ? join(env.HOME, path.slice(1)) : path;
    if (from === null && !isAbsolute(expanded)) {
      return repos.length ? { path: expanded.replace(/\\/g, '/').replace(/^(\.\/)+/, ''), leadOnly: repos[0].leadOnly } : null;
    }
    const full = realPath(resolve(from ?? '/', expanded));
    realRepos ??= repos.map((repo) => ({ ...repo, root: realPath(repo.root) }));
    let best: { path: string; leadOnly: string[] } | null = null;
    for (const repo of realRepos) {
      const inRepo = relative(repo.root, full);
      if (inRepo === '' || inRepo.startsWith('..') || isAbsolute(inRepo)) continue;
      if (!best || inRepo.length < best.path.length) best = { path: inRepo, leadOnly: repo.leadOnly };
    }
    if (best) return { ...best, path: best.path.split(sep).join('/') };
    const root = rootOf(dirname(full));
    if (root === null) return null;
    if (!leadOnlyAt.has(root)) leadOnlyAt.set(root, existsSync(join(root, 'yokoten.json')) ? loadConfig(root, { onProblem: () => {} }).leadOnly : null);
    const leadOnly = leadOnlyAt.get(root);
    return leadOnly ? { path: relative(root, full).split(sep).join('/'), leadOnly } : null;
  };
  // A folder is ruled when a file in it would be: `.git` stands for any file there.
  const isRuled = (folder: string) => ruled({ path: join(folder, '.git'), from: null }, {}) !== null;
  return { ruled, rootOf, isRuled };
}

// The nearest folder at or above `folder` with a `.git`. Each folder walked is kept, so a
// later walk stops where an earlier one passed.
function gitRootAbove(folder: string, known: Map<string, string | null>): string | null {
  const walked: string[] = [];
  let found: string | null = null;
  for (let dir = folder; ; dir = dirname(dir)) {
    if (known.has(dir)) {
      found = known.get(dir) ?? null;
      break;
    }
    walked.push(dir);
    if (existsSync(join(dir, '.git'))) {
      found = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  for (const dir of walked) known.set(dir, found);
  return found;
}

// `keepsRestores`: false leaves out `git checkout` and `git restore`, which bring back committed files.
function writeTargets(words: string[], folder: string | null, rootOf: FileRules['rootOf'], { keepsRestores = true } = {}): WriteTarget[] {
  const targets: WriteTarget[] = [];
  const marks = unquotedRedirects.get(words);
  for (const [index, word] of words.entries()) {
    // Words the reader did not make (the rough cut) have no marks: any redirect counts.
    if (readWords.has(words) ? !marks?.has(index) : !REDIRECT.test(word)) continue;
    const redirect = WRITE_REDIRECT.exec(word);
    const path = redirect && (redirect[2] || words[index + 1]);
    if (!path || (redirect[1] === '>&' && /^(\d+|-)$/.test(path))) continue;
    targets.push({ path, from: folder });
  }
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue; // from an `env -S` string
    from = at + 1;
    const name = programName(program);
    const args = withoutShellRedirects(words, at + 1);
    if (isGit(program)) {
      if (!keepsRestores && ['checkout', 'restore'].includes(gitParts(args, folder).sub ?? '')) continue;
      targets.push(...gitWrites(args, folder, rootOf));
    }
    else if (Object.hasOwn(WRITERS, name)) targets.push(...WRITERS[name](args, folder).map((path) => ({ path, from: folder })));
  }
  return targets;
}

/**
 * The words that are no option, in order: after `--` every word is one. `valued` are the
 * options whose value is the next word.
 */
export function plainArgs(args: string[], valued: string[] = []): string[] {
  const plain: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') return [...plain, ...args.slice(index + 1)];
    if (valued.includes(word)) index++;
    else if (!word.startsWith('-') || word === '-') plain.push(word);
  }
  return plain;
}

/** The value of the first of `names` in `args`: `-t x`, `-tx`, `--target-directory=x`. */
function optionValue(args: string[], names: string[]): string | undefined {
  for (const [index, word] of args.entries()) {
    for (const name of names) {
      if (word === name) return args[index + 1];
      if (name.startsWith('--') ? word.startsWith(`${name}=`) : word.startsWith(name) && word.length > 2) return word.slice(name.length + (name.startsWith('--') ? 1 : 0));
    }
  }
  return undefined;
}

// cp, mv, install and ln write their destination, and each source's name inside it when
// it is a folder: named by -t, ending in /, given more than one source, or one on disk.
// mv also removes its sources.
function copyTargets(args: string[], { valued, isMove, folder }: { valued: string[]; isMove: boolean; folder: string | null }): string[] {
  const plain = plainArgs(args, valued);
  const named = optionValue(args, ['-t', '--target-directory']);
  const sources = named === undefined ? plain.slice(0, -1) : plain;
  const into = named ?? plain.at(-1);
  if (into === undefined) return [];
  const isFolder = named !== undefined || into.endsWith('/') || sources.length > 1 || isFolderOnDisk(folder, into);
  return [...(isMove ? sources : []), into, ...(isFolder ? sources.map((source) => `${into}/${base(source)}`) : [])];
}

function isFolderOnDisk(folder: string | null, path: string): boolean {
  try {
    return statSync(resolve(folder ?? '.', path)).isDirectory();
  } catch {
    return false;
  }
}

// `sed -i`: the files after the script. A short option cluster ends at `i` (its suffix
// follows) or at e, f or l (their value follows).
function sedTargets(args: string[]): string[] {
  let isInPlace = false;
  let hasScript = false;
  const plain: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      plain.push(...args.slice(index + 1));
      break;
    }
    if (word.startsWith('--')) {
      if (/^--in-place(=|$)/.test(word)) isInPlace = true;
      if (/^--(expression|file)(=|$)/.test(word)) hasScript = true;
      if (/^--(expression|file|line-length)$/.test(word)) index++;
    } else if (word.startsWith('-') && word !== '-') {
      for (const [at, letter] of [...word].entries()) {
        if (at === 0) continue;
        if (letter === 'i') isInPlace = true;
        if (letter === 'e' || letter === 'f') hasScript = true;
        if ('efl'.includes(letter) && at === word.length - 1) index++;
        if ('iefl'.includes(letter)) break;
      }
    } else plain.push(word);
  }
  if (!isInPlace) return [];
  return hasScript ? plain : plain.slice(1);
}

// `perl -i` (`-pi`, `-i.bak`): the files after the script. Options end at the first plain
// word. In a cluster, e and E take the next word; I, M, m, F, C, x, d, D, l and 0 take
// the rest of the word.
function perlTargets(args: string[]): string[] {
  let isInPlace = false;
  let hasScript = false;
  let index = 0;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      index++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    for (const [at, letter] of [...word].entries()) {
      if (at === 0) continue;
      if (letter === 'i') isInPlace = true;
      if (letter === 'e' || letter === 'E') {
        hasScript = true;
        if (at === word.length - 1) index++;
      }
      if ('ieEIMmFCxdDl0'.includes(letter)) break;
    }
  }
  if (!isInPlace) return [];
  return hasScript ? args.slice(index) : args.slice(index + 1);
}

const COPY_VALUES = ['-t', '--target-directory', '-S', '--suffix'];
// Each writer by name, with the files it writes. Every other program is a read here.
const WRITERS: Record<string, (args: string[], folder: string | null) => string[]> = {
  tee: (args) => plainArgs(args),
  truncate: (args) => plainArgs(args, ['-s', '--size', '-r', '--reference']),
  rm: (args) => plainArgs(args),
  rmdir: (args) => plainArgs(args),
  unlink: (args) => plainArgs(args),
  shred: (args) => plainArgs(args, ['-n', '--iterations', '-s', '--size']),
  sed: sedTargets,
  perl: perlTargets,
  cp: (args, folder) => copyTargets(args, { valued: COPY_VALUES, isMove: false, folder }),
  ln: (args, folder) => copyTargets(args, { valued: COPY_VALUES, isMove: false, folder }),
  mv: (args, folder) => copyTargets(args, { valued: COPY_VALUES, isMove: true, folder }),
  install: (args, folder) => copyTargets(args, { valued: [...COPY_VALUES, '-m', '--mode', '-o', '--owner', '-g', '--group', '--strip-program'], isMove: false, folder }),
  dd: (args) => args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice('of='.length)),
  // A download writes its output file, or into its output folder (#591).
  curl: (args) => optionValues(args, ['o'], ['--output', '--output-dir']),
  wget: (args) => optionValues(args, ['O', 'o', 'a', 'P'], ['--output-document', '--output-file', '--append-output', '--directory-prefix']),
};

const PATCH_VALUES = ['-i', '--input', '-o', '--output', '-p', '-d', '--directory', '-B', '--prefix', '-D', '-F', '-r', '--reject-file', '-z', '--suffix', '-V', '-Y', '--basename-prefix'];
const EDITOR_VALUES = ['-c', '--cmd', '-S', '-u', '-U', '-i', '-T', '-w', '-W', '-s', '-t', '-q', '--listen'];

// vim and its kin: every file named; `+cmd` is a command, not a file.
const editorTargets = (args: string[]) => plainArgs(args, EDITOR_VALUES).filter((arg) => !arg.startsWith('+'));

// `awk -i inplace`: the files after the program text, or every plain word with -f or -e.
function awkTargets(args: string[]): string[] {
  const isInPlace = args.some((arg, at) => arg === '-iinplace' || arg === '--include=inplace' || ((arg === '-i' || arg === '--include') && args[at + 1] === 'inplace'));
  if (!isInPlace) return [];
  const plain = plainArgs(args, ['-f', '--file', '-v', '--assign', '-i', '--include', '-F', '--field-separator', '-l', '--load', '-e', '--source']);
  return args.some((arg) => /^(-[fe]|--file|--source)/.test(arg)) ? plain : plain.slice(1);
}

// More writers, read for git's config and hooks only (#361): editors and patchers change the
// files they name. A patch with no file named changes the files in the patch, which the
// guard does not read. They are not in WRITERS, whose files the lead-only rule also reads.
const SETUP_WRITERS: Record<string, (args: string[]) => string[]> = {
  patch: (args) => [...plainArgs(args, PATCH_VALUES).slice(0, 1), ...optionValues(args, ['o', 'd', 'r'], ['--output', '--directory', '--reject-file'])],
  ed: (args) => plainArgs(args, ['-p', '--prompt']),
  ex: (args) => editorTargets(args),
  vi: (args) => editorTargets(args),
  vim: (args) => editorTargets(args),
  nvim: (args) => editorTargets(args),
  awk: (args) => awkTargets(args),
  gawk: (args) => awkTargets(args),
  // An archive unpacks into its folder: `tar -x -C dir`, `unzip -d dir`.
  tar: (args) => (/^[A-Za-z]*x[A-Za-z]*$/.test(args[0] ?? '') || args.some((arg) => /^(-[A-Za-z]*x[A-Za-z]*|--extract|--get)$/.test(arg)) ? optionValues(args, ['C'], ['--directory']) : []),
  unzip: (args) => optionValues(args, ['d'], []),
};

/**
 * Every value of the options named: `--long value`, `--long=value`, `-x value`, `-xvalue`,
 * and `-abx value`, where `x` ends a group of short options. `letters` are the short ones.
 */
function optionValues(args: string[], letters: string[], longs: string[]): string[] {
  const values: string[] = [];
  for (const [at, arg] of args.entries()) {
    if (arg === '--') break;
    const long = longs.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (long) values.push(arg === long ? (args[at + 1] ?? '') : arg.slice(long.length + 1));
    else if (/^-[A-Za-z]/.test(arg)) {
      if (letters.includes(arg[1]) && arg.length > 2) values.push(arg.slice(2));
      else if (letters.some((letter) => arg.endsWith(letter) && /^-[A-Za-z]+$/.test(arg))) values.push(args[at + 1] ?? '');
    }
  }
  return values.filter(Boolean);
}

/** git's subcommand, its arguments and the folder it works in (null: unknown), from the git word on. */
function gitParts(args: string[], folder: string | null): { sub: string | undefined; args: string[]; dir: string | null } {
  let dir = folder;
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '-C') dir = dir === null ? null : resolve(dir, args[index + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(args[index])) dir = null;
    index += GIT_VALUE_OPTIONS.has(args[index]) ? 2 : 1;
  }
  return { sub: args[index], args: args.slice(index + 1), dir };
}

// git's own writes to files in the work tree. A patch's files are read from the patch.
function gitWrites(words: string[], folder: string | null, rootOf: FileRules['rootOf']): WriteTarget[] {
  const { sub, args, dir } = gitParts(words, folder);
  const at = (paths: string[]) => paths.map((path) => ({ path, from: dir }));
  if (sub === 'checkout') return at(args.includes('--') ? args.slice(args.indexOf('--') + 1) : plainArgs(args, ['-b', '-B', '--orphan']));
  // `git restore --staged` alone changes only what is staged: the way to undo a `git add`.
  const isIndexOnly = args.some((arg) => arg === '--staged' || arg === '-S') && !args.some((arg) => arg === '--worktree' || arg === '-W');
  if (sub === 'restore') return isIndexOnly ? [] : at(plainArgs(args, ['-s', '--source']));
  if (sub === 'rm') return at(plainArgs(args));
  if (sub === 'mv') return at(copyTargets(args, { valued: [], isMove: true, folder: dir }));
  if (sub !== 'apply') return [];
  if (dir === null) {
    // From an unknown folder a patch file cannot be placed, so what it changes is
    // unknown: unsure means refused where the folder is used (#559). `-` is stdin.
    return plainArgs(args, ['-p', '--exclude', '--include', '--directory'])
      .filter((patch) => patch !== '-')
      .map((patch) => ({ path: patch, from: dir, isUnread: true }));
  }
  const root = rootOf(dir);
  if (!root) return [];
  const targets: WriteTarget[] = [];
  // `-` is stdin, which the guard never reads. A patch is read only as a plain file of at
  // most PATCH_LIMIT bytes: never a FIFO, a device or /dev/stdin, which could wait or be huge.
  for (const patch of plainArgs(args, ['-p', '--exclude', '--include', '--directory']).filter((arg) => arg !== '-')) {
    const file = resolve(dir, patch);
    let isReadable = false;
    try {
      const stat = statSync(file);
      isReadable = stat.isFile() && stat.size <= PATCH_LIMIT;
    } catch {
      isReadable = false;
    }
    if (!isReadable) targets.push({ path: patch, from: dir, isUnread: true });
    else targets.push(...patchFiles(readText(file)).map((path) => ({ path: join(root, path), from: root })));
  }
  return targets;
}

// The files a patch names: `diff --git a/x b/y`, `--- a/x` and `+++ b/y`.
function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) files.push(header[1], header[2]);
    const side = /^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/.exec(line);
    if (side && side[1] !== '/dev/null') files.push(side[1]);
  }
  return files;
}

// `git commit` options whose value is the next word.
const COMMIT_VALUES = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--cleanup', '--template', '--trailer', '--pathspec-from-file']);

/**
 * The files a `git commit` commits, as full paths: its pathspecs when it names any, else
 * what is staged, and with -a what is changed too. In a short option cluster, m, F, C, c
 * and t take a value; S and u take the rest of the word.
 */
function commitTargets(words: string[], folder: string | null, rootOf: FileRules['rootOf'], env: Env): WriteTarget[] {
  const start = words.findIndex(isGit);
  if (start === -1) return [];
  const { sub, args, dir } = gitParts(withoutShellRedirects(words, start + 1), folder);
  if (sub !== 'commit') return [];
  let isAll = false;
  let isInclude = false;
  const named: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      named.push(...args.slice(index + 1));
      break;
    }
    if (word.startsWith('--')) {
      if (word === '--all') isAll = true;
      if (word === '--include') isInclude = true;
      if (COMMIT_VALUES.has(word)) index++;
    } else if (word.startsWith('-') && word !== '-') {
      for (const [at, letter] of [...word].entries()) {
        if (at === 0) continue;
        if (letter === 'a') isAll = true;
        if (letter === 'i') isInclude = true;
        if ('mFCct'.includes(letter) && at === word.length - 1) index++;
        if ('mFCctSu'.includes(letter)) break;
      }
    } else named.push(word);
  }
  const targets = named.map((path) => ({ path, from: dir }));
  if (named.length > 0 && !isInclude) return targets;
  // From an unknown folder the staged files (and with -a, the changed ones too) are
  // unknowable: unsure means refused where the folder is used (#559). A commit that
  // names only absolute paths still checks them one by one above and below.
  if (dir === null) return [...targets, { path: '.', from: dir }];
  // git names staged files from the repo's root. The root is found by a walk, not a second git.
  const root = rootOf(dir);
  if (root === null) return targets;
  const changed = (args: string[]) =>
    (readGit(dir, ['--no-optional-locks', 'diff', ...args, '--name-only', '--no-renames', '-z'], env) ?? '')
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path: join(root, path), from: root }));
  return [...targets, ...changed(['--cached']), ...(isAll ? changed([]) : [])];
}

// ---- Programs the project blocks (#192) ----
//
// yokoten.json "commands.block" names programs no agent runs here, each with its reason.
// Only a program counts, so `echo python` and `cat python.md` pass. A command can run
// more than one program, and `findPrograms` lists each:
//
// - the first word after assignments (FOO=1), redirects (`>out`, `2>&1`, `< in`) and
//   shell keywords (`then`, `do`, `!`);
// - after a launcher that runs the next word as a program (env, sudo, nice, timeout,
//   xargs, stdbuf, setsid, busybox and the others in LAUNCHERS), the word after its
//   options;
// - the program after `find ... -exec`, `-execdir`, `-ok` and `-okdir`;
// - the programs of the string `env -S` splits.
//
// A shell string (`bash -c '...'`, `ssh host '...'`, `flock f -c '...'`) is read by
// commandWords. A case pattern (`python3)`) is no command: the reader drops it.

// Shell keywords before a program: `if x`, `then x`, `do x`, `! x`. `time` is a launcher.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac', '!', '{', '}', '(']);
// A loop or case head names a variable and data, not a program: `for f in a b`.
const HEADS = new Set(['for', 'select', 'case', 'in']);
// The words that open a compound command, each with the word that closes it.
const COMPOUNDS: Record<string, 'fi' | 'done' | 'esac'> = { if: 'fi', while: 'done', until: 'done', for: 'done', select: 'done', case: 'esac' };

// Each launcher, with the options that take the next word as their value, and how many
// plain words come before the program (timeout's duration, chrt's priority, taskset's mask).
const LAUNCHERS: Record<string, { options: string[]; operands?: number }> = {
  env: { options: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  sudo: { options: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'] },
  doas: { options: ['-u', '-C'] },
  pkexec: { options: ['--user'] },
  command: { options: [] },
  builtin: { options: [] },
  exec: { options: ['-a'] },
  time: { options: ['-f', '--format', '-o', '--output'] },
  nice: { options: ['-n', '--adjustment'] },
  nohup: { options: [] },
  setsid: { options: [] },
  timeout: { options: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  xargs: { options: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'] },
  stdbuf: { options: ['-i', '-o', '-e'] },
  unbuffer: { options: [] },
  busybox: { options: [] },
  chrt: { options: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'], operands: 1 },
  ionice: { options: ['-c', '--class', '-n', '--classdata'] },
  taskset: { options: [], operands: 1 },
  numactl: { options: ['-N', '-m', '-C', '-p', '-i', '--cpunodebind', '--membind', '--physcpubind', '--preferred', '--interleave'] },
  chroot: { options: [], operands: 1 },
  flock: { options: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'], operands: 1 },
  faketime: { options: [], operands: 1 },
  fakeroot: { options: ['-l', '--lib', '--faked', '-s', '-i'] },
  eatmydata: { options: [] },
  nocache: { options: [] },
  catchsegv: { options: [] },
  strace: { options: ['-o', '-e', '-p', '-s', '-u', '-E', '-a', '-b', '-I', '-O', '-S', '-P', '-X'] },
  ltrace: { options: ['-o', '-e', '-p', '-s', '-u', '-a', '-n', '-l'] },
  firejail: { options: [] },
  proxychains: { options: ['-f'] },
  proxychains4: { options: ['-f'] },
  torsocks: { options: ['-u', '-p', '-a', '-P'] },
  'xvfb-run': { options: ['-n', '--server-num', '-e', '--error-file', '-f', '--auth-file', '-p', '--xauth-protocol', '-s', '--server-args', '-w', '--wait'] },
  caffeinate: { options: ['-t', '-w'] },
};
// find runs the program after each of these.
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// A redirect's operator, with the file descriptor before it.
const REDIRECT_OPERATOR = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(?:>>|<<<|<>|>\||[<>]&|[<>])/;
// Whether a > read now goes on the word as part of its redirect: the word so far is only a
// file descriptor (`2`, `{fd}`), `&`, or one >, with no quote. Otherwise it starts a new word.
const isOperatorStart = (word: string, isQuoted: boolean) => !isQuoted && /^(\d+|\{[A-Za-z_]\w*\}|&)?>?$/.test(word);
// A redirect: `>out`, `2>&1`, `&>>log`, `<in`, or one with its file in the next word (`> out`).
const REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(?:>>|<<<|<>|>\||[<>]&|[<>])(.*)$/s;

/** How many words the redirect at `index` takes: 0 when the word is no redirect. */
function redirectLength(words: string[], index: number): number {
  const redirect = REDIRECT.exec(words[index] ?? '');
  if (!redirect) return 0;
  return redirect[1] === '' && index + 1 < words.length ? 2 : 1;
}

/** The index of the first word at or after `index` that is not an assignment, a redirect or a keyword, at most `limit`. */
function skipPrefix(words: string[], index: number, limit = words.length): number {
  while (index < limit) {
    if (isAssignment(words[index]) || KEYWORDS.has(words[index])) index++;
    else if (redirectLength(words, index) > 0) index = Math.min(index + redirectLength(words, index), limit);
    else break;
  }
  return index;
}

/** A program's name: no folder and no .exe. */
const programName = (word: string) => base(word).replace(/\.exe$/i, '');

// The string `env -S` splits into a command, from the option at `index`, or undefined.
// A long option may be cut short, as getopt allows: `--split`, `--s`.
function splitString(words: string[], index: number): string | undefined {
  const option = words[index];
  const long = /^--(s[a-z-]*)(?:=(.*))?$/s.exec(option);
  if (long && 'split-string'.startsWith(long[1])) return envEscapes(long[2] ?? words[index + 1]);
  const short = /^-[a-zA-Z]*S(.*)$/s.exec(option);
  if (short) return envEscapes(short[1] || words[index + 1]);
  return undefined;
}

// env -S reads its own escapes before it splits: \_ (a space), \t \n \v \f \r are
// whitespace that cuts words, and \c ends the string. The other escapes (\\ \" \' \$ \#)
// are left for commandWords, which reads them as the shell does.
function envEscapes(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  spend(text.length);
  let out = '';
  const variable = /\$\{[A-Za-z_]\w*\}/y;
  for (let i = 0; i < text.length; i++) {
    const next = text[i + 1] ?? '';
    variable.lastIndex = i;
    // env puts the variable's value in place of ${NAME}; the guard does not know it, and
    // reads it as empty, so `--for${X}ce` reads as the option it may well be.
    if (text[i] === '$' && next === '{' && variable.test(text)) i = variable.lastIndex - 1;
    else if (text[i] !== '\\') out += text[i];
    else if (next === 'c') break;
    else {
      out += '_tnvfr'.includes(next) && next !== '' ? ' ' : text[i] + next;
      i++;
    }
  }
  return out;
}

// At most this many programs from one command: a longer list is refused (see checkBlocked).
const MAX_PROGRAMS = 256;

/** A program a command runs, and where that word sits. `-1` is an `env -S` program. */
interface ProgramPlace {
  word: string;
  index: number;
}

/** The words that name the programs a command runs, in order. */
function findPrograms(words: string[]): string[] {
  return findProgramPlaces(words).map((place) => place.word);
}

/** The programs a command runs, each with its index in `words`. */
export function findProgramPlaces(words: string[]): { word: string; index: number }[] {
  spend(words.length);
  const programs: ProgramPlace[] = [];
  // commandWords reads `bash -c 'x'` again as `-c x`: the shell's options come first.
  const start = words.findIndex((word) => !word.startsWith('-'));
  if (start === -1) return programs;
  const findAt = programAt(words, start, programs);
  // find runs the program after each -exec, -execdir, -ok and -okdir. One pass over the
  // words finds them all, a find inside a find too, without reading any word twice.
  if (findAt !== -1) {
    for (let action = findAt + 1; action < words.length && programs.length <= MAX_PROGRAMS; action++) {
      if (FIND_ACTIONS.has(words[action])) programAt(words, action + 1, programs, true);
    }
  }
  return programs;
}

// ---- Heavy jobs (#401) ----
//
// A build, a test suite, a package install or a container build can fill a disk. When the
// kept reading of the Windows drive under a WSL disk file is low, the hook asks the owner
// before one of these starts. Only a program counts, as for a blocked command: a text that
// merely mentions `npm test` is no heavy job, and a shell the guard cannot read names none.

const PACKAGE_PROGRAMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_INSTALLS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'rebuild', 'link', 'dedupe', 'prune', 'pack']);
const PACKAGE_RUNS = new Set(['run', 'run-script']);
// A script whose name says it builds, tests or checks the project.
const HEAVY_SCRIPTS = /(^|[:._-])(build|test|lint|check|typecheck|verify|ci)([:._-]|$)/i;
// A program that is a heavy job on its own (`null`), or the subcommands that are one.
const HEAVY_PROGRAMS: Record<string, ReadonlySet<string> | null> = {
  make: null, ninja: null, bazel: null, cmake: null, meson: null, tsc: null,
  jest: null, vitest: null, mocha: null, pytest: null, phpunit: null, rspec: null,
  mvn: null, mvnw: null, gradle: null, gradlew: null, buildah: null,
  cargo: new Set(['build', 'test', 'check', 'clippy', 'bench', 'install']),
  go: new Set(['build', 'test', 'install', 'generate']),
  dotnet: new Set(['build', 'test', 'restore', 'publish', 'pack']),
  docker: new Set(['build', 'buildx', 'pull', 'run', 'compose']),
  podman: new Set(['build', 'pull', 'run', 'compose']),
  nerdctl: new Set(['build', 'pull', 'run', 'compose']),
};
// A version or help word asks nothing about the project.
const PROBES = new Set(['--version', '-v', '-V', '--help', '-h']);

/** The package manager's job when it installs or runs a build or test script, or null. */
function packageJob(name: string, args: string[]): string | null {
  const first = args.find((arg) => !arg.startsWith('-'));
  if (first === undefined) return null;
  if (PACKAGE_INSTALLS.has(first)) return `${name} ${first}`;
  if (first === 'test' || first === 'build') return `${name} ${first}`;
  if (name === 'npm' && first === 't') return 'npm test';
  if (!PACKAGE_RUNS.has(first)) return null;
  const script = args.slice(args.indexOf(first) + 1).find((arg) => !arg.startsWith('-'));
  return script !== undefined && HEAVY_SCRIPTS.test(script) ? `${name} ${first} ${script}` : null;
}

/** The heavy job the program at `index` runs, as a person reads it, or null. */
function heavyAt(words: string[], index: number): string | null {
  const program = programName(words[index]);
  const args = words.slice(index + 1);
  if (program === 'node') return args.some((arg) => arg === '--test' || arg.startsWith('--test=')) ? 'node --test' : null;
  if (PACKAGE_PROGRAMS.has(program)) return packageJob(program, args);
  const subcommands = HEAVY_PROGRAMS[program];
  if (subcommands === undefined) return null;
  if (args[0] !== undefined && PROBES.has(args[0])) return null;
  if (subcommands === null) return program;
  const sub = args.find((arg) => !arg.startsWith('-'));
  return sub !== undefined && subcommands.has(sub) ? `${program} ${sub}` : null;
}

/**
 * The heavy job `command` starts, such as `npm test`, or null. It reads the command's
 * programs, not its text, so `echo npm test` names none.
 */
export function findHeavyJob(command: string): string | null {
  try {
    for (const words of commandWords(command)) {
      for (const place of findProgramPlaces(words)) {
        const job = heavyAt(words, place.index);
        if (job !== null) return job;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Adds the program of the command that starts at `index` to `programs`, after
// assignments, redirects, keywords and launchers, and the programs of an `env -S`
// string. Returns the index of the program when it is find, or -1. In a find action
// (`isAction`) the command ends at `;` or `{} +`, and the walk stops at the next action too:
// findProgramPlaces reads that one itself, so no word is walked once for each action before it.
function programAt(words: string[], index: number, programs: ProgramPlace[], isAction = false): number {
  let limit = words.length;
  if (isAction) {
    limit = index;
    while (limit < words.length && !FIND_ACTIONS.has(words[limit]) && words[limit] !== ';' && !(words[limit] === '+' && words[limit - 1] === '{}')) limit++;
  }
  while (index < limit) {
    index = skipPrefix(words, index, limit);
    if (index >= limit || HEADS.has(words[index])) return -1;
    const name = programName(words[index]);
    if (!Object.hasOwn(LAUNCHERS, name)) {
      programs.push({ word: words[index], index });
      return name === 'find' ? index : -1;
    }
    const launcher = LAUNCHERS[name];
    index++;
    // `command -v x` only says where x is; it does not run it.
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[index] ?? '')) return -1;
    while (index < limit && words[index].startsWith('-')) {
      const split = name === 'env' ? splitString(words, index) : undefined;
      if (split !== undefined) {
        for (const command of commandWords(split)) {
          for (const program of findProgramPlaces(command)) programs.push({ word: program.word, index: -1 });
        }
      }
      index += launcher.options.includes(words[index]) ? 2 : 1;
    }
    index += launcher.operands ?? 0;
  }
  return -1;
}

function checkBlocked(words: string[], blockList: Record<string, string>): Finding | null {
  const programs = findPrograms(words);
  if (programs.length > MAX_PROGRAMS && Object.keys(blockList).length > 0) {
    return finding('unreadable-command', `yokoten could not read this command: it runs more than ${MAX_PROGRAMS} programs`, 'split it into simpler commands, one per call');
  }
  const name = programs.map(programName).find((program) => Object.hasOwn(blockList, program));
  if (name === undefined) return null;
  const reason = blockList[name].trim().replace(/\.+$/, '');
  return finding('blocked-command', `\`${name}\` is blocked in this project`, 'use the project\'s own stack instead; yokoten.json "commands.block" lists what is blocked', { why: reason });
}

// ---- Commands that print account details (#390) ----
//
// Some commands print the owner's name, email, login or a private host: a git author line,
// a remote URL, an account report. Once that output reaches an agent it can't be taken
// back, so the hook pipes these commands through `yokoten redact`. Only a read is
// rewritten, and only when the whole command is one plain command from this table: no
// separator, pipe, redirect, substitution, prefix or launcher. Then the rewrite can't run
// anything the user did not already see. One row per kind of command. Add a row when an
// incident shows a new one.

/** One read-only command that prints account details. */
interface AccountPrinter {
  /** The program, by its base name. */
  program: string;
  /** Its subcommands that print them: the word right after the program. */
  subcommands: string[];
  /** True when the words after the subcommand keep it a plain read that prints them. */
  accepts: (args: string[]) => boolean;
  /** What it prints, for the message. */
  prints: string;
  /** Options the rewrite adds after the subcommand, so the read runs no program the repo names. */
  harden?: string[];
}

// Options that make a git read write a file or run another program. A format option keeps
// it a read: `--format=%an` prints the author with no "Author:" line, and redact hides the
// value wherever it stands (#413).
const GIT_UNSAFE = /^(?:--output|-o|--ext-diff|--exec-path|--textconv|--filters|--show-signature)/;
const isGitRead = (args: string[]) => !args.some((arg) => GIT_UNSAFE.test(arg));
// A log can run a program the repo's config names: a textconv, an external diff, or gpg to
// check a signature (log.showSignature). The rewrite turns them off, so an allowed read runs
// only git (#413).
const NO_DIFF_PROGRAMS = ['--no-ext-diff', '--no-textconv', '--no-show-signature'];
// `git shortlog` with no revision reads a log from stdin when stdin is no terminal, as in the
// rewrite: so it is rewritten only with a revision, `git shortlog -sne HEAD` (#413). The word
// after an option that takes one is no revision, nor is a path after `--`.
const SHORTLOG_VALUED = new Set(['--group', '--format', '-w']);
function isShortlogRead(args: string[]): boolean {
  if (!isGitRead(args)) return false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return false;
    if (SHORTLOG_VALUED.has(args[i])) i++;
    else if (!args[i].startsWith('-')) return true;
  }
  return false;
}

// `git cat-file -p <object>`, or `git cat-file commit|tag <object>`: one object, printed. A
// commit or a tag names its author. A batch reads object names from stdin: not rewritten.
const isCatFileRead = (args: string[]) => args.length === 2 && ['-p', 'commit', 'tag'].includes(args[0]) && !args[1].startsWith('-');

// `git remote -v`, or `git remote get-url|show <name>`: never add, remove or set.
const isRemoteRead = (args: string[]) =>
  (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) || ((args[0] === 'get-url' || args[0] === 'show') && args.slice(1).every((arg) => /^(?:--all|--push|-n|[\w.-]+)$/.test(arg)));

// `git config --list`, or a read of one account key. A write prints nothing.
const CONFIG_SCOPES = new Set(['--global', '--system', '--local', '--show-origin', '--show-scope', '--includes', '--name-only', '-z', '--null']);
const ACCOUNT_KEY = /^(?:user|remote|credential|url|sendemail)\./i;
function isConfigRead(args: string[]): boolean {
  const [verb, key, ...more] = args.filter((arg) => !CONFIG_SCOPES.has(arg));
  if (verb === '--list' || verb === '-l' || verb === 'list') return key === undefined;
  if (verb === '--get' || verb === '--get-all' || verb === 'get' || verb === '--get-regexp') return key !== undefined && ACCOUNT_KEY.test(key) && more.length === 0;
  return false;
}

// A GET of a traffic or account path: one path, and only options that read.
function isAccountGet(args: string[]): boolean {
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--paginate', '-i', '--include', '--silent'].includes(arg)) continue;
    if (arg === '--jq' || arg === '-q' || arg === '-X' || arg === '--method') {
      const value = args[++i];
      if (value === undefined || ((arg === '-X' || arg === '--method') && value.toUpperCase() !== 'GET')) return false;
    } else if (/^--(?:jq)=/.test(arg)) continue;
    else if (/^(?:--method=|-X)/.test(arg)) {
      if (arg.replace(/^(?:--method=|-X)/, '').toUpperCase() !== 'GET') return false;
    } else if (arg.startsWith('-') || path !== undefined) return false;
    else path = arg;
  }
  return path !== undefined && /(^|\/)(?:traffic|user|users)(?:\/|$)/.test(path);
}

// Options that only choose which account or registry to ask: each takes a value.
const takesOnly = (valued: string[], flags: string[] = []) => (args: string[]) => {
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i]) && args[i + 1] !== undefined) i++;
    else if (!flags.includes(args[i])) return false;
  }
  return true;
};

export const ACCOUNT_PRINTERS: AccountPrinter[] = [
  { program: 'git', subcommands: ['log', 'show', 'whatchanged'], accepts: isGitRead, prints: 'author names and emails', harden: NO_DIFF_PROGRAMS },
  { program: 'git', subcommands: ['blame', 'annotate'], accepts: isGitRead, prints: 'author names and emails', harden: ['--no-textconv'] },
  { program: 'git', subcommands: ['for-each-ref'], accepts: isGitRead, prints: 'author names and emails' },
  { program: 'git', subcommands: ['shortlog'], accepts: isShortlogRead, prints: 'author names and emails' },
  { program: 'git', subcommands: ['cat-file'], accepts: isCatFileRead, prints: 'author names and emails' },
  { program: 'git', subcommands: ['remote'], accepts: isRemoteRead, prints: 'remote URLs' },
  { program: 'git', subcommands: ['config'], accepts: isConfigRead, prints: 'your name, email and remotes' },
  { program: 'gh', subcommands: ['api'], accepts: isAccountGet, prints: 'the login and account details' },
  { program: 'gh', subcommands: ['auth'], accepts: (args) => args[0] === 'status' && takesOnly(['--hostname', '-h'], ['--active', '-a'])(args.slice(1)), prints: 'the login' },
  { program: 'npm', subcommands: ['whoami'], accepts: takesOnly(['--registry']), prints: 'the login' },
  { program: 'wrangler', subcommands: ['whoami'], accepts: (args) => args.length === 0, prints: 'the account name and email' },
];

// Shell text that makes more than one plain command: separators, pipes, background, redirects,
// substitutions, groups, a line end, an escape, a comment, or a glob: `git log *` in a folder
// with a file named `--output=x` passes that option (#413).
const NOT_SIMPLE = /[;&|<>`$(){}\\\n#*?[]/;
// Quoted text bash reads as it is: '...', or "..." with no $, ` or \ inside. A format such as
// '%(authorname) <%ae>' is one word, not a group or a redirect (#413). The search runs from
// the left, as bash reads. A quote left after it means the search and bash may not agree on
// where a string ends: a "..." with a $ inside, an escaped or an unclosed quote. Then the
// command is not plain, so a quote can never hide a redirect.
const LITERAL_QUOTED = /'[^'\n]*'|"[^"$`\\\n]*"/g;
function isSimple(command: string): boolean {
  const rest = command.replace(LITERAL_QUOTED, 'x');
  return !/['"]/.test(rest) && !NOT_SIMPLE.test(rest);
}
// A word that reads as a redirect: a second check, in case a quote was read wrong.
const REDIRECT_WORD = /^\d*[<>]|^&>/;
// Runners that start a package's program by name: `npx wrangler`, `pnpm dlx wrangler`.
const PACKAGE_RUNNERS: Record<string, string[]> = { npx: [], bunx: [], pnpm: ['dlx', 'exec'], yarn: ['dlx', 'exec'] };

/** The mark every wrapped command carries, so the hook never wraps one twice. */
export const REDACT_MARKER = '# yokoten-redact';
const RUNS_REDACT = /\byokoten(?:\.ts|\.js)?["']?\s+redact\b/;
/**
 * A command that already sends its output through `yokoten redact`: it starts with the
 * wrapper's first line, marker included, and calls redact. A comment that names them does not count.
 */
export const isRedacted = (command: string): boolean => command.startsWith(`set -o pipefail ${REDACT_MARKER}\n`) && RUNS_REDACT.test(command);

/** What a plain read from ACCOUNT_PRINTERS prints, and the command as the rewrite runs it. */
function readAccount(command: string): { printed: string; hardened: string } | null {
  if (isRedacted(command) || !isSimple(command)) return null;
  let words: string[];
  try {
    const commands = commandWords(command);
    if (commands.length !== 1) return null;
    words = commands[0];
  } catch {
    return null;
  }
  if (!words.length || isAssignment(words[0]) || words.some((word) => REDIRECT_WORD.test(word))) return null;
  let at = 0;
  let name = programName(words[0]);
  if (Object.hasOwn(PACKAGE_RUNNERS, name)) {
    at = PACKAGE_RUNNERS[name].includes(words[1]) ? 2 : 1;
    if (words[at] === undefined) return null;
    name = programName(words[at]).replace(/@[^/]*$/, '');
  }
  const subcommand = words[at + 1];
  const row = ACCOUNT_PRINTERS.find((printer) => printer.program === name && printer.subcommands.includes(subcommand) && printer.accepts(words.slice(at + 2)));
  if (!row) return null;
  let hardened = command;
  if (row.harden) {
    // The options go right after the subcommand. Both words must stand unquoted at the start,
    // or the place is unclear, and the command is not rewritten.
    const head = /^(\s*)(\S+)(\s+)(\S+)(?=\s|$)/.exec(command);
    if (at !== 0 || !head || head[2] !== words[0] || head[4] !== subcommand) return null;
    hardened = `${head[0]} ${row.harden.join(' ')}${command.slice(head[0].length)}`;
  }
  return { printed: `\`${row.program} ${subcommand}\` prints ${row.prints}`, hardened };
}

/**
 * What the command prints about the owner, or null. Not null only when the whole command
 * is one plain command that a row of ACCOUNT_PRINTERS lists, its subcommand in place:
 * `git remote add show x` is no `git remote show`.
 */
export const printsAccount = (command: string): string | null => readAccount(command)?.printed ?? null;

/** The command as the rewrite runs it: a git log or blame with no textconv or external diff (#413). */
export const hardenRead = (command: string): string => readAccount(command)?.hardened ?? command;

/** The refusal for an agent whose hook can't change the command, with yokoten.json "privacy.output" "stop": the fix is the wrapped command. */
export const privateOutput = (printed: string, wrapped: string): Finding => finding('private-output', `${printed}, and this agent can't filter it`, `run it as \`${wrapped}\``);

/**
 * The command with its output, stderr too, sent through `redact`, the command that runs
 * `yokoten redact`. pipefail keeps the command's exit code. If redact can't start or
 * stops, `cat` passes the rest through: hiding output never stops the command. The
 * command sits on lines of its own, after the marker.
 */
export const wrapForRedact = (command: string, redact: string): string => `set -o pipefail ${REDACT_MARKER}\n(\n${command}\n) 2>&1 | { ${redact} || cat; }`;

// ---- Reading bash ----
//
// A small reader for everyday bash, not a full parser. It turns command text into a list
// of commands, each a list of words.
//
// - Quotes: '...', "..." (with \ escapes), $'...' and $"..." are part of one word. A
//   separator inside them does not cut the command.
// - Separators: ; & && || | |& ( ) { } and line ends. A \ before a line end joins lines.
//   A group `{ ...; }` or subshell `( ... )` stays open until its } or ).
// - A case pattern (`a|b)` after `case x in` or `;;`) is dropped: it names values.
// - A word that starts with # begins a comment, to the line end.
// - $(...), `...`, <(...) and >(...) run, so their text is read as commands, even in "...".
// - A heredoc body is data, unless a shell reads it (see `bodies`).
// - A shell, eval or ssh runs a string, so the words after it are read again as commands
//   (see `runString`). So does `source /dev/stdin` or `. /dev/fd/N` with its input.
// - Each construct is read once: an unclosed $(, <(, ((, ` or " has read the rest of the
//   text as commands, and the rest is not read again. All reads of one command share one
//   work budget (see withBudget); a command over it is refused.
//
// When the text is unclear, the guard blocks rather than guesses. An unclosed quote is
// dropped and the rest is read as plain words, so `echo 'x; npm publish` still blocks.
// Functions and aliases are not followed.

const MAX_DEPTH = 8;

// ---- The work budget ----
//
// Every read of one command draws on one budget: each character the reader visits, each
// word a word loop looks at. Nested constructs read text again (a shell string, an env -S
// string, a substitution), at most MAX_DEPTH times over, so a command that reads cleanly
// stays well inside it. A command that would cost more, by design or by accident, throws,
// and checkCommand refuses it: the guard never runs out of time or memory and lets it by.
const BUDGET_PER_CHARACTER = 20;
const BUDGET_BASE = 200_000;
let budget: { left: number } | null = null;

class OverBudget extends Error {}

function spend(amount: number): void {
  // The same steps the budget draws. The linear tests read the count (#754).
  noteWork(amount);
  if (budget !== null && (budget.left -= amount) < 0) throw new OverBudget('the command costs too much to read');
}

// Runs `read` under a budget for text of `size` characters. A read inside another shares
// the outer budget, unless `fresh` (a hook file is not part of the command).
function withBudget<T>(size: number, read: () => T, fresh = false): T {
  if (budget !== null && !fresh) return read();
  const outer = budget;
  budget = { left: BUDGET_PER_CHARACTER * size + BUDGET_BASE };
  try {
    return read();
  } finally {
    budget = outer;
  }
}

const isShell = (word: string) => /^(?:ba|da|z|k|c|tc|fi|pw)?sh(?:\.exe)?$/.test(base(word));
// Programs that run a later word through a shell, beside the shells. A pattern means only
// with that option: sudo and doas pass their words to a program unless given -s or -i,
// and env unless given -S. xargs, nohup, time and the like run a program, not a shell
// string, so their words are already checked where they stand.
const RUNNERS: Record<string, RegExp | null> = {
  eval: null, ssh: null, su: null, runuser: null, watch: null, script: null, flock: null, parallel: null, tmux: null, screen: null,
  sudo: /^(-[a-zA-Z]*[si]|--shell|--login)/, doas: /^-[a-zA-Z]*s/, env: /^(-[a-zA-Z]*S|--s)/,
};

const RUNNER_OPTIONS = Object.entries(RUNNERS).flatMap(([runner, option]) => (option ? [[runner, option] as const] : []));

// Where a shell or a runner stands in the command, or -1. Anywhere counts: `find -exec sh
// -c`, `xargs sh -c` and `sudo bash -c` all run a string.
// It walks back from the end once, so each word is tested once against each option.
function runnerAt(words: string[]): number {
  spend(words.length);
  const later = new Set<string>(); // runners whose option stands after the current word
  let at = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    const name = base(words[i]);
    if (isShell(words[i]) || (Object.hasOwn(RUNNERS, name) && (RUNNERS[name] === null || later.has(name))) || sourcesInput(words, i)) at = i;
    for (const [runner, option] of RUNNER_OPTIONS) if (option.test(words[i])) later.add(runner);
  }
  return at;
}

// `source /dev/stdin` and `. /dev/fd/3` run what comes in, as a shell does;
// `source -- /dev/stdin`, `. //dev/stdin` and `. /proc/$$/fd/0` do too.
function sourcesInput(words: string[], i: number): boolean {
  if (words[i] !== 'source' && words[i] !== '.') return false;
  const file = (words[i + 1] === '--' ? words[i + 2] : words[i + 1]) ?? '';
  return /^\/(?:dev\/(?:stdin|fd\/\d+)|proc\/[^/]+\/fd\/\d+)$/.test(file.replace(/\/{2,}/g, '/'));
}

// A command that, in the middle of a pipeline, hands on what comes in: `tee` with any files,
// `cat` with no file but `-`. The next command gets what the one before it printed.
function passesOn(words: string[]): boolean {
  const program = findPrograms(words)[0];
  if (program === undefined) return false;
  const name = programName(program);
  if (name === 'tee') return true;
  if (name !== 'cat') return false;
  const at = words.indexOf(program, skipPrefix(words, 0));
  return at !== -1 && words.slice(at + 1).every((word) => word.startsWith('-'));
}

// `source x` and `. x`: the shell runs the file, so a `<(...)` given to it is commands.
function isSource(words: string[]): boolean {
  const program = findPrograms(words)[0];
  return program === 'source' || program === '.';
}

// The command xargs runs, without what comes in (`xargs -0 git` gives `git`), or null when
// the command has no xargs. With no program after its options, xargs runs echo.
function xargsCommand(words: string[]): string | null {
  spend(words.length);
  let index = words.findIndex((word) => programName(word) === 'xargs');
  if (index === -1) return null;
  for (index++; index < words.length && words[index].startsWith('-'); ) index += LAUNCHERS.xargs.options.includes(words[index]) ? 2 : 1;
  return words.slice(index).join(' ');
}

/** Whether a delimiter word is a null: a real null, or printf's `\0`, `\000` or `\x00`. */
const isNullDelimiter = (text: string) => text === '\0' || /^\\0{1,3}$/.test(text) || /^\\x00$/i.test(text);

/** Whether xargs splits its input on a null: `-0`, `--null`, `-d '\0'`, or a short cluster that holds `0` (`-r0`). */
function xargsUsesNull(words: string[]): boolean {
  let index = words.findIndex((word) => programName(word) === 'xargs');
  if (index === -1) return false;
  for (index++; index < words.length && /^--?[^-]/.test(words[index]); ) {
    const word = words[index];
    if (word === '--null') return true;
    if (word === '--delimiter' || word.startsWith('--delimiter=')) {
      const inline = word.startsWith('--delimiter=');
      const delim = inline ? word.slice('--delimiter='.length) : (words[index + 1] ?? '');
      if (isNullDelimiter(delim)) return true;
      index += inline ? 1 : 2;
      continue;
    }
    if (word.startsWith('--')) {
      index += LAUNCHERS.xargs.options.includes(word) ? 2 : 1;
      continue;
    }
    let valued = false;
    for (let letter = 1; letter < word.length; letter++) {
      if (word[letter] === '0') return true;
      if (word[letter] === 'd') {
        const rest = word.slice(letter + 1);
        if (isNullDelimiter(rest || (words[index + 1] ?? ''))) return true;
        valued = rest === '';
        break;
      }
      // A valued short option takes the rest of the word (`-s0` is -s 0, not -0).
      if (LAUNCHERS.xargs.options.includes(`-${word[letter]}`)) {
        valued = letter === word.length - 1;
        break;
      }
    }
    index += valued || LAUNCHERS.xargs.options.includes(word) ? 2 : 1;
  }
  return false;
}

// printf leaves a null as `\0`, `\000` or `\x00`. A later shell read swallows the
// backslash (`\0` becomes `0`), so xargs -0 would not see the word in front of it.
const PRINTF_NULL = /\\(?:0{1,3}(?![0-7])|x00(?![0-9A-Fa-f]))/gi;

/** The text xargs reads, as words. `xargs -0` also splits on a null (#573). */
function xargsInput(words: string[], text: string): string {
  const split = xargsUsesNull(words) ? text.replace(PRINTF_NULL, ' ').replace(/\0/g, ' ') : text;
  return split.replace(/\s+/g, ' ');
}

// What a command prints, as the command it pipes into reads it: for printf, its format
// filled in (see printfText); for any other, its words after the program, as echo prints
// them, with each \n a line end. Over-reading is fine: `cat x` "prints" x.
function printedText(words: string[]): string {
  const at = skipPrefix(words, 0);
  const program = findPrograms(words)[0];
  const printfAt = program !== undefined && programName(program) === 'printf' ? words.indexOf(program, at) : -1;
  if (printfAt !== -1) return printfText(words.slice(printfAt + 1));
  return words.slice(at + 1).join(' ').replace(/\\n/g, '\n');
}

// More text than this from printf's format said again for each set of arguments, and the
// guard reads the format and the arguments as plain words instead.
const MAX_PRINTF_REPEATS = 65_536;

// What `printf [-v name] [--] format args...` prints, when the format's only conversions are
// %s and %b (and %%): the format with each conversion filled by the next argument, again
// while arguments are left, and its escapes \n \t \\ read. For any harder format, the
// arguments and the format, as words: the guard reads more than printf prints, never less.
function printfText(args: string[]): string {
  let at = 0;
  if (args[at] === '-v') at += 2;
  if (args[at] === '--') at++;
  const format = args[at] ?? '';
  const values = args.slice(at + 1);
  spend(format.length + values.length);
  const texts: string[] = ['']; // the format's text before each conversion, and after the last
  const conversions: string[] = []; // 's' or 'b'
  let isSimple = true;
  for (let position = 0; position < format.length && isSimple; position++) {
    const next = format[position + 1] ?? '';
    if (format[position] === '%' && (next === 's' || next === 'b')) {
      conversions.push(next);
      texts.push('');
      position++;
    } else if (format[position] === '%' && next === '%') {
      texts[texts.length - 1] += '%';
      position++;
    } else if (format[position] === '%') isSimple = false;
    else if (format[position] === '\\') {
      texts[texts.length - 1] += printfEscape(next);
      position++;
    } else texts[texts.length - 1] += format[position];
  }
  const repeats = conversions.length === 0 ? 1 : Math.max(1, Math.ceil(values.length / conversions.length));
  if (!isSimple || (repeats - 1) * format.length > MAX_PRINTF_REPEATS) {
    // The arguments first, so xargs takes its program's first word from them; then each on a
    // line of its own, and the format with the arguments after it, for a shell.
    const joined = values.join(' ');
    return [joined, ...values, `${format} ${joined}`].join('\n').replace(/\\n/g, '\n');
  }
  let out = '';
  let filled = 0; // how many arguments are filled in
  for (let repeat = 0; repeat < repeats; repeat++) {
    spend(texts.length);
    for (const [index, conversion] of conversions.entries()) {
      const value = values[filled++] ?? '';
      // %b reads the escapes in its argument too.
      out += texts[index] + (conversion === 'b' ? value.replace(/\\(.?)/gs, (_, letter: string) => printfEscape(letter)) : value);
    }
    out += texts[conversions.length];
  }
  return out;
}

// What printf prints for the escape \<letter>: a line end for n, a tab for t, one \ for \,
// and for any other, both characters as written.
function printfEscape(letter: string): string {
  if (letter === 'n') return '\n';
  if (letter === 't') return '\t';
  if (letter === '\\') return '\\';
  return `\\${letter}`;
}

// ssh options that take a value, in the same word (-p22) or the next (-p 22).
const SSH_VALUE_OPTIONS = 'BbcDEeFIiJLlmOoPpQRSWw';
// flock options that take a value. -c (--command) takes the shell string.
const FLOCK_VALUE_OPTIONS = 'wE';

// The text a runner at `at` hands to a shell. For most it is every word after the runner.
// ssh runs the words after its options and the host (`ssh -p 22 host 'x'`), and flock the
// string after -c (`flock f -c 'x'`) or the command after its file (`flock f x`).
function runString(words: string[], at: number): string {
  const name = base(words[at]);
  if (name === 'ssh') return words.slice(sshCommand(words, at + 1)).join(' ');
  if (name === 'flock') return flockCommand(words, at + 1);
  if (name === 'env') return envCommand(words, at + 1) ?? words.slice(at + 1).join(' ');
  return words.slice(at + 1).join(' ');
}

// The command `env -S` runs: its split string, then the words after it
// (`env -iS'git push' x`, `env --split-string='a b'`, `env -u X -S 'a b'`).
function envCommand(words: string[], index: number): string | undefined {
  while (index < words.length && words[index].startsWith('-')) {
    const split = splitString(words, index);
    if (split !== undefined) {
      const isInline = /^--[^=]*=/.test(words[index]) || /^-[a-zA-Z]*S./s.test(words[index]);
      return [split, ...words.slice(index + (isInline ? 1 : 2))].join(' ');
    }
    index += LAUNCHERS.env.options.includes(words[index]) ? 2 : 1;
  }
  return undefined;
}

// The index of the first word after ssh's options and host.
function sshCommand(words: string[], index: number): number {
  while (index < words.length && words[index].startsWith('-') && words[index] !== '-') {
    if (words[index] === '--') return index + 2;
    const option = words[index];
    const value = [...option.slice(1)].findIndex((letter) => SSH_VALUE_OPTIONS.includes(letter));
    // A value option last in its word takes the next word: `-tp 22`.
    index += value !== -1 && value === option.length - 2 ? 2 : 1;
  }
  return index + 1;
}

// flock's command: the string after -c or --command, before or after the file, or the
// words after the file.
function flockCommand(words: string[], index: number): string {
  let file = false;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith('--')) {
      const command = /^--command(?:=(.*))?$/s.exec(word);
      if (command) return command[1] ?? words[index + 1] ?? '';
      if (/^--(wait|timeout|conflict-exit-code)$/.test(word)) index++;
    } else if (word.startsWith('-') && word.length > 1) {
      for (let letter = 1; letter < word.length; letter++) {
        const rest = word.slice(letter + 1);
        if (word[letter] === 'c') return rest || (words[index + 1] ?? '');
        if (FLOCK_VALUE_OPTIONS.includes(word[letter])) {
          if (!rest) index++;
          break;
        }
      }
    } else if (!file) file = true;
    else return words.slice(index).join(' ');
  }
  return '';
}

/** Every command the text runs, as lists of words. Text that runs inside a command is listed too. */
export function commandWords(text: string, depth = 0): string[][] {
  const out: string[][] = [];
  withBudget(text.length, () => read(text, 0, '', depth, out));
  return out;
}

interface Heredoc {
  delim: string;
  strip: boolean;
  quoted: boolean;
  /** The index, on its line, of the command that holds the <<. */
  cmd: number;
  /** The groups open around it, outermost first. */
  groups: Group[];
  /** The group it follows, `{ read a; } <<EOF`: the body is the group's input. */
  group?: Group;
}

// A group `{ ...; }`, a subshell `( ... )`, or a compound command (`if ... fi`, a loop to
// its `done`, `case ... esac`). What its commands print goes where the group sends it, so a
// heredoc body or an echo inside may reach a shell after the group: `{ cat <<EOF; } | bash`,
// `if x; then echo y; fi | bash`. A compound command's kind is the word that closes it.
interface Group {
  kind: '(' | '{' | 'fi' | 'done' | 'esac';
  /** The index, on the current line, of its first command, and of the one after it once closed. */
  from: number;
  to: number;
  /** What its commands print (heredoc bodies, the words an echo prints), waiting for where the group's output goes. */
  bodies: string[];
  /** The groups closed inside it that sent their output on to it: their bodies are its own. */
  inner: Group[];
  /** Whether a command in it reads its input as commands. */
  reads: boolean;
}

// `%(refname)`, `%(refname:short)`: a git format atom, which git reads as the value of
// `--format`. Only this shape is one word. A space, a `;` or a missing `)` means the `(` is a
// subshell after all, and the words after it must be read as commands (#873).
const GIT_FORMAT_ATOM = /^\*?[A-Za-z][A-Za-z0-9_.:*,=/@+-]*$/;
function isGitFormatAtom(text: string, open: number): boolean {
  const close = text.indexOf(')', open + 1);
  return close !== -1 && GIT_FORMAT_ATOM.test(text.slice(open + 1, close));
}

// Reads commands from `start` until `closer` (`)` or a backtick) or the end, and adds them
// to `out`. Returns the index after the closer, or -1 if a closer was wanted and not found.
function read(text: string, start: number, closer: string, depth: number, out: string[][]): number {
  // Too deep to follow: fall back to the rough cut, which finds more than is there.
  // Return -1 when a closer was wanted. text.length would look like the closer was found
  // at the end, and the caller would read the same tail again (#754).
  if (depth > MAX_DEPTH) {
    spend(text.length - start);
    for (const words of rough(text.slice(start))) out.push(words);
    return closer ? -1 : text.length;
  }
  const nested = (s: string) => out.push(...commandWords(s, depth + 1));
  let words: string[] = [];
  let substitutions: string[] = []; // the text inside each $(...) and <(...) of this command
  let word = '';
  let inWord = false;
  let isQuoted = false; // the word has a quote or a \ in it, so it is no keyword: `'case'`, `\case`
  let quotedAt = 0; // with isQuoted, how much of the word came before its first quote
  // Marks the word as quoted from here on, before the quoted text is added.
  const quote = () => {
    if (!isQuoted) quotedAt = word.length;
    isQuoted = true;
  };
  let caseAt = -1; // where `case` stands in words, when it starts the command
  let isLeading = true; // every word so far is a keyword, so the next one leads the command
  let line: string[][] = []; // the commands so far on this line, for heredocs
  let pipes: boolean[] = []; // for each of them, whether it pipes into the next
  let pending: Heredoc[] = [];
  let piped: string[] | null = null; // the command before a |
  let pipedSubstitutions: string[] = []; // the text inside each $(...) and <(...) of that command
  const groups: Group[] = []; // the groups open now, outermost first
  // A group that just closed, until we see where it sends its output. closeGroup sets it, so
  // the type is written out: TypeScript would take it for null.
  let closed = null as Group | null;
  let carried: string[] = []; // heredoc bodies a closed group pipes on, waiting for the command that reads them
  let cases = 0; // how many `case ... in` are open
  let isPattern = false; // reading a case pattern, up to its )
  let alternative = 0; // words in the pattern since the last |: more than one is no pattern

  const endWord = () => {
    const ended = inWord ? word : null;
    const isKeyword = !isQuoted;
    const isFirst = isLeading;
    if (ended !== null) {
      words.push(ended);
      readWords.add(words);
      // A redirect whose operator is unquoted, whatever its file: `>"AGENTS.md"` (#402).
      if (REDIRECT.test(ended) && (!isQuoted || (REDIRECT_OPERATOR.exec(ended)?.[0].length ?? Infinity) <= quotedAt)) {
        const marks = unquotedRedirects.get(words) ?? new Set<number>();
        marks.add(words.length - 1);
        unquotedRedirects.set(words, marks);
      }
      isLeading = isLeading && isKeyword && KEYWORDS.has(ended);
    }
    word = '';
    inWord = false;
    isQuoted = false;
    if (ended === null) return;
    if (isPattern && ++alternative > 1) isPattern = false; // `a b)` is no pattern: read it as a command
    if (!isKeyword) return;
    // A compound command is a group, open from its first word to the word that closes it.
    if (isFirst && Object.hasOwn(COMPOUNDS, ended)) {
      groups.push({ kind: COMPOUNDS[ended], from: line.length, to: 0, bodies: [], inner: [], reads: false });
    } else if (isFirst && groups.length > 0 && groups[groups.length - 1].kind === ended) {
      closeGroup(line.length + 1); // the command the closing word leads is the group's too
    }
    if (ended === 'esac' && isFirst && cases > 0) {
      cases--;
      isPattern = false;
    } else if (ended === 'case' && isFirst) {
      caseAt = words.length - 1;
    } else if (ended === 'in' && !isPattern) {
      // `case $x in`: what comes next is a pattern, not a command.
      if (caseAt !== -1 && words.length - 1 === caseAt + 2) {
        endCommand();
        cases++;
        isPattern = true;
        alternative = 0;
      }
    }
  };
  // Closes the innermost group, whose commands end before `to`. A group that reads commands
  // makes its parent one that does.
  const closeGroup = (to: number) => {
    closed = groups.pop() ?? null;
    if (closed === null) return;
    closed.to = to;
    const parent = groups.at(-1);
    if (parent && closed.reads) parent.reads = true;
  };
  // Where a group that just closed sends the bodies inside it, and whether this command
  // reads bodies a group piped on. A body that reaches no reader stays data.
  const settle = (pipe: boolean) => {
    if (carried.length > 0 && words.length > 0) {
      const reads = readsCommands(words);
      if (reads) for (const body of carried) nested(body);
      // `{ echo push --force; } | xargs git`: xargs hands the bodies to its program as words.
      const handed = reads ? null : xargsCommand(words);
      if (handed !== null) nested(`${handed} ${xargsInput(words, carried.join(' '))}`);
      if (reads || handed !== null || !pipe) carried = [];
    }
    if (closed) {
      if (pipe) {
        spend(closed.to - closed.from);
        groupBodies(closed, carried);
        // For the bodies read at this line's end: the group's commands pipe on, too.
        for (let i = closed.from; i < closed.to; i++) pipes[i] = true;
      } else groups.at(-1)?.inner.push(closed); // its bodies are its parent's now
      closed = null;
    }
  };
  // The end of the text or of a substitution. Bodies that still wait for a reader, after a
  // pipe to nothing or in a group that never closed, are read as commands, not guessed.
  const finish = () => {
    endCommand();
    for (const group of groups) groupBodies(group, carried);
    for (const body of carried) nested(body);
  };
  const endCommand = (pipe = false) => {
    endWord();
    spend(words.length);
    line.push(words);
    pipes.push(pipe);
    settle(pipe);
    if (words.length === 0) return;
    out.push(words);
    if (groups.length > 0) {
      // The innermost group reads; it tells its parent when it closes (see closeGroup).
      if (readsCommands(words)) groups[groups.length - 1].reads = true;
      // What the command prints, as `echo` would, waits in the group for where it goes.
      const printed = printedText(words);
      if (printed) groups[groups.length - 1].bodies.push(printed);
    }
    const at = runnerAt(words);
    if (at !== -1) {
      // `bash -c 'x'`, `eval "x"`, `ssh host 'x'`: read the string it runs as commands.
      nested(runString(words, at));
      // `echo 'npm publish' | bash`: the words before the pipe are the shell's input.
      if (piped) nested(printedText(piped));
    }
    // `bash <(x)`, `source <(x)`, `eval "$(x)"`: what x prints is commands, as in `x | bash`.
    // All of them in one group: in a group piped to a shell, every line is read as commands.
    if (substitutions.length > 0 && (at !== -1 || isSource(words))) nested(`{ ${substitutions.join('\n')}\n} | bash`);
    // `echo push | xargs git`: xargs hands what comes in to its program as words.
    // `xargs -0` also splits on a null, which printf writes as `\0` (#573).
    const handed = piped ? xargsCommand(words) : null;
    if (piped && handed !== null) nested(`${handed} ${xargsInput(words, printedText(piped))}`);
    // `cat <(x) | bash`, `echo "$(x)" | xargs git`: the command before the pipe may print
    // what x prints. In a group piped on, each line x prints reaches the reader.
    if (pipedSubstitutions.length > 0 && (at !== -1 || handed !== null)) {
      const xargs = xargsUsesNull(words) ? `xargs -0 ${handed}` : `xargs ${handed}`;
      nested(`{ ${pipedSubstitutions.join('\n')}\n} | ${at !== -1 ? 'bash' : xargs}`);
    }
    if (pipe && piped !== null && passesOn(words)) {
      // `echo x | tee f | bash`: tee hands on what echo printed. Its own `$(x)` and `<(x)`
      // substitutions are read too: over-reading is fine. pipedSubstitutions is this reader's own array.
      for (const substitution of substitutions) pipedSubstitutions.push(substitution);
    } else {
      piped = pipe ? words : null;
      pipedSubstitutions = pipe ? substitutions : [];
    }
    substitutions = [];
    words = [];
    caseAt = -1;
    isLeading = true;
  };

  let index = start;
  while (index < text.length) {
    spend(1);
    const character = text[index];
    const next = text[index + 1];
    // A separator inside what looked like a pattern means it was none: the words so far, and
    // every command before, are read as commands. Only words since the last cut are dropped.
    const isCut = character === ';' || character === '&' || (character === '|' && next === '|') || ((character === '\n' || character === '(') && (inWord || words.length > 0));
    if (isPattern && isCut) isPattern = false;
    if (isPattern && (character === ')' || character === '|' || character === '(')) endWord();
    if (isPattern && (character === ')' || character === '|' || character === '(')) {
      // A case pattern, `a|b)` or `(a)`, names values, not programs. The commands come after the ).
      if (character === ')') {
        words = [];
        caseAt = -1;
        isLeading = true;
        isPattern = false;
      }
      alternative = 0;
      index++;
      continue;
    }
    if (closer && character === closer && !(character === ')' && groups.at(-1)?.kind === '(')) {
      finish();
      return index + 1;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      endWord();
      index++;
    } else if (character === '\n') {
      endCommand();
      index = pending.length ? bodies(text, index + 1, pending, { line, pipes, groups }, depth, out) : index + 1;
      pending = [];
      line = [];
      pipes = [];
      spend(groups.length);
      for (const group of groups) group.from = 0;
    } else if (character === '#' && !inWord) {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '\\') {
      if (next !== '\n') {
        quote();
        word += next ?? character;
        inWord = true;
      }
      index += 2;
    } else if (character === "'" || (character === '$' && next === "'")) {
      // '...' is as written. $'...' takes \ escapes, so \' does not close it.
      const ansi = character === '$';
      const open = ansi ? index + 1 : index;
      const end = ansi ? closeAnsi(text, open + 1) : text.indexOf("'", open + 1);
      spend((end === -1 ? text.length : end) - open);
      if (end === -1) index = open + 1; // unclosed: drop the quote and read on
      else {
        const body = text.slice(open + 1, end);
        quote();
        word += ansi ? body.replace(/\\(.)/gs, '$1') : body;
        inWord = true;
        index = end + 1;
      }
    } else if (character === '"' || (character === '$' && next === '"')) {
      const open = character === '$' ? index + 1 : index;
      const quoted = readDouble(text, open + 1, depth, out, false, substitutions);
      if (quoted === RAN_OUT) index = text.length; // a substitution in it never closed and read the rest
      else if (!quoted) index = open + 1; // unclosed: drop the quote and read on
      else {
        quote();
        word += quoted.value;
        inWord = true;
        index = quoted.end;
      }
    } else if ((character === '$' || character === '<' || character === '>') && next === '(') {
      // $(...), $((...)), <(...) and >(...): the inside runs on its own.
      const end = read(text, index + 2, ')', depth + 1, out);
      if (end === -1) {
        // Unclosed: the read inside already read the rest as commands. Never read it again.
        endCommand();
        index = text.length;
      } else {
        if (character !== '>' && text[index + 2] !== '(') substitutions.push(text.slice(index + 2, end - 1));
        word += text.slice(index, end);
        inWord = true;
        index = end;
      }
    } else if (character === '`') {
      const end = read(text, index + 1, '`', depth + 1, out);
      if (end !== -1) {
        substitutions.push(text.slice(index + 1, end - 1));
        word += text.slice(index, end); // kept in the word, as $(...) is, so a check sees the unknown part
      }
      inWord = true;
      index = end === -1 ? text.length : end; // unclosed: the read inside read the rest
    } else if (character === '(' && next === '(') {
      // (( maths )): read the inside on its own, so a << there is a shift, not a heredoc.
      endWord();
      const end = read(text, index + 1, ')', depth + 1, out);
      if (end === -1) endCommand();
      index = end === -1 ? text.length : end; // unclosed: the read inside read the rest
    } else if (character === '(' && word.endsWith('%') && isGitFormatAtom(text, index)) {
      // A git format such as `%(refname)` is one word, as the quote note above says: git
      // reads it as the value of `--format`, and a shell refuses the unquoted form. Reading
      // it whole keeps the tag name in the same command, so the release check sees it (#873).
      // Only an atom is read whole. Anything else, such as `%(git push --tags)` or an
      // unclosed `%(`, falls to the group arm below and still reads as the command it is.
      const stop = text.indexOf(')', index + 1) + 1;
      word += text.slice(index, stop);
      inWord = true;
      index = stop;
    } else if (character === '(' || (character === '{' && !inWord && /\s/.test(next ?? ''))) {
      // A subshell or a group cuts like a separator, and is open until its ) or }.
      endCommand();
      groups.push({ kind: character, from: line.length, to: 0, bodies: [], inner: [], reads: false });
      index++;
    } else if ((character === ')' && groups.at(-1)?.kind === '(') || (character === '}' && !inWord && /[\s;|&)<>]|^$/.test(next ?? '') && groups.at(-1)?.kind === '{')) {
      endCommand();
      closeGroup(line.length);
      index++;
    } else if (character === ';' && cases > 0 && (next === ';' || next === '&')) {
      // `;;`, `;&` and `;;&` end a case item: a pattern comes next.
      endCommand();
      isPattern = true;
      alternative = 0;
      index += next === ';' && text[index + 2] === '&' ? 3 : 2;
    } else if (character === ')' || character === ';' || (character === '}' && !inWord && /[\s;]|^$/.test(next ?? ''))) {
      // A brace inside a word (${x}, a{b,c}) does not cut.
      endCommand();
      index++;
    } else if (character === '&') {
      if (next === '>' || word.endsWith('>')) {
        // &> and >& are redirects, not separators. `hi&>f` is `hi &>f`.
        if (next === '>' && inWord && !isOperatorStart(word, isQuoted)) endWord();
        word += character;
        inWord = true;
        index++;
      } else {
        endCommand();
        index += next === '&' ? 2 : 1;
      }
    } else if (character === '|' && !isQuoted && /^(\d+|\{[A-Za-z_]\w*\}|&)?>$/.test(word)) {
      // `>|` writes its file even with noclobber on: a redirect, not a pipe (#402).
      word += character;
      index++;
    } else if (character === '|') {
      endCommand(next !== '|');
      index += next === '|' || next === '&' ? 2 : 1;
    } else if (character === '<' && next === '<' && text[index + 2] === '<') {
      // A here-string is one more word. A shell that reads it is a runner, so it is read.
      endWord();
      words.push('<<<');
      index += 3;
    } else if (character === '<' && next === '<' && !word.endsWith('<')) {
      // `3<<EOF`: the number names the file descriptor, part of the redirect, not a word.
      if (inWord && !isQuoted && /^(\d+|\{[A-Za-z_]\w*\})$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      spend(groups.length);
      const doc = heredoc(text, index + 2, line.length, [...groups]);
      if (doc) {
        // Right after a group closes, the heredoc is the group's input: `{ read a; } <<EOF`,
        // `while read l; do x; done <<EOF` (there the closing word leads the command).
        if (closed && withoutRedirects(words).length === (closed.kind === '(' || closed.kind === '{' ? 0 : 1)) doc.doc.group = closed;
        pending.push(doc.doc);
        index = doc.end;
      } else {
        words.push('<<'); // no word after it: bash calls that an error; read on
        index += 2;
      }
    } else if (character === '>' && inWord && !isOperatorStart(word, isQuoted)) {
      // An unquoted > inside a word starts a redirect, as in bash: `echo hi>f` is `echo hi >f` (#402).
      endWord();
      word = character;
      inWord = true;
      index++;
    } else {
      word += character;
      inWord = true;
      index++;
    }
  }
  finish();
  return closer ? -1 : text.length;
}

// Adds the bodies of `group` and of the groups closed inside it to `into`. Each closed group
// has one parent, and its bodies are taken once, so a deep nest of groups costs no more
// than its bodies.
function groupBodies(group: Group, into: string[]): void {
  const stack = [group];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    spend(1 + next.bodies.length);
    for (const body of next.bodies) into.push(body);
    for (const inner of next.inner) stack.push(inner);
    next.bodies = [];
    next.inner = [];
  }
}

// The end of a $'...' string: the next ' without a \ before it.
function closeAnsi(text: string, i: number): number {
  for (; i < text.length; i++) {
    spend(1);
    if (text[i] === '\\') i++;
    else if (text[i] === "'") return i;
  }
  return -1;
}

// What readDouble returns when a substitution inside never closed: that read went on to the
// end of the text, so the caller must not read the rest again.
const RAN_OUT = Symbol('ran out');

// Reads "..." from after the opening quote. $(...) and `...` inside it run, so they are
// read as commands. Returns the word's text and the index after the closing quote, or null
// when it never closes (RAN_OUT when a substitution in it never closes). With `toEnd` there is no closing quote: it reads a heredoc body.
function readDouble(text: string, index: number, depth: number, out: string[][], toEnd = false, substitutions: string[] = []): { value: string; end: number } | typeof RAN_OUT | null {
  let value = '';
  while (index < text.length) {
    spend(1);
    const character = text[index];
    if (character === '"' && !toEnd) return { value, end: index + 1 };
    if (character === '\\') {
      // In "...", \ escapes only $ ` " \ and a line end. Before anything else it stays.
      const n = text[index + 1] ?? '';
      if (n && '$`"\\'.includes(n)) value += n;
      else if (n !== '\n') value += character + n;
      index += 2;
    } else if (character === '$' || character === '`') {
      // A joined line hides the opener: `"$\⏎(sh)"` is `"$(sh)"` before parsing.
      const opened = character === '`' ? index : skipContinuation(text, index + 1);
      if (character === '`' || text[opened] === '(') {
        const from = character === '`' ? index + 1 : opened + 1;
        const end = read(text, from, character === '`' ? '`' : ')', depth + 1, out);
        if (end === -1) return RAN_OUT;
        substitutions.push(text.slice(from, end - 1));
        value += character === '`' ? text.slice(index, end) : '$(' + text.slice(from, end);
        index = end;
      } else {
        value += character;
        index++;
      }
    } else {
      value += character;
      index++;
    }
  }
  return toEnd ? { value, end: index } : null;
}

// Reads the word after << or <<-. A quoted word means the body is not expanded.
function heredoc(text: string, index: number, cmd: number, groups: Group[]): { doc: Heredoc; end: number } | null {
  const strip = text[index] === '-';
  if (strip) index++;
  while (text[index] === ' ' || text[index] === '\t') index++;
  const start = index;
  let delim = '';
  let quoted = false;
  // A \r is part of the word, as in bash: `<<EOF\r` ends at a line `EOF\r`.
  while (index < text.length && !/[ \t\n;&|()<>]/.test(text[index])) {
    const character = text[index];
    // `<<$'EOF'` and `<<$"EOF"`: bash ends the body at EOF, without the $.
    if (character === '$' && (text[index + 1] === "'" || text[index + 1] === '"')) {
      index++;
      continue;
    }
    if (character === '"') {
      // In "...", a \ before " \ $ or ` is removed: `<<"E\"F"` ends at a line `E"F` (#439).
      let at = index + 1;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\' && '"\\$`'.includes(text[at + 1] ?? '')) at++;
        delim += text[at];
        at++;
      }
      spend(at - index);
      if (at >= text.length) return null;
      quoted = true;
      index = at + 1;
    } else if (character === "'") {
      const end = text.indexOf(character, index + 1);
      spend((end === -1 ? text.length : end) - index);
      if (end === -1) return null;
      delim += text.slice(index + 1, end);
      quoted = true;
      index = end + 1;
    } else if (character === '\\') {
      delim += text[index + 1] ?? '';
      quoted = true;
      index += 2;
    } else {
      delim += character;
      index++;
    }
  }
  // A \ before a line end in the word, quoted or not: bash may join the two lines
  // (`<<"E\⏎F"` ends at a line EF). The guard does not follow that, so it refuses (#439).
  if (text.slice(start, index).includes('\\\n')) throw new UnsureHeredoc('a line end in a heredoc word');
  return delim ? { doc: { delim, strip, quoted, cmd, groups }, end: index } : null;
}

class UnsureHeredoc extends Error {}

// Reads the heredoc bodies that start at `index`, in order, and returns the index after the
// last one. A body is data, unless a shell or runner reads it (#196): the program of the
// command that holds the <<, or of a command it pipes into (`cat <<EOF | bash`). The
// program is found after assignments, keywords and launchers (see readsCommands), so
// `then bash <<EOF` and `env X=1 bash -s <<EOF` count, and `cat > sh <<EOF` or
// `node - <<EOF` do not. So does a command with no program (see feedsShell). A pipe left open at the line end (`cat <<EOF |`) counts too: its
// reader is on a later line. A group that closed on the line pipes its commands on
// (`{ cat <<EOF; } | bash`). Then the body is read as commands. A body in a group still
// open waits in the group: where the group sends its output decides (see `settle` in read).
// A heredoc right after a group closes is the group's input (`{ read a; } <<EOF`): it is
// commands when a command in the group reads commands, or the group pipes into one.
// An unquoted body still runs $(...) and `...`, so those are read too. A body with no end
// line runs to the end of the text, as in bash.
function bodies(text: string, index: number, docs: Heredoc[], { line, pipes, groups }: { line: string[][]; pipes: boolean[]; groups: Group[] }, depth: number, out: string[][]): number {
  // Once per line, from the last command back: where the pipeline from each command ends,
  // and whether a command from it to there reads commands. Each heredoc then looks it up.
  spend(line.length);
  const ends: number[] = [];
  const reads: boolean[] = [];
  for (let i = line.length - 1; i >= 0; i--) {
    const pipesOn = pipes[i] && i + 1 < line.length;
    ends[i] = pipesOn ? ends[i + 1] : i;
    reads[i] = readsCommands(line[i]) || (pipesOn && reads[i + 1]);
  }
  const handedTo = new Map<number, string | null>(); // what xargs runs, for each command that holds a heredoc
  for (const doc of docs) {
    const lines: string[] = [];
    while (index < text.length) {
      let nl = text.indexOf('\n', index);
      if (nl === -1) nl = text.length;
      spend(nl - index + 1);
      const ln = text.slice(index, nl);
      index = nl + 1;
      // As in bash, a line ends the body only when it is the word exactly: `EOF\r` does not.
      if ((doc.strip ? ln.replace(/^\t+/, '') : ln) === doc.delim) break;
      lines.push(ln);
    }
    const body = lines.join('\n');
    // `xargs git <<EOF`: the body's words are the program's words.
    if (!handedTo.has(doc.cmd)) handedTo.set(doc.cmd, xargsCommand(line[doc.cmd] ?? []));
    const handed = handedTo.get(doc.cmd) ?? null;
    if (handed !== null) out.push(...commandWords(`${handed} ${xargsInput(line[doc.cmd] ?? [], body)}`, depth + 1));
    const last = ends[doc.cmd] ?? doc.cmd;
    const isOpenPipe = last > doc.cmd && line[last].length === 0;
    const isRead = doc.group ? doc.group.reads : feedsShell(line[doc.cmd] ?? []);
    if (isOpenPipe || isRead || reads[doc.cmd] === true) {
      out.push(...commandWords(body, depth + 1));
      continue;
    }
    if (!doc.quoted) readDouble(body, 0, depth, out, true);
    doc.groups.findLast((group) => groups.includes(group))?.bodies.push(body);
  }
  return Math.min(index, text.length);
}

// A heredoc on a command with no program feeds the shell itself: `exec <<EOF`, `exec
// 3<<EOF; bash <&3`, or a bare redirect. A keyword (`done <<EOF`) hands it to its loop.
function feedsShell(words: string[]): boolean {
  return words.every((word) => !KEYWORDS.has(word) && !HEADS.has(word)) && findPrograms(words).length === 0;
}

// Programs that read their input as data, never as commands.
const DATA_READERS = new Set([
  'cat', 'tee', 'node', 'deno', 'bun', 'gh', 'git', 'yokoten', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq',
  'jq', 'yq', 'tr', 'cut', 'less', 'more', 'diff', 'patch', 'base64', 'xxd', 'od', 'column', 'fold', 'fmt', 'nl', 'paste', 'rev', 'iconv',
  'gzip', 'xz', 'zstd', 'bzip2', 'tar', 'curl', 'wget', 'mail', 'mailx', 'sendmail', 'pbcopy', 'xclip', 'wl-copy', 'clip', 'sponge',
  'read', 'mapfile', 'readarray', 'true', ':',
]);

// Whether a command reads its input as commands. The program is found after assignments,
// shell keywords and launchers (`then bash`, `stdbuf -oL bash`). When it is one of
// DATA_READERS, only a shell or runner up to it counts, so `cat > sh <<EOF` and
// `node x.ts --shell bash <<EOF` are data, and `sudo -s` still counts. When it is not, the
// guard does not know what the program does with its input, so a shell or runner anywhere
// in the command counts: `mystery-launcher bash <<EOF` is refused rather than guessed.
// The answer is kept per command: a line of heredocs and pipes asks again for the same one.
// An empty list is not kept: the reader may still fill it.
const readsCache = new WeakMap<string[], boolean>();

function readsCommands(words: string[]): boolean {
  const known = readsCache.get(words);
  if (known !== undefined) return known;
  const program = findPrograms(words)[0];
  let reads: boolean;
  // A program from a variable (`$line`) may be anything, so its input may run.
  if (program?.startsWith('$')) reads = true;
  else if (program === undefined || !DATA_READERS.has(programName(program))) reads = runnerAt(words) !== -1;
  else {
    const at = words.indexOf(program);
    reads = runnerAt(withoutRedirects(at === -1 ? words : words.slice(0, at + 1))) !== -1;
  }
  if (words.length > 0) readsCache.set(words, reads);
  return reads;
}

// The words with each redirect and its file taken out: `> sh cat` names no shell.
function withoutRedirects(words: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; ) {
    const length = redirectLength(words, index);
    if (length === 0) kept.push(words[index]);
    index += length || 1;
  }
  return kept;
}

// The old cut: quotes become spaces, then cut at ; | & ( ) and line ends. It finds more
// than is there, so it is only the fallback when nesting is too deep to follow.
function rough(text: string): string[][] {
  return text
    .replace(/['"`]/g, ' ')
    .split(/[;|&()\r\n]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

// gh's token can do all that the guard stops in gh: with it, curl or a script calls the host
// itself (#659, #668). No agent needs to see it, since gh and `yokoten bot` use it without
// showing it. So, for every agent, the guard refuses the plain ways to print or send it:
// gh's own commands that print it, a gh alias (which can run them under another name), the
// token's variables, git's and the system's credential stores, and settings that make the
// bot's gh or git run another program in the bot's environment, which holds the token.
// It reads characters, not code: a script written and then run, or one that reads gh's
// files itself, gets past (guide: What it doesn't do).

const TOKEN_FIX = 'run gh itself, or `yokoten bot -- gh …`, which use the token without showing it; `gh auth status` says whether gh is signed in';
// The names, with a way around a refusal that only mentions one.
const NAME_FIX = `${TOKEN_FIX}. To write the name in a post, put the text in a body file; to search for it, leave out the \`$\` (\`rg GH_TOKEN\`)`;
const BOT_FIX = 'run the bot\'s gh or git with no settings in front and no `-c`; a pager, an editor or a credential helper would run in the bot\'s environment, which holds its token';

const TOKEN_NAMES = 'GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN';
// `$GH_TOKEN`, `${GH_TOKEN}`, `${GH_TOKEN:-x}`, `${#GH_TOKEN}`, `${!GH_TOKEN}`, in any quotes.
const TOKEN_VARIABLE = new RegExp(String.raw`\$\{?[#!]?(?:${TOKEN_NAMES})(?!\w)`);
// PowerShell's `$env:GH_TOKEN` and cmd's `%GH_TOKEN%`. Windows names ignore case.
const WINDOWS_VARIABLE = new RegExp(String.raw`\$env:(?:${TOKEN_NAMES})(?!\w)|%(?:${TOKEN_NAMES})%`, 'i');
const TOKEN_NAME = new RegExp(String.raw`(?<!\w)(?:${TOKEN_NAMES})(?!\w)`);
// Programs that run the code they are given, or print a variable by name: `process.env.GH_TOKEN`
// in `node -e` reads the token. A shell is left out: the guard reads `bash -c` text as commands.
const READS_ENV = /^(python[\d.]*|node|nodejs|deno|bun|tsx|ts-node|perl|ruby|php|lua|osascript|pwsh|powershell|printenv|awk|gawk|mawk|jq|Rscript|tclsh|java)$/;
// Git prints the Authorization header in a trace only when this is turned off.
const TRACE_UNREDACTED = /(?<!\w)GIT_TRACE_REDACT=(?!["']?(?:1|true|yes|on)(?:["'\s;&|)]|$))/i;
// Git settings in the environment: they reach the bot's git, which keeps the variables it is given.
const GIT_CONFIG_VARIABLE = /(?<!\w)GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)=/;
// The files gh and git keep a login in, as plain text.
const CREDENTIAL_FILE = /(?:^|[\\/])(?:\.git-credentials|gh[\\/]hosts\.ya?ml)$/;
const shows = (what: string, fix = TOKEN_FIX) => finding('gh-token', what, fix);

/** The keys git's `-c key=value` and `--config-env key=VAR` set before git's command, in lower case. */
function gitSettings(args: string[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (!word.startsWith('-')) break;
    let setting: string | undefined;
    if (word === '-c' || word === '--config-env') setting = args[++index];
    else if (word.startsWith('--config-env=')) setting = word.slice('--config-env='.length);
    else if (word.startsWith('-c')) setting = word.slice(2);
    else if (GIT_VALUE_OPTIONS.has(word)) index++;
    if (setting !== undefined) keys.push(setting.split('=')[0].toLowerCase());
  }
  return keys;
}

/** Where the bot's command starts in the words (`yokoten bot -- git …`), or -1. */
const botAt = (words: string[]) => {
  const at = words.findIndex((word, index) => word === 'bot' && words[index + 1] === '--');
  return at === -1 ? -1 : at + 2;
};

/** For every agent: a command that shows gh's token, or lets a program take it, or null. */
function checkTokenUse(command: string, commands: string[][]): Finding | null {
  if (TOKEN_VARIABLE.test(command) || WINDOWS_VARIABLE.test(command)) {
    return shows("the command expands gh's token from the environment, so it can reach the host around the guard", NAME_FIX);
  }
  if (TRACE_UNREDACTED.test(command)) return shows('GIT_TRACE_REDACT turned off makes a git trace print the token git sends');
  const bot = commands.some((words) => botAt(words) !== -1);
  if (bot && GIT_CONFIG_VARIABLE.test(command)) return shows('git settings in the environment reach the bot\'s git, and can run a program where the bot\'s token is', BOT_FIX);
  for (const raw of commands) {
    // A here-string is read as a command of its own: `bash <<< 'gh auth token'`.
    const words = raw[0] === '<<<' ? raw.slice(1) : raw;
    const names = words.map(programName);
    const runner = names.find((name) => READS_ENV.test(name));
    if (runner && words.some((word) => TOKEN_NAME.test(word))) return shows(`\`${runner}\` is given the name of gh's token, so it can read the token and reach the host around the guard`, NAME_FIX);
    if (words.some((word) => CREDENTIAL_FILE.test(word))) return shows('the command names a file where gh or git keeps a login as plain text');
    const reached = checkCredentialStores(words, names) ?? checkTokenGit(words) ?? hostTokenReveal(words);
    if (reached) return reached;
  }
  return null;
}

/** The system's password stores and git's credential helpers, asked for a password. */
function checkCredentialStores(words: string[], names: string[]): Finding | null {
  const at = (name: string) => names.indexOf(name);
  const security = at('security');
  if (security !== -1 && /^find-(internet|generic)-password$/.test(words[security + 1] ?? '') && words.some((word) => /^-[a-zA-Z]*[wg]$/.test(word))) {
    return shows('`security find-…-password -w` prints a password from the keychain, where gh may keep its token');
  }
  const secretTool = at('secret-tool');
  if (secretTool !== -1 && words[secretTool + 1] === 'lookup') return shows('`secret-tool lookup` prints a password from the keyring, where gh may keep its token');
  if (names.some((name) => name.startsWith('git-credential')) && words.includes('get')) return shows('a git credential helper with `get` prints the password it keeps, which may be gh\'s token');
  return null;
}

/** git: a credential read, a credential helper set with `-c`, and any setting given to the bot's git. */
function checkTokenGit(words: string[]): Finding | null {
  const at = words.findIndex(isGit);
  if (at === -1) return null;
  const args = withoutShellRedirects(words, at + 1);
  const keys = gitSettings(args);
  if (at === botAt(words) && keys.length) return shows(`\`-c ${keys[0]}\` on the bot's git can run a program where the bot's token is`, BOT_FIX);
  if (keys.some((key) => key.startsWith('credential.'))) return shows('a credential helper set with `-c` runs a program that gets git\'s login');
  const [sub, action] = plainArgs(args, [...GIT_VALUE_OPTIONS]);
  if (sub === 'credential' && action === 'fill') return shows("`git credential fill` prints the password git keeps for a host, which is gh's token when gh signs git in");
  if (sub?.startsWith('credential-') && args.includes('get')) return shows(`\`git ${sub} get\` prints the password it keeps, which may be gh's token`);
  return null;
}
