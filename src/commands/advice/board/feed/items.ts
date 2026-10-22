// What an agent's session log says, as the board streams it (#694): one list of plain items,
// the same for every runtime. Each runtime writes its own log; the readers here turn one
// line of it into items. Nothing here masks: tail.ts masks every item before it leaves the
// server. Nothing here is HTML: the page puts every word in as text.

/**
 * One thing the agent did. `say` is what it wrote, `think` its reasoning summary, `tool` one
 * tool call (`text` in a few words, `full` the whole call), `result` a call's output (`call`
 * names the call), and `stop` a call the guard refused.
 */
export interface StreamItem {
  kind: 'say' | 'think' | 'tool' | 'result' | 'stop';
  text: string;
  full?: string;
  /** For `tool` and `result`: the call, as the runtime names it. tail.ts numbers it before it leaves. */
  call?: string;
  /** When, as an ISO time, or '' when the log does not say. */
  time: string;
}

/** The runtimes whose log the board reads. */
export type StreamSource = 'claude' | 'muse' | 'grok';

/** The most of a call's whole text, and of an output, that the board keeps. */
export const FULL_LIMIT = 4000;
export const RESULT_LIMIT = 2000;
/** The most of one message or summary line the board keeps. */
export const TEXT_LIMIT = 8000;

/** Text cut to `limit` characters, with a note of how much was left out. */
export function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A path in the worktree, without the worktree: `src/a.ts`, not `/home/x/repo/src/a.ts`. */
function inTree(path: string, tree: string): string {
  return tree && path.startsWith(`${tree}/`) ? path.slice(tree.length + 1) : path;
}

/** One tool call in a few words: its own description, the command, or what it read or changed. */
export function describeCall(name: string, args: Record<string, unknown>, tree: string): string {
  const first = (value: unknown) => inTree(textOf(value).split('\n')[0].trim(), tree).slice(0, 160);
  const path = textOf(args.file_path) || textOf(args.path) || textOf(args.target_file) || textOf(args.notebook_path);
  if (textOf(args.description).trim()) return first(args.description);
  if (textOf(args.command).trim()) return first(args.command);
  if (path && /read|view|cat/i.test(name)) return `read ${first(path)}`;
  if (path && /write|edit|patch|replace|create/i.test(name)) return `changed ${first(path)}`;
  if (textOf(args.pattern)) return `searched for ${first(args.pattern)}`;
  if (path) return `${name.replaceAll('_', ' ')} ${first(path)}`;
  return name.replaceAll('_', ' ');
}

/** A call's whole text: the command when it has one, else its arguments as JSON. */
function fullCall(name: string, args: Record<string, unknown>): string {
  const command = textOf(args.command);
  return cut(command || `${name} ${JSON.stringify(args, null, 2)}`, FULL_LIMIT);
}

/** A call's arguments from the JSON text some runtimes keep them in. Not JSON: no arguments. */
function argsOf(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  try {
    const parsed: unknown = JSON.parse(textOf(value));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A tool call as an item. */
function toolItem(name: string, args: Record<string, unknown>, call: string, tree: string, time: string): StreamItem {
  return { kind: 'tool', text: describeCall(name, args, tree), full: fullCall(name, args), call, time };
}

/** A tool's output as an item: a guard's refusal stands out, any other output rides under its call. */
function resultItem(text: string, call: string, isError: boolean, time: string): StreamItem {
  const isGuard = /\byokoten\b/i.test(text) && (isError || /blocked by hook/i.test(text)) && /block|refus|stop|not allowed/i.test(text);
  if (isGuard) return { kind: 'stop', text: cut(text.trim(), RESULT_LIMIT), call, time };
  return { kind: 'result', text: cut(text, RESULT_LIMIT), call, time };
}

/** Said text as an item, or nothing when it is empty. */
function saidItem(kind: 'say' | 'think', text: string, time: string): StreamItem[] {
  return text.trim() ? [{ kind, text: cut(text.trim(), TEXT_LIMIT), time }] : [];
}

/** A Claude Code tool result's text: a string, or the text parts of a list. */
function claudeResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isObject(part) && part.type === 'text' ? textOf(part.text) : '')).filter(Boolean).join('\n');
}

