// Tests for src/commands/advice/board/feed/items.ts and tail.ts: each runtime's log becomes
// one list of items, and each read takes only the new lines.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../../../repo/helpers.ts';
import type { StreamSource } from '../../../../../src/commands/advice/board/feed/items.ts';
import { KEEP_ITEMS, makeStreamStore, READ_BYTES, readStream, SEND_ITEMS, START_BYTES } from '../../../../../src/commands/advice/board/feed/tail.ts';

const TREE = '/work/repo';
const AT = '2026-10-22T10:00:00.000Z';
const AT_US = Date.parse(AT) * 1000;
const line = (record: unknown) => `${JSON.stringify(record)}\n`;

/** One short session, as Claude Code writes it: a prompt, a message, two calls and their results, then a message. */
function claudeLog(): string {
  return [
    { type: 'user', timestamp: AT, message: { role: 'user', content: 'the task, which the board leaves out' } },
    { type: 'assistant', timestamp: AT, message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Reading the issue first.' }] } },
    { type: 'assistant', timestamp: AT, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'gh issue view 694', description: 'Read the issue' } }] } },
    { type: 'user', timestamp: AT, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'title: the board streams' }] } },
    { type: 'assistant', timestamp: AT, message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: `${TREE}/src/a.ts` } }] } },
    { type: 'user', timestamp: AT, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: '1 export {}' }] }] } },
    { type: 'attachment', timestamp: AT, attachment: { type: 'total_tokens_reminder' } },
    { type: 'assistant', timestamp: AT, message: { content: [{ type: 'text', text: 'Done.' }] } },
  ].map(line).join('');
}

/** The same session as Muse Code writes it: events in a run, a frame of children, times in microseconds. */
function museLog(): string {
  const event = (body: Record<string, unknown>) => ({ schema_version: 1, recorded_at: AT_US, record_type: 'event', payload_type: 'runtime.session', payload: { event: body, kind: 'run' } });
  return [
    { schema_version: 1, recorded_at: AT_US, payload_type: 'runtime.session.metadata', payload: { kind: 'metadata', record: { workspace_root: TREE } } },
    event({ kind: 'reasoning_summary_committed', text: '' }),
    event({ kind: 'assistant_message_committed', phase: 'commentary', text: 'Reading the issue first.' }),
    event({ kind: 'assistant_tool_calls_committed', tool_calls: [{ args: JSON.stringify({ command: 'gh issue view 694', description: 'Read the issue' }), call_id: 'call_1', id: 'fc_1', name: 'bash' }] }),
    { retained_frame: 'x', children: [{ child_index: 0, record_json: JSON.stringify(event({ kind: 'tool_result_batch_committed', results: [{ text: 'title: the board streams', tool_call_id: 'call_1', tool_call_index: 0 }] })) }] },
    event({ kind: 'assistant_tool_calls_committed', tool_calls: [{ args: JSON.stringify({ path: `${TREE}/src/a.ts` }), call_id: 'call_2', id: 'fc_2', name: 'read_file' }] }),
    event({ kind: 'tool_result_batch_committed', results: [{ text: '1 export {}', tool_call_id: 'call_2', tool_call_index: 0 }] }),
    event({ kind: 'status', text: 'not a message' }),
    event({ kind: 'assistant_message_committed', text: 'Done.' }),
  ].map(line).join('');
}

