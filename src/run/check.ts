// The checks that see every road: an agent can change a file with its edit tool, with
// sed, or with a script, and only the commit sees all three. The hook stops the edit
// tool early; this is the inspection at the end of the line.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config, Env } from '../rules/config.ts';
import { findUnknownKeys, matcher } from '../rules/config.ts';
import { checkEdit, isLeadOnly, withWorkerMark } from '../rules/guards.ts';
import { checkBuildOutput, checkLayout } from '../rules/layout.ts';
import { type Finding, finding, isFailingFinding } from '../rules/message.ts';
import { isChangeFile, longSentenceNote, longSentences } from '../rules/pr.ts';
import { autoLogins, loadIgnores, mapMarkKinds, notUtc, repoMarkKinds, scanText, TIME_ZONE_FIX } from '../rules/privacy.ts';
import { parseChange, readChanges } from './changelog.ts';
import { isShallowNote, translationNotes } from './translations.ts';

// ---- Git answers kept for a run (#408, #453) ----
//
// Within one run (a doctor or an init), several checks ask git the same question: the
// repo's own core.hooksPath, say, or the files in the index. Each answer is kept for the
// run, so git starts once per question (#408, #453). Only inside `withGitReads`: init
// writes core.hooksPath, and tests change it between runs, so nothing is kept from one run
// to the next. The config values come from one `git config --list` a run; outside a run
// each value is one `git config --get`, as one value is all most callers need.

type Answer = { value: unknown } | { error: unknown };

let answers: Map<string, Answer> | null = null;

/** Run `read` with each git answer below kept until it returns. */
export function withGitReads<T>(read: () => T): T {
  const outer = answers;
  answers ??= new Map();
  try {
    return read();
  } finally {
    answers = outer;
  }
}

/** Drop the answers kept so far in this run: after a git write, as init's `git config core.hooksPath`. */
export function forgetGitReads(): void {
  answers?.clear();
}

/** The answer `read` gives, kept under `key` while `withGitReads` runs. A read that throws throws again, without a second try. */
export function remembered<T>(key: string, read: () => T): T {
  if (!answers) return read();
  let answer = answers.get(key);
  if (!answer) {
    try {
      answer = { value: read() };
    } catch (error) {
      answer = { error };
    }
    answers.set(key, answer);
  }
  if ('error' in answer) throw answer.error;
  return answer.value as T;
}

/** One git config entry: the scope it comes from (local, global, system, command, worktree), its key as git prints it, and its value. */
export interface ConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** The key as `git config --list` prints it: the section and the name in lower case, a subsection as it is. */
export function configKey(key: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

/** The entries of `git config --list --show-scope -z`: `scope\0key\nvalue\0` each, or `scope\0key\0` for a key with no `=`. */
export function parseConfigList(text: string): ConfigEntry[] {
  const parts = text.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [scope, item] = [parts[i], parts[i + 1]];
    const newline = item.indexOf('\n');
    entries.push(newline === -1 ? { scope, key: item, value: '' } : { scope, key: item.slice(0, newline), value: item.slice(newline + 1) });
  }
  return entries;
}

// The keys of two answers: `assumeEmptyFolder` keeps them ahead of the reads.
const listKey = (root: string, env: Env) => `config-list\0${root}\0${JSON.stringify(env)}`;
const indexKey = (root: string) => `ls-files\0${root}`;

/**
 * Every config entry git sees in `root` with `env`, oldest first, from one call kept for
 * the run. Null outside a run, or when git can't list them: the caller then asks per key.
 */
function readConfigList(root: string, env: Env): ConfigEntry[] | null {
  if (!answers) return null;
  return remembered(listKey(root, env), () => {
    try {
      return parseConfigList(execFileSync('git', ['config', '--list', '--show-scope', '-z'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 1 << 26 }));
    } catch {
      return null;
    }
  });
}

/** The entries of the keys `match` takes (a key name, or a test of the key as git prints it), oldest first; null as for `readConfigList`. */
export function configEntries(root: string, match: string | RegExp, env: Env): ConfigEntry[] | null {
  const list = readConfigList(root, env);
  if (!list) return null;
  const key = typeof match === 'string' ? configKey(match) : null;
  return list.filter((entry) => (key === null ? (match as RegExp).test(entry.key) : entry.key === key));
}

