// Tests for src/commands/advice/board/page/script.ts. The pure functions run as they are; the
// drawing ones run on a small fake document that keeps every node it is given.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeedEvent } from '../../../../../src/commands/advice/board/feed.ts';
import { ageOf, clearedId, githubNote, groupFeed, loadUi, localDay, type PageData, type PageState, pickLang, renderCenter, renderLimits, renderOutput, renderRight, renderRuns, renderSide, renderStart, renderWaiting, roleGroup, saveUi, say, summaryOf } from '../../../../../src/commands/advice/board/page/script.ts';
import type { BoardWaiting } from '../../../../../src/commands/advice/board/controls.ts';
import { LANG_NAMES, WORDS } from '../../../../../src/commands/advice/board/page/words.ts';
import { type AgentView, pullView, vendorOf } from '../../../../../src/commands/advice/board/view.ts';

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
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  get textContent(): string {
    return this.tag === '#text' ? this.text : this.children.map((child) => child.textContent).join('');
  }
  /** Every node under this one, this one first. */
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_: string, tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { text }),
};
Object.assign(globalThis, { document: fakeDocument });

const agent = (fields: Partial<AgentView>): AgentView => ({ key: '~/w', name: 'w', vendor: vendorOf('muse'), model: '', effort: '', role: 'engineer', dot: 'working', task: '', title: '', ref: null, doing: '', checks: '', age: '', updated: 'u1', branch: '', ...fields });
const event = (kind: FeedEvent['kind'], text: string): FeedEvent => ({ kind, text, time: '2026-10-22T10:00:00Z' });

