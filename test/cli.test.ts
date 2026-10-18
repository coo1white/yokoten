// End to end: the CLI in throwaway git repos, the way a hook or CI runs it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closestWord, COMMANDS, editDistance, HELP_OPTIONS } from '../src/run/cli.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'yokoten.ts');
const at = '@';

function makeSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  // A clean environment: no real HOME, no real marks, no role, and commit times in UTC
  // whatever the machine's time zone (#40). No proxy either: the shell's proxy is not
  // passed on, and a call to a fake server on this machine goes to it directly (#138).
  const env = { PATH: process.env.PATH, HOME: home, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
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
  const sandbox = makeSandbox();
  const call = (tool_input: object, extra?: Record<string, string>) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input }), extra });
  let result = call({ command: 'git push --tags' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal(call({ command: 'git status' }).status, 0);
  // A heredoc body is data, unless a shell reads it (#105).
  assert.equal(call({ command: "ego-browser nodejs <<'EOF'\nawait page.fill('#q', 'npm publish');\nEOF" }).status, 0);
  assert.equal(call({ command: 'bash <<EOF\nnpm publish\nEOF' }).status, 2);
  assert.equal(call({ file_path: join(sandbox.repo, 'AGENTS.md') }).status, 0);
  result = call({ file_path: join(sandbox.repo, 'AGENTS.md') }, { YOKOTEN_ROLE: 'worker' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  // A worker subagent is a worker even in a lead session.
  result = sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, agent_type: 'worker', tool_input: { file_path: 'CLAUDE.md' } }) });
  assert.equal(result.status, 2);
  // The user-level guard leaves files to the project.
  result = sandbox.run(['hook', '--commands-only'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { file_path: 'CLAUDE.md' } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 0);
  assert.equal(sandbox.run(['hook'], { input: 'not json' }).status, 0);
});

// The Stop event is shaped as Claude Code's hook docs show it (code.claude.com/docs/en/hooks#stop).
test('hook --stop: sends the agent back once with the findings in changed files, never twice (#92)', () => {
  const sandbox = makeSandbox();
  const stop = (active = false, extra?: Record<string, string>) =>
    sandbox.run(['hook', '--stop'], { input: JSON.stringify({ session_id: 'abc123', cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: 'done' }), extra });
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  // Clean: the turn ends.
  let result = stop();
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // A fake secret in a new, untracked file, written by a script the tool hook never saw.
  const key = `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}`;
  sandbox.write('scripts/out.txt', `${key}\n`);
  result = stop();
  assert.equal(result.status, 2, 'blocked');
  assert.match(result.stderr, /^yokoten: 1 problem\(s\) in the changed files\. Fix them before you end the turn:\n- scripts\/out\.txt:1: a secret \(AWS access key id\)\. .+\. .+\.\n  docs: https:\/\/\S+#privacy\n$/);
  assert.ok(!result.stderr.includes(key), 'the secret is never printed');
  assert.equal(result.stdout, '', 'stdout stays empty for the runtime');
  // Already sent back once: the turn ends, whatever is found. No loop.
  result = stop(true);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  // Staged and changed files count too; a lead-only file only for a worker.
  rmSync(join(sandbox.repo, 'scripts'), { recursive: true });
  sandbox.write('a.md', `mail me${at}gmail.com\n`);
  assert.match(stop().stderr, /a\.md:1: an email/);
  sandbox.write('a.md', 'fine\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', 'AGENTS.md');
  assert.equal(stop().status, 0);
  result = stop(false, { YOKOTEN_ROLE: 'worker' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  // --json: the same Finding shape.
  result = sandbox.run(['hook', '--stop', '--json'], { input: JSON.stringify({ cwd: sandbox.repo, stop_hook_active: false }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.deepEqual([out.blocked, out.stop, out.findings[0].id], [true, true, 'lead-only']);
  for (const k of ['what', 'why', 'fix']) assert.ok(out.findings[0][k]);
  // Not a Stop event, or not a repo: the turn ends.
  for (const input of ['not json', '', 'null', '[1]']) assert.equal(sandbox.run(['hook', '--stop'], { input }).status, 0, input);
  const away = mkdtempSync(join(tmpdir(), 'yokoten-away-'));
  assert.equal(sandbox.run(['hook', '--stop'], { input: JSON.stringify({ cwd: away }) }).status, 0);
  // Outside a repo the guard still stops a tag push, and git's own error stays hidden:
  // an agent read it as the result of the stopped command.
  result = sandbox.run(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Bash', tool_input: { command: 'git push --tags' } }) });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /fatal|not a git repository/);
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\..*YOKOTEN_RELEASE_APPROVAL=1 claude/);
  // A broken config is an internal error: the turn ends, with one line on stderr.
  sandbox.write('yokoten.json', '{ broken');
  result = sandbox.run(['hook', '--stop'], { input: JSON.stringify({ cwd: sandbox.repo }) });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^yokoten hook --stop: skipped, [^\n]+\n$/);
  // --stop is for Claude Code's Stop event only.
  assert.equal(sandbox.run(['hook', '--stop', '--agent', 'codex'], { input: '{}' }).status, 1);
  assert.equal(sandbox.run(['hook', '--stop', '--commands-only'], { input: '{}' }).status, 1);
});

// Each call is shaped as the runtime's hook docs show it (#30): Codex's PreToolUse
// (developers.openai.com/codex/hooks) and Gemini CLI's BeforeTool (geminicli.com/docs/hooks).
test('hook --agent codex: shell calls by command, apply_patch by the files it touches (#30)', () => {
  const sandbox = makeSandbox();
  const call = (tool_name: string, command: string, extra?: Record<string, string>, fields: object = {}) =>
    sandbox.run(['hook', '--agent', 'codex'], {
      input: JSON.stringify({
        session_id: 'thr_123',
        transcript_path: null,
        cwd: sandbox.repo,
        hook_event_name: 'PreToolUse',
        model: 'gpt-5',
        permission_mode: 'default',
        turn_id: 'turn_1',
        tool_name,
        tool_use_id: 'call_1',
        tool_input: { command },
        ...fields,
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
  assert.equal(call('apply_patch', patch(`*** Add File: ${join(sandbox.repo, '.github', 'x.yml')}`), worker).status, 2, 'an absolute path');
  assert.equal(call('apply_patch', patch('*** Update File: src/a.ts'), worker).status, 0);
  assert.equal(call('apply_patch', patch('*** Update File: AGENTS.md')).status, 0, 'the lead may');
  // A worker subagent's call names its role (Codex rust-v0.163.0, #210); no env needed.
  assert.equal(call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a1', agent_type: 'worker' }).status, 2, 'a worker subagent');
  assert.equal(call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a2', agent_type: 'explorer' }).status, 0, 'an explorer is not a worker');
  // A patch is not a command, and an unknown tool is neither.
  assert.equal(call('apply_patch', 'git push --tags').status, 0);
  assert.equal(call('mcp__fs__write', 'git push --tags').status, 0);
});

test('hook --agent gemini: run_shell_command by command, write_file and replace by file_path (#30)', () => {
  const sandbox = makeSandbox();
  const call = (tool_name: string, tool_input: object, extra?: Record<string, string>) =>
    sandbox.run(['hook', '--agent', 'gemini'], {
      input: JSON.stringify({
        session_id: 's1',
        transcript_path: join(sandbox.home, 't.json'),
        cwd: sandbox.repo,
        hook_event_name: 'BeforeTool',
        timestamp: '2026-10-18T00:00:00Z',
        tool_name,
        tool_input,
      }),
      extra,
    });
  let result = call('run_shell_command', { command: 'git push --tags', description: 'push tags' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal(result.stdout, '', 'Gemini CLI reads stdout as JSON: nothing else goes there');
  assert.equal(call('run_shell_command', { command: 'git status' }).status, 0);
  const worker = { YOKOTEN_ROLE: 'worker' };
  result = call('write_file', { file_path: join(sandbox.repo, 'AGENTS.md'), content: 'x' }, worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal(call('replace', { file_path: '.gemini/settings.json', instruction: 'i', old_string: 'a', new_string: 'b' }, worker).status, 2);
  assert.equal(call('write_file', { file_path: 'src/a.ts', content: 'x' }, worker).status, 0);
  assert.equal(call('read_file', { file_path: 'AGENTS.md' }, worker).status, 0, 'reading is not editing');
  assert.equal(call('write_file', { file_path: 'AGENTS.md', content: 'x' }).status, 0, 'the lead may');
  result = sandbox.run(['hook', '--agent', 'cursor'], { input: '{}' });
  assert.equal(result.status, 1, 'an unknown agent is an error to see, not a block');
  assert.match(result.stderr, /claude-code, codex, gemini/);
});

// Gemini CLI (v0.64.0) swaps `$GEMINI_PROJECT_DIR` in the command text for the shell-quoted
// launch folder, then runs the text in a shell (#210). This copies that against a repo whose
// path has a space and an @.
test('init: the Gemini hook command runs when Gemini quotes a path with a space (#210)', () => {
  const sandbox = makeSandbox();
  // An older yokoten wrote the folder in double quotes; init updates that hook in place.
  const old = 'node "$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --agent gemini';
  sandbox.write('.gemini/settings.json', JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: old, name: 'yokoten' }] }] } }));
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated the Gemini CLI tool-call hook/);
  const repo = join(dirname(sandbox.repo), 'my repo@1');
  renameSync(sandbox.repo, repo);
  const groups = JSON.parse(readFileSync(join(repo, '.gemini', 'settings.json'), 'utf8')).hooks.BeforeTool;
  assert.equal(groups.length, 1, 'updated, not added');
  const command: string = groups[0].hooks[0].command;
  assert.equal(command, 'node $GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts hook --agent gemini');
  // shell-quote, which Gemini uses, writes a path with a space and no single quote as
  // '…'; a single quote inside would become '\''.
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const input = JSON.stringify({ session_id: 's1', cwd: repo, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'git push --tags' } });
  const asGemini = (text: string) =>
    spawnSync('bash', ['-c', text.replaceAll('$GEMINI_PROJECT_DIR', quote(repo))], { cwd: repo, env: { ...sandbox.env, GEMINI_PROJECT_DIR: repo }, input, encoding: 'utf8' });
  const ran = asGemini(command);
  assert.equal(ran.status, 2, ran.stderr);
  assert.match(ran.stderr, /owner decides when to release/);
  // The control: the old quoted command never reaches yokoten.
  const broken = asGemini(old);
  assert.notEqual(broken.status, 2);
  assert.match(broken.stderr, /Cannot find module/);
});

test('hook: a repo reached through a symlink gets the same file rules (#1)', () => {
  const sandbox = makeSandbox();
  const link = join(sandbox.home, 'link');
  symlinkSync(sandbox.repo, link);
  const call = (file_path: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: link, tool_input: { file_path } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(call(join(link, 'AGENTS.md')).status, 2, 'absolute path through the link');
  assert.equal(call('AGENTS.md').status, 2, 'relative to a cwd through the link');
  assert.equal(call(join(link, '.github', 'new', 'x.yml')).status, 2, 'a file in a folder that does not exist yet');
  assert.equal(call(join(sandbox.home, 'elsewhere.md')).status, 0, 'outside the repo');
});

test('check --staged: stops a commit with a personal email or a private mark', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  sandbox.write('src/a.md', 'fine\n');
  sandbox.git('add', '.');
  assert.equal(sandbox.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } }).status, 0);
  sandbox.write('src/b.md', `write to me${at}gmail.com\nI live in MyCity\n`);
  sandbox.git('add', '.');
  const r = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/b\.md:1: an email/);
  assert.match(r.stderr, /src\/b\.md:2: matches a line of your private-marks file/);
  assert.ok(!/mycity/i.test(r.stderr));
});

test('check --staged: stops build output and binaries, lets images and allowed paths through (#56)', () => {
  const sandbox = makeSandbox();
  sandbox.write('dist/app.js', 'console.log(1);\n');
  writeFileSync(join(sandbox.repo, 'tool'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 0]));
  writeFileSync(join(sandbox.repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  sandbox.git('add', '.');
  let r = sandbox.run(['check', '--staged']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dist\/app\.js: build output, in a dist\/ folder\./);
  assert.match(r.stderr, /tool: a binary file\. A reviewer can't read it/);
  assert.ok(!r.stderr.includes('logo.png'), 'an image is fine');
  sandbox.write('yokoten.json', JSON.stringify({ allowBuild: ['dist/**', 'tool'] }));
  sandbox.git('add', '.');
  r = sandbox.run(['check', '--staged']);
  assert.equal(r.status, 0, r.stderr);
});

test('doctor: the no-build-output step looks at the tracked files (#56)', () => {
  const sandbox = makeSandbox();
  const line = () => sandbox.run(['doctor']).stdout.split('\n').find((l) => / no-build-output/.test(l)) ?? '';
  assert.match(line(), /^ +done +no-build-output/);
  sandbox.write('build/a.js', 'x\n');
  sandbox.write('lib/x.so', 'x\n');
  sandbox.git('add', '.');
  assert.match(line(), /^ +to do +no-build-output \(Scorecard: Binary-Artifacts\): build output in the repo \(build\/a\.js, lib\/x\.so\)/);
  sandbox.write('yokoten.json', JSON.stringify({ allowBuild: ['build/**', 'lib/**'] }));
  assert.match(line(), /^ +done +no-build-output/);
});

test('check --staged: stops a commit whose time carries a time zone, never printing it (#40)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  const zoned = { GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' };
  let r = sandbox.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  assert.ok(!/0700/.test(r.stderr), 'the offset is never printed');
  assert.equal(sandbox.run(['check', '--staged'], { extra: { GIT_AUTHOR_DATE: '2026-10-18T02:00:00+0000' } }).status, 0);
  // A project can turn it off.
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { utc: false } }));
  sandbox.git('add', '.');
  r = sandbox.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 0, r.stderr);
});

