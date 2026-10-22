/// <reference lib="dom" />
// The board page's script (#603). Each function here runs in the browser: page.ts puts
// their source into the page, so they use nothing but each other, their arguments and the
// browser. Tests call the plain ones directly. Agents write the status files, so every
// word goes in as text: nothing here parses HTML.

import type { BoardIssue, BoardLimits, BoardRun, BoardWaiting } from '../controls.ts';
import type { FeedEvent } from '../feed/steps.ts';
import type { AgentView, BoardData, NeedView, PullView } from '../view.ts';
import { followStream, renderStream, type StreamView } from './stream.ts';

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

function vendorChip(agent: AgentView): HTMLElement {
  const mark = el('span', { class: 'vm' });
  mark.style.background = agent.vendor.color;
  return el('span', { class: 'chip' }, mark, agent.vendor.name);
}

function refChip(agent: AgentView): HTMLElement | null {
  if (!agent.ref) return null;
  return el('span', { class: 'ref' }, icon(agent.ref.kind === 'pr' ? 'pr' : 'issue', true), `${agent.ref.kind === 'pr' ? 'PR' : 'Issue'} #${agent.ref.number}`);
}

/** A fold header: a button with the chevron, name, count and, when folded, what it hides; then an optional action beside it. */
function foldHead(state: PageState, key: string, dots: string[], extra: HTMLElement | null = null): HTMLElement {
  const isOpen = !state.ui.fold[key];
  return el('div', { class: 'sh' },
    el('button', { class: `f${isOpen ? ' open' : ''}`, 'data-fold': key, 'aria-expanded': String(isOpen) }, icon('chev', true), say(state, key), el('span', { class: 'n' }, String(dots.length)), isOpen ? null : el('span', { class: 'sum' }, summaryOf(state, dots))),
    extra);
}

/** One agent in the left column. A finished one gets a clear button beside it. */
function agentRow(state: PageState, agent: AgentView): HTMLElement {
  const isDone = agent.dot === 'done';
  const row = el('button', { class: `row${isDone ? ' done-row' : ''}${agent.role === 'lead' ? ' lead-row' : ''}`, 'data-pick': agent.key, 'aria-current': String(agent.key === state.ui.current) },
    el('span', { class: 'r1' }, el('span', { class: `dot ${agent.dot}`, title: say(state, `dot.${agent.dot}`) }), el('span', { class: 'ttl' }, agent.title || agent.name), el('span', { class: 'age' }, ageOf(state, agent, Date.now()))),
    el('span', { class: 'r2' }, vendorChip(agent), el('span', { class: 'who' }, agent.role === 'lead' ? say(state, 'yourManager') : agent.name), refChip(agent)),
    agent.doing ? el('span', { class: 'r3' }, el('span', {}, agent.doing)) : null);
  const clear = isDone ? el('button', { class: 'x', 'data-clear': clearedId(agent), title: say(state, 'clearOne'), 'aria-label': say(state, 'clearOne') }, icon('x', true)) : null;
  return el('div', { class: 'item' }, row, clear);
}