/** The value `git config --get key` gives in `root` (the last one set), trimmed, or '' when it is not set or git fails. */
export const gitConfig = (root: string, key: string, env: Env): string => {
  const entries = configEntries(root, key, env);
  if (entries) return (entries.at(-1)?.value ?? '').trim();
  return remembered(`config\0${root}\0${key}\0${JSON.stringify(env)}`, () => {
    try {
      return execFileSync('git', ['config', '--get', key], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  });
};

/**
 * Keep, for this run, the answers git gives in an empty folder outside any repo with no
 * config: no entries, and no index. For a self-test's folder (doctor's road control), so
 * the control reads no git and no config of this machine. Nothing outside a run.
 */
export function assumeEmptyFolder(root: string, env: Env): void {
  answers?.set(listKey(root, env), { value: [] });
  answers?.set(indexKey(root), { error: new Error(`${root} is not in a git repository`) });
}

/** The answer of `read` (the files in the index of `root`), kept for the run under one key for every caller. */
export const rememberedIndex = (root: string, read: () => string[]): string[] => remembered(indexKey(root), read);

/**
 * A git read a check depends on that git could not answer (#403): it failed, was stopped,
 * or wrote more than the buffer holds. The check stops on it and says so, never reading
 * no answer as "clean" or "no changes". `gitReadFinding` turns it into the finding.
 */
export class GitReadError extends Error {}

/** Why a git call gave no answer, in a few words; git's own first line of stderr when it has one. */
function whyNoAnswer(result: { error?: Error; status: number | null; signal: NodeJS.Signals | null; stderr: Buffer | string | null }, maxBuffer: number): string {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOBUFS') return `its output is over the ${maxBuffer >= 1 << 20 ? `${maxBuffer >> 20} MB` : `${maxBuffer} bytes`} yokoten reads`;
  if (code === 'ETIMEDOUT') return 'it took too long and was stopped';
  if (code === 'ENOENT') return 'git, or the folder it runs in, was not found';
  if (result.error) return result.error.message.split('\n')[0];
  if (result.signal) return `it was stopped by ${result.signal}`;
  const said = String(result.stderr ?? '').split('\n').find((line) => line.trim());
  return `it exited ${result.status}${said ? `: ${said.trim().replace(/[.\s]+$/, '')}` : ''}`;
}

/**
 * Git that reads the objects as they are, not as `git replace` shows them. A replace ref
 * makes git show other bytes than the ones it commits, and replace refs are pushed like
 * any ref, so a check that reads through one checks the wrong bytes (#284, #294). Every
 * read of repo content goes through here. Bytes, not text: a blob may be binary. Any exit
 * but 0 throws a GitReadError (#403); `okCodes` names other exits that are answers.
 */
export function runGit(cwd: string, args: string[], { env, input, maxBuffer = 1 << 30, okCodes = [0] }: { env: Env; input?: string; maxBuffer?: number; okCodes?: number[] }): { stdout: Buffer; status: number } {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd, env, input, maxBuffer });
  if (result.error || result.status === null || !okCodes.includes(result.status)) {
    throw new GitReadError(`\`git ${args.join(' ')}\` gave no answer: ${whyNoAnswer(result, maxBuffer)}`);
  }
  return { stdout: result.stdout, status: result.status };
}

/** What git printed, as bytes; see `runGit`. */
export const readGit = (cwd: string, args: string[], options: { env: Env; input?: string; maxBuffer?: number }): Buffer => runGit(cwd, args, options).stdout;

const git = (cwd: string, env: Env, args: string[]) => readGit(cwd, args, { env }).toString('utf8');
const gitBytes = (cwd: string, env: Env, args: string[], input = '', maxBuffer = 1 << 30) => readGit(cwd, args, { env, input, maxBuffer });
const list = (out: string) => out.split('\0').filter(Boolean);

/** A GitReadError as the one finding a check reports in its place (#403). */
export const gitReadFinding = (err: GitReadError): Finding =>
  finding('git-read', `git can't answer, so the check stopped without looking: ${err.message}`, 'run that git command yourself to see why, fix it, then run the check again');

