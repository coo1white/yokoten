/// <reference lib="dom" />
// The lead's desk and the timeline (#701). Like script.ts, these functions run in the
// browser: page.ts puts their source into the page. They use only each other, the
// page's own helpers, their arguments and the browser. Every word from the desk file
// goes in as text.

import type { BoardIssue } from '../../controls.ts';
import type { AgentView } from '../../view.ts';
import { el, type PageState, say } from './script.ts';
import type { PageData } from './script.ts';

/** How far back the timeline looks, by default. The page functions repeat this number: their source is copied into the page, so they cannot see this binding. */
export const TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Where a bar sits in the window, as percentages, or null when it misses the window. */
export function barPlace(started: string, ended: string, now: number, windowMs = 24 * 60 * 60 * 1000): { left: number; width: number } | null {
  const start = Date.parse(started);
  const end = ended ? Date.parse(ended) : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const windowStart = now - windowMs;
  if (end < windowStart || start > now) return null;
  const from = Math.max(start, windowStart);
  const to = Math.min(end, now);
  const span = windowMs || 1;
  const left = ((from - windowStart) / span) * 100;
  // A point in time still shows as a short bar.
  const width = to === from ? 1.5 : ((to - from) / span) * 100;
  return { left, width };
}

/** One row of the timeline. */
export interface TimelineRow {
  key: string;
  title: string;
  color: string;
  started: string;
  ended: string;
  isWorking: boolean;
  dependsOn: number[];
  /** Where the issue sits on the critical path (#709), or -1 when it is not on it. */
  rank: number;
}

/** True when `time` falls inside the last 24 hours ending at `now`. */
function isRecent(time: string | undefined, now: number): boolean {
  const then = Date.parse(time ?? '');
  return !Number.isNaN(then) && then <= now && now - then <= 24 * 60 * 60 * 1000;
}

/** The rows in flight: each agent whose bar meets the window, then a recent issue nobody has taken. The critical path comes first (#709). */
export function timelineOf(agents: AgentView[], issues: BoardIssue[] | string, now: number, criticalPath: readonly number[] = []): TimelineRow[] {
  const list = typeof issues === 'string' ? [] : issues;
  const rankOf = new Map(criticalPath.map((number, at) => [number, at]));
  const rows: TimelineRow[] = [];
  const covered = new Set<number>();
  for (const agent of agents) {
    const started = agent.started || agent.updated;
    const ended = agent.dot === 'done' ? agent.updated : '';
    if (!barPlace(started, ended, now)) continue;
    const ref = agent.ref;
    const owned = ref?.kind === 'issue' ? list.find((item) => item.number === ref.number) : undefined;
    if (ref?.kind === 'issue') covered.add(ref.number);
    rows.push({ key: agent.key, title: agent.title || agent.name, color: agent.vendor.color, started, ended, isWorking: agent.dot === 'working', dependsOn: owned?.dependsOn ?? [], rank: ref?.kind === 'issue' ? rankOf.get(ref.number) ?? -1 : -1 });
  }
  for (const issue of list) {
    if (covered.has(issue.number)) continue;
    const started = issue.createdAt || issue.updatedAt || '';
    if (!isRecent(issue.createdAt, now) && !isRecent(issue.updatedAt, now)) continue;
    if (!barPlace(started, '', now)) continue;
    rows.push({ key: `issue-${issue.number}`, title: issue.title || `#${issue.number}`, color: '#8b8b8b', started, ended: '', isWorking: false, dependsOn: issue.dependsOn ?? [], rank: rankOf.get(issue.number) ?? -1 });
  }
  // The critical path first, in the order it can start; the rest keep their order.
  return rows.sort((left, right) => (left.rank < 0 ? Number.MAX_SAFE_INTEGER : left.rank) - (right.rank < 0 ? Number.MAX_SAFE_INTEGER : right.rank));
}