function makeState(data: PageData, lang = 'en'): PageState {
  const ui = loadUi(false);
  ui.lang = lang;
  return { token: '', refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

function makeData(fields: Partial<PageData>): PageData {
  return { repo: '~/repo', repoUrl: '', agents: [], needs: [], pulls: [], merged: [], worktrees: [], updated: '', feeds: {}, waiting: [], issues: [], runs: [], limits: { maxAgents: 3, byModel: {} }, ...fields };
}

test('board script: three or more routine steps fold; waits, failures and the latest step never do', () => {
  const kinds = (items: ReturnType<typeof groupFeed>) => items.map((item) => (item.kind === 'group' ? `group(${item.items.length})` : item.kind));
  assert.deepEqual(kinds(groupFeed([event('step', 'a'), event('step', 'b'), event('pass', 'c'), event('step', 'd')])), ['group(3)', 'step'], 'the latest stays open');
  assert.deepEqual(kinds(groupFeed([event('step', 'a'), event('step', 'b'), event('fail', 'c'), event('step', 'd'), event('step', 'e'), event('step', 'f'), event('wait', 'g')])), ['step', 'step', 'fail', 'group(3)', 'wait']);
  assert.deepEqual(kinds(groupFeed([event('step', 'a'), event('step', 'b'), event('step', 'c')])), ['step', 'step', 'step'], 'two left after the latest: not enough to fold');
  assert.deepEqual(groupFeed([]), []);
});

test('board script: words in the page language, with values put in and the English singular', () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
  const english = makeState(makeData({}));
  assert.equal(say(english, 'oneRuleSet', { n: 1 }), 'One rule set · 1 vendor');
  assert.equal(say(english, 'oneRuleSet', { n: 2 }), 'One rule set · 2 vendors');
  assert.equal(say(english, 'waitingFor', { name: '{n} $& <b>' }), '{n} $& <b> is waiting for you', 'a value goes in as it is');
  assert.equal(summaryOf(english, ['working', 'waiting', 'working']), '2 working · 1 waiting');
  assert.equal(say(english, roleGroup('verifier')), 'Verifiers');
  assert.equal(roleGroup('lead'), 'group.other');
  const chinese = makeState(makeData({}), 'zh-CN');
  assert.equal(say(chinese, 'oneRuleSet', { n: 1 }), '一套规则 · 1 家厂商', 'no English singular in Chinese');
  assert.equal(say(makeState(makeData({}), 'zh-TW'), 'pull.approve'), '等你核准');
  assert.equal(say(makeState(makeData({}), 'fr'), 'undo'), 'Undo', 'an unknown language falls back to English');
  assert.equal(say(english, 'no.such.key'), 'no.such.key');
  assert.equal(pickLang(['zh-HK', 'en']), 'zh-TW');
  assert.equal(pickLang(['zh-Hant-TW']), 'zh-TW');
  assert.equal(pickLang(['zh']), 'zh-CN');
  assert.equal(pickLang(['de-DE', 'ja-JP']), 'ja');
  assert.equal(pickLang(['de-DE']), 'en');
  assert.equal(pickLang([]), 'en');
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(ageOf(english, agent({ updated: '2026-10-22T11:59:40Z' }), now), 'just now');
  assert.equal(ageOf(english, agent({ updated: '2026-10-22T11:55:00Z', age: '5 min ago' }), now), '5 min ago');
  assert.match(ageOf(makeState(makeData({}), 'zh-CN'), agent({ updated: '2026-10-22T11:55:00Z', age: '5 min ago' }), now), /5.*分钟前/);
  assert.match(ageOf(makeState(makeData({}), 'ja'), agent({ updated: '2026-10-22T09:00:00Z' }), now), /3/);
  assert.equal(ageOf(english, agent({ updated: 'soon', age: 'kept' }), now), 'kept', 'an odd time keeps the server words');
  assert.equal(clearedId(agent({ key: '~/a', updated: 't' })), '~/a@t', 'an agent that writes again comes back');
  assert.match(localDay(Date.parse('2026-10-22T12:00:00Z')), /^2026-10-2[123]$/);
});

test('board script: the saved UI comes back; blocked storage keeps the defaults', () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
  const ui = loadUi(false, ['ja']);
  assert.deepEqual({ ...ui.fold }, { 'group.finished': true }, 'finished agents start folded');
  assert.equal(ui.lang, 'ja', 'the browser language');
  ui.fold['group.engineer'] = true;
  ui.cleared.push('~/a@t');
  ui.theme = 'dark';
  ui.lang = 'zh-TW';
  saveUi(ui);
  const back = loadUi(false, ['ja']);
  assert.deepEqual([back.fold['group.engineer'], back.cleared, back.theme, back.lang], [true, ['~/a@t'], 'dark', 'zh-TW'], 'the picked language wins');
  assert.equal(loadUi(true).fold['group.reviewer'], true, 'a phone starts with the groups folded');
  store.set('yokoten-board', JSON.stringify({ lang: '<x>' }));
  assert.equal(loadUi(false).lang, 'en', 'a saved language the board does not speak is dropped');
  Object.assign(globalThis, { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
  assert.deepEqual(loadUi(false).cleared, []);
  assert.doesNotThrow(() => saveUi(back));
});

// Agents write the status files: their words must reach the page as text, never as markup.
test('board script: an agent\'s words stay text, and a link goes only to an http(s) address', () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
  const hostile = '<img src=x onerror=alert(1)>';
  const data = makeData({
    agents: [agent({ name: hostile, title: hostile, doing: hostile, dot: 'waiting' }), agent({ key: '~/d', name: 'Done one', dot: 'done' })],
    needs: [
      { kind: 'answer', title: `${hostile} is waiting for you`, why: hostile, agentKey: '~/w', pull: 0 },
      { kind: 'approve', title: 'Approve PR #3', why: 'ok', agentKey: '', pull: 3 },
      { kind: 'approve', title: 'Approve PR #4', why: 'ok', agentKey: '', pull: 4 },
    ],
    pulls: [
      pullView({ number: 3, title: 'good', branch: 'b', url: 'https://example.com/pull/3', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', mergedAt: '' }),
      { ...pullView({ number: 4, title: 'odd', branch: 'b', url: '', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', mergedAt: '' }), url: 'javascript:alert(1)' },
    ],
    feeds: { '~/w': [event('step', hostile)] },
  });
  const state = makeState(data);
  state.ui.current = '~/w';
  const nodes = [...renderSide(state, data), renderCenter(state, data), renderRight(state, data, Date.now())].flatMap((node) => (node as unknown as FakeNode).all());
  assert.ok(!nodes.some((node) => node.tag === 'img'), 'no element comes from the text');
  assert.ok(nodes.some((node) => node.tag === '#text' && node.text === hostile), 'the words show as they are');
  const links = nodes.filter((node) => node.tag === 'a').map((node) => node.getAttribute('href'));
  assert.ok(links.every((href) => href === 'https://example.com/pull/3'), `only the http(s) address is a link: ${links.join(' ')}`);
  assert.ok(links.length >= 1);
  const pinned = (renderSide(state, data)[0] as unknown as FakeNode).textContent;
  assert.match(pinned, /No lead on the board yet/, 'with no lead, the pinned row says how one joins');
  assert.match(pinned, /Needs you3/);
  assert.match(pinned, /Approve PR #3/);
  const japanese = makeState(data, 'ja');
  assert.match((renderRight(japanese, data, Date.now()) as unknown as FakeNode).textContent, /あなたの承認待ち/, 'the pull request status in the page language');
});

// #603: the right column starts with the waiting list: who waits, their role, how
// long, why, and where to act. An odd link stays plain text.
test('board script: the waiting list shows what waits for you', () => {
  const data = makeData({
    waiting: [
      { kind: 'approve', agent: 'w', role: 'engineer', wait: '5 min ago', why: 'tier A, checks pass, needs the owner go-ahead: #7 work', link: 'https://example.com/pull/7' },
      { kind: 'guard', agent: 'g', role: '', wait: 'just now', why: 'the guard stopped a push', link: 'javascript:alert(1)' },
      { kind: 'question', agent: 'q', role: 'helper', wait: '2 min ago', why: 'which one?', link: '' },
    ],
  });
  const state = makeState(data);
  const right = renderWaiting(state, data.waiting) as unknown as FakeNode;
  const text = right.textContent;
  assert.match(text, /Needs you3/);
  assert.match(text, /Needs the owner go-ahead · w · \[engineer\] · 5 min ago/);
  assert.match(text, /tier A, checks pass, needs the owner go-ahead: #7 work/);
  assert.match(text, /Guard stop · g · just now/);
  assert.match(text, /Question · q · \[helper\] · 2 min ago/);
  const links = right.all().filter((node) => node.tag === 'a').map((node) => node.getAttribute('href'));
  assert.deepEqual(links, ['https://example.com/pull/7'], 'only the http(s) address is a link');
  const empty = renderWaiting(state, []) as unknown as FakeNode;
  assert.match(empty.textContent, /Nothing needs you right now\./);
});

// #603: the right column holds the board's controls: the start form, the limits
// form, the runs the board started with their stop buttons, and the live output.
test('board script: the controls start and stop agents from the page', () => {
  const data = makeData({
    issues: [{ number: 603, title: 'board agents', url: '' }],
    runs: [
      { name: 'issue-603-codex', issue: '603', vendor: 'codex', model: 'model-a', worktree: '~/repo/.worktrees/603', pid: 1000, status: 'running', startedAt: '', stoppedAt: '', exitCode: null, output: ['hello', 'world'] },
      { name: 'issue-604-codex', issue: '604', vendor: 'codex', model: 'model-a', worktree: '', pid: null, status: 'stopped', startedAt: '', stoppedAt: '', exitCode: 1, output: [] },
    ],
    limits: { maxAgents: 2, byModel: { 'model-a': 1 } },
  });
  const state = makeState(data);
  const byId = (root: FakeNode, id: string) => root.all().find((node) => node.getAttribute('id') === id);
  const start = renderStart(state, data.issues) as unknown as FakeNode;
  assert.ok(byId(start, 'start-issue'), 'the issue field');
  assert.ok(byId(start, 'start-vendor'), 'the vendor field');
  assert.ok(byId(start, 'start-model'), 'the model field');
  assert.equal(start.all().filter((node) => node.tag === 'option' && node.getAttribute('value') === 'codex').length, 1, 'every vendor is one option');
  assert.ok(start.all().some((node) => node.tag === 'option' && node.textContent === '#603 board agents'), 'the open issues feed the issue list');
  assert.ok(start.all().some((node) => node.tag === 'button' && node.getAttribute('data-start') === '1' && node.textContent === 'Start'), 'the start button');
  const limits = renderLimits(state, data.limits) as unknown as FakeNode;
  assert.ok(byId(limits, 'limits-max'), 'the cap field');
  assert.ok(byId(limits, 'limits-models'), 'the per-model field');
  assert.match(limits.textContent, /Now: 2 at once · model-a: 1/);
  assert.ok(limits.all().some((node) => node.tag === 'button' && node.getAttribute('data-limits') === '1' && node.textContent === 'Save'), 'the save button');
  const runs = renderRuns(state, data.runs) as unknown as FakeNode;
  assert.match(runs.textContent, /Started here2/);
  assert.match(runs.textContent, /issue-603-codex · codex · model-a · issue 603 · running/);
  assert.match(runs.textContent, /~\/repo\/.worktrees\/603/);
  const stops = runs.all().filter((node) => node.tag === 'button' && node.getAttribute('data-stop') !== null);
  assert.deepEqual(stops.map((node) => node.getAttribute('data-stop')), ['issue-603-codex'], 'only the running run stops');
  const output = renderOutput(state, data.runs) as unknown as FakeNode;
  assert.match(output.textContent, /Latest output/);
  const shown = output.all().filter((node) => node.tag === 'pre');
  assert.equal(shown.length, 2, 'one block per run');
  assert.equal(shown[0].textContent, 'hello\nworld', 'the live output');
  assert.equal(shown[1].textContent, 'No output yet.');
  const right = renderRight(state, data, Date.now()) as unknown as FakeNode;
  assert.match(right.textContent, /Needs you/);
  assert.match(right.textContent, /Start an agent/);
  assert.match(right.textContent, /Limits/);
  assert.match(right.textContent, /Started here/);
  assert.match(right.textContent, /Latest output/);
});

// #603: there are no Approve or Merge buttons anywhere; those stay on the host, with
// the owner. A row that names an approval only picks an agent or opens the host.
test('board script: no control approves or merges', () => {
  const waiting: BoardWaiting[] = [{ kind: 'approve', agent: 'w', role: 'engineer', wait: '5 min ago', why: 'tier A: #7 work', link: '' }];
  const data = makeData({
    waiting,
    agents: [agent({ key: '~/w', name: 'w', role: 'engineer', dot: 'waiting' })],
    needs: [{ kind: 'approve', title: 'Approve PR #7', why: 'ok', agentKey: '~/w', pull: 7 }],
    runs: [{ name: 'issue-7-codex', issue: '7', vendor: 'codex', model: 'model-a', worktree: '', pid: 1, status: 'running', startedAt: '', stoppedAt: '', exitCode: null, output: [] }],
  });
  const state = makeState(data);
  const nodes = [renderSide(state, data)[0], renderSide(state, data)[1], renderCenter(state, data), renderRight(state, data, Date.now())].flatMap((node) => (node as unknown as FakeNode).all());
  const kinds = nodes.filter((node) => node.tag === 'button').flatMap((node) => [...node.attrs.keys()]);
  assert.ok(!kinds.some((kind) => /approve|merge/i.test(kind)), 'no control claims to approve or merge');
  assert.ok(nodes.some((node) => node.tag === 'button' && node.getAttribute('data-start') === '1'), 'the page starts');
  assert.ok(nodes.some((node) => node.tag === 'button' && node.getAttribute('data-stop') === 'issue-7-codex'), 'the page stops');
});

// Agents write the status files, the issues, and the run output: every word reaches
// the controls as text, never as markup.
test('board script: issue titles and run output stay text', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const data = makeData({
    issues: [{ number: 603, title: hostile, url: '' }],
    runs: [{ name: hostile, issue: '603', vendor: hostile, model: hostile, worktree: hostile, pid: null, status: 'running', startedAt: '', stoppedAt: '', exitCode: null, output: [hostile] }],
    waiting: [{ kind: 'question', agent: hostile, role: '', wait: hostile, why: hostile, link: '' }],
  });
  const state = makeState(data);
  const nodes = [renderStart(state, data.issues), renderRuns(state, data.runs), renderOutput(state, data.runs), renderWaiting(state, data.waiting)].flatMap((node) => (node as unknown as FakeNode).all());
  assert.ok(!nodes.some((node) => node.tag === 'img'), 'no element comes from the text');
  assert.ok(nodes.filter((node) => node.tag === '#text' && node.text === hostile).length >= 4, 'the words show as they are');
  assert.ok(!nodes.some((node) => node.tag === 'a'), 'no link without an http(s) address');
});

test('board script: a finished agent can be cleared, and comes back when it writes again', () => {
  const done = agent({ key: '~/d', name: 'Done one', dot: 'done', updated: 'u1' });
  const data = makeData({ agents: [agent({ key: '~/l', role: 'lead', name: 'Lead' }), done] });
  const state = makeState(data);
  const text = () => (renderSide(state, data)[1] as unknown as FakeNode).textContent;
  state.ui.fold['group.finished'] = false;
  assert.match(text(), /Finished1/);
  assert.match(text(), /Clear all/);
  state.ui.cleared.push(clearedId(done));
  assert.doesNotMatch(text(), /Finished/);
  assert.match(text(), /1 cleared agent · logs kept/);
  done.updated = 'u2';
  assert.match(text(), /Finished1/, 'it wrote again, so it is back');
});

// #688: before the first GitHub read, the lists say "reading GitHub" in the page's
// language. After a failed read, the old lists stay with when they were read.
test('board script: the GitHub lists say when they are being read, and when they are old', () => {
  const now = Date.parse('2026-10-23T10:00:00Z');
  const reading = makeData({ repoUrl: 'https://github.com/octo/demo', pulls: 'reading GitHub…', issues: 'reading GitHub…', github: { isReading: true, readAt: '', failed: '' } });
  assert.equal(githubNote(makeState(reading), reading, now), 'Reading GitHub…');
  const chinese = (renderRight(makeState(reading, 'zh-CN'), reading, now) as unknown as FakeNode).textContent;
  assert.match(chinese, /正在读取 GitHub…/, 'the pull requests say it in the page language');
  assert.ok(!chinese.includes('reading GitHub…'), 'not the server\'s English words');
  const old = makeData({ repoUrl: 'https://github.com/octo/demo', github: { isReading: false, readAt: '2026-10-23T09:55:00Z', failed: 'gh could not list the open issues: run it again' } });
  assert.equal(githubNote(makeState(old), old, now), 'GitHub could not be read. These lists were read 5 min ago.');
  const fresh = makeData({ repoUrl: 'https://github.com/octo/demo', github: { isReading: false, readAt: '2026-10-23T09:59:00Z', failed: '' } });
  assert.equal(githubNote(makeState(fresh), fresh, now), '', 'a good read needs no note');
  assert.equal(githubNote(makeState(makeData({})), makeData({}), now), '', 'no remote, no note');
});
