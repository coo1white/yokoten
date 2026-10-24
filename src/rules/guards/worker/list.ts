import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homeIn } from '../../privacy.ts';
import { type Env } from '../../config.ts';
import { realPath } from '../bash/read/words.ts';

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
