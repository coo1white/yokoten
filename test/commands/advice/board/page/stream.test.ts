// Tests for src/commands/advice/board/page/stream.ts, on a small fake document that keeps every node it is given.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamItem } from '../../../../../src/commands/advice/board/feed/items.ts';
import { boardScript } from '../../../../../src/commands/advice/board/page/page.ts';
import { loadUi, type PageData, type PageState, renderCenter } from '../../../../../src/commands/advice/board/page/script.ts';
import { addStream, emptyStream, newStreamNode, renderStream, stepsLabel } from '../../../../../src/commands/advice/board/page/stream.ts';
import { LANG_NAMES, WORDS } from '../../../../../src/commands/advice/board/page/words.ts';
import { EMPTY_DESK } from '../../../../../src/commands/advice/board/feed/desk.ts';
import { type AgentView, vendorOf } from '../../../../../src/commands/advice/board/view.ts';

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
  append(...nodes: (FakeNode | string)[]): void {
    this.children.push(...nodes.map((node) => (typeof node === 'string' ? Object.assign(new FakeNode('#text'), { text: node }) : node)));
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    this.children = [];
    this.append(...nodes);
  }
  get textContent(): string {
    return this.tag === '#text' ? this.text : this.children.map((child) => child.textContent).join('');
  }
  /** The nodes under this one with a class, in order. */
  find(name: string): FakeNode[] {
    const here = (this.attrs.get('class') ?? '').split(' ').includes(name) ? [this] : [];
    return [...here, ...this.children.flatMap((child) => child.find(name))];
  }
}

Object.assign(globalThis, {
  document: {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { text }),
  },
});

const agent: AgentView = { key: '~/w', name: 'w', vendor: vendorOf('claude'), model: '', effort: '', role: 'engineer', dot: 'working', task: '', title: 'the task', ref: null, doing: 'reading the issue', checks: '', age: '', updated: 'u1', started: '', branch: '' };
const data: PageData = { repo: '~/repo', repoUrl: '', agents: [agent], needs: [], pulls: [], merged: [], worktrees: [], desk: EMPTY_DESK, updated: '', feeds: { '~/w': [{ kind: 'step', text: 'reading the issue', time: '2026-10-22T10:00:00Z' }] }, waiting: [], issues: [], runs: [], limits: { maxAgents: 3, byModel: {} } };

function makeState(): PageState {
  const ui = loadUi(false);
  ui.lang = 'en';
  ui.current = '~/w';
  return { token: '', refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

const tool = (text: string, call: string): StreamItem => ({ kind: 'tool', text, full: `full ${text}`, call, time: '' });

// #694: tool calls in a row fold into "Ran N steps · last"; each opens to the whole call.
test('board stream page: calls fold into one run, outputs go under their call, messages break the run', () => {
  const state = makeState();
  const stream = { ...emptyStream('~/w'), source: 'claude' as const };
  stream.node = newStreamNode(state);
  state.stream = stream;
  addStream(state, stream, [{ kind: 'say', text: 'First.\n\nSecond line.', time: '2026-10-22T10:00:00Z' }, tool('Read the issue', 'c1')]);
  const run = () => (stream.node as unknown as FakeNode).find('steps').at(-1);
  assert.equal(run()?.children[0].textContent, 'Read the issue', 'one call shows as itself');
  addStream(state, stream, [tool('npm test', 'c2'), { kind: 'result', text: 'all green', call: 'c1', time: '' }, tool('git diff', 'c3')]);
  assert.equal(run()?.children[0].textContent, 'Ran 3 steps · git diff', 'new calls join the run at the bottom');
  const calls = run()?.find('call') ?? [];
  assert.deepEqual(calls.map((call) => call.children[0].textContent), ['Read the issue', 'npm test', 'git diff']);
  assert.match(calls[0].textContent, /full Read the issueOutputall green$/, 'the output goes under its own call');
  addStream(state, stream, [{ kind: 'stop', text: 'yokoten: blocked', time: '' }, tool('again', 'c4')]);
  const node = stream.node as unknown as FakeNode;
  assert.equal(node.find('steps').length, 2, 'a message ends the run; the next call starts a new one');
  assert.equal(node.find('gstop')[0].textContent, 'The guard stopped this call.yokoten: blocked');
  assert.deepEqual(node.find('msg')[0].children.filter((child) => child.tag === 'p').map((child) => child.textContent), ['First.', 'Second line.']);
  assert.equal(stepsLabel(state, 1, 'x'), 'x');
});

test('board stream page: the middle shows the stream when a log is found, else the doing steps', () => {
  const state = makeState();
  assert.ok(renderCenter(state, data).textContent.includes('reading the issue'), 'no stream yet: the doing steps');
  state.stream = { ...emptyStream('~/w'), source: 'doing' };
  assert.equal(renderStream(state, agent), null);
  assert.ok(renderCenter(state, data).textContent.includes('Since the board started'), 'no log: the doing steps, as before');
  const stream = { ...emptyStream('~/w'), source: 'muse' as const };
  stream.node = newStreamNode(state);
  state.stream = stream;
  addStream(state, stream, [{ kind: 'say', text: 'Working on it.', time: '' }]);
  const center = renderCenter(state, data) as unknown as FakeNode;
  assert.ok(center.children.includes(stream.node as unknown as FakeNode), 'the kept list, not a new one');
  assert.ok(center.textContent.includes('From the agent’s own session') && center.textContent.includes('Working on it.'));
  assert.ok(!center.textContent.includes('Since the board started'));
  state.stream = { ...stream, agent: '~/other' };
  assert.equal(renderStream(state, agent), null, 'another agent’s stream is not shown');
});

test('board stream page: the script asks /feed with the token and the cursor', () => {
  const script = boardScript();
  assert.ok(script.includes('feed?t=${encodeURIComponent(state.token)}&agent=${encodeURIComponent(stream.agent)}&after=${encodeURIComponent(stream.next)}'));
  for (const name of ['addStream', 'loadStream', 'followStream', 'renderStream']) assert.ok(script.includes(`function ${name}`), `${name} runs in the page`);
});
