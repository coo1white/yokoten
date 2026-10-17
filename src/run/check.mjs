// The checks that see every road: an agent can change a file with its edit tool, with
// sed, or with a script, and only the commit sees all three. The hook stops the edit
// tool early; this is the inspection at the end of the line.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matcher } from '../rules/glob.mjs';
import { checkEdit } from '../rules/guards.mjs';
import { checkLayout } from '../rules/layout.mjs';
import { loadMarks, scanText } from '../rules/privacy.mjs';

const git = (cwd, args, input) =>
  // With `input` the output is a Buffer: blobs may not be text.
  execFileSync('git', args, { cwd, input, encoding: input === undefined ? 'utf8' : undefined, maxBuffer: 1 << 30 });
const list = (out) => out.split('\0').filter(Boolean);

export const gitRoot = (cwd) => git(cwd, ['rev-parse', '--show-toplevel']).trim();

/** The files in the index: what the next commit (or, in CI, the checkout) holds. */
export const indexFiles = (root) => list(git(root, ['ls-files', '-z']));

/** The files the next commit adds, changes, moves or deletes (a move by its new name). */
const stagedChanges = (root) => list(git(root, ['diff', '--cached', '--name-status', '--diff-filter=ACDMR', '-z']));

function stagedFiles(root) {
  // -z --name-status gives: status, path (and for R/C, old path then new path).
  const out = stagedChanges(root);
  const files = [];
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

const isBinary = (buf) => buf.includes(0);

/** Problems for the whole tree, or with `staged`, for the commit about to be made. */
export function check(root, { config, env, staged = false }) {
  const problems = [];
  const marks = loadMarks(env);
  const skip = matcher(config.privacy.skip);
  const privacy = (path, buf) => {
    if (skip(path) || isBinary(buf)) return;
    problems.push(...scanText(buf.toString('utf8'), { file: path, marks, allow: config.privacy.allow }));
  };
  if (staged) {
    for (const { status, path } of stagedFiles(root)) {
      const reason = checkEdit(path, { config, env });
      if (reason) problems.push(reason);
      if (status !== 'D') privacy(path, git(root, ['show', `:${path}`], ''));
    }
  } else {
    for (const path of indexFiles(root)) {
      let buf;
      try {
        buf = readFileSync(join(root, path));
      } catch {
        continue; // deleted in the work tree but not yet staged
      }
      privacy(path, buf);
    }
  }
  problems.push(...checkLayout(indexFiles(root), config));
  return problems;
}

/**
 * The privacy check over every commit on every branch: what was ever committed, plus
 * author and committer emails and commit messages. Run it before a private repo goes
 * public; a file deleted later is still in the history.
 */
export function checkHistory(root, { config, env }) {
  const problems = new Set();
  const marks = loadMarks(env);
  const skip = matcher(config.privacy.skip);
  const opts = { marks, allow: config.privacy.allow };

  const log = git(root, ['log', '--all', '--format=%h%x00%ae%x00%ce%x00%B%x1e']);
  for (const entry of log.split('\x1e')) {
    const [hash, author, committer, message] = entry.replace(/^\n/, '').split('\0');
    if (!hash) continue;
    for (const p of scanText(`${author}\n${committer}`, { file: `commit ${hash} (author/committer)`, ...opts })) problems.add(p);
    for (const p of scanText(message ?? '', { file: `commit ${hash} (message)`, ...opts })) problems.add(p);
  }

  // Every blob ever committed, with the first path it was seen at.
  const objects = git(root, ['rev-list', '--all', '--objects']).split('\n');
  const blobs = new Map();
  for (const line of objects) {
    const [sha, ...rest] = line.split(' ');
    if (sha && rest.length) blobs.set(sha, rest.join(' '));
  }
  const types = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], [...blobs.keys()].join('\n') + '\n')
    .toString('utf8')
    .split('\n');
  const wanted = types.filter((l) => l.endsWith(' blob')).map((l) => l.split(' ')[0]).filter((sha) => !skip(blobs.get(sha)));
  if (wanted.length === 0) return [...problems];
  const batch = git(root, ['cat-file', '--batch'], wanted.join('\n') + '\n');
  let at = 0;
  while (at < batch.length) {
    const nl = batch.indexOf(10, at);
    const [sha, , size] = batch.subarray(at, nl).toString('utf8').split(' ');
    const body = batch.subarray(nl + 1, nl + 1 + Number(size));
    at = nl + 1 + Number(size) + 1;
    if (isBinary(body)) continue;
    for (const p of scanText(body.toString('utf8'), { file: `${blobs.get(sha)} @ blob ${sha.slice(0, 8)}`, ...opts })) problems.add(p);
  }
  return [...problems];
}
