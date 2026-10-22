// Tests for src/commands/advice/board/script.ts. The pure functions run as they are; the
// drawing ones run on a small fake document that keeps every node it is given.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeedEvent } from '../../../../../src/commands/advice/board/feed.ts';
import { ageOf, clearedId, groupFeed, loadUi, localDay, type PageData, type PageState, pickLang, renderCenter, renderRight, renderSide, roleGroup, saveUi, say, summaryOf } from '../../../../../src/commands/advice/board/page/script.ts';
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
  return { repo: '~/repo', repoUrl: '', agents: [], needs: [], pulls: [], merged: [], worktrees: [], updated: '', feeds: {}, ...fields };
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
  assert.equal(say(english, roleGroup('verifier')), 'Checkers');
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
