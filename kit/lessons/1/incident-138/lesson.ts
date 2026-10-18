// A lesson from incident #138: repo: a bot test fails when the shell uses a proxy
// https://github.com/yokoten-labs/yokoten/issues/138
//
// Drafted by `yokoten learn 138`, then reviewed: the check below finds a test that talks to
// a server on this machine and never sets NO_PROXY.
//
// What happened (from the issue):
//   On 2026-10-18 and 2026-10-19, `npm test` failed three times with one test, then passed
//   on a rerun with nothing changed. The shell had `NODE_USE_ENV_PROXY=1` loaded. With
//   that, Node's `fetch` sends even a call to 127.0.0.1 through the shell's proxy, which
//   closes it. The test called a fake API on 127.0.0.1, so it failed with
//   `UND_ERR_SOCKET: other side closed`.
//
// Fix (from the issue):
//   The test sets `NO_PROXY` and `no_proxy` to `127.0.0.1,localhost` while it runs, then
//   puts them back. Node reads both spellings.
//
// Lesson (from the issue):
//   A test that passes on a rerun is not random: compare what was different around the
//   failing runs (here, the environment), and reproduce it before fixing.
//
// What the check can't see: a test that gets the address from a helper file, or sets
// NO_PROXY in a shared setup file. The second is a false note; "notNow" stops it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The shape of a yokoten finding: what happened, why it matters, and the fix. */
export interface Finding {
  id: string;
  what: string;
  why: string;
  fix: string;
  docs?: string;
}

export const lesson: Finding = {
  id: 'incident-138',
  what: 'a test calls a server on this machine and does not set NO_PROXY',
  why: 'with NODE_USE_ENV_PROXY=1 and a proxy in the shell, Node sends even a call to 127.0.0.1 through the proxy, so the test fails on some machines and passes on a rerun',
  fix: 'set NO_PROXY and no_proxy to 127.0.0.1,localhost while the test runs, then put the old values back',
};

/** JavaScript and TypeScript test files: `*.test.*`, `*.spec.*`, or any file under a test folder. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_FOLDER = /^(test|tests|__tests__)$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
/** Folders that hold someone else's code or build output. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);
/** An http URL to this machine, or a server that listens on it. */
const LOCAL_SERVER = /\bhttps?:\/\/(127\.0\.0\.1|localhost(?![\w.-])|\[::1\])|\.listen\([^)]*['"`](127\.0\.0\.1|localhost|::1)['"`]/;
const SETS_NO_PROXY = /\bno_proxy\b/i;
/** Enough for any real test file, and a stop for a huge generated one. */
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 20_000;

/** The test files under `root`, as paths from it. Hidden folders and others' code are skipped. */
function listTestFiles(root: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const visit = (dir: string, isInTestFolder: boolean) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_FILES) return;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)) visit(path, isInTestFolder || TEST_FOLDER.test(entry.name));
      } else if (entry.isFile() && (TEST_FILE.test(entry.name) || (isInTestFolder && CODE_FILE.test(entry.name)))) found.push(path);
    }
  };
  visit('', false);
  return found;
}

/**
 * The places in the repo at `root` where the incident can happen again: one finding for
 * each place, [] when there is none. `yokoten doctor` runs it in every project that uses
 * the kit, so it reads files only: no network, no writes, and fast. Import only from
 * Node, so the lesson works on its own.
 */
export function findProblems(root: string): Finding[] {
  const problems: Finding[] = [];
  for (const path of listTestFiles(root)) {
    let text: string;
    try {
      if (statSync(join(root, path)).size > MAX_FILE_BYTES) continue;
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    if (LOCAL_SERVER.test(text) && !SETS_NO_PROXY.test(text)) problems.push({ ...lesson, what: `${path}: ${lesson.what}` });
  }
  return problems;
}
