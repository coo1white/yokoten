// Tests for src/commands/advice/board/feed/logs.ts: each runtime's log is found from the worktree.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeFolder, claudeTask, findAgentLog, findClaudeLog, findGrokLog, findMuseLog, museRoot, namesTree } from '../../../../../src/commands/advice/board/feed/logs.ts';

/** A file with its folders, last changed `age` ms ago. */
function put(file: string, text: string, age = 0): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  const when = new Date(Date.now() - age);
  utimesSync(file, when, when);
}

const prompt = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

test('board stream logs: the names Claude Code and Muse use for a worktree', () => {
  assert.equal(claudeFolder('/home/a/dev/x.y/.claude/worktrees/hi-1'), '-home-a-dev-x-y--claude-worktrees-hi-1');
  assert.ok(namesTree('Worktree: ~/dev/repo-694 (branch 694)', '/home/a/dev/repo-694', '/home/a'));
  assert.ok(namesTree('cd /home/a/dev/repo-694/src', '/home/a/dev/repo-694', '/home/a'));
  assert.ok(!namesTree('Worktree: ~/dev/repo-6945', '/home/a/dev/repo-694', '/home/a'), 'a longer name is another worktree');
  assert.equal(claudeTask(`${JSON.stringify({ type: 'attachment' })}\n${prompt('the task')}`), 'the task');
  assert.equal(museRoot('{"payload":{"kind":"metadata","record":{"workspace_root":"/w/a\\"b"}}}'), '/w/a"b');
  assert.equal(museRoot('{}'), '');
});

// #694: a Claude Code agent's own sessions, or a subagent of a lead elsewhere whose task names the worktree.
test('board stream logs: Claude Code, its own newest session, or a subagent whose task names the worktree', () => {
  const home = mkdtempSync(join(tmpdir(), 'yokoten-logs-'));
  const tree = join(home, 'dev', 'repo-694');
  const projects = join(home, '.claude', 'projects');
  const env = { HOME: home };
  assert.equal(findClaudeLog(tree, env, new Map()), null, 'no log yet');
  put(join(projects, claudeFolder(tree), 'old.jsonl'), prompt('old'), 60000);
  put(join(projects, claudeFolder(tree), 'new.jsonl'), prompt('new'), 30000);
  assert.equal(findClaudeLog(tree, env, new Map())?.file, join(projects, claudeFolder(tree), 'new.jsonl'));
  const lead = join(projects, claudeFolder(join(home, 'dev')), 'lead-1', 'subagents');
  put(join(lead, 'agent-other.jsonl'), prompt('Worktree: ~/dev/repo-695'), 0);
  put(join(lead, 'agent-mine.jsonl'), prompt('Worktree: ~/dev/repo-694. Work only there.'), 1000);
  const cache = new Map();
  const found = findClaudeLog(tree, env, cache);
  assert.deepEqual([found?.source, found?.file], ['claude', join(lead, 'agent-mine.jsonl')], 'the newest log that belongs to the worktree');
  assert.equal(cache.get(join(lead, 'agent-other.jsonl')), false, 'whose a log is, is kept');
  // A desk's own state folder counts too (#637).
  put(join(`${tree}.state`, 'claude-code', 'projects', claudeFolder(tree), 'desk.jsonl'), prompt('desk'), 0);
  assert.equal(findClaudeLog(tree, env, new Map())?.file, join(`${tree}.state`, 'claude-code', 'projects', claudeFolder(tree), 'desk.jsonl'));
});

test('board stream logs: Muse by its workspace, Grok by its folder, Codex not yet', () => {
  const home = mkdtempSync(join(tmpdir(), 'yokoten-logs-'));
  const tree = join(home, 'dev', 'repo-694');
  const env = { HOME: home };
  const sessions = join(home, '.local', 'share', 'muse', 'sessions', '2026', '10', '22');
  const meta = (root: string) => `${JSON.stringify({ payload: { kind: 'metadata', record: { workspace_root: root } } })}\n`;
  put(join(sessions, 'a', 'session.jsonl'), meta(tree), 5000);
  put(join(sessions, 'b', 'session.jsonl'), meta(join(home, 'dev', 'other')), 0);
  assert.equal(findMuseLog(tree, env, new Map())?.file, join(sessions, 'a', 'session.jsonl'));
  assert.equal(findMuseLog(join(home, 'none'), env, new Map()), null);
  const grok = join(home, '.grok', 'sessions', encodeURIComponent(tree), 's1', 'chat_history.jsonl');
  put(grok, '');
  assert.equal(findGrokLog(tree, env)?.file, grok);
  assert.equal(findAgentLog(tree, 'grok', env, new Map())?.source, 'grok');
  assert.equal(findAgentLog(tree, 'muse', env, new Map())?.source, 'muse');
  assert.equal(findAgentLog(tree, 'codex', env, new Map()), null, 'no Codex reader yet: the doing steps show');
  assert.equal(findAgentLog(tree, '', env, new Map())?.source, 'grok', 'an unnamed vendor gets the newest log of any runtime');
  assert.equal(findAgentLog(tree, 'muse', {}, new Map()), null, 'no home folder, no log');
});
