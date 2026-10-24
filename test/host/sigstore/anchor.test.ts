// Tests for src/host/sigstore/anchor.ts: the log checked against its daily anchors (#768).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAnchors } from '../../../src/host/sigstore/anchor.ts';
import { readEventLog, lineHash } from '../../../src/host/sigstore/record.ts';
import { makeEventLog } from '../../repo/helpers.ts';

const TIMES = ['2026-10-20T10:00:00Z', '2026-10-20T23:59:00Z', '2026-10-21T00:01:00Z', '2026-10-21T12:00:00Z', '2026-10-22T08:00:00Z'];
const TODAY = '2026-10-22';

/** Rekor holds the anchors this map names, and nothing else. */
function fakeRekor(anchors: Set<string>) {
  const asked: string[] = [];
  return {
    asked,
    lookup: async (hash: string) => {
      asked.push(hash);
      return anchors.has(hash)
        ? { found: { uuid: 'u', logIndex: 1, integratedTime: 1 } }
        : { problem: 'Rekor holds no entry for this hash' };
    },
  };
}

test('anchor: every past day is found in Rekor, and today is left out', async () => {
  const made = makeEventLog(TIMES);
  const rekor = fakeRekor(new Set([made.hashes[1], made.hashes[3]]));
  const report = await checkAnchors(readEventLog(made.text), { today: TODAY, lookup: rekor.lookup });
  assert.deepEqual(report.problems, []);
  assert.equal(report.anchored, 2);
  assert.deepEqual(rekor.asked, [made.hashes[1], made.hashes[3]], 'today (2026-10-22) is not asked for');
  assert.deepEqual(report.notes.map((note) => note.what), [
    "2026-10-20: the day's last line is anchored at Rekor log index 1",
    "2026-10-21: the day's last line is anchored at Rekor log index 1",
  ]);
});

test('anchor: a changed last line makes that day miss, and names only that day', async () => {
  const made = makeEventLog(TIMES);
  const rekor = fakeRekor(new Set([made.hashes[1], made.hashes[3]]));
  const changed = made.lines[3].replace('"stringValue":"4"', '"stringValue":"four"');
  const report = await checkAnchors(readEventLog(made.text.replace(made.lines[3], changed)), { today: TODAY, lookup: rekor.lookup });
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].what, /^2026-10-21 no longer matches its anchor/);
  assert.equal(report.anchored, 1);
});

test('anchor: a chain rebuilt after the change still misses the anchored hash', async () => {
  const made = makeEventLog(TIMES);
  const rekor = fakeRekor(new Set([made.hashes[1], made.hashes[3]]));
  const changed = made.lines[3].replace('"stringValue":"4"', '"stringValue":"four"');
  const rebuilt = made.lines[4].replace(made.hashes[3], lineHash(changed));
  const text = made.text.replace(made.lines[3], changed).replace(made.lines[4], rebuilt);
  const log = readEventLog(text);
  assert.deepEqual(log.problems, [], 'the writer rebuilt every later hash');
  const report = await checkAnchors(log, { today: TODAY, lookup: rekor.lookup });
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].what, /^2026-10-21 no longer matches its anchor: Rekor holds no entry for this hash/);
  assert.match(report.problems[0].what, /last line 4, hash [0-9a-f]{12}…/);
});

test('anchor: a changed middle line names the day where the chain breaks', async () => {
  const made = makeEventLog(TIMES);
  const rekor = fakeRekor(new Set([made.hashes[1], made.hashes[3]]));
  const changed = made.lines[2].replace('"stringValue":"3"', '"stringValue":"three"');
  const report = await checkAnchors(readEventLog(made.text.replace(made.lines[2], changed)), { today: TODAY, lookup: rekor.lookup });
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0].what, /^2026-10-21 no longer matches its anchor: the chain breaks at line 4/);
  assert.equal(report.anchored, 1, 'the day before the change still verifies');
});

test('anchor: a day Rekor does not hold is a problem, and one it holds is a note', async () => {
  const made = makeEventLog(TIMES);
  const rekor = fakeRekor(new Set([made.hashes[1]]));
  const report = await checkAnchors(readEventLog(made.text), { today: TODAY, lookup: rekor.lookup });
  assert.equal(report.anchored, 1);
  assert.deepEqual(report.problems.map((problem) => problem.id), ['anchor']);
  assert.match(report.problems[0].what, /^2026-10-21 no longer matches its anchor/);
});

test('anchor: a chain problem on a line with no day is one plain finding', async () => {
  const made = makeEventLog(TIMES);
  const rekor = fakeRekor(new Set([made.hashes[1], made.hashes[3]]));
  const log = readEventLog(`not json\n${made.text}`);
  const report = await checkAnchors(log, { today: TODAY, lookup: rekor.lookup });
  assert.match(report.problems[0].what, /the event log's chain does not hold/);
});
