// Tests for src/commands/advice/board/page/browser/script.ts. The pure functions run as they are; the
// drawing ones run on a small fake document that keeps every node it is given.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeedEvent } from '../../../../../../src/commands/advice/board/feed/steps.ts';
import { ageOf, clearedId, githubNote, groupFeed, loadUi, localDay, onClick, onMenuKey, type PageData, type PageState, pickLang, render, renderBar, renderCenter, renderLimits, renderNeedItem, renderOutput, renderRight, renderRuns, renderSide, renderStart, roleGroup, saveUi, say, summaryOf } from '../../../../../../src/commands/advice/board/page/browser/script.ts';
import type { BoardWaiting } from '../../../../../../src/commands/advice/board/controls.ts';
import { LANG_NAMES, WORDS } from '../../../../../../src/commands/advice/board/page/words.ts';
import { EMPTY_DESK } from '../../../../../../src/commands/advice/board/feed/read/desk.ts';
import { type AgentView, pullView, vendorOf } from '../../../../../../src/commands/advice/board/view.ts';

/** One node of the fake document: a tag, its attributes, its children, or its text. */
class FakeNode {
  tag: string;
  text = '';
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
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
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  /** The id attribute, as an element exposes it. */
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) node.parent = this;
    this.children.push(...nodes);
  }
  className = '';
  hidden = false;
  /** Set when a draw writes `textContent`. Null means the children hold the text. */
  ownText: string | null = null;
  get textContent(): string {
    if (this.ownText !== null) return this.ownText;
    return this.tag === '#text' ? this.text : this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.ownText = String(value);
    this.children = [];
  }
  replaceChildren(...nodes: Array<FakeNode | null | undefined>): void {
    this.ownText = null;
    this.children = nodes.filter((node): node is FakeNode => node != null);
    for (const node of this.children) node.parent = this;
  }
  /** True when this node matches one simple selector: a tag, #id, .class or [attr]. */
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const one = part.trim();
      if (one.startsWith('#')) return this.getAttribute('id') === one.slice(1);
      if (one.startsWith('.')) return (this.getAttribute('class') ?? '').split(' ').includes(one.slice(1));
      if (one.startsWith('[')) {
        const body = one.slice(1, -1);
        const eq = body.indexOf('=');
        if (eq < 0) return this.attrs.has(body);
        const value = body.slice(eq + 1).replace(/^['"]|['"]$/g, '');
        return this.getAttribute(body.slice(0, eq)) === value;
      }
      return this.tag === one;
    });
  }
  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  focus(): void {
    fakeDocument.activeElement = this;
  }
  /** Every node under this one, this one first. */
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const fakeDocument: {
  createElement: (tag: string) => FakeNode;
  createElementNS: (_: string, tag: string) => FakeNode;
  createTextNode: (text: string) => FakeNode;
  activeElement: FakeNode | null;
  getElementById?: (id: string) => FakeNode | null;
  querySelector?: (selector: string) => FakeNode | null;
  documentElement?: FakeNode;
} = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_: string, tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { text }),
  activeElement: null,
};
Object.assign(globalThis, { document: fakeDocument });

const agent = (fields: Partial<AgentView>): AgentView => ({ key: '~/w', name: 'w', nickname: '', isMain: false, vendor: vendorOf('muse'), model: '', effort: '', role: 'engineer', dot: 'working', task: '', title: '', ref: null, doing: '', checks: '', age: '', updated: 'u1', started: '', branch: '', isLive: true, ...fields });
const event = (kind: FeedEvent['kind'], text: string): FeedEvent => ({ kind, text, time: '2026-10-22T10:00:00Z' });

function makeState(data: PageData, lang = 'en'): PageState {
  const ui = loadUi(false);
  ui.lang = lang;
  return { refreshMs: 15000, agentFile: '.yokoten-agent.json', words: WORDS, langNames: LANG_NAMES, data, ui, live: 'live', isMenuOpen: false, toast: null, toastTimer: 0, readAt: 0 };
}