test('check --history: counts commits with a time zone, as a note that does not fail (#40)', () => {
  const sandbox = makeSandbox();
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'utc');
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'zoned'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: 'Asia/Tokyo' } });
  const r = sandbox.run(['check', '--history']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 1 commit\(s\) record a time zone other than UTC/);
});

test('check --history: finds what a later commit deleted, and a personal author email', () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `server ${[10, 1, 2, 3].join('.')}\ntoken ${token}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  sandbox.git('-c', `user.email=me${at}gmail.com`, 'commit', '-q', '--allow-empty', '-m', 'oops');
  assert.equal(sandbox.run(['check']).status, 0, 'the tree today is clean');
  const r = sandbox.run(['check', '--history']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /notes\.md @ blob \w+:1: an IP address/);
  assert.match(r.stderr, /notes\.md @ blob \w+:2: a secret \(GitHub token\)/, 'a secret deleted later (#8)');
  assert.ok(!r.stderr.includes(token), 'the secret is never printed');
  assert.match(r.stderr, /\(author\/committer\):1: an email/);
});

test('init: adds the practices, keeps what is there, and doctor goes on to stage 4', () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '# our own rules\n');
  sandbox.write('.github/SECURITY.md', '# email us\n');
  // The user's own Codex and Gemini CLI settings stay.
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  sandbox.write('.codex/hooks.json', JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  sandbox.write('.gemini/settings.json', JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  assert.match(sandbox.run(['doctor']).stdout, /note +codex-hook: no tool-call guard/, 'reported, not counted as missing');
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept AGENTS\.md/);
  assert.match(result.stdout, /wrote \.githooks\/pre-commit/);
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), '# our own rules\n');
  assert.match(result.stdout, /kept \.github\/SECURITY\.md/);
  assert.equal(readFileSync(join(sandbox.repo, '.github/SECURITY.md'), 'utf8'), '# email us\n', 'the project\'s own policy stays');
  assert.match(result.stdout, /wrote \.github\/dependabot\.yml/);
  assert.match(result.stdout, /wrote CHANGELOG\.md/);
  assert.match(readFileSync(join(sandbox.repo, 'CHANGELOG.md'), 'utf8'), /^## \[Unreleased\]$/m, 'the changelog skeleton (#34)');
  assert.match(result.stdout, /wrote changes\/README\.md/);
  assert.match(readFileSync(join(sandbox.repo, 'changes/README.md'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts changelog --write/, 'the change files folder (#132)');
  assert.ok(statSync(join(sandbox.repo, '.githooks', 'pre-commit')).mode & 0o100);
  const workflow = readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8');
  assert.match(workflow, /node \.yokoten\/bin\/yokoten\.ts check/);
  assert.match(workflow, /persist-credentials: false/, 'the hardened workflow (#36)');
  assert.match(workflow, /^  ci:\n    if: always\(\)\n    needs: \[check, lint\]$/m, 'one required check that waits for the rest (#36)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --pr/, 'the pull request check (#47)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/issue.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --issue/, 'the issue title check');
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  // Again: nothing changes.
  result = sandbox.run(['init']);
  assert.match(result.stdout, /kept \.github\/SECURITY\.md/);
  assert.match(result.stdout, /kept \.github\/dependabot\.yml/);
  assert.match(result.stdout, /kept CHANGELOG\.md/);
  assert.match(result.stdout, /same the tool-call hook/);
  assert.match(result.stdout, /same TZ=UTC for agent sessions/);
  const settings = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(result.stdout, /same the stop check/);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --stop' }] }], 'the stop check, once (#92)');
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  assert.match(result.stdout, /same the Codex tool-call hook/);
  assert.match(result.stdout, /same the Gemini CLI tool-call hook/);
  const codex = JSON.parse(readFileSync(join(sandbox.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.equal(codex.hooks.PreToolUse.length, 2);
  assert.deepEqual(codex.hooks.PreToolUse[1], {
    hooks: [{ type: 'command', command: 'node "$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts" hook --agent codex' }],
    matcher: 'Bash|apply_patch',
  });
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.deepEqual(gemini.hooks.BeforeTool[1], {
    hooks: [{ type: 'command', command: 'node $GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts hook --agent gemini', name: 'yokoten' }],
    matcher: 'run_shell_command|write_file|replace',
  });
  assert.match(sandbox.run(['doctor']).stdout, /ok +codex-hook\n +ok +gemini-hook/);
  // The pre-commit hook runs the vendored check on a real commit.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0);
  sandbox.write('leak.md', `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}\n`);
  sandbox.git('add', 'leak.md');
  const secret = sandbox.git('commit', '-qm', 'leak');
  assert.notEqual(secret.status, 0, 'a secret is refused too (#8)');
  assert.match(secret.stderr, /leak\.md:1: a secret \(AWS access key id\)/);
  sandbox.git('reset', '-q', 'leak.md');
  // init does all of stages 1 to 3 but the tests, so with tests the road goes on to stage 4.
  assert.match(sandbox.run(['doctor', '--session']).stdout, /^yokoten: stage 1 of 5, safety net\. Next: no test command/);
  sandbox.withTests();
  result = sandbox.run(['doctor', '--session']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^yokoten: stage 4 of 5, a team of agents\. Next: no CODEOWNERS file/);
});

test('init: safe defaults, Dependabot and a security policy; doctor lists the security switches (#35)', () => {
  const sandbox = makeSandbox();
  const r = sandbox.run(['init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote \.github\/SECURITY\.md/);
  assert.match(r.stdout, /wrote \.github\/dependabot\.yml/);
  const dependabot = readFileSync(join(sandbox.repo, '.github/dependabot.yml'), 'utf8');
  for (const line of [/package-ecosystem: github-actions/, /interval: monthly/, /default-days: 7/, /patterns: \['\*'\]/, /prefix: ci/]) assert.match(dependabot, line);
  assert.equal([...dependabot.matchAll(/^\s*- package-ecosystem:/gm)].length, 1, 'actions only, since the stack is unknown');
  assert.match(readFileSync(join(sandbox.repo, '.github/SECURITY.md'), 'utf8'), /\*\*Report a vulnerability\*\*/);
  const doctor = sandbox.run(['doctor']);
  for (const sw of [/private vulnerability reporting/, /secret scanning with push protection/, /Dependabot alerts/]) assert.match(doctor.stdout, sw);
  // Right after init only the license is missing: say what to do, not that init adds it (#208).
  const security = () => sandbox.run(['doctor']).stdout.split('\n').find((l) => / security-files\b/.test(l)) ?? '';
  assert.match(security(), /: no license file; choose a license and add it as LICENSE$/);
  assert.doesNotMatch(security(), /yokoten init/);
  rmSync(join(sandbox.repo, '.github/SECURITY.md'));
  assert.match(security(), /: no security policy \(SECURITY\.md\), no license file; run `yokoten init` to add the security policy and Dependabot, and choose a license and add it as LICENSE$/);
  sandbox.write('LICENSE', 'placeholder license\n');
  sandbox.run(['init']);
  assert.match(security(), /^ +done +security-files/);
});

/** The doctor --json mark of one road step. */
const stepMark = (sandbox: ReturnType<typeof makeSandbox>, id: string) =>
  (JSON.parse(sandbox.run(['doctor', '--json']).stdout).steps as { id: string; mark: string }[]).find((step) => step.id === id)?.mark;

test("init: a CLAUDE.md gets one line that imports AGENTS.md, and doctor's rules step wants it (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# our rules\n\nRun the tests first.\n');
  sandbox.write('AGENTS.md', '# shared rules\n');
  assert.notEqual(stepMark(sandbox, 'rules'), 'done', 'AGENTS.md that Claude Code does not read is not done');
  assert.match(sandbox.run(['doctor']).stdout, /rules[^\n]*: CLAUDE\.md does not import AGENTS\.md[^\n]*; add a line `@AGENTS\.md`/);
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote AGENTS\.md/);
  assert.match(result.stdout, /updated CLAUDE\.md: it now reads AGENTS\.md/);
  const claude = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# our rules\n\nRun the tests first.\n\n'), 'the project\'s own lines stay');
  assert.match(claude, /\n<!--[^\n]*-->\n@AGENTS\.md\n$/, 'a comment line, then the import, at the end');
  assert.equal(stepMark(sandbox, 'rules'), 'done');
  // Again: one import, not two.
  result = sandbox.run(['init']);
  assert.doesNotMatch(result.stdout, /updated CLAUDE\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), claude);
});

test('init: a CLAUDE.md that already imports or links AGENTS.md is left as it is (#206)', () => {
  for (const text of [`# rules\n${at}AGENTS.md\n`, '# rules\nSee [the rules](AGENTS.md).\n', `# rules\nRead ${at}./AGENTS.md first.\n`]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), text);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test("init: a .claude/CLAUDE.md alone gets `@../AGENTS.md`, and doctor's rules step wants it (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('.claude/CLAUDE.md', '# our rules\n');
  sandbox.write('AGENTS.md', '# shared rules\n');
  assert.notEqual(stepMark(sandbox, 'rules'), 'done', 'Claude Code reads .claude/CLAUDE.md instead of AGENTS.md');
  assert.match(sandbox.run(['doctor']).stdout, /rules[^\n]*: \.claude\/CLAUDE\.md does not import AGENTS\.md[^\n]*; add a line `@\.\.\/AGENTS\.md`/);
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated \.claude\/CLAUDE\.md: it now reads AGENTS\.md/);
  // Claude Code resolves an import relative to the file that holds it, so this is the root AGENTS.md.
  assert.match(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), /^# our rules\n\n<!--[^\n]*-->\n@\.\.\/AGENTS\.md\n$/);
  assert.equal(existsSync(join(sandbox.repo, 'CLAUDE.md')), false, 'no root CLAUDE.md is made');
  assert.equal(stepMark(sandbox, 'rules'), 'done');
});

test('init: CLAUDE.md and .claude/CLAUDE.md, neither importing AGENTS.md: the root one gets the import (#206)', () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# root rules\n');
  sandbox.write('.claude/CLAUDE.md', '# folder rules\n');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated CLAUDE\.md: it now reads AGENTS\.md/);
  assert.doesNotMatch(result.stdout, /updated \.claude\/CLAUDE\.md/);
  assert.match(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), /\n@AGENTS\.md\n$/);
  assert.equal(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), '# folder rules\n');
  assert.equal(stepMark(sandbox, 'rules'), 'done');
});

