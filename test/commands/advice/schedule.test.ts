// Tests for src/commands/advice/schedule.ts (#709): the dependency graph, the heap, the
// room a start needs, and the critical path the board's timeline shows first.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareIssues, heapPop, heapPush, planSchedule, priorityOf, readyQueue, roomFor, scheduleIssueOf, SCHEDULE_DEFAULTS, summarizeSchedule, takeStarts } from '../../../src/commands/advice/schedule.ts';

/** One open issue with the priority the tests name, not a label. */
function issue(number: number, priority: 0 | 1 | 2 | 3 = 2, dependsOn: number[] = [], createdAt = '2026-10-01T00:00:00Z') {
  return { number, title: `issue ${number}`, createdAt, priority, dependsOn };
}

test('schedule: a topological order puts a dependency before its issue', () => {
  const plan = planSchedule([
    issue(3, 2, [1]),
    issue(1),
    issue(2, 2, [1]),
    issue(4, 2, [2, 3]),
  ]);
  assert.deepEqual(plan.order, [1, 2, 3, 4]);
  assert.deepEqual(plan.cycles, []);
  assert.equal(plan.order.indexOf(1) < plan.order.indexOf(3), true, '1 comes before 3');
  assert.equal(plan.order.indexOf(3) < plan.order.indexOf(4), true, '3 comes before 4');
});

test('schedule: a cycle is reported, never followed', () => {
  const plan = planSchedule([
    issue(1, 2, [2]),
    issue(2, 2, [1]),
    issue(3, 2, [1]),
    issue(4),
  ]);
  assert.deepEqual(plan.cycles.map((cycle) => [...cycle].sort((left, right) => left - right)), [[1, 2]]);
  assert.deepEqual(plan.order, [4], 'only the issue outside the cycle is placed');
  assert.deepEqual(plan.blocked, [3], 'an issue behind the cycle waits, and is named');
  assert.deepEqual(plan.ready.map((item) => item.number), [4], 'no issue in a cycle is ready');
});

test('schedule: the heap picks priority, then the smallest issue, then the oldest', () => {
  const rows = [
    issue(5, 2, [], '2026-09-01T00:00:00Z'),
    issue(2, 2, [], '2026-10-01T00:00:00Z'),
    issue(20, 0, [], '2026-10-02T00:00:00Z'),
    issue(9, 1, [], '2026-10-03T00:00:00Z'),
    issue(7, 2, [], '2026-08-01T00:00:00Z'),
  ];
  assert.deepEqual(readyQueue(rows).map((item) => item.number), [20, 9, 2, 5, 7]);
  // The same order comes out of the heap itself, one pop at a time.
  const heap: ReturnType<typeof issue>[] = [];
  for (const row of rows) heapPush(heap, row, compareIssues);
  const popped: number[] = [];
  for (let next = heapPop(heap, compareIssues); next; next = heapPop(heap, compareIssues)) popped.push(next.number);
  assert.deepEqual(popped, [20, 9, 2, 5, 7]);
});

test('schedule: an issue waits until its dependency closes', () => {
  const rows = [issue(9), issue(10, 2, [9])];
  assert.deepEqual(readyQueue(rows).map((item) => item.number), [9], '10 waits while 9 is open');
  assert.deepEqual(readyQueue(rows, new Set([9])).map((item) => item.number), [10], '9 closed frees 10');
  const plan = planSchedule(rows, new Set([9]));
  assert.deepEqual(plan.ready.map((item) => item.number), [10]);
  assert.deepEqual(plan.order, [10], 'a closed issue is not scheduled again');
});

test('schedule: the memory floor stops a start; the slot cap stops the rest', () => {
  const ready = [issue(1, 0), issue(2, 0), issue(3, 0)];
  assert.deepEqual(takeStarts(ready, { running: 0, freeMemoryMb: 100 }, { maxAgents: 3, memoryFloorMb: 1024 }), { started: [], stoppedBy: 'memory' });
  assert.equal(roomFor({ running: 0, freeMemoryMb: 1023 }, SCHEDULE_DEFAULTS), 'memory');
  assert.equal(roomFor({ running: 3, freeMemoryMb: 8000 }, SCHEDULE_DEFAULTS), 'slots');
  assert.equal(roomFor({ running: 2, freeMemoryMb: 8000 }, SCHEDULE_DEFAULTS), null);
  assert.deepEqual(takeStarts(ready, { running: 1, freeMemoryMb: 4096 }, { maxAgents: 3, memoryFloorMb: 1024 }), { started: [1, 2], stoppedBy: 'slots' });
  assert.deepEqual(takeStarts(ready, { running: 0, freeMemoryMb: 4096 }, { maxAgents: 3, memoryFloorMb: 1024 }), { started: [1, 2, 3], stoppedBy: null });
});

test('schedule: the critical path is the longest chain still open, from the first start', () => {
  const plan = planSchedule([
    issue(1),
    issue(2, 2, [1]),
    issue(3, 2, [2]),
    issue(4, 2, [1]),
    issue(5),
  ]);
  assert.deepEqual(plan.criticalPath, [1, 2, 3]);
  const alone = planSchedule([issue(8)]);
  assert.deepEqual(alone.criticalPath, [8]);
  const loop = planSchedule([issue(1, 2, [2]), issue(2, 2, [1])]);
  assert.deepEqual(loop.criticalPath, [], 'a cycle has no critical path');
});

test('schedule: the priority comes from labels, a milestone or the title area', () => {
  assert.equal(priorityOf({ labels: ['p1'] }), 1);
  assert.equal(priorityOf({ labels: ['P0'] }), 0);
  assert.equal(priorityOf({ labels: ['privacy'] }), 0);
  assert.equal(priorityOf({ title: 'security: a guard hole' }), 0);
  assert.equal(priorityOf({ labels: ['later'] }), 3);
  assert.equal(priorityOf({ milestone: 'First release' }), 1);
  assert.equal(priorityOf({}), 2);
  assert.equal(scheduleIssueOf({ number: 7, title: 'fix: one thing', createdAt: '', labels: ['security'], dependsOn: [6] }).priority, 0);
  assert.deepEqual(scheduleIssueOf({ number: 7, title: 'fix: one thing', createdAt: '', dependsOn: [6] }).dependsOn, [6]);
});

test('schedule: the summary names issues by number for /data', () => {
  const summary = summarizeSchedule(planSchedule([issue(2), issue(3, 2, [2])]));
  assert.deepEqual(summary, { ready: [2], order: [2, 3], cycles: [], blocked: [], criticalPath: [2, 3] });
});