/** "after #697, #698", in the page's language, or '' when nothing is waited on. */
function formatWaits(state: PageState, numbers: number[]): string {
  if (!numbers.length) return '';
  return say(state, 'afterIssue', { refs: numbers.map((number) => `#${number}`).join(', ') });
}

/** How many ready issues the queue lists. The rest show as a count. */
const QUEUE_ROWS = 5;

/** The board's issue limit, repeated here because page.ts copies this source into the page. */
const ISSUE_LIMIT = 30;

/**
 * Why a start waits, in the page's words: the machine's room by the board's limits
 * (#709). A missing room (before the first read) still shows the settings.
 */
function roomNote(state: PageState, data: PageData): string {
  const floor = data.limits.memoryFloorMb;
  const max = data.limits.maxAgents;
  const room = data.room;
  if (room?.hold === 'memory') return say(state, 'queueHeldMemory', { free: room.freeMemoryMb, floor });
  if (room?.hold === 'slots') return say(state, 'queueHeldSlots', { max });
  return say(state, 'queueRoom', { max, floor });
}

/**
 * The dependency queue (#709): the next ready issues in start order, any cycle, why a
 * start waits, and the board's one start control. The ready list and the cycles are the
 * ones /data already serves, so the page never works the graph out again.
 */
export function renderQueue(state: PageState, data: PageData): HTMLElement | null {
  const schedule = data.schedule;
  if (!schedule) return null;
  const issues = typeof data.issues === 'string' ? [] : data.issues;
  const titleOf = new Map(issues.map((issue) => [issue.number, issue.title || `#${issue.number}`]));
  const box = el('div', { class: 'queue' });
  box.append(el('h3', {}, say(state, 'queueTitle'), el('span', { class: 'n' }, String(schedule.ready.length))));
  if (!schedule.ready.length) box.append(el('p', { class: 'quiet' }, say(state, issues.length > ISSUE_LIMIT ? 'queueCutOff' : 'queueEmpty')));
  for (const number of schedule.ready.slice(0, QUEUE_ROWS)) {
    box.append(el('p', { class: 'q-row' }, el('span', { class: 'num' }, `#${number}`), ` ${titleOf.get(number) ?? ''}`));
  }
  const more = schedule.ready.length - QUEUE_ROWS;
  if (more > 0) box.append(el('p', { class: 'quiet' }, say(state, 'queueMore', { n: more })));
  for (const cycle of schedule.cycles) {
    box.append(el('p', { class: 'q-cycle' }, say(state, 'queueCycle', { refs: cycle.map((number) => `#${number}`).join(' → ') })));
  }
  if (schedule.blocked.length) box.append(el('p', { class: 'quiet' }, say(state, 'queueBlocked', { n: schedule.blocked.length })));
  box.append(el('p', { class: 'quiet' }, roomNote(state, data)));
  const vendor = el('select', { id: 'q-vendor', name: 'vendor' }, ...['claude-code', 'codex', 'muse', 'grok', 'antigravity', 'deepseek-harness'].map((name) => el('option', { value: name }, name)));
  const model = el('input', { id: 'q-model', name: 'model', placeholder: say(state, 'modelName') });
  box.append(el('div', { class: 'q-start' }, vendor, model, el('button', { class: 'hbtn', 'data-start-next': '1' }, say(state, 'startNext'))));
  box.append(el('p', { class: 'quiet', id: 'queue-note' }, ''));
  // The settings that hold a start, set here so the lead view can change them (#709).
  box.append(el('p', { class: 'quiet' }, say(state, 'queueLimitsHint')));
  const max = el('input', { id: 'q-max', name: 'maxAgents', inputmode: 'numeric', value: String(data.limits.maxAgents), 'aria-label': say(state, 'maxAgents') });
  const floor = el('input', { id: 'q-floor', name: 'memory', inputmode: 'numeric', value: String(data.limits.memoryFloorMb), 'aria-label': say(state, 'memoryFloor') });
  box.append(el('div', { class: 'q-start' }, max, floor, el('button', { class: 'hbtn', 'data-queue-limits': '1' }, say(state, 'saveNow'))));
  box.append(el('p', { class: 'quiet', id: 'queue-limits-note' }, ''));
  return box;
}

