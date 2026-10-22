/// <reference lib="dom" />
// The board page's script (#603). Each function here runs in the browser: page.ts puts
// their source into the page, so they use nothing but each other, their arguments and the
// browser. Tests call the plain ones directly. Agents write the status files, so every
// word goes in as text: nothing here parses HTML.

import type { FeedEvent } from '../feed.ts';
import type { AgentView, BoardData, NeedView, PullView } from '../view.ts';

/** The page's data: what /data sends. */
export type PageData = BoardData & { feeds: Record<string, FeedEvent[]> };

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

/** Everything the page holds while it runs. */
export interface PageState {
  token: string;
  refreshMs: number;
  agentFile: string;
  /** Each language's words, and each language's own name. */
  words: Record<string, Record<string, string>>;
  langNames: Record<string, string>;
  data: PageData | null;
  ui: PageUi;
  live: 'loading' | 'live' | 'lost' | 'waiting';
  isMenuOpen: boolean;
  toast: { key: string; count: number; cleared: string[]; merged: boolean } | null;
  toastTimer: number;
  readAt: number;
}

/** A routine step run: three or more steps in a row that need nothing from the owner. */
export type FeedItem = FeedEvent | { kind: 'group'; items: FeedEvent[] };

/** One element with its class, attributes and children. Text children become text nodes. */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name === 'cls' ? 'class' : name, value);
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

/** The group an agent's role goes in, as its word key. */
export function roleGroup(role: string): string {
  return ['engineer', 'reviewer', 'verifier', 'helper'].includes(role) ? `group.${role}` : 'group.other';
}

/** "2 working · 1 waiting": what a folded group holds. */
export function summaryOf(state: PageState, dots: string[]): string {
  const counts: Record<string, number> = {};
  for (const dot of dots) counts[dot] = (counts[dot] ?? 0) + 1;
  return Object.entries(counts).map(([dot, count]) => `${count} ${say(state, `dot.${dot}`)}`).join(' · ');
}

