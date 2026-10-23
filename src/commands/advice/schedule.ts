// Start queued work in dependency order (#709). Open issues name what they wait for on a
// "Depends on issue #N" line. Those lines make a graph: an issue is ready only when every
// issue it names is closed. A cycle is reported, never followed.
//
// The next ready issue comes from a heap: P0 (security and privacy), then P1 (an open
// milestone), then P2, then P3; the smallest issue number next; the oldest issue last.
// A start also needs room on the machine: a cap on agents at once, and a floor on free
// memory, both settings. The longest chain still open is the critical path, which the
// board's timeline puts first.
//
// Everything here is plain data and plain functions: no gh call, no process started, so a
// test can hold the whole schedule still.

import { freemem } from 'node:os';

/** A priority level: P0 security and privacy, P1 an open milestone, P2 the rest, P3 later. */
export type Priority = 0 | 1 | 2 | 3;

/** One open issue as the schedule reads it. */
export interface ScheduleIssue {
  number: number;
  title: string;
  createdAt: string;
  priority: Priority;
  dependsOn: number[];
}

/** What a gh issue row says about its priority: its title, labels and milestone. */
export interface PriorityFields {
  title?: string;
  labels?: readonly string[];
  milestone?: string | null;
}

/** One issue as gh lists it, before the schedule adds its priority. */
export interface IssueFields extends PriorityFields {
  number: number;
  title: string;
  createdAt: string;
  dependsOn?: readonly number[];
}

/** A priority written as a label, P0 through P3. */
const PRIORITY_LABEL = /^p([0-3])$/i;

/** Labels and title areas that put an issue first: a security or privacy fix. */
const FIRST_WORDS = new Set(['security', 'privacy']);

/** Labels that say "not yet": P3. */
const LATER_WORDS = new Set(['later', 'backlog', 'not now']);

/** The words of a label or area, cleaned: lowercase, one space between words. */
function words(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The priority of one issue. A P0-P3 label wins, so a project that keeps its own levels
 * is read as it means them. Else a security or privacy label, or a title area
 * `security:` or `privacy:`, is P0. Else a later label is P3. Else an open milestone is
 * P1. Everything else is P2.
 */
export function priorityOf(fields: PriorityFields): Priority {
  const labels = (fields.labels ?? []).map(words);
  for (const label of labels) {
    const match = PRIORITY_LABEL.exec(label);
    if (match) return Number(match[1]) as Priority;
  }
  if (labels.some((label) => FIRST_WORDS.has(label))) return 0;
  if (labels.some((label) => LATER_WORDS.has(label))) return 3;
  const area = /^([a-z][a-z -]*):/i.exec(fields.title?.trim() ?? '');
  if (area && FIRST_WORDS.has(words(area[1]))) return 0;
  if (fields.milestone) return 1;
  return 2;
}

/** One issue with its priority, ready for the graph. */
export function scheduleIssueOf(issue: IssueFields): ScheduleIssue {
  return {
    number: issue.number,
    title: issue.title,
    createdAt: issue.createdAt,
    priority: priorityOf(issue),
    dependsOn: [...(issue.dependsOn ?? [])],
  };
}

/** A time for ordering, or the end of time when the text is not a time. */
function timeOf(when: string): number {
  const time = Date.parse(when);
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

/** The heap order: priority, then the smallest issue number, then the oldest issue. */
export function compareIssues(left: ScheduleIssue, right: ScheduleIssue): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.number !== right.number) return left.number - right.number;
  return timeOf(left.createdAt) - timeOf(right.createdAt);
}

/** Add `item` to a binary heap, keeping `compare`'s smallest at the top. */
export function heapPush<T>(heap: T[], item: T, compare: (left: T, right: T) => number): void {
  heap.push(item);
  for (let at = heap.length - 1; at > 0; ) {
    const up = (at - 1) >> 1;
    if (compare(heap[at], heap[up]) >= 0) return;
    [heap[at], heap[up]] = [heap[up], heap[at]];
    at = up;
  }
}

/** Take the smallest item from a binary heap, or undefined when it is empty. */
export function heapPop<T>(heap: T[], compare: (left: T, right: T) => number): T | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (!top || heap.length === 0 || last === undefined) return top;
  heap[0] = last;
  for (let at = 0; ; ) {
    const left = at * 2 + 1;
    const right = left + 1;
    let small = at;
    if (left < heap.length && compare(heap[left], heap[small]) < 0) small = left;
    if (right < heap.length && compare(heap[right], heap[small]) < 0) small = right;
    if (small === at) return top;
    [heap[at], heap[small]] = [heap[small], heap[at]];
    at = small;
  }
}

