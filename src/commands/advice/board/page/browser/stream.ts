/// <reference lib="dom" />
// The picked agent's session in the middle column, as it happens (#694). Like script.ts, each
// function runs in the browser: page.ts puts their source into the page, so they use nothing
// but each other, script.ts's functions, their arguments and the browser. The page asks
// /feed for the items after its cursor and adds them at the bottom; it never draws the
// whole session again. Every word goes in as text: nothing here parses HTML.

import type { StreamAnswer } from '../../feed/tail.ts';
import type { StreamItem } from '../../feed/shape.ts';
import type { AgentView } from '../../view.ts';
import { el, icon, type PageState, render, say } from './script.ts';

/** How many tool steps stay open before the rest fold (#698). */
const SHOW_STEPS = 3;

/** A run of tool steps: where the next one goes, and the fold once it passes SHOW_STEPS. */
export interface StepRun {
  /** The fold's summary, once the run is longer than SHOW_STEPS. */
  summary: HTMLElement | null;
  /** The chat, then the fold. */
  list: HTMLElement;
  count: number;
}

/** The stream the page holds for the picked agent. `node` is the column's scrolling list, kept between draws. */
export interface StreamView {
  agent: string;
  source: StreamAnswer['source'] | '';
  next: string;
  node: HTMLElement | null;
  run: StepRun | null;
  /** Each call's box, by its number, so its output can go under it. */
  calls: Record<string, HTMLElement>;
  timer: number;
  isAsking: boolean;
}

/** A stream with nothing in it yet, for one agent. */
export function emptyStream(agent: string): StreamView {
  return { agent, source: '', next: '', node: null, run: null, calls: {}, timer: 0, isAsking: false };
}

/** A time as the page shows it, or '' when the log keeps none. */
export function streamTime(state: PageState, time: string): string {
  const then = Date.parse(time);
  return Number.isNaN(then) ? '' : new Date(then).toLocaleTimeString(state.ui.lang, { hour: 'numeric', minute: '2-digit' });
}

/** The first two lines of a result, and whether the rest stays closed. */
function clipText(text: string): { shown: string; isLong: boolean } {
  const lines = text.split('\n');
  if (lines.length <= 2) return { shown: text, isLong: false };
  return { shown: `${lines[0]}\n${lines[1]}…`, isLong: true };
}

/** A step's result: the mark, two lines, and the rest behind a click. Nothing long starts open. */
function outputNode(text: string): HTMLElement {
  const clip = clipText(text);
  const mark = el('span', { class: 'mk' }, '⎿ ');
  if (!clip.isLong) return el('div', { class: 'step-out' }, mark, el('span', {}, clip.shown));
  return el('details', { class: 'step-out' }, el('summary', {}, mark, el('span', {}, clip.shown)), el('pre', { class: 'full' }, text));
}

/** One tool step: a dot, the common tool name, then the short note or the command. */
function stepNode(item: StreamItem): HTMLElement {
  const note = item.isCommand ? el('code', {}, item.text) : el('span', {}, item.text);
  return el('div', { class: item.isFailed ? 'step bad' : 'step' }, el('span', { class: 'sd' }), el('b', {}, item.tool ?? 'Other'), ' ', note);
}

/** Mark a step failed once its result says so. The dot turns red. */
function markFailed(node: HTMLElement): void {
  const names = (node.getAttribute('class') ?? '').split(' ').filter((name) => name);
  if (!names.includes('bad')) node.setAttribute('class', [...names, 'bad'].join(' '));
}

/** One message, thought or guard stop as its own block. A time shows once, on the message. */
function streamBlock(state: PageState, item: StreamItem): HTMLElement {
  if (item.kind === 'think') return el('div', { class: 'think' }, item.text);
  if (item.kind === 'stop') return el('div', { class: 'gstop' }, el('div', { class: 'ah' }, icon('shield', true), el('b', {}, say(state, 'streamStop'))), el('pre', { class: 'full' }, item.text));
  const time = streamTime(state, item.time);
  return el('div', { class: 'msg' }, time ? el('div', { class: 'tm' }, time) : null, ...item.text.split(/\n{2,}/).map((part) => el('p', {}, part)));
}

