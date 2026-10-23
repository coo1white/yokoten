// What an agent's session log says, as the board streams it (#694, #698). Each runtime writes
// its own log. Each reader maps one line onto the standard in shape.ts. Nothing here masks:
// tail.ts masks every item before it leaves the server. Nothing here is HTML.

import { commonTool, type StreamItem, type StreamSource } from './shape.ts';

export { commonTool, type StreamItem, type StreamSource };

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

/** A tool call as an item. The common name is what the page shows; `full` keeps the runtime's name. */
function toolItem(name: string, args: Record<string, unknown>, call: string, tree: string, time: string): StreamItem {
  const item: StreamItem = { kind: 'tool', tool: commonTool(name), text: describeCall(name, args, tree), full: fullCall(name, args), call, time };
  if (!textOf(args.description).trim() && textOf(args.command).trim()) item.isCommand = true;
  return item;
}

/** A tool's output as an item: a guard's refusal stands out, any other output rides under its call. */
function resultItem(text: string, call: string, isError: boolean, time: string): StreamItem {
  const isGuard = /\byokoten\b/i.test(text) && (isError || /blocked by hook/i.test(text)) && /block|refus|stop|not allowed/i.test(text);
  if (isGuard) return { kind: 'stop', text: cut(text.trim(), RESULT_LIMIT), call, time };
  const item: StreamItem = { kind: 'result', text: cut(text, RESULT_LIMIT), call, time };
  if (isError) item.isFailed = true;
  return item;
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

/** The text of a Codex message: a string, or the text parts that go in it. */
function codexMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!isObject(part)) return textOf(part);
      const type = textOf(part.type);
      return !type || type === 'output_text' || type === 'text' ? textOf(part.text) : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A Codex reasoning summary, from its summary and content parts. */
function codexSummaryText(payload: Record<string, unknown>): string {
  return [payload.summary, payload.content]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((part) => (isObject(part) ? textOf(part.text) : textOf(part)))
    .filter(Boolean)
    .join('\n');
}

/** A shell command without its `bash -lc` wrapper: the words the agent chose to run. */
function shellWords(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length > 2 && /(?:^|\/)(?:bash|sh|zsh|dash|fish)$/.test(words[0]) && /^-[A-Za-z]*c[A-Za-z]*$/.test(words[1])) {
    return words.slice(2).join(' ').replace(/^(['"])(.*)\1$/, '$2');
  }
  return text;
}

/** Codex arguments as the shared describer reads them: a command string, or the patch's file. */
function codexArgs(name: string, raw: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...raw };
  const listed = Array.isArray(raw.command) ? raw.command.filter((part): part is string => typeof part === 'string').join(' ') : '';
  const command = shellWords(textOf(raw.command) || textOf(raw.cmd) || listed);
  const isPatch = /patch/i.test(name);
  if (command && !isPatch) args.command = command;
  const body = textOf(raw.patch) || textOf(raw.input) || (isPatch ? command : '');
  const header = /\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/.exec(body);
  if (header) args.file_path = header[1].trim();
  if (isPatch) delete args.command;
  return args;
}

/** A Codex tool output: a string, the text a result object carries, or the parts of a list. */
function codexOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(codexOutput).filter(Boolean).join('\n');
  if (!isObject(value)) return '';
  return textOf(value.content) || textOf(value.stdout) || textOf(value.text) || textOf(value.output);
}

/** A result object Codex sometimes keeps as JSON text. Not JSON, or not an object: null. */
function codexJson(value: unknown): Record<string, unknown> | null {
  if (isObject(value)) return value;
  try {
    const parsed: unknown = JSON.parse(textOf(value));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A Codex result's text, with a JSON result object opened to the text it carries. */
function codexResultText(value: unknown): string {
  const parsed = codexJson(value);
  if (parsed && typeof value === 'string') {
    return textOf(parsed.content) || textOf(parsed.stdout) || textOf(parsed.text) || textOf(parsed.output) || value;
  }
  return codexOutput(value);
}

/** True when a Codex result says it failed: a flag, a status, an exit code, or the output's own line. */
function codexFailed(payload: Record<string, unknown>, output: unknown): boolean {
  const box = codexJson(output);
  if (payload.is_error === true || payload.success === false || payload.status === 'failed') return true;
  if (box && (box.is_error === true || box.success === false)) return true;
  const code = typeof payload.exit_code === 'number' ? payload.exit_code : box && typeof box.exit_code === 'number' ? box.exit_code : null;
  if (code !== null) return code !== 0;
  const hit = /(?:process )?exited with code (\d+)/i.exec(codexOutput(output));
  return hit ? Number(hit[1]) !== 0 : false;
}

/**
 * One line of a Codex rollout (`sessions/<year>/<month>/<day>/rollout-*.jsonl`). A
 * `response_item` holds a message, a reasoning summary, a tool call or its output.
 * `event_msg` repeats the message, so it is left out. Codex names a shell call three
 * ways (`shell`, `local_shell_call`, `custom_tool_call` for `apply_patch`), and all
 * three become the same kinds here.
 */
export function codexItems(record: unknown, tree: string): StreamItem[] {
  if (!isObject(record) || record.type === 'event_msg' || record.type === 'session_meta') return [];
  const time = textOf(record.timestamp);
  const payload = record.type === 'response_item' && isObject(record.payload) ? record.payload : record;
  const kind = textOf(payload.type);
  if (kind === 'message' && payload.role === 'assistant') return saidItem('say', codexMessageText(payload.content), time);
  if (kind === 'reasoning') return saidItem('think', codexSummaryText(payload), time);
  if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
    const name = textOf(payload.name) || (kind === 'local_shell_call' ? 'shell' : 'tool');
    const input = textOf(payload.input);
    const raw = kind === 'custom_tool_call' && input ? { input, patch: input } : argsOf(payload.arguments ?? payload.input ?? payload.action);
    return [toolItem(name, codexArgs(name, raw), textOf(payload.call_id) || textOf(payload.id), tree, time)];
  }
  if (kind === 'function_call_output' || kind === 'custom_tool_call_output' || kind === 'local_shell_call_output') {
    return [resultItem(codexResultText(payload.output), textOf(payload.call_id) || textOf(payload.id), codexFailed(payload, payload.output), time)];
  }
  if (kind === 'web_search_call') {
    const action = isObject(payload.action) ? payload.action : {};
    const query = textOf(action.query) || textOf(payload.query);
    return [toolItem('web_search', query ? { pattern: query } : {}, textOf(payload.id) || textOf(payload.call_id), tree, time)];
  }
  return [];
}

/**
 * One line of a plain text log (`log` in the status file): the line itself, as the agent's
 * words, cut when long. No JSON, no tool calls.
 */
export function plainItems(line: unknown, _: string): StreamItem[] {
  return typeof line === 'string' ? saidItem('say', line.replace(/\r$/, ''), '') : [];
}

/** The reader for each runtime's log lines. A new runtime is one reader here, and nothing else. */
export const LINE_READERS: Record<StreamSource, (record: unknown, tree: string) => StreamItem[]> = {
  claude: claudeItems,
  muse: museItems,
  grok: grokItems,
  codex: codexItems,
  plain: plainItems,
};