function needRow(state: PageState, need: NeedView): HTMLElement {
  const pull = typeof state.data?.pulls === 'string' ? undefined : state.data?.pulls.find((each) => each.number === need.pull);
  const agent = state.data?.agents.find((each) => each.key === need.agentKey);
  const title = need.kind === 'approve' ? say(state, 'approveTitle', { n: need.pull }) : say(state, 'waitingFor', { name: agent?.name ?? '' });
  const why = need.kind === 'approve' ? say(state, 'approveWhy', { title: pull?.title ?? '' }) : agent?.doing || agent?.task || say(state, 'noReason');
  const body = [el('span', { class: 'r1' }, el('span', { class: 'dot waiting' }), el('span', { class: 'ttl' }, title)), el('span', { class: 'r3 wrap' }, why)];
  if (need.kind === 'approve' && pull && /^https?:\/\//i.test(pull.url)) return el('a', { class: 'row need-row', href: pull.url, target: '_blank', rel: 'noopener noreferrer' }, ...body);
  return el('button', { class: 'row need-row', 'data-pick': need.agentKey }, ...body);
}

/** The left column: the lead and what needs you (never folded), then the agents by role, then the finished ones. */
export function renderSide(state: PageState, data: PageData): [HTMLElement, HTMLElement] {
  const lead = data.agents.find((agent) => agent.role === 'lead');
  const pinned = el('div', { class: 'pinned' }, el('h2', { class: 'sh lead-h' }, icon('msg', true), say(state, 'lead')));
  pinned.append(lead ? agentRow(state, lead) : el('div', { class: 'row lead-row still' }, el('span', { class: 'r1' }, el('span', { class: 'dot idle' }), el('span', { class: 'ttl' }, say(state, 'noLead'))), el('span', { class: 'r3 wrap' }, say(state, 'noLeadHow', { file: state.agentFile }))));
  pinned.append(el('h2', { class: 'sh need', title: say(state, 'needsYouHint') }, icon('bell', true), say(state, 'needsYou'), el('span', { class: 'n' }, String(data.needs.length))));
  pinned.append(...(data.needs.length ? data.needs.map((need) => needRow(state, need)) : [el('p', { class: 'quiet' }, say(state, 'nothingNeeds'))]));
  const list = el('div', { class: 'agents' });
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
    list.append(foldHead(state, 'group.finished', finished.map((agent) => agent.dot), el('button', { class: 'act', 'data-clear-all': '1', title: say(state, 'clearAllHint') }, say(state, 'clearAll'))));
    if (!state.ui.fold['group.finished']) list.append(...finished.map((agent) => agentRow(state, agent)));
  }
  const hidden = others.filter((agent) => cleared.has(clearedId(agent)));
  if (hidden.length) {
    list.append(el('div', { class: 'arch' }, icon('archive', true), say(state, 'clearedCount', { n: hidden.length }), el('button', { class: 'act', 'data-show-cleared': '1', 'aria-expanded': String(state.ui.showCleared) }, say(state, state.ui.showCleared ? 'hide' : 'show'))));
    if (state.ui.showCleared) {
      list.append(...hidden.map((agent) => el('div', { class: 'row done-row still' },
        el('span', { class: 'r1' }, el('span', { class: 'dot done' }), el('span', { class: 'ttl' }, agent.title || agent.name), el('span', { class: 'age' }, ageOf(state, agent, Date.now()))),
        el('span', { class: 'r2' }, vendorChip(agent), el('span', { class: 'who' }, agent.name), el('button', { class: 'act', 'data-restore': clearedId(agent) }, say(state, 'putBack'))))));
    }
  }
  if (!others.length) list.append(el('p', { class: 'quiet' }, say(state, 'noAgents', { file: state.agentFile })));
  return [pinned, list];
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
  const agent = data.agents.find((each) => each.key === state.ui.current) ?? data.agents.find((each) => each.role === 'lead');
  if (!agent) return el('div', { class: 'blank' }, el('h1', {}, say(state, 'emptyTitle')), el('p', {}, say(state, 'emptyBody', { file: state.agentFile })));
  const isLead = agent.role === 'lead';
  const isCleared = state.ui.cleared.includes(clearedId(agent));
  const role = agent.role ? ` · ${say(state, `role.${agent.role}`)}` : '';
  const head = el('div', { class: 'ch' },
    el('div', { class: 'grow' }, el('h1', {}, agent.title || agent.name),
      el('div', { class: 'sub' }, vendorChip(agent), el('span', {}, isLead ? say(state, 'yourManager') : `${agent.name}${role}`), agent.branch ? el('span', { class: 'mono' }, icon('branch', true), agent.branch) : null)),
    agent.model ? el('span', { class: 'model', title: say(state, 'modelEffort') }, el('b', {}, agent.model), agent.effort ? `· ${agent.effort}` : '') : null,
    refChip(agent),
    agent.dot === 'done' && !isCleared ? el('button', { class: 'hbtn', 'data-clear': clearedId(agent), title: say(state, 'keptHint') }, icon('archive', true), say(state, 'clearFromBoard')) : null);
  const foot = agent.dot === 'done'
    ? el('div', { class: 'ro' }, icon('done', true), say(state, 'finishedNote'))
    : el('div', { class: 'ro' }, icon('lock', true), say(state, isLead ? 'leadNote' : 'otherNote'));
  // The agent's own session when its log is found (#694); else the steps the board saw.
  const stream = renderStream(state, agent);
  if (stream) {
    const ask = agent.dot === 'waiting' ? el('div', { class: 'ask' }, el('div', { class: 'ah' }, icon('shield'), el('h2', {}, say(state, 'waitingFor', { name: agent.name }))), el('p', {}, agent.doing || say(state, 'noReason')), el('p', { class: 'quiet' }, say(state, 'answerThere'))) : null;
    return el('section', { class: 'center-in' }, head, stream, ask, foot);
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
  return el('section', { class: 'center-in' }, head, feed, foot);
}

function pullCard(state: PageState, pull: PullView): HTMLElement {
  const steps = el('div', { class: 'steps' }, ...pull.steps.map((mark, index) => el('i', { class: mark, title: say(state, `step.${index}`) })));
  const title = el('span', { class: 'nm' }, el('span', { class: 'num' }, `#${pull.number}`), ` ${pull.title}`);
  return el('div', { class: 'pr' },
    el('div', { class: 'h' }, el('span', { class: 'open-i' }, icon('pr')), /^https?:\/\//i.test(pull.url) ? el('a', { href: pull.url, target: '_blank', rel: 'noopener noreferrer', class: 'grow' }, title) : el('div', { class: 'grow' }, title), pull.tier ? el('span', { class: `tier t${pull.tier}` }, say(state, 'tier', { tier: pull.tier })) : null),
    steps, el('div', { class: 'sl' }, el('span', { class: pull.tone }, say(state, `pull.${pull.status}`)), el('span', { class: 'mut' }, pull.branch)));
}

/** One waiting row: what waits, who waits, how long, why, and where to act. Text from agents shows as text; the link goes only to an http(s) address. */
function waitingRow(state: PageState, row: BoardWaiting): HTMLElement {
  const kinds: Record<string, string> = { approve: 'waitApprove', guard: 'waitGuard', question: 'waitQuestion' };
  const head = [say(state, kinds[row.kind] ?? 'waitQuestion'), row.agent, row.role ? `[${say(state, `role.${row.role}`)}]` : '', row.wait].filter((part) => part !== '').join(' · ');
  const body = [el('p', {}, head), el('p', {}, row.why)];
  if (/^https?:\/\//i.test(row.link)) return el('a', { class: 'pr', href: row.link, target: '_blank', rel: 'noopener noreferrer' }, ...body, el('p', {}, say(state, 'actHere')));
  return el('div', { class: 'pr' }, ...body);
}

/** The waiting list at the top of the right column. */
export function renderWaiting(state: PageState, waiting: BoardWaiting[]): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh need', title: say(state, 'needsYouHint') }, icon('bell'), say(state, 'needsYou'), el('span', { class: 'n' }, String(waiting.length))));
  if (!waiting.length) box.append(el('p', { class: 'quiet' }, say(state, 'nothingNeeds')));
  else box.append(...waiting.map((row) => waitingRow(state, row)));
  return box;
}

/** One labelled field of the start and limits forms. */
function field(label: string, input: HTMLElement): HTMLElement {
  return el('div', { class: 'fld' }, el('label', {}, label, input));
}

/** The form that starts an agent: the issue from the open list, the vendor, and the model. */
export function renderStart(state: PageState, issues: BoardIssue[] | string): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('term'), say(state, 'startAgent')));
  const rows = typeof issues === 'string' ? [] : issues;
  const issue = el('input', { id: 'start-issue', name: 'issue', inputmode: 'numeric', ...(rows.length ? { list: 'start-issues' } : {}) });
  const vendor = el('select', { id: 'start-vendor', name: 'vendor' }, ...['claude-code', 'codex', 'muse', 'grok', 'antigravity', 'deepseek-harness'].map((name) => el('option', { value: name }, name)));
  const model = el('input', { id: 'start-model', name: 'model', placeholder: say(state, 'modelName') });
  box.append(field(say(state, 'issueNumber'), issue));
  if (rows.length) box.append(el('datalist', { id: 'start-issues' }, ...rows.map((row) => el('option', { value: String(row.number) }, `#${row.number} ${row.title}`))));
  else if (typeof issues === 'string') box.append(el('p', { class: 'quiet' }, issues));
  box.append(field(say(state, 'vendorName'), vendor));
  box.append(field(say(state, 'modelName'), model));
  box.append(el('p', {}, el('button', { class: 'hbtn', 'data-start': '1' }, say(state, 'startNow'))));
  box.append(el('p', { class: 'quiet', id: 'start-note' }, ''));
  return box;
}

