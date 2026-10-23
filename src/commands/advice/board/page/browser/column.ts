/// <reference lib="dom" />
// The left column and the Needs you bell (#603, #737, #701). Like script.ts, these
// functions run in the browser: page.ts puts their source into the page. The bell
// lists everything that needs the owner. The desk lists only the lead's decisions.

import type { AgentView, NeedView } from '../../view.ts';
import { isCheckoutLead, roleGroup } from '../groups.ts';
import { renderDesk } from './desk.ts';
import { ageOf, clearedId, el, icon, say, summaryOf, type PageData, type PageState } from './script.ts';

/** How old a Needs you row is. A day or more says so, in the page's language. */
export function ageOfNeed(state: PageState, at: string, now: number): string {
  const then = Date.parse(at);
  if (!at || Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes >= 1440) return say(state, 'olderThanADay');
  if (minutes < 1) return say(state, 'justNow');
  const format = new Intl.RelativeTimeFormat(state.ui.lang, { style: 'short' });
  return minutes < 60 ? format.format(-minutes, 'minute') : format.format(-Math.floor(minutes / 60), 'hour');
}

/** The id a row is remembered by, so a new one can pulse and a done one can leave. */
export function idOfNeed(need: NeedView): string {
  return `${need.kind}:${need.pull}:${need.issue ?? 0}:${need.agentKey}`;
}

/** Remember the rows. A new one, while the panel is closed, pulses the badge once. */
export function noteNewNeeds(state: PageState, needs: NeedView[]): void {
  const ids = needs.map(idOfNeed);
  const seen = state.seenNeedIds ?? [];
  const hasNew = state.hasSeenNeeds === true && state.isNeedsOpen !== true && ids.some((id) => !seen.includes(id));
  state.seenNeedIds = ids;
  state.hasSeenNeeds = true;
  if (hasNew) state.pulseNeeds = true;
}

/** An http(s) address, or '': a status file cannot hand the page a script link. */
function webLink(url: string): string {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
}

/** The title and the Act here address for one row, from the pull request, the issue, or the agent's link. */
function readNeedTarget(state: PageState, need: NeedView): { title: string; link: string } {
  const pulls = state.data?.pulls;
  const pull = need.pull && Array.isArray(pulls) ? pulls.find((each) => each.number === need.pull) : undefined;
  if (pull) return { title: pull.title, link: webLink(pull.url) };
  const issues = state.data?.issues;
  const issue = need.issue && Array.isArray(issues) ? issues.find((each) => each.number === need.issue) : undefined;
  if (issue) return { title: issue.title, link: webLink(issue.url) };
  const name = state.data?.agents.find((each) => each.key === need.agentKey)?.name;
  const waiting = name ? state.data?.waiting.find((row) => row.agent === name && webLink(row.link)) : undefined;
  return { title: '', link: waiting ? webLink(waiting.link) : '' };
}

/** One Needs you row: what it is, which pull request or issue, how old, and one Act here link. */
export function renderNeedItem(state: PageState, need: NeedView, now: number): HTMLElement {
  const target = readNeedTarget(state, need);
  const what = need.kind === 'approve' ? say(state, 'pull.approve') : (need.why || say(state, 'noReason'));
  const number = need.issue && !need.pull ? need.issue : need.pull;
  const which = number ? say(state, need.issue && !need.pull ? 'needIssue' : 'needPull', { n: number }) : '';
  const age = ageOfNeed(state, need.at ?? '', now);
  const line = [which, target.title].filter(Boolean).join(' ');
  const link = target.link ? el('a', { class: 'go', href: target.link, target: '_blank', rel: 'noopener noreferrer' }, say(state, 'actHere')) : null;
  return el('div', { class: 'need-item', role: 'listitem', tabindex: '0' }, el('span', { class: 'ttl' }, what), line ? el('span', { class: 'meta' }, line) : null, age ? el('span', { class: 'age' }, age) : null, link);
}

/**
 * Fill the header panel from the latest rows. A finished row is already gone from the data.
 * On a phone the lead column is hidden, so the same desk is drawn here too. Wide screens
 * hide that copy with CSS.
 */
export function fillNeeds(state: PageState, data: PageData): void {
  const menu = document.getElementById('needs-menu');
  if (!menu) return;
  menu.hidden = state.isNeedsOpen !== true;
  const rows = data.needs.length ? data.needs.map((need) => renderNeedItem(state, need, Date.now())) : [el('p', { class: 'quiet' }, say(state, 'nothingNeeds'))];
  const parts: HTMLElement[] = [el('div', { role: 'list' }, ...rows)];
  const lead = data.agents.find((agent) => isCheckoutLead(agent));
  const hasDesk = !!data.desk && (data.desk.now !== '' || data.desk.decisions.length > 0 || data.desk.reply !== '');
  if (lead || hasDesk) parts.push(el('div', { class: 'phone-desk' }, renderDesk(state, data, lead)));
  menu.replaceChildren(...parts);
}

export function vendorChip(agent: AgentView): HTMLElement {
  const mark = el('span', { class: agent.isLive ? 'vm live' : 'vm' });
  mark.style.background = agent.vendor.color;
  return el('span', { class: 'chip' }, mark, agent.vendor.name);
}

export function refChip(agent: AgentView): HTMLElement | null {
  if (!agent.ref) return null;
  return el('span', { class: 'ref' }, icon(agent.ref.kind === 'pr' ? 'pr' : 'issue', true), `${agent.ref.kind === 'pr' ? 'PR' : 'Issue'} #${agent.ref.number}`);
}