/** A ready issue from the graph: everything it depends on is closed. */
function isReady(issue: ScheduleIssue, open: ReadonlySet<number>): boolean {
  return issue.dependsOn.every((number) => !open.has(number));
}

/** The ready issues in start order: a heap, not a sort, so the next one is O(log n). */
export function readyQueue(issues: readonly ScheduleIssue[], closed: ReadonlySet<number> = new Set()): ScheduleIssue[] {
  const openIssues = issues.filter((issue) => !closed.has(issue.number));
  const open = new Set(openIssues.map((issue) => issue.number));
  const heap: ScheduleIssue[] = [];
  for (const issue of openIssues) if (isReady(issue, open)) heapPush(heap, issue, compareIssues);
  const ready: ScheduleIssue[] = [];
  for (let next = heapPop(heap, compareIssues); next; next = heapPop(heap, compareIssues)) ready.push(next);
  return ready;
}

/** True when two cycles hold the same issue numbers. */
function sameCycle(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((number) => right.includes(number));
}

/** Every cycle left after the graph's acyclic part is taken away, one path per cycle. */
function findCycles(left: ReadonlySet<number>, byNumber: ReadonlyMap<number, ScheduleIssue>): number[][] {
  const state = new Map<number, 1 | 2>();
  const path: number[] = [];
  const cycles: number[][] = [];
  const visit = (number: number) => {
    state.set(number, 1);
    path.push(number);
    for (const dependency of byNumber.get(number)?.dependsOn ?? []) {
      if (!left.has(dependency)) continue;
      const seen = state.get(dependency);
      if (seen === 1) {
        const found = path.slice(path.indexOf(dependency));
        if (!cycles.some((cycle) => sameCycle(cycle, found))) cycles.push(found);
      } else if (!seen) visit(dependency);
    }
    path.pop();
    state.set(number, 2);
  };
  for (const number of left) if (!state.has(number)) visit(number);
  return cycles;
}

/** The longest chain still open, in the order work can start: a dependency before its issue. */
function longestChain(order: readonly number[], byNumber: ReadonlyMap<number, ScheduleIssue>, inOrder: ReadonlySet<number>): number[] {
  const length = new Map<number, number>();
  const next = new Map<number, number>();
  for (let at = 0; at < order.length; at++) {
    const issue = byNumber.get(order[at]) as ScheduleIssue;
    let best = 0;
    let bestDependency = -1;
    for (const dependency of issue.dependsOn) {
      if (!inOrder.has(dependency)) continue;
      const depth = length.get(dependency) ?? 0;
      if (depth > best || (depth === best && dependency < bestDependency)) {
        best = depth;
        bestDependency = dependency;
      }
    }
    length.set(issue.number, best + 1);
    next.set(issue.number, bestDependency);
  }
  let start = -1;
  for (const issue of byNumber.values()) {
    if (!inOrder.has(issue.number)) continue;
    if (start < 0) {
      start = issue.number;
      continue;
    }
    const depth = length.get(issue.number) ?? 0;
    const startDepth = length.get(start) ?? 0;
    if (depth > startDepth || (depth === startDepth && compareIssues(issue, byNumber.get(start) as ScheduleIssue) < 0)) start = issue.number;
  }
  const chain: number[] = [];
  for (let at = start; at > 0; at = next.get(at) ?? -1) chain.push(at);
  return chain.reverse();
}

/** A schedule for the whole open graph. */
export interface SchedulePlan {
  /** The issues ready now, in start order. */
  ready: ScheduleIssue[];
  /** Every issue the graph can place, one dependency before the issue that waits for it. */
  order: number[];
  /** Each cycle found, as its issue numbers. A cycle is reported, never scheduled. */
  cycles: number[][];
  /** Issues left out because they wait for a cycle. */
  blocked: number[];
  /** The longest chain still open, from the first issue to start to the last. */
  criticalPath: number[];
}

