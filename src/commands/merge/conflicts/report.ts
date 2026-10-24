// What `yokoten conflicts` says (#909): the plain-words summary a person reads, and the
// map itself with --json. map.ts reads git and writes the cache; this file only chooses
// words. The order here is a first look, not the merge order (#912): it names a pair, then
// says which of the two goes first, which is all a beginner needs before one merge.

import { formatFinding } from '../../../rules/message.ts';
import { type Invocation, parse, print, printJson, requireRoot, say, usage } from '../../shared.ts';
import { beforeChange, buildMap, openChanges, writeMap } from './map.ts';
import type { Change, Collision, ConflictMap } from './types.ts';

/** The most labels one line names before it counts the rest. */
const MAX_LABELS = 6;
/** The most colliding pairs the summary names: the map itself has them all. */
const MAX_PAIRS = 5;
/** The most changes that move a shared file that the summary names. */
const MAX_MOVERS = 3;
/** The most paths one line names before it counts the rest. */
const MAX_PATHS = 3;

const one = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Some paths, or the first few and a count: a line stays short on a big map. */
export function pathsText(paths: string[]): string {
  const first = paths.slice(0, MAX_PATHS);
  const rest = paths.length - first.length;
  return rest > 0 ? `${first.join(', ')}, and ${rest} more` : first.join(', ');
}

/** Some labels, or the first few and a count. */
export function labelsText(changes: Change[]): string {
  const first = changes.slice(0, MAX_LABELS);
  const rest = changes.length - first.length;
  const names = first.map((change) => change.label).join(', ');
  return rest > 0 ? `${names}, and ${rest} more` : names;
}

/** The open changes that collide with main now. */
export const collideWithMain = (map: ConflictMap): Change[] => map.changes.filter((change) => (change.mainConflicts?.length ?? 0) > 0);

/** The two changes of a collision, in the map's order. */
function pairOf(map: ConflictMap, a: string, b: string): [Change, Change] | null {
  const left = map.changes.find((change) => change.id === a);
  const right = map.changes.find((change) => change.id === b);
  return left && right ? [left, right] : null;
}

/**
 * Which of a conflicting pair goes first: the one that touches fewer files, then the
 * smaller one. A pair that conflicts is merged one way round, and the other change follows.
 */
export function firstOf(a: Change, b: Change): Change {
  if (a.files.length !== b.files.length) return a.files.length < b.files.length ? a : b;
  return beforeChange(a, b) ? a : b;
}

/**
 * The changes that move a file another open change also touches: a rename or a delete of a
 * file on main, so a split that deletes the old file counts. A draft is listed, not ordered.
 */
export function movers(map: ConflictMap): { change: Change; others: Change[] }[] {
  const found: { change: Change; others: Change[] }[] = [];
  for (const change of map.changes) {
    if (!change.moves.length) continue;
    const moved = new Set(change.moves);
    const others = map.changes.filter((other) => other.id !== change.id && other.files.some((path) => moved.has(path)));
    if (others.length) found.push({ change, others });
  }
  return found.sort((a, b) => b.others.length - a.others.length);
}

/**
 * The summary: what collides with main, which pairs collide and what to merge first, which
 * change moves what others touch, and which paths are hot. Plain words, one idea a line.
 */