test('init: a .claude/CLAUDE.md that already imports AGENTS.md is left as it is (#206)', () => {
  for (const text of [`# rules\n${at}../AGENTS.md\n`, '# rules\nSee [the rules](../AGENTS.md).\n']) {
    const sandbox = makeSandbox();
    sandbox.write('.claude/CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), text);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test("init: husky keeps its hooks folder; .husky/pre-commit gets the check and keeps its own lines (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', '#!/bin/sh\ntouch own-hook-ran\n');
  chmodSync(join(sandbox.repo, '.husky/pre-commit'), 0o755);
  sandbox.git('config', 'core.hooksPath', '.husky');
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit: the commit check \(kept core\.hooksPath \(husky\)/);
  assert.doesNotMatch(result.stdout, /set git core\.hooksPath/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.husky', 'the project\'s hooks folder stays');
  assert.ok(!existsSync(join(sandbox.repo, '.githooks')), 'no second hooks folder that git never runs');
  const hook = readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8');
  assert.match(hook, /^#!\/bin\/sh\n# yokoten: [^\n]*\nnode "\.yokoten\/bin\/yokoten\.ts" check --staged \|\| exit 1\ntouch own-hook-ran\n$/);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  // Again: the hook already runs yokoten.
  result = sandbox.run(['init']);
  assert.match(result.stdout, /same \.husky\/pre-commit/);
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), hook);
  // A real commit runs both: the project's hook and the yokoten check.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.ok(existsSync(join(sandbox.repo, 'own-hook-ran')), 'the project\'s own hook still runs');
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0);
});

test('init: husky not yet installed in this clone; init leaves core.hooksPath unset and says to run npm install (#206)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit/);
  assert.match(result.stdout, /run `npm install`/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), /^# yokoten: [^\n]*\nnode [^\n]*\nnpm test\n$/);
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done', 'git runs no hook yet');
  assert.match(sandbox.run(['doctor']).stdout, /run `npm install` so husky sets core\.hooksPath/);
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done', "husky 9's folder runs .husky/pre-commit");
});

test("init: another core.hooksPath is kept, and its pre-commit is made with the check (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('tools/hooks/commit-msg', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  assert.match(sandbox.run(['doctor']).stdout, /tools\/hooks\/pre-commit does not run yokoten/);
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote tools\/hooks\/pre-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), 'tools/hooks');
  assert.ok(statSync(join(sandbox.repo, 'tools/hooks/pre-commit')).mode & 0o100, 'executable');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'adopt yokoten').status, 0);
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0, 'the check runs from the project\'s folder');
});

// A lesson added to the kit's core rules reaches a project that already ran init (#120).
test('update: doctor says when the core rules are behind; update previews, and --write keeps "This project" byte for byte (#120)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));
  assert.match(sandbox.run(['doctor']).stdout, /\n {2}ok +core-rules\n/, 'init wrote the kit, so it is up to date');
  let result = sandbox.run(['update']);
  assert.deepEqual([result.status, result.stdout], [0, 'yokoten update: the core rules in AGENTS.md are up to date with yokoten 0.1.0; nothing to change\n']);

  // An older kit had no rule 12, and someone edited a line by hand. The project's own
  // part has trailing spaces and a CRLF line end, to show it is kept byte for byte.
  const own = '## This project\n\nBuild with `make`.  \n<!-- ours -->\r\n';
  const old = kitCore.replace(/^\| 12 \|.*\n/m, '').replace('Plain English, close to', 'Plain words, close to') + own;
  writeFileSync(path, old);
  const doctor = sandbox.run(['doctor']);
  assert.match(doctor.stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind yokoten 0\.1\.0's, or were edited by hand \(2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\); run `yokoten update` to see the change/);
  assert.equal(doctor.status, 1);
  assert.match(sandbox.run(['doctor', '--session']).stdout, /^yokoten: the core rules in AGENTS\.md are behind/m, 'a session hears it');
  assert.ok(JSON.parse(sandbox.run(['doctor', '--json']).stdout).findings.some((f: { id: string }) => f.id === 'core-rules'));

  // The preview shows each line, the hand edit too, and writes nothing.
  result = sandbox.run(['update']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten update: the core rules in AGENTS\.md differ from yokoten 0\.1\.0's: 2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\n/);
  assert.match(result.stdout, /^- Plain words, close to ASD-STE100/m, 'the hand-edited line is shown as replaced');
  assert.match(result.stdout, /^\+ Plain English, close to ASD-STE100/m);
  assert.match(result.stdout, /^\+ \| 12 \| Decisions are written down once/m);
  assert.match(result.stdout, /Nothing was written\. Run `yokoten update --write` to write it\.\n$/);
  assert.equal(readFileSync(path, 'utf8'), old, 'the preview writes nothing');

  // --write replaces the core part only; a second run has nothing to do.
  result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `yokoten update: replaced the core rules in AGENTS.md with yokoten 0.1.0's: 2 line(s) added, 1 removed; sections changed: Core rules, Writing. "## This project" and below are unchanged\n`);
  assert.equal(readFileSync(path, 'utf8'), kitCore + own);
  assert.match(sandbox.run(['update']).stdout, /up to date/);
  assert.match(sandbox.run(['doctor']).stdout, /\n {2}ok +core-rules\n/);

  // Line ends do not count: a CRLF checkout is up to date.
  writeFileSync(path, kitCore.replaceAll('\n', '\r\n') + own);
  assert.match(sandbox.run(['update']).stdout, /up to date/);

  // Without the heading, doctor can't tell the core rules from the project's: a note, never a guess.
  writeFileSync(path, '# our own rules\n');
  assert.match(sandbox.run(['doctor']).stdout, /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: AGENTS\.md has no `## This project` heading/);
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, /core rules/);
  result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten update: can't compare AGENTS\.md with the kit: .*Nothing was written/);
  assert.equal(readFileSync(path, 'utf8'), '# our own rules\n');

  rmSync(path);
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, /core-rules/, 'the road asks for AGENTS.md');
  result = sandbox.run(['update']);
  assert.deepEqual([result.status, result.stderr], [1, 'yokoten update: no AGENTS.md here; nothing was written. Run `yokoten init` to add one\n']);
  assert.equal(sandbox.run(['update', '--force']).status, 1, 'an unknown option is refused');
  assert.match(sandbox.run(['explain', 'core-rules']).stdout, /^core-rules: the core rules in AGENTS\.md/);
});

// A project written by a newer yokoten is never taken back to an older kit (#141).
test('update: init writes the kit version; a newer project is refused, an older one is updated (#141)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  assert.match(fresh, /^<!-- yokoten kit 0\.1\.0 -->\n# How work is done here\n/, 'init writes the mark on the first line');
  const own = fresh.slice(fresh.indexOf('## This project'));
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));

  // Newer: a later kit added a line. update refuses, with or without --write, and doctor
  // says to update yokoten, not the project.
  const newer = kitCore.replace('0.1.0 -->', '0.2.0 -->').replace('## Roles\n', '## Roles\n\nA rule from a later kit.\n') + own;
  writeFileSync(path, newer);
  for (const args of [['update'], ['update', '--write']]) {
    const result = sandbox.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^yokoten update: AGENTS\.md was written by yokoten 0\.2\.0, newer than this yokoten 0\.1\.0\. Nothing was written/);
  }
  assert.equal(readFileSync(path, 'utf8'), newer, 'a newer project is not downgraded');
  const doctor = sandbox.run(['doctor']);
  assert.match(doctor.stdout, /\n {2}note +core-rules: the core rules in AGENTS\.md come from yokoten 0\.2\.0, newer than this yokoten 0\.1\.0; update yokoten itself, not the project/);
  assert.doesNotMatch(doctor.stdout, /MISSING core-rules/);

  // Older: the same text with an older mark is updated, and gets the new mark.
  writeFileSync(path, newer.replace('0.2.0 -->', '0.0.9 -->'));
  assert.match(sandbox.run(['doctor']).stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind/);
  let result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh);

  // No mark (every project before #141): an unknown version, compared by content as before.
  const unmarked = newer.replace(/^<!-- yokoten kit .* -->\n/, '');
  writeFileSync(path, unmarked);
  result = sandbox.run(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'updated, and the mark is added');
  writeFileSync(path, fresh.replace(/^<!-- yokoten kit .* -->\n/, ''));
  assert.match(sandbox.run(['update']).stdout, /up to date/, 'the mark alone is no change');
});

// CI and the hooks run the copy in .yokoten/. It carries the kit's AGENTS.md, so doctor
// there compares with the kit the project vendored, not "can't compare" (#145).
test('update: the .yokoten/ copy has the kit\'s AGENTS.md, so doctor and update compare from it (#145)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const vendored = (...args: string[]) => spawnSync('node', ['.yokoten/bin/yokoten.ts', ...args], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  const kitDir = join(sandbox.repo, '.yokoten', 'kit');
  assert.deepEqual(readdirSync(kitDir, { recursive: true }).map(String).sort(), ['project', join('project', 'AGENTS.md')], 'one kit file, no more');
  assert.match(vendored('doctor').stdout, /\n {2}ok +core-rules\n/, 'a fresh project is up to date');

  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  writeFileSync(path, fresh.replace('Plain English, close to', 'Plain words, close to'));
  assert.match(vendored('doctor').stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind yokoten 0\.1\.0's, or were edited by hand/);
  const result = vendored('update', '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'the copy writes its own kit, the one CI checks against');

  // The control: without the kit file, the copy can't compare. init puts it back.
  rmSync(kitDir, { recursive: true });
  assert.match(vendored('doctor').stdout, /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: this copy of yokoten has no kit/);
  assert.equal(sandbox.run(['init']).status, 0);
  assert.ok(existsSync(join(kitDir, 'project', 'AGENTS.md')), 'init refreshes the copied kit file');
  assert.match(vendored('doctor').stdout, /\n {2}ok +core-rules\n/);
});

// The road (record 0004). A session hears three lines about one step; the marks file is
// set so that the private-marks note does not add a fourth.
test('doctor --session: exactly three lines, about the first step of the first stage not done', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const r = sandbox.run(['doctor', '--session'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 0, 'a session always starts');
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'yokoten: stage 1 of 5, safety net. Next: no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one.',
    'Why: an agent follows the rules it can read, and only those.',
    'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).',
  ]);
  // Outside a repo it says nothing (unless yokoten itself is broken).
  assert.equal(sandbox.run(['doctor', '--session'], { cwd: sandbox.home }).stdout, '');
});

test('doctor --session: "not now" skips a step, by the names yokoten.json already uses', () => {
  const sandbox = makeSandbox();
  const next = () => sandbox.run(['doctor', '--session']).stdout.split('\n')[0];
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'our rules live in the wiki for now' } }));
  assert.match(next(), /stage 1 of 5, safety net\. Next: no tool-call guard/);
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e' } }));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run/, 'a stage with every step not now is passed');
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { rules: 'a', 'tool-hook': 'b', 'commit-check': 'c', runtime: 'd', tests: 'e', ci: 'no remote yet', issues: 'f' } }));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: no issue templates and no pull request template/);
  const full = sandbox.run(['doctor']).stdout;
  assert.match(full, /^ +not now +ci \(Scorecard: CI-Tests\): no remote yet$/m, 'the full map shows the reason');
  assert.match(full, /^ +next +templates \(GitHub community profile\): /m);
  assert.match(full, /^ +to do +changelog \(Best Practices: release_notes\): /m);
  assert.match(full, /^ +to do +titles \(Conventional Commits 1\.0\.0\): CI does not check pull requests/m);
});

