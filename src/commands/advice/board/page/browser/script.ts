/// <reference lib="dom" />
// The board page's script (#603). Each function runs in the browser. page.ts puts its source
// into the page, so it uses only other functions here, its arguments and the browser.
// Tests call the plain ones. Every word from a status file goes in as text.

import type { BoardIssue, BoardLimits, BoardRun, BoardWaiting } from '../../controls.ts';
import type { FeedEvent } from '../../feed/steps.ts';
import type { AgentView, BoardData } from '../../view.ts';
import { ageOfNeed, fillNeeds, foldHead, idOfNeed, noteNewNeeds, refChip, renderNeedItem, renderSide, vendorChip } from './column.ts';
import { renderTimeline } from './desk.ts';
import { isCheckoutLead, roleGroup } from '../groups.ts';
import { githubNote, renderBar, renderLimits, renderOutput, renderRight, renderRuns, renderStart, RIGHT_FUNCTIONS } from '../right.ts';
import { followStream, renderStream, type StreamView } from './stream.ts';
import { renderAgentPanel } from './panel.ts';

export { ageOfNeed, fillNeeds, foldHead, idOfNeed, noteNewNeeds, renderNeedItem, renderSide };
export { githubNote, isCheckoutLead, renderBar, renderLimits, renderOutput, renderRight, renderRuns, renderStart, roleGroup };

/** The page's data: what /data sends. The waiting list, the open issues, the board's own runs, and its limits ride with the board. */
export type PageData = BoardData & {
  feeds: Record<string, FeedEvent[]>;
  waiting: BoardWaiting[];
  issues: BoardIssue[] | string;
  runs: BoardRun[];
  limits: BoardLimits;
  /** How fresh the GitHub lists are (#688): a read runs now, when they were last read, and why the last read failed. */
  github?: { isReading: boolean; readAt: string; failed: string };
};

/** What the owner folded, cleared or picked. Kept in this browser only; the board works without it. */
export interface PageUi {
  current: string;
  fold: Record<string, boolean>;
  open: Record<string, boolean>;
  /** Cleared agents as key@updated, so an agent that writes again comes back. */
  cleared: string[];
  showCleared: boolean;
  /** The local day "Merged today" was cleared, or ''. */
  mergedCleared: string;
  theme: '' | 'light' | 'dark';
  /** The language tag the owner picked, or the browser's. */
  lang: string;
}

/** Everything the page holds while it runs. The board's cookie is not one of these fields. */
export interface PageState {
  refreshMs: number;
  agentFile: string;
  /** Each language's words, and each language's own name. */
  words: Record<string, Record<string, string>>;
  langNames: Record<string, string>;
  data: PageData | null;
  ui: PageUi;
  live: 'loading' | 'live' | 'lost' | 'waiting';
  isMenuOpen: boolean;
  /** The Needs you panel is open. A reload starts closed. */
  isNeedsOpen?: boolean;
  /** Row ids from the last draw, so a new one can pulse the badge. */
  seenNeedIds?: string[];
  /** True after the first list. The first draw does not pulse. */
  hasSeenNeeds?: boolean;
  /** True for this draw when a new row arrived while the panel was closed. */
  pulseNeeds?: boolean;
  toast: { key: string; count: number; cleared: string[]; merged: boolean } | null;
  toastTimer: number;
  readAt: number;
  /** The picked agent's session as it streams (#694); none before the first draw. */
  stream?: StreamView;
}

/** A routine step run: three or more steps in a row that need nothing from the owner. */
export type FeedItem = FeedEvent | { kind: 'group'; items: FeedEvent[] };

/** One element with its class, attributes and children. Text children become text nodes. */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) if (child !== null) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