/**
 * Add items at the bottom. The agent's words are paragraphs. Each tool is one line.
 * After SHOW_STEPS lines, the rest fold. A result sits under its step, two lines at most.
 */
export function addStream(state: PageState, stream: StreamView, items: StreamItem[]): void {
  const node = stream.node;
  if (!node) return;
  for (const item of items) {
    if (item.kind === 'result') {
      const call = item.call ? stream.calls[item.call] : undefined;
      if (!call) continue;
      if (item.isFailed) markFailed(call);
      if (item.text.trim()) call.append(outputNode(item.text));
      continue;
    }
    if (item.kind !== 'tool') {
      stream.run = null;
      node.append(streamBlock(state, item));
      continue;
    }
    if (!stream.run) stream.run = { summary: null, list: node, count: 0 };
    if (stream.run.count === SHOW_STEPS) {
      const summary = el('summary', {});
      const more = el('details', { class: 'step-more' }, summary);
      stream.run.summary = summary;
      stream.run.list = more;
      node.append(more);
    }
    const step = stepNode(item);
    if (item.call) stream.calls[item.call] = step;
    stream.run.list.append(step);
    stream.run.count += 1;
    if (stream.run.summary) stream.run.summary.replaceChildren(say(state, 'moreSteps', { n: stream.run.count - SHOW_STEPS }));
  }
}

/** The stream's list for the picked agent, or null when the page shows its `doing` steps instead. */
export function renderStream(state: PageState, agent: AgentView): HTMLElement | null {
  const stream = state.stream;
  if (!stream || stream.agent !== agent.key || !stream.node || stream.source === 'doing' || stream.source === '') return null;
  return stream.node;
}

/** A new list for a stream: its heading, and a note until the first item comes. */
export function newStreamNode(state: PageState): HTMLElement {
  return el('div', { class: 'feed chat' }, el('div', { class: 'day' }, say(state, 'streamTitle')));
}

/** Ask /feed for what came after the cursor, add it, and ask again: soon when more is waiting. */
export function loadStream(state: PageState): void {
  const stream = state.stream;
  if (!stream || !stream.agent || stream.isAsking) return;
  clearTimeout(stream.timer);
  stream.isAsking = true;
  const ask = `feed?agent=${encodeURIComponent(stream.agent)}&after=${encodeURIComponent(stream.next)}`;
  const again = (ms: number) => {
    stream.isAsking = false;
    if (state.stream === stream) stream.timer = window.setTimeout(() => loadStream(state), ms);
  };
  fetch(ask, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((answer: StreamAnswer) => {
      if (state.stream !== stream) return;
      const wasShown = stream.source !== '' && stream.source !== 'doing';
      stream.source = answer.source;
      stream.next = answer.next;
      if (answer.reset) Object.assign(stream, { node: answer.source === 'doing' ? null : newStreamNode(state), run: null, calls: {} });
      const node = stream.node;
      const isAtEnd = !node || node.scrollTop + node.clientHeight >= node.scrollHeight - 60;
      addStream(state, stream, answer.items);
      if (answer.reset || !wasShown) render(state);
      else if (node && isAtEnd) node.scrollTop = node.scrollHeight;
      again(answer.more ? 300 : 2000);
    })
    .catch(() => again(5000));
}

/** Follow the picked agent: a new pick drops the old stream and asks for the new one at once. */
export function followStream(state: PageState, key: string): void {
  if (state.stream?.agent === key) return;
  if (state.stream) clearTimeout(state.stream.timer);
  state.stream = emptyStream(key);
  if (key) loadStream(state);
}

/** The stream's functions, in the order page.ts writes them. */
export const STREAM_FUNCTIONS = [emptyStream, streamTime, clipText, outputNode, stepNode, markFailed, streamBlock, addStream, renderStream, newStreamNode, loadStream, followStream];
