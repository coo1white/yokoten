// `mergeOrder`: the order `yokoten train` merges open changes, from the conflict map (#912).
//
// Every merge moves main, so the map is built again before the next pick. This module only
// orders the map it is given. It follows three rules:
//
// - A change that moves or deletes a path goes first, alone: every other change still
//   names the old path, so letting one merge through first would move the ground under it.
// - A change that collides with nothing goes next: it can never make a collision worse.
// - Of the rest, the change that the most other changes collide with goes first, so one
//   change several others depend on stops holding them up. Two changes that collide with
//   as many as each other go oldest first.
//
// The shared `Change` shape has no date, so the map's own list is the record of age: the
// map builder lists changes oldest first. A change that conflicts with main now needs a
// rebuild before it can merge, so it comes last with a reason that says so.

import type { Change, ConflictMap } from './types.ts';

/** One pick from the map: the change, and why it is next. The reason is one plain line. */
export interface MergePick {
  id: string;
  why: string;
}

/** Every open change in merge order, each with one plain line saying why it is there. */
export function mergeOrder(map: ConflictMap): MergePick[] {
  const changes = map.changes.filter((change) => !change.draft);
  const age = new Map(map.changes.map((change, index) => [change.id, index]));
  const collisions = countCollisions(changes, map);
  const byAge = (left: Change, right: Change) => (age.get(left.id) ?? 0) - (age.get(right.id) ?? 0);
  const byDegreeThenAge = (left: Change, right: Change) => (collisions.get(right.id) ?? 0) - (collisions.get(left.id) ?? 0) || byAge(left, right);

  const isStructural = (change: Change) => change.moves.length > 0;
  const isBlocked = (change: Change) => (change.mainConflicts?.length ?? 0) > 0;

  const structural = changes.filter(isStructural).sort(byAge);
  const free = changes.filter((change) => !isStructural(change) && !isBlocked(change) && !collisions.get(change.id)).sort(byAge);
  const colliding = changes.filter((change) => !isStructural(change) && !isBlocked(change) && collisions.get(change.id)).sort(byDegreeThenAge);
  const blocked = changes.filter((change) => !isStructural(change) && isBlocked(change)).sort(byAge);

  const picks: MergePick[] = [];
  for (const change of structural) picks.push({ id: change.id, why: structuralReason(change) });
  for (const change of free) picks.push({ id: change.id, why: 'it collides with no other open change' });
  for (let index = 0; index < colliding.length; index++) {
    const change = colliding[index];
    const degree = collisions.get(change.id) ?? 0;
    const next = colliding[index + 1];
    const isTie = next !== undefined && (collisions.get(next.id) ?? 0) === degree;
    picks.push({ id: change.id, why: isTie ? `it collides with ${countOf(degree)}, and it is the oldest at that count` : `it collides with ${countOf(degree)}, more than any other change left` });
  }
  for (const change of blocked) picks.push({ id: change.id, why: blockedReason(change) });
  return picks;
}

/** The next change to merge, or null when the map holds none. */
export function nextPick(map: ConflictMap): MergePick | null {
  return mergeOrder(map)[0] ?? null;
}

/** The pull request numbers in merge order: what `train` merges when it is given none. */
export function listPullRequests(map: ConflictMap): number[] {
  return mergeOrder(map)
    .map((pick) => pick.id)
    .filter((id) => /^pr:\d+$/.test(id))
    .map((id) => Number(id.slice(3)));
}

/** How many collisions name each change. A change the map does not list is left out. */
function countCollisions(changes: Change[], map: ConflictMap): Map<string, number> {
  const counts = new Map(changes.map((change) => [change.id, 0]));
  for (const collision of map.collisions) {
    for (const id of [collision.a, collision.b]) {
      if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

const fileCount = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/** `1 other open change`, or `2 other open changes`. */
const countOf = (count: number) => `${count} other open ${count === 1 ? 'change' : 'changes'}`;

const structuralReason = (change: Change) => `it moves or deletes ${fileCount(change.moves.length)}, so it goes first and alone`;

const blockedReason = (change: Change) => `it conflicts with main in ${fileCount(change.mainConflicts?.length ?? 0)} now, so it needs a rebuild before it can merge`;