test('doctor: each stage boundary, from a fresh repo to the end of the road', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'placeholder-mark\n');
  const key = join(sandbox.home, 'bot.pem');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks };
  const session = (more: Record<string, string> = {}) => sandbox.run(['doctor', '--session'], { extra: { ...extra, ...more } }).stdout.trimEnd().split('\n');
  const next = (more?: Record<string, string>) => session(more)[0];
  assert.match(next(), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  // Stage 1 done, stage 2 not: init without its CI workflow.
  assert.equal(sandbox.run(['init']).status, 0);
  sandbox.withTests();
  rmSync(join(sandbox.repo, '.github', 'workflows', 'yokoten.yml'));
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: CI does not run `yokoten check`/, 'the pull request check alone is not the CI check');
  sandbox.write('TODO.md', '- one\n');
  sandbox.run(['init']);
  assert.match(next(), /stage 2 of 5, issues and pull requests\. Next: a todo file \(TODO\.md\)/);
  rmSync(join(sandbox.repo, 'TODO.md'));
  // Stage 2 done. init wrote a changelog and changes/; without both, stage 3 is next.
  rmSync(join(sandbox.repo, 'CHANGELOG.md'));
  assert.match(next(), /stage 4 of 5/, 'changes/ alone passes the changelog step (#132)');
  rmSync(join(sandbox.repo, 'changes'), { recursive: true });
  assert.match(next(), /stage 3 of 5, release\. Next: no CHANGELOG\.md with an "Unreleased" section, and no changes\/ folder/);
  sandbox.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
  // Stage 3 done.
  assert.match(next(), /stage 4 of 5, a team of agents\. Next: no CODEOWNERS file/);
  sandbox.write('.github/CODEOWNERS', '* @placeholder\n');
  assert.match(next(), /stage 4 of 5, a team of agents\. Next: no bot on this machine/);
  writeFileSync(key, 'not a real key\n');
  const bot = { YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key };
  assert.match(next(bot), /stage 4 of 5, a team of agents\. Next: the yokoten skills are not in/);
  assert.equal(sandbox.run(['install']).status, 0);
  // Stage 4 done. init writes a security policy and Dependabot; the license is the owner's choice.
  assert.match(next(bot), /stage 5 of 5, going public\. Next: no license file; /);
  sandbox.write('LICENSE', 'placeholder license\n');
  assert.deepEqual(session(bot), ['yokoten: every step yokoten can check is done, or marked not now.']);
  // The order is advice, not a gate: a later step done early counts as done.
  rmSync(join(sandbox.repo, 'AGENTS.md'));
  assert.match(next(bot), /stage 1 of 5, safety net\. Next: no AGENTS\.md/);
  assert.match(sandbox.run(['doctor'], { extra: { ...extra, ...bot } }).stdout, /^ +done +security-files \(Scorecard: Security-Policy · OSPS-VM-02\.01\)$/m, 'full doctor names the outside standard (#58)');
});

test('doctor: the tests step wants a test command and a CI step that runs it (#55)', () => {
  const sandbox = makeSandbox();
  const line = () => sandbox.run(['doctor']).stdout.split('\n').find((l) => / tests\b/.test(l)) ?? '';
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  // npm's placeholder script only fails: it is no test command.
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): CI does not run the tests/);
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npm run test\n');
  assert.match(line(), /^ +done +tests/);
  // A project with no package.json: CI that runs a test runner is enough.
  rmSync(join(sandbox.repo, 'package.json'));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: go test ./...\n');
  assert.match(line(), /^ +done +tests/);
});

test('install: skills, agents and hooks once, the user\'s own files untouched', () => {
  const sandbox = makeSandbox();
  const claude = join(sandbox.home, '.claude');
  const shared = join(sandbox.home, '.agents');
  mkdirSync(join(claude, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'agents', 'reviewer.md'), 'my own reviewer\n');
  // The user's own skill in the shared folder, with a kit skill's name.
  mkdirSync(join(shared, 'skills', 'rca'), { recursive: true });
  writeFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'my own rca\n');
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }));
  // An unknown option is refused, and nothing is written (#203).
  const homeBefore = readdirSync(sandbox.home, { recursive: true }).sort();
  let result = sandbox.run(['install', '--dry-run']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'yokoten install: unknown option --dry-run. Run `yokoten install --help`.\n']);
  assert.deepEqual(readdirSync(sandbox.home, { recursive: true }).sort(), homeBefore, 'install --dry-run writes nothing');
  result = sandbox.run(['install']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept \(yours\) agent reviewer/);
  assert.equal(readFileSync(join(claude, 'agents', 'reviewer.md'), 'utf8'), 'my own reviewer\n');
  // Every skill in both folders: Claude Code's, and the shared one other agents read (#29).
  const kitSkills = readdirSync(join(sandbox.home, '.local/share/yokoten/kit/user/skills'));
  assert.ok(kitSkills.includes('release'), 'the release skill (#34)');
  // The release skill leaves the tag to the owner: the tag command it gives is stopped for an agent.
  const tagLine = readFileSync(join(claude, 'skills', 'release', 'SKILL.md'), 'utf8').match(/`(git tag [^`]+)`/);
  assert.ok(tagLine);
  assert.equal(sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command: tagLine[1].replaceAll('X.Y.Z', '1.2.3') } }) }).status, 2);
  for (const name of kitSkills) {
    assert.ok(existsSync(join(claude, 'skills', name, 'SKILL.md')), `~/.claude/skills/${name}`);
    assert.ok(existsSync(join(shared, 'skills', name, 'SKILL.md')), `~/.agents/skills/${name}`);
    assert.match(result.stdout, new RegExp(`wrote skill ${name} in ~/\\.claude/skills`));
  }
  assert.match(result.stdout, /kept \(yours\) skill rca in ~\/\.agents\/skills/);
  assert.equal(readFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'utf8'), 'my own rca\n');
  assert.ok(!existsSync(join(shared, 'agents')), 'agents stay Claude-only');
  const marks = join(sandbox.home, '.config/yokoten/private-marks');
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  result = sandbox.run(['install']);
  for (const name of kitSkills) assert.match(result.stdout, new RegExp(`same skill ${name} in ~/\\.claude/skills`));
  for (const name of kitSkills.filter((n) => n !== 'rca')) assert.match(result.stdout, new RegExp(`same skill ${name} in ~/\\.agents/skills`));
  assert.match(result.stdout, /kept \(yours\) skill rca in ~\/\.agents\/skills/);
  const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'x');
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.Stop, undefined, "the stop check reads files, so it is per project, from init (#92)");
  // The installed copy runs on its own.
  const doctor = spawnSync('node', [join(sandbox.home, '.local/share/yokoten/bin/yokoten.ts'), 'doctor', '--session'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /private-marks is missing or empty/);
  // The home folder names the machine's user; it never shows (#25).
  for (const out of [result.stdout, doctor.stdout]) assert.ok(!out.includes(sandbox.home), 'output shows the home path');
  assert.match(doctor.stdout, /~\/\.config\/yokoten\/private-marks/);
  // The skills check wants every skill in both folders, and names what is missing.
  // Skills are a step on the road, stage 4.
  const skillsLine = () => sandbox.run(['doctor']).stdout.split('\n').find((l) => / skills/.test(l)) ?? '';
  assert.match(skillsLine(), /^\s+done\s+skills$/);
  rmSync(join(shared, 'skills', 'inspect'), { recursive: true });
  assert.match(skillsLine(), /^\s+(next|to do)\s+skills: the yokoten skills are not in ~\/\.agents\/skills \(inspect\); run `yokoten install`, or install the Claude Code plugin$/);
});

test('check --pr: reads the CI event, lists the changed files from git, notes long prose (#47)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.write('README.md', `Short.\n${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (body: string) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n';
  let result = sandbox.run(['check', '--pr'], { extra: event(body) });
  assert.equal(result.status, 1, 'src/a.ts changed with no changelog line');
  assert.match(result.stderr, /changelog: 1 changed file/);
  assert.match(result.stdout, /note: 1 long sentence\(s\)\n- README\.md:2: a sentence of 30 words/);
  result = sandbox.run(['check', '--pr'], { extra: event(`${body}No changelog: a test\n`) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --pr: ok/);
  assert.doesNotMatch(result.stdout, /lines, over 400/, 'a small diff gets no size note (#57)');
  // Outside a pull request run, there is nothing to check.
  result = sandbox.run(['check', '--pr']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no pull request in this run/);
});

test('check --pr: a change file counts as the changelog entry, and its form is checked (#132)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const commit = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) sandbox.write(file, content);
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'head');
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  const good = commit({ 'src/a.ts': 'export const a = 1;\n', 'changes/1-a.md': 'Added\n\nA new thing.\n' });
  const bad = commit({ 'changes/1-a.md': 'Improved\n\nA new thing.\n' });
  const event = (head: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = sandbox.run(['check', '--pr'], { extra: event(good) });
  assert.equal(result.status, 0, result.stderr);
  result = sandbox.run(['check', '--pr'], { extra: event(bad) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- changes\/1-a\.md:1: line 1 is not a section\. .*Make line 1 one of: Added, Changed/);
  assert.doesNotMatch(result.stderr, /changelog: /, 'the file still counts as the entry');
});