/** The form that sets the limits: how many agents run at once, and how many of one model. */
export function renderLimits(state: PageState, limits: BoardLimits): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('lock'), say(state, 'limitsTitle')));
  const caps = Object.keys(limits.byModel).map((name) => `${name}: ${limits.byModel[name]}`).join(', ');
  box.append(el('p', { class: 'quiet' }, say(state, 'limitsNow', { max: limits.maxAgents }) + (caps ? ` · ${say(state, 'limitsModels', { models: caps })}` : '')));
  box.append(field(say(state, 'maxAgents'), el('input', { id: 'limits-max', name: 'maxAgents', inputmode: 'numeric', value: String(limits.maxAgents) })));
  box.append(field(say(state, 'modelsPaired'), el('input', { id: 'limits-models', name: 'models', value: caps })));
  box.append(el('p', {}, el('button', { class: 'hbtn', 'data-limits': '1' }, say(state, 'saveNow'))));
  box.append(el('p', { class: 'quiet', id: 'limits-note' }, ''));
  return box;
}

/** One agent the board started, with a stop button while it runs. */
function runCard(state: PageState, run: BoardRun): HTMLElement {
  const status = run.status === 'running' ? say(state, 'runRunning') : say(state, 'runStopped');
  return el('div', { class: 'pr' },
    el('p', {}, `${run.name} · ${run.vendor} · ${run.model} · issue ${run.issue} · ${status}`),
    run.worktree ? el('p', { class: 'mut' }, run.worktree) : null,
    run.status === 'running' ? el('p', {}, el('button', { class: 'hbtn', 'data-stop': run.name }, icon('x', true), say(state, 'stopNow'))) : null);
}

