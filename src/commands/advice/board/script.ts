/// <reference lib="dom" />
// The board page's script (#603). Each function here runs in the browser: page.ts puts
// their source into the page, so they use nothing but each other, their arguments and the
// browser. Tests call the plain ones directly. Agents write the status files, so every
// word goes in as text: nothing here parses HTML.

import type { FeedEvent } from './feed.ts';
import type { AgentView, BoardData, NeedView, PullView } from './view.ts';

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
}

/** Everything the page holds while it runs. */
export interface PageState {
  token: string;
  refreshMs: number;
  agentFile: string;
  data: PageData | null;
  ui: PageUi;
  toast: { text: string; cleared: string[]; merged: boolean } | null;
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

/** `1 agent`, `2 agents`. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
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

/** The group an agent's role goes in, by its plural name. */
export function roleGroup(role: string): string {
  if (role === 'engineer') return 'Engineers';
  if (role === 'reviewer') return 'Reviewers';
  if (role === 'verifier') return 'Checkers';
  if (role === 'helper') return 'Helpers';
  return 'Other agents';
}

/** "2 working · 1 waiting": what a folded group holds. */
export function summaryOf(dots: string[]): string {
  const counts: Record<string, number> = {};
  for (const dot of dots) counts[dot] = (counts[dot] ?? 0) + 1;
  return Object.entries(counts).map(([dot, count]) => `${count} ${dot}`).join(' · ');
}

/** The UI the owner left last time, or the defaults. A phone starts with the agent groups folded. */
export function loadUi(isPhone: boolean): PageUi {
  const fold: Record<string, boolean> = isPhone ? { Engineers: true, Reviewers: true, Checkers: true, Helpers: true, 'Other agents': true, Finished: true } : { Finished: true };
  const ui: PageUi = { current: '', fold, open: {}, cleared: [], showCleared: false, mergedCleared: '', theme: '' };
  try {
    const saved = JSON.parse(localStorage.getItem('yokoten-board') ?? 'null');
    if (saved && typeof saved === 'object') {
      if (saved.fold && typeof saved.fold === 'object') Object.assign(ui.fold, saved.fold);
      if (Array.isArray(saved.cleared)) ui.cleared = saved.cleared.filter((id: unknown) => typeof id === 'string');
      if (typeof saved.mergedCleared === 'string') ui.mergedCleared = saved.mergedCleared;
      if (saved.theme === 'light' || saved.theme === 'dark') ui.theme = saved.theme;
    }
  } catch {
    // A private window or blocked storage: the defaults stand.
  }
  return ui;
}

export function saveUi(ui: PageUi): void {
  try {
    localStorage.setItem('yokoten-board', JSON.stringify({ fold: ui.fold, cleared: ui.cleared, mergedCleared: ui.mergedCleared, theme: ui.theme }));
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

/** A fold header: chevron, name, count, and a summary of what it hides when folded. */
function foldHead(state: PageState, key: string, label: string, dots: string[], extra: HTMLElement | null = null): HTMLElement {
  const isOpen = !state.ui.fold[key];
  return el('div', { cls: `sh f${isOpen ? ' open' : ''}`, 'data-fold': key, role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) },
    icon('chev', true), label, el('span', { cls: 'n' }, String(dots.length)), isOpen ? null : el('span', { cls: 'sum' }, summaryOf(dots)), extra);
}

/** One agent in the left column. A finished one gets a clear button. */
function agentRow(state: PageState, agent: AgentView): HTMLElement {
  const isDone = agent.dot === 'done';
  const row = el('button', { cls: `row${isDone ? ' done-row' : ''}${agent.role === 'lead' ? ' lead-row' : ''}`, 'data-pick': agent.key, 'aria-current': String(agent.key === state.ui.current) },
    el('div', { cls: 'r1' }, el('span', { cls: `dot ${agent.dot}`, title: agent.dot }), el('span', { cls: 'ttl' }, agent.title || agent.name), el('span', { cls: 'age' }, agent.age)),
    el('div', { cls: 'r2' }, vendorChip(agent), el('span', { cls: 'who' }, agent.role === 'lead' ? 'Your project manager' : agent.name), refChip(agent)),
    agent.doing ? el('div', { cls: 'r3' }, el('span', {}, agent.doing)) : null);
  if (isDone) row.append(el('span', { cls: 'x', 'data-clear': clearedId(agent), title: 'Clear from the board. The log and the branch are kept.', role: 'button' }, icon('x', true)));
  return row;
}

function needRow(state: PageState, need: NeedView): HTMLElement {
  const pull = typeof state.data?.pulls === 'string' ? undefined : state.data?.pulls.find((each) => each.number === need.pull);
  const body = [el('div', { cls: 'r1' }, el('span', { cls: 'dot waiting' }), el('span', { cls: 'ttl' }, need.title)), el('div', { cls: 'r3 wrap' }, need.why)];
  if (need.kind === 'approve' && pull?.url && /^https?:\/\//i.test(pull.url)) return el('a', { cls: 'row need-row', href: pull.url, target: '_blank', rel: 'noopener noreferrer' }, ...body);
  return el('button', { cls: 'row need-row', 'data-pick': need.agentKey }, ...body);
}

/** The left column: the lead and what needs you (never folded), then the agents by role, then the finished ones. */
export function renderSide(state: PageState, data: PageData): [HTMLElement, HTMLElement] {
  const lead = data.agents.find((agent) => agent.role === 'lead');
  const pinned = el('div', { cls: 'pinned' }, el('div', { cls: 'sh lead-h' }, icon('msg', true), 'Lead'));
  pinned.append(lead ? agentRow(state, lead) : el('div', { cls: 'row lead-row empty' }, el('div', { cls: 'r1' }, el('span', { cls: 'dot idle' }), el('span', { cls: 'ttl' }, 'No lead on the board yet')), el('div', { cls: 'r3 wrap' }, `The lead joins by writing ${state.agentFile} with "role": "lead".`)));
  pinned.append(el('div', { cls: 'sh need', title: 'This list never folds, so nothing waiting on you is hidden' }, icon('bell', true), 'Needs you', el('span', { cls: 'n' }, String(data.needs.length))));
  pinned.append(...(data.needs.length ? data.needs.map((need) => needRow(state, need)) : [el('p', { cls: 'quiet' }, 'Nothing needs you right now.')]));
  const list = el('div', { cls: 'agents' });
  const cleared = new Set(state.ui.cleared);
  const others = data.agents.filter((agent) => agent.role !== 'lead');
  const live = others.filter((agent) => agent.dot !== 'done');
  for (const group of ['Engineers', 'Reviewers', 'Checkers', 'Helpers', 'Other agents']) {
    const members = live.filter((agent) => roleGroup(agent.role) === group);
    if (!members.length) continue;
    list.append(foldHead(state, group, group, members.map((agent) => agent.dot)));
    if (!state.ui.fold[group]) list.append(...members.map((agent) => agentRow(state, agent)));
  }
  const finished = others.filter((agent) => agent.dot === 'done' && !cleared.has(clearedId(agent)));
  if (finished.length) {
    list.append(foldHead(state, 'Finished', 'Finished', finished.map((agent) => agent.dot), el('span', { cls: 'act', 'data-clear-all': '1', role: 'button', title: 'Clear every finished agent. Logs and branches are kept.' }, 'Clear all')));
    if (!state.ui.fold.Finished) list.append(...finished.map((agent) => agentRow(state, agent)));
  }
  const hidden = others.filter((agent) => cleared.has(clearedId(agent)));
  if (hidden.length) {
    list.append(el('div', { cls: 'arch' }, icon('archive', true), `${plural(hidden.length, 'cleared agent')} · logs kept`, el('button', { 'data-show-cleared': '1' }, state.ui.showCleared ? 'Hide' : 'Show')));
    if (state.ui.showCleared) {
      list.append(...hidden.map((agent) => el('div', { cls: 'row done-row still' },
        el('div', { cls: 'r1' }, el('span', { cls: 'dot done' }), el('span', { cls: 'ttl' }, agent.title || agent.name), el('span', { cls: 'age' }, agent.age)),
        el('div', { cls: 'r2' }, vendorChip(agent), el('span', { cls: 'who' }, agent.name), el('button', { cls: 'act', 'data-restore': clearedId(agent) }, 'Put back')))));
    }
  }
  if (!others.length) list.append(el('p', { cls: 'quiet' }, `No agents yet. One joins by writing ${state.agentFile} in its worktree.`));
  return [pinned, list];
}

/** One step in the feed. */
function feedEvent(event: FeedEvent): HTMLElement {
  const look: Record<string, string> = { step: 'term', pass: 'check', wait: 'bell', fail: 'shield', done: 'done' };
  const time = new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return el('div', { cls: `ev ${event.kind}` }, el('span', { cls: 'ic' }, icon(look[event.kind] ?? 'term')), el('div', { cls: 't' }, el('p', {}, event.text)), el('span', { cls: 'tm' }, time));
}

/** The middle: the picked agent, its feed, and what the owner can do. */
export function renderCenter(state: PageState, data: PageData): HTMLElement {
  const agent = data.agents.find((each) => each.key === state.ui.current) ?? data.agents.find((each) => each.role === 'lead');
  if (!agent) return el('div', { cls: 'blank' }, el('h1', {}, 'Your team shows here'), el('p', {}, `Each agent writes ${state.agentFile} in its worktree. The lead writes one with "role": "lead".`));
  const isLead = agent.role === 'lead';
  const isCleared = state.ui.cleared.includes(clearedId(agent));
  const head = el('div', { cls: 'ch' },
    el('div', { cls: 'grow' }, el('h1', {}, agent.title || agent.name),
      el('div', { cls: 'sub' }, vendorChip(agent), el('span', {}, isLead ? 'Your project manager' : `${agent.name}${agent.role ? ` · ${agent.role}` : ''}`), agent.branch ? el('span', { cls: 'mono' }, icon('branch', true), agent.branch) : null)),
    agent.model ? el('span', { cls: 'model', title: 'Model and effort' }, el('b', {}, agent.model), agent.effort ? `· ${agent.effort}` : '') : null,
    refChip(agent),
    agent.dot === 'done' && !isCleared ? el('button', { cls: 'hbtn', 'data-clear': clearedId(agent), title: 'The log and the branch are kept' }, icon('archive', true), 'Clear from board') : null);
  const events = data.feeds[agent.key] ?? [];
  const feed = el('div', { cls: 'feed' }, el('div', { cls: 'day' }, 'Since the board started'));
  groupFeed(events).forEach((item, index) => {
    if (item.kind !== 'group') return void feed.append(feedEvent(item));
    const key = `${agent.key}#${index}`;
    const isOpen = !!state.ui.open[key];
    feed.append(el('button', { cls: `grp${isOpen ? ' open' : ''}`, 'data-group': key, 'aria-expanded': String(isOpen) }, icon('chev', true), el('span', {}, `${plural(item.items.length, 'routine step')}. Nothing needs you.`)));
    if (isOpen) feed.append(el('div', { cls: 'grp-body' }, ...item.items.map(feedEvent)));
  });
  if (!events.length) feed.append(el('p', { cls: 'quiet' }, agent.doing || 'Nothing reported yet.'));
  if (agent.dot === 'waiting') feed.append(el('div', { cls: 'ask' }, el('div', { cls: 'ah' }, icon('shield'), el('h3', {}, `${agent.name} is waiting for you`)), el('p', {}, agent.doing || 'It did not say why.'), el('p', { cls: 'quiet' }, 'Answer it in its own terminal for now.')));
  const foot = agent.dot === 'done'
    ? el('div', { cls: 'ro' }, icon('done', true), 'This agent has finished. Its log stays on disk after you clear it.')
    : el('div', { cls: 'ro' }, icon('lock', true), isLead ? 'Talk to the lead in its own terminal for now. Messaging from the board comes next.' : 'Started outside the board, so you can watch it here but not message it.');
  return el('section', { cls: 'center-in' }, head, feed, foot);
}

function pullCard(pull: PullView): HTMLElement {
  const names = ['Built', 'Checked', 'You', 'Merged'];
  const steps = el('div', { cls: 'steps' }, ...pull.steps.map((mark, index) => el('i', { cls: mark, title: names[index] })));
  const title = el('div', { cls: 'nm' }, el('span', { cls: 'num' }, `#${pull.number}`), ` ${pull.title}`);
  return el('div', { cls: 'pr' },
    el('div', { cls: 'h' }, el('span', { cls: 'open-i' }, icon('pr')), /^https?:\/\//i.test(pull.url) ? el('a', { href: pull.url, target: '_blank', rel: 'noopener noreferrer', cls: 'grow' }, title) : el('div', { cls: 'grow' }, title), pull.tier ? el('span', { cls: `tier t${pull.tier}` }, `TIER ${pull.tier}`) : null),
    steps, el('div', { cls: 'sl' }, el('span', { cls: pull.tone }, pull.label), el('span', { cls: 'mut' }, pull.branch)));
}

/** The right side: open pull requests with their steps, then what merged today. */
export function renderRight(state: PageState, data: PageData, now: number): HTMLElement {
  const box = el('div', {});
  const pulls = typeof data.pulls === 'string' ? [] : data.pulls;
  box.append(foldHead(state, 'Pulls', 'Pull requests', pulls.map((pull) => (pull.tone === 'fail' ? 'failing' : pull.tone === 'ok' ? 'ready' : 'moving'))));
  if (!state.ui.fold.Pulls) {
    if (typeof data.pulls === 'string') box.append(el('p', { cls: 'quiet' }, data.pulls));
    else if (!pulls.length) box.append(el('p', { cls: 'quiet' }, 'No open pull requests.'));
    else box.append(...pulls.map(pullCard));
  }
  const today = localDay(now);
  const merged = data.merged.filter((pull) => localDay(Date.parse(pull.mergedAt)) === today);
  if (merged.length && state.ui.mergedCleared !== today) {
    box.append(foldHead(state, 'Merged', 'Merged today', merged.map(() => 'merged'), el('span', { cls: 'act', 'data-clear-merged': '1', role: 'button', title: 'Hide until tomorrow' }, 'Clear')));
    if (!state.ui.fold.Merged) box.append(...merged.map((pull) => el('div', { cls: 'mrow' }, icon('merge', true), el('span', { cls: 'num' }, `#${pull.number}`), pull.title)));
  }
  return box;
}

/** The bar at the bottom: each vendor with its agents, and where the board runs. */
export function renderBar(data: PageData): HTMLElement[] {
  const vendors = new Map<string, { color: string; count: number }>();
  for (const agent of data.agents) {
    if (agent.dot === 'done') continue;
    const seen = vendors.get(agent.vendor.name) ?? { color: agent.vendor.color, count: 0 };
    seen.count += 1;
    vendors.set(agent.vendor.name, seen);
  }
  const parts: HTMLElement[] = [el('span', {}, icon('shield', true), `One rule set · ${plural(vendors.size, 'vendor')}`)];
  for (const [name, { color, count }] of vendors) {
    const mark = el('span', { cls: 'vm' });
    mark.style.background = color;
    parts.push(el('span', {}, mark, `${name} · ${plural(count, 'agent')}`));
  }
  parts.push(el('span', { cls: 'sp' }), el('span', {}, icon('lock', true), 'Runs on your computer. Nothing leaves it.'));
  return parts;
}

/** Draw the whole page from the state. */
export function render(state: PageState): void {
  const data = state.data;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  document.documentElement.setAttribute('data-theme', state.ui.theme);
  if (!data) return;
  if (!data.agents.some((agent) => agent.key === state.ui.current)) state.ui.current = data.agents.find((agent) => agent.role === 'lead')?.key ?? '';
  const [pinned, agents] = renderSide(state, data);
  byId('pinned').replaceChildren(pinned);
  byId('agents').replaceChildren(agents);
  byId('center').replaceChildren(renderCenter(state, data));
  byId('right').replaceChildren(renderRight(state, data, Date.now()));
  byId('bar').replaceChildren(...renderBar(data));
  byId('repo').textContent = data.repo.split('/').pop() ?? data.repo;
  const toast = byId('toast');
  toast.hidden = !state.toast;
  toast.replaceChildren(...(state.toast ? [el('span', {}, state.toast.text), el('button', { 'data-undo': '1' }, 'Undo')] : []));
}

/** Show the undo note for 8 seconds. */
export function showToast(state: PageState, text: string, cleared: string[], merged: boolean): void {
  state.toast = { text, cleared, merged };
  clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    state.toast = null;
    render(state);
  }, 8000);
}

/** One click anywhere: each control says what it does in a data- attribute. */
export function onClick(state: PageState, event: Event): void {
  const target = (event.target as Element).closest('[data-fold],[data-clear],[data-clear-all],[data-show-cleared],[data-restore],[data-group],[data-clear-merged],[data-undo],[data-pick],#theme');
  if (!target || !state.data) return;
  const ask = (name: string) => target.getAttribute(name);
  const ui = state.ui;
  if (target.id === 'theme') ui.theme = document.documentElement.getAttribute('data-theme') === 'dark' || (!ui.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark';
  else if (ask('data-clear')) {
    event.stopPropagation();
    ui.cleared.push(ask('data-clear') as string);
    showToast(state, 'Cleared from the board. Its log is kept.', [ask('data-clear') as string], false);
  } else if (ask('data-clear-all')) {
    const ids = state.data.agents.filter((agent) => agent.dot === 'done' && agent.role !== 'lead').map(clearedId).filter((id) => !ui.cleared.includes(id));
    ui.cleared.push(...ids);
    showToast(state, `Cleared ${plural(ids.length, 'finished agent')}. Logs are kept.`, ids, false);
  } else if (ask('data-fold')) ui.fold[ask('data-fold') as string] = !ui.fold[ask('data-fold') as string];
  else if (ask('data-show-cleared')) ui.showCleared = !ui.showCleared;
  else if (ask('data-restore')) ui.cleared = ui.cleared.filter((id) => id !== ask('data-restore'));
  else if (ask('data-group')) ui.open[ask('data-group') as string] = !ui.open[ask('data-group') as string];
  else if (ask('data-clear-merged')) {
    ui.mergedCleared = localDay(Date.now());
    showToast(state, 'Merged list cleared until tomorrow.', [], true);
  } else if (ask('data-undo') && state.toast) {
    const undone = state.toast;
    ui.cleared = ui.cleared.filter((id) => !undone.cleared.includes(id));
    if (undone.merged) ui.mergedCleared = '';
    state.toast = null;
  } else if (ask('data-pick')) {
    ui.current = ask('data-pick') as string;
    render(state);
    if (matchMedia('(max-width: 700px)').matches) document.getElementById('center')?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  saveUi(ui);
  render(state);
}

/** Read /data, then draw. The pill says how fresh the data is. */
export function loadData(state: PageState): void {
  const pill = document.getElementById('live') as HTMLElement;
  fetch(`data?t=${encodeURIComponent(state.token)}`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((data: PageData) => {
      state.data = data;
      state.readAt = Date.now();
      pill.className = 'pill';
      pill.lastChild!.textContent = 'Live';
      render(state);
    })
    .catch(() => {
      pill.className = 'pill off';
      pill.lastChild!.textContent = state.data ? 'Lost the board: is it still running?' : 'Waiting for data';
    });
}

/** Start the page: the saved UI, the clicks, the first read, then a read every refreshMs. */
export function startPage(state: PageState): void {
  state.ui = loadUi(matchMedia('(max-width: 700px)').matches);
  document.addEventListener('click', (event) => onClick(state, event));
  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && (event.target as Element).matches('[role=button]')) {
      event.preventDefault();
      onClick(state, event);
    }
  });
  render(state);
  loadData(state);
  setInterval(() => loadData(state), state.refreshMs);
}

/** The page's functions, in the order page.ts writes them. */
export const PAGE_FUNCTIONS = [el, icon, plural, groupFeed, localDay, clearedId, roleGroup, summaryOf, loadUi, saveUi, vendorChip, refChip, foldHead, agentRow, needRow, renderSide, feedEvent, renderCenter, pullCard, renderRight, renderBar, render, showToast, onClick, loadData, startPage];