test('changelog: previews the change files, and --write moves them into CHANGELOG.md (#132)', () => {
  const sandbox = makeSandbox();
  let result = sandbox.run(['changelog']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no change files in changes\//);
  sandbox.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-18\n\n### Added\n\n- The first release.\n');
  sandbox.write('changes/README.md', '# Change files\n');
  sandbox.write('changes/2-b.md', 'Fixed\n\nA fix.\n');
  sandbox.write('changes/1-a.md', 'Added\n\nA thing.\n');
  result = sandbox.run(['changelog']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 change\(s\); `--write` adds these under \[Unreleased\] in CHANGELOG\.md:\n\n### Added\n\n- A thing\.\n\n### Fixed\n\n- A fix\.\n$/);
  assert.ok(existsSync(join(sandbox.repo, 'changes/1-a.md')), 'a preview writes nothing');
  // A bad file stops the write, and says so on stderr.
  sandbox.write('changes/3-c.md', 'Added\n');
  result = sandbox.run(['changelog', '--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 problem\(s\); nothing was written:\n- changes\/3-c\.md:1: no entry after the section/);
  rmSync(join(sandbox.repo, 'changes/3-c.md'));
  result = sandbox.run(['changelog', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote 2 change\(s\) under \[Unreleased\] in CHANGELOG\.md, and deleted:\n- changes\/1-a\.md\n- changes\/2-b\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n### Fixed\n\n- A fix.\n\n## [0.1.0] - 2026-10-18\n\n### Added\n\n- The first release.\n');
  assert.deepEqual(readdirSync(join(sandbox.repo, 'changes')), ['README.md']);
  assert.equal(sandbox.run(['changelog', '--wrote']).status, 1, 'an unknown option is refused');
});

test('check --pr: CODEOWNERS comes from the base branch, so a pull request cannot lower its own tier', () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/CODEOWNERS', '/kit/ @owner\n');
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // The pull request edits CODEOWNERS to drop kit/, and changes kit/.
  sandbox.write('.github/CODEOWNERS', '/nothing/ @owner\n');
  sandbox.write('kit/a.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (tier: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = `tier: ${tier}\nCloses #1\nThis changes the kit.\n## Why\nx\n## What changed\nx\n## How tested\nx\n`;
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = sandbox.run(['check', '--pr'], { extra: event('B') });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): kit\/a\.md/);
  r = sandbox.run(['check', '--pr'], { extra: event('A') });
  assert.equal(r.status, 0, r.stderr);
});

test('check --pr: a large pull request gets a note, never a failure; lock files do not count (#57)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const a${i} = ${i};\n`).join('');
  sandbox.write('package-lock.json', lines(1000));
  sandbox.write('src/a.ts', lines(300));
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'small');
  const small = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/b.ts', lines(200));
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'large');
  const large = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const event = (head: string) => {
    const file = join(sandbox.home, 'event.json');
    const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
    return { GITHUB_EVENT_PATH: file };
  };
  let r = sandbox.run(['check', '--pr'], { extra: event(small) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /lines, over 400/, '300 lines; the lock file does not count');
  r = sandbox.run(['check', '--pr'], { extra: event(large) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: this pull request changes 500 lines, over 400\. Smaller pull requests are easier to review/);
  assert.match(r.stdout, /check --pr: ok/);
});

test('check --issue: reads the issue from the CI event; a bad title fails, a good one passes', () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['doctor', 'check'] }));
  const event = (issue: object) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ action: 'opened', issue }));
    return { GITHUB_EVENT_PATH: file };
  };
  let result = sandbox.run(['check', '--issue'], { extra: event({ title: 'doctor: add the review step', labels: [{ name: 'feat' }] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check --issue: ok/);
  result = sandbox.run(['check', '--issue'], { extra: event({ title: 'The review step is missing.', labels: [{ name: 'incident' }] }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check --issue: 2 problem\(s\)\n- title: it does not start with an area\. .+`area: symptom`.+\n  docs: \S+#issue-titles\n- title: a full stop at the end\./);
  assert.doesNotMatch(result.stderr, /The review step is missing/, 'the title is user input; it is not printed back');
  result = sandbox.run(['check', '--issue'], { extra: event({ title: 'site: a page', labels: [] }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use one of: doctor, check\./);
  result = sandbox.run(['check', '--issue', '--json'], { extra: event({ title: 'site: a page.', labels: [] }) });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.check, 'issue');
  assert.deepEqual(report.findings.map((f: { id: string }) => f.id), ['issue-area', 'issue-title']);
  assert.ok(!result.stdout.includes('a page'), 'the title is not printed back');
  result = sandbox.run(['check', '--issue', '--pr']);
  assert.equal(result.status, 1, 'two modes are a usage error');
  assert.equal(result.stdout, '');
  // A comment on a pull request comes as an issue too; it is not an issue to check.
  result = sandbox.run(['check', '--issue'], { extra: event({ title: 'Anything', pull_request: { url: 'x' } }) });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = sandbox.run(['check', '--issue']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no issue in this run/);
  result = sandbox.run(['check', '--issue', '--json']);
  assert.deepEqual(JSON.parse(result.stdout).skipped, 'no issue in this run (it reads the CI event); nothing to check');
});

// #91: in GitHub Actions, the findings show on the pull request page: an annotation per
// finding on stdout, and a job summary. The finding text is reused, so no private value.
test('check in GitHub Actions: annotations and a job summary, place but never content (#91)', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  const email = `me${at}gmail.com`;
  sandbox.write('a.md', 'fine\n');
  sandbox.write('notes/b.md', `fine\n${email}\nI live in MyCity\ntoken ${token}\n`);
  sandbox.git('add', '.');
  const summary = join(sandbox.home, 'summary.md');
  const actions = { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, YOKOTEN_PRIVATE_MARKS: marks };
  const before = sandbox.run(['check'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  const result = sandbox.run(['check'], { extra: actions });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, before.stderr, 'the text for people is the same');
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^::error file=notes\/b\.md,line=2,title=yokoten email::an email address\. .+\. .+\.%0A  docs: https:\/\/\S+#privacy$/);
  assert.match(lines[1], /^::error file=notes\/b\.md,line=3,title=yokoten private-mark::matches a line of your private-marks file\. /);
  assert.match(lines[2], /^::error file=notes\/b\.md,line=4,title=yokoten secret::a secret \(GitHub token\)\. /);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check: 3 problems\n\n\| Place \| Rule \| What \| Why \| Fix \|\n/);
  assert.match(text, /\| notes\/b\.md:2 \| \[email\]\(https:\/\/\S+#privacy\) \| an email address \| .+ \| .+ \|/);
  assert.match(text, /\| notes\/b\.md:3 \| \[private-mark\]\(\S+\) \| matches a line of your private-marks file \|/);
  assert.match(text, /\| notes\/b\.md:4 \| \[secret\]\(\S+\) \| a secret \(GitHub token\) \|/);
  // The positive control: the place is there, the matched text is not (core rule 11).
  for (const out of [result.stdout, text]) {
    assert.ok(!out.includes(token) && !out.includes(email) && !/mycity/i.test(out), 'no matched text');
    assert.ok(!out.includes(sandbox.home), 'the home folder is never shown');
  }
  // --json keeps stdout pure JSON; the summary is still written. The summary file grows.
  const json = sandbox.run(['check', '--json'], { extra: actions });
  assert.equal(JSON.parse(json.stdout).ok, false);
  assert.equal(readFileSync(summary, 'utf8').split('### yokoten check: 3 problems').length, 3, 'appended, not replaced');
  // ok, with the mode in the heading.
  sandbox.git('rm', '-q', '--cached', 'notes/b.md');
  rmSync(join(sandbox.repo, 'notes'), { recursive: true });
  const ok = sandbox.run(['check', '--staged'], { extra: actions });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'yokoten check: ok\n', 'no findings, no annotations');
  assert.match(readFileSync(summary, 'utf8'), /### yokoten check --staged: ok\n\n$/);
});

test('check outside GitHub Actions: the output is unchanged and no summary is written (#91)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  const summary = join(sandbox.home, 'summary.md');
  const plain = sandbox.run(['check']);
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /^yokoten check: 1 problem\(s\)\n- a\.md:1: an email address\. [^\n]+\.\n  docs: https:\/\/\S+#privacy\n$/);
  for (const extra of [{ GITHUB_STEP_SUMMARY: summary }, { GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: summary }] as Record<string, string>[]) {
    const r = sandbox.run(['check'], { extra });
    assert.deepEqual([r.status, r.stdout, r.stderr], [plain.status, plain.stdout, plain.stderr], JSON.stringify(extra));
  }
  assert.ok(!existsSync(summary), 'no summary outside Actions');
});

test('check --pr: notes hard-to-read names on added code lines, and the exit code does not change (#111)', () => {
  const project = makeSandbox();
  const filler = Array(11).fill('// filler');
  // An old file with a long-lived one-letter name: not noted, its lines are not added.
  project.write('src/old.ts', ['const t = 0;', ...filler, 'console.log(t);', ''].join('\n'));
  project.write('src/moved.ts', ['const q = 0;', ...filler, 'console.log(q);', ''].join('\n'));
  project.git('add', '.');
  project.git('commit', '-qm', 'base');
  const base = project.git('rev-parse', 'HEAD').stdout.trim();
  project.write('src/old.ts', ['const t = 0;', ...filler, 'console.log(t);', 'const count = t + 1;', ''].join('\n'));
  project.git('mv', 'src/moved.ts', 'src/renamed.ts');
  project.write('src/cart.js', ['const s = 0;', 'const loadTheWholeUserList = () => [];', 'for (let i = 0; i < 3; i++) console.log(i);', ...filler, 'console.log(s);', ''].join('\n'));
  project.git('add', '.');
  project.git('commit', '-qm', 'head');
  const head = project.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(project.home, 'event.json');
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
  const r = project.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 2 hard-to-read name\(s\)\n- src\/cart\.js:1: "s" is used for 14 lines\. A reader must scroll back to learn what it holds\. Name what it is, e\.g\. "text"\.\n  docs: \S+#naming\n- src\/cart\.js:2: "loadTheWholeUserList" has 5 words, over 4\. /);
  assert.doesNotMatch(r.stdout, /"i"|old\.ts|renamed\.ts/, 'no note for `i` in a short loop, for unchanged lines, or for a moved file');
  assert.match(r.stdout, /check --pr: ok/);
  const json = JSON.parse(project.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } }).stdout);
  assert.equal(json.ok, true, 'notes never fail the check');
  assert.deepEqual(json.notes.map((note: { id: string; file: string; line: number }) => `${note.id} ${note.file}:${note.line}`), ['name-short src/cart.js:1', 'name-long src/cart.js:2']);
});

test('check --pr in GitHub Actions: notes are warnings, in their own section (#91)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('README.md', `Short.\n${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')}.\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n', labels: [{ name: 'feat' }], milestone: null, base: { sha: base }, head: { sha: head } } }));
  const summary = join(sandbox.home, 'summary.md');
  const r = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1, 'no milestone');
  assert.match(r.stdout, /^::error title=yokoten pr-milestone::/m, 'a finding with no place has no file');
  assert.match(r.stdout, /^::warning file=README\.md,line=2,title=yokoten long-sentence::a sentence of 30 words\. /m);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check --pr: 1 problem\n/);
  assert.match(text, /\n#### Notes \(1\): these never fail the check\n\n\| Place \| Rule \| What \| Why \| Fix \|\n\|[-|]+\|\n\| README\.md:2 \| long-sentence \| a sentence of 30 words \|/);
});

// #42: stdout is data and stderr is for people; --json prints pure JSON. Exit codes are
// written down once (docs/guide.md, "Exit codes") and held here.
test('exit codes: 0 ok, 1 problems or a usage error, 2 the hook blocked (#42)', () => {
  const sandbox = makeSandbox();
  const hook = (command: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  assert.equal(sandbox.run(['check']).status, 0);
  assert.equal(hook('git status').status, 0);
  assert.equal(sandbox.run(['doctor', '--session']).status, 0, 'a session always starts');
  assert.equal(sandbox.run(['explain', 'release']).status, 0);
  assert.equal(sandbox.run(['doctor']).status, 1, 'steps left on the road');
  sandbox.write('b.md', `me${at}gmail.com\n`);
  sandbox.git('add', '.');
  assert.equal(sandbox.run(['check']).status, 1);
  assert.equal(sandbox.run(['explain', 'nope']).status, 1);
  assert.equal(hook('git push --tags').status, 2);
  // A usage error is refused, never ignored: no fake success.
  for (const args of [['nope'], ['check', '--stagd'], ['check', '--staged', '--pr'], ['check', 'extra'], ['doctor', '--sesion'], ['hook', '--agent'], ['explain', 'a', 'b']]) {
    const r = sandbox.run(args, { input: '{}' });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '', `${args.join(' ')}: nothing on stdout`);
    assert.notEqual(r.stderr, '', `${args.join(' ')}: says why on stderr`);
  }
});

test('help: every command has --help, -h and `help <command>`; each exits 0 and writes nothing (#207)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const before = () => [sandbox.git('status', '--porcelain', '--ignored').stdout, readdirSync(sandbox.home, { recursive: true }).sort()];
  const start = before();
  for (const command of COMMANDS) {
    for (const args of [[command.name, '--help'], [command.name, '-h'], ['help', command.name], [command.name, '--nope', '--help']]) {
      const r = sandbox.run(args, { input: '{}' });
      assert.deepEqual([r.status, r.stderr], [0, ''], args.join(' '));
      assert.match(r.stdout, new RegExp(`^Usage: yokoten ${command.name}\\b`), args.join(' '));
      for (const option of [...command.options.map((o) => o.name), ...HELP_OPTIONS]) assert.ok(r.stdout.includes(option), `${args.join(' ')}: names ${option}`);
      assert.match(r.stdout, /\nExample:\n {2}\S/, `${args.join(' ')}: one example`);
    }
  }
  assert.deepEqual(before(), start, '--help writes nothing');
  // The command list names every command, and -h and -v work alone.
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const r = sandbox.run(args);
    assert.equal(r.status, 0, args.join(' '));
    for (const command of COMMANDS) assert.match(r.stdout, new RegExp(`^ {2}${command.name} `, 'm'), `${args.join(' ')}: lists ${command.name}`);
  }
  assert.equal(sandbox.run(['-v']).stdout, sandbox.run(['--version']).stdout);
});

