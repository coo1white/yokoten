// The checks that see every road: an agent can change a file with its edit tool, with
// sed, or with a script, and only the commit sees all three. The hook stops the edit
// tool early; this is the inspection at the end of the line.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config, Env } from '../rules/config.ts';
import { matcher } from '../rules/config.ts';
import { checkEdit } from '../rules/guards.ts';
import { checkBuildOutput, checkLayout } from '../rules/layout.ts';
import { type Finding, finding } from '../rules/message.ts';
import { loadMarks, notUtc, scanText, TIME_ZONE_FIX } from '../rules/privacy.ts';
import { translationNotes } from './translations.ts';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
// Bytes, not text: a blob may be binary.
const gitBytes = (cwd: string, args: string[], input = '', maxBuffer = 1 << 30) => execFileSync('git', args, { cwd, input, maxBuffer });
const list = (out: string) => out.split('\0').filter(Boolean);

// Outside a repo this fails, and the caller handles it. Hide git's own error, or an agent
// reads it as the result of the command the guard just stopped.
export const gitRoot = (cwd: string): string =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The files in the index: what the next commit (or, in CI, the checkout) holds. */
export const indexFiles = (root: string): string[] => list(git(root, ['ls-files', '-z']));

/** A staged entry; `from` is the old path of a move or copy. */
type Staged = { status: string; path: string; from?: string; mode: string; blob: string };

/**
 * The files the next commit adds, changes, moves, deletes or changes the type of (a move
 * by its new name, and its old one in `from`), with the mode and blob id git stores for each.
 */
