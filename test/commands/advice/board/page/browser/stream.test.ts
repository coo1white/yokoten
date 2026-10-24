// Tests for src/commands/advice/board/page/browser/stream.ts, on a small fake document that keeps every node it is given.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StreamItem } from '../../../../../../src/commands/advice/board/feed/items.ts';
import { makeStreamStore, readStream } from '../../../../../../src/commands/advice/board/feed/tail.ts';
import { boardPage, boardScript } from '../../../../../../src/commands/advice/board/page/page.ts';
import { loadUi, type PageData, type PageState, renderCenter } from '../../../../../../src/commands/advice/board/page/browser/script.ts';
import { addStream, emptyStream, newStreamNode, renderStream } from '../../../../../../src/commands/advice/board/page/browser/stream.ts';
import { makeRedactor } from '../../../../../../src/rules/privacy.ts';
import { SECRET } from '../../../../../../src/rules/privacy/secrets.ts';
import { makeTempDir } from '../../../../../repo/helpers.ts';
import { LANG_NAMES, WORDS } from '../../../../../../src/commands/advice/board/page/words.ts';
import { EMPTY_DESK } from '../../../../../../src/commands/advice/board/feed/read/desk.ts';
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

const agent: AgentView = { key: '~/w', name: 'w', nickname: '', isMain: false, vendor: vendorOf('claude'), model: '', effort: '', role: 'engineer', dot: 'working', task: '', title: 'the task', ref: null, doing: 'reading the issue', checks: '', age: '', updated: 'u1', started: '', branch: '' };
const data: PageData = { repo: '~/repo', repoName: 'repo', repoUrl: '', agents: [agent], needs: [], pulls: [], merged: [], worktrees: [], desk: EMPTY_DESK, updated: '', feeds: { '~/w': [{ kind: 'step', text: 'reading the issue', time: '2026-10-22T10:00:00Z' }] }, waiting: [], issues: [], runs: [], limits: { maxAgents: 3, byModel: {}, memoryFloorMb: 1024 } };

function makeState(): PageState {
  const ui = loadUi(false);
  ui.lang = 'en';
  ui.current = '~/w';
  return { refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

const tool = (text: string, call: string): StreamItem => ({ kind: 'tool', tool: 'Bash', text, call, time: '' });

// #698: the agent's words are the text. Each tool is one line. After three, the rest fold.
test('board stream page: a tool is one line, a long run folds, and a result opens on click', () => {
  const state = makeState();
  const stream = { ...emptyStream('~/w'), source: 'claude' as const };
  stream.node = newStreamNode(state);
  state.stream = stream;
  addStream(state, stream, [{ kind: 'say', text: 'First.\n\nSecond line.', time: '2026-10-22T10:00:00Z' }, tool('Read the issue', 'c1')]);
  const node = () => stream.node as unknown as FakeNode;
  const steps = () => node().find('step');
  assert.match(steps()[0].textContent, /^Bash Read the issue$/, 'one call is a dot, the tool, and the note');
  assert.equal(node().find('tm').length, 1, 'the time shows once, on the message');
  addStream(state, stream, [tool('npm test', 'c2'), { kind: 'result', text: 'one\ntwo\nthree', call: 'c1', time: '' }, tool('git diff', 'c3'), tool('again', 'c4')]);
  assert.equal(node().find('step-more').length, 1, 'the fourth step folds');
  assert.equal(node().find('step-more')[0].children[0].textContent, '+1 more step');
  assert.equal(node().children.filter((child) => child.getAttribute('class') === 'step').length, 3, 'three steps stay in the open');
  const opened = steps()[0].find('step-out')[0];
  assert.equal(opened.tag, 'details', 'a long result opens without a script');
  assert.match(opened.children[0].textContent, /one\ntwo…$/);
  assert.equal(opened.find('full')[0].textContent, 'one\ntwo\nthree');
  addStream(state, stream, [{ kind: 'result', text: 'no', call: 'c2', isFailed: true, time: '' }, { kind: 'stop', text: 'yokoten: blocked', time: '' }, tool('later', 'c5')]);
  assert.ok(steps()[1].getAttribute('class')?.split(' ').includes('bad'), 'a failed step has a red dot');
  assert.equal(node().find('gstop')[0].textContent, 'The guard stopped this call.yokoten: blocked');
  assert.equal(node().find('step-more').length, 1, 'a message ends the run; the next step does not join the fold');
  assert.deepEqual(node().find('msg')[0].children.filter((child) => child.tag === 'p').map((child) => child.textContent), ['First.', 'Second line.']);
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

// #698: masking happens before the stream is drawn. The page shows the masked step and the opened result.
test('board stream page: a home path and a token are masked in the step line and the opened result', () => {
  const home = '/home/someone';
  const token = `${'gh'}p_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  const command = `cat ${home}/notes ${token}`;
  const output = `saw ${token}\nat ${home}/notes\nline three`;
  const dir = makeTempDir('yokoten-stream-');
  const file = join(dir, 'session.jsonl');
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  writeFileSync(file, [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: output }] } }),
  ].join(''));
  const mask = makeRedactor({}, { HOME: home });
  const answer = readStream(makeStreamStore({}, mask, () => ({ source: 'claude', file, mtime: 0 })), '~/w', '/work/repo', 'claude', '');
  const state = makeState();
  const stream = { ...emptyStream('~/w'), source: 'claude' as const };
  stream.node = newStreamNode(state);
  addStream(state, stream, [{ kind: 'say', text: '<img src=x onerror=alert(1)>', time: '' }, ...answer.items]);
  const node = stream.node as unknown as FakeNode;
  assert.equal(node.find('img').length, 0, 'agent text is not HTML');
  assert.ok(node.find('msg')[0].textContent.includes('<img src=x onerror=alert(1)>'), 'agent text shows as text');
  const step = node.find('step')[0];
  const opened = step.find('full')[0].textContent;
  assert.equal(step.textContent.includes(token), false);
  assert.equal(step.textContent.includes(home), false);
  assert.match(step.textContent, /Bash/);
  assert.ok(step.textContent.includes('~/notes'), 'the home path is masked on the step line');
  assert.ok(step.textContent.includes(SECRET), 'the token is masked on the step line');
  assert.equal(opened.includes(token), false);
  assert.equal(opened.includes(home), false);
  assert.ok(opened.includes(SECRET), 'the token is masked in the opened result');
  assert.ok(opened.includes('~/notes'), 'the home path is masked in the opened result');
});

test('board stream page: the script asks /feed with the cursor', () => {
  const script = boardScript();
  assert.ok(script.includes('feed?agent=${encodeURIComponent(stream.agent)}&after=${encodeURIComponent(stream.next)}'));
  for (const name of ['addStream', 'loadStream', 'followStream', 'renderStream']) assert.ok(script.includes(`function ${name}`), `${name} runs in the page`);
  const page = boardPage('bm9uY2U=');
  assert.ok(page.includes('@keyframes breath'), 'a working square breathes');
  assert.ok(page.includes('.vm.live{animation:none}'), 'reduced motion keeps the square still');
});
