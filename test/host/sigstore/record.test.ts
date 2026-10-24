// Tests for src/host/sigstore/record.ts: the event log's chain and its daily hashes (#768).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyHashes, dayOf, findLine, readEventLog, ZERO_HASH } from '../../../src/host/sigstore/record.ts';
import { makeEventLog } from '../../repo/helpers.ts';

const TIMES = ['2026-10-20T10:00:00Z', '2026-10-20T23:59:00Z', '2026-10-21T00:01:00Z', '2026-10-21T12:00:00Z'];

test('record: a log read back names every line, and the chain holds', () => {
  const made = makeEventLog(TIMES);
  const log = readEventLog(made.text);
  assert.deepEqual(log.problems, []);
  assert.equal(log.lines.length, 4);
  assert.deepEqual(log.lines.map((line) => line.hash), made.hashes);
  assert.deepEqual(log.lines.map((line) => line.day), ['2026-10-20', '2026-10-20', '2026-10-21', '2026-10-21']);
  assert.equal(findLine(log, made.hashes[2]), 2);
  assert.equal(findLine(log, 'f'.repeat(64)), -1);
});

test('record: the daily hash is the last line of the day, and nothing else', () => {
  const made = makeEventLog(TIMES);
  assert.deepEqual(dailyHashes(readEventLog(made.text)), [
    { day: '2026-10-20', hash: made.hashes[1], index: 1 },
    { day: '2026-10-21', hash: made.hashes[3], index: 3 },
  ]);
});

test('record: one changed line breaks the chain there, and the day hash is not the old one', () => {
  const made = makeEventLog(TIMES);
  const changed = made.lines[2].replace('"stringValue":"3"', '"stringValue":"three"');
  assert.notEqual(changed, made.lines[2], 'the sample line changed');
  const log = readEventLog(made.text.replace(made.lines[2], changed));
  assert.equal(log.problems[0]?.index, 3);
  assert.match(log.problems[0]?.what ?? '', /line 4 names a previous hash that is not the hash of line 3/);
  const daily = dailyHashes(log);
  assert.equal(daily[0].hash, made.hashes[1], 'the day before the change still hashes as it did');
  assert.equal(daily[1].hash, made.hashes[3], 'a change in the middle leaves the last line alone, so only the chain shows it');
});

test('record: a writer that rebuilds every later line leaves a chain that holds, with a different last hash', () => {
  // Only the day's anchored hash can show this rewrite; the chain alone cannot (#768).
  const made = makeEventLog(TIMES);
  const rewired = makeEventLog(TIMES.map((time, index) => (index === 2 ? '2026-10-21T00:02:00Z' : time)));
  assert.deepEqual(readEventLog(rewired.text).problems, []);
  assert.notEqual(rewired.hashes[3], made.hashes[3]);
});

test('record: the first line names 64 zeros; a missing or odd hash is a problem', () => {
  const made = makeEventLog(TIMES);
  const zeros = readEventLog(made.text);
  assert.equal(zeros.lines[0].text.includes(ZERO_HASH), true);
  const first = JSON.parse(made.lines[0]);
  first.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.pop();
  const noHash = readEventLog([JSON.stringify(first), ...made.lines.slice(1)].join('\n'));
  assert.match(noHash.problems[0]?.what ?? '', /no yokoten\.event\.previous_hash/);
  const wrong = readEventLog(made.text.replace(ZERO_HASH, '1'.repeat(64)));
  assert.match(wrong.problems[0]?.what ?? '', /names 11111111…, not 64 zeros/);
});

test('record: a line that is not one JSON object, a \\r, and an empty log', () => {
  assert.deepEqual(readEventLog(''), { lines: [], problems: [] });
  assert.match(readEventLog('not json\n').problems[0]?.what ?? '', /not one OTLP\/JSON log record/);
  const made = makeEventLog(TIMES);
  const cr = readEventLog(made.text.replaceAll('\n', '\r\n'));
  assert.match(cr.problems[0]?.what ?? '', /carriage return/);
});

test('record: the day comes from the nanoseconds, and a value that is not digits gives none', () => {
  assert.equal(dayOf('1792713600000000000'), new Date(1792713600000).toISOString().slice(0, 10));
  assert.equal(dayOf('2026-10-22'), null);
  assert.equal(dayOf(undefined), null);
  assert.equal(dayOf('99999999999999999999999999'), null);
});