/**
 * One line of a Claude Code session log (`~/.claude/projects/<folder>/<session>.jsonl`). The
 * assistant's text, its thinking when shown, and its tool calls; the tool results from the
 * user's turn. The prompts themselves, and every other record, are left out.
 */
export function claudeItems(record: unknown, tree: string): StreamItem[] {
  if (!isObject(record) || !isObject(record.message)) return [];
  const time = textOf(record.timestamp);
  const content = record.message.content;
  if (!Array.isArray(content)) return record.type === 'assistant' ? saidItem('say', textOf(content), time) : [];
  const items: StreamItem[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (record.type === 'assistant' && part.type === 'text') items.push(...saidItem('say', textOf(part.text), time));
    if (record.type === 'assistant' && part.type === 'thinking') items.push(...saidItem('think', textOf(part.thinking), time));
    if (record.type === 'assistant' && part.type === 'tool_use') items.push(toolItem(textOf(part.name), argsOf(part.input), textOf(part.id), tree, time));
    if (record.type === 'user' && part.type === 'tool_result') items.push(resultItem(claudeResultText(part.content), textOf(part.tool_use_id), part.is_error === true, time));
  }
  return items;
}

/** Muse Code's records, from one log line: the line itself, or the records a frame holds. */
function museRecords(line: unknown): Record<string, unknown>[] {
  if (!isObject(line)) return [];
  if (!Array.isArray(line.children)) return [line];
  return line.children.flatMap((child) => {
    if (!isObject(child)) return [];
    try {
      const parsed: unknown = JSON.parse(textOf(child.record_json));
      return isObject(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/** A Muse time, kept in microseconds, as ISO. */
function museTime(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(Math.floor(value / 1000)).toISOString() : '';
}

/**
 * One line of a Muse Code session log (`~/.local/share/muse/sessions/<date>/<id>/session.jsonl`):
 * its committed messages, reasoning summaries, tool calls and tool results.
 */
export function museItems(line: unknown, tree: string): StreamItem[] {
  const items: StreamItem[] = [];
  for (const record of museRecords(line)) {
    const payload = isObject(record.payload) ? record.payload : {};
    const event = isObject(payload.event) ? payload.event : payload;
    const time = museTime(record.recorded_at);
    if (event.kind === 'assistant_message_committed') items.push(...saidItem('say', textOf(event.text), time));
    if (event.kind === 'reasoning_summary_committed') items.push(...saidItem('think', textOf(event.text), time));
    if (event.kind === 'assistant_tool_calls_committed' && Array.isArray(event.tool_calls)) {
      for (const call of event.tool_calls) if (isObject(call)) items.push(toolItem(textOf(call.name), argsOf(call.args), textOf(call.call_id) || textOf(call.id), tree, time));
    }
    if (event.kind === 'tool_result_batch_committed' && Array.isArray(event.results)) {
      for (const result of event.results) if (isObject(result)) items.push(resultItem(textOf(result.text), textOf(result.tool_call_id), false, time));
    }
  }
  return items;
}

/**
 * One line of a Grok session's chat history (`~/.grok/sessions/<folder>/<id>/chat_history.jsonl`):
 * the assistant's text and tool calls, its reasoning summaries, and the tool results. The
 * history keeps no times.
 */
export function grokItems(record: unknown, tree: string): StreamItem[] {
  if (!isObject(record)) return [];
  if (record.type === 'assistant') {
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls.filter(isObject) : [];
    return [...saidItem('say', textOf(record.content), ''), ...calls.map((call) => toolItem(textOf(call.name), argsOf(call.arguments), textOf(call.id), tree, ''))];
  }
  if (record.type === 'reasoning' && Array.isArray(record.summary)) {
    return saidItem('think', record.summary.map((part) => (isObject(part) ? textOf(part.text) : '')).join('\n'), '');
  }
  if (record.type === 'tool_result') return [resultItem(textOf(record.content), textOf(record.tool_call_id), false, '')];
  return [];
}

/** The reader for each runtime's log lines. Codex: none yet, as no Codex session log on hand shows its format. */
export const LINE_READERS: Record<StreamSource, (record: unknown, tree: string) => StreamItem[]> = {
  claude: claudeItems,
  muse: museItems,
  grok: grokItems,
};