/** A fold header: a button with the chevron, name, count and, when folded, what it hides; then an optional action beside it. */
export function foldHead(state: PageState, key: string, dots: string[], extra: HTMLElement | null = null): HTMLElement {
  const isOpen = !state.ui.fold[key];
  return el('div', { class: 'sh' },
    el('button', { class: `f${isOpen ? ' open' : ''}`, 'data-fold': key, 'aria-expanded': String(isOpen) }, icon('chev', true), say(state, key), el('span', { class: 'n' }, String(dots.length)), isOpen ? null : el('span', { class: 'sum' }, summaryOf(state, dots))),
    extra);
}

/**
 * True when the left column lists this agent (#779). Live or waiting stays.
 * A finished agent, a stale desk, or one the owner cleared, does not.
 */
export function isOnBoard(agent: AgentView, cleared: readonly string[]): boolean {
  if (cleared.includes(clearedId(agent))) return false;
  if (agent.dot === 'done') return false;
  return agent.isLive === true || agent.dot === 'waiting';
}

/** One agent in the left column. A finished one gets a clear button beside it. */
function agentRow(state: PageState, agent: AgentView): HTMLElement {
  const isDone = agent.dot === 'done';
  const row = el('button', { class: `row${isDone ? ' done-row' : ''}${isCheckoutLead(agent) ? ' lead-row' : ''}`, 'data-pick': agent.key, 'aria-current': String(agent.key === state.ui.current) },
    el('span', { class: 'r1' }, el('span', { class: `dot ${agent.dot}`, title: say(state, `dot.${agent.dot}`) }), el('span', { class: 'ttl' }, agent.title || agent.name), el('span', { class: 'age' }, ageOf(state, agent, Date.now()))),
    el('span', { class: 'r2' }, vendorChip(agent), el('span', { class: 'who' }, agent.nickname || agent.name), refChip(agent)),
    agent.doing ? el('span', { class: 'r3' }, el('span', {}, agent.doing)) : null);
  const clear = isDone ? el('button', { class: 'x', 'data-clear': clearedId(agent), title: say(state, 'clearOne'), 'aria-label': say(state, 'clearOne') }, icon('x', true)) : null;
  return el('div', { class: 'item' }, row, clear);
}

/** The left column: the lead, then the agents by role, then the finished ones. Needs you is the header bell. */
export function renderSide(state: PageState, data: PageData): [HTMLElement, HTMLElement] {
  const lead = data.agents.find((agent) => isCheckoutLead(agent));
  const pinned = el('div', { class: 'pinned' }, el('h2', { class: 'sh lead-h' }, icon('msg', true), say(state, 'lead')));
  // The desk is the lead's own decisions (#701). Needs you stays in the header bell (#737).
  const hasDesk = !!data.desk && (data.desk.now !== '' || data.desk.decisions.length > 0 || data.desk.reply !== '');
  if (!lead && !hasDesk) pinned.append(el('div', { class: 'row lead-row still' }, el('span', { class: 'r1' }, el('span', { class: 'dot idle' }), el('span', { class: 'ttl' }, say(state, 'noLead'))), el('span', { class: 'r3 wrap' }, say(state, 'noLeadHow', { file: state.agentFile }))));
  else {
    if (lead) pinned.append(agentRow(state, lead));
    pinned.append(renderDesk(state, data, lead));
  }
  const list = el('div', { class: 'agents' });
  const cleared = state.ui.cleared;
  const others = data.agents.filter((agent) => agent !== lead);
  const listed = others.filter((agent) => isOnBoard(agent, cleared));
  for (const group of ['group.manager', 'group.engineer', 'group.reviewer', 'group.verifier', 'group.helper']) {
    const members = listed.filter((agent) => roleGroup(agent.role) === group);
    if (!members.length) continue;
    list.append(foldHead(state, group, members.map((agent) => agent.dot)));
    if (!state.ui.fold[group]) list.append(...members.map((agent) => agentRow(state, agent)));
  }
  // A finished or stale desk joins the archived list. It comes back when it is live again.
  const archived = others.filter((agent) => !isOnBoard(agent, cleared));
  if (archived.length) {
    const kept = new Set(cleared);
    list.append(el('div', { class: 'arch' }, icon('archive', true), say(state, 'archivedCount', { n: archived.length }), el('button', { class: 'act', 'data-show-cleared': '1', 'aria-expanded': String(state.ui.showCleared) }, say(state, state.ui.showCleared ? 'hide' : 'show'))));
    if (state.ui.showCleared) {
      list.append(...archived.map((agent) => el('div', { class: 'item' },
        el('button', { class: 'row done-row still', 'data-pick': agent.key, 'aria-current': String(agent.key === state.ui.current) },
          el('span', { class: 'r1' }, el('span', { class: `dot ${agent.dot}` }), el('span', { class: 'ttl' }, agent.title || agent.name), el('span', { class: 'age' }, ageOf(state, agent, Date.now()))),
          el('span', { class: 'r2' }, vendorChip(agent), el('span', { class: 'who' }, agent.nickname || agent.name))),
        kept.has(clearedId(agent)) ? el('button', { class: 'act', 'data-restore': clearedId(agent) }, say(state, 'putBack')) : null)));
    }
  }
  if (!others.length) list.append(el('p', { class: 'quiet' }, say(state, 'noAgents', { file: state.agentFile })));
  return [pinned, list];
}

/** The bell and the left column, in the order page.ts writes them. */
export const COLUMN_FUNCTIONS = [ageOfNeed, idOfNeed, noteNewNeeds, webLink, readNeedTarget, renderNeedItem, fillNeeds, vendorChip, refChip, foldHead, isOnBoard, agentRow, renderSide];
