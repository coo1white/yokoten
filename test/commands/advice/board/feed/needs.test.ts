// Tests for src/commands/advice/board/feed/needs.ts. A known-bad review still in
// progress must not become an approval, and a finished pull request must leave.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNeeds, isOlderThanDay, type NeedAgent } from '../../../../../src/commands/advice/board/feed/needs.ts';
import { readBoardPulls } from '../../../../../src/host/github/board-pulls.ts';
import type { BoardPull } from '../../../../../src/host/github/index.ts';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const PULL: BoardPull = { number: 1, title: 't', branch: 'b', url: '', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', isApprovedOnHead: false, mergedAt: '' };

const agent = (fields: Partial<NeedAgent>): NeedAgent => ({ key: '~/w', name: 'Ada', nickname: '', role: 'engineer', dot: 'waiting', doing: 'Asks a question', task: '', updated: '2026-10-23T11:00:00Z', ref: null, ...fields });

test('board needs: a reviewer still on a pull request keeps the approval off the list', () => {
  const pulls = [PULL];
  const open = buildNeeds([agent({ key: '~/r', name: 'Rev', role: 'reviewer', dot: 'working', ref: { kind: 'pr', number: 1 }, updated: '2026-10-23T04:00:00Z' })], pulls);
  assert.deepEqual(open.map((need) => need.pull), [], 'the review has not finished, so it is not the owner\'s turn');
  assert.equal(open.some((need) => need.why.includes('All checks pass')), false);
  const waiting = buildNeeds([agent({ key: '~/r', name: 'Rev', role: 'reviewer', dot: 'waiting', doing: 'Which name?', ref: { kind: 'pr', number: 1 } })], pulls);
  assert.deepEqual(waiting.map((need) => [need.kind, need.why]), [['answer', 'Which name?']]);
  const done = buildNeeds([agent({ key: '~/r', name: 'Rev', role: 'reviewer', dot: 'done', ref: { kind: 'pr', number: 1 }, updated: '2026-10-23T04:00:00Z' })], pulls);
  assert.deepEqual(done.map((need) => [need.kind, need.pull, need.at]), [['approve', 1, '2026-10-23T04:00:00.000Z']]);
});

// A cross-vendor review is a comment. GitHub may still say the review is waiting.
test('board needs: a latest review comment that says request changes is not an approval', () => {
  const row = {
    number: 7,
    title: 'board',
    headRefName: 'b',
    url: '',
    state: 'OPEN',
    reviewDecision: 'REVIEW_REQUIRED',
    isDraft: false,
    statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
    labels: [{ name: 'tier A' }],
  };
  const listed = (comments: { body: string; createdAt: string }[], reviews: { body: string; submittedAt: string; state: string }[] = []) =>
    readBoardPulls(() => JSON.stringify([{ ...row, comments, reviews }]), 'o/r') as BoardPull[];
  const asksApproval = (pulls: BoardPull[]) => buildNeeds([], pulls).some((need) => need.why.includes('needs your approval') || need.why.includes('All checks pass'));
  const blocked = listed([
    { body: 'thanks for the look', createdAt: '2026-10-23T01:00:00Z' },
    { body: 'PR #7: request changes\n\nScope. The diff stays with the board.', createdAt: '2026-10-23T02:00:00Z' },
  ]);
  assert.equal(blocked[0]?.review, 'changes');
  assert.equal(asksApproval(blocked), false, 'request changes is not checks pass, needs your approval');
  const fromReview = listed([], [{ body: 'PR #7: request changes', submittedAt: '2026-10-23T04:00:00Z', state: 'COMMENTED' }]);
  assert.equal(fromReview[0]?.review, 'changes');
  assert.equal(asksApproval(fromReview), false);
  const cleared = listed([
    { body: 'PR #7: request changes', createdAt: '2026-10-23T01:00:00Z' },
    { body: 'PR #7: approve', createdAt: '2026-10-23T03:00:00Z' },
  ]);
  assert.equal(cleared[0]?.review, 'waiting');
  assert.equal(asksApproval(cleared), true, 'a later approve comment lets the owner decide');
  const buried = listed([{ body: 'The note says request changes in the middle of a long paragraph about the old bug.', createdAt: '2026-10-23T02:00:00Z' }]);
  assert.equal(buried[0]?.review, 'waiting', 'a mention inside a paragraph is not the verdict');
});

test('board needs: a row leaves when the pull request is approved, merged or closed', () => {
  const agents = [
    agent({ key: '~/a', name: 'Ada', ref: { kind: 'pr', number: 2 } }),
    agent({ key: '~/b', name: 'Bea', ref: { kind: 'issue', number: 8 }, updated: '2026-10-22T08:00:00Z' }),
  ];
  const open = buildNeeds(agents, [{ ...PULL, number: 2 }], [8]);
  assert.deepEqual(open.map((need) => need.title), ['Approve PR #2', 'Bea is waiting for you']);
  const settled = buildNeeds(agents, [{ ...PULL, number: 2, isApprovedOnHead: true }, { ...PULL, number: 3, stage: 'merged' }, { ...PULL, number: 4, stage: 'closed' }], []);
  assert.deepEqual(settled, [], 'the same read, after the work is done, has no row');
  assert.equal(isOlderThanDay('2026-10-22T08:00:00Z', NOW), true, 'a day old says so');
  assert.equal(isOlderThanDay('2026-10-23T04:00:00Z', NOW), false, 'eight hours stays, and says how old on the page');
  assert.equal(isOlderThanDay('', NOW), false);
  assert.equal(isOlderThanDay('soon', NOW), false);
});