/** Build the graph, take its topological order, and find its cycles and critical path. */
export function planSchedule(issues: readonly ScheduleIssue[], closed: ReadonlySet<number> = new Set()): SchedulePlan {
  const openIssues = issues.filter((issue) => !closed.has(issue.number));
  const byNumber = new Map(openIssues.map((issue) => [issue.number, issue]));
  const open = new Set(byNumber.keys());
  const waitsFor = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const issue of byNumber.values()) {
    const waiting = issue.dependsOn.filter((number) => open.has(number));
    waitsFor.set(issue.number, waiting.length);
    for (const dependency of waiting) {
      const list = dependents.get(dependency) ?? [];
      list.push(issue.number);
      dependents.set(dependency, list);
    }
  }
  const heap: ScheduleIssue[] = [];
  for (const issue of byNumber.values()) if (waitsFor.get(issue.number) === 0) heapPush(heap, issue, compareIssues);
  const order: number[] = [];
  for (let next = heapPop(heap, compareIssues); next; next = heapPop(heap, compareIssues)) {
    order.push(next.number);
    for (const dependent of dependents.get(next.number) ?? []) {
      const waiting = (waitsFor.get(dependent) ?? 0) - 1;
      waitsFor.set(dependent, waiting);
      if (waiting === 0) heapPush(heap, byNumber.get(dependent) as ScheduleIssue, compareIssues);
    }
  }
  const inOrder = new Set(order);
  const left = new Set([...byNumber.keys()].filter((number) => !inOrder.has(number)));
  const cycles = findCycles(left, byNumber);
  const inCycle = new Set(cycles.flat());
  return {
    ready: readyQueue(issues, closed),
    order,
    cycles,
    blocked: [...left].filter((number) => !inCycle.has(number)),
    criticalPath: longestChain(order, byNumber, inOrder),
  };
}

/** The schedule as the board serves it: issue numbers, not whole issues. */
export interface ScheduleSummary {
  ready: number[];
  order: number[];
  cycles: number[][];
  blocked: number[];
  criticalPath: number[];
}

/** A plan with the issues named by number, for /data. */
export function summarizeSchedule(plan: SchedulePlan): ScheduleSummary {
  return {
    ready: plan.ready.map((issue) => issue.number),
    order: plan.order,
    cycles: plan.cycles,
    blocked: plan.blocked,
    criticalPath: plan.criticalPath,
  };
}

/** A schedule with nothing in it, for a list that cannot be read. */
export const EMPTY_SCHEDULE: ScheduleSummary = { ready: [], order: [], cycles: [], blocked: [], criticalPath: [] };

/** The two settings a start needs room by. */
export interface ScheduleSettings {
  /** How many agents run at once. */
  maxAgents: number;
  /** Free memory the machine keeps for itself before another agent may start, in MB. */
  memoryFloorMb: number;
}

/** What the machine has now. */
export interface MachineState {
  running: number;
  freeMemoryMb: number;
}

/** The schedule's settings at start: three agents at once, and a 1024 MB floor. */
export const SCHEDULE_DEFAULTS: ScheduleSettings = { maxAgents: 3, memoryFloorMb: 1024 };

/** Why another agent cannot start now, or null when one can. */
export function roomFor(state: MachineState, settings: ScheduleSettings = SCHEDULE_DEFAULTS): 'slots' | 'memory' | null {
  if (state.running >= settings.maxAgents) return 'slots';
  if (state.freeMemoryMb < settings.memoryFloorMb) return 'memory';
  return null;
}

/** What one machine's room allows now. */
export interface Starts {
  /** The ready issues to start, in start order. */
  started: number[];
  /** Why the rest wait, or null when the whole ready list fits. */
  stoppedBy: 'slots' | 'memory' | null;
}

/**
 * Take ready issues in order while the machine has room. A full slot or a low memory
 * floor stops the list: a start never makes either worse, so the rest cannot fit.
 */
export function takeStarts(ready: readonly ScheduleIssue[], state: MachineState, settings: ScheduleSettings = SCHEDULE_DEFAULTS): Starts {
  const started: number[] = [];
  let running = state.running;
  for (const issue of ready) {
    const reason = roomFor({ running, freeMemoryMb: state.freeMemoryMb }, settings);
    if (reason) return { started, stoppedBy: reason };
    started.push(issue.number);
    running++;
  }
  return { started, stoppedBy: null };
}

/** The machine's free memory now, in whole megabytes. */
export function freeMemoryMb(): number {
  return Math.floor(freemem() / (1024 * 1024));
}