/** One Lucide icon from the page's sprite. */
export function icon(name: string, small = false): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', small ? 'i s' : 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** A word in the page's language, with its values put in. A count picks its plural form, such as `.one`, where the language has one. */
export function say(state: PageState, key: string, values: Record<string, string | number> = {}): string {
  const lang = state.words[state.ui.lang] ? state.ui.lang : 'en';
  const words = state.words[lang];
  const form = typeof values.n === 'number' ? new Intl.PluralRules(lang).select(values.n) : '';
  const text = (form ? words[`${key}.${form}`] : undefined) ?? words[key] ?? state.words.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

/** The board's language for the browser's languages: the first one it speaks, else English. */
export function pickLang(tags: readonly string[]): string {
  for (const tag of tags.map((each) => each.toLowerCase())) {
    if (/^zh-(tw|hk|mo)|^zh-hant/.test(tag)) return 'zh-TW';
    if (tag.startsWith('zh')) return 'zh-CN';
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

/** How long ago an agent wrote, in the page's language. English keeps the server's words. */
export function ageOf(state: PageState, agent: AgentView, now: number): string {
  const then = Date.parse(agent.updated);
  if (Number.isNaN(then) || (state.ui.lang === 'en' && agent.age)) return agent.age;
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 1) return say(state, 'justNow');
  const format = new Intl.RelativeTimeFormat(state.ui.lang, { style: 'short' });
  if (minutes < 60) return format.format(-minutes, 'minute');
  return minutes < 1440 ? format.format(-Math.floor(minutes / 60), 'hour') : format.format(-Math.floor(minutes / 1440), 'day');
}


/** Fold three or more routine steps in a row into one group. Waits, failures and the end never fold, and the latest step always shows. */
export function groupFeed(events: FeedEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  let run: FeedEvent[] = [];
  const flush = () => {
    if (run.length >= 3) items.push({ kind: 'group', items: run });
    else items.push(...run);
    run = [];
  };
  for (const event of events) {
    if (event.kind === 'step' || event.kind === 'pass') run.push(event);
    else {
      flush();
      items.push(event);
    }
  }
  const latest = run.pop();
  flush();
  if (latest) items.push(latest);
  return items;
}

/** The local day of a time, as YYYY-MM-DD. */
export function localDay(time: number): string {
  const day = new Date(time);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** The id a cleared agent is kept by: it comes back when it writes again. */
export function clearedId(agent: AgentView): string {
  return `${agent.key}@${agent.updated}`;
}

/** "2 working · 1 waiting": what a folded group holds. */
export function summaryOf(state: PageState, dots: string[]): string {
  const counts: Record<string, number> = {};
  for (const dot of dots) counts[dot] = (counts[dot] ?? 0) + 1;
  return Object.entries(counts).map(([dot, count]) => `${count} ${say(state, `dot.${dot}`)}`).join(' · ');
}

/** The UI the owner left last time, or the defaults. A phone starts with the agent groups folded. */
export function loadUi(isPhone: boolean, browserLangs: readonly string[] = []): PageUi {
  const groups = ['group.manager', 'group.engineer', 'group.reviewer', 'group.verifier', 'group.helper'];
  const fold: Record<string, boolean> = { 'group.finished': true };
  if (isPhone) for (const group of groups) fold[group] = true;
  const ui: PageUi = { current: '', fold, open: {}, cleared: [], showCleared: false, mergedCleared: '', theme: '', lang: pickLang(browserLangs) };
  try {
    const saved = JSON.parse(localStorage.getItem('yokoten-board') ?? 'null');
    if (saved && typeof saved === 'object') {
      if (saved.fold && typeof saved.fold === 'object') for (const [key, value] of Object.entries(saved.fold)) if (typeof value === 'boolean' && key !== '__proto__') ui.fold[key] = value;
      if (Array.isArray(saved.cleared)) ui.cleared = saved.cleared.filter((id: unknown) => typeof id === 'string');
      if (typeof saved.mergedCleared === 'string') ui.mergedCleared = saved.mergedCleared;
      if (saved.theme === 'light' || saved.theme === 'dark') ui.theme = saved.theme;
      if (['en', 'zh-CN', 'zh-TW', 'ja'].includes(saved.lang)) ui.lang = saved.lang;
    }
  } catch {
    // A private window or blocked storage: the defaults stand.
  }
  return ui;
}

export function saveUi(ui: PageUi): void {
  try {
    localStorage.setItem('yokoten-board', JSON.stringify({ fold: ui.fold, cleared: ui.cleared, mergedCleared: ui.mergedCleared, theme: ui.theme, lang: ui.lang }));
  } catch {
    // Not saved: the board still works.
  }
}


/** One step in the feed. A step is the agent's own words; the other kinds are the board's. */
function feedEvent(state: PageState, event: FeedEvent): HTMLElement {
  const look: Record<string, string> = { step: 'term', pass: 'check', wait: 'bell', fail: 'shield', done: 'done' };
  const time = new Date(event.time).toLocaleTimeString(state.ui.lang, { hour: 'numeric', minute: '2-digit' });
  const text = event.kind === 'step' ? event.text : say(state, `feed.${event.kind}`);
  return el('div', { class: `ev ${event.kind}` }, el('span', { class: 'ic' }, icon(look[event.kind] ?? 'term')), el('div', { class: 't' }, el('p', {}, text)), el('span', { class: 'tm' }, time));
}

/** The middle: the picked agent, its feed, and what the owner can do. */
export function renderCenter(state: PageState, data: PageData): HTMLElement {
  const agent = data.agents.find((each) => each.key === state.ui.current) ?? data.agents.find((each) => isCheckoutLead(each));
  if (!agent) return el('div', { class: 'blank' }, el('h1', {}, say(state, 'emptyTitle')), el('p', {}, say(state, 'emptyBody', { file: state.agentFile })));
  const isLead = isCheckoutLead(agent);
  const isCleared = state.ui.cleared.includes(clearedId(agent));
  const roleKey = `role.${agent.role}`;
  const role = agent.role && state.words.en[roleKey] ? ` · ${say(state, roleKey)}` : '';
  const who = agent.nickname || agent.name;
  const head = el('div', { class: 'ch' },
    el('div', { class: 'grow' }, el('h1', {}, agent.title || agent.name),
      el('div', { class: 'sub' }, vendorChip(agent), el('span', {}, isLead ? `${who} · ${say(state, 'yourManager')}` : `${who}${role}`), agent.branch ? el('span', { class: 'mono' }, icon('branch', true), agent.branch) : null)),
    agent.model ? el('span', { class: 'model', title: say(state, 'modelEffort') }, el('b', {}, agent.model), agent.effort ? `· ${agent.effort}` : '') : null,
    refChip(agent),
    agent.dot === 'done' && !isCleared ? el('button', { class: 'hbtn', 'data-clear': clearedId(agent), title: say(state, 'keptHint') }, icon('archive', true), say(state, 'clearFromBoard')) : null);
  const foot = agent.dot === 'done'
    ? el('div', { class: 'ro' }, icon('done', true), say(state, 'finishedNote'))
    : el('div', { class: 'ro' }, icon('lock', true), say(state, isLead ? 'leadNote' : 'otherNote'));
  const panel = renderAgentPanel(state, agent);
  // The lead's middle is the timeline (#701). Another agent's session is unchanged (#694).
  if (isLead) return el('section', { class: 'center-in' }, head, panel, renderTimeline(state, data), foot);
  // The agent's own session when its log is found (#694); else the steps the board saw.
  const stream = renderStream(state, agent);
  if (stream) {
    const ask = agent.dot === 'waiting' ? el('div', { class: 'ask' }, el('div', { class: 'ah' }, icon('shield'), el('h2', {}, say(state, 'waitingFor', { name: agent.name }))), el('p', {}, agent.doing || say(state, 'noReason')), el('p', { class: 'quiet' }, say(state, 'answerThere'))) : null;
    return el('section', { class: 'center-in' }, head, panel, stream, ask, foot);
  }
  const events = data.feeds[agent.key] ?? [];
  const feed = el('div', { class: 'feed' }, el('div', { class: 'day' }, say(state, 'since')));
  groupFeed(events).forEach((item) => {
    if (item.kind !== 'group') return void feed.append(feedEvent(state, item));
    const key = `${agent.key}#${item.items[0].time}`;
    const isOpen = !!state.ui.open[key];
    feed.append(el('button', { class: `grp${isOpen ? ' open' : ''}`, 'data-group': key, 'aria-expanded': String(isOpen) }, icon('chev', true), el('span', {}, say(state, 'routine', { n: item.items.length }))));
    if (isOpen) feed.append(el('div', { class: 'grp-body' }, ...item.items.map((event) => feedEvent(state, event))));
  });
  if (!events.length) feed.append(el('p', { class: 'quiet' }, agent.doing || say(state, 'nothingYet')));
  if (agent.dot === 'waiting') feed.append(el('div', { class: 'ask' }, el('div', { class: 'ah' }, icon('shield'), el('h2', {}, say(state, 'waitingFor', { name: agent.name }))), el('p', {}, agent.doing || say(state, 'noReason')), el('p', { class: 'quiet' }, say(state, 'answerThere'))));
  return el('section', { class: 'center-in' }, head, panel, feed, foot);
}

/** The top bar's words, the language menu, the GitHub link and the theme icon. */
export function renderTop(state: PageState): void {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const isDark = state.ui.theme === 'dark' || (!state.ui.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', state.ui.theme);
  document.documentElement.setAttribute('lang', state.ui.lang);
  byId('live').className = `pill${state.live === 'live' ? '' : ' off'}`;
  byId('live-text').textContent = say(state, `live.${state.live}`);
  byId('lang-name').textContent = state.langNames[state.ui.lang] ?? 'English';
  byId('lang').setAttribute('aria-label', say(state, 'language'));
  byId('lang').setAttribute('aria-expanded', String(state.isMenuOpen));
  const menu = byId('lang-menu');
  menu.hidden = !state.isMenuOpen;
  // A refresh redraws the top bar; the items stay, so a focused item keeps its focus.
  if (menu.getAttribute('data-for') !== state.ui.lang) {
    menu.setAttribute('data-for', state.ui.lang);
    menu.replaceChildren(...Object.entries(state.langNames).map(([tag, name]) => el('button', { class: 'mi', role: 'menuitemradio', 'data-lang': tag, 'aria-checked': String(tag === state.ui.lang), lang: tag }, el('span', { class: 'grow' }, name), tag === state.ui.lang ? icon('check', true) : null)));
  }
  const github = byId('github');
  github.hidden = !/^https:\/\//.test(state.data?.repoUrl ?? '');
  if (!github.hidden) github.setAttribute('href', state.data?.repoUrl ?? '');
  for (const [id, key] of [['github', 'github'], ['theme', 'theme']]) {
    byId(id).setAttribute('aria-label', say(state, key));
    byId(id).setAttribute('title', say(state, key));
  }
  byId('theme').replaceChildren(icon(isDark ? 'sun' : 'moon'));
  const count = state.data?.needs.length ?? 0;
  const badge = document.getElementById('needs-count');
  if (badge) {
    badge.textContent = String(count);
    badge.setAttribute('class', `badge${count > 0 ? ' on' : ''}${state.pulseNeeds ? ' pulse' : ''}`);
  }
  const needs = document.getElementById('needs');
  if (needs) {
    needs.setAttribute('aria-expanded', String(state.isNeedsOpen === true));
    needs.setAttribute('aria-label', say(state, 'needsYou'));
    needs.setAttribute('title', say(state, 'needsYouHint'));
  }
  for (const area of ['pinned', 'agents', 'center']) {
    const node = document.getElementById(area);
    if (node) node.setAttribute('aria-label', say(state, `area.${area}`));
  }
}

/** Draw the whole page from the state. */
export function render(state: PageState): void {
  const data = state.data;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  if (data) noteNewNeeds(state, data.needs);
  renderTop(state);
  if (data) fillNeeds(state, data);
  state.pulseNeeds = false;
  if (!data) return;
  if (!data.agents.some((agent) => agent.key === state.ui.current)) state.ui.current = data.agents.find((agent) => isCheckoutLead(agent))?.key ?? '';
  const [pinned, agents] = renderSide(state, data);
  byId('pinned').replaceChildren(pinned);
  byId('agents').replaceChildren(agents);
  followStream(state, state.ui.current);
  // The stream's list is kept between draws; a draw puts it back where the owner left it, or at the end.
  const list = state.stream?.node;
  const top = list ? list.scrollTop : 0;
  const isAtEnd = !list || !list.isConnected || list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
  byId('center').replaceChildren(renderCenter(state, data));
  if (list?.isConnected) list.scrollTop = isAtEnd ? list.scrollHeight : top;
  // The right column is gone (#737). A test page that still has the node can draw it.
  const right = document.getElementById('right');
  if (right) right.replaceChildren(renderRight(state, data, Date.now()));
  byId('bar').replaceChildren(...renderBar(state, data));
  byId('repo').textContent = data.repoName || data.repo.split('/').pop() || data.repo;
  const toast = byId('toast');
  toast.hidden = !state.toast;
  toast.replaceChildren(...(state.toast ? [el('span', {}, say(state, state.toast.key, { n: state.toast.count })), el('button', { 'data-undo': '1' }, say(state, 'undo'))] : []));
}

/** Show the undo note for 8 seconds. */
export function showToast(state: PageState, key: string, cleared: string[], merged: boolean): void {
  state.toast = { key, count: cleared.length, cleared, merged };
  clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    state.toast = null;
    render(state);
  }, 8000);
}

/** One click anywhere: each control says what it does in a data- attribute. */
export function onClick(state: PageState, event: Event): void {
  const hit = event.target as Element | null;
  const needsHit = hit?.closest('#needs, #needs-menu') ?? null;
  let closedNeeds = false;
  if (state.isNeedsOpen && !needsHit) {
    state.isNeedsOpen = false;
    closedNeeds = true;
  }
  const target = hit?.closest('[data-fold],[data-clear],[data-clear-all],[data-show-cleared],[data-restore],[data-group],[data-clear-merged],[data-undo],[data-pick],[data-reply],[data-lang],[data-start],[data-limits],[data-stop],#lang,#theme,#needs') ?? null;
  const fieldValue = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
  const ui = state.ui;
  if (state.isMenuOpen && target?.id !== 'lang' && !target?.hasAttribute('data-lang')) {
    state.isMenuOpen = false;
    renderTop(state);
  }
  if (target?.id === 'needs') {
    state.isNeedsOpen = state.isNeedsOpen !== true;
    state.pulseNeeds = false;
    render(state);
    if (state.isNeedsOpen) (document.querySelector?.('#needs-menu a, #needs-menu [tabindex]') as HTMLElement | null)?.focus();
    return;
  }
  if (!target) {
    if (closedNeeds) render(state);
    return;
  }
  const ask = (name: string) => target.getAttribute(name);
  if (target.id === 'lang') {
    state.isMenuOpen = !state.isMenuOpen;
    renderTop(state);
    if (state.isMenuOpen) (document.querySelector('#lang-menu [aria-checked=true]') as HTMLElement | null)?.focus();
    return;
  }
  if (ask('data-lang')) {
    ui.lang = ask('data-lang') as string;
    state.isMenuOpen = false;
    document.getElementById('lang')?.focus();
  } else if (target.id === 'theme') ui.theme = document.documentElement.getAttribute('data-theme') === 'dark' || (!ui.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark';
  else if (!state.data) return;
  else if (ask('data-clear')) {
    ui.cleared.push(ask('data-clear') as string);
    showToast(state, 'clearedToast', [ask('data-clear') as string], false);
  } else if (ask('data-clear-all')) {
    const ids = state.data.agents.filter((agent) => agent.dot === 'done' && !isCheckoutLead(agent)).map(clearedId).filter((id) => !ui.cleared.includes(id));
    ui.cleared.push(...ids);
    showToast(state, 'clearedMany', ids, false);
  } else if (ask('data-fold')) ui.fold[ask('data-fold') as string] = !ui.fold[ask('data-fold') as string];
  else if (ask('data-panel')) ui.open[`panel:${ask('data-panel') as string}`] = !ui.open[`panel:${ask('data-panel') as string}`];
  else if (ask('data-show-cleared')) ui.showCleared = !ui.showCleared;
  else if (ask('data-restore')) ui.cleared = ui.cleared.filter((id) => id !== ask('data-restore'));
  else if (ask('data-group')) ui.open[ask('data-group') as string] = !ui.open[ask('data-group') as string];
  else if (ask('data-reply')) ui.open['lead-reply'] = !ui.open['lead-reply'];
  else if (ask('data-clear-merged')) {
    ui.mergedCleared = localDay(Date.now());
    showToast(state, 'mergedHidden', [], true);
  } else if (ask('data-undo') && state.toast) {
    const undone = state.toast;
    ui.cleared = ui.cleared.filter((id) => !undone.cleared.includes(id));
    if (undone.merged) ui.mergedCleared = '';
    state.toast = null;
  } else if (ask('data-start') !== null) {
    postForm(state, 'agents/start', [['issue', fieldValue('start-issue')], ['vendor', fieldValue('start-vendor')], ['model', fieldValue('start-model')]], 'start-note', 'startDone');
  } else if (ask('data-limits') !== null) {
    postForm(state, 'agents/limits', [['maxAgents', fieldValue('limits-max')], ['models', fieldValue('limits-models')]], 'limits-note', 'limitsDone');
  } else if (ask('data-stop')) {
    postForm(state, 'agents/stop', [['name', ask('data-stop') as string]], 'runs-note', 'stopDone');
  } else if (ask('data-pick')) {
    ui.current = ask('data-pick') as string;
    render(state);
    const isStill = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (matchMedia('(max-width: 700px)').matches) document.getElementById('center')?.scrollIntoView({ behavior: isStill ? 'auto' : 'smooth' });
    return;
  }
  saveUi(ui);
  render(state);
}

/** The language menu's keys, and Escape for Needs you: arrows move, Escape closes. */
export function onMenuKey(state: PageState, event: KeyboardEvent): void {
  if (event.key === 'Escape' && state.isNeedsOpen) {
    state.isNeedsOpen = false;
    render(state);
    document.getElementById('needs')?.focus();
    if (!state.isMenuOpen) return;
  }
  if (!state.isMenuOpen) return;
  const items = [...document.querySelectorAll('#lang-menu [data-lang]')] as HTMLElement[];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape' || event.key === 'Tab') {
    state.isMenuOpen = false;
    renderTop(state);
    if (event.key === 'Escape') document.getElementById('lang')?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const from = at < 0 && event.key === 'ArrowUp' ? 0 : at;
    items[(from + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
}

/**
 * Post a controls form to the board, then read again. The fetch carries the page's
 * Origin, and the browser sends the board's cookie. The note says what the board
 * answered, as text; only a pass reads again.
 */
export function postForm(state: PageState, path: string, fields: [string, string][], noteId: string, doneKey: string): void {
  const note = document.getElementById(noteId);
  const body = fields.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    .then((res) => res.text().then((text) => ({ ok: res.ok, text })))
    .then(({ ok, text }) => {
      if (note) note.textContent = ok ? say(state, doneKey) : text || say(state, 'notReached');
      if (ok) loadData(state);
    })
    .catch(() => {
      if (note) note.textContent = say(state, 'notReached');
    });
}

/** Read /data, then draw. The pill says how fresh the data is. */
export function loadData(state: PageState): void {
  fetch('data', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((data: PageData) => {
      state.data = data;
      state.readAt = Date.now();
      state.live = 'live';
      render(state);
    })
    .catch(() => {
      state.live = state.data ? 'lost' : 'waiting';
      renderTop(state);
    });
}

/** Start the page: the saved UI, the clicks, the first read, then a read every refreshMs. */
export function startPage(state: PageState): void {
  state.ui = loadUi(matchMedia('(max-width: 700px)').matches, navigator.languages ?? [navigator.language]);
  document.addEventListener('click', (event) => onClick(state, event));
  document.addEventListener('keydown', (event) => onMenuKey(state, event));
  render(state);
  loadData(state);
  setInterval(() => loadData(state), state.refreshMs);
}

/** The page's functions, in the order page.ts writes them. */
export const PAGE_FUNCTIONS = [el, icon, say, pickLang, ageOf, groupFeed, localDay, clearedId, roleGroup, isCheckoutLead, summaryOf, loadUi, saveUi, feedEvent, renderCenter, ...RIGHT_FUNCTIONS, renderTop, render, showToast, onClick, onMenuKey, postForm, loadData, startPage];