test('help: the help table and the parser list the same commands and options (#207)', () => {
  const source = readFileSync(CLI, 'utf8');
  // Every parse call names a command in the table; no option list is written outside it.
  const parsed = [...source.matchAll(/\bparse\('([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...parsed].sort(), COMMANDS.map((command) => command.name).sort(), 'each command parses its words by its help entry');
  assert.doesNotMatch(source, /flags: \[/, 'no option list outside the help table');
  const cases = [...source.matchAll(/^ {4}case '([a-z]+)':/gm)].map((m) => m[1]);
  assert.deepEqual([...cases].sort(), COMMANDS.map((command) => command.name).sort(), 'each command in the switch has a help entry, and the reverse');
  // Each option the help lists is accepted: with it, the parser gives no "unknown option".
  const sandbox = makeSandbox();
  for (const command of COMMANDS) {
    for (const option of command.options) {
      const r = sandbox.run([command.name, option.name, ...(option.value ? ['x'] : []), '--not-an-option']);
      assert.match(r.stderr, new RegExp(`unknown option --not-an-option`), `${command.name} ${option.name}`);
    }
  }
});

test('help: a typo in a command or an option names the closest one; a far one lists the commands (#207)', () => {
  const sandbox = makeSandbox();
  const cases: [string[], string][] = [
    [['docter'], 'yokoten: unknown command "docter". Did you mean "doctor"? Run `yokoten help`.\n'],
    [['help', 'chek'], 'yokoten: unknown command "chek". Did you mean "check"? Run `yokoten help`.\n'],
    [['check', '--stagd'], 'yokoten check: unknown option --stagd. Did you mean --staged? Run `yokoten check --help`.\n'],
    [['doctor', '--hepl'], 'yokoten doctor: unknown option --hepl. Did you mean --help? Run `yokoten doctor --help`.\n'],
  ];
  for (const [args, stderr] of cases) assert.deepEqual(pick(sandbox.run(args, { input: '{}' })), [1, '', stderr], args.join(' '));
  const far = sandbox.run(['zzzzzz']);
  assert.deepEqual([far.status, far.stdout], [1, '']);
  assert.match(far.stderr, /^yokoten: unknown command "zzzzzz"\. Commands: install, init, .*version\. Run `yokoten help`\.\n$/);
  assert.equal(editDistance('docter', 'doctor'), 1);
  assert.equal(closestWord('xyz', ['doctor', 'check']), undefined, 'more than two edits: no guess');
});

const pick = (r: { status: number | null; stdout: string; stderr: string }) => [r.status, r.stdout, r.stderr];

test('--json: check, doctor, hook and explain print pure JSON with what, why and fix; never a private value (#42)', () => {
  const sandbox = makeSandbox();
  const marks = join(sandbox.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  const extra = { YOKOTEN_PRIVATE_MARKS: marks, YOKOTEN_ROLE: 'worker' };
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.write('notes/a.md', `me${at}gmail.com\nI live in MyCity\n${token}\nserver ${[10, 1, 2, 3].join('.')}\n`);
  sandbox.write('dist/app.js', 'x\n');
  for (let i = 0; i < 8; i++) sandbox.write(`many/${i}.md`, 'x\n');
  sandbox.git('add', '.');
  const shaped = (f: Record<string, unknown>) => {
    for (const k of ['id', 'what', 'why', 'fix']) assert.ok(typeof f[k] === 'string' && f[k], `${f.id}: ${k}`);
  };
  const clean = (out: string) => {
    for (const secret of ['mycity', 'gmail', token, [10, 1, 2, 3].join('.'), sandbox.home]) assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), `${secret} printed`);
  };

  // check: the text form says what, why and fix on each line.
  let result = sandbox.run(['check', '--staged'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(result.status, 1);
  const lines = result.stderr.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length >= 7, result.stderr);
  for (const line of lines) assert.match(line, /^- .+\. [A-Z].+\. .+\.$/, line);
  clean(result.stderr);
  result = sandbox.run(['check', '--staged', '--json'], { extra: { ...extra, GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
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
    docs: 'https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#privacy',
    file: 'notes/a.md',
    line: 1,
  });
  clean(result.stdout);
  result = sandbox.run(['check', '--json'], { extra });
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['check', 'ok', 'findings', 'notes']);

  // hook: the runtimes still read stderr and the exit code; --json adds the finding on stdout.
  const call = { cwd: sandbox.repo, tool_input: { command: 'git push --force' } };
  result = sandbox.run(['hook', '--json'], { input: JSON.stringify(call) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^yokoten: git push --force forces the push\. .+\. Use --force-with-lease/);
  const blocked = JSON.parse(result.stdout);
  assert.equal(blocked.blocked, true);
  shaped(blocked.finding);
  assert.equal(blocked.finding.id, 'force-push');
  result = sandbox.run(['hook', '--json'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command: 'git status' } }) });
  assert.deepEqual([result.status, JSON.parse(result.stdout)], [0, { blocked: false, toolCall: true }]);
  result = sandbox.run(['hook'], { input: JSON.stringify(call) });
  assert.equal(result.stdout, '', 'without --json, stdout stays empty for the runtimes');

  // doctor: the road and the machine as data.
  result = sandbox.run(['doctor', '--json'], { extra });
  assert.equal(result.status, 1);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.stage, 1);
  assert.equal(doc.next.id, 'tool-hook');
  assert.ok(doc.steps.some((st: { id: string; mark: string }) => st.id === 'rules' && st.mark === 'done'));
  assert.ok(doc.findings.some((f: { id: string }) => f.id === 'secret'), 'the tree check is in it');
  doc.findings.forEach(shaped);
  doc.notes.forEach(shaped);
  clean(result.stdout);
  result = sandbox.run(['doctor', '--session', '--json'], { extra });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['tool-hook']);

  // explain: a known id, and an unknown one with the list.
  result = sandbox.run(['explain', 'secret', '--json']);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['found', 'id', 'kind', 'what', 'why', 'check', 'docs']);
  result = sandbox.run(['explain', 'nope', '--json']);
  assert.equal(result.status, 1);
  const unknown = JSON.parse(result.stdout);
  assert.equal(unknown.found, false);
  assert.ok(unknown.ids.includes('secret') && unknown.ids.includes('tool-hook'));
  result = sandbox.run(['explain', 'secret']);
  assert.match(result.stdout, /^secret: .+\.\nWhy: .+\.\nCheck: .+\.\nDocs: https:\/\/github\.com\/yokoten-labs\/yokoten\/blob\/main\/docs\/guide\.md#privacy\n$/, 'the link to the rule (#94)');
  result = sandbox.run(['explain', 'commit-check']);
  assert.match(result.stdout, /^commit-check: a step on the road: stage 1 of 5, safety net\.\nWhy: .+\.\nCheck: .+\.\nStandard: OSPS-BR-07\.01\.\n$/);
  result = sandbox.run(['explain']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ids: release, /);
});

test('init: reads GitHub and says what it would do; --github --yes does it, and a second run changes nothing (#10)', () => {
  const sandbox = makeSandbox();
  // A fake gh first on PATH, holding the repo in a file. The real gh and GitHub are never reached.
  const bin = join(sandbox.home, 'bin');
  const state = join(sandbox.home, 'gh.json');
  mkdirSync(bin);
  writeFileSync(state, JSON.stringify({ labels: [{ name: 'bug', color: 'd73a4a', description: 'Something does not work as it should' }, { name: 'question', color: 'd876e3', description: '' }], milestones: [], calls: [] }));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const a = process.argv.slice(2);
const option = (name) => a[a.indexOf(name) + 1];
s.calls.push(a.join(' '));
if (a[0] === 'label' && a[1] === 'create') s.labels.push({ name: a[2], color: option('--color'), description: option('--description') });
else if (a[0] === 'label' && a[1] === 'delete') s.labels = s.labels.filter((l) => l.name !== a[2]);
else if (a.includes('POST')) s.milestones.push(a.at(-1).slice(6));
else if (a[0] === 'api' && a.some((w) => w.includes('/labels'))) s.labels.forEach((l) => console.log(JSON.stringify(l)));
else if (a[0] === 'api') s.milestones.forEach((m) => console.log('open ' + m));
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  const calls = (): string[] => JSON.parse(readFileSync(state, 'utf8')).calls;
  const changed = () => calls().filter((c) => /^label |POST/.test(c));
  // Without a GitHub remote, init succeeds, says what it skipped, and never runs gh.
  let result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because there is no origin remote yet/);
  assert.equal(calls().length, 0);
  assert.equal(sandbox.run(['init', '--yes'], { extra }).status, 1, '--yes alone is refused');
  assert.equal(sandbox.run(['init', '--remove-default-labels'], { extra }).status, 1, 'so is --remove-default-labels');
  sandbox.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: example\/repo\n- 1 of the 9 standard labels are there; kept\n- not in the standard set: question\./);
  assert.match(result.stdout, /Would do:\n- make label "feat"[^]*- make milestone "First release"\nNothing changed\./);
  assert.deepEqual(changed(), [], 'plain init only reads');
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- done: make label "good first issue"[^\n]*\n[^]*- done: make milestone "First release"/);
  assert.equal(changed().length, 9);
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.match(result.stdout, /- 9 of the 9 standard labels are there; kept\n- a milestone is open; kept\n[^]*Nothing to change\./);
  assert.equal(changed().length, 9, 'the second run changed nothing');
  // Without gh on the PATH, init still succeeds and says so. Only node and git are there.
  const noGh = join(sandbox.home, 'no-gh');
  mkdirSync(noGh);
  const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(noGh, 'node'));
  symlinkSync(join(gitPath, 'git'), join(noGh, 'git'));
  result = sandbox.run(['init', '--github', '--yes'], { extra: { PATH: noGh } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because gh is not installed/);
});

// The Claude Code plugin (#31). The repo root is the plugin and its own marketplace, so the
// plugin names the kit's files and copies none. The fields and path rules checked here are
// the documented ones: code.claude.com/docs/en/plugins/manifest-reference and
// code.claude.com/docs/en/plugins/marketplace-reference.
const ROOT = join(dirname(CLI), '..');
const manifest = (name: string) => JSON.parse(readFileSync(join(ROOT, '.claude-plugin', name), 'utf8'));
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

test('plugin: the marketplace and the plugin have the documented fields', () => {
  const market = manifest('marketplace.json');
  const plugin = manifest('plugin.json');
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  assert.match(market.name, idPattern);
  assert.equal(typeof market.owner?.name, 'string');
  assert.ok(market.owner.name.length > 0);
  assert.equal(market.plugins.length, 1);
  const [entry] = market.plugins;
  assert.match(entry.name, idPattern);
  // The entry name and the manifest name are the same, or an install by name fails.
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.source, './', 'the repo root is the plugin');
  assert.match(plugin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case');
  // No version in either file: users get each commit, and package.json keeps the one version.
  assert.equal(plugin.version, undefined);
  assert.equal(entry.version, undefined);
});

test('plugin: every path it names exists inside the plugin, and the kit is not copied', () => {
  const plugin = manifest('plugin.json');
  const paths: string[] = [...plugin.skills, ...plugin.agents];
  for (const p of paths) {
    assert.ok(p.startsWith('./'), `${p} starts with ./`);
    assert.ok(!p.split('/').includes('..'), `${p} stays in the plugin`);
    assert.ok(existsSync(join(ROOT, p)), `${p} exists`);
  }
  // Skills are folders of <name>/SKILL.md: the ones install puts on a machine, and the
  // plugin's own, which run yokoten from the plugin. Agents are .md files, every kit agent.
  assert.deepEqual(plugin.skills, ['./kit/user/skills/', './kit/plugin/skills/']);
  for (const dir of plugin.skills) for (const name of readdirSync(join(ROOT, dir))) assert.ok(existsSync(join(ROOT, dir, name, 'SKILL.md')), `${dir}${name}`);
  assert.deepEqual(plugin.agents, readdirSync(join(ROOT, 'kit/user/agents')).sort().map((f) => `./kit/user/agents/${f}`), 'list every agent in kit/user/agents');
  // Every script a hook or a plugin skill runs is in the plugin, named from its root.
  const skills = readdirSync(join(ROOT, 'kit/plugin/skills')).map((name) => readFileSync(join(ROOT, 'kit/plugin/skills', name, 'SKILL.md'), 'utf8'));
  const text = [JSON.stringify(plugin.hooks), ...skills].join('\n');
  const scripts = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\ ]+)/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 4, 'the scan found the hooks and commands');
  for (const s of scripts) assert.ok(existsSync(join(ROOT, s)), s);
});