/** The same session as Grok keeps it: no times. */
function grokLog(): string {
  return [
    { type: 'system', content: 'the system prompt' },
    { type: 'user', content: [{ type: 'text', text: 'the task' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'x', status: 'completed' },
    { type: 'assistant', content: 'Reading the issue first.', tool_calls: [{ id: 'call-1', name: 'run_terminal_command', arguments: JSON.stringify({ command: 'gh issue view 694', description: 'Read the issue' }) }] },
    { type: 'tool_result', tool_call_id: 'call-1', content: 'title: the board streams' },
    { type: 'assistant', content: '', tool_calls: [{ id: 'call-2', name: 'read_file', arguments: JSON.stringify({ target_file: `${TREE}/src/a.ts` }) }] },
    { type: 'tool_result', tool_call_id: 'call-2', content: '1 export {}' },
    { type: 'assistant', content: 'Done.' },
  ].map(line).join('');
}

/** A log file in a new temp folder. */
function writeLog(text: string, name = 'session.jsonl'): string {
  const file = join(makeTempDir('yokoten-stream-'), name);
  writeFileSync(file, text);
  return file;
}

/** A store that finds `file` for every agent, and masks nothing unless told. */
function storeFor(source: StreamSource, file: string, mask = (text: string) => text) {
  return makeStreamStore({}, mask, () => ({ source, file, mtime: 0 }));
}

const SESSION = [
  { kind: 'say', text: 'Reading the issue first.', time: AT },
  { kind: 'tool', tool: 'Bash', text: 'Read the issue', full: 'gh issue view 694', call: 'c1', time: AT },
  { kind: 'result', text: 'title: the board streams', call: 'c1', time: AT },
  { kind: 'tool', tool: 'Read', text: 'read src/a.ts', call: 'c2', time: AT },
  { kind: 'result', text: '1 export {}', call: 'c2', time: AT },
  { kind: 'say', text: 'Done.', time: AT },
];
/** The items without the whole calls, which name each runtime's own tool. */
const withoutFull = (items: { full?: string }[]) => items.map((item, index) => (index === 3 ? { ...item, full: undefined } : item)).map((item) => JSON.parse(JSON.stringify(item)));

// #694: the board reads each runtime's own log, and the page sees one kind of list.
test('board stream: a Claude Code log and a Muse log become the same message list', () => {
  const claude = readStream(storeFor('claude', writeLog(claudeLog())), '~/w', TREE, 'claude-code', '');
  const muse = readStream(storeFor('muse', writeLog(museLog())), '~/w', TREE, 'muse', '');
  assert.equal(claude.source, 'claude');
  assert.equal(muse.source, 'muse');
  assert.deepEqual(withoutFull(claude.items), SESSION);
  assert.deepEqual(withoutFull(muse.items), SESSION);
  assert.equal(claude.reset, true, 'a first read starts the page over');
  assert.equal(claude.next, `${claude.session}:6`);
  // Grok keeps no times; the rest is the same.
  const grok = readStream(storeFor('grok', writeLog(grokLog(), 'chat_history.jsonl')), '~/w', TREE, 'grok', '');
  assert.deepEqual(withoutFull(grok.items), SESSION.map((item) => ({ ...item, time: '' })));
});

// #694: each refresh reads only the new lines, from where the last read stopped.
test('board stream: each read takes only the new lines, and the cursor gets only the new items', () => {
  const file = writeLog(claudeLog());
  const store = storeFor('claude', file);
  const first = readStream(store, '~/w', TREE, 'claude-code', '');
  // The old lines change on disk; a read from the start would see it.
  const old = claudeLog();
  writeFileSync(file, old.replace('Reading the issue first.', 'Rewritten, never re-read.'));
  appendFileSync(file, line({ type: 'assistant', timestamp: AT, message: { content: [{ type: 'text', text: 'One more.' }] } }));
  const second = readStream(store, '~/w', TREE, 'claude-code', first.next);
  assert.equal(second.reset, false);
  assert.deepEqual(second.items.map((item) => item.text), ['One more.']);
  assert.equal(second.next, `${first.session}:7`);
  // A part line waits for its end.
  appendFileSync(file, '{"type":"assistant","timestamp":"x","message":{"content":[{"type":"text","text":"half');
  const third = readStream(store, '~/w', TREE, 'claude-code', second.next);
  assert.deepEqual(third.items, []);
  appendFileSync(file, ' done"}]}}\n');
  assert.deepEqual(readStream(store, '~/w', TREE, 'claude-code', third.next).items.map((item) => item.text), ['half done']);
  // A cursor from another session, or none, gets what the board holds, and starts over.
  const again = readStream(store, '~/w', TREE, 'claude-code', 's99:3');
  assert.equal(again.reset, true);
  assert.equal(again.items.length, 8);
});

test('board stream: a huge log starts near its end, and one read takes at most READ_BYTES', () => {
  const filler = line({ type: 'assistant', timestamp: AT, message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } });
  const file = writeLog(filler.repeat(Math.ceil((START_BYTES * 2) / filler.length)));
  const store = storeFor('claude', file);
  const first = readStream(store, '~/w', TREE, 'claude-code', '');
  assert.equal(first.more, true, 'more is waiting');
  const tail = store.tails.get('~/w');
  assert.ok(tail);
  assert.ok(tail.offset <= Math.ceil((START_BYTES * 2) / filler.length) * filler.length - START_BYTES + READ_BYTES, 'started near the end and read one piece');
  assert.equal(first.items.length, Math.min(SEND_ITEMS, Math.floor(READ_BYTES / filler.length)), 'the cut first line is skipped, and one answer carries at most SEND_ITEMS');
  let cursor = first.next;
  let count = first.items.length;
  for (let read = 0; read < 20; read += 1) {
    const next = readStream(store, '~/w', TREE, 'claude-code', cursor);
    cursor = next.next;
    count += next.items.length;
    if (!next.more) break;
  }
  // Every line of the last START_BYTES reaches the page, none twice, and none drops off the top unsent.
  assert.ok(Math.abs(count - Math.floor(START_BYTES / filler.length)) <= 1, `read the last part of the log once (${count} items)`);
  assert.ok(tail.items.length <= KEEP_ITEMS);
  // A line longer than any message is skipped, and the next one still reads.
  appendFileSync(file, `${'y'.repeat(5 * 1024 * 1024)}\n`);
  appendFileSync(file, line({ type: 'assistant', timestamp: AT, message: { content: [{ type: 'text', text: 'after' }] } }));
  let last: string[] = [];
  for (let read = 0; read < 40; read += 1) {
    const next = readStream(store, '~/w', TREE, 'claude-code', cursor);
    cursor = next.next;
    last = next.items.map((item) => item.text);
    if (!next.more) break;
  }
  assert.deepEqual(last, ['after']);
});

test('board stream: every kept item passes the mask, and no log means the doing steps', () => {
  const store = storeFor('claude', writeLog(claudeLog()), (text) => text.replaceAll('issue', '<mark>'));
  const answer = readStream(store, '~/w', TREE, 'claude-code', '');
  assert.equal(answer.items[0].text, 'Reading the <mark> first.');
  assert.equal(answer.items[1].full, 'gh <mark> view 694');
  const none = readStream(makeStreamStore({}, (text) => text, () => null), '~/w', TREE, 'codex', '');
  assert.deepEqual(none, { source: 'doing', session: '', next: '', reset: true, more: false, items: [] });
});

// #694: a runner's plain text log streams as messages. Only the new lines on each read,
// and a long line is cut like any other message.
test('board stream: a plain log streams only its new lines, each cut when long', () => {
  const file = writeLog('first line\nsecond line\n', 'runner.log');
  const store = makeStreamStore({}, (text) => text, () => ({ source: 'plain', file, mtime: 0 }));
  const first = readStream(store, '~/w', TREE, 'opencode', '');
  assert.equal(first.source, 'plain');
  assert.deepEqual(first.items.map((item) => [item.kind, item.tool, item.text]), [
    ['say', undefined, 'first line'],
    ['say', undefined, 'second line'],
  ]);
  assert.equal(first.next, `${first.session}:2`);
  // Old lines are never read again, only what came after the cursor.
  appendFileSync(file, 'third line\r\n');
  const second = readStream(store, '~/w', TREE, 'opencode', first.next);
  assert.deepEqual(second.items.map((item) => item.text), ['third line'], 'the carriage return is not a message');
  assert.equal(second.reset, false);
  // A line longer than a message is cut, with a note of how much was left out.
  appendFileSync(file, `${'x'.repeat(9000)}\n`);
  const third = readStream(store, '~/w', TREE, 'opencode', second.next);
  assert.equal(third.items.length, 1);
  assert.ok(third.items[0].text.endsWith('… (1000 more characters)'));
  assert.equal(third.items[0].text.startsWith('x'.repeat(100)), true);
});
