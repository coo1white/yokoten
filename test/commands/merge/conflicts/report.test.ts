// Tests for src/commands/merge/conflicts/report.ts (#909): the summary a beginner reads,
// in the words the issue asks for.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstOf, movers, pathsText, summaryLines } from '../../../../src/commands/merge/conflicts/report.ts';
import type { Change, Collision, ConflictMap } from '../../../../src/commands/merge/conflicts/types.ts';

/** One change, by hand: the summary is words, so it needs no repo. */
function change(id: string, label: string, files: string[], moves: string[] = [], options: { draft?: boolean; main?: string[] } = {}): Change {
  return {
    id,
    label,
    branch: id,
    head: '0'.repeat(8),
    draft: options.draft ?? false,
    files,
    moves,
    mainConflicts: options.main ?? [],
  };
}

/** A map of the changes given, in the order given. */
function mapOf(changes: Change[], collisions: Collision[] = [], hot: string[] = []): ConflictMap {
  return { version: 1, builtAt: new Date(0).toISOString(), main: '0'.repeat(8), changes, collisions, leased: {}, hot };
}

/** The example the issue gives: two pull requests on one file, and one that moves a file three touch. */
function issueExample(): ConflictMap {
  return mapOf(
    [
      change('pr:12', 'PR #12', ['src/app.ts', 'src/old.ts'], [], { main: ['src/app.ts'] }),
      change('pr:15', 'PR #15', ['src/app.ts', 'src/old.ts'], [], { main: ['src/app.ts'] }),
      change('pr:20', 'PR #20', ['src/new.ts'], ['src/old.ts']),
      change('pr:25', 'PR #25', ['src/old.ts']),
    ],
    [{ a: 'pr:12', b: 'pr:15', files: ['src/app.ts'] }],
  );
}

test('the summary says what collides and what to merge first, in the issue\'s words', () => {
  assert.deepEqual(summaryLines(issueExample()), [
    '2 changes collide with main: PR #12, PR #15.',
    'PR #12 and PR #15 both change src/app.ts. Merge PR #12 first, then PR #15.',
    'PR #20 moves 1 file that 3 other changes touch. It goes in alone, first.',
  ]);
});

test('a map with nothing to say is one short line', () => {
  const quiet = mapOf([change('pr:12', 'PR #12', ['src/app.ts']), change('pr:15', 'PR #15', ['src/b.ts'])]);
  assert.deepEqual(summaryLines(quiet), ['No open change collides with main, or with another open change.']);
  assert.deepEqual(summaryLines(mapOf([])), ['No open change is here to compare with main.', 'Push a branch or open a pull request, then run `yokoten conflicts` again.']);
});

test('the pair order is the smaller change first, then the smaller number', () => {
  const small = change('pr:15', 'PR #15', ['src/app.ts']);
  const big = change('pr:12', 'PR #12', ['src/app.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(firstOf(small, big), small);
  assert.equal(firstOf(big, small), small);
  const same = change('pr:9', 'PR #9', ['src/app.ts']);
  assert.equal(firstOf(same, small), same);
});

test('a draft is listed but not ordered, and a hot path is named', () => {
  const draft = change('pr:18', 'PR #18', ['src/app.ts'], [], { draft: true, main: ['src/app.ts'] });
  const one = change('pr:12', 'PR #12', ['src/app.ts', 'src/b.ts']);
  const lines = summaryLines(mapOf([draft, one], [], ['src/app.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']));
  assert.deepEqual(lines, [
    '1 change collides with main: PR #18.',
    'PR #18 is a draft, so it is listed here, but not ordered.',
    '4 files are hot: src/app.ts, src/b.ts, src/c.ts, and 1 more. Three or more open changes touch them, or an open change moves them.',
  ]);
});

test('a long map stays short on a line', () => {
  assert.equal(pathsText(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']), 'a.ts, b.ts, c.ts, and 2 more');
  assert.equal(pathsText(['a.ts']), 'a.ts');
  const changes = Array.from({ length: 9 }, (_, index) => change(`pr:${index + 1}`, `PR #${index + 1}`, [`src/${index}.ts`]));
  const collisions: Collision[] = changes.slice(1).map((held) => ({ a: 'pr:1', b: held.id, files: ['src/app.ts'] }));
  const lines = summaryLines(mapOf(changes, collisions));
  assert.equal(lines.filter((line) => line.includes('both change')).length, 5);
  assert.ok(lines.some((line) => line === '3 more pairs collide: `yokoten conflicts --json` names every one.'), lines.join('\n'));
});

test('a change that moves a shared file is named once, with how many others touch it', () => {
  const rows = movers(issueExample());
  assert.deepEqual(rows.map((row) => [row.change.label, row.others.length]), [['PR #20', 3]]);
  assert.deepEqual(movers(mapOf([change('pr:20', 'PR #20', ['src/new.ts'], ['src/old.ts'])])), []);
});