/** The lead box: what the lead is doing, at most three decisions, and the last reply. */
export function renderDesk(state: PageState, data: PageData, lead: AgentView | undefined): HTMLElement {
  const desk = data.desk;
  const box = el('div', { class: 'lead-desk' });
  const nowText = desk.now || say(state, 'deskQuiet');
  const now = lead
    ? el('button', { class: 'now', 'data-pick': lead.key, 'aria-current': String(lead.key === state.ui.current) }, nowText)
    : el('p', { class: 'now' }, nowText);
  box.append(el('h3', {}, say(state, 'deskNow')), now);
  box.append(el('h3', {}, say(state, 'deskWaiting')));
  const decisions = desk.decisions.slice(0, 3);
  if (!decisions.length) box.append(el('p', { class: 'quiet' }, say(state, 'deskNone')));
  for (const decision of decisions) {
    const answers = decision.answers.length ? el('p', { class: 'answers' }, ...decision.answers.map((word) => el('span', { class: 'ans' }, word))) : null;
    const recommend = decision.recommend ? el('p', { class: 'rec' }, say(state, 'deskRecommend', { text: decision.recommend })) : null;
    box.append(el('div', { class: 'decision' }, el('p', { class: 'ask-line' }, decision.question), recommend, answers));
  }
  box.append(el('h3', {}, say(state, 'deskReply')));
  if (!desk.reply) box.append(el('p', { class: 'quiet' }, say(state, 'deskNoReply')));
  else {
    const isOpen = !!state.ui.open['lead-reply'];
    const reply = el('button', { class: 'reply', 'aria-expanded': String(isOpen && !!desk.rest) }, desk.reply);
    if (desk.rest) reply.setAttribute('data-reply', 'lead');
    box.append(reply);
    if (isOpen && desk.rest) box.append(el('p', { class: 'rest' }, desk.rest));
  }
  return box;
}

/** The middle, when the lead is picked: one row per piece of work, bars across the last 24 hours. */
export function renderTimeline(state: PageState, data: PageData, now: number = Date.now()): HTMLElement {
  const rows = timelineOf(data.agents, data.issues, now, data.schedule?.criticalPath ?? []);
  const box = el('div', { class: 'gantt' }, el('div', { class: 'scale' }, el('span', {}, say(state, 'scaleAgo')), el('span', {}, say(state, 'timelineTitle')), el('span', {}, say(state, 'scaleNow'))));
  if (!rows.length) {
    box.append(el('p', { class: 'quiet' }, say(state, 'timelineEmpty')));
    return box;
  }
  for (const row of rows) {
    const place = barPlace(row.started, row.ended, now);
    if (!place) continue;
    const bar = el('span', { class: row.isWorking ? 'gantt-bar live' : 'gantt-bar', 'aria-hidden': 'true' });
    bar.style.left = `${place.left}%`;
    bar.style.width = `${place.width}%`;
    bar.style.background = row.color;
    const name = el('div', { class: 'gantt-name' }, el('span', { class: 'ttl' }, row.title));
    const waits = formatWaits(state, row.dependsOn);
    if (waits) name.append(el('span', { class: 'waits' }, waits));
    box.append(el('div', { class: row.rank >= 0 ? 'gantt-row critical' : 'gantt-row' }, name, el('div', { class: 'gantt-track' }, bar)));
  }
  return box;
}

/** The desk and timeline functions, in the order page.ts writes them. */
export const DESK_FUNCTIONS = [barPlace, isRecent, timelineOf, formatWaits, roomNote, renderQueue, renderDesk, renderTimeline];
