// Tests for src/commands/advice/board/page/right.ts. Needs you is the header bell (#737).

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadUi, type PageData, type PageState } from '../../../../../src/commands/advice/board/page/script.ts';
import { renderRight, RIGHT_FUNCTIONS } from '../../../../../src/commands/advice/board/page/right.ts';
import { LANG_NAMES, WORDS } from '../../../../../src/commands/advice/board/page/words.ts';
import { pullView } from '../../../../../src/commands/advice/board/view.ts';

/** One node of the fake document: a tag, its attributes, its children, or its text. */
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
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  get textContent(): string {
    return this.tag === '#text' ? this.text : this.children.map((child) => child.textContent).join('');
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_: string, tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { text }),
};
Object.assign(globalThis, { document: fakeDocument });

function makeState(data: PageData): PageState {
  const ui = loadUi(false);
  ui.lang = 'en';
  return { refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

test('board right: Needs you is not listed here, and a pull request still shows', () => {
  const data: PageData = {
    repo: '~/repo',
    repoName: 'repo',
    repoUrl: 'https://example.com/octo/demo',
    agents: [],
    needs: [{ kind: 'approve', title: 'Approve PR #7', why: 'work', agentKey: '', pull: 7 }],
    pulls: [pullView({ number: 7, title: 'work', branch: 'board-fast', url: 'https://example.com/pull/7', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', isApprovedOnHead: false, mergedAt: '' })],
    merged: [],
    worktrees: [],
    updated: '',
    feeds: {},
    waiting: [
      { kind: 'approve', agent: 'w', role: 'engineer', wait: '5 min ago', why: 'tier A: #7 work', link: 'https://example.com/pull/7' },
      { kind: 'guard', agent: 'g', role: '', wait: 'just now', why: 'the guard stopped a push', link: '' },
      { kind: 'question', agent: 'q', role: 'helper', wait: '2 min ago', why: 'which one?', link: '' },
    ],
    issues: [],
    runs: [],
    limits: { maxAgents: 3, byModel: {} },
  };
  const right = renderRight(makeState(data), data, Date.now()) as unknown as FakeNode;
  assert.equal(/Needs you\d/.test(right.textContent), false, 'the right column does not list Needs you');
  assert.equal(right.textContent.includes('Guard stop'), false, 'a guard stop is not a second list');
  assert.equal(right.textContent.includes('which one?'), false, 'a question is not a second list');
  assert.match(right.textContent, /Pull requests/);
  assert.match(right.textContent, /#7/);
  assert.match(right.textContent, /Needs your approval/);
  assert.match(right.textContent, /board-fast/);
});

test('board right: the page can run these functions as one script', () => {
  const source = RIGHT_FUNCTIONS.map(String).join('\n');
  assert.equal(source.includes('export '), false, 'a classic script has no export');
  assert.ok(source.includes('function renderRight'), 'the right column is in the page');
  assert.ok(source.includes('function renderBar'), 'the bottom bar is in the page');
  assert.doesNotThrow(() => new Function(`${source}\nrenderRight;`));
});
