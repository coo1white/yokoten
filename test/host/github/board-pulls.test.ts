// Tests for src/host/github/board-pulls.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Gh } from '../../../src/host/github/planning.ts';
import { readBoardPulls, readBoardPullsLater } from '../../../src/host/github/board-pulls.ts';

// #601, #688: the board's pull requests, from two `gh pr list`: the open ones with their
// checks, and the last few merged without. A fake gh stands in for GitHub and answers
// every row to both, so each query keeps only its own stages, and closed rows never show.
test('readBoardPulls: each row as its stages; a row with no number is skipped', () => {
  const calls: string[][] = [];
  const rows = [
    { number: 1, title: 'team page', headRefName: 'board', url: 'https://example.com/pull/1', state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], labels: [{ name: 'tier B' }] },
    { number: 2, title: 'steady tests', headRefName: 'linear', url: '', state: 'MERGED', mergedAt: '2026-10-22T09:00:00Z', reviewDecision: 'APPROVED', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: '', status: 'IN_PROGRESS' }], labels: [{ name: 'tier: a' }] },
    { number: 3, title: 'draft work', headRefName: 'draft', url: '', state: 'OPEN', reviewDecision: null, isDraft: true, statusCheckRollup: [], labels: [] },
    { number: 4, title: 'closed stays', headRefName: 'old', url: '', state: 'CLOSED', reviewDecision: 'CHANGES_REQUESTED', isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }], labels: [{ name: 'bug' }] },
    { title: 'no number', headRefName: 'x' },
  ];
  const gh: Gh = (args) => {
    calls.push(args);
    return JSON.stringify(rows);
  };
  assert.deepEqual(readBoardPulls(gh, 'octo/demo'), [
    { number: 1, title: 'team page', branch: 'board', url: 'https://example.com/pull/1', stage: 'open', checks: 'pass', tier: 'B', review: 'waiting', mergedAt: '' },
    { number: 3, title: 'draft work', branch: 'draft', url: '', stage: 'draft', checks: 'none', tier: '', review: 'none', mergedAt: '' },
    { number: 2, title: 'steady tests', branch: 'linear', url: '', stage: 'merged', checks: 'running', tier: 'A', review: 'approved', mergedAt: '2026-10-22T09:00:00Z' },
  ]);
  assert.deepEqual(calls, [
    ['pr', 'list', '--repo', 'octo/demo', '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,state,reviewDecision,isDraft,statusCheckRollup,labels,url,mergedAt'],
    ['pr', 'list', '--repo', 'octo/demo', '--state', 'merged', '--limit', '10', '--json', 'number,title,headRefName,state,url,mergedAt'],
  ], 'no --state all, and no checks for merged ones');
});