test('plugin: its hooks are the ones install adds, and the guard it registers blocks', () => {
  const sandbox = makeSandbox();
  const hooks = manifest('plugin.json').hooks as Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
  // install's user-level hooks, with the plugin's root in place of the machine copy.
  assert.equal(sandbox.run(['install']).status, 0);
  const installed = JSON.parse(readFileSync(join(sandbox.home, '.claude', 'settings.json'), 'utf8')).hooks;
  const shape = (h: typeof hooks, cli: string) => Object.fromEntries(Object.entries(h).map(([event, groups]) => [event, groups.map((g) => ({ matcher: g.matcher, commands: g.hooks.map((x) => `${x.type}: ${x.command.replace(cli, 'CLI')}`) }))]));
  assert.deepEqual(shape(hooks, `"${PLUGIN_ROOT}/bin/yokoten.ts"`), shape(installed, '"$HOME/.local/share/yokoten/bin/yokoten.ts"'));
  // The command as Claude Code runs it: the root filled in, through the shell.
  const run = (command: string, input?: string, extra: Record<string, string> = {}) =>
    spawnSync(command.replaceAll(PLUGIN_ROOT, ROOT), { shell: true, cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PLUGIN_ROOT: ROOT, ...extra }, input, encoding: 'utf8' });
  const guard = hooks.PreToolUse[0].hooks[0].command;
  const call = (command: string) => JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const r = run(guard, call('git push --force origin main'));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /force/);
  assert.equal(run(guard, call('git status')).status, 0);
  // At session start, doctor tells the agent how to run yokoten from the plugin.
  const session = run(hooks.SessionStart[0].hooks[0].command);
  assert.equal(session.status, 0, session.stderr);
  assert.match(session.stdout, /^yokoten: stage 1 of 5/);
  assert.match(session.stdout, /runs as \/yokoten:init, \/yokoten:doctor and \/yokoten:update/);
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, /yokoten:init/, 'only from the plugin');
});

// /yokoten:update (#142). The skill runs the plugin's own yokoten, which may be newer
// than the project's .yokoten/ copy: the preview first, the write only when asked.
test('plugin: /yokoten:update previews from the plugin, then writes with --write; a .yokoten/ copy without its kit cannot compare', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const old = fresh.replace('Plain English, close to', 'Plain words, close to');
  assert.notEqual(old, fresh);
  writeFileSync(path, old);
  const skill = readFileSync(join(ROOT, 'kit/plugin/skills/update/SKILL.md'), 'utf8');
  const commands = [...skill.matchAll(/^ *(node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/yokoten\.ts" update.*)$/gm)].map((m) => m[1]);
  assert.deepEqual(commands, [`node "${PLUGIN_ROOT}/bin/yokoten.ts" update`, `node "${PLUGIN_ROOT}/bin/yokoten.ts" update --write`], 'preview, then write');
  assert.doesNotMatch(skill, /\.yokoten\/bin/, 'the skill never runs the copy in .yokoten/');
  const run = (command: string) => spawnSync(command.replaceAll(PLUGIN_ROOT, ROOT), { shell: true, cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PLUGIN_ROOT: ROOT }, encoding: 'utf8' });

  // The control: a .yokoten/ copy without its kit file can't compare and writes nothing.
  rmSync(join(sandbox.repo, '.yokoten', 'kit'), { recursive: true });
  const vendored = spawnSync('node', ['.yokoten/bin/yokoten.ts', 'update', '--write'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(vendored.status, 1);
  assert.match(vendored.stderr, /can't compare AGENTS\.md with the kit: this copy of yokoten has no kit.*\/yokoten:update/);
  assert.equal(readFileSync(path, 'utf8'), old);

  let result = run(commands[0]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^- Plain words, close to/m);
  assert.match(result.stdout, /^\+ Plain English, close to/m);
  assert.equal(readFileSync(path, 'utf8'), old, 'the preview writes nothing');
  result = run(commands[1]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /replaced the core rules in AGENTS\.md/);
  assert.equal(readFileSync(path, 'utf8'), fresh);
  assert.match(run(commands[0]).stdout, /up to date/);
});

test('doctor: the plugin, when on, stands in for install', () => {
  const sandbox = makeSandbox();
  const machine = () => sandbox.run(['doctor']).stdout;
  assert.match(machine(), /MISSING session-doctor: sessions do not start with doctor; run `yokoten install`, or install the Claude Code plugin/);
  assert.match(machine(), /MISSING runtime: no runtime installed/);
  mkdirSync(join(sandbox.home, '.claude'));
  const settings = (enabledPlugins: unknown) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
  settings({ 'yokoten@yokoten': false });
  assert.match(machine(), /MISSING session-doctor/, 'off is off');
  settings({ 'yokoten@yokoten': true });
  const out = machine();
  assert.match(out, /ok {6}session-doctor/);
  assert.match(out, /ok {6}runtime/);
  assert.match(out, /^ +(done|to do|next) +skills$/m);
  assert.doesNotMatch(out, /skills: the yokoten skills are not in/);
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), 'not json');
  assert.match(machine(), /MISSING session-doctor/, 'a broken settings file enables nothing');
});

// #198: a plugin older than this yokoten is a note, in full doctor and in a session. A fake
// install in the fake HOME, laid out as Claude Code keeps it; the real one is never read.
test('doctor: notes an installed plugin older than this yokoten (#198)', () => {
  const sandbox = makeSandbox();
  const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const plugins = join(sandbox.home, '.claude', 'plugins');
  const folder = join(plugins, 'cache', 'yokoten', 'yokoten', 'abc123');
  mkdirSync(folder, { recursive: true });
  const enable = (on: boolean) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': on } }));
  const install = (entry: object) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: folder, version: 'abc123', ...entry }] } }));
  const pluginVersion = (v: string) => writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'yokoten', version: v }));
  const full = () => sandbox.run(['doctor']).stdout;
  const olderNote = /the yokoten plugin is older than this yokoten/;

  // Positive control: an old plugin is noted, with the one command, and doctor does not fail on it.
  enable(true);
  install({ gitCommitSha: 'abc123' });
  pluginVersion('0.0.1');
  const lines = full().split('\n');
  const line = `  note    plugin: the yokoten plugin is older than this yokoten (0.0.1 < ${version}); update it: \`claude plugin update yokoten@yokoten\`, then restart Claude Code`;
  assert.ok(lines.includes(line), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('MISSING plugin')));
  assert.match(sandbox.run(['doctor', '--session']).stdout, olderNote);
  const json = JSON.parse(sandbox.run(['doctor', '--json']).stdout);
  assert.ok(json.notes.some((n: { what: string }) => olderNote.test(n.what)), 'a note in JSON');
  assert.ok(!json.findings.some((f: { what: string }) => olderNote.test(f.what)), 'not a finding');

  // The same version, or a newer one: nothing.
  pluginVersion(version);
  assert.doesNotMatch(full(), olderNote);
  pluginVersion('9999.0.0');
  assert.doesNotMatch(full(), olderNote);
  // Off in the settings: the plugin does not run, so its age does not matter.
  pluginVersion('0.0.1');
  enable(false);
  assert.doesNotMatch(full(), olderNote);
  enable(true);
  // A project install for another project is not this one's.
  install({ scope: 'project', projectPath: join(sandbox.home, 'elsewhere') });
  assert.doesNotMatch(full(), olderNote);
  // No install file, or an odd one: no note, no crash.
  for (const text of [null, 'not json', '{"plugins": []}', '{"plugins": {"yokoten@yokoten": "odd"}}', '{"plugins": {"yokoten@yokoten": [null, 7]}}']) {
    rmSync(join(plugins, 'installed_plugins.json'), { force: true });
    if (text !== null) writeFileSync(join(plugins, 'installed_plugins.json'), text);
    const result = sandbox.run(['doctor']);
    assert.ok(result.stdout.includes('machine:'), `${text}: doctor ran to the end`);
    assert.doesNotMatch(result.stdout, olderNote, String(text));
    assert.doesNotMatch(result.stderr, /Error/, String(text));
  }
  install({ gitCommitSha: 'abc123' });
  rmSync(join(folder, 'package.json'));
  assert.doesNotMatch(full(), olderNote, 'outside a yokoten checkout, a commit alone tells nothing');
});

test('doctor: in a yokoten checkout, a plugin commit behind the default branch is a note (#198)', () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', JSON.stringify({ name: 'yokoten', version: '0.0.1' }));
  sandbox.write('bin/yokoten.ts', '');
  sandbox.git('add', '.');
  sandbox.git('commit', '-q', '-m', 'feat: one');
  const first = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const plugins = join(sandbox.home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  // No installPath and no package.json: only the commit can tell.
  const install = (sha: string) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'yokoten@yokoten': [{ scope: 'user', version: sha.slice(0, 12), gitCommitSha: sha }] } }));
  const olderNote = /the yokoten plugin is older than this yokoten \(([0-9a-f]{12}) < ([0-9a-f]{12})\)/;
  const commit = (name: string) => {
    sandbox.write(`${name}.md`, `${name}\n`);
    sandbox.git('add', '.');
    sandbox.git('commit', '-q', '-m', `feat: ${name}`);
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  install(first);
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote, 'the plugin is main');
  // The plugin is main's tip and doctor runs on a feature branch ahead of main: up to date,
  // though HEAD descends from it. An update could not help, so nothing.
  sandbox.git('checkout', '-q', '-b', 'feature');
  commit('two');
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote, 'the plugin is main, HEAD is ahead');
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, olderNote);
  // Positive control: main moves on, so the plugin is one commit behind it, on any branch.
  sandbox.git('checkout', '-q', 'main');
  const tip = commit('three');
  sandbox.git('checkout', '-q', 'feature');
  const match = sandbox.run(['doctor']).stdout.match(olderNote);
  assert.deepEqual(match?.slice(1), [first.slice(0, 12), tip.slice(0, 12)]);
  assert.match(sandbox.run(['doctor', '--session']).stdout, olderNote);
  // A commit this repo doesn't know: can't tell, so nothing.
  install('0'.repeat(40));
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote);
  // No origin/HEAD, origin/main or main: no default branch to compare with, so nothing.
  install(first);
  sandbox.git('branch', '-q', '-m', 'main', 'trunk');
  assert.doesNotMatch(sandbox.run(['doctor']).stdout, olderNote, 'no main ref');
});

