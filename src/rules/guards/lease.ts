// A file lease, as the guard reads it (#911): while an open change is moving or deleting
// a file, an edit to that file from another change is stopped before it starts.
//
// The map itself is built elsewhere (#909) and lives in the clone's git folder. This module
// reads only the map it is given: no git, no network, and no file of its own, so the guard
// keeps its time budget (record 0013).

/**
 * The part of the shared conflict map a lease reads (#914). The shared type lives in
 * `src/commands/merge/conflicts/types.ts`, which this low layer may not import: the
 * architecture test stops a `rules` module that imports from `commands` (record 0004).
 * A `ConflictMap` is wider than this and is accepted as it is.
 */
export interface LeaseMap {
  /** Every open change, by id. A draft holds no lease. */
  changes: ReadonlyArray<{ id: string; label: string; branch: string; draft: boolean }>;
  /** Each path an open change moves, to the id of a change that moves it. */
  leased: Readonly<Record<string, string>>;
}

/** The change whose lease stops an edit. */
export interface Lease {
  /** The change's id, such as `pr:12`. */
  by: string;
  /** What a person reads: `PR #12`, or `branch feature-x`. */
  label: string;
}

/**
 * The lease on `path`, or null when the edit may go ahead. `path` is relative to the repo
 * root with forward slashes, as the guard's other file rules take it. `branch` is the one
 * checked out in the folder of `path`, or `''` when the guard cannot tell.
 *
 * A missing map, a path with no lease, and the lease owner's own branch all return null:
 * a stale or missing map never blocks (the session-start doctor says the map is old), and
 * a change may always edit the files it is moving itself.
 */
export function leaseFor(path: string, branch: string, map: LeaseMap | null): Lease | null {
  if (map === null) return null;
  const by = map.leased[normalisePath(path)];
  if (by === undefined) return null;
  const change = map.changes.find((candidate) => candidate.id === by);
  // A lease that names no change is a map this reader does not understand: allow.
  if (change === undefined || change.draft) return null;
  // The change's own branch is never stopped by its own lease.
  if (change.branch === branch) return null;
  return { by: change.id, label: change.label };
}

/** A repo path the way git writes it: forward slashes, with no leading `./`. */
function normalisePath(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  return slashed.startsWith('./') ? slashed.slice(2) : slashed;
}
