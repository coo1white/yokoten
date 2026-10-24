import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { homeOf } from '../../privacy.ts';
import { type Env } from '../../config.ts';
import { configFolder, configFinding, namesConfigFolder, withHomeRead, configForms, configTargetRefusal, type ConfigContext } from './config.ts';
import { listedWorker } from './list.ts';
import { findSparesGitTree } from '../commands/lose-work.ts';
import { isFolder, globMatches, isGit, GIT_VALUE_OPTIONS, withoutShellRedirects, realPath, FIND_ACTIONS, programName, findPrograms } from '../bash/read/words.ts';
import { gitRootAbove, writeTargets, plainArgs, COPY_VALUES, WRITERS } from '../lead-only/targets.ts';

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
export function protectedGitDirs(folder: string): string[] {
  const link = gitLinkAbove(folder);
  if (link === null || link.kind === 'broken') return [];
  const common = link.kind === 'file' ? readSmallFile(join(link.gitDir, 'commondir'))?.trim() : undefined;
  return [...new Set([link.gitDir, ...(common ? [resolve(link.gitDir, common)] : [])].map(realPath))];
}

const MARK_FIX = 'leave the git folder and the worker mark as they are; if your task needs them, stop and tell the lead';
export const markFinding = (what: string) => finding('worker-mark', what, MARK_FIX);


// Text that names a git folder: the mark, a `.git` part, git's options and variables for one.
const NAMES_GIT_DIR = new RegExp(`${WORKER_MARK}|(^|[\\s'"=:/\\\\(\`;&|<>])\\.git(?=$|[\\s'"/\\\;&|)\`<>])|--(absolute-)?git-(dir|common-dir|path)\\b|\\bGIT_(DIR|COMMON_DIR)\\b|gitdir`, 'i');

/** Whether `name`, one part of a path as the shell reads it (a glob too), can be `.git`. */
export const mayBeDotGit = (name: string) => globMatches(name, '.git');

// Where a path, or a command's text, breaks into parts: folders, words, substitutions.
export const PATH_BREAKS = /[\s/\\()'"`$;|&<>=:]+/;

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
export const MARK_WRITERS = new Set(['chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'touch', 'mkdir', 'mkfifo', 'mknod', 'rsync', 'ln']);
// Programs that run code given to them: what that code changes is not read.
export const RUNS_CODE = /^(python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|osascript|pwsh|powershell|sh|bash|zsh|dash|ksh|fish)$/;
export const FIND_WRITES = /^-(delete|fprint0?|fprintf|fls)$/;

/**
 * For a worker: a command that writes, moves, removes, links or changes the mode of a file in
 * a git folder, or redirects into one (#555), or null. A read that names `.git` passes
 * (`grep --exclude-dir=.git`, `find . -path ./.git -prune`, `grep GIT_DIR`). A target counts
 * when it may be a `.git` folder or the mark (see mayBeGitPath), when its real path is in the
 * worker's own git folders, and when the guard can't read it (`$(...)`, `$x`, `xargs rm`,
 * `find -exec rm`, inline code) in a command that names a git folder. The same holds for
 * yokoten's config folder, where the worker list is kept (#591): see configTargetRefusal.
 */
export function checkWorkerWrites(words: string[], { folder, near = folder, command, env = {} }: { folder: string | null; near?: string | null; command: string; env?: Env }): Finding | null {
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
export const FIND_LEAD_OPTIONS = /^-([HLP]|O\d*)$/;
export const FIND_NAME_TESTS = new Set(['-name', '-iname']);
const FIND_PATH_TESTS = new Set(['-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']);
const FIND_JOINS = new Set(['-o', '-or', '!', '-not', ',']);

/**
 * A find's start folders (`.` when it names none) and its arguments, when it writes: an
 * action in FIND_WRITES, or -exec and its kin running a writer. Null for a find that reads.
 */
export function findWrites(args: string[], writes: (name: string) => boolean): { starts: string[]; args: string[] } | null {
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