// #688: the same read without blocking. Both queries run at once and get the signal; a
// failed one gives the reason, as the blocking read does.
test('readBoardPullsLater: the same rows, without blocking; a failure is a reason', async () => {
  const row = { number: 5, title: 't', headRefName: 'b', url: '', state: 'OPEN', reviewDecision: '', isDraft: false, statusCheckRollup: [], labels: [] };
  const signals: (AbortSignal | undefined)[] = [];
  const stop = new AbortController();
  const later = (args: string[], signal?: AbortSignal) => {
    signals.push(signal);
    return Promise.resolve(JSON.stringify(args.includes('merged') ? [] : [row]));
  };
  assert.deepEqual((await readBoardPullsLater(later, 'o/r', stop.signal) as { number: number }[]).map((pull) => pull.number), [5]);
  assert.deepEqual(signals, [stop.signal, stop.signal], 'each query can be stopped');
  const refused = () => Promise.reject(Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials' }));
  assert.equal(await readBoardPullsLater(refused, 'o/r'), 'gh can\'t list the pull requests (HTTP 401: Bad credentials): run `gh auth login`, and check the repo');
  const missing: Gh = () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  assert.match(String(await readBoardPullsLater(missing, 'o/r')), /^gh is not installed/, 'a gh that throws at once is a reason too');
});

test('readBoardPulls: a fail wins over running; odd rows are reasons or blanks, never a crash', () => {
  const ghWith = (rows: unknown): Gh => () => JSON.stringify(rows);
  const row = { number: 1, title: 't', headRefName: 'b', url: '', state: 'OPEN', reviewDecision: '', isDraft: false, labels: [] };
  const checksOf = (rollup: unknown) => (readBoardPulls(ghWith([{ ...row, statusCheckRollup: rollup }]), 'o/r') as { checks: string }[])[0].checks;
  assert.equal(checksOf([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: 'FAILURE', status: 'COMPLETED' }]), 'fail');
  assert.equal(checksOf([{ conclusion: 'TIMED_OUT', status: 'COMPLETED' }]), 'fail');
  assert.equal(checksOf([{ conclusion: '', status: 'QUEUED' }]), 'running');
  assert.equal(checksOf([]), 'none');
  assert.equal(checksOf(null), 'none');
  assert.equal(checksOf([null, 'x']), 'none');
  assert.equal(checksOf([{ conclusion: 'CANCELLED', status: 'COMPLETED' }]), 'pass');
  // Fail-closed: a completed run reads pass only on a known-good conclusion.
  assert.equal(checksOf([{ conclusion: 'NEUTRAL', status: 'COMPLETED' }]), 'pass');
  assert.equal(checksOf([{ conclusion: 'SKIPPED', status: 'COMPLETED' }]), 'pass');
  assert.equal(checksOf([{ conclusion: 'STARTUP_FAILURE', status: 'COMPLETED' }]), 'fail');
  assert.equal(checksOf([{ conclusion: 'STALE', status: 'COMPLETED' }]), 'fail');
  assert.equal(checksOf([{ conclusion: 'SOMETHING_NEW', status: 'COMPLETED' }]), 'fail', 'an unknown conclusion');
  assert.equal(checksOf([{ status: 'COMPLETED' }]), 'fail', 'a missing conclusion');
  assert.equal(checksOf([{ conclusion: '', status: 'COMPLETED' }]), 'fail', 'an empty conclusion');
  const tierOf = (labels: unknown) => (readBoardPulls(ghWith([{ ...row, statusCheckRollup: [], labels }]), 'o/r') as { tier: string }[])[0].tier;
  assert.equal(tierOf([{ name: 'Tier C' }]), 'C');
  assert.equal(tierOf([{ name: 'tier' }, { name: 'tier D' }]), '');
  assert.equal(tierOf('tier B'), '');
  // The same shapes CI reads (#601): no separator or colon without a space count, extra spaces do not.
  assert.equal(tierOf([{ name: 'tierB' }]), 'B');
  assert.equal(tierOf([{ name: 'tier:B' }]), 'B');
  assert.equal(tierOf([{ name: '  tier B  ' }]), 'B');
  assert.equal(tierOf([{ name: 'tier  B' }]), '');
  const blank = (readBoardPulls(ghWith([{ ...row, number: 2, title: null, headRefName: 7, url: null, state: null }]), 'o/r') as { title: string; branch: string; url: string; stage: string }[])[0];
  assert.deepEqual([blank.title, blank.branch, blank.url, blank.stage], ['', '', '', 'open']);
  const said = (text: string): Gh => () => text;
  assert.equal(readBoardPulls(said('not json'), 'o/r'), 'gh gave no pull request list: run it again', 'not json');
  assert.equal(readBoardPulls(said('{}'), 'o/r'), 'gh gave no pull request list: run it again', 'not a list');
  assert.deepEqual(readBoardPulls(said('[]'), 'o/r'), [], 'no pull requests');
  const missing: Gh = () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  assert.match(String(readBoardPulls(missing, 'o/r')), /^gh is not installed/);
  const refused: Gh = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials\nmore' });
  };
  assert.equal(readBoardPulls(refused, 'o/r'), 'gh can\'t list the pull requests (HTTP 401: Bad credentials): run `gh auth login`, and check the repo');
});

test('readBoardPulls: each check counts by its latest run, so a green rerun reads pass (#601)', () => {
  const ghWith = (rows: unknown): Gh => () => JSON.stringify(rows);
  const row = { number: 1, title: 't', headRefName: 'b', url: '', state: 'OPEN', reviewDecision: '', isDraft: false, labels: [] };
  const checksOf = (rollup: unknown) => (readBoardPulls(ghWith([{ ...row, statusCheckRollup: rollup }]), 'o/r') as { checks: string }[])[0].checks;
  const oldFail = { name: 'tests', conclusion: 'FAILURE', status: 'COMPLETED', completedAt: '2026-10-20T10:00:00Z' };
  const newPass = { name: 'tests', conclusion: 'SUCCESS', status: 'COMPLETED', completedAt: '2026-10-21T10:00:00Z' };
  assert.equal(checksOf([oldFail, newPass]), 'pass', 'a failure with a green rerun');
  assert.equal(checksOf([newPass, oldFail]), 'pass', 'the dates decide, not the file order');
  const oldPass = { ...oldFail, conclusion: 'SUCCESS' };
  const newFail = { ...newPass, conclusion: 'FAILURE' };
  assert.equal(checksOf([oldPass, newFail]), 'fail', 'a pass with a red rerun');
  assert.equal(checksOf([newFail, oldPass]), 'fail', 'the dates decide, not the file order');
  // startedAt stands in when completedAt is missing, as on a running check.
  assert.equal(checksOf([oldFail, { name: 'tests', conclusion: '', status: 'IN_PROGRESS', startedAt: '2026-10-21T10:00:00Z' }]), 'running', 'a running rerun of a failed check');
  // Missing dates never crash: a dateless run never beats a dated one.
  assert.equal(checksOf([{ name: 'tests', conclusion: 'FAILURE', status: 'COMPLETED' }, newPass]), 'pass');
  assert.equal(checksOf([{ name: 'tests', conclusion: 'FAILURE', status: 'COMPLETED' }, { name: 'tests', conclusion: 'SUCCESS', status: 'COMPLETED' }]), 'fail', 'two dateless runs keep file order');
  assert.equal(checksOf([{ name: 'tests', conclusion: 'SUCCESS', status: 'COMPLETED', completedAt: 'not a date' }]), 'pass', 'an odd date reads as no date');
  // Distinct names still each count.
  assert.equal(checksOf([newPass, { name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED', completedAt: '2026-10-20T10:00:00Z' }]), 'fail');
});