// Outside a repo this fails, and the caller handles it. Hide git's own error, or an agent
// reads it as the result of the command the guard just stopped.
export const gitRoot = (cwd: string, env: Env): string =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The files in the index: what the next commit (or, in CI, the checkout) holds. */
export const indexFiles = (root: string, env: Env): string[] => rememberedIndex(root, () => list(git(root, env, ['ls-files', '-z'])));

/** A staged entry; `from` is the old path of a move or copy. */
type Staged = { status: string; path: string; from?: string; mode: string; blob: string };

/**
 * The files the next commit adds, changes, moves, deletes or changes the type of (a move
 * by its new name, and its old one in `from`), with the mode and blob id git stores for each.
 */
function stagedFiles(root: string, env: Env): Staged[] {
  // -z --raw gives ":oldmode newmode oldblob newblob status", then the path (for R/C, old
  // path then new path).
  const out = list(git(root, env, ['diff', '--cached', '--raw', '--no-abbrev', '--diff-filter=ACDMRT', '-z']));
  const files: Staged[] = [];
  for (let i = 0; i < out.length; ) {
    const [, mode, , blob, status] = out[i].split(' ');
    const moved = status.startsWith('R') || status.startsWith('C');
    files.push(moved ? { status: status[0], path: out[i + 2], from: out[i + 1], mode, blob } : { status: status[0], path: out[i + 1], mode, blob });
    i += moved ? 3 : 2;
  }
  return files;
}

