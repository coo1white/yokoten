// Tests for src/commands/advice/board/page/browser/column.ts. The lead desk and the bell
// do not draw the same list (#701, #737).

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_DESK } from '../../../../../../src/commands/advice/board/feed/read/desk.ts';
import { renderSide } from '../../../../../../src/commands/advice/board/page/browser/column.ts';
import { loadUi, type PageData, type PageState } from '../../../../../../src/commands/advice/board/page/browser/script.ts';
import { boardScript } from '../../../../../../src/commands/advice/board/page/page.ts';
import { LANG_NAMES, WORDS } from '../../../../../../src/commands/advice/board/page/words.ts';
import { type AgentView, vendorOf } from '../../../../../../src/commands/advice/board/view.ts';

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
}

Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { text }),
  },
  localStorage: { getItem: () => null, setItem: () => undefined },
});

const agent = (fields: Partial<AgentView>): AgentView => ({
  key: '~/main', name: 'Ada', nickname: 'Calm Hopper', isMain: true, vendor: vendorOf('claude'), model: '', effort: '',
  role: 'lead', dot: 'working', task: '', title: 'The board', ref: null, doing: 'reading', checks: '', age: '',
  updated: '2026-10-22T11:00:00Z', started: '2026-10-22T10:00:00Z', branch: '', ...fields,
});

function makeState(data: PageData): PageState {
  const ui = loadUi(false);
  ui.lang = 'en';
  return { refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

test('board column: the desk shows the lead decision, and Needs you stays out of it', () => {
  const data: PageData = {
    repo: '~/repo', repoName: 'repo', repoUrl: '',
    agents: [agent({}), agent({ key: '~/desk', name: 'Bea', nickname: 'Bold Ada', isMain: false, role: 'lead' })],
    needs: [{ kind: 'approve', title: 'Approve PR #7', why: 'secret approval row', agentKey: '', pull: 7 }],
    pulls: [], merged: [], worktrees: [],
    desk: { ...EMPTY_DESK, now: 'Writing the timeline', decisions: [{ question: 'Ship the board?', recommend: 'yes', answers: ['yes', 'no'] }] },
    updated: '', feeds: {}, waiting: [], issues: [], runs: [], limits: { maxAgents: 3, byModel: {} },
  };
  const pinned = renderSide(makeState(data), data)[0] as unknown as FakeNode;
  assert.match(pinned.textContent, /Calm Hopper/);
  assert.match(pinned.textContent, /Writing the timeline/);
  assert.match(pinned.textContent, /Waiting on you/);
  assert.match(pinned.textContent, /Ship the board\?/);
  assert.equal(pinned.textContent.includes('Bea'), false, 'a desk lead stays out of the lead box');
  assert.equal(pinned.textContent.includes('secret approval row'), false, 'the bell row is not drawn again');
  assert.doesNotMatch(pinned.textContent, /Needs you/);
});

test('board column: each drawing function is in the page script once', () => {
  const script = boardScript();
  for (const name of ['renderSide', 'fillNeeds', 'renderDesk', 'renderTimeline', 'renderStream']) {
    const found = script.match(new RegExp(`function ${name}\\b`, 'g')) ?? [];
    assert.equal(found.length, 1, name);
  }
});
