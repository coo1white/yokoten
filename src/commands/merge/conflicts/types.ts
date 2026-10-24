// The shapes the collision work shares (#914): the conflict map (#909) builds them, the move window
// (#910), the file leases in the guard (#911), the merge order (#912) and the rebuild offer (#913)
// read them. One file, so five pieces built at the same time agree on one shape.
//
// The map is kept at `.git/yokoten/conflicts.json` in the clone that built it. The guard reads it
// and never builds it: building runs git for every open change, and the guard has a time budget
// (record 0013).

/** One open change: a pull request on a host, or a local branch or worktree with no host. */
export interface Change {
  /** `pr:12` for a pull request, `branch:feature-x` for a local branch. */
  id: string;
  /** What a person reads: `PR #12`, or `branch feature-x`. */
  label: string;
  /** The branch name. */
  branch: string;
  /** The first 8 characters of its head commit. */
  head: string;
  /** Drafts and changes the owner holds are listed, but never ordered or leased. */
  draft: boolean;
  /** Every path it changes, from `git diff --name-status -M main...head`. A rename lists both paths. */
  files: string[];
  /** Paths it moves away: renamed from, or deleted from main (a split deletes, and git calls that no rename). */
  moves: string[];
  /** Paths that conflict with main now (`git merge-tree`), empty when it merges cleanly; null when git could not tell. */
  mainConflicts: string[] | null;
}

/** Two open changes that conflict with each other. Only pairs that share a file are tried. */
export interface Collision {
  first: string;
  second: string;
  files: string[];
}

export interface ConflictMap {
  /** Format version; a reader refuses a version it does not know and treats the map as missing. */
  version: 1;
  /** ISO time the map was built, in UTC. */
  builtAt: string;
  /** The first 8 characters of main when the map was built. */
  main: string;
  changes: Change[];
  collisions: Collision[];
  /** Paths an open change moves: an edit elsewhere to one of them is refused (#911). */
  leased: Record<string, string>;
  /** Paths three or more open changes touch: a note, not a refusal. */
  hot: string[];
}

/** Where the map is kept, relative to the clone's git folder (`git rev-parse --git-common-dir`). */
export const MAP_FILE = 'yokoten/conflicts.json';

/** A map older than this is stale: the guard allows and the session-start doctor says so. */
export const MAP_MAX_AGE_MS = 60 * 60 * 1000;