export function summaryLines(map: ConflictMap): string[] {
  if (!map.changes.length) return ['No open change is here to compare with main.', 'Push a branch or open a pull request, then run `yokoten conflicts` again.'];
  const lines: string[] = [];
  const withMain = collideWithMain(map);
  if (!withMain.length && !map.collisions.length) {
    lines.push('No open change collides with main, or with another open change.');
  }
  if (withMain.length) {
    lines.push(`${one(withMain.length, 'change')} ${withMain.length === 1 ? 'collides' : 'collide'} with main: ${labelsText(withMain)}.`);
  }
  const pairs: { collision: Collision; pair: [Change, Change] }[] = [];
  for (const collision of map.collisions) {
    const pair = pairOf(map, collision.a, collision.b);
    if (pair) pairs.push({ collision, pair });
  }
  for (const { collision, pair } of pairs.slice(0, MAX_PAIRS)) {
    const [left, right] = pair;
    const first = firstOf(left, right);
    const second = first === left ? right : left;
    lines.push(`${first.label} and ${second.label} both change ${pathsText(collision.files)}. Merge ${first.label} first, then ${second.label}.`);
  }
  const morePairs = map.collisions.length - Math.min(pairs.length, MAX_PAIRS);
  if (morePairs > 0) lines.push(`${one(morePairs, 'more pair')} collide: \`yokoten conflicts --json\` names every one.`);
  const moving = movers(map);
  for (const { change, others } of moving.slice(0, MAX_MOVERS)) {
    lines.push(`${change.label} moves ${one(change.moves.length, 'file')} that ${one(others.length, 'other change')} ${others.length === 1 ? 'touches' : 'touch'}. It goes in alone, first.`);
  }
  if (moving.length > MAX_MOVERS) lines.push(`${one(moving.length - MAX_MOVERS, 'more change')} move files that others touch: \`yokoten conflicts --json\` names every one.`);
  const drafts = map.changes.filter((change) => change.draft && (change.mainConflicts?.length || map.collisions.some((collision) => collision.a === change.id || collision.b === change.id)));
  if (drafts.length) {
    lines.push(drafts.length === 1
      ? `${drafts[0]?.label ?? 'A draft'} is a draft, so it is listed here, but not ordered.`
      : `${labelsText(drafts)} are drafts, so they are listed here, but not ordered.`);
  }
  if (map.hot.length) {
    lines.push(`${one(map.hot.length, 'file')} ${map.hot.length === 1 ? 'is' : 'are'} hot: ${pathsText(map.hot)}. Three or more open changes touch them, or an open change moves them.`);
  }
  return lines;
}

/** The rebuild offer of #913: a prompt that rebuilds one change instead of merging it. */
type RebuildPrompt = (map: ConflictMap, id: string) => string;

// #913 writes ./rebuild.ts. A variable specifier typechecks and runs before that file
// lands, because the five parts of #914 merge into one branch before the pull request.
const REBUILD_MODULE = './rebuild.ts';

/** The rebuild offer, or null when this build has none yet. */
async function loadRebuild(): Promise<RebuildPrompt | null> {
  try {
    const module = (await import(REBUILD_MODULE)) as { rebuildPrompt?: RebuildPrompt };
    return typeof module.rebuildPrompt === 'function' ? module.rebuildPrompt : null;
  } catch {
    return null;
  }
}

/** Build one change in a fresh worktree instead of merging it (#913), as a prompt to hand over. */
async function rebuild(map: ConflictMap, word: string, invocation: Invocation): Promise<number> {
  const change = map.changes.find((held) => held.id === word || held.branch === word);
  if (!change) {
    print(invocation, [`yokoten conflicts: no open change ${word}. Run \`yokoten conflicts\` to see the ${one(map.changes.length, 'change')} this map holds.`], invocation.stderr);
    return 1;
  }
  const prompt = await loadRebuild();
  if (prompt === null) {
    print(invocation, ['yokoten conflicts: this build has no rebuild offer yet, so nothing was rebuilt.', 'Update yokoten, then run `yokoten conflicts --rebuild` again.'], invocation.stderr);
    return 1;
  }
  print(invocation, prompt(map, change.id).split('\n'));
  return 0;
}

/** `yokoten conflicts`: build the map, keep it for the guard, and say what it holds. */
export async function runConflicts(invocation: Invocation): Promise<number> {
  const options = parse('conflicts', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const json = options.flags.has('--json');
  const root = requireRoot(invocation, invocation.cwd, (missing) => ({ command: 'conflicts', ok: false, error: formatFinding(missing) }));
  if (root === null) return 1;
  const opened = await openChanges(root, invocation.env);
  const built = buildMap(root, invocation.env, { listed: opened.listed });
  if (typeof built === 'string') {
    // With --json the answer is data, and a failure is data too: stdout holds the error alone.
    if (json) printJson(invocation, { command: 'conflicts', ok: false, error: built });
    print(invocation, [`yokoten conflicts: ${built}.`], invocation.stderr);
    return 1;
  }
  const { map, notes } = built;
  const word = options.values['--rebuild'];
  if (word !== undefined) return rebuild(map, word, invocation);
  // The guard reads this file and never runs git (record 0013), so a map kept now is cheap
  // for every tool call that follows. A map that can't be kept is a note: the answer stands.
  const notKept = writeMap(root, invocation.env, map);
  if (json) printJson(invocation, map);
  else print(invocation, summaryLines(map));
  for (const note of [...opened.notes, ...notes, ...(notKept === null ? [] : [notKept])]) say(invocation, `note: ${note}\n`, invocation.stderr);
  return 0;
}