/** The UI the owner left last time, or the defaults. A phone starts with the agent groups folded. */
export function loadUi(isPhone: boolean, browserLangs: readonly string[] = []): PageUi {
  const groups = ['group.engineer', 'group.reviewer', 'group.verifier', 'group.helper', 'group.other'];
  const fold: Record<string, boolean> = { 'group.finished': true };
  if (isPhone) for (const group of groups) fold[group] = true;
  const ui: PageUi = { current: '', fold, open: {}, cleared: [], showCleared: false, mergedCleared: '', theme: '', lang: pickLang(browserLangs) };
  try {
    const saved = JSON.parse(localStorage.getItem('yokoten-board') ?? 'null');
    if (saved && typeof saved === 'object') {
      if (saved.fold && typeof saved.fold === 'object') Object.assign(ui.fold, saved.fold);
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

function vendorChip(agent: AgentView): HTMLElement {
  const mark = el('span', { cls: 'vm' });
  mark.style.background = agent.vendor.color;
  return el('span', { cls: 'chip' }, mark, agent.vendor.name);
}

function refChip(agent: AgentView): HTMLElement | null {
  if (!agent.ref) return null;
  return el('span', { cls: 'ref' }, icon(agent.ref.kind === 'pr' ? 'pr' : 'issue', true), `${agent.ref.kind === 'pr' ? 'PR' : 'Issue'} #${agent.ref.number}`);
}

/** A fold header: a button with the chevron, name, count and, when folded, what it hides; then an optional action beside it. */
function foldHead(state: PageState, key: string, dots: string[], extra: HTMLElement | null = null): HTMLElement {
  const isOpen = !state.ui.fold[key];
  return el('div', { cls: 'sh' },
    el('button', { cls: `f${isOpen ? ' open' : ''}`, 'data-fold': key, 'aria-expanded': String(isOpen) }, icon('chev', true), say(state, key), el('span', { cls: 'n' }, String(dots.length)), isOpen ? null : el('span', { cls: 'sum' }, summaryOf(state, dots))),
    extra);
}

/** One agent in the left column. A finished one gets a clear button beside it. */
function agentRow(state: PageState, agent: AgentView): HTMLElement {
  const isDone = agent.dot === 'done';
  const row = el('button', { cls: `row${isDone ? ' done-row' : ''}${agent.role === 'lead' ? ' lead-row' : ''}`, 'data-pick': agent.key, 'aria-current': String(agent.key === state.ui.current) },
    el('span', { cls: 'r1' }, el('span', { cls: `dot ${agent.dot}`, title: say(state, `dot.${agent.dot}`) }), el('span', { cls: 'ttl' }, agent.title || agent.name), el('span', { cls: 'age' }, ageOf(state, agent, Date.now()))),
    el('span', { cls: 'r2' }, vendorChip(agent), el('span', { cls: 'who' }, agent.role === 'lead' ? say(state, 'yourManager') : agent.name), refChip(agent)),
    agent.doing ? el('span', { cls: 'r3' }, el('span', {}, agent.doing)) : null);
  const clear = isDone ? el('button', { cls: 'x', 'data-clear': clearedId(agent), title: say(state, 'clearOne'), 'aria-label': say(state, 'clearOne') }, icon('x', true)) : null;
  return el('div', { cls: 'item' }, row, clear);
}

function needRow(state: PageState, need: NeedView): HTMLElement {
  const pull = typeof state.data?.pulls === 'string' ? undefined : state.data?.pulls.find((each) => each.number === need.pull);
  const agent = state.data?.agents.find((each) => each.key === need.agentKey);
  const title = need.kind === 'approve' ? say(state, 'approveTitle', { n: need.pull }) : say(state, 'waitingFor', { name: agent?.name ?? '' });
  const why = need.kind === 'approve' ? say(state, 'approveWhy', { title: pull?.title ?? '' }) : agent?.doing || agent?.task || say(state, 'noReason');
  const body = [el('span', { cls: 'r1' }, el('span', { cls: 'dot waiting' }), el('span', { cls: 'ttl' }, title)), el('span', { cls: 'r3 wrap' }, why)];
  if (need.kind === 'approve' && pull && /^https?:\/\//i.test(pull.url)) return el('a', { cls: 'row need-row', href: pull.url, target: '_blank', rel: 'noopener noreferrer' }, ...body);
  return el('button', { cls: 'row need-row', 'data-pick': need.agentKey }, ...body);
}

/** The left column: the lead and what needs you (never folded), then the agents by role, then the finished ones. */
export function renderSide(state: PageState, data: PageData): [HTMLElement, HTMLElement] {
  const lead = data.agents.find((agent) => agent.role === 'lead');
  const pinned = el('div', { cls: 'pinned' }, el('h2', { cls: 'sh lead-h' }, icon('msg', true), say(state, 'lead')));
  pinned.append(lead ? agentRow(state, lead) : el('div', { cls: 'row lead-row still' }, el('span', { cls: 'r1' }, el('span', { cls: 'dot idle' }), el('span', { cls: 'ttl' }, say(state, 'noLead'))), el('span', { cls: 'r3 wrap' }, say(state, 'noLeadHow', { file: state.agentFile }))));
  pinned.append(el('h2', { cls: 'sh need', title: say(state, 'needsYouHint') }, icon('bell', true), say(state, 'needsYou'), el('span', { cls: 'n' }, String(data.needs.length))));
  pinned.append(...(data.needs.length ? data.needs.map((need) => needRow(state, need)) : [el('p', { cls: 'quiet' }, say(state, 'nothingNeeds'))]));
  const list = el('div', { cls: 'agents' });
  const cleared = new Set(state.ui.cleared);
  const others = data.agents.filter((agent) => agent.role !== 'lead');
  const live = others.filter((agent) => agent.dot !== 'done');
  for (const group of ['group.engineer', 'group.reviewer', 'group.verifier', 'group.helper', 'group.other']) {
    const members = live.filter((agent) => roleGroup(agent.role) === group);
    if (!members.length) continue;
    list.append(foldHead(state, group, members.map((agent) => agent.dot)));
    if (!state.ui.fold[group]) list.append(...members.map((agent) => agentRow(state, agent)));
  }
  const finished = others.filter((agent) => agent.dot === 'done' && !cleared.has(clearedId(agent)));
  if (finished.length) {
    list.append(foldHead(state, 'group.finished', finished.map((agent) => agent.dot), el('button', { cls: 'act', 'data-clear-all': '1', title: say(state, 'clearAllHint') }, say(state, 'clearAll'))));
    if (!state.ui.fold['group.finished']) list.append(...finished.map((agent) => agentRow(state, agent)));
  }
  const hidden = others.filter((agent) => cleared.has(clearedId(agent)));
  if (hidden.length) {
    list.append(el('div', { cls: 'arch' }, icon('archive', true), say(state, 'clearedCount', { n: hidden.length }), el('button', { cls: 'act', 'data-show-cleared': '1', 'aria-expanded': String(state.ui.showCleared) }, say(state, state.ui.showCleared ? 'hide' : 'show'))));
    if (state.ui.showCleared) {
      list.append(...hidden.map((agent) => el('div', { cls: 'row done-row still' },
        el('span', { cls: 'r1' }, el('span', { cls: 'dot done' }), el('span', { cls: 'ttl' }, agent.title || agent.name), el('span', { cls: 'age' }, ageOf(state, agent, Date.now()))),
        el('span', { cls: 'r2' }, vendorChip(agent), el('span', { cls: 'who' }, agent.name), el('button', { cls: 'act', 'data-restore': clearedId(agent) }, say(state, 'putBack'))))));
    }
  }
  if (!others.length) list.append(el('p', { cls: 'quiet' }, say(state, 'noAgents', { file: state.agentFile })));
  return [pinned, list];
}

/** One step in the feed. A step is the agent's own words; the other kinds are the board's. */
function feedEvent(state: PageState, event: FeedEvent): HTMLElement {
  const look: Record<string, string> = { step: 'term', pass: 'check', wait: 'bell', fail: 'shield', done: 'done' };
  const time = new Date(event.time).toLocaleTimeString(state.ui.lang, { hour: 'numeric', minute: '2-digit' });
  const text = event.kind === 'step' ? event.text : say(state, `feed.${event.kind}`);
  return el('div', { cls: `ev ${event.kind}` }, el('span', { cls: 'ic' }, icon(look[event.kind] ?? 'term')), el('div', { cls: 't' }, el('p', {}, text)), el('span', { cls: 'tm' }, time));
}

/** The middle: the picked agent, its feed, and what the owner can do. */
export function renderCenter(state: PageState, data: PageData): HTMLElement {
  const agent = data.agents.find((each) => each.key === state.ui.current) ?? data.agents.find((each) => each.role === 'lead');
  if (!agent) return el('div', { cls: 'blank' }, el('h1', {}, say(state, 'emptyTitle')), el('p', {}, say(state, 'emptyBody', { file: state.agentFile })));
  const isLead = agent.role === 'lead';
  const isCleared = state.ui.cleared.includes(clearedId(agent));
  const role = agent.role ? ` · ${say(state, `role.${agent.role}`)}` : '';
  const head = el('div', { cls: 'ch' },
    el('div', { cls: 'grow' }, el('h1', {}, agent.title || agent.name),
      el('div', { cls: 'sub' }, vendorChip(agent), el('span', {}, isLead ? say(state, 'yourManager') : `${agent.name}${role}`), agent.branch ? el('span', { cls: 'mono' }, icon('branch', true), agent.branch) : null)),
    agent.model ? el('span', { cls: 'model', title: say(state, 'modelEffort') }, el('b', {}, agent.model), agent.effort ? `· ${agent.effort}` : '') : null,
    refChip(agent),
    agent.dot === 'done' && !isCleared ? el('button', { cls: 'hbtn', 'data-clear': clearedId(agent), title: say(state, 'keptHint') }, icon('archive', true), say(state, 'clearFromBoard')) : null);
  const events = data.feeds[agent.key] ?? [];
  const feed = el('div', { cls: 'feed' }, el('div', { cls: 'day' }, say(state, 'since')));
  groupFeed(events).forEach((item, index) => {
    if (item.kind !== 'group') return void feed.append(feedEvent(state, item));
    const key = `${agent.key}#${index}`;
    const isOpen = !!state.ui.open[key];
    feed.append(el('button', { cls: `grp${isOpen ? ' open' : ''}`, 'data-group': key, 'aria-expanded': String(isOpen) }, icon('chev', true), el('span', {}, say(state, 'routine', { n: item.items.length }))));
    if (isOpen) feed.append(el('div', { cls: 'grp-body' }, ...item.items.map((event) => feedEvent(state, event))));
  });
  if (!events.length) feed.append(el('p', { cls: 'quiet' }, agent.doing || say(state, 'nothingYet')));
  if (agent.dot === 'waiting') feed.append(el('div', { cls: 'ask' }, el('div', { cls: 'ah' }, icon('shield'), el('h2', {}, say(state, 'waitingFor', { name: agent.name }))), el('p', {}, agent.doing || say(state, 'noReason')), el('p', { cls: 'quiet' }, say(state, 'answerThere'))));
  const foot = agent.dot === 'done'
    ? el('div', { cls: 'ro' }, icon('done', true), say(state, 'finishedNote'))
    : el('div', { cls: 'ro' }, icon('lock', true), say(state, isLead ? 'leadNote' : 'otherNote'));
  return el('section', { cls: 'center-in' }, head, feed, foot);
}

function pullCard(state: PageState, pull: PullView): HTMLElement {
  const steps = el('div', { cls: 'steps' }, ...pull.steps.map((mark, index) => el('i', { cls: mark, title: say(state, `step.${index}`) })));
  const title = el('span', { cls: 'nm' }, el('span', { cls: 'num' }, `#${pull.number}`), ` ${pull.title}`);
  return el('div', { cls: 'pr' },
    el('div', { cls: 'h' }, el('span', { cls: 'open-i' }, icon('pr')), /^https?:\/\//i.test(pull.url) ? el('a', { href: pull.url, target: '_blank', rel: 'noopener noreferrer', cls: 'grow' }, title) : el('div', { cls: 'grow' }, title), pull.tier ? el('span', { cls: `tier t${pull.tier}` }, say(state, 'tier', { tier: pull.tier })) : null),
    steps, el('div', { cls: 'sl' }, el('span', { cls: pull.tone }, say(state, `pull.${pull.status}`)), el('span', { cls: 'mut' }, pull.branch)));
}

/** The right side: open pull requests with their steps, then what merged today. */
export function renderRight(state: PageState, data: PageData, now: number): HTMLElement {
  const box = el('div', {});
  const pulls = typeof data.pulls === 'string' ? [] : data.pulls;
  box.append(foldHead(state, 'pulls', pulls.map((pull) => (pull.tone === 'fail' ? 'failing' : pull.tone === 'ok' ? 'ready' : 'moving'))));
  if (!state.ui.fold.pulls) {
    if (typeof data.pulls === 'string') box.append(el('p', { cls: 'quiet' }, data.repoUrl ? data.pulls : say(state, 'noRemote')));
    else if (!pulls.length) box.append(el('p', { cls: 'quiet' }, say(state, 'noPulls')));
    else box.append(...pulls.map((pull) => pullCard(state, pull)));
  }
  const today = localDay(now);
  const merged = data.merged.filter((pull) => localDay(Date.parse(pull.mergedAt)) === today);
  if (merged.length && state.ui.mergedCleared !== today) {
    box.append(foldHead(state, 'mergedToday', merged.map(() => 'merged'), el('button', { cls: 'act', 'data-clear-merged': '1', title: say(state, 'hideTillTomorrow') }, say(state, 'clear'))));
    if (!state.ui.fold.mergedToday) box.append(...merged.map((pull) => el('div', { cls: 'mrow' }, icon('merge', true), el('span', { cls: 'num' }, `#${pull.number}`), pull.title)));
  }
  return box;
}

/** The bar at the bottom: each vendor with its agents, and where the board runs. */
export function renderBar(state: PageState, data: PageData): HTMLElement[] {
  const vendors = new Map<string, { color: string; count: number }>();
  for (const agent of data.agents) {
    if (agent.dot === 'done') continue;
    const seen = vendors.get(agent.vendor.name) ?? { color: agent.vendor.color, count: 0 };
    seen.count += 1;
    vendors.set(agent.vendor.name, seen);
  }
  const parts: HTMLElement[] = [el('span', {}, icon('shield', true), say(state, 'oneRuleSet', { n: vendors.size }))];
  for (const [name, { color, count }] of vendors) {
    const mark = el('span', { cls: 'vm' });
    mark.style.background = color;
    parts.push(el('span', {}, mark, say(state, 'vendorAgents', { name, n: count })));
  }
  parts.push(el('span', { cls: 'sp' }), el('span', {}, icon('lock', true), say(state, 'local')));
  return parts;
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
  menu.replaceChildren(...Object.entries(state.langNames).map(([tag, name]) => el('button', { cls: 'mi', role: 'menuitemradio', 'data-lang': tag, 'aria-checked': String(tag === state.ui.lang), lang: tag }, el('span', { cls: 'grow' }, name), tag === state.ui.lang ? icon('check', true) : null)));
  const github = byId('github');
  github.hidden = !/^https:\/\//.test(state.data?.repoUrl ?? '');
  if (!github.hidden) github.setAttribute('href', state.data?.repoUrl ?? '');
  for (const [id, key] of [['github', 'github'], ['theme', 'theme']]) {
    byId(id).setAttribute('aria-label', say(state, key));
    byId(id).setAttribute('title', say(state, key));
  }
  byId('theme').replaceChildren(icon(isDark ? 'sun' : 'moon'));
  for (const area of ['pinned', 'agents', 'center', 'right']) byId(area).setAttribute('aria-label', say(state, `area.${area}`));
}

/** Draw the whole page from the state. */
export function render(state: PageState): void {
  const data = state.data;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  renderTop(state);
  if (!data) return;
  if (!data.agents.some((agent) => agent.key === state.ui.current)) state.ui.current = data.agents.find((agent) => agent.role === 'lead')?.key ?? '';
  const [pinned, agents] = renderSide(state, data);
  byId('pinned').replaceChildren(pinned);
  byId('agents').replaceChildren(agents);
  byId('center').replaceChildren(renderCenter(state, data));
  byId('right').replaceChildren(renderRight(state, data, Date.now()));
  byId('bar').replaceChildren(...renderBar(state, data));
  byId('repo').textContent = data.repo.split('/').pop() ?? data.repo;
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
  const target = (event.target as Element).closest('[data-fold],[data-clear],[data-clear-all],[data-show-cleared],[data-restore],[data-group],[data-clear-merged],[data-undo],[data-pick],[data-lang],#lang,#theme');
  const ui = state.ui;
  if (state.isMenuOpen && target?.id !== 'lang' && !target?.hasAttribute('data-lang')) {
    state.isMenuOpen = false;
    renderTop(state);
  }
  if (!target) return;
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
    const ids = state.data.agents.filter((agent) => agent.dot === 'done' && agent.role !== 'lead').map(clearedId).filter((id) => !ui.cleared.includes(id));
    ui.cleared.push(...ids);
    showToast(state, 'clearedMany', ids, false);
  } else if (ask('data-fold')) ui.fold[ask('data-fold') as string] = !ui.fold[ask('data-fold') as string];
  else if (ask('data-show-cleared')) ui.showCleared = !ui.showCleared;
  else if (ask('data-restore')) ui.cleared = ui.cleared.filter((id) => id !== ask('data-restore'));
  else if (ask('data-group')) ui.open[ask('data-group') as string] = !ui.open[ask('data-group') as string];
  else if (ask('data-clear-merged')) {
    ui.mergedCleared = localDay(Date.now());
    showToast(state, 'mergedHidden', [], true);
  } else if (ask('data-undo') && state.toast) {
    const undone = state.toast;
    ui.cleared = ui.cleared.filter((id) => !undone.cleared.includes(id));
    if (undone.merged) ui.mergedCleared = '';
    state.toast = null;
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

/** The language menu's keys: arrows move, Escape closes and goes back to the button. */
export function onMenuKey(state: PageState, event: KeyboardEvent): void {
  if (!state.isMenuOpen) return;
  const items = [...document.querySelectorAll('#lang-menu [data-lang]')] as HTMLElement[];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape' || event.key === 'Tab') {
    state.isMenuOpen = false;
    renderTop(state);
    if (event.key === 'Escape') document.getElementById('lang')?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
}

/** Read /data, then draw. The pill says how fresh the data is. */
export function loadData(state: PageState): void {
  fetch(`data?t=${encodeURIComponent(state.token)}`, { cache: 'no-store' })
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
export const PAGE_FUNCTIONS = [el, icon, say, pickLang, ageOf, groupFeed, localDay, clearedId, roleGroup, summaryOf, loadUi, saveUi, vendorChip, refChip, foldHead, agentRow, needRow, renderSide, feedEvent, renderCenter, pullCard, renderRight, renderBar, renderTop, render, showToast, onClick, onMenuKey, loadData, startPage];
