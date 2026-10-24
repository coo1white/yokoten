// The move window (#910): a change that moves, renames, splits or deletes files goes in
// alone and first. The window is the set of paths it moves away (a rename's old path, a
// delete, or the delete half of a split). A second change that moves one of them waits.
//
// `structural` gives the merge order its changes, oldest first. `moveCollision` gives the
// refusal the open change already holding the window, so its message can name it.

import type { Change, ConflictMap } from './types.ts';

/**
 * The open changes that move files, oldest first. The map lists its changes in that order,
 * so filtering keeps it. A draft is listed but never ordered, so it is not here.
 */
export function structural(map: ConflictMap): Change[] {
  return map.changes.filter((change) => !change.draft && change.moves.length > 0);
}

/**
 * The open change, other than `branch`, that moves one of `stagedMoves`: the change a commit
 * has to wait for, or null when none does. Oldest first, so the refusal names the change that
 * got there first. A draft still holds the paths it moves, so it counts here.
 */
export function moveCollision(map: ConflictMap, stagedMoves: string[], branch: string): Change | null {
  const moves = new Set(stagedMoves);
  return map.changes.find((change) => change.branch !== branch && change.moves.some((path) => moves.has(path))) ?? null;
}
