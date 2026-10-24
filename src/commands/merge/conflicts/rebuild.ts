// The rebuild offer (#913): when a change conflicts with main, start its branch again from
// today's main instead of hand-merging it. A hand merge can undo newer work on main: on
// 2026-10-24 a pull request replaced a refusal format that main had just shipped.
//
// Two pieces: `rebuildPrompt` writes what a person pastes into their AI, and `leasePush`
// gives the git arguments that push the rebuilt branch only over the head it started from.
// The conflict map (#909) supplies the branch, its head and the files that collide.

import type { Change, ConflictMap } from './types.ts';

/** A message a person reads: what happened, why it matters, and the safe next step. */
const refuse = (what: string, why: string, fix: string): Error =>
  new Error(`What: ${what}\nWhy: ${why}\nFix: ${fix}`);

/** The change the map holds for `id`, or a plain message that says how to get one. */
function findChange(map: ConflictMap, id: string): Change {
  const change = map.changes.find((candidate) => candidate.id === id);
  if (change !== undefined) return change;
  throw refuse(
    `the conflict map has no change with id ${id}`,
    'a rebuild prompt needs the branch name and the files that collide',
    'run `yokoten conflicts` again, then choose the change from its list',
  );
}

/**
 * The files that collide for one change: the ones git reports against main, then the ones
 * it shares with another open change, each path once and in map order.
 */
function findCollidingFiles(map: ConflictMap, change: Change): string[] {
  const files = [...(change.mainConflicts ?? [])];
  for (const collision of map.collisions) {
    if (collision.a === change.id || collision.b === change.id) files.push(...collision.files);
  }
  return [...new Set(files)];
}

/** A path list a person can read, one path per line; a named placeholder when it is empty. */
function formatPathLines(paths: string[], empty: string): string {
  return paths.length === 0 ? `- ${empty}` : paths.map((path) => `- ${path}`).join('\n');
}

/**
 * What a person pastes into their AI to rebuild a change on today's main (#913). It keeps
 * the old commits as `old-work`, starts the branch again from main, and says which files
 * collide. It never says to force the push: only a lease push is offered.
 */
export function rebuildPrompt(map: ConflictMap, id: string): string {
  const change = findChange(map, id);
  const files = findCollidingFiles(map, change);
  const fileHeading = files.length === 0 ? 'Files this change touches:' : 'Files that collide:';
  return [
    `Rebuild ${change.label} on today's main.`,
    '',
    'This change conflicts with other work on main.',
    'Do not merge the old branch by hand.',
    'Make the same change again on today\'s code.',
    '',
    `Branch: ${change.branch}`,
    `Old head: ${change.head} (keep it as old-work)`,
    `Main now: ${map.main}`,
    fileHeading,
    formatPathLines(files.length === 0 ? change.files : files, 'the map lists no files'),
    '',
    'Follow these steps in order:',
    '1. Keep the old commits for reference:',
    `   git branch old-work ${change.head}`,
    '   If old-work already exists, stop and ask a person.',
    '2. Start the branch again from the latest main:',
    '   git switch main',
    '   git pull --ff-only',
    `   git switch -C ${change.branch} main`,
    '3. Read what the old work changed:',
    '   git diff main...old-work',
    '4. Make the same change again on today\'s code, in small commits.',
    '5. Never undo main\'s newer work.',
    '   Where main changed the same lines, keep main\'s change.',
    '6. Keep every test the old work added. Add each test back, and run it.',
    '7. Use UTC for every commit time:',
    '   TZ=UTC git commit -m "your message"',
    '8. Check that main does not already hold the old work.',
    '   If it does, stop and ask a person.',
    '9. Push the rebuilt branch with a lease on the old head:',
    `   git push ${leasePush(change.branch, change.head).slice(1).join(' ')}`,
    '   If git refuses, the branch moved. Stop and ask a person.',
    '',
    'When you are done, tell the person which tests you ran and what you changed.',
  ].join('\n');
}

/**
 * The git arguments that push a rebuilt branch (#913): `git <args>`. The lease names the
 * branch and the head it started from, so git refuses when the branch moved meanwhile.
 * This is the safe push: a plain force push could throw away the work that moved it.
 */
export function leasePush(branch: string, startedFrom: string): string[] {
  if (branch === '' || branch.startsWith('-') || branch.includes(':')) {
    throw refuse(
      `the branch name "${branch}" cannot be pushed`,
      'a branch name is never empty, never starts with a dash, and holds no colon',
      'use the branch name from the conflict map',
    );
  }
  if (startedFrom === '' || startedFrom.startsWith('-') || startedFrom.includes(':')) {
    throw refuse(
      `the old head "${startedFrom}" cannot be leased`,
      'the lease needs the commit the branch held before the rebuild',
      'use the old head from the conflict map',
    );
  }
  return ['push', `--force-with-lease=${branch}:${startedFrom}`, 'origin', branch];
}