/** The agents the board started. */
export function renderRuns(state: PageState, runs: BoardRun[]): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('term'), say(state, 'startedHere'), el('span', { class: 'n' }, String(runs.length))));
  if (!runs.length) box.append(el('p', { class: 'quiet' }, say(state, 'noStarted')));
  else box.append(...runs.map((run) => runCard(state, run)));
  box.append(el('p', { class: 'quiet', id: 'runs-note' }, ''));
  return box;
}

/** The latest output of the agents the board started. */
export function renderOutput(state: PageState, runs: BoardRun[]): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('msg'), say(state, 'latestOutput')));
  if (!runs.length) box.append(el('p', { class: 'quiet' }, say(state, 'noOutput')));
  else {
    for (const run of runs) {
      box.append(el('div', { class: 'pr' }, el('p', {}, run.name), el('pre', { class: 'out' }, run.output.length ? run.output.join('\n') : say(state, 'noOutput'))));
    }
  }
  return box;
}

/**
 * A note on the GitHub lists, or '' (#688): "reading GitHub" before the first read
 * finishes, and when they were read after a read failed.
 */
export function githubNote(state: PageState, data: PageData, now: number): string {
  const github = data.github;
  if (!github || !data.repoUrl) return '';
  if (!github.readAt && !github.failed) return say(state, 'readingGitHub');
  if (!github.readAt || !github.failed) return '';
  return say(state, 'githubOld', { n: Math.max(1, Math.floor((now - Date.parse(github.readAt)) / 60000)) });
}

