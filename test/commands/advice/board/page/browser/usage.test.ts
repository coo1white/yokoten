// Tests for src/commands/advice/board/page/browser/usage.ts (#611): the usage view on
// the page shows tokens and a price, keeps a filter, and says partial when it must.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderUsage } from '../../../../../../src/commands/advice/board/page/browser/usage.ts';
import { loadUi, type PageData, type PageState } from '../../../../../../src/commands/advice/board/page/browser/script.ts';
import { LANG_NAMES, WORDS } from '../../../../../../src/commands/advice/board/page/words.ts';
import { EMPTY_DESK } from '../../../../../../src/commands/advice/board/feed/read/desk.ts';

/** One node of the fake document. */
class FakeNode {
  tag: string;
  text = '';
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
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
  replaceChildren(...nodes: Array<FakeNode | null | undefined>): void {
    this.children = nodes.filter((node): node is FakeNode => node != null);
  }
  get textContent(): string {
    return this.tag === '#text' ? this.text : this.children.map((child) => child.textContent).join('');
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

const cell = (fields: Record<string, unknown>) => ({
  agent: 'Ada', vendor: 'Claude', model: 'claude-opus-5-5', role: 'engineer', day: '2026-10-22',
  input: 2_000_000, cached: 1_000_000, output: 100_000, usd: 39, isPartial: false, isLocal: false, ...fields,
});

function makeData(cells: ReturnType<typeof cell>[], partial: string[] = []): PageData {
  return {
    repo: '~/repo', repoName: 'repo', repoUrl: '', agents: [], needs: [], pulls: [], merged: [], worktrees: [],
    desk: EMPTY_DESK, updated: '', feeds: {}, waiting: [], issues: [], runs: [], limits: { maxAgents: 3, byModel: {}, memoryFloorMb: 2048 },
    usage: { cells, days: ['2026-10-22'], partial, checked: '2026-10-23', sources: [] },
  };
}

function makeState(data: PageData): PageState {
  const ui = loadUi(false);
  ui.lang = 'en';
  return { refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

test('board usage view: a row shows its tokens and an API estimate in plain words', () => {
  const data = makeData([cell({})]);
  const box = renderUsage(makeState(data), data) as unknown as FakeNode;
  assert.match(box.textContent, /Use and cost/);
  assert.match(box.textContent, /2,000,000 in · 1,000,000 cached · 100,000 out/);
  assert.match(box.textContent, /about \$39\.00 if paid by API/);
  assert.match(box.textContent, /Prices checked 2026-10-23/);
  assert.match(box.textContent, /claude-opus-5-5 · 2026-10-22/, 'the row names the model and the day');
  assert.match(box.textContent, /Ada \[engineer\]/, 'the row names the role');
});

test('board usage view: an unknown price is partial, and says why', () => {
  const data = makeData([cell({ model: 'mystery-9', usd: null, isPartial: true, agent: 'Bea' })], ['Bea: its log has no token counts']);
  const box = renderUsage(makeState(data), data) as unknown as FakeNode;
  assert.match(box.textContent, /partial/);
  assert.match(box.textContent, /Bea: its log has no token counts/);
  assert.doesNotMatch(box.textContent, /\$\d/);
});

test('board usage view: a role filter keeps its rows, and the fold remembers being shut', () => {
  const data = makeData([cell({}), cell({ agent: 'Bea', role: 'reviewer', vendor: 'Muse', model: 'muse-spark' })]);
  const state = makeState(data);
  state.ui.usageRole = 'reviewer';
  const box = renderUsage(state, data) as unknown as FakeNode;
  assert.match(box.textContent, /Bea/);
  assert.doesNotMatch(box.textContent, /Ada/);
  state.ui.fold.usage = true;
  const shut = renderUsage(state, data) as unknown as FakeNode;
  assert.doesNotMatch(shut.textContent, /Bea/);
  assert.equal(shut.children.length, 1, 'a shut fold shows its head only');
});

test('board usage view: no cells says so rather than showing zero', () => {
  const data = makeData([]);
  const box = renderUsage(makeState(data), data) as unknown as FakeNode;
  assert.match(box.textContent, /No token counts in a local log yet/);
});
