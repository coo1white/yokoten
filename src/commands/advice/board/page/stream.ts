/// <reference lib="dom" />
// The picked agent's session in the middle column, as it happens (#694). Like script.ts, each
// function runs in the browser: page.ts puts their source into the page, so they use nothing
// but each other, script.ts's functions, their arguments and the browser. The page asks
// /feed for the items after its cursor and adds them at the bottom; it never draws the
// whole session again. Every word goes in as text: nothing here parses HTML.

import type { StreamAnswer } from '../feed/tail.ts';
import type { StreamItem } from '../feed/items.ts';
import type { AgentView } from '../view.ts';
import { el, icon, type PageState, render, say } from './script.ts';

/** The run of tool calls at the bottom: its box, its head, its list, and how many calls it holds. */
export interface StepRun {
  box: HTMLElement;
  head: HTMLElement;
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

/** What a run of calls says when folded: the one call, or how many and the last. */
export function stepsLabel(state: PageState, count: number, last: string): string {
  return count === 1 ? last : say(state, 'streamSteps', { n: count, last });
}

/** One call: a line that opens to the whole call, and later its output. */
function callNode(item: StreamItem): HTMLElement {
  return el('details', { class: 'call' }, el('summary', {}, item.text), el('pre', { class: 'full' }, item.full ?? item.text));
}

/** One message, thought or guard stop as its own block. Paragraphs keep their line breaks as text. */
function streamBlock(state: PageState, item: StreamItem): HTMLElement {
  const time = streamTime(state, item.time);
  if (item.kind === 'think') return el('div', { class: 'think' }, item.text);
  if (item.kind === 'stop') return el('div', { class: 'gstop' }, el('div', { class: 'ah' }, icon('shield', true), el('b', {}, say(state, 'streamStop'))), el('pre', { class: 'full' }, item.text));
  return el('div', { class: 'msg' }, time ? el('div', { class: 'tm' }, time) : null, ...item.text.split(/\n{2,}/).map((part) => el('p', {}, part)));
}

/**
 * Add items at the bottom of the stream. Tool calls in a row fold into one run, "Ran N
 * steps · last"; each opens to the whole call. An output goes under its call.
 */
export function addStream(state: PageState, stream: StreamView, items: StreamItem[]): void {
  const node = stream.node;
  if (!node) return;
  for (const item of items) {
    if (item.kind === 'result') {
      const call = item.call ? stream.calls[item.call] : undefined;
      if (call && item.text.trim()) call.append(el('div', { class: 'out-h' }, say(state, 'streamOutput')), el('pre', { class: 'full out' }, item.text));
      continue;
    }
    if (item.kind !== 'tool') {
      stream.run = null;
      node.append(streamBlock(state, item));
      continue;
    }
    if (!stream.run) {
      const head = el('span', {});
      const list = el('div', { class: 'calls' });
      const box = el('details', { class: 'steps' }, el('summary', {}, icon('term', true), head), list);
      stream.run = { box, head, list, count: 0 };
      node.append(box);
    }
    const call = callNode(item);
    if (item.call) stream.calls[item.call] = call;
    stream.run.list.append(call);
    stream.run.count += 1;
    stream.run.head.replaceChildren(stepsLabel(state, stream.run.count, item.text));
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
  const ask = `feed?t=${encodeURIComponent(state.token)}&agent=${encodeURIComponent(stream.agent)}&after=${encodeURIComponent(stream.next)}`;
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
export const STREAM_FUNCTIONS = [emptyStream, streamTime, stepsLabel, callNode, streamBlock, addStream, renderStream, newStreamNode, loadStream, followStream];