/** A path as a shell word: as it is when it has only plain characters, else in single quotes. */
const shellWord = (path: string): string => (/^[\w./@+=,-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);

/**
 * The line a stopped commit ends with (#503): the one command that takes the staged files the
 * problems name out of the commit, and that they stay on disk. Null when no problem names a staged
 * file. With no commit yet there is no HEAD to restore from, so it is `git rm --cached`.
 */
export function unstageHint(root: string, env: Env, problems: Finding[]): string | null {
  const staged = stagedFiles(root, env).map((entry) => entry.path);
  // A finding for a folder (#521) ends in a slash: the hint names the folder, never its files.
  const isStaged = (file: string) => (file.endsWith('/') ? staged.some((path) => path.startsWith(file)) : staged.includes(file));
  const named = [...new Set(problems.flatMap((problem) => (problem.file !== undefined && isStaged(problem.file) ? [problem.file] : [])))];
  if (!named.length) return null;
  const hasFolder = named.some((file) => file.endsWith('/'));
  let hasHead = true;
  try {
    git(root, env, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    hasHead = false;
  }
  const command = hasHead ? 'git restore --staged' : hasFolder ? 'git rm -r --cached' : 'git rm --cached';
  return `To take ${hasFolder ? (named.length > 1 ? 'these paths' : 'this folder') : named.length > 1 ? 'these files' : 'this file'} out of the commit, run \`${command} ${named.map(shellWord).join(' ')}\`. ${named.length > 1 ? 'They stay' : 'It stays'} on disk, with your changes.`;
}

/** A full object id: SHA-1 or SHA-256. */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The other parents of the merge being committed, from MERGE_HEAD; none outside a merge.
 * `--git-path` finds it in a worktree too. A line that is not an object id makes the whole
 * file untrusted, so none is returned and every staged file gets the role checks. A head
 * HEAD already leads to is a fast-forward, which git commits with one parent, not as a
 * merge, so it is dropped.
 */
function mergeHeads(root: string, env: Env): string[] {
  // Where MERGE_HEAD is must be known (#403); only the file itself may be missing.
  const path = resolve(root, git(root, env, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  if (!lines.every((line) => OBJECT_ID.test(line))) return [];
  // Exit 1 is "not an ancestor": a real other parent. 0 is a fast-forward, which exempts
  // nothing. Anything else is no answer, and the check stops (#403): a head left out here
  // would also leave out the files only that head had.
  return lines.filter((head) => runGit(root, ['merge-base', '--is-ancestor', 'HEAD', head], { env, okCodes: [0, 1] }).status === 1);
}

/**
 * The paths the merge itself changed: those whose staged state differs from every parent. A file the
 * other branch changed matches that branch, so only a conflict resolution or an edit made
 * during the merge is left. HEAD is already a parent the staged list differs from; each
 * MERGE_HEAD parent takes one `git diff`.
 *
 * Like the guards, this is a guard against mistakes, not a lock. MERGE_HEAD is a file the
 * agent can write, so a merge made up on purpose gets past it. The lock is on the server:
 * branch protection and CODEOWNERS.
 */
function mergeMade(root: string, paths: string[], heads: string[], env: Env): string[] {
  let left = paths;
  for (const head of heads) {
    // --no-renames: a move is its old path deleted and its new path added, so the old
    // path counts as changed unless this parent made the same move.
    const differs = new Set(list(git(root, env, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--end-of-options', head])));
    left = left.filter((path) => differs.has(path));
  }
  return left;
}

/**
 * The paths the merge removed that only the other side had: some MERGE_HEAD has the path,
 * and neither the index nor HEAD does. The staged diff is against HEAD, so it never lists
 * them; a worker who merges in a lead-only file and then moves or removes it would
 * otherwise pass. One `git diff` per head, and one `git ls-tree` for HEAD.
 */
function mergeRemoved(root: string, heads: string[], env: Env): string[] {
  if (heads.length === 0) return [];
  const gone = new Set(heads.flatMap((head) => list(git(root, env, ['diff', '--cached', '--no-renames', '--diff-filter=D', '--name-only', '-z', '--end-of-options', head]))));
  if (gone.size === 0) return [];
  const inHead = new Set(list(git(root, env, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])));
  return [...gone].filter((path) => !inHead.has(path));
}

/**
 * The tip of `origin/<default branch>`, or null when this clone has none. A missing
 * `origin/HEAD` falls through to `origin/main`, then `origin/master`. The local branch
 * `main` is never that tip. Git failing is null: the check goes on, and a lead-only
 * file is still checked (#684).
 */
function originDefaultTip(root: string, env: Env): string | null {
  const commitOf = (ref: string): string | null => {
    try {
      const id = git(root, env, ['rev-parse', '--verify', '--quiet', ref]).trim();
      return OBJECT_ID.test(id) ? id : null;
    } catch {
      return null;
    }
  };
  let named: string | null = null;
  try {
    const printed = git(root, env, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim();
    if (/^refs\/remotes\/origin\/.+$/.test(printed)) named = printed;
  } catch {
    named = null;
  }
  const fallback = ['refs/remotes/origin/main', 'refs/remotes/origin/master'];
  for (const ref of named === null ? fallback : [named]) {
    const id = commitOf(ref);
    if (id !== null) return id;
  }
  if (named === null) return null;
  for (const ref of fallback) {
    if (ref === named) continue;
    const id = commitOf(ref);
    if (id !== null) return id;
  }
  return null;
}

/**
 * The one other parent of this merge, when that parent is the tip from `originDefaultTip`.
 * Several parents, or any other commit, are not that merge: a lead-only file stays checked.
 */
function exemptMergeId(root: string, env: Env, heads: string[]): string | null {
  if (heads.length !== 1) return null;
  const tip = originDefaultTip(root, env);
  return tip === heads[0] ? tip : null;
}

/** A gitlink (a submodule's commit): no blob to read in this repo. */
const GITLINK = '160000';

/** How many bytes git reads to decide whether a file is binary. */
const BINARY_PEEK = 8000;
/**
 * The most bytes one `git cat-file --batch` call returns. Blobs are read in batches under
 * it, so a commit of many large images never fills one buffer. A blob larger than it is
 * read only for its first BINARY_PEEK bytes: enough to tell binary, and a text file that
 * big is not scanned for privacy.
 */
export const BATCH_CAP = 64 << 20;

/** A blob as read: its bytes, all of them when `whole`, else only the first BINARY_PEEK. */
export type Blob = { bytes: Buffer; size: number; whole: boolean };

/** Blob ids, in order, as batches of at most `cap` bytes, and the ids each larger than `cap`. */
export function batchBlobs(sizes: Map<string, number>, cap: number): { batches: string[][]; over: string[] } {
  const batches: string[][] = [];
  const over: string[] = [];
  let batch: string[] = [];
  let total = 0;
  for (const [id, size] of sizes) {
    if (size > cap) {
      over.push(id);
      continue;
    }
    if (total + size > cap && batch.length > 0) {
      batches.push(batch);
      batch = [];
      total = 0;
    }
    batch.push(id);
    total += size;
  }
  if (batch.length > 0) batches.push(batch);
  return { batches, over };
}

/**
 * Each blob by id, read in `git cat-file --batch` calls of at most `cap` bytes. A blob
 * missing from the object store is left out. Like every read here, it reads the objects as
 * stored, past any replace ref (#294).
 */
export function readBlobs(root: string, ids: string[], env: Env, cap = BATCH_CAP): Map<string, Blob> {
  const blobs = new Map<string, Blob>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return blobs;
  // Sizes first, so no call returns more than the cap.
  const sizes = new Map<string, number>();
  for (const line of gitBytes(root, env, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], unique.join('\n') + '\n').toString('utf8').split('\n')) {
    const [id, size] = line.split(' ');
    if (size !== undefined && size !== 'missing') sizes.set(id, Number(size));
  }
  const { batches, over } = batchBlobs(sizes, cap);
  for (const id of over) {
    // Only the start: git is stopped once the buffer is past it.
    const out = spawnSync('git', ['--no-replace-objects', 'cat-file', 'blob', id], { cwd: root, env, maxBuffer: BINARY_PEEK, stdio: ['ignore', 'pipe', 'ignore'] }).stdout ?? Buffer.alloc(0);
    const size = sizes.get(id) ?? 0;
    // A read shorter than the peek (or the whole blob, if smaller) is git failing (#403): left
    // out, as a missing blob is, so the entry can't pass unread.
    if (out.length < Math.min(BINARY_PEEK, size)) continue;
    blobs.set(id, { bytes: out.subarray(0, BINARY_PEEK), size, whole: false });
  }
  for (const ids of batches) {
    // Each blob comes back as "<id> <type> <size>\n<bytes>\n".
    const room = ids.reduce((sum, id) => sum + (sizes.get(id) ?? 0) + 128, 0);
    const out = gitBytes(root, env, ['cat-file', '--batch'], ids.join('\n') + '\n', room);
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(10, at);
      const [id, type, size] = out.subarray(at, nl).toString('utf8').split(' ');
      if (type === 'missing') {
        at = nl + 1;
        continue;
      }
      blobs.set(id, { bytes: out.subarray(nl + 1, nl + 1 + Number(size)), size: Number(size), whole: true });
      at = nl + 1 + Number(size) + 1;
    }
  }
  return blobs;
}

/** Binary the way git decides it from the bytes: a NUL in the first 8000. */
const looksBinary = (buf: Buffer) => buf.subarray(0, BINARY_PEEK).includes(0);

/**
 * A file in the work tree as git would store it: a symlink's link text, never its
 * target. Undefined for a deleted file or anything else that is not a file (a submodule).
 */
function readEntry(root: string, path: string): Buffer | undefined {
  try {
    const full = join(root, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return readlinkSync(full, { encoding: 'buffer' });
    return stat.isFile() ? readFileSync(full) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Problems for the whole tree, or with `staged`, for the commit about to be made. For the
 * whole tree, a translation behind its source (#87) goes in `notes`, or with yokoten.json
 * `"translations": { "fail": true }`, in the problems. In a shallow clone, the one note that
 * says translations weren't checked is never a problem (#181). A key in yokoten.json that yokoten
 * does not know (#228) goes in `notes` too.
 */
export function check(root: string, { config, env, staged = false, notes = [] }: { config: Config; env: Env; staged?: boolean; notes?: Finding[] }): Finding[] {
  const problems: Finding[] = [];
  // The index is read once, here or in the run around this check (#453).
  let index: string[] | undefined;
  const indexed = () => (index ??= indexFiles(root, env));
  const kinds = repoMarkKinds(env, root, config.privacy); // less what the repo is named for and the machine allows (#447)
  const marks = kinds.map((mark) => mark.value);
  const logins = autoLogins(kinds);
  const markKinds = mapMarkKinds(kinds);
  const skip = matcher(config.privacy.skip);
  const ignoreFile = loadIgnores(root);
  problems.push(...ignoreFile.problems);
  const privacy = (path: string, buf: Buffer) => {
    if (skip(path) || looksBinary(buf)) return;
    const found = scanText(buf.toString('utf8'), { file: path, marks, logins, allow: config.privacy.allow, kinds: markKinds, ignores: ignoreFile.entries, env });
    for (const hit of found) (isFailingFinding(hit) ? problems : notes).push(hit);
  };
  if (staged) {
    const files = stagedFiles(root, env);
    // git sets GIT_INDEX_FILE for the commit hooks, so an empty commit or an amend is
    // still checked. Run by hand with nothing staged, there is no commit to check (#208).
    const isCommitting = files.length > 0 || env.GIT_INDEX_FILE !== undefined;
    if (!isCommitting) notes.push(finding('time-zone', 'nothing is staged', 'stage a change with `git add`, then run it again', { why: 'with nothing staged there is no commit to check' }));
    // The commit about to be made: git var gives its author and committer, time included.
    if (isCommitting && config.privacy.utc && ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].some((v) => notUtc(git(root, env, ['var', v])))) {
      problems.push(finding('time-zone', "this commit's time carries your time zone", TIME_ZONE_FIX));
    }
    // In a merge, ordinary files are role-checked only when the merge itself changed
    // them, so a side branch may still bring its own files. A lead-only file is exempt
    // only when the one MERGE_HEAD is origin/<default branch> and the index matches
    // that commit (mergeMade drops it), or the path is unchanged against HEAD (it is
    // not in `touched`). Any other lead-only change is checked, and the finding names
    // the file (#684). A move is checked at its old path too: moving AGENTS.md away
    // removes it. A copy leaves it.
    const touched = [...new Set(files.flatMap((f) => (f.from === undefined || f.status !== 'R' ? [f.path] : [f.from, f.path])))];
    // A file only the other branch had, removed during the merge, is the worker's too.
    const heads = mergeHeads(root, env);
    const exemptId = exemptMergeId(root, env, heads);
    const rolePaths = new Set([...mergeMade(root, touched, heads, env), ...mergeRemoved(root, heads, env)]);
    if (exemptId === null) {
      for (const path of touched) {
        if (isLeadOnly(path, config.leadOnly)) rolePaths.add(path);
      }
    }
    // A worker by YOKOTEN_ROLE or by the mark on its worktree, which a runtime's env can't drop (#555).
    const roleEnv = withWorkerMark(env, [root]);
    for (const path of rolePaths) {
      const reason = checkEdit(path, { config, env: roleEnv });
      if (reason) problems.push(reason);
    }
    // A deleted file has no blob, and a submodule's lives in its own repo.
    const kept = files.filter((f) => f.status !== 'D' && f.mode !== GITLINK);
    const blobs = readBlobs(root, kept.map((f) => f.blob), env);
    // An entry whose blob is not in the object store can't be checked, so it can't pass.
    for (const { path } of kept.filter((f) => !blobs.has(f.blob))) {
      problems.push(finding('missing-blob', "git can't read the staged copy", `run \`git add ${path}\` again, or \`git rm --cached ${path}\``, { file: path }));
    }
    // A blob over the batch cap was read only for its start: binary is known, privacy is not.
    for (const { path, blob } of kept) {
      const found = blobs.get(blob);
      if (found?.whole) privacy(path, found.bytes);
      // A staged change file is read as `check --pr` reads it (#346): a problem for
      // `yokoten changelog`'s parser fails the commit, a long sentence is a note.
      if (found?.whole && isChangeFile(path)) {
        const text = found.bytes.toString('utf8');
        problems.push(...parseChange(path, text).problems);
        notes.push(...longSentences(text).map((long) => longSentenceNote(path, long)));
      }
    }
    problems.push(...checkBuildOutput(kept.map(({ path, blob }) => ({ path, binary: looksBinary(blobs.get(blob)?.bytes ?? Buffer.alloc(0)) })), config));
  } else {
    for (const path of indexed()) {
      const buf = readEntry(root, path); // none if deleted in the work tree but not yet staged
      if (buf) privacy(path, buf);
    }
    for (const note of translationNotes(root, indexed(), env)) (config.translations.fail && !isShallowNote(note) ? problems : notes).push(note);
    // A key yokoten.json holds but yokoten does not know (#228).
    notes.push(...findUnknownKeys(root));
    // Every change file present, read by `yokoten changelog`'s own reader (#346). Long
    // sentences are noted only for the files a commit changes, as `check --pr` does.
    problems.push(...readChanges(root).problems);
  }
  // An exempt glob that matches nothing is a note for the tree, not at each commit (#381).
  problems.push(...checkLayout(indexed(), config, staged ? undefined : notes));
  return problems;
}

/**
 * The files changed in the work tree: staged, not staged, and new files git does not
 * ignore. A move counts as a delete and an add. `--no-optional-locks` keeps git from
 * writing the index, so this can run while the agent's own git command runs.
 */
export const changedFiles = (root: string, env: Env): string[] =>
  list(git(root, env, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).map((entry) => entry.slice(3));

/**
 * Problems in the changed files only (#92): the file rules and the privacy check that
 * `check --staged` uses, on what is in the work tree now. The Stop hook runs it, so it
 * reads no history and makes no network call. A deleted file gets only the file rules.
 */
export function checkChanged(root: string, { config, env, notes = [] }: { config: Config; env: Env; notes?: Finding[] }): Finding[] {
  const problems: Finding[] = [];
  const kinds = repoMarkKinds(env, root, config.privacy); // less what the repo is named for and the machine allows (#447)
  const marks = kinds.map((mark) => mark.value);
  const logins = autoLogins(kinds);
  const markKinds = mapMarkKinds(kinds);
  const skip = matcher(config.privacy.skip);
  const ignoreFile = loadIgnores(root);
  problems.push(...ignoreFile.problems);
  for (const path of changedFiles(root, env)) {
    const reason = checkEdit(path, { config, env });
    if (reason) problems.push(reason);
    if (skip(path)) continue;
    const buf = readEntry(root, path); // none if deleted, or a folder (a submodule)
    if (buf && !looksBinary(buf)) {
      const found = scanText(buf.toString('utf8'), { file: path, marks, logins, allow: config.privacy.allow, kinds: markKinds, ignores: ignoreFile.entries, env });
      for (const hit of found) (isFailingFinding(hit) ? problems : notes).push(hit);
    }
  }
  return problems;
}

/** Whether this clone is shallow: git holds only the newest commits (CI's default checkout). */
const isShallow = (root: string, env: Env): boolean => git(root, env, ['rev-parse', '--is-shallow-repository']).trim() === 'true';

/**
 * Whether git reads a grafts file, which can hide commits from git (#284): one named by
 * GIT_GRAFT_FILE, or `info/grafts` where git looks for it (#294).
 */
const hasGrafts = (root: string, env: Env): boolean =>
  Boolean(env.GIT_GRAFT_FILE) || existsSync(resolve(root, git(root, env, ['rev-parse', '--git-path', 'info/grafts']).trim()));

/** What `check --history` reports in a shallow clone, in place of a scan (#266). */
const shallowHistory = (): Finding =>
  finding('shallow-history', "this clone is shallow, so the history check can't see old commits", 'use `fetch-depth: 0` in actions/checkout, or run `git fetch --unshallow`, then run it again');

/** What `check --history` reports when the repo has a grafts file, in place of a scan (#284). */
const graftedHistory = (): Finding =>
  finding('shallow-history', "this repo has a grafts file, so the history check can't see every commit", 'run `git replace --convert-graft-file` to turn .git/info/grafts into replace refs, which the check reads past, then run it again');

/**
 * How many commits on every branch record a time zone other than UTC. History can't be
 * changed without a force push, which is the owner's call, so this is a count to know,
 * not a problem that fails the check. A shallow clone can't count them: 0, and
 * `checkHistory` says why. `env` names a grafts file, as for `checkHistory`.
 */
export function historyTimeZones(root: string, env: Env): number {
  if (isShallow(root, env) || hasGrafts(root, env)) return 0;
  return git(root, env, ['log', '--all', '--format=%ad|%cd', '--date=format:%z'])
    .split('\n')
    .filter((line) => line && line.split('|').some((zone) => notUtc(` ${zone}`))).length;
}

/**
 * The privacy check over every commit on every branch: what was ever committed, plus
 * author and committer emails and commit messages. Run it before a private repo goes
 * public; a file deleted later is still in the history. A shallow clone can't see the
 * older commits, so it is not scanned: one finding says so (#266). A grafts file can hide
 * commits the same way (#284).
 */
export function checkHistory(root: string, { config, env, notes = [] }: { config: Config; env: Env; notes?: Finding[] }): Finding[] {
  if (isShallow(root, env)) return [shallowHistory()];
  if (hasGrafts(root, env)) return [graftedHistory()];
  // The same hit in several commits is reported once.
  const problems = new Map<string, Finding>();
  const warnings = new Map<string, Finding>();
  const add = (found: Finding[]) => {
    for (const f of found) (isFailingFinding(f) ? problems : warnings).set(JSON.stringify(f), f);
  };
  const kinds = repoMarkKinds(env, root, config.privacy); // less what the repo is named for and the machine allows (#447)
  const marks = kinds.map((mark) => mark.value);
  const logins = autoLogins(kinds);
  const markKinds = mapMarkKinds(kinds);
  const skip = matcher(config.privacy.skip);
  const ignoreFile = loadIgnores(root);
  add(ignoreFile.problems);
  const opts = { marks, allow: config.privacy.allow, kinds: markKinds, ignores: ignoreFile.entries, env };

  const log = git(root, env, ['log', '--all', '--format=%h%x00%ae%x00%ce%x00%B%x1e']);
  for (const entry of log.split('\x1e')) {
    const [hash, author, committer, message] = entry.replace(/^\n/, '').split('\0');
    if (!hash) continue;
    add(scanText(`${author}\n${committer}`, { file: `commit ${hash} (author/committer)`, ...opts }));
    add(scanText(message ?? '', { file: `commit ${hash} (message)`, ...opts }));
  }

  // Every blob ever committed, with the first path it was seen at.
  const objects = git(root, env, ['rev-list', '--all', '--objects']).split('\n');
  const blobs = new Map<string, string>();
  for (const line of objects) {
    const [sha, ...rest] = line.split(' ');
    if (sha && rest.length) blobs.set(sha, rest.join(' '));
  }
  const types = gitBytes(root, env, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], [...blobs.keys()].join('\n') + '\n')
    .toString('utf8')
    .split('\n');
  const wanted = types.filter((l) => l.endsWith(' blob')).map((l) => l.split(' ')[0]).filter((sha) => !skip(blobs.get(sha) ?? ''));
  const found = new Map<string, Finding[]>();
  for (const [sha, { bytes, whole }] of readBlobs(root, wanted, env, BATCH_CAP)) {
    if (!whole || looksBinary(bytes)) continue;
    // The blob's path places an added forge login (#410); the finding is named below.
    const hits = scanText(bytes.toString('utf8'), { file: blobs.get(sha) ?? '', ...opts, logins });
    if (hits.length) found.set(sha, hits);
  }
  // Name each blob by the commit that added it (#208), read only when there is a hit.
  const added = found.size ? firstCommits(root, env) : new Map<string, { commit: string; path: string }>();
  for (const [sha, hits] of found) {
    const first = added.get(sha);
    const file = first ? `${first.path} @ ${first.commit}` : `${blobs.get(sha)} @ blob ${sha.slice(0, 8)}`;
    const hint = first ? '' : `; \`git log --all --find-object=${sha.slice(0, 8)}\` names the commit`;
    add(hits.map((f) => ({ ...f, file, fix: f.fix + hint })));
  }
  notes.push(...warnings.values());
  return [...problems.values()];
}

/**
 * The commit that first added each blob (its first 8 characters), and the blob's path in
 * that commit: one walk of every branch, oldest first. A blob only a merge brings in is
 * not found.
 */
function firstCommits(root: string, env: Env): Map<string, { commit: string; path: string }> {
  const added = new Map<string, { commit: string; path: string }>();
  let commit = '';
  // Plain paths: a raw line is ":old-mode new-mode old-sha new-sha status<TAB>path".
  const log = git(root, env, ['-c', 'core.quotePath=false', 'log', '--all', '--reverse', '--raw', '--no-abbrev', '--no-renames', '--format=commit %H']);
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 15);
    else if (line.startsWith(':')) {
      const tab = line.indexOf('\t');
      const sha = line.slice(0, tab).split(' ')[3];
      if (sha && !added.has(sha)) added.set(sha, { commit, path: line.slice(tab + 1) });
    }
  }
  return added;
}

/** The history's time zone count (`historyTimeZones`), as a note. */
export const timeZoneNote = (commits: number): Finding =>
  finding('time-zone', `${commits} commit(s) record a time zone other than UTC`, "leave them unless the owner decides to rewrite history; new commits are checked");