/** The right side: the waiting list, open pull requests with their steps, what merged today, and the board's own controls. */
export function renderRight(state: PageState, data: PageData, now: number): HTMLElement {
  const box = el('div', {});
  box.append(renderWaiting(state, data.waiting));
  const pulls = typeof data.pulls === 'string' ? [] : data.pulls;
  const note = githubNote(state, data, now);
  // Before the first read, the lists say only that GitHub is being read, in the page's language.
  const isFirstRead = note !== '' && !data.github?.readAt && !data.github?.failed;
  box.append(foldHead(state, 'pulls', pulls.map((pull) => (pull.tone === 'fail' ? 'failing' : pull.tone === 'ok' ? 'ready' : 'moving'))));
  if (!state.ui.fold.pulls) {
    if (note && !isFirstRead) box.append(el('p', { class: 'quiet' }, note));
    if (isFirstRead) box.append(el('p', { class: 'quiet', role: 'status' }, note));
    else if (typeof data.pulls === 'string') box.append(el('p', { class: 'quiet' }, data.repoUrl ? data.pulls : say(state, 'noRemote')));
    else if (!pulls.length) box.append(el('p', { class: 'quiet' }, say(state, 'noPulls')));
    else box.append(...pulls.map((pull) => pullCard(state, pull)));
  }
  const today = localDay(now);
  const merged = data.merged.filter((pull) => localDay(Date.parse(pull.mergedAt)) === today);
  if (merged.length && state.ui.mergedCleared !== today) {
    box.append(foldHead(state, 'mergedToday', merged.map(() => 'merged'), el('button', { class: 'act', 'data-clear-merged': '1', title: say(state, 'hideTillTomorrow') }, say(state, 'clear'))));
    if (!state.ui.fold.mergedToday) box.append(...merged.map((pull) => el('div', { class: 'mrow' }, icon('merge', true), el('span', { class: 'num' }, `#${pull.number}`), pull.title)));
  }
  box.append(renderStart(state, isFirstRead ? note : data.issues));
  box.append(renderLimits(state, data.limits));
  box.append(renderRuns(state, data.runs));
  box.append(renderOutput(state, data.runs));
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
    const mark = el('span', { class: 'vm' });
    mark.style.background = color;
    parts.push(el('span', {}, mark, say(state, 'vendorAgents', { name, n: count })));
  }
  parts.push(el('span', { class: 'sp' }), el('span', {}, icon('lock', true), say(state, 'local')));
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
  followStream(state, state.ui.current);
  // The stream's list is kept between draws; a draw puts it back where the owner left it, or at the end.
  const list = state.stream?.node;
  const top = list ? list.scrollTop : 0;
  const isAtEnd = !list || !list.isConnected || list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
  byId('center').replaceChildren(renderCenter(state, data));
  if (list?.isConnected) list.scrollTop = isAtEnd ? list.scrollHeight : top;
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
  const target = (event.target as Element).closest('[data-fold],[data-clear],[data-clear-all],[data-show-cleared],[data-restore],[data-group],[data-clear-merged],[data-undo],[data-pick],[data-lang],[data-start],[data-limits],[data-stop],#lang,#theme');
  const fieldValue = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
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
    const from = at < 0 && event.key === 'ArrowUp' ? 0 : at;
    items[(from + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
}

/**
 * Post a controls form to the board, then read again. The fetch carries the page's
 * Origin, and the link's token rides in the query. The note says what the board
 * answered, as text; only a pass reads again.
 */
export function postForm(state: PageState, path: string, fields: [string, string][], noteId: string, doneKey: string): void {
  const note = document.getElementById(noteId);
  const body = fields.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  fetch(`${path}?t=${encodeURIComponent(state.token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
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
export const PAGE_FUNCTIONS = [el, icon, say, pickLang, ageOf, groupFeed, localDay, clearedId, roleGroup, summaryOf, loadUi, saveUi, vendorChip, refChip, foldHead, agentRow, needRow, renderSide, feedEvent, renderCenter, pullCard, waitingRow, renderWaiting, field, renderStart, renderLimits, runCard, renderRuns, renderOutput, githubNote, renderRight, renderBar, renderTop, render, showToast, onClick, onMenuKey, postForm, loadData, startPage];