// #117: the bot checks a title before it sends anything, by the rules CI uses. A fake gh
// and a local API server stand in for GitHub; the real ones are never reached.
test('bot: a bad title is refused before the token is asked for; a good one runs (#117)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host', 'check'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN }) + '\\n');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  // A throwaway key, made for this test run only.
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const path = { PATH: `${bin}:${process.env.PATH}` };
  const bot = { ...path, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  // Not spawnSync: the server must answer while the CLI runs.
  const run = (command: string[], extra: Record<string, string> = bot, before: string[] = []) =>
    new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn('node', [CLI, 'bot', ...before, '--', ...command], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra } });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => done({ status, stderr }));
    });
  const refused = async (command: string[], pattern: RegExp, extra?: Record<string, string>) => {
    const r = await run(command, extra);
    assert.equal(r.status, 1, command.join(' '));
    assert.match(r.stderr, /^yokoten bot: 1 problem\(s\) in the title; nothing was sent\. Fix the title and run it again:\n- title: /, command.join(' '));
    assert.match(r.stderr, pattern, command.join(' '));
    assert.doesNotMatch(r.stderr, /YOKOTEN_BOT|bot\.pem|GitHub said/, 'the title is the reason, not the bot setup');
    assert.deepEqual(requests, [], `no token was asked for: ${command.join(' ')}`);
    assert.deepEqual(ran(), [], `gh did not run: ${command.join(' ')}`);
  };
  try {
    // Positive controls: each bad title is refused with what, why and the fix.
    await refused(['gh', 'issue', 'create', '--title', `host: ${'a'.repeat(60)}`, '--body', 'x'], /title: 66 characters, over 60\. .+\. Shorten it/);
    await refused(['gh', 'issue', 'create', '-t', 'guard: add a step', '-l', 'feat'], /not in yokoten\.json "areas"\. .+\. Use one of: host, check\.$/m);
    await refused(['gh', 'issue', 'edit', '5', '--title=host: add a step.'], /title: a full stop at the end\. A title is a name/);
    await refused(['gh', 'pr', 'create', `--title=feat(host): ${'a'.repeat(62)}`, '--body', 'x'], /title: 74 characters, over 72\. .+\. Shorten it/);
    await refused(['gh', 'pr', 'edit', '5', '-t', 'feat(host): add a step.'], /title: a full stop at the end\. A commit title has no full stop\. Remove the full stop\./);
    await refused(['gh', 'pr', 'create', '-t', 'feat(guard): add a step'], /the area `guard` is not in yokoten\.json "areas"/);
    // With no bot set up at all, the title is still the reason given.
    await refused(['gh', 'pr', 'create', '--title', 'feat(host): add a step.'], /full stop/, path);
    const missing = await run(['gh', 'pr', 'create', '--title', 'feat(host): add a step'], path);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^yokoten bot: YOKOTEN_BOT_APP_ID is not set/, 'a good title goes on to the bot setup');

    // A good title, and commands with no title, take the normal bot path.
    const good: string[][] = [
      ['gh', 'issue', 'create', '--title', 'host: check the title', '--label', 'incident', '--body', '-t'],
      ['gh', 'pr', 'create', '-t', 'feat(host): check the title', '--body', 'x'],
      ['gh', 'pr', 'create', '--fill'],
      ['gh', 'issue', 'list'],
    ];
    for (const command of good) {
      const r = await run(command);
      assert.equal(r.status, 0, `${command.join(' ')}: ${r.stderr}`);
    }
    assert.deepEqual(ran(), good.map((command) => ({ args: command.slice(1), token: 'ghs_test' })));
    assert.equal(requests.length, good.length * 2, 'one installation lookup and one token per run');

    // bot has no options of its own (#203): one before `--` is refused, and nothing runs.
    const unknown = await run(['echo'], bot, ['--x']);
    assert.deepEqual([unknown.status, unknown.stderr], [1, 'yokoten bot: unknown option --x. Run `yokoten bot --help`.\n']);
    assert.equal(ran().length, good.length, 'gh did not run');
    assert.equal(requests.length, good.length * 2, 'no token was asked for');
    // Everything after `--` is the command's, passed on unchanged.
    const passed = await run(['gh', '--anything', 'issue', 'list']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(ran().at(-1), { args: ['--anything', 'issue', 'list'], token: 'ghs_test' });
    // --help after `--` is the command's own (#207): gh runs, and yokoten prints no help.
    const helped = await run(['gh', '--help']);
    assert.equal(helped.status, 0, helped.stderr);
    assert.deepEqual(ran().at(-1), { args: ['--help'], token: 'ghs_test' });
    // Before `--`, it is bot's help: no bot setup needed, no token, nothing runs.
    const own = await run(['gh', 'issue', 'list'], path, ['--help']);
    assert.equal(own.status, 0, own.stderr);
    assert.equal(ran().length, good.length + 2, 'gh did not run for bot --help');
  } finally {
    server.close();
  }
});

// #77: `learn` turns an incident issue into a check draft. A fake gh first on PATH gives the
// issue; the real gh and GitHub are never reached.
test('learn: previews a check draft from an incident, writes it with --write, and never overwrites', () => {
  const sandbox = makeSandbox();
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const issue = { number: 7, title: 'repo: a test fails behind a proxy', body: '## What happened\n\nA test failed.\n\n## Fix\n\nThe test sets NO_PROXY.\n', url: 'https://example.com/issues/7', labels: [{ name: 'incident' }] };
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nif (process.argv[4] !== '7') { console.error('no such issue'); process.exit(1); }\nconsole.log(${JSON.stringify(JSON.stringify(issue))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const extra = { PATH: `${bin}:${process.env.PATH}` };
  let result = sandbox.run(['learn', '7'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten learn: a check draft from issue #7, "repo: a test fails behind a proxy"\.\n1 TODO\(s\) for the reviewer:\n- why: the issue has no "Why it matters" section\n/);
  assert.match(result.stdout, /\n--- lessons\/incident-7\/lesson\.ts\n[^]*fix: 'The test sets NO_PROXY',[^]*\n--- lessons\/incident-7\/lesson\.test\.ts\n/);
  assert.match(result.stdout, /Nothing was written\. `yokoten learn 7 --write` adds these files for review\.\n$/);
  assert.ok(!existsSync(join(sandbox.repo, 'lessons')), 'a preview writes nothing');
  result = sandbox.run(['learn', '7', '--write'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote:\n- lessons\/incident-7\/lesson\.ts\n- lessons\/incident-7\/lesson\.test\.ts\nReview the draft/);
  assert.ok(!/--- lessons/.test(result.stdout), '--write lists the files, not their text');
  assert.match(readFileSync(join(sandbox.repo, 'lessons/incident-7/lesson.ts'), 'utf8'), /id: 'incident-7',/);
  result = sandbox.run(['learn', '7', '--write'], { extra });
  assert.match(result.stdout, /Kept, already there:\n- lessons\/incident-7\/lesson\.ts\n/);
  result = sandbox.run(['learn', '8'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten learn: gh can't read issue 8 \(no such issue\)/);
  result = sandbox.run(['learn'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /name an incident issue/);
});

// #147, the whole loop: an incident becomes a lesson in a copy of yokoten, a person writes the
// check, the lesson ships in the kit, and doctor in another project shows it as a note. A
// fake gh gives the issue; nothing reaches the network.
test('lessons: learn, write the check, ship, then doctor in a second repo shows the note', () => {
  const sandbox = makeSandbox();
  // The first repo: a copy of yokoten, where the kit lives.
  const yokoten = join(sandbox.home, 'yokoten');
  for (const part of ['bin', 'src', 'kit', 'package.json']) cpSync(join(dirname(CLI), '..', part), join(yokoten, part), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: yokoten });
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  const issue = { number: 9, title: 'repo: a .env file was committed', body: '## What happened\n\nA .env file reached main.\n\n## Why it matters\n\nA .env file can hold a secret.\n\n## Fix\n\nRemove it, and add it to .gitignore.\n', url: 'https://example.com/issues/9', labels: [{ name: 'incident' }] };
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(issue))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const cli = join(yokoten, 'bin', 'yokoten.ts');
  const runCopy = (args: string[], cwd: string, extra: Record<string, string> = {}) => spawnSync('node', [cli, ...args], { cwd, env: { ...sandbox.env, PATH: `${bin}:${process.env.PATH}`, ...extra }, encoding: 'utf8' });

  let result = runCopy(['learn', '9', '--write'], yokoten);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /The issue answers every field\./);
  // Not reviewed yet: shipping is refused.
  result = runCopy(['learn', '--ship', 'incident-9'], yokoten);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten learn --ship: 2 problem\(s\); nothing was moved:\n- lessons\/incident-9\/lesson\.ts still has 1 TODO\(reviewer\)/);
  // The reviewer writes the check and its positive control.
  const lessonFile = join(yokoten, 'lessons/incident-9/lesson.ts');
  writeFileSync(lessonFile, readFileSync(lessonFile, 'utf8')
    .replace('/** The shape', "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\n\n/** The shape")
    .replace(/ {2}\/\/ TODO\(reviewer\)[^\n]*\n {2}void root;\n {2}return \[\];/, "  return existsSync(join(root, '.env')) ? [{ ...lesson, what: '.env is in the repo' }] : [];"));
  const testFile = join(yokoten, 'lessons/incident-9/lesson.test.ts');
  writeFileSync(testFile, readFileSync(testFile, 'utf8')
    .replace(/ {2}\/\/ TODO\(reviewer\): replace with files that show the incident\.\n {2}const knownBad = makeRepo\(\{ 'TODO\(reviewer\)': '' \}\);/, "  const knownBad = makeRepo({ '.env': 'KEY=1' });")
    .replace(/ {2}\/\/ TODO\(reviewer\): replace with files where all is well\.\n/, ''));
  result = runCopy(['learn', '--ship', 'incident-9'], yokoten);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten learn --ship: incident-9 is in kit\/lessons\/incident-9\/, with a row in kit\/lessons\/README\.md \(from https:\/\/example\.com\/issues\/9, yokoten \d+\.\d+\.\d+\)\./);

  // The second repo: a project with the problem. Doctor shows the note, and it fails nothing.
  sandbox.write('.env', 'KEY=1\n');
  result = runCopy(['doctor'], sandbox.repo);
  assert.match(result.stdout, /\n {2}note {4}lesson incident-9: \.env is in the repo; Remove it, and add it to \.gitignore\n/);
  const report = JSON.parse(runCopy(['doctor', '--json'], sandbox.repo).stdout);
  assert.deepEqual(report.lessons.find((lesson: { id: string }) => lesson.id === 'incident-9'), { id: 'incident-9', mark: 'note' });
  assert.ok(report.notes.some((note: { id: string }) => note.id === 'incident-9') && !report.findings.some((f: { id: string }) => f.id === 'incident-9'), 'a note, never a finding');
  // Not now, with the reason.
  sandbox.write('yokoten.json', JSON.stringify({ notNow: { 'incident-9': 'a sample file, no secret in it' } }));
  result = runCopy(['doctor'], sandbox.repo);
  assert.match(result.stdout, /\n {2}not now lesson incident-9: a sample file, no secret in it\n/);
});

test('adopt: with no key, the rule-based draft and how to set the key; it changes no file (#6)', () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# rules\n');
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const before = sandbox.git('status', '--porcelain', '--ignored').stdout;
  const r = sandbox.run(['adopt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| Practice \| The project today \| Draft \| Why \|/);
  assert.match(r.stdout, /\| rules \| partial: no AGENTS\.md, but CLAUDE\.md \| lighter \|/);
  assert.match(r.stdout, /set MODEL_API_KEY \(or LLAMA_API_KEY\)/);
  assert.match(r.stdout, /You decide every row/);
  const json = sandbox.run(['adopt', '--json']);
  const rows = JSON.parse(json.stdout) as { key: string; decision: string }[];
  assert.equal(rows.find((row) => row.key === 'tests')?.decision, 'as-is');
  assert.match(json.stderr, /drafted by rules/);
  assert.equal(sandbox.git('status', '--porcelain', '--ignored').stdout, before, 'adopt writes nothing');
});

// #174: the pitch demo runs end to end, offline, in a temp folder it removes, and never
// touches this repo's kit.
test('demo: scripts/demo.ts walks the loop from an incident to a doctor note, and leaves nothing', () => {
  const temp = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const kitTable = join(dirname(CLI), '..', 'kit', 'lessons', 'README.md');
  const before = readFileSync(kitTable, 'utf8');
  const result = spawnSync('node', [join(dirname(CLI), '..', 'scripts', 'demo.ts')], { env: { PATH: process.env.PATH, TMPDIR: temp }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\n\$ yokoten learn https:\/\/github\.com\/octo-org\/project-a\/issues\/12\nyokoten learn: a check draft from issue #12, /);
  assert.match(result.stdout, /\nWrote:\n- lessons\/incident-12\/lesson\.ts\n/);
  assert.match(result.stdout, /\nyokoten learn --ship: 2 problem\(s\); nothing was moved:\n- lessons\/incident-12\/lesson\.ts still has 1 TODO\(reviewer\)/);
  assert.match(result.stdout, /\n\+ {2}what: 'a test calls a server on this machine and does not set NO_PROXY',\n/);
  assert.match(result.stdout, /\nyokoten learn --ship: incident-12 is in kit\/lessons\/incident-12\//);
  assert.match(result.stdout, /\n {2}note {4}lesson incident-12: test\/api\.test\.js: a test calls a server on this machine and does not set NO_PROXY; set NO_PROXY/);
  assert.match(result.stdout, /\nDone in \d+\.\ds: /);
  assert.deepEqual(readdirSync(temp), [], 'the demo folder is gone');
  assert.equal(readFileSync(kitTable, 'utf8'), before, 'the real kit is not touched');
  rmSync(temp, { recursive: true, force: true });
});
