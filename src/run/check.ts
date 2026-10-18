// The checks that see every road: an agent can change a file with its edit tool, with
// sed, or with a script, and only the commit sees all three. The hook stops the edit
// tool early; this is the inspection at the end of the line.

import { execFileSync } from 'node:child_process';
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
const gitBytes = (cwd: string, args: string[], input = '') => execFileSync('git', args, { cwd, input, maxBuffer: 1 << 30 });
const list = (out: string) => out.split('\0').filter(Boolean);

// Outside a repo this fails, and the caller handles it. Hide git's own error, or an agent
// reads it as the result of the command the guard just stopped.
export const gitRoot = (cwd: string): string =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The files in the index: what the next commit (or, in CI, the checkout) holds. */
export const indexFiles = (root: string): string[] => list(git(root, ['ls-files', '-z']));

type Staged = { status: string; path: string; mode: string; blob: string };

/**
 * The files the next commit adds, changes, moves, deletes or changes the type of (a move
 * by its new name), with the mode and blob id git stores for each.
 */
function stagedFiles(root: string): Staged[] {
  // -z --raw gives ":oldmode newmode oldblob newblob status", then the path (for R/C, old
  // path then new path).
  const out = list(git(root, ['diff', '--cached', '--raw', '--no-abbrev', '--diff-filter=ACDMRT', '-z']));
  const files: Staged[] = [];
  for (let i = 0; i < out.length; ) {
    const [, mode, , blob, status] = out[i].split(' ');
    const moved = status.startsWith('R') || status.startsWith('C');
    files.push({ status: status[0], path: out[moved ? i + 2 : i + 1], mode, blob });
    i += moved ? 3 : 2;
  }
  return files;
}

/**
 * The other parents of the merge being committed, from MERGE_HEAD; none outside a merge.
 * `--git-path` finds it in a worktree too.
 */
function mergeHeads(root: string): string[] {
  try {
    return readFileSync(resolve(root, git(root, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim()), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The staged paths the merge itself made: those that differ from every parent. A file the
 * other branch changed matches that branch, so only a conflict resolution or an edit made
 * during the merge is left. HEAD is already a parent the staged list differs from; each
 * MERGE_HEAD parent takes one `git diff`.
 */
function mergeMade(root: string, files: Staged[], heads: string[]): Staged[] {
  let left = files;
  for (const head of heads) {
    const differs = new Set(list(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', head])));
    left = left.filter((f) => differs.has(f.path));
  }
  return left;
}

/** A gitlink (a submodule's commit): no blob to read in this repo. */
const GITLINK = '160000';

/** The bytes of each blob, by id, read in one `git cat-file --batch`. */
function readBlobs(root: string, ids: string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (ids.length === 0) return blobs;
  const batch = gitBytes(root, ['cat-file', '--batch'], ids.join('\n') + '\n');
  let at = 0;
  while (at < batch.length) {
    const nl = batch.indexOf(10, at);
    const [id, type, size] = batch.subarray(at, nl).toString('utf8').split(' ');
    if (type === 'missing') {
      at = nl + 1;
      continue;
    }
    blobs.set(id, batch.subarray(nl + 1, nl + 1 + Number(size)));
    at = nl + 1 + Number(size) + 1;
  }
  return blobs;
}

const isBinary = (buf: Buffer) => buf.includes(0);
/** Binary the way git decides it from the bytes: a NUL in the first 8000. */
const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

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
    if (skip(path) || isBinary(buf)) return;
    problems.push(...scanText(buf.toString('utf8'), { file: path, marks, allow: config.privacy.allow }));
  };
  if (staged) {
    // The commit about to be made: git var gives its author and committer, time included.
    if (config.privacy.utc && ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].some((v) => notUtc(git(root, ['var', v])))) {
      problems.push(finding('time-zone', "this commit's time carries your time zone", TIME_ZONE_FIX));
    }
    const files = stagedFiles(root);
    // In a merge, the role checks see only what the merge itself changed: a worker
    // bringing in main is not handing over main's edits to lead-only files or tests.
    for (const { path } of mergeMade(root, files, mergeHeads(root))) {
      const reason = checkEdit(path, { config, env });
      if (reason) problems.push(reason);
    }
    // A deleted file has no blob, and a submodule's lives in its own repo.
    const kept = files.filter((f) => f.status !== 'D' && f.mode !== GITLINK);
    const blobs = readBlobs(root, kept.map((f) => f.blob));
    for (const { path, blob } of kept) privacy(path, blobs.get(blob) ?? Buffer.alloc(0));
    problems.push(...checkBuildOutput(kept.map(({ path, blob }) => ({ path, binary: looksBinary(blobs.get(blob) ?? Buffer.alloc(0)) })), config));
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
    if (buf && !isBinary(buf)) problems.push(...scanText(buf.toString('utf8'), { file: path, marks, allow: config.privacy.allow }));
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
  for (const [sha, body] of readBlobs(root, wanted)) {
    if (isBinary(body)) continue;
    add(scanText(body.toString('utf8'), { file: `${blobs.get(sha)} @ blob ${sha.slice(0, 8)}`, ...opts }));
  }
  return [...problems.values()];
}

/** The history's time zone count (`historyTimeZones`), as a note. */
export const timeZoneNote = (commits: number): Finding =>
  finding('time-zone', `${commits} commit(s) record a time zone other than UTC`, "leave them unless the owner decides to rewrite history; new commits are checked");
