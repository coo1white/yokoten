// Tests for src/commands/advice/board/page/browser/desk.ts. Drawing runs on a small fake document.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardIssue } from '../../../../../../src/commands/advice/board/controls.ts';
import { barPlace, renderDesk, renderTimeline } from '../../../../../../src/commands/advice/board/page/browser/desk.ts';
import { loadUi, type PageData, type PageState } from '../../../../../../src/commands/advice/board/page/browser/script.ts';
import { LANG_NAMES, WORDS } from '../../../../../../src/commands/advice/board/page/words.ts';
import { type AgentView, vendorOf } from '../../../../../../src/commands/advice/board/view.ts';
import { EMPTY_DESK } from '../../../../../../src/commands/advice/board/feed/read/desk.ts';

/** One node of the fake document. */
class FakeNode {
  tag: string;
  text = '';
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  style: Record<string, string> = {};
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  get textContent(): string {
    return this.tag === '#text' ? this.text : this.children.map((child) => child.textContent).join('');
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { text }),
  },
  localStorage: { getItem: () => null, setItem: () => undefined },
});

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const toIso = (time: number) => new Date(time).toISOString();

const agent = (fields: Partial<AgentView>): AgentView => ({
  key: '~/w', name: 'w', nickname: '', isMain: false, vendor: vendorOf('grok'), model: '', effort: '', role: 'engineer', dot: 'working',
  task: '', title: '', ref: null, doing: '', checks: '', age: '', updated: toIso(NOW), started: toIso(NOW - 6 * HOUR), branch: '', ...fields,
});

const issue = (fields: Partial<BoardIssue>): BoardIssue => ({
  number: 1, title: '', url: '', createdAt: toIso(NOW - HOUR), updatedAt: toIso(NOW - HOUR), dependsOn: [], ...fields,
});