function makeData(fields: Partial<PageData>): PageData {
  return { repo: '~/repo', repoName: 'repo', repoUrl: '', agents: [], needs: [], pulls: [], merged: [], worktrees: [], desk: EMPTY_DESK, updated: '', feeds: {}, waiting: [], issues: [], runs: [], limits: { maxAgents: 3, byModel: {} }, ...fields };
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
  assert.equal(roleGroup('worker'), 'group.engineer');
  assert.equal(roleGroup('lead'), 'group.manager');
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
  assert.deepEqual({ ...ui.fold }, {}, 'no group starts folded on a desktop');
  assert.equal(ui.lang, 'ja', 'the browser language');
  ui.fold['group.engineer'] = true;
  ui.cleared.push('~/a@t');
  ui.theme = 'dark';
  ui.lang = 'zh-TW';
  saveUi(ui);
  const back = loadUi(false, ['ja']);
  assert.deepEqual([back.fold['group.engineer'], back.cleared, back.theme, back.lang], [true, ['~/a@t'], 'dark', 'zh-TW'], 'the picked language wins');
  assert.equal(loadUi(true).fold['group.reviewer'], true, 'a phone starts with the groups folded');
  assert.equal(loadUi(true).fold['group.manager'], true, 'a phone folds the project managers too');
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
      pullView({ number: 3, title: 'good', branch: 'b', url: 'https://example.com/pull/3', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', isApprovedOnHead: false, mergedAt: '' }),
      { ...pullView({ number: 4, title: 'odd', branch: 'b', url: '', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', isApprovedOnHead: false, mergedAt: '' }), url: 'javascript:alert(1)' },
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
  assert.doesNotMatch(pinned, /Needs you/, 'Needs you left the left column');
  const rows = data.needs.map((need) => renderNeedItem(state, need, Date.now()) as unknown as FakeNode);
  const rowNodes = rows.flatMap((node) => node.all());
  assert.ok(!rowNodes.some((node) => node.tag === 'img'), 'a row builds no element from the text');
  assert.ok(rowNodes.some((node) => node.tag === '#text' && node.text === hostile), 'the row shows the words as they are');
  assert.match(rows[1].textContent, /Needs your approval/);
  assert.doesNotMatch(rows[1].textContent, /All checks pass/, 'the row does not say the checks passed');
  const rowLinks = rowNodes.filter((node) => node.tag === 'a').map((node) => node.getAttribute('href'));
  assert.deepEqual(rowLinks, ['https://example.com/pull/3'], 'a script address is not a link');
  const japanese = makeState(data, 'ja');
  assert.match((renderRight(japanese, data, Date.now()) as unknown as FakeNode).textContent, /あなたの承認待ち/, 'the pull request status in the page language');
});

// #737: Needs you is the header bell. The columns do not list it, even when /data
// still sends waiting rows.
test('board script: Needs you is the header list, not a column', () => {
  const data = makeData({
    waiting: [
      { kind: 'approve', agent: 'w', role: 'engineer', wait: '5 min ago', why: 'tier A, checks pass, needs the owner go-ahead: #7 work', link: 'https://example.com/pull/7' },
      { kind: 'guard', agent: 'g', role: '', wait: 'just now', why: 'the guard stopped a push', link: 'javascript:alert(1)' },
      { kind: 'question', agent: 'q', role: 'helper', wait: '2 min ago', why: 'which one?', link: '' },
    ],
    needs: [{ kind: 'approve', title: 'Approve PR #7', why: 'work. All checks pass. Tier A needs your approval.', agentKey: '', pull: 7 }],
    pulls: [pullView({ number: 7, title: 'work', branch: 'b', url: 'https://example.com/pull/7', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', isApprovedOnHead: false, mergedAt: '' })],
  });
  const state = makeState(data);
  const pinned = renderSide(state, data)[0] as unknown as FakeNode;
  assert.doesNotMatch(pinned.textContent, /Needs you/);
  assert.equal(pinned.textContent.includes('Approve PR #7'), false);
  const right = renderRight(state, data, Date.now()) as unknown as FakeNode;
  assert.equal(/Needs you\d/.test(right.textContent), false, 'the right column does not list Needs you');
  assert.equal(right.textContent.includes('Guard stop'), false, 'a guard stop is not a second Needs you list');
  assert.match(right.textContent, /Pull requests/);
  const row = renderNeedItem(state, data.needs[0], Date.now()) as unknown as FakeNode;
  assert.match(row.textContent, /Needs your approval/);
  assert.match(row.textContent, /PR #7 work/);
  assert.match(row.textContent, /Act here/);
  const links = row.all().filter((node) => node.tag === 'a').map((node) => node.getAttribute('href'));
  assert.deepEqual(links, ['https://example.com/pull/7'], 'only the http(s) address is a link');
});

// #603: the right column holds the board's controls: the start form, the limits
// form, the runs the board started with their stop buttons, and the live output.
test('board script: the controls start and stop agents from the page', () => {
  const data = makeData({
    issues: [{ number: 603, title: 'board agents', url: '', createdAt: '', updatedAt: '', dependsOn: [] }],
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
  assert.equal(/Needs you\d/.test(right.textContent), false, 'the controls do not list Needs you');
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
    issues: [{ number: 603, title: hostile, url: '', createdAt: '', updatedAt: '', dependsOn: [] }],
    runs: [{ name: hostile, issue: '603', vendor: hostile, model: hostile, worktree: hostile, pid: null, status: 'running', startedAt: '', stoppedAt: '', exitCode: null, output: [hostile] }],
    waiting: [{ kind: 'question', agent: hostile, role: '', wait: hostile, why: hostile, link: '' }],
  });
  const state = makeState(data);
  const nodes = [renderStart(state, data.issues), renderRuns(state, data.runs), renderOutput(state, data.runs), renderRight(state, data, Date.now())].flatMap((node) => (node as unknown as FakeNode).all());
  assert.ok(!nodes.some((node) => node.tag === 'img'), 'no element comes from the text');
  assert.ok(nodes.filter((node) => node.tag === '#text' && node.text === hostile).length >= 4, 'the words show as they are');
  assert.ok(!nodes.some((node) => node.tag === 'a'), 'no link without an http(s) address');
});

test('board script: a finished or stale desk joins the cleared list, and comes back when it is live (#779)', () => {
  const done = agent({ key: '~/d', name: 'Done one', dot: 'done', updated: 'u1', isLive: false });
  const stale = agent({ key: '~/s', name: 'Stale one', dot: 'idle', isLive: false });
  const live = agent({ key: '~/w', name: 'Live one', dot: 'working', isLive: true });
  const waiting = agent({ key: '~/q', name: 'Ask one', dot: 'waiting', isLive: false });
  const data = makeData({ agents: [agent({ key: '~/l', role: 'lead', name: 'Lead', isMain: true }), done, stale, live, waiting] });
  const state = makeState(data);
  const text = () => (renderSide(state, data)[1] as unknown as FakeNode).textContent;
  assert.match(text(), /Live one/);
  assert.match(text(), /Ask one/);
  assert.doesNotMatch(text(), /Done one/);
  assert.doesNotMatch(text(), /Stale one/);
  assert.match(text(), /2 archived agents/);
  state.ui.showCleared = true;
  assert.match(text(), /Done one/);
  assert.match(text(), /Stale one/);
  const list = renderSide(state, data)[1] as unknown as FakeNode;
  assert.ok(list.all().some((node) => node.getAttribute('data-pick') === '~/d'), 'a finished desk can still be opened');
  assert.ok(list.all().some((node) => node.getAttribute('data-pick') === '~/s'), 'a stale desk can still be opened');
  done.dot = 'working';
  done.isLive = true;
  done.updated = 'u2';
  assert.match(text(), /Done one/, 'it is live again, so it is back on the list');
  assert.match(text(), /1 archived agent/);
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

// #685: an empty board says in plain words how agents appear, in every language.
// It names no JSON file. The start form is not on the page (#737).
test('board script: the empty board says how agents appear', () => {
  for (const lang of Object.keys(WORDS)) {
    const state = makeState(makeData({}), lang);
    const text = [renderCenter(state, makeData({})), ...renderSide(state, makeData({}))].map((node) => (node as unknown as FakeNode).textContent).join(' ');
    assert.doesNotMatch(text, /\.yokoten-agent\.json|"role"|JSON/, `${lang}: no file name or JSON`);
  }
  const english = makeState(makeData({}));
  const center = (renderCenter(english, makeData({})) as unknown as FakeNode).textContent;
  assert.match(center, /Start any agent in this repo/);
  assert.match(center, /It shows here at once/);
});

// #693: a role groups by the work its name contains. The checkout lead stays in its
// own box. A lead in a desk is a project manager, above the engineers.
test('board script: roles group by the work they name', () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
  const english = makeState(makeData({}));
  const group = (role: string) => roleGroup(role);
  for (const role of ['worker', 'Worker', 'engineer', 'senior', 'developer', 'coder', 'development']) assert.equal(group(role), 'group.engineer', role);
  for (const role of ['reviewer', 'Review', 'Code Review']) assert.equal(group(role), 'group.reviewer', role);
  for (const role of ['verifier', 'checker', 'tester']) assert.equal(group(role), 'group.verifier', role);
  for (const role of ['lead', 'manager', 'pm', 'PM']) assert.equal(group(role), 'group.manager', role);
  for (const role of ['oracle', '', 'boss']) assert.equal(group(role), 'group.helper', role);
  assert.equal(say(english, group('worker')), 'Engineers');
  assert.equal(say(english, group('reviewer')), 'Reviewers');
  assert.equal(say(english, group('lead')), 'Project managers');
  assert.equal(say(english, group('oracle')), 'Helpers');
  assert.equal(say(makeState(makeData({}), 'zh-CN'), 'group.manager'), '项目经理');
  assert.equal(say(makeState(makeData({}), 'zh-TW'), 'group.manager'), '專案經理');
  assert.equal(say(makeState(makeData({}), 'ja'), 'group.manager'), 'プロジェクトマネージャー');
  const data = makeData({
    agents: [
      agent({ key: '~/main', name: 'Ada', role: 'lead', isMain: true }),
      agent({ key: '~/desk', name: 'Bea', role: 'lead' }),
      agent({ key: '~/w', name: 'worker-file', nickname: 'Swift Lovelace', title: 'Fix the board', role: 'worker' }),
      agent({ key: '~/r', name: 'Rev', role: 'reviewer' }),
      agent({ key: '~/u', name: 'Odd', role: 'oracle' }),
    ],
  });
  const state = makeState(data);
  const [pinned, list] = renderSide(state, data).map((node) => node as unknown as FakeNode);
  assert.match(pinned.textContent, /Ada/);
  assert.equal(pinned.textContent.includes('Bea'), false, 'a desk lead stays out of the lead box');
  assert.equal(pinned.textContent.includes('worker-file'), false, 'a worker stays out of the lead box');
  const text = list.textContent;
  assert.ok(text.indexOf('Project managers') < text.indexOf('Engineers'), 'project managers sit above engineers');
  assert.ok(text.includes('Bea') && text.includes('Swift Lovelace') && text.includes('Rev') && text.includes('Odd'));
  assert.equal(text.includes('Other agents'), false, 'no other-agents group');
  const row = list.all().find((node) => node.getAttribute('data-pick') === '~/w');
  assert.equal(row?.all().find((node) => node.getAttribute('class') === 'who')?.textContent, 'Swift Lovelace');
  assert.equal(row?.all().find((node) => node.getAttribute('class') === 'ttl')?.textContent, 'Fix the board');
});

// #693: the top bar names the main checkout's folder, the same name the address uses.
test('board script: the top bar shows the main folder', () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined }, matchMedia: () => ({ matches: false }), fetch: () => new Promise(() => undefined) });
  const nodes = new Map<string, FakeNode>();
  for (const id of ['live', 'live-text', 'lang-name', 'lang', 'lang-menu', 'github', 'theme', 'pinned', 'agents', 'center', 'right', 'bar', 'repo', 'toast']) nodes.set(id, new FakeNode('div'));
  Object.assign(fakeDocument, { getElementById: (id: string) => nodes.get(id) ?? null, documentElement: new FakeNode('html') });
  const data = makeData({ repo: '~/work/yokoten-688-board-fast', repoName: 'yokoten' });
  render(makeState(data));
  assert.equal(nodes.get('repo')?.textContent, 'yokoten');
});

// #698: a working chip breathes. The bar shows free seats, or idle agents when no file is set.
test('board script: a working chip breathes, and the bar counts free seats', () => {
  const live = agent({ key: '~/a', name: 'Live', vendor: vendorOf('grok'), isLive: true, dot: 'working' });
  const idle = agent({ key: '~/b', name: 'Idle', vendor: vendorOf('claude'), isLive: false, dot: 'idle' });
  const data = makeData({ agents: [live, idle, agent({ key: '~/c', name: 'Done', vendor: vendorOf('grok'), dot: 'done' })] });
  const state = makeState(data);
  const list = renderSide(state, data)[1] as unknown as FakeNode;
  const markOf = (key: string) => list.all().find((node) => node.getAttribute('data-pick') === key)?.all().find((node) => (node.getAttribute('class') ?? '').includes('vm'));
  assert.ok(markOf('~/a')?.getAttribute('class')?.split(' ').includes('live'), 'a working chip breathes');
  assert.equal(markOf('~/b'), undefined, 'a stale desk leaves the list');
  assert.match(list.textContent, /2 archived agents/);
  state.ui.current = '~/a';
  const head = (renderCenter(state, data) as unknown as FakeNode).all().find((node) => (node.getAttribute('class') ?? '').includes('vm'));
  assert.ok(head?.getAttribute('class')?.split(' ').includes('live'), 'the session header breathes too');
  const open = renderBar(state, data).map((node) => node as unknown as FakeNode);
  assert.match(open.map((node) => node.textContent).join('\n'), /1 idle/);
  assert.match(open.map((node) => node.textContent).join('\n'), /Grok · 1 agent · 0 idle/);
  const grok = open.find((node) => node.textContent.includes('Grok'));
  const claude = open.find((node) => node.textContent.includes('Claude'));
  assert.equal(grok?.all().find((node) => (node.getAttribute('class') ?? '').includes('vm'))?.getAttribute('class'), 'vm live');
  assert.equal(claude?.all().find((node) => (node.getAttribute('class') ?? '').includes('vm'))?.getAttribute('class'), 'vm');
  const seated = { ...data, seats: { grok: 16, deepseek: 4, claude: 0, muse: 0 } };
  const withSeats = renderBar(state, seated).map((node) => (node as unknown as FakeNode).textContent).join('\n');
  assert.match(withSeats, /19 free/);
  assert.match(withSeats, /Grok · 1 of 16/);
  assert.match(withSeats, /Claude · 0 of 0/);
  const clamped = renderBar(state, { ...data, seats: { grok: 0 } }).map((node) => (node as unknown as FakeNode).textContent).join('\n');
  assert.match(clamped, /Grok · 1 of 0/);
  assert.match(clamped, /^0 free/m);
});

// #779: 21 seats, and 30 old desks. The footer shows who is working, of those seats.
test('board script: the footer counts seats, not every desk it has seen (#779)', () => {
  const old = Array.from({ length: 30 }, (_, index) => agent({
    key: `~/old-${index}`,
    name: `old-${index}`,
    vendor: vendorOf(index % 2 === 0 ? 'grok' : 'deepseek'),
    dot: 'idle',
    isLive: false,
  }));
  const working = [
    agent({ key: '~/g1', name: 'g1', vendor: vendorOf('grok'), dot: 'working', isLive: true }),
    agent({ key: '~/g2', name: 'g2', vendor: vendorOf('grok'), dot: 'working', isLive: true }),
    agent({ key: '~/d1', name: 'd1', vendor: vendorOf('deepseek'), dot: 'working', isLive: true }),
  ];
  const data = makeData({ agents: [...old, ...working], seats: { claude: 1, grok: 8, deepseek: 12 } });
  const state = makeState(data);
  const bar = renderBar(state, data).map((node) => (node as unknown as FakeNode).textContent).join('\n');
  assert.equal(1 + 8 + 12, 21);
  assert.match(bar, /Grok · 2 of 8/);
  assert.match(bar, /DeepSeek · 1 of 12/);
  assert.match(bar, /Claude · 0 of 1/);
  const list = renderSide(state, data)[1] as unknown as FakeNode;
  assert.match(list.textContent, /30 archived agents/);
  assert.equal(list.textContent.includes('old-0'), false, 'an old desk is not listed');
  assert.match(list.textContent, /g1/);
  assert.match(list.textContent, /d1/);
});

// #737: the bell opens and closes, the badge counts, a new row pulses once, and a
// finished row leaves on the next draw.
test('board script: the bell opens, closes, counts, and drops a finished row', () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined }, matchMedia: () => ({ matches: false }), fetch: () => new Promise(() => undefined) });
  const nodes = new Map<string, FakeNode>();
  for (const id of ['live', 'live-text', 'lang-name', 'lang', 'lang-menu', 'github', 'theme', 'pinned', 'agents', 'center', 'bar', 'repo', 'toast', 'needs', 'needs-count', 'needs-menu']) {
    const node = new FakeNode(id === 'needs' || id === 'lang' || id === 'theme' ? 'button' : 'div');
    node.setAttribute('id', id);
    nodes.set(id, node);
  }
  const bell = nodes.get('needs') as FakeNode;
  const badge = nodes.get('needs-count') as FakeNode;
  bell.append(badge);
  const menu = nodes.get('needs-menu') as FakeNode;
  fakeDocument.documentElement = new FakeNode('html');
  fakeDocument.getElementById = (id: string) => nodes.get(id) ?? null;
  fakeDocument.querySelector = (selector: string) => (selector.includes('#needs-menu') ? menu.all().find((node) => node.tag === 'a' || node.hasAttribute('tabindex')) ?? null : null);
  const hoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const approve = { kind: 'approve' as const, title: 'Approve PR #7', why: 'work. All checks pass. Tier A needs your approval.', agentKey: '', pull: 7, at: hoursAgo };
  const answer = { kind: 'answer' as const, title: 'Bea is waiting for you', why: 'Which name?', agentKey: '~/b', pull: 0, issue: 8, at: dayAgo };
  const data = makeData({
    needs: [approve, answer],
    pulls: [pullView({ number: 7, title: 'work', branch: 'b', url: 'https://example.com/pull/7', stage: 'open', checks: 'pass', tier: 'A', review: 'waiting', isApprovedOnHead: false, mergedAt: '' })],
    issues: [{ number: 8, title: 'Name the row', url: 'https://example.com/issues/8', createdAt: '', updatedAt: '', dependsOn: [] }],
  });
  const state = makeState(data);
  const click = (target: FakeNode) => onClick(state, { target } as unknown as Event);
  render(state);
  assert.equal(badge.textContent, '2');
  assert.equal(badge.getAttribute('class'), 'badge on', 'the first sight does not pulse');
  assert.equal(menu.hidden, true);
  assert.doesNotMatch((nodes.get('pinned') as FakeNode).textContent, /Needs you/);
  assert.equal(fakeDocument.getElementById?.('right') ?? null, null, 'the page has no right column');
  click(bell);
  assert.equal(state.isNeedsOpen, true);
  assert.equal(menu.hidden, false);
  assert.equal(bell.getAttribute('aria-expanded'), 'true');
  const rows = menu.all().filter((node) => node.getAttribute('class') === 'need-item');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.getAttribute('tabindex') === '0'), 'a row can take the keyboard');
  assert.match(rows[0].textContent, /Needs your approval/);
  assert.match(rows[0].textContent, /PR #7 work/);
  assert.doesNotMatch(rows[0].textContent, /Older than a day/);
  assert.doesNotMatch(rows[0].textContent, /All checks pass/);
  assert.match(rows[1].textContent, /Which name\?/);
  assert.match(rows[1].textContent, /Issue #8 Name the row/);
  assert.match(rows[1].textContent, /Older than a day/);
  const links = menu.all().filter((node) => node.tag === 'a').map((node) => node.getAttribute('href'));
  assert.deepEqual(links, ['https://example.com/pull/7', 'https://example.com/issues/8']);
  click(links.length ? (menu.all().find((node) => node.tag === 'a') as FakeNode) : bell);
  assert.equal(state.isNeedsOpen, true, 'a click inside the list stays open');
  click(badge);
  assert.equal(state.isNeedsOpen, false, 'the bell again closes it');
  assert.equal(menu.hidden, true);
  click(bell);
  click(new FakeNode('div'));
  assert.equal(state.isNeedsOpen, false, 'a click outside closes it');
  click(bell);
  onMenuKey(state, { key: 'Escape' } as unknown as KeyboardEvent);
  assert.equal(state.isNeedsOpen, false, 'Escape closes it');
  assert.equal(fakeDocument.activeElement, bell, 'Escape returns to the bell');
  const extra = { kind: 'answer' as const, title: 'Cy is waiting for you', why: 'A new one', agentKey: '~/c', pull: 0, issue: 9, at: hoursAgo };
  data.needs = [approve, answer, extra];
  render(state);
  assert.equal(badge.getAttribute('class'), 'badge on pulse', 'a new row pulses once');
  assert.equal(state.pulseNeeds, false, 'the pulse is for this draw only');
  render(state);
  assert.equal(badge.getAttribute('class'), 'badge on', 'the next draw does not pulse again');
  state.isNeedsOpen = true;
  data.needs = [...data.needs, { kind: 'answer', title: 'Di is waiting for you', why: 'While open', agentKey: '~/d', pull: 0, at: hoursAgo }];
  render(state);
  assert.equal(badge.getAttribute('class'), 'badge on', 'an open list does not pulse');
  data.needs = data.needs.filter((need) => need.pull !== 7);
  render(state);
  assert.equal(menu.textContent.includes('PR #7'), false, 'a finished row leaves without a reload');
  assert.match(menu.textContent, /Which name\?/);
  data.needs = [];
  render(state);
  assert.equal(badge.textContent, '0');
  assert.equal(badge.getAttribute('class'), 'badge');
  assert.match(menu.textContent, /Nothing needs you right now/);
});
