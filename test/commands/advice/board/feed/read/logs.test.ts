// Tests for src/commands/advice/board/feed/read/logs.ts: each runtime's log is found from the worktree.

import '../../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir } from '../../../../../repo/helpers.ts';
import { claudeFolder, claudeTask, findAgentLog, findClaudeLog, findGrokLog, findMuseLog, LEAD_SESSION_FILE, museRoot, namesTree } from '../../../../../../src/commands/advice/board/feed/read/logs.ts';

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
  const home = makeTempDir('yokoten-logs-');
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
  const home = makeTempDir('yokoten-logs-');
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
  assert.equal(findAgentLog(tree, 'codex', env, new Map()), null, 'no rollout yet: the doing steps show');
  assert.equal(findAgentLog(tree, '', env, new Map())?.source, 'grok', 'an unnamed vendor gets the newest log of any runtime');
  assert.equal(findAgentLog(tree, 'muse', {}, new Map()), null, 'no home folder, no log');
});

// #698: Codex rollouts live in sessions/year/month/day. DeepSeek reads that log, not another runtime's.
test('board stream logs: a Codex rollout by its cwd, for Codex and DeepSeek', () => {
  const home = makeTempDir('yokoten-logs-');
  const tree = join(home, 'dev', 'repo');
  const env = { HOME: home };
  const day = join(home, '.codex', 'sessions', '2026', '10', '22');
  const meta = (cwd: string) => `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n`;
  put(join(day, 'rollout-old.jsonl'), meta(tree), 5000);
  put(join(day, 'notes.txt'), meta(tree), 0);
  put(join(day, 'rollout-other.jsonl'), meta(join(home, 'dev', 'other')), 0);
  put(join(day, 'rollout-new.jsonl'), meta(tree), 1000);
  assert.equal(findAgentLog(tree, 'codex', env, new Map())?.file, join(day, 'rollout-new.jsonl'));
  const alt = join(home, 'codex-home', 'sessions', '2026', '10', '23');
  put(join(alt, 'rollout-home.jsonl'), meta(tree), 0);
  assert.equal(findAgentLog(tree, 'deepseek', { HOME: home, CODEX_HOME: join(home, 'codex-home') }, new Map())?.file, join(alt, 'rollout-home.jsonl'));
  const desk = join(`${tree}.state`, 'codex', 'sessions', '2026', '10', '23');
  put(join(desk, 'rollout-desk.jsonl'), meta(tree), 0);
  assert.equal(findAgentLog(tree, 'deepseek-harness', env, new Map())?.file, join(desk, 'rollout-desk.jsonl'));
  put(join(home, '.claude', 'projects', claudeFolder(tree), 's.jsonl'), prompt('hi'), 0);
  const deepseek = findAgentLog(tree, 'deepseek', env, new Map());
  assert.equal(deepseek?.source, 'codex', 'DeepSeek does not take another runtime\'s log');
  assert.equal(deepseek?.file, join(desk, 'rollout-desk.jsonl'));
});

// #700: the main checkout's lead log is the registered path, when that path stays inside
// Claude's projects folder. A path that escapes, a symlink out, or a non-jsonl file is
// refused, and the folder search runs as before. A missing file does the same.
test('board stream logs: a registered lead log wins, and a bad path falls back (#700)', () => {
  const sandbox = makeSandbox();
  const home = sandbox.home;
  const tree = sandbox.repo;
  const env = sandbox.env;
  const projects = join(home, '.claude', 'projects');
  const own = join(projects, claudeFolder(tree), 'old.jsonl');
  put(own, prompt('old'), 0);
  assert.equal(findClaudeLog(tree, env, new Map())?.file, own, 'no registration file: the folder search');
  const live = join(projects, claudeFolder(join(home, 'parent')), 'live.jsonl');
  put(live, prompt('live'), 60000);
  const file = join(tree, '.git', LEAD_SESSION_FILE);
  const point = (path: string) => writeFileSync(file, `${path}\n`, { mode: 0o600 });
  point(live);
  // macOS temp is a symlink, so the registered file's real path can differ from `live`.
  const registered = findClaudeLog(tree, env, new Map());
  assert.equal(registered ? realpathSync(registered.file) : '', realpathSync(live), 'the registered log, even when an older log in the repo folder is newer');
  const outside = join(home, 'escape.jsonl');
  put(outside, prompt('out'));
  point(`${projects}/../../escape.jsonl`);
  assert.equal(findClaudeLog(tree, env, new Map())?.file, own, 'a .. path that leaves the projects folder');
  const link = join(projects, 'link.jsonl');
  symlinkSync(outside, link);
  point(link);
  assert.equal(findClaudeLog(tree, env, new Map())?.file, own, 'a symlink that points out');
  const notes = join(projects, 'notes.txt');
  put(notes, 'notes');
  point(notes);
  assert.equal(findClaudeLog(tree, env, new Map())?.file, own, 'not a jsonl file');
  point(join(projects, 'gone.jsonl'));
  assert.equal(findClaudeLog(tree, env, new Map())?.file, own, 'a path that is not there');
  rmSync(file);
  assert.equal(findClaudeLog(tree, env, new Map())?.file, own, 'no registration file');
  point(live);
  sandbox.write('a.md', 'a\n');
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'start').status, 0);
  const worktree = join(makeTempDir('yokoten-wt-'), 'wt');
  assert.equal(sandbox.git('worktree', 'add', '-q', '-b', 'lead-700', worktree).status, 0);
  assert.notEqual(findClaudeLog(worktree, env, new Map())?.file, live, 'a worktree does not take the main checkout\'s lead log');
});
