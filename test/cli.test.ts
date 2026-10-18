// End to end: the CLI in throwaway git repos, the way a hook or CI runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'yokoten.ts');
const at = '@';

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  // A clean environment: no real HOME, no real marks, no role, and commit times in UTC
  // whatever the machine's time zone (#40).
  const env = { PATH: process.env.PATH, HOME: home, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', `1+test${at}users.noreply.github.com`);
  const run = (args: string[], { input, cwd = repo, extra = {} }: { input?: string; cwd?: string; extra?: Record<string, string> } = {}) => spawnSync('node', [CLI, ...args], { cwd, env: { ...env, ...extra }, input, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  // The tests step (#55): a test script, and a workflow that runs it.
  const withTests = () => {
    write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    write('.github/workflows/test.yml', 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
  };
  return { home, repo, env, git, run, write, withTests };
}

test('hook: blocks with exit 2 and a reason, allows with exit 0', () => {
  const s = sandbox();
  const call = (tool_input: object, extra?: Record<string, string>) => s.run(['hook'], { input: JSON.stringify({ cwd: s.repo, tool_input }), extra });
  let r = call({ command: 'git push --tags' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /owner decides when to release/);
  assert.equal(call({ command: 'git status' }).status, 0);
  assert.equal(call({ file_path: join(s.repo, 'AGENTS.md') }).status, 0);
  r = call({ file_path: join(s.repo, 'AGENTS.md') }, { YOKOTEN_ROLE: 'worker' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /lead-only/);
  // A worker subagent is a worker even in a lead session.
  r = s.run(['hook'], { input: JSON.stringify({ cwd: s.repo, agent_type: 'worker', tool_input: { file_path: 'CLAUDE.md' } }) });
  assert.equal(r.status, 2);
  // The user-level guard leaves files to the project.
  r = s.run(['hook', '--commands-only'], { input: JSON.stringify({ cwd: s.repo, tool_input: { file_path: 'CLAUDE.md' } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(r.status, 0);
  assert.equal(s.run(['hook'], { input: 'not json' }).status, 0);
});

// The Stop event is shaped as Claude Code's hook docs show it (code.claude.com/docs/en/hooks#stop).
test('hook --stop: sends the agent back once with the findings in changed files, never twice (#92)', () => {
  const s = sandbox();
  const stop = (active = false, extra?: Record<string, string>) =>
    s.run(['hook', '--stop'], { input: JSON.stringify({ session_id: 'abc123', cwd: s.repo, hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: 'done' }), extra });
  s.write('a.md', 'fine\n');
  s.git('add', '.');
  s.git('commit', '-qm', 'start');
  // Clean: the turn ends.
  let r = stop();
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  // A fake secret in a new, untracked file, written by a script the tool hook never saw.
  const key = `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}`;
  s.write('scripts/out.txt', `${key}\n`);
  r = stop();
  assert.equal(r.status, 2, 'blocked');
  assert.match(r.stderr, /^yokoten: 1 problem\(s\) in the changed files\. Fix them before you end the turn:\n- scripts\/out\.txt:1: a secret \(AWS access key id\)\. .+\. .+\.\n$/);
  assert.ok(!r.stderr.includes(key), 'the secret is never printed');
  assert.equal(r.stdout, '', 'stdout stays empty for the runtime');
  // Already sent back once: the turn ends, whatever is found. No loop.
  r = stop(true);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  // Staged and changed files count too; a lead-only file only for a worker.
  rmSync(join(s.repo, 'scripts'), { recursive: true });
  s.write('a.md', `mail me${at}gmail.com\n`);
  assert.match(stop().stderr, /a\.md:1: an email/);
  s.write('a.md', 'fine\n');
  s.write('AGENTS.md', '# rules\n');
  s.git('add', 'AGENTS.md');
  assert.equal(stop().status, 0);
  r = stop(false, { YOKOTEN_ROLE: 'worker' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /AGENTS\.md is lead-only/);
  // --json: the same Finding shape.
  r = s.run(['hook', '--stop', '--json'], { input: JSON.stringify({ cwd: s.repo, stop_hook_active: false }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.blocked, out.stop, out.findings[0].id], [true, true, 'lead-only']);
  for (const k of ['what', 'why', 'fix']) assert.ok(out.findings[0][k]);
  // Not a Stop event, or not a repo: the turn ends.
  for (const input of ['not json', '', 'null', '[1]']) assert.equal(s.run(['hook', '--stop'], { input }).status, 0, input);
  const away = mkdtempSync(join(tmpdir(), 'yokoten-away-'));
  assert.equal(s.run(['hook', '--stop'], { input: JSON.stringify({ cwd: away }) }).status, 0);
  // A broken config is an internal error: the turn ends, with one line on stderr.
  s.write('yokoten.json', '{ broken');
  r = s.run(['hook', '--stop'], { input: JSON.stringify({ cwd: s.repo }) });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^yokoten hook --stop: skipped, [^\n]+\n$/);
  // --stop is for Claude Code's Stop event only.
  assert.equal(s.run(['hook', '--stop', '--agent', 'codex'], { input: '{}' }).status, 1);
  assert.equal(s.run(['hook', '--stop', '--commands-only'], { input: '{}' }).status, 1);
});

// Each call is shaped as the runtime's hook docs show it (#30): Codex's PreToolUse
// (developers.openai.com/codex/hooks) and Gemini CLI's BeforeTool (geminicli.com/docs/hooks).
test('hook --agent codex: shell calls by command, apply_patch by the files it touches (#30)', () => {
  const s = sandbox();
  const call = (tool_name: string, command: string, extra?: Record<string, string>) =>
    s.run(['hook', '--agent', 'codex'], {
      input: JSON.stringify({
        session_id: 'thr_123',
        transcript_path: null,
        cwd: s.repo,
        hook_event_name: 'PreToolUse',
        model: 'gpt-5',
        permission_mode: 'default',
        turn_id: 'turn_1',
        tool_name,
        tool_use_id: 'call_1',
        tool_input: { command },
      }),
      extra,
    });
  let r = call('Bash', 'git push --tags');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /owner decides when to release/);
  assert.equal(call('Bash', 'git status').status, 0);
  const patch = (header: string) => `*** Begin Patch\n${header}\n@@\n-old\n+new\n*** End Patch\n`;
  const worker = { YOKOTEN_ROLE: 'worker' };
  r = call('apply_patch', patch('*** Update File: AGENTS.md'), worker);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /lead-only/);
  assert.equal(call('apply_patch', patch('*** Update File: src/a.ts\n*** Move to: .codex/hooks.json'), worker).status, 2, 'a move into a lead-only path');
  assert.equal(call('apply_patch', patch(`*** Add File: ${join(s.repo, '.github', 'x.yml')}`), worker).status, 2, 'an absolute path');
  assert.equal(call('apply_patch', patch('*** Update File: src/a.ts'), worker).status, 0);
  assert.equal(call('apply_patch', patch('*** Update File: AGENTS.md')).status, 0, 'the lead may');
  // A patch is not a command, and an unknown tool is neither.
  assert.equal(call('apply_patch', 'git push --tags').status, 0);
  assert.equal(call('mcp__fs__write', 'git push --tags').status, 0);
});

test('hook --agent gemini: run_shell_command by command, write_file and replace by file_path (#30)', () => {
  const s = sandbox();
  const call = (tool_name: string, tool_input: object, extra?: Record<string, string>) =>
    s.run(['hook', '--agent', 'gemini'], {
      input: JSON.stringify({
        session_id: 's1',
        transcript_path: join(s.home, 't.json'),
        cwd: s.repo,
        hook_event_name: 'BeforeTool',
        timestamp: '2026-10-18T00:00:00Z',
        tool_name,
        tool_input,
      }),
      extra,
    });
  let r = call('run_shell_command', { command: 'git push --tags', description: 'push tags' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /owner decides when to release/);
  assert.equal(r.stdout, '', 'Gemini CLI reads stdout as JSON: nothing else goes there');
  assert.equal(call('run_shell_command', { command: 'git status' }).status, 0);
  const worker = { YOKOTEN_ROLE: 'worker' };
  r = call('write_file', { file_path: join(s.repo, 'AGENTS.md'), content: 'x' }, worker);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /lead-only/);
  assert.equal(call('replace', { file_path: '.gemini/settings.json', instruction: 'i', old_string: 'a', new_string: 'b' }, worker).status, 2);
  assert.equal(call('write_file', { file_path: 'src/a.ts', content: 'x' }, worker).status, 0);
  assert.equal(call('read_file', { file_path: 'AGENTS.md' }, worker).status, 0, 'reading is not editing');
  assert.equal(call('write_file', { file_path: 'AGENTS.md', content: 'x' }).status, 0, 'the lead may');
  r = s.run(['hook', '--agent', 'cursor'], { input: '{}' });
  assert.equal(r.status, 1, 'an unknown agent is an error to see, not a block');
  assert.match(r.stderr, /claude-code, codex, gemini/);
});

test('hook: a repo reached through a symlink gets the same file rules (#1)', () => {
  const s = sandbox();
  const link = join(s.home, 'link');
  symlinkSync(s.repo, link);
  const call = (file_path: string) => s.run(['hook'], { input: JSON.stringify({ cwd: link, tool_input: { file_path } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(call(join(link, 'AGENTS.md')).status, 2, 'absolute path through the link');
  assert.equal(call('AGENTS.md').status, 2, 'relative to a cwd through the link');
  assert.equal(call(join(link, '.github', 'new', 'x.yml')).status, 2, 'a file in a folder that does not exist yet');
  assert.equal(call(join(s.home, 'elsewhere.md')).status, 0, 'outside the repo');
});

test('check --staged: stops a commit with a personal email or a private mark', () => {
  const s = sandbox();
  const marks = join(s.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  s.write('src/a.md', 'fine\n');
  s.git('add', '.');
  assert.equal(s.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } }).status, 0);
  s.write('src/b.md', `write to me${at}gmail.com\nI live in MyCity\n`);
  s.git('add', '.');
  const r = s.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/b\.md:1: an email/);
  assert.match(r.stderr, /src\/b\.md:2: matches a line of your private-marks file/);
  assert.ok(!/mycity/i.test(r.stderr));
});

test('check --staged: stops build output and binaries, lets images and allowed paths through (#56)', () => {
  const s = sandbox();
  s.write('dist/app.js', 'console.log(1);\n');
  writeFileSync(join(s.repo, 'tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 0]));
  writeFileSync(join(s.repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  s.git('add', '.');
  let r = s.run(['check', '--staged']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dist\/app\.js: build output, in a dist\/ folder\./);
  assert.match(r.stderr, /tool: a binary file\. A reviewer can't read it/);
  assert.ok(!r.stderr.includes('logo.png'), 'an image is fine');
  s.write('yokoten.json', JSON.stringify({ allowBuild: ['dist/**', 'tool'] }));
  s.git('add', '.');
  r = s.run(['check', '--staged']);
  assert.equal(r.status, 0, r.stderr);
});

test('doctor: the no-build-output step looks at the tracked files (#56)', () => {
  const s = sandbox();
  const line = () => s.run(['doctor']).stdout.split('\n').find((l) => / no-build-output/.test(l)) ?? '';
  assert.match(line(), /^ +done +no-build-output/);
  s.write('build/a.js', 'x\n');
  s.write('lib/x.so', 'x\n');
  s.git('add', '.');
  assert.match(line(), /^ +to do +no-build-output \(Scorecard: Binary-Artifacts\): build output in the repo \(build\/a\.js, lib\/x\.so\)/);
  s.write('yokoten.json', JSON.stringify({ allowBuild: ['build/**', 'lib/**'] }));
  assert.match(line(), /^ +done +no-build-output/);
});

test('check --staged: stops a commit whose time carries a time zone, never printing it (#40)', () => {
  const s = sandbox();
  s.write('a.md', 'fine\n');
  s.git('add', '.');
  const zoned = { GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' };
  let r = s.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  assert.ok(!/0700/.test(r.stderr), 'the offset is never printed');
  assert.equal(s.run(['check', '--staged'], { extra: { GIT_AUTHOR_DATE: '2026-10-18T02:00:00+0000' } }).status, 0);
  // A project can turn it off.
  s.write('yokoten.json', JSON.stringify({ privacy: { utc: false } }));
  s.git('add', '.');
  r = s.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 0, r.stderr);
});

test('check --history: counts commits with a time zone, as a note that does not fail (#40)', () => {
  const s = sandbox();
  s.git('commit', '-q', '--allow-empty', '-m', 'utc');
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'zoned'], { cwd: s.repo, env: { ...s.env, TZ: 'Asia/Tokyo' } });
  const r = s.run(['check', '--history']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 1 commit\(s\) record a time zone other than UTC/);
});

test('check --history: finds what a later commit deleted, and a personal author email', () => {
  const s = sandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  s.write('notes.md', `server ${[10, 1, 2, 3].join('.')}\ntoken ${token}\n`);
  s.git('add', '.');
  s.git('commit', '-qm', 'add notes');
  s.git('rm', '-q', 'notes.md');
  s.git('commit', '-qm', 'remove notes');
  s.git('-c', `user.email=me${at}gmail.com`, 'commit', '-q', '--allow-empty', '-m', 'oops');
  assert.equal(s.run(['check']).status, 0, 'the tree today is clean');
  const r = s.run(['check', '--history']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /notes\.md @ blob \w+:1: an IP address/);
  assert.match(r.stderr, /notes\.md @ blob \w+:2: a secret \(GitHub token\)/, 'a secret deleted later (#8)');
  assert.ok(!r.stderr.includes(token), 'the secret is never printed');
  assert.match(r.stderr, /\(author\/committer\):1: an email/);
});

test('init: adds the practices, keeps what is there, and doctor goes on to stage 4', () => {
  const s = sandbox();
  s.write('AGENTS.md', '# our own rules\n');
  s.write('.github/SECURITY.md', '# email us\n');
  // The user's own Codex and Gemini CLI settings stay.
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  s.write('.codex/hooks.json', JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  s.write('.gemini/settings.json', JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  assert.match(s.run(['doctor']).stdout, /note +codex-hook: no tool-call guard/, 'reported, not counted as missing');
  let r = s.run(['init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept AGENTS\.md/);
  assert.match(r.stdout, /wrote \.githooks\/pre-commit/);
  assert.equal(readFileSync(join(s.repo, 'AGENTS.md'), 'utf8'), '# our own rules\n');
  assert.match(r.stdout, /kept \.github\/SECURITY\.md/);
  assert.equal(readFileSync(join(s.repo, '.github/SECURITY.md'), 'utf8'), '# email us\n', 'the project\'s own policy stays');
  assert.match(r.stdout, /wrote \.github\/dependabot\.yml/);
  assert.match(r.stdout, /wrote CHANGELOG\.md/);
  assert.match(readFileSync(join(s.repo, 'CHANGELOG.md'), 'utf8'), /^## \[Unreleased\]$/m, 'the changelog skeleton (#34)');
  assert.ok(statSync(join(s.repo, '.githooks', 'pre-commit')).mode & 0o100);
  const workflow = readFileSync(join(s.repo, '.github/workflows/yokoten.yml'), 'utf8');
  assert.match(workflow, /node \.yokoten\/bin\/yokoten\.ts check/);
  assert.match(workflow, /persist-credentials: false/, 'the hardened workflow (#36)');
  assert.match(workflow, /^  ci:\n    if: always\(\)\n    needs: \[check, lint\]$/m, 'one required check that waits for the rest (#36)');
  assert.match(readFileSync(join(s.repo, '.github/workflows/pr.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --pr/, 'the pull request check (#47)');
  assert.match(readFileSync(join(s.repo, '.github/workflows/issue.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --issue/, 'the issue title check');
  assert.ok(existsSync(join(s.repo, '.yokoten', 'VERSION')));
  assert.equal(s.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  // Again: nothing changes.
  r = s.run(['init']);
  assert.match(r.stdout, /kept \.github\/SECURITY\.md/);
  assert.match(r.stdout, /kept \.github\/dependabot\.yml/);
  assert.match(r.stdout, /kept CHANGELOG\.md/);
  assert.match(r.stdout, /same the tool-call hook/);
  assert.match(r.stdout, /same TZ=UTC for agent sessions/);
  const settings = JSON.parse(readFileSync(join(s.repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(r.stdout, /same the stop check/);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --stop' }] }], 'the stop check, once (#92)');
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  assert.match(r.stdout, /same the Codex tool-call hook/);
  assert.match(r.stdout, /same the Gemini CLI tool-call hook/);
  const codex = JSON.parse(readFileSync(join(s.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.equal(codex.hooks.PreToolUse.length, 2);
  assert.deepEqual(codex.hooks.PreToolUse[1], {
    hooks: [{ type: 'command', command: 'node "$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts" hook --agent codex' }],
    matcher: 'Bash|apply_patch',
  });
  const gemini = JSON.parse(readFileSync(join(s.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.deepEqual(gemini.hooks.BeforeTool[1], {
    hooks: [{ type: 'command', command: 'node "$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --agent gemini', name: 'yokoten' }],
    matcher: 'run_shell_command|write_file|replace',
  });
  assert.match(s.run(['doctor']).stdout, /ok +codex-hook\n +ok +gemini-hook/);
  // The pre-commit hook runs the vendored check on a real commit.
  s.git('add', '.');
  const commit = s.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  s.write('leak.md', `me${at}gmail.com\n`);
  s.git('add', 'leak.md');
  assert.notEqual(s.git('commit', '-qm', 'leak').status, 0);
  s.write('leak.md', `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}\n`);
  s.git('add', 'leak.md');
  const secret = s.git('commit', '-qm', 'leak');
  assert.notEqual(secret.status, 0, 'a secret is refused too (#8)');
  assert.match(secret.stderr, /leak\.md:1: a secret \(AWS access key id\)/);
  s.git('reset', '-q', 'leak.md');
  // init does all of stages 1 to 3 but the tests, so with tests the road goes on to stage 4.
  assert.match(s.run(['doctor', '--session']).stdout, /^yokoten: stage 1 of 5, safety net\. Next: no test command/);
  s.withTests();
  r = s.run(['doctor', '--session']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^yokoten: stage 4 of 5, a team of agents\. Next: no CODEOWNERS file/);
});

test('init: safe defaults, Dependabot and a security policy; doctor lists the security switches (#35)', () => {
  const s = sandbox();
  const r = s.run(['init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote \.github\/SECURITY\.md/);
  assert.match(r.stdout, /wrote \.github\/dependabot\.yml/);
  const dependabot = readFileSync(join(s.repo, '.github/dependabot.yml'), 'utf8');
  for (const line of [/package-ecosystem: github-actions/, /interval: monthly/, /default-days: 7/, /patterns: \['\*'\]/, /prefix: ci/]) assert.match(dependabot, line);
  assert.equal([...dependabot.matchAll(/^\s*- package-ecosystem:/gm)].length, 1, 'actions only, since the stack is unknown');
  assert.match(readFileSync(join(s.repo, '.github/SECURITY.md'), 'utf8'), /\*\*Report a vulnerability\*\*/);
  const doctor = s.run(['doctor']);
  for (const sw of [/private vulnerability reporting/, /secret scanning with push protection/, /Dependabot alerts/]) assert.match(doctor.stdout, sw);
});

// The road (record 0004). A session hears three lines about one step; the marks file is
// set so that the private-marks note does not add a fourth.
test('doctor --session: exactly three lines, about the first step of the first stage not done', () => {
  const s = sandbox();
  const marks = join(s.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const r = s.run(['doctor', '--session'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 0, 'a session always starts');
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'yokoten: stage 1 of 5, safety net. Next: no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one.',
    'Why: an agent follows the rules it can read, and only those.',
    'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).',
  ]);
  // Outside a repo it says nothing (unless yokoten itself is broken).
  assert.equal(s.run(['doctor', '--session'], { cwd: s.home }).stdout, '');
});

test('doctor --session: "not now" skips a step, by the names yokoten.json already uses', () => {
  const s = sandbox();
  const next = () => s.run(['doctor', '--session']).stdout.split('\n')[0];
  s.write('yokoten.json', JSON.stringify({ notNow: { rules: 'our rules live in the wiki for now' } }));
  assert.match(next(), /stage 1 of 5, safety net\. Next: no tool-call guard/);
  s.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e' } }));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run/, 'a stage with every step not now is passed');
  s.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e', ci: 'no remote yet', issues: 'f' } }));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: no issue templates and no pull request template/);
  const full = s.run(['doctor']).stdout;
  assert.match(full, /^ +not now +ci \(Scorecard: CI-Tests\): no remote yet$/m, 'the full map shows the reason');
  assert.match(full, /^ +next +templates \(GitHub community profile\): /m);
  assert.match(full, /^ +to do +changelog \(Best Practices: release_notes\): /m);
  assert.match(full, /^ +to do +titles \(Conventional Commits 1\.0\.0\): CI does not check pull requests/m);
});

test('doctor: each stage boundary, from a fresh repo to the end of the road', () => {
  const s = sandbox();
  const marks = join(s.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const key = join(s.home, 'bot.pem');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  const session = (more: Record<string, string> = {}) => s.run(['doctor', '--session'], { extra: { ...extra, ...more } }).stdout.trimEnd().split('\n');
  const next = (more?: Record<string, string>) => session(more)[0];
  assert.match(next(), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  // Stage 1 done, stage 2 not: init without its CI workflow.
  assert.equal(s.run(['init']).status, 0);
  s.withTests();
  rmSync(join(s.repo, '.github', 'workflows', 'yokoten.yml'));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run `yokoten check`/, 'the pull request check alone is not the CI check');
  s.write('TODO.md', '- one\n');
  s.run(['init']);
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: a todo file \(TODO\.md\)/);
  rmSync(join(s.repo, 'TODO.md'));
  // Stage 2 done. init wrote a changelog; without it, stage 3 is next.
  rmSync(join(s.repo, 'CHANGELOG.md'));
  assert.match(next(), /stage 3 of 5, release\. Next: no CHANGELOG\.md/);
  s.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
  // Stage 3 done.
  assert.match(next(), /stage 4 of 5, a team of agents\. Next: no CODEOWNERS file/);
  s.write('.github/CODEOWNERS', '* @placeholder\n');
  assert.match(next(), /stage 4 of 5, a team of agents\. Next: no bot on this machine/);
  writeFileSync(key, 'not a real key\n');
  const bot = { YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key };
  assert.match(next(bot), /stage 4 of 5, a team of agents\. Next: the yokoten skills are not in/);
  assert.equal(s.run(['install']).status, 0);
  // Stage 4 done. init writes a security policy and Dependabot; the license is the owner's choice.
  assert.match(next(bot), /stage 5 of 5, going public\. Next: no license file; /);
  s.write('LICENSE', 'placeholder license\n');
  assert.deepEqual(session(bot), ['yokoten: every step yokoten can check is done, or marked not now.']);
  // The order is advice, not a gate: a later step done early counts as done.
  rmSync(join(s.repo, 'AGENTS.md'));
  assert.match(next(bot), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  assert.match(s.run(['doctor'], { extra: { ...extra, ...bot } }).stdout, /^ +done +security-files \(Scorecard: Security-Policy · OSPS-VM-02\.01\)$/m, 'full doctor names the outside standard (#58)');
});

test('doctor: the tests step wants a test command and a CI step that runs it (#55)', () => {
  const s = sandbox();
  const line = () => s.run(['doctor']).stdout.split('\n').find((l) => / tests\b/.test(l)) ?? '';
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  // npm's placeholder script only fails: it is no test command.
  s.write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  s.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): CI does not run the tests/);
  s.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npm run test\n');
  assert.match(line(), /^ +done +tests/);
  // A project with no package.json: CI that runs a test runner is enough.
  rmSync(join(s.repo, 'package.json'));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  s.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: go test ./...\n');
  assert.match(line(), /^ +done +tests/);
});

test('install: skills, agents and hooks once, the user\'s own files untouched', () => {
  const s = sandbox();
  const claude = join(s.home, '.claude');
  const shared = join(s.home, '.agents');
  mkdirSync(join(claude, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'agents', 'reviewer.md'), 'my own reviewer\n');
  // The user's own skill in the shared folder, with a kit skill's name.
  mkdirSync(join(shared, 'skills', 'rca'), { recursive: true });
  writeFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'my own rca\n');
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }));
  let r = s.run(['install']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept \(yours\) agent reviewer/);
  assert.equal(readFileSync(join(claude, 'agents', 'reviewer.md'), 'utf8'), 'my own reviewer\n');
  // Every skill in both folders: Claude Code's, and the shared one other agents read (#29).
  const kitSkills = readdirSync(join(s.home, '.local/share/yokoten/kit/user/skills'));
  assert.ok(kitSkills.includes('release'), 'the release skill (#34)');
  // The release skill leaves the tag to the owner: the tag command it gives is stopped for an agent.
  const tagLine = readFileSync(join(claude, 'skills', 'release', 'SKILL.md'), 'utf8').match(/`(git tag [^`]+)`/);
  assert.ok(tagLine);
  assert.equal(s.run(['hook'], { input: JSON.stringify({ cwd: s.repo, tool_input: { command: tagLine[1].replaceAll('X.Y.Z', '1.2.3') } }) }).status, 2);
  for (const name of kitSkills) {
    assert.ok(existsSync(join(claude, 'skills', name, 'SKILL.md')), `~/.claude/skills/${name}`);
    assert.ok(existsSync(join(shared, 'skills', name, 'SKILL.md')), `~/.agents/skills/${name}`);
    assert.match(r.stdout, new RegExp(`wrote skill ${name} in ~/\\.claude/skills`));
  }
  assert.match(r.stdout, /kept \(yours\) skill rca in ~\/\.agents\/skills/);
  assert.equal(readFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'utf8'), 'my own rca\n');
  assert.ok(!existsSync(join(shared, 'agents')), 'agents stay Claude-only');
  const marks = join(s.home, '.config/yokoten/private-marks');
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  r = s.run(['install']);
  for (const name of kitSkills) assert.match(r.stdout, new RegExp(`same skill ${name} in ~/\\.claude/skills`));
  for (const name of kitSkills.filter((n) => n !== 'rca')) assert.match(r.stdout, new RegExp(`same skill ${name} in ~/\\.agents/skills`));
  assert.match(r.stdout, /kept \(yours\) skill rca in ~\/\.agents\/skills/);
  const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'x');
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.Stop, undefined, "the stop check reads files, so it is per project, from init (#92)");
  // The installed copy runs on its own.
  const doctor = spawnSync('node', [join(s.home, '.local/share/yokoten/bin/yokoten.ts'), 'doctor', '--session'], { cwd: s.repo, env: s.env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /private-marks is missing or empty/);
  // The home folder names the machine's user; it never shows (#25).
  for (const out of [r.stdout, doctor.stdout]) assert.ok(!out.includes(s.home), 'output shows the home path');
  assert.match(doctor.stdout, /~\/\.config\/yokoten\/private-marks/);
  // The skills check wants every skill in both folders, and names what is missing.
  // Skills are a step on the road, stage 4.
  const skillsLine = () => s.run(['doctor']).stdout.split('\n').find((l) => / skills/.test(l)) ?? '';
  assert.match(skillsLine(), /^\s+done\s+skills$/);
  rmSync(join(shared, 'skills', 'inspect'), { recursive: true });
  assert.match(skillsLine(), /^\s+(next|to do)\s+skills: the yokoten skills are not in ~\/\.agents\/skills \(inspect\); run `yokoten install`$/);
});

test('check --pr: reads the CI event, lists the changed files from git, notes long prose (#47)', () => {
  const s = sandbox();
  s.write('README.md', 'Short.\n');
  s.git('add', '.');
  s.git('commit', '-qm', 'base');
  const base = s.git('rev-parse', 'HEAD').stdout.trim();
  s.write('src/a.ts', 'export const a = 1;\n');
  s.write('README.md', `Short.\n${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`);
  s.git('add', '.');
  s.git('commit', '-qm', 'head');
  const head = s.git('rev-parse', 'HEAD').stdout.trim();
  const event = (body: string) => {
    const file = join(s.home, 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n';
  let r = s.run(['check', '--pr'], { extra: event(body) });
  assert.equal(r.status, 1, 'src/a.ts changed with no changelog line');
  assert.match(r.stderr, /changelog: 1 changed file/);
  assert.match(r.stdout, /note: 1 long sentence\(s\)\n- README\.md:2: a sentence of 30 words/);
  r = s.run(['check', '--pr'], { extra: event(`${body}No changelog: a test\n`) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check --pr: ok/);
  assert.doesNotMatch(r.stdout, /lines, over 400/, 'a small diff gets no size note (#57)');
  // Outside a pull request run, there is nothing to check.
  r = s.run(['check', '--pr']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no pull request in this run/);
});

test('check --pr: CODEOWNERS comes from the base branch, so a pull request cannot lower its own tier', () => {
  const s = sandbox();
  s.write('.github/CODEOWNERS', '/kit/ @owner\n');
  s.write('README.md', 'Short.\n');
  s.git('add', '.');
  s.git('commit', '-qm', 'base');
  const base = s.git('rev-parse', 'HEAD').stdout.trim();
  // The pull request edits CODEOWNERS to drop kit/, and changes kit/.
  s.write('.github/CODEOWNERS', '/nothing/ @owner\n');
  s.write('kit/a.md', 'Short.\n');
  s.git('add', '.');
  s.git('commit', '-qm', 'head');
  const head = s.git('rev-parse', 'HEAD').stdout.trim();
  const event = (tier: string) => {
    const file = join(s.home, 'event.json');
    const body = `tier: ${tier}\nCloses #1\nThis changes the kit.\n## Why\nx\n## What changed\nx\n## How tested\nx\n`;
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = s.run(['check', '--pr'], { extra: event('B') });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): kit\/a\.md/);
  r = s.run(['check', '--pr'], { extra: event('A') });
  assert.equal(r.status, 0, r.stderr);
});

test('check --pr: a large pull request gets a note, never a failure; lock files do not count (#57)', () => {
  const s = sandbox();
  s.write('README.md', 'Short.\n');
  s.git('add', '.');
  s.git('commit', '-qm', 'base');
  const base = s.git('rev-parse', 'HEAD').stdout.trim();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const a${i} = ${i};\n`).join('');
  s.write('package-lock.json', lines(1000));
  s.write('src/a.ts', lines(300));
  s.git('add', '.');
  s.git('commit', '-qm', 'small');
  const small = s.git('rev-parse', 'HEAD').stdout.trim();
  s.write('src/b.ts', lines(200));
  s.git('add', '.');
  s.git('commit', '-qm', 'large');
  const large = s.git('rev-parse', 'HEAD').stdout.trim();
  const event = (head: string) => {
    const file = join(s.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = s.run(['check', '--pr'], { extra: event(small) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /lines, over 400/, '300 lines; the lock file does not count');
  r = s.run(['check', '--pr'], { extra: event(large) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: this pull request changes 500 lines, over 400\. Smaller pull requests are easier to review/);
  assert.match(r.stdout, /check --pr: ok/);
});

test('check --issue: reads the issue from the CI event; a bad title fails, a good one passes', () => {
  const s = sandbox();
  s.write('yokoten.json', JSON.stringify({ areas: ['doctor', 'check'] }));
  const event = (issue: object) => {
    const file = join(s.home, 'event.json');
    writeFileSync(file, JSON.stringify({ action: 'opened', issue }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = s.run(['check', '--issue'], { extra: event({ title: 'doctor: add the review step', labels: [{ name: 'feat' }] }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /check --issue: ok/);
  r = s.run(['check', '--issue'], { extra: event({ title: 'The review step is missing.', labels: [{ name: 'incident' }] }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /check --issue: 2 problem\(s\)\n- title: it does not start with an area\. .+`area: symptom`.+\n- title: a full stop at the end\./);
  assert.doesNotMatch(r.stderr, /The review step is missing/, 'the title is user input; it is not printed back');
  r = s.run(['check', '--issue'], { extra: event({ title: 'site: a page', labels: [] }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Use one of: doctor, check\./);
  r = s.run(['check', '--issue', '--json'], { extra: event({ title: 'site: a page.', labels: [] }) });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  const report = JSON.parse(r.stdout);
  assert.equal(report.check, 'issue');
  assert.deepEqual(report.findings.map((f: { id: string }) => f.id), ['issue-area', 'issue-title']);
  assert.ok(!r.stdout.includes('a page'), 'the title is not printed back');
  r = s.run(['check', '--issue', '--pr']);
  assert.equal(r.status, 1, 'two modes are a usage error');
  assert.equal(r.stdout, '');
  // A comment on a pull request comes as an issue too; it is not an issue to check.
  r = s.run(['check', '--issue'], { extra: event({ title: 'Anything', pull_request: { url: 'x' } }) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no issue in this run/);
  r = s.run(['check', '--issue']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no issue in this run/);
  r = s.run(['check', '--issue', '--json']);
  assert.deepEqual(JSON.parse(r.stdout).skipped, 'no issue in this run (it reads the CI event); nothing to check');
});

// #42: stdout is data and stderr is for people; --json prints pure JSON. Exit codes are
// written down once (docs/guide.md, "Exit codes") and held here.
test('exit codes: 0 ok, 1 problems or a usage error, 2 the hook blocked (#42)', () => {
  const s = sandbox();
  const hook = (command: string) => s.run(['hook'], { input: JSON.stringify({ cwd: s.repo, tool_input: { command } }) });
  s.write('a.md', 'fine\n');
  s.git('add', '.');
  assert.equal(s.run(['check']).status, 0);
  assert.equal(hook('git status').status, 0);
  assert.equal(s.run(['doctor', '--session']).status, 0, 'a session always starts');
  assert.equal(s.run(['explain', 'release']).status, 0);
  assert.equal(s.run(['doctor']).status, 1, 'steps left on the road');
  s.write('b.md', `me${at}gmail.com\n`);
  s.git('add', '.');
  assert.equal(s.run(['check']).status, 1);
  assert.equal(s.run(['explain', 'nope']).status, 1);
  assert.equal(hook('git push --tags').status, 2);
  // A usage error is refused, never ignored: no fake success.
  for (const args of [['nope'], ['check', '--stagd'], ['check', '--staged', '--pr'], ['check', 'extra'], ['doctor', '--sesion'], ['hook', '--agent'], ['explain', 'a', 'b']]) {
    const r = s.run(args, { input: '{}' });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '', `${args.join(' ')}: nothing on stdout`);
    assert.notEqual(r.stderr, '', `${args.join(' ')}: says why on stderr`);
  }
});

test('--json: check, doctor, hook and explain print pure JSON with what, why and fix; never a private value (#42)', () => {
  const s = sandbox();
  const marks = join(s.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks, YOKOTEN_ROLE: 'worker' };
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  s.write('AGENTS.md', '# rules\n');
  s.write('notes/a.md', `me${at}gmail.com\nI live in MyCity\n${token}\nserver ${[10, 1, 2, 3].join('.')}\n`);
  s.write('dist/app.js', 'x\n');
  for (let i = 0; i < 8; i++) s.write(`many/${i}.md`, 'x\n');
  s.git('add', '.');
  const shaped = (f: Record<string, unknown>) => {
    for (const k of ['id', 'what', 'why', 'fix']) assert.ok(typeof f[k] === 'string' && f[k], `${f.id}: ${k}`);
  };
  const clean = (out: string) => {
    for (const secret of ['mycity', 'gmail', token, [10, 1, 2, 3].join('.'), s.home]) assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), `${secret} printed`);
  };

  // check: the text form says what, why and fix on each line.
  let r = s.run(['check', '--staged'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(r.status, 1);
  const lines = r.stderr.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length >= 7, r.stderr);
  for (const line of lines) assert.match(line, /^- .+\. [A-Z].+\. .+\.$/, line);
  clean(r.stderr);
  r = s.run(['check', '--staged', '--json'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  const report = JSON.parse(r.stdout);
  assert.equal(report.check, 'staged');
  assert.equal(report.ok, false);
  assert.deepEqual(
    [...new Set(report.findings.map((f: { id: string }) => f.id))].sort(),
    ['build-output', 'email', 'ip', 'layout', 'lead-only', 'private-mark', 'secret', 'time-zone'],
  );
  report.findings.forEach(shaped);
  assert.deepEqual(report.findings.find((f: { id: string }) => f.id === 'email'), {
    id: 'email',
    what: 'an email address',
    why: 'an email address points at a person, and git keeps it after the file is gone',
    fix: 'use your GitHub noreply address, or a placeholder at example.com',
    file: 'notes/a.md',
    line: 1,
  });
  clean(r.stdout);
  r = s.run(['check', '--json'], { extra });
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['check', 'ok', 'findings', 'notes']);

  // hook: the runtimes still read stderr and the exit code; --json adds the finding on stdout.
  const call = { cwd: s.repo, tool_input: { command: 'git push --force' } };
  r = s.run(['hook', '--json'], { input: JSON.stringify(call) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^yokoten: git push --force forces the push\. .+\. Use --force-with-lease/);
  const blocked = JSON.parse(r.stdout);
  assert.equal(blocked.blocked, true);
  shaped(blocked.finding);
  assert.equal(blocked.finding.id, 'force-push');
  r = s.run(['hook', '--json'], { input: JSON.stringify({ cwd: s.repo, tool_input: { command: 'git status' } }) });
  assert.deepEqual([r.status, JSON.parse(r.stdout)], [0, { blocked: false, toolCall: true }]);
  r = s.run(['hook'], { input: JSON.stringify(call) });
  assert.equal(r.stdout, '', 'without --json, stdout stays empty for the runtimes');

  // doctor: the road and the machine as data.
  r = s.run(['doctor', '--json'], { extra });
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.stage, 1);
  assert.equal(doc.next.id, 'tool-hook');
  assert.ok(doc.steps.some((st: { id: string; mark: string }) => st.id === 'rules' && st.mark === 'done'));
  assert.ok(doc.findings.some((f: { id: string }) => f.id === 'secret'), 'the tree check is in it');
  doc.findings.forEach(shaped);
  doc.notes.forEach(shaped);
  clean(r.stdout);
  r = s.run(['doctor', '--session', '--json'], { extra });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).findings.map((f: { id: string }) => f.id), ['tool-hook']);

  // explain: a known id, and an unknown one with the list.
  r = s.run(['explain', 'secret', '--json']);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['found', 'id', 'kind', 'what', 'why', 'check']);
  r = s.run(['explain', 'nope', '--json']);
  assert.equal(r.status, 1);
  const unknown = JSON.parse(r.stdout);
  assert.equal(unknown.found, false);
  assert.ok(unknown.ids.includes('secret') && unknown.ids.includes('tool-hook'));
  r = s.run(['explain', 'commit-check']);
  assert.match(r.stdout, /^commit-check: a step on the road: stage 1 of 5, safety net\.\nWhy: .+\.\nCheck: .+\.\nStandard: OSPS-BR-07\.01\.\n$/);
  r = s.run(['explain']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Ids: release, /);
});

test('init --github: opt-in, says what it would make, makes it with --yes, and a second run makes nothing (#10)', () => {
  const s = sandbox();
  // A fake gh first on PATH, holding the repo in a file. The real gh and GitHub are never reached.
  const bin = join(s.home, 'bin');
  const state = join(s.home, 'gh.json');
  mkdirSync(bin);
  writeFileSync(state, JSON.stringify({ labels: ['bug', 'question'], milestones: [], calls: [] }));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const a = process.argv.slice(2);
s.calls.push(a.join(' '));
if (a[0] === 'repo') console.log('me/repo');
else if (a[0] === 'label' && a[1] === 'list') s.labels.forEach((l) => console.log(l));
else if (a[0] === 'label' && a[1] === 'create') s.labels.push(a[2]);
else if (a.includes('POST')) s.milestones.push(a.at(-1).slice(6));
else if (a[0] === 'api') s.milestones.forEach((m) => console.log('open ' + m));
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  const made = () => JSON.parse(readFileSync(state, 'utf8')).calls.filter((c: string) => / create |POST/.test(c));
  let r = s.run(['init'], { extra });
  assert.match(r.stdout, /run `yokoten init --github` to see what it would make/);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).calls.length, 0, 'without --github, gh is not run');
  assert.equal(s.run(['init', '--yes'], { extra }).status, 1, '--yes alone is refused');
  r = s.run(['init', '--github'], { extra });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GitHub: me\/repo\n- 1 of the 9 standard labels are there; kept\n- not in the standard set: question\./);
  assert.match(r.stdout, /Would make:\n- label "feat"[^]*- milestone "First release"\nNothing changed\./);
  assert.deepEqual(made(), []);
  r = s.run(['init', '--github', '--yes'], { extra });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /- made label "good first issue"\n[^]*- made milestone "First release"/);
  assert.equal(made().length, 9);
  r = s.run(['init', '--github', '--yes'], { extra });
  assert.match(r.stdout, /- 9 of the 9 standard labels are there; kept\n- a milestone is there; kept\n[^]*Nothing to make\./);
  assert.equal(made().length, 9, 'the second run made nothing');
});