function stagedFiles(root: string): Staged[] {
  // -z --raw gives ":oldmode newmode oldblob newblob status", then the path (for R/C, old
  // path then new path).
  const out = list(git(root, ['diff', '--cached', '--raw', '--no-abbrev', '--diff-filter=ACDMRT', '-z']));
  const files: Staged[] = [];
  for (let i = 0; i < out.length; ) {
    const [, mode, , blob, status] = out[i].split(' ');
    const moved = status.startsWith('R') || status.startsWith('C');
    files.push(moved ? { status: status[0], path: out[i + 2], from: out[i + 1], mode, blob } : { status: status[0], path: out[i + 1], mode, blob });
    i += moved ? 3 : 2;
  }
  return files;
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
function mergeHeads(root: string): string[] {
  let lines: string[];
  try {
    lines = readFileSync(resolve(root, git(root, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim()), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  if (!lines.every((line) => OBJECT_ID.test(line))) return [];
  // Exit 1 is "not an ancestor": a real other parent. 0 is a fast-forward; 128 is an id
  // git can't read. Both exempt nothing.
  return lines.filter((head) => spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', head], { cwd: root, stdio: 'ignore' }).status === 1);
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
function mergeMade(root: string, paths: string[], heads: string[]): string[] {
  let left = paths;
  for (const head of heads) {
    // --no-renames: a move is its old path deleted and its new path added, so the old
    // path counts as changed unless this parent made the same move.
    const differs = new Set(list(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--end-of-options', head])));
    left = left.filter((path) => differs.has(path));
  }
  return left;
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
 * missing from the object store is left out.
 */
export function readBlobs(root: string, ids: string[], cap = BATCH_CAP): Map<string, Blob> {
  const blobs = new Map<string, Blob>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return blobs;
  // Sizes first, so no call returns more than the cap.
  const sizes = new Map<string, number>();
  for (const line of gitBytes(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], unique.join('\n') + '\n').toString('utf8').split('\n')) {
    const [id, size] = line.split(' ');
    if (size !== undefined && size !== 'missing') sizes.set(id, Number(size));
  }
  const { batches, over } = batchBlobs(sizes, cap);
  for (const id of over) {
    // Only the start: git is stopped once the buffer is past it.
    const out = spawnSync('git', ['cat-file', 'blob', id], { cwd: root, maxBuffer: BINARY_PEEK, stdio: ['ignore', 'pipe', 'ignore'] }).stdout ?? Buffer.alloc(0);
    blobs.set(id, { bytes: out.subarray(0, BINARY_PEEK), size: sizes.get(id) ?? 0, whole: false });
  }
  for (const ids of batches) {
    // Each blob comes back as "<id> <type> <size>\n<bytes>\n".
    const room = ids.reduce((sum, id) => sum + (sizes.get(id) ?? 0) + 128, 0);
    const out = gitBytes(root, ['cat-file', '--batch'], ids.join('\n') + '\n', room);
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
 * `"translations": { "fail": true }`, in the problems.
 */
export function check(root: string, { config, env, staged = false, notes = [] }: { config: Config; env: Env; staged?: boolean; notes?: Finding[] }): Finding[] {
  const problems: Finding[] = [];
  const marks = loadMarks(env);
  const skip = matcher(config.privacy.skip);
  const privacy = (path: string, buf: Buffer) => {
    if (skip(path) || looksBinary(buf)) return;
    problems.push(...scanText(buf.toString('utf8'), { file: path, marks, allow: config.privacy.allow }));
  };
  if (staged) {
    // The commit about to be made: git var gives its author and committer, time included.
    if (config.privacy.utc && ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].some((v) => notUtc(git(root, ['var', v])))) {
      problems.push(finding('time-zone', "this commit's time carries your time zone", TIME_ZONE_FIX));
    }
    const files = stagedFiles(root);
    // In a merge, the role checks see only what the merge itself changed: a worker
    // bringing in main is not handing over main's edits to lead-only files or tests. A
    // move is checked at its old path too: moving AGENTS.md away removes it. A copy leaves it.
    const touched = [...new Set(files.flatMap((f) => (f.from === undefined || f.status !== 'R' ? [f.path] : [f.from, f.path])))];
    for (const path of mergeMade(root, touched, mergeHeads(root))) {
      const reason = checkEdit(path, { config, env });
      if (reason) problems.push(reason);
    }
    // A deleted file has no blob, and a submodule's lives in its own repo.
    const kept = files.filter((f) => f.status !== 'D' && f.mode !== GITLINK);
    const blobs = readBlobs(root, kept.map((f) => f.blob));
    // An entry whose blob is not in the object store can't be checked, so it can't pass.
    for (const { path } of kept.filter((f) => !blobs.has(f.blob))) {
      problems.push(finding('missing-blob', "git can't read the staged copy", `run \`git add ${path}\` again, or \`git rm --cached ${path}\``, { file: path }));
    }
    // A blob over the batch cap was read only for its start: binary is known, privacy is not.
    for (const { path, blob } of kept) {
      const found = blobs.get(blob);
      if (found?.whole) privacy(path, found.bytes);
    }
    problems.push(...checkBuildOutput(kept.map(({ path, blob }) => ({ path, binary: looksBinary(blobs.get(blob)?.bytes ?? Buffer.alloc(0)) })), config));
  } else {
    for (const path of indexFiles(root)) {
      const buf = readEntry(root, path); // none if deleted in the work tree but not yet staged
      if (buf) privacy(path, buf);
    }
    (config.translations.fail ? problems : notes).push(...translationNotes(root, indexFiles(root)));
  }
  problems.push(...checkLayout(indexFiles(root), config));
  return problems;
}

/**
 * The files changed in the work tree: staged, not staged, and new files git does not
 * ignore. A move counts as a delete and an add. `--no-optional-locks` keeps git from
 * writing the index, so this can run while the agent's own git command runs.
 */
export const changedFiles = (root: string): string[] =>
  list(git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).map((entry) => entry.slice(3));

/**
 * Problems in the changed files only (#92): the file rules and the privacy check that
 * `check --staged` uses, on what is in the work tree now. The Stop hook runs it, so it
 * reads no history and makes no network call. A deleted file gets only the file rules.
 */
export function checkChanged(root: string, { config, env }: { config: Config; env: Env }): Finding[] {
  const problems: Finding[] = [];
  const marks = loadMarks(env);
  const skip = matcher(config.privacy.skip);
  for (const path of changedFiles(root)) {
    const reason = checkEdit(path, { config, env });
    if (reason) problems.push(reason);
    if (skip(path)) continue;
    const buf = readEntry(root, path); // none if deleted, or a folder (a submodule)
    if (buf && !looksBinary(buf)) problems.push(...scanText(buf.toString('utf8'), { file: path, marks, allow: config.privacy.allow }));
  }
  return problems;
}

/**
 * How many commits on every branch record a time zone other than UTC. History can't be
 * changed without a force push, which is the owner's call, so this is a count to know,
 * not a problem that fails the check.
 */
export function historyTimeZones(root: string): number {
  return git(root, ['log', '--all', '--format=%ad|%cd', '--date=format:%z'])
    .split('\n')
    .filter((line) => line && line.split('|').some((zone) => notUtc(` ${zone}`))).length;
}

/**
 * The privacy check over every commit on every branch: what was ever committed, plus
 * author and committer emails and commit messages. Run it before a private repo goes
 * public; a file deleted later is still in the history.
 */
export function checkHistory(root: string, { config, env }: { config: Config; env: Env }): Finding[] {
  // The same hit in several commits is reported once.
  const problems = new Map<string, Finding>();
  const add = (found: Finding[]) => {
    for (const f of found) problems.set(JSON.stringify(f), f);
  };
  const marks = loadMarks(env);
  const skip = matcher(config.privacy.skip);
  const opts = { marks, allow: config.privacy.allow };

  const log = git(root, ['log', '--all', '--format=%h%x00%ae%x00%ce%x00%B%x1e']);
  for (const entry of log.split('\x1e')) {
    const [hash, author, committer, message] = entry.replace(/^\n/, '').split('\0');
    if (!hash) continue;
    add(scanText(`${author}\n${committer}`, { file: `commit ${hash} (author/committer)`, ...opts }));
    add(scanText(message ?? '', { file: `commit ${hash} (message)`, ...opts }));
  }

  // Every blob ever committed, with the first path it was seen at.
  const objects = git(root, ['rev-list', '--all', '--objects']).split('\n');
  const blobs = new Map<string, string>();
  for (const line of objects) {
    const [sha, ...rest] = line.split(' ');
    if (sha && rest.length) blobs.set(sha, rest.join(' '));
  }
  const types = gitBytes(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], [...blobs.keys()].join('\n') + '\n')
    .toString('utf8')
    .split('\n');
  const wanted = types.filter((l) => l.endsWith(' blob')).map((l) => l.split(' ')[0]).filter((sha) => !skip(blobs.get(sha) ?? ''));
  for (const [sha, { bytes, whole }] of readBlobs(root, wanted)) {
    if (!whole || looksBinary(bytes)) continue;
    add(scanText(bytes.toString('utf8'), { file: `${blobs.get(sha)} @ blob ${sha.slice(0, 8)}`, ...opts }));
  }
  return [...problems.values()];
}

/** The history's time zone count (`historyTimeZones`), as a note. */
export const timeZoneNote = (commits: number): Finding =>
  finding('time-zone', `${commits} commit(s) record a time zone other than UTC`, "leave them unless the owner decides to rewrite history; new commits are checked");