function makeState(data: PageData): PageState {
  const ui = loadUi(false);
  ui.lang = 'en';
  ui.current = '~/l';
  return { refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

function makeData(fields: Partial<PageData>): PageData {
  return { repo: '~/repo', repoName: 'repo', repoUrl: '', agents: [], needs: [], pulls: [], merged: [], worktrees: [], desk: EMPTY_DESK, updated: '', feeds: {}, waiting: [], issues: [], runs: [], limits: { maxAgents: 3, byModel: {} }, ...fields };
}

const drawn = (node: HTMLElement) => node as unknown as FakeNode;
const withClass = (root: FakeNode, name: string) => root.all().filter((node) => (node.getAttribute('class') ?? '').split(' ').includes(name));

test('board desk: at most three decisions are shown', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const decisions = [1, 2, 3, 4].map((number) => ({ question: number === 1 ? hostile : `Question ${number}`, recommend: 'ship', answers: ['yes', 'no'] }));
  const data = makeData({
    agents: [agent({ key: '~/l', role: 'lead', name: 'Lead' })],
    desk: { now: hostile, decisions, updated: '', reply: 'The bar is in.', rest: 'The rest stays closed until a click.' },
  });
  const state = makeState(data);
  const box = drawn(renderDesk(state, data, data.agents[0]));
  assert.equal(withClass(box, 'decision').length, 3);
  assert.equal(box.textContent.includes('Question 4'), false);
  assert.equal(withClass(box, 'ans').length, 6);
  assert.ok(box.all().every((node) => node.tag !== 'img'), 'the question stays text');
  assert.ok(box.all().some((node) => node.tag === '#text' && node.text === hostile));
  const reply = withClass(box, 'reply')[0];
  assert.equal(reply.getAttribute('data-reply'), 'lead');
  assert.equal(reply.textContent, 'The bar is in.');
  assert.equal(withClass(box, 'rest').length, 0);
  state.ui.open['lead-reply'] = true;
  const open = drawn(renderDesk(state, data, data.agents[0]));
  assert.equal(withClass(open, 'rest')[0].textContent, 'The rest stays closed until a click.');
  const one = makeData({ desk: { ...EMPTY_DESK, reply: 'Only one sentence.' } });
  const shut = drawn(renderDesk(makeState(one), one, undefined));
  assert.equal(withClass(shut, 'reply')[0].getAttribute('data-reply'), null, 'one sentence does not open');
});

test('board desk: timeline bars come from the start and the end', () => {
  assert.deepEqual(barPlace(toIso(NOW - 12 * HOUR), toIso(NOW - 6 * HOUR), NOW), { left: 50, width: 25 });
  assert.deepEqual(barPlace(toIso(NOW - 6 * HOUR), '', NOW), { left: 75, width: 25 });
  assert.deepEqual(barPlace(toIso(NOW - 48 * HOUR), '', NOW), { left: 0, width: 100 });
  assert.equal(barPlace(toIso(NOW - 48 * HOUR), toIso(NOW - 30 * HOUR), NOW), null, 'finished before the window');
  assert.equal(barPlace(toIso(NOW + HOUR), '', NOW), null, 'a start in the future');

  const data = makeData({
    agents: [
      agent({ key: '~/a', title: 'Writing', vendor: vendorOf('grok'), dot: 'working', started: toIso(NOW - 6 * HOUR) }),
      agent({ key: '~/b', title: 'Checks', vendor: vendorOf('claude'), dot: 'done', started: toIso(NOW - 18 * HOUR), updated: toIso(NOW - 6 * HOUR) }),
      agent({ key: '~/c', title: 'Long', vendor: vendorOf('muse'), dot: 'working', started: toIso(NOW - 48 * HOUR) }),
      agent({ key: '~/d', title: 'Gone', dot: 'done', started: toIso(NOW - 48 * HOUR), updated: toIso(NOW - 30 * HOUR) }),
    ],
  });
  const box = drawn(renderTimeline(makeState(data), data, NOW));
  const bars = withClass(box, 'gantt-bar');
  assert.deepEqual(bars.map((bar) => [bar.style.left, bar.style.width, bar.getAttribute('class'), bar.style.background]), [
    ['75%', '25%', 'gantt-bar live', '#9ca3af'],
    ['25%', '50%', 'gantt-bar', '#d97757'],
    ['0%', '100%', 'gantt-bar live', '#0866ff'],
  ]);
  assert.equal(box.textContent.includes('Gone'), false);
  assert.match(box.textContent, /Last 24 hours/);
  assert.match(box.textContent, /24h ago/);
});

test('board desk: the critical path comes first', () => {
  const data = makeData({
    issues: [
      issue({ number: 10, title: 'Later', dependsOn: [11] }),
      issue({ number: 11, title: 'First' }),
    ],
    schedule: { ready: [11], order: [11, 10], cycles: [], blocked: [], criticalPath: [11, 10] },
  });
  const box = drawn(renderTimeline(makeState(data), data, NOW));
  assert.deepEqual(withClass(box, 'gantt-row').map((row) => row.textContent), ['First', 'Laterafter #11']);
  assert.equal(withClass(box, 'critical').length, 2, 'both rows on the chain are marked');
});

test('board desk: a dependency is shown on its row', () => {
  const data = makeData({
    agents: [agent({ key: '~/a', title: 'Timeline', ref: { kind: 'issue', number: 701 }, started: toIso(NOW - 2 * HOUR) })],
    issues: [
      issue({ number: 701, title: 'Timeline', dependsOn: [697] }),
      issue({ number: 698, title: 'Phone', dependsOn: [700], createdAt: toIso(NOW - 2 * HOUR) }),
      issue({ number: 500, title: 'Old issue', createdAt: toIso(NOW - 72 * HOUR), updatedAt: toIso(NOW - 72 * HOUR) }),
    ],
  });
  const box = drawn(renderTimeline(makeState(data), data, NOW));
  const rows = withClass(box, 'gantt-row').map((row) => row.textContent);
  assert.deepEqual(rows, ['Timelineafter #697', 'Phoneafter #700']);
  assert.equal(box.textContent.includes('Old issue'), false, 'an issue from before the window stays off');
  const quiet = makeData({ issues: 'reading GitHub…' });
  assert.match(drawn(renderTimeline(makeState(quiet), quiet, NOW)).textContent, /Nothing in flight/);
});
