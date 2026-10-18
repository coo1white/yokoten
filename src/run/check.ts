// The checks that see every road: an agent can change a file with its edit tool, with
// sed, or with a script, and only the commit sees all three. The hook stops the edit
// tool early; this is the inspection at the end of the line.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config, Env } from '../rules/config.ts';
import { matcher } from '../rules/config.ts';
import { checkEdit } from '../rules/guards.ts';
import { checkBuildOutput, checkLayout } from '../rules/layout.ts';
import { type Finding, finding } from '../rules/message.ts';
import { loadMarks, notUtc, scanText, TIME_ZONE_FIX } from '../rules/privacy.ts';
import { translationNotes } from './translations.ts';

/**
 * Git that reads the objects as they are, not as `git replace` shows them. A replace ref
 * makes git show other bytes than the ones it commits, and replace refs are pushed like
 * any ref, so a check that reads through one checks the wrong bytes (#284, #294). Every
 * read of repo content goes through here or `gitBytes`. `quiet` hides git's own error.
 */
export const git = (cwd: string, args: string[], { quiet = false } = {}): string =>
  execFileSync('git', ['--no-replace-objects', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'inherit'] });
// Bytes, not text: a blob may be binary.
const gitBytes = (cwd: string, args: string[], input = '') => execFileSync('git', ['--no-replace-objects', ...args], { cwd, input, maxBuffer: 1 << 30 });
const list = (out: string) => out.split('\0').filter(Boolean);

// Outside a repo this fails, and the caller handles it. Hide git's own error, or an agent
// reads it as the result of the command the guard just stopped.
export const gitRoot = (cwd: string): string =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The files in the index: what the next commit (or, in CI, the checkout) holds. */
export const indexFiles = (root: string): string[] => list(git(root, ['ls-files', '-z']));

/** The files the next commit adds, changes, moves or deletes (a move by its new name). */
const stagedChanges = (root: string) => list(git(root, ['diff', '--cached', '--name-status', '--diff-filter=ACDMR', '-z']));

function stagedFiles(root: string): { status: string; path: string }[] {
  // -z --name-status gives: status, path (and for R/C, old path then new path).
  const out = stagedChanges(root);
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i < out.length; ) {
    const status = out[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status: status[0], path: out[i + 2] });
      i += 3;
    } else {
      files.push({ status, path: out[i + 1] });
      i += 2;
    }
  }
  return files;
}

const isBinary = (buf: Buffer) => buf.includes(0);

/** The files the next commit adds or changes, and whether git sees each as binary (`-` lines). */
function stagedBinary(root: string): { path: string; binary: boolean }[] {
  // -z --numstat gives "added\tdeleted\tpath", or for a move "added\tdeleted\t", old path, new path.
  const out = git(root, ['diff', '--cached', '--numstat', '--diff-filter=ACMR', '-z']).split('\0');
  const files: { path: string; binary: boolean }[] = [];
  for (let i = 0; i < out.length; i++) {
    const [added, deleted, path] = out[i].split('\t');
    if (deleted === undefined) continue;
    const binary = added === '-' && deleted === '-';
    if (path) files.push({ path, binary });
    else {
      files.push({ path: out[i + 2], binary });
      i += 2;
    }
  }
  return files;
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
    for (const { status, path } of stagedFiles(root)) {
      const reason = checkEdit(path, { config, env });
      if (reason) problems.push(reason);
      if (status !== 'D') privacy(path, gitBytes(root, ['show', `:${path}`]));
    }
    problems.push(...checkBuildOutput(stagedBinary(root), config));
  } else {
    for (const path of indexFiles(root)) {
      let buf: Buffer;
      try {
        buf = readFileSync(join(root, path));
      } catch {
        continue; // deleted in the work tree but not yet staged
      }
      privacy(path, buf);
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
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, path));
    } catch {
      continue; // deleted, or a folder (a submodule)
    }
    if (!isBinary(buf)) problems.push(...scanText(buf.toString('utf8'), { file: path, marks, allow: config.privacy.allow }));
  }
  return problems;
}

/** Whether this clone is shallow: git holds only the newest commits (CI's default checkout). */
const isShallow = (root: string): boolean => git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';

/**
 * Whether git reads a grafts file, which can hide commits from git (#284): one named by
 * GIT_GRAFT_FILE, or `info/grafts` where git looks for it (#294).
 */
const hasGrafts = (root: string, env: Env = process.env): boolean =>
  Boolean(env.GIT_GRAFT_FILE) || existsSync(resolve(root, git(root, ['rev-parse', '--git-path', 'info/grafts']).trim()));

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
 * `checkHistory` says why.
 */
export function historyTimeZones(root: string): number {
  if (isShallow(root) || hasGrafts(root)) return 0;
  return git(root, ['log', '--all', '--format=%ad|%cd', '--date=format:%z'])
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
export function checkHistory(root: string, { config, env }: { config: Config; env: Env }): Finding[] {
  if (isShallow(root)) return [shallowHistory()];
  if (hasGrafts(root, env)) return [graftedHistory()];
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
  if (wanted.length === 0) return [...problems.values()];
  const batch = gitBytes(root, ['cat-file', '--batch'], wanted.join('\n') + '\n');
  let at = 0;
  while (at < batch.length) {
    const nl = batch.indexOf(10, at);
    const [sha, , size] = batch.subarray(at, nl).toString('utf8').split(' ');
    const body = batch.subarray(nl + 1, nl + 1 + Number(size));
    at = nl + 1 + Number(size) + 1;
    if (isBinary(body)) continue;
    add(scanText(body.toString('utf8'), { file: `${blobs.get(sha)} @ blob ${sha.slice(0, 8)}`, ...opts }));
  }
  return [...problems.values()];
}

/** The history's time zone count (`historyTimeZones`), as a note. */
export const timeZoneNote = (commits: number): Finding =>
  finding('time-zone', `${commits} commit(s) record a time zone other than UTC`, "leave them unless the owner decides to rewrite history; new commits are checked");
