/// <reference lib="dom" />
// The picked agent's detail panel (#644), at the top of the middle column. Like the
// other browser modules, each function runs in the page: it uses only functions page.ts
// writes, its arguments and the browser. The panel starts folded to one line; a click
// opens it. Every value came through the server's masks before it got here.

import type { AgentView } from '../../view.ts';
import { el, icon, type PageState, say } from './script.ts';

/** How full the agent's context is, or null when its status file does not say both counts. */
export function contextOf(agent: AgentView): { percent: number; isSoon: boolean } | null {
  const used = agent.contextUsed;
  const limit = agent.contextLimit;
  if (typeof used !== 'number' || typeof limit !== 'number' || !Number.isFinite(used) || !Number.isFinite(limit)) return null;
  if (used < 0 || limit <= 0) return null;
  const percent = Math.min(100, Math.round((used / limit) * 100));
  // 80 is the compact warning line. The number is written here because page.ts sends functions, not module constants.
  return { percent, isSoon: percent >= 80 };
}

/** A time as how long ago it was, in the page's language. An odd or missing time is ''. */
export function timeAgo(state: PageState, time: string, now: number = Date.now()): string {
  const then = Date.parse(time);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 1) return say(state, 'justNow');
  const format = new Intl.RelativeTimeFormat(state.ui.lang, { style: 'short' });
  if (minutes < 60) return format.format(-minutes, 'minute');
  if (minutes < 1440) return format.format(-Math.floor(minutes / 60), 'hour');
  return format.format(-Math.floor(minutes / 1440), 'day');
}

/** The picked agent's panel: one line when folded, four sections when open. */
export function renderAgentPanel(state: PageState, agent: AgentView): HTMLElement {
  const key = `panel:${agent.key}`;
  const isOpen = !!state.ui.open[key];
  const context = contextOf(agent);
  const contextWords = context ? say(state, 'contextUsed', { n: context.percent }) : say(state, 'contextUnknown');
  const outputs = agent.outputs ?? [];
  const background = agent.background ?? [];
  const row = (label: string, value: string): HTMLElement => el('div', { class: 'kv' }, el('dt', {}, label), el('dd', {}, value || say(state, 'unknown')));
  const section = (title: string, ...children: (HTMLElement | null)[]): HTMLElement => el('section', { class: 'panel-sec' }, el('h3', {}, title), ...children);
  const outputList = outputs.length
    ? el('ul', { class: 'out-list' }, ...outputs.map((file) => el('li', {}, el('code', {}, file))))
    : el('p', { class: 'quiet' }, say(state, 'panelNoOutputs'));
  const backgroundList = background.length
    ? el('ul', { class: 'out-list' }, ...background.map((task) => {
        const since = timeAgo(state, task.since);
        return el('li', {}, el('span', {}, task.text), since ? el('span', { class: 'quiet' }, ` · ${say(state, 'panelSince', { time: since })}`) : null);
      }))
    : el('p', { class: 'quiet' }, say(state, 'panelNoBackground'));
  const head = el('button', { class: `panel-head${isOpen ? ' open' : ''}`, 'data-panel': agent.key, 'aria-expanded': String(isOpen) },
    el('span', { class: 'chev' }, icon('chev', true)),
    el('b', {}, say(state, 'agentPanel')),
    el('span', { class: 'sum' }, contextWords),
    context?.isSoon ? el('span', { class: 'warn' }, icon('bell', true), say(state, 'contextSoon')) : null,
    el('span', { class: 'n' }, String(outputs.length)));
  if (!isOpen) return el('section', { class: 'panel' }, head);
  const body = el('div', { class: 'panel-body' },
    section(say(state, 'panelContext'),
      el('p', { class: context?.isSoon ? 'warn' : '' }, contextWords),
      context ? el('div', { class: 'ctrack' }, el('div', { class: `cfill${context.isSoon ? ' warn' : ''}`, style: `width:${context.percent}%` })) : null,
      context?.isSoon ? el('p', { class: 'warn' }, icon('bell', true), say(state, 'contextSoon')) : null),
    section(say(state, 'panelEnvironment'),
      el('dl', { class: 'env' },
        row(say(state, 'panelRuntime'), agent.vendor.name),
        row(say(state, 'panelModel'), agent.model),
        row(say(state, 'panelEffort'), agent.effort),
        row(say(state, 'panelWorktree'), agent.worktree || agent.key),
        row(say(state, 'panelBranch'), agent.branch),
        row(say(state, 'panelStarted'), timeAgo(state, agent.started || agent.updated)))),
    section(say(state, 'panelOutputs'), outputList),
    section(say(state, 'panelBackground'), backgroundList));
  return el('section', { class: 'panel open' }, head, body);
}

/** The panel's functions, in the order page.ts writes them. */
export const PANEL_FUNCTIONS = [contextOf, timeAgo, renderAgentPanel];
