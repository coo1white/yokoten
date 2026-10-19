// End to end: the CLI in throwaway git repos, the way a hook or CI runs it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closestWord, COMMANDS, editDistance, guardCommand, HELP_OPTIONS, refuseOnFailure } from '../src/run/cli.ts';
import { copyRuntime } from '../src/setup/files.ts';
import { guardDeadline } from '../src/run/hook.ts';
import { hasHook } from '../src/agents/hooks-file.ts';
import { checkLines } from '../src/setup/init.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'yokoten.ts');

// A project hook command as init writes it: a plain line when `path` is gone (#204), else node.
const MISSING_PROJECT = 'yokoten: the hook cannot run, because .yokoten/ is missing. Restore it from git, or run yokoten init again';
const guarded = (path: string, args: string) => `[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; node ${path} ${args}`;
// A tool-call guard fails closed (#260): no node is one line and exit 1; then a small heap,
// node's stderr held back, and any exit but 0 and 2 becomes 2 with one line.
const MISSING_NODE = 'yokoten: the guard cannot run, because node is not on PATH for this agent; run yokoten doctor in a terminal';
const REFUSE = 'case $code in 0|2) printf %s "${err%x}" >&2;; *) echo "yokoten\'s guard failed (exit $code), so the command is refused; run \\`yokoten doctor\\`" >&2; code=2;; esac; exit $code';
const onToolCall = (check: string, path: string, args: string) =>
  `${check}command -v node >/dev/null 2>&1 || { echo '${MISSING_NODE}' >&2; exit 1; }; { err=$( ( node --max-old-space-size=256 ${path} ${args} 2>&1 1>&3 3>&-; c=$?; printf x; exit $c ) 2>/dev/null ); code=$?; } 3>&1; ${REFUSE}`;
const guardedCall = (path: string, args: string) => onToolCall(`[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; `, path, args);
const at = '@';

const pick = (result: { status: number | null; stdout: string; stderr: string }) => [result.status, result.stdout, result.stderr];

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
  const run = (args: string[], { input, cwd = repo, extra = {}, timeout }: { input?: string; cwd?: string; extra?: Record<string, string>; timeout?: number } = {}) =>
    spawnSync('node', [CLI, ...args], { cwd, env: { ...env, ...extra }, input, encoding: 'utf8', timeout });
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

// The runtimes let a tool call through when the hook runs past their timeout, so a guard
// that reads too long is stopped and the call refused (#274).
test('hook: past the deadline the call is refused, in text and JSON (#274)', () => {
  const sandbox = makeSandbox();
  const input = JSON.stringify({ cwd: sandbox.repo, tool_input: { command: `npm run build -- ${'--flag value '.repeat(200)}` } });
  const late = { YOKOTEN_GUARD_DEADLINE_MS: '1' };
  let result = sandbox.run(['hook'], { input, extra: late });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^yokoten: the guard took longer than 1 ms to read this command\. .*Split the command into smaller ones\./);
  result = sandbox.run(['hook', '--json'], { input, extra: late });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.blocked, true);
  assert.equal(out.finding.id, 'unreadable-command');
  // The default deadline: a plain command passes, and the guard still blocks.
  const call = (command: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  assert.equal(call('ls').status, 0);
  assert.equal(call('git push --force origin main').status, 2);
  assert.equal(sandbox.run(['hook'], { input, extra: { YOKOTEN_GUARD_DEADLINE_MS: 'soon' } }).status, 0, 'a bad value keeps the default');
  // The setting can never turn the deadline off, nor set a timer Node can't hold.
  for (const [value, ms] of [['', 5000], ['0', 5000], ['-5', 5000], ['0x10', 5000], ['1e9', 5000], ['2.5', 5000], ['Infinity', 5000], ['250', 250], ['90000', 30_000], ['3000000000', 30_000]] as const) {
    assert.equal(guardDeadline(value), ms, `YOKOTEN_GUARD_DEADLINE_MS=${value}`);
  }
});

test('hook: a command the guard reads too slowly is refused within the deadline (#274)', () => {
  const sandbox = makeSandbox();
  // A large command, still being read when a 1 ms deadline passes, however fast the reader:
  // the busy worker is stopped and the hook exits at once, in little memory.
  const input = JSON.stringify({ cwd: sandbox.repo, tool_input: { command: `find . ${'-exec env '.repeat(30000)}` } });
  const start = Date.now();
  const result = spawnSync('node', ['--max-old-space-size=256', CLI, 'hook'], { cwd: sandbox.repo, env: { ...sandbox.env, YOKOTEN_GUARD_DEADLINE_MS: '1' }, input, encoding: 'utf8', timeout: 20000 });
  const took = Date.now() - start;
  assert.ok(took < 10000, `the hook took ${took} ms`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /took longer than 1 ms/);
});

// The Stop event is shaped as Claude Code's hook docs show it (code.claude.com/docs/en/hooks#stop).
test('hook: bad JSON in yokoten.json gives the defaults and one line, and check still fails (#218)', () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{ "layout": ');
  const call = (command: string) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  const line = /^yokoten hook: yokoten\.json was ignored, so the defaults apply; the core checks still run\. yokoten\.json: [^\n]+\n/;
  let result = call('git push --force');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, line);
  assert.match(result.stderr, /\nyokoten: [^\n]*force/);
  assert.ok(!result.stderr.includes(sandbox.repo), 'no absolute path');
  result = call('git status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, line);
  assert.equal(result.stderr.split('\n').filter(Boolean).length, 1, 'one line');
  // check and doctor still see a config problem.
  result = sandbox.run(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /yokoten\.json:/);
});

test('hook: a key with the wrong shape gets its default and one line; check names the key; an unknown key is a note (#228)', () => {
  const sandbox = makeSandbox();
  // Positive control: before #228, this made the hook crash on an edit (exit 1, guard open).
  sandbox.write('yokoten.json', '{ "leadOnly": "x" }');
  const call = (toolInput: Record<string, string>) => sandbox.run(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: toolInput }), extra: { YOKOTEN_ROLE: 'worker' } });
  const line = /^yokoten hook: yokoten\.json "leadOnly" was ignored, so its default applies; the core checks still run\. yokoten\.json: "leadOnly" must be a list of text, such as [^\n]+\n/;
  for (const toolInput of [{ file_path: 'AGENTS.md' }, { command: 'git push --force' }] as Record<string, string>[]) {
    const result = call(toolInput);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, line);
    assert.equal(result.stderr.match(/^yokoten hook:/gm)?.length, 1, 'one line');
  }
  let result = sandbox.run(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check: yokoten\.json: "leadOnly" must be a list of text/);
  // An unknown key is a note, and check passes.
  sandbox.write('yokoten.json', '{ "colour": "blue" }');
  result = sandbox.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten check: note: yokoten\.json: "colour" is not a key this version of yokoten knows/m);
  assert.equal(call({ command: 'git status' }).stderr, '', 'the hook says nothing');
  // Every wrong key in one run.
  sandbox.write('yokoten.json', '{ "leadOnly": "x", "tests": 5, "notNow": null }');
  result = sandbox.run(['check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check: yokoten\.json: 2 keys have the wrong shape:\n- "tests" must be [^\n]+\n- "leadOnly" must be /);
});

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
  // --stop takes a known agent only, and never with --commands-only.
  assert.equal(sandbox.run(['hook', '--stop', '--agent', 'cursor'], { input: '{}' }).status, 1);
  assert.equal(sandbox.run(['hook', '--stop', '--commands-only'], { input: '{}' }).status, 1);
});

// Each end-of-turn event as the runtime sends it (#211): Codex's Stop (rust-v0.163.0
// schema) and Gemini CLI's AfterAgent (v0.64.0). Both send the agent back on exit 2.
test('hook --stop --agent codex|gemini: the end-of-turn event sends the agent back once (#211)', () => {
  const sandbox = makeSandbox();
  const events: Record<string, (active: boolean) => object> = {
    codex: (active) => ({
      session_id: 'thr_123',
      transcript_path: null,
      cwd: sandbox.repo,
      hook_event_name: 'Stop',
      model: 'gpt-5',
      permission_mode: 'default',
      turn_id: 'turn_1',
      stop_hook_active: active,
      last_assistant_message: 'done',
    }),
    gemini: (active) => ({
      session_id: 's1',
      transcript_path: join(sandbox.home, 't.json'),
      cwd: sandbox.repo,
      hook_event_name: 'AfterAgent',
      timestamp: '2026-10-19T00:00:00.000Z',
      prompt: 'fix it',
      prompt_response: 'done',
      stop_hook_active: active,
    }),
  };
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  for (const [agent, event] of Object.entries(events)) {
    const stop = (active: boolean) => sandbox.run(['hook', '--stop', '--agent', agent], { input: JSON.stringify(event(active)) });
    assert.deepEqual(pick(stop(false)), [0, '', ''], `${agent}: clean`);
    sandbox.write('a.md', `mail me${at}gmail.com\n`);
    const result = stop(false);
    assert.equal(result.status, 2, `${agent}: sent back`);
    assert.match(result.stderr, /^yokoten: 1 problem\(s\) in the changed files\. Fix them before you end the turn:\n- a\.md:1: an email/);
    assert.equal(result.stdout, '', `${agent}: stdout stays empty`);
    assert.deepEqual(pick(stop(true)), [0, '', ''], `${agent}: already sent back once`);
    sandbox.write('a.md', 'fine\n');
  }
  // The hooks init writes run the same check, from the vendored copy.
  assert.equal(sandbox.run(['init']).status, 0);
  sandbox.write('a.md', `mail me${at}gmail.com\n`);
  const command = (file: string, event: string) => JSON.parse(readFileSync(join(sandbox.repo, file), 'utf8')).hooks[event][0].hooks[0].command as string;
  const shell = (text: string, input: object) =>
    spawnSync(text, { shell: '/bin/sh', cwd: sandbox.repo, env: { ...sandbox.env, GEMINI_PROJECT_DIR: sandbox.repo }, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(shell(command('.codex/hooks.json', 'Stop'), events.codex(false)).status, 2, 'the Codex Stop hook');
  assert.equal(shell(command('.gemini/settings.json', 'AfterAgent'), events.gemini(false)).status, 2, 'the Gemini AfterAgent hook');
  assert.equal(shell(command('.codex/hooks.json', 'Stop'), events.codex(true)).status, 0);
  // doctor's codex-hook step wants the stop check too.
  const codexFile = join(sandbox.repo, '.codex', 'hooks.json');
  const hooks = JSON.parse(readFileSync(codexFile, 'utf8'));
  delete hooks.hooks.Stop;
  writeFileSync(codexFile, JSON.stringify(hooks));
  assert.match(sandbox.run(['doctor']).stdout, /note +codex-hook: no stop check in \.codex\/hooks\.json/);
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
  let result = call('Bash', 'git push --tags');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal(call('Bash', 'git status').status, 0);
  const patch = (header: string) => `*** Begin Patch\n${header}\n@@\n-old\n+new\n*** End Patch\n`;
  const worker = { YOKOTEN_ROLE: 'worker' };
  result = call('apply_patch', patch('*** Update File: AGENTS.md'), worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal(call('apply_patch', patch('*** Update File: src/a.ts\n*** Move to: .codex/hooks.json'), worker).status, 2, 'a move into a lead-only path');
  assert.equal(call('apply_patch', patch(`*** Add File: ${join(sandbox.repo, '.github', 'x.yml')}`), worker).status, 2, 'an absolute path');
  assert.equal(call('apply_patch', patch('*** Update File: src/a.ts'), worker).status, 0);
  assert.equal(call('apply_patch', patch('*** Update File: AGENTS.md')).status, 0, 'the lead may');
  // A worker subagent's call names its role (Codex rust-v0.163.0, #210); no env needed.
  assert.equal(call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a1', agent_type: 'worker' }).status, 2, 'a worker subagent');
  assert.equal(call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a2', agent_type: 'explorer' }).status, 0, 'an explorer is not a worker');
  // A shell-run apply_patch is a Bash call, with no second hook (#209): its files count too.
  const heredoc = (header: string, before = '') => `${before}apply_patch <<'EOF'\n${patch(header)}EOF\n`;
  result = call('Bash', heredoc('*** Update File: AGENTS.md'), worker);
  assert.equal(result.status, 2, 'a heredoc to apply_patch');
  assert.match(result.stderr, /AGENTS\.md/);
  assert.match(call('Bash', `${heredoc('*** Update File: src/a.ts')}git push --tags\n`, worker).stderr, /owner decides when to release/, 'the command is still checked');
  assert.equal(call('Bash', `${heredoc('*** Update File: src/a.ts')}git push --tags\n`, worker).status, 2);
  assert.equal(call('Bash', `applypatch '${patch('*** Delete File: .github/x.yml')}'`, worker).status, 2, 'the envelope as an argument');
  assert.equal(call('Bash', heredoc('*** Add File: workflows/x.yml', 'cd .github && '), worker).status, 2, 'after a cd');
  assert.equal(call('Bash', heredoc('*** Add File: workflows/x.yml', 'cd .github; pwd\n'), worker).status, 2, 'a cd further back');
  assert.equal(call('Bash', heredoc('*** Add File: workflows/x.yml', 'pushd ".github" >/dev/null; ls; '), worker).status, 2, 'a quoted pushd');
  assert.equal(call('Bash', heredoc('*** Update File: a.ts', 'cd src; '), worker).status, 0, 'a cd into a normal dir');
  // Anything may stand in front of apply_patch: any mention counts every header (PR #221).
  const lead = patch('*** Update File: AGENTS.md');
  const ways = {
    'command apply_patch': heredoc('*** Update File: AGENTS.md', 'command '),
    'timeout 30 apply_patch': heredoc('*** Update File: AGENTS.md', 'timeout 30 '),
    'env -C': heredoc('*** Add File: workflows/x.yml', 'env -C .github '),
    'FOO=1 apply_patch': heredoc('*** Update File: AGENTS.md', 'FOO=1 '),
    '\\apply_patch': heredoc('*** Update File: AGENTS.md', '\\'),
    'a variable': `p=apply_patch; $p <<'EOF'\n${lead}EOF\n`,
    'a pipe': `printf '%s\\n' '${lead}' | apply_patch`,
    'written newlines': `printf '*** Begin Patch\\n*** Update File: AGENTS.md\\n*** End Patch\\n' | apply_patch`,
    'an early end marker': heredoc('*** Update File: src/a.ts\n@@\n+*** End Patch\n*** Update File: AGENTS.md'),
  };
  for (const [way, command] of Object.entries(ways)) assert.equal(call('Bash', command, worker).status, 2, way);
  assert.equal(call('Bash', heredoc('*** Update File: src/a.ts', 'command '), worker).status, 0, 'a normal file');
  // A dir only the shell knows: each path counts from every folder above the cwd too.
  sandbox.write('src/a.ts', '');
  const deeper = { cwd: join(sandbox.repo, 'src') };
  assert.equal(call('Bash', heredoc('*** Update File: AGENTS.md', 'cd "$(git rev-parse --show-toplevel)" && '), worker, deeper).status, 2, 'cd to an unknown dir');
  assert.equal(call('Bash', heredoc('*** Update File: AGENTS.md', 'cd ~/x; cd -; '), worker, deeper).status, 2, 'cd ~ and cd -');
  assert.equal(call('Bash', heredoc('*** Update File: AGENTS.md', 'cd "$HOME"; '), {}, deeper).status, 0, 'the lead may');
  assert.equal(call('Bash', heredoc('*** Update File: src/a.ts\n*** Move to: CLAUDE.md'), worker).status, 2, 'a move');
  assert.equal(call('Bash', heredoc('*** Update File: src/a.ts'), worker).status, 0);
  assert.equal(call('Bash', heredoc('*** Update File: AGENTS.md')).status, 0, 'the lead may');
  assert.equal(call('Bash', `cat > notes.md <<'EOF'\n${patch('*** Update File: AGENTS.md')}EOF\n`, worker).status, 0, 'an envelope as data');
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
  assert.equal(command, guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts', 'hook --agent gemini'));
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

test('check --staged: a submodule and a path with a colon pass, read by blob id (#244)', () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // A submodule add, as git records it: a gitlink at mode 160000.
  sandbox.git('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  sandbox.write('2:notes.md', 'notes\n');
  sandbox.git('add', '2:notes.md');
  let result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  result = sandbox.run(['check', '--staged', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).check, 'staged');
  // A pointer bump.
  sandbox.git('commit', '-qm', 'sub');
  sandbox.git('commit', '-q', '--allow-empty', '-m', 'next');
  const next = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('update-index', '--cacheinfo', `160000,${next},sub`);
  result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
});

test('check --staged: a symlink turned into a file is checked for privacy (#244)', () => {
  const sandbox = makeSandbox();
  symlinkSync('a.md', join(sandbox.repo, 'link'));
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  rmSync(join(sandbox.repo, 'link'));
  sandbox.write('link', `write to me${at}gmail.com\n`);
  sandbox.git('add', 'link');
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /link:1: an email/);
});

test('check and the stop hook read a symlink as its link text, never its target (#244)', () => {
  const sandbox = makeSandbox();
  writeFileSync(join(dirname(sandbox.repo), 'outside.txt'), `write to me${at}gmail.com\n`);
  symlinkSync('../outside.txt', join(sandbox.repo, 'out'));
  symlinkSync('/dev/zero', join(sandbox.repo, 'zero'));
  sandbox.git('add', '.');
  const stop = () => sandbox.run(['hook', '--stop'], { input: JSON.stringify({ cwd: sandbox.repo, stop_hook_active: false }), timeout: 10000 });
  let result = stop();
  assert.deepEqual([result.status, result.stderr], [0, ''], 'staged, before the commit');
  sandbox.git('commit', '-qm', 'links');
  result = sandbox.run(['check'], { timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  // A link whose text is itself an email is still caught.
  symlinkSync(`me${at}gmail.com`, join(sandbox.repo, 'mail'));
  sandbox.git('add', 'mail');
  assert.match(stop().stderr, /mail:1: an email/);
  assert.match(sandbox.run(['check'], { timeout: 10000 }).stderr, /mail:1: an email/);
});

test('check --staged: binary is decided from the bytes, not .gitattributes (#244)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.gitattributes', 'yarn.lock -diff\n*.pbxproj binary\n');
  sandbox.write('yarn.lock', 'left-pad@1.0.0:\n  version "1.0.0"\n');
  sandbox.write('App.pbxproj', '// !$*UTF8*$!\n{\n}\n');
  sandbox.git('add', '.');
  let result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 0, result.stderr);
  // A NUL in the first 8000 bytes is binary; one after them is not, as git decides.
  writeFileSync(join(sandbox.repo, 'tool'), Buffer.concat([Buffer.from('#!'), Buffer.alloc(1), Buffer.from('x\n')]));
  writeFileSync(join(sandbox.repo, 'late.txt'), Buffer.concat([Buffer.alloc(8000, 'a'), Buffer.alloc(1)]));
  sandbox.git('add', '.');
  result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool: a binary file/);
  assert.ok(!result.stderr.includes('late.txt'), result.stderr);
});

// A merge leaves the index and MERGE_HEAD as the pre-merge-commit hook sees them (#246).
function mergeSandbox() {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', 'rules\n');
  sandbox.write('test/a.test.ts', 'old\n');
  sandbox.write('src/a.ts', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  sandbox.git('checkout', '-qb', 'work');
  sandbox.write('src/a.ts', 'b\n');
  sandbox.git('commit', '-qam', 'work');
  sandbox.git('checkout', '-q', 'main');
  return sandbox;
}

test('check --staged: in a merge, the role checks see only what the merge itself changed (#246)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main changed a lead-only file and a test; a worker brings main into its branch.
  let sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.write('test/a.test.ts', 'new\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  let result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main changed AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: { ...worker, YOKOTEN_FIX_TASK: '1' } });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main changed a test, in a fix task');
  // An edit made during the merge is the worker's own.
  sandbox.write('AGENTS.md', 'my rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);

  // A conflict in AGENTS.md resolved by a new edit is refused.
  sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'lead rules\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  sandbox.write('AGENTS.md', 'worker rules\n');
  sandbox.git('commit', '-qam', 'worker edit');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 1, 'a conflict');
  sandbox.write('AGENTS.md', 'both rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);

  // Outside a merge, a worker's commit of AGENTS.md is refused as before.
  sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'my rules\n');
  sandbox.git('add', 'AGENTS.md');
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: in a merge, a merged-in file is still checked for privacy (#246)', () => {
  const sandbox = mergeSandbox();
  sandbox.write('notes.md', `write to me${at}gmail.com\n`);
  sandbox.git('add', 'notes.md');
  sandbox.git('commit', '-qm', 'notes');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  const result = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md:1: an email/);
});

test('check --staged: a malformed MERGE_HEAD is ignored, and the full role check runs (#246)', () => {
  // A real merge of main, which changed AGENTS.md, then a line git would read as an option.
  const sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'new rules\n');
  sandbox.git('commit', '-qam', 'lead');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  const mergeHead = join(sandbox.repo, sandbox.git('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim());
  appendFileSync(mergeHead, '--relative=zzz\n');
  const result = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: a MERGE_HEAD that descends from HEAD exempts nothing (#246)', () => {
  // A fast-forward is a one-parent commit, not a merge: a stash of a lead-only edit named
  // in MERGE_HEAD must not let that edit through.
  const sandbox = mergeSandbox();
  sandbox.write('AGENTS.md', 'my rules\n');
  assert.equal(sandbox.git('stash', '-q').status, 0);
  const stash = sandbox.git('rev-parse', 'stash@{0}').stdout.trim();
  writeFileSync(join(sandbox.repo, sandbox.git('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim()), `${stash}\n`);
  assert.equal(sandbox.git('checkout', 'stash@{0}', '--', 'AGENTS.md').status, 0);
  const result = sandbox.run(['check', '--staged'], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: a move is role-checked at its old path too (#259)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  const moved = (from: string, to: string, extra: Record<string, string>) => {
    const sandbox = mergeSandbox();
    assert.equal(sandbox.git('mv', from, to).status, 0);
    assert.match(sandbox.git('diff', '--cached', '--name-status').stdout, /^R/, 'git sees a move');
    return sandbox.run(['check', '--staged'], { extra });
  };
  let result = moved('AGENTS.md', 'notes.md', worker);
  assert.equal(result.status, 1, 'a worker moves a lead-only file away');
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  result = moved('src/a.ts', 'src/b.ts', worker);
  assert.deepEqual([result.status, result.stderr], [0, ''], 'a worker moves its own file');
  result = moved('AGENTS.md', 'notes.md', {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead moves a lead-only file');
  result = moved('test/a.test.ts', 'test/b.test.ts', { ...worker, YOKOTEN_FIX_TASK: '1' });
  assert.equal(result.status, 1, 'a fix task moves a test');
  assert.match(result.stderr, /test\/a\.test\.ts is a test file/);
});

test('check --staged: in a merge, a move is the worker\'s only if the merge made it (#259)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main moved AGENTS.md; a worker brings main in.
  let sandbox = mergeSandbox();
  assert.equal(sandbox.git('mv', 'AGENTS.md', 'RULES.md').status, 0);
  sandbox.git('commit', '-qm', 'lead move');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  let result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.deepEqual([result.status, result.stderr], [0, ''], 'main moved AGENTS.md');

  // The worker moves AGENTS.md away during a merge of main.
  sandbox = mergeSandbox();
  sandbox.write('notes.md', 'notes\n');
  sandbox.git('add', 'notes.md');
  sandbox.git('commit', '-qm', 'notes');
  sandbox.git('checkout', '-q', 'work');
  assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
  assert.equal(sandbox.git('mv', 'AGENTS.md', 'RULES.md').status, 0);
  result = sandbox.run(['check', '--staged'], { extra: worker });
  assert.equal(result.status, 1, 'the merge made the move');
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
});

test('check --staged: in a merge, removing a lead-only file only the other side has is the worker\'s (#259)', () => {
  const worker = { YOKOTEN_ROLE: 'worker' };
  // Main moves .github/a.yml to .github/b.yml; a worker merges main in, then runs `then`.
  const merged = (then: string[][], extra: Record<string, string>) => {
    const sandbox = makeSandbox();
    sandbox.write('.github/a.yml', 'on: push\n');
    sandbox.write('src/a.ts', 'a\n');
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'start');
    sandbox.git('checkout', '-qb', 'work');
    sandbox.write('src/a.ts', 'b\n');
    sandbox.git('commit', '-qam', 'work');
    sandbox.git('checkout', '-q', 'main');
    assert.equal(sandbox.git('mv', '.github/a.yml', '.github/b.yml').status, 0);
    sandbox.git('commit', '-qm', 'lead move');
    sandbox.git('checkout', '-q', 'work');
    assert.equal(sandbox.git('merge', '--no-commit', '--no-ff', 'main').status, 0);
    for (const args of then) assert.equal(sandbox.git(...args).status, 0, args.join(' '));
    return sandbox.run(['check', '--staged'], { extra });
  };
  let result = merged([['mv', '.github/b.yml', 'c.yml']], worker);
  assert.equal(result.status, 1, 'a worker moves the merged-in file away');
  assert.match(result.stderr, /\.github\/b\.yml is lead-only/);
  result = merged([['rm', '-qf', '.github/b.yml']], worker);
  assert.equal(result.status, 1, 'a worker removes the merged-in file');
  assert.match(result.stderr, /\.github\/b\.yml is lead-only/);
  result = merged([['mv', '.github/b.yml', 'c.yml']], {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead moves it');
  result = merged([['rm', '-qf', '.github/b.yml']], {});
  assert.deepEqual([result.status, result.stderr], [0, ''], 'the lead removes it');
  result = merged([], worker);
  assert.deepEqual([result.status, result.stderr], [0, ''], 'a clean merge of the move');
});

test('check --staged: a staged entry git can\'t read fails, not passes as empty (#244)', () => {
  const sandbox = makeSandbox();
  sandbox.git('update-index', '--add', '--info-only', '--cacheinfo', `100644,${'1'.repeat(40)},ghost.md`);
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ghost\.md: git can't read the staged copy\. .+ Run `git add ghost\.md` again/);
});

test('check --staged: a text file with a NUL after 8000 bytes is scanned for privacy (#244)', () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.repo, 'late.txt'), Buffer.concat([Buffer.from(`write to me${at}gmail.com\n`), Buffer.alloc(9000, 'a'), Buffer.alloc(1)]));
  sandbox.git('add', '.');
  const result = sandbox.run(['check', '--staged']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /late\.txt:1: an email/);
  assert.ok(!result.stderr.includes('binary'), result.stderr);
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

test('doctor: shows check\'s notes, worded as check words them, and they never change the exit code (#228)', () => {
  const sandbox = makeSandbox();
  const before = sandbox.run(['doctor']);
  assert.doesNotMatch(before.stdout, /note +yokoten\.json|is behind en\.md/);
  // An unknown yokoten.json key.
  sandbox.write('yokoten.json', '{ "colour": "blue" }');
  const unknownKey = /^ {2}note +yokoten\.json: "colour" is not a key this version of yokoten knows/m;
  assert.match(sandbox.run(['check']).stdout, /^yokoten check: note: yokoten\.json: "colour" is not a key this version of yokoten knows/m);
  let result = sandbox.run(['doctor']);
  assert.match(result.stdout, unknownKey);
  assert.equal(result.status, before.status, 'a note never changes the exit code');
  result = sandbox.run(['doctor', '--json']);
  assert.ok(JSON.parse(result.stdout).notes.some((f: { file?: string; what: string }) => f.file === 'yokoten.json' && /"colour"/.test(f.what)));
  assert.doesNotMatch(sandbox.run(['doctor', '--session']).stdout, /colour/, 'a session stays short');
  // A translation behind its English source.
  sandbox.write('en.md', '# Guide\n\nStep one.\n');
  sandbox.write('zh.md', '<!-- source: en.md -->\n# 指南\n\n第一步。\n');
  sandbox.git('add', 'en.md', 'zh.md');
  sandbox.git('commit', '-q', '-m', 'docs: add the guide');
  sandbox.write('en.md', '# Guide\n\nStep one.\nStep two.\n');
  sandbox.git('commit', '-q', '-am', 'docs: add step two');
  result = sandbox.run(['doctor']);
  assert.match(result.stdout, /^ {2}note +zh\.md:1: is behind en\.md by 1 commit/m);
  assert.match(result.stdout, unknownKey);
  assert.equal(result.status, before.status);
  assert.ok(JSON.parse(sandbox.run(['doctor', '--json']).stdout).notes.some((f: { id: string }) => f.id === 'translation-behind'));
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

test('check --history: a shallow clone fails with one finding, never "every commit" (#266)', () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `token ${token}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  // A full clone finds the secret a later commit deleted.
  const full = join(sandbox.home, 'full');
  const shallow = join(sandbox.home, 'shallow');
  spawnSync('git', ['clone', '-q', `file://${sandbox.repo}`, full], { env: sandbox.env });
  spawnSync('git', ['clone', '-q', '--depth', '1', `file://${sandbox.repo}`, shallow], { env: sandbox.env });
  let result = sandbox.run(['check', '--history'], { cwd: full });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md @ blob \w+:1: a secret \(GitHub token\)/);
  // The shallow clone (actions/checkout's default) is not scanned, and says why.
  result = sandbox.run(['check', '--history'], { cwd: shallow });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!/every commit/.test(result.stdout + result.stderr), result.stdout);
  assert.match(result.stderr, /1 problem\(s\)\n- this clone is shallow, so the history check can't see old commits\. .+\. Use `fetch-depth: 0` in actions\/checkout, or run `git fetch --unshallow`/);
  assert.ok(!result.stderr.includes('notes.md'), 'nothing was scanned');
  result = sandbox.run(['check', '--history', '--json'], { cwd: shallow });
  assert.equal(result.status, 1);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.findings.map((f: { id: string }) => f.id), ['shallow-history']);
  assert.deepEqual(out.notes, []);
  // In GitHub Actions: an error annotation and a row in the job summary.
  const summary = join(sandbox.home, 'summary.md');
  result = sandbox.run(['check', '--history'], { cwd: shallow, extra: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error title=yokoten shallow-history::.*this clone is shallow/m);
  assert.match(readFileSync(summary, 'utf8'), /1 problem\n[^]*shallow-history[^]*this clone is shallow/);
});

test('check --history: a commit hidden by git replace is still scanned; a grafts file fails with one finding (#284)', () => {
  const sandbox = makeSandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  sandbox.write('notes.md', `token ${token}\n`);
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'add notes');
  const first = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('rm', '-q', 'notes.md');
  sandbox.git('commit', '-qm', 'remove notes');
  // Swap the first commit for an empty root commit: git log and rev-list now skip the token.
  const emptyTree = sandbox.git('hash-object', '-w', '-t', 'tree', '/dev/null').stdout.trim();
  const emptyRoot = sandbox.git('commit-tree', emptyTree, '-m', 'add notes').stdout.trim();
  assert.equal(sandbox.git('replace', first, emptyRoot).status, 0);
  assert.equal(sandbox.git('log', '--all', '--format=%H', '--', 'notes.md').stdout.trim(), '', 'git itself no longer sees the token');
  let result = sandbox.run(['check', '--history']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /notes\.md @ blob \w+:1: a secret \(GitHub token\)/);
  assert.ok(!result.stderr.includes(token), 'the secret is never printed');

  // A grafts file can hide commits too: nothing is scanned, and one finding says why.
  const second = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.git('replace', '-d', first);
  sandbox.write('.git/info/grafts', `${second}\n`);
  result = sandbox.run(['check', '--history']);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(!/every commit on every branch/.test(result.stdout + result.stderr), result.stdout);
  assert.match(result.stderr, /1 problem\(s\)\n- this repo has a grafts file, so the history check can't see every commit\. .+\. Run `git replace --convert-graft-file`/);
  assert.ok(!result.stderr.includes('notes.md'), 'nothing was scanned');
  result = sandbox.run(['check', '--history', '--json']);
  assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['shallow-history']);
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
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: guarded('"$CLAUDE_PROJECT_DIR/.yokoten/bin/yokoten.ts"', 'hook --stop') }] }], 'the stop check, once (#92)');
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  assert.match(result.stdout, /same the Codex tool-call hook/);
  assert.match(result.stdout, /same the Gemini CLI tool-call hook/);
  const codex = JSON.parse(readFileSync(join(sandbox.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.equal(codex.hooks.PreToolUse.length, 2);
  assert.deepEqual(codex.hooks.PreToolUse[1], {
    hooks: [{ type: 'command', command: guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts"', 'hook --agent codex') }],
    matcher: 'Bash|apply_patch',
  });
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.deepEqual(gemini.hooks.BeforeTool[1], {
    hooks: [{ type: 'command', command: guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts', 'hook --agent gemini'), name: 'yokoten' }],
    matcher: 'run_shell_command|write_file|replace',
  });
  // The stop checks (#211): Codex's Stop and Gemini's AfterAgent take no matcher, once each.
  assert.match(result.stdout, /same the Codex stop check/);
  assert.match(result.stdout, /same the Gemini CLI stop check/);
  assert.deepEqual(codex.hooks.Stop, [{ hooks: [{ type: 'command', command: guarded('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts"', 'hook --stop --agent codex') }] }]);
  assert.deepEqual(gemini.hooks.AfterAgent, [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts', 'hook --stop --agent gemini'), name: 'yokoten-stop' }] }]);
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
  assert.match(sandbox.run(['doctor', '--session']).stdout, /^yokoten: stage 1 of 5, safety net\. Next: no workflow runs a test command/);
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

test('init: a CLAUDE.md that already imports AGENTS.md is left as it is (#206)', () => {
  for (const text of [`# rules\n${at}AGENTS.md\n`, `# rules\nRead ${at}./AGENTS.md first.\n`, `# rules\r\n${at}AGENTS.md\r\n`, `# rules\n${at}AGENTS.md`]) {
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
  for (const text of [`# rules\n${at}../AGENTS.md\n`, `# rules\nRead ${at}../AGENTS.md first.\n`]) {
    const sandbox = makeSandbox();
    sandbox.write('.claude/CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, '.claude', 'CLAUDE.md'), 'utf8'), text);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: an import of another file that starts with AGENTS.md does not count; init adds the real import (#206)', () => {
  const cases = [
    { file: 'CLAUDE.md', text: `# rules\n${at}AGENTS.md.bak\n`, line: `${at}AGENTS.md` },
    { file: 'CLAUDE.md', text: `# rules\nOld: ${at}./AGENTS.md.old\n`, line: `${at}AGENTS.md` },
    { file: '.claude/CLAUDE.md', text: `# rules\n${at}../AGENTS.md.bak\n`, line: `${at}../AGENTS.md` },
  ];
  for (const { file, text, line } of cases) {
    const sandbox = makeSandbox();
    sandbox.write(file, text);
    sandbox.write('AGENTS.md', '# shared rules\n');
    assert.notEqual(stepMark(sandbox, 'rules'), 'done', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`updated ${file}: it now reads AGENTS.md`), result.stdout);
    const after = readFileSync(join(sandbox.repo, file), 'utf8');
    assert.ok(after.startsWith(text), 'the old line stays');
    assert.ok(after.endsWith(`-->\n${line}\n`), after);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: a Markdown link to AGENTS.md is not an import; init adds the import and keeps the link (#206)', () => {
  // Claude Code loads only `@path` imports; a link is text, so the session would not read AGENTS.md.
  const cases = [
    { file: 'CLAUDE.md', text: '# rules\nSee [the rules](AGENTS.md).\n', line: `${at}AGENTS.md` },
    { file: 'CLAUDE.md', text: '# rules\nSee [the rules](./AGENTS.md).\n', line: `${at}AGENTS.md` },
    { file: '.claude/CLAUDE.md', text: '# rules\nSee [the rules](../AGENTS.md).\n', line: `${at}../AGENTS.md` },
  ];
  for (const { file, text, line } of cases) {
    const sandbox = makeSandbox();
    sandbox.write(file, text);
    sandbox.write('AGENTS.md', '# shared rules\n');
    assert.notEqual(stepMark(sandbox, 'rules'), 'done', text);
    assert.match(sandbox.run(['doctor']).stdout, /rules[^\n]*does not import AGENTS\.md/, text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, file), 'utf8');
    assert.ok(after.startsWith(text), 'the link stays');
    assert.ok(after.endsWith(`-->\n${line}\n`), after);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: an import inside a code span or fenced block is not an import; init adds the real one (#206)', () => {
  // Claude Code skips Markdown code spans and fenced code blocks when it reads imports.
  const fence = '```';
  for (const text of [
    `# rules\nWrite \`${at}AGENTS.md\` to import it.\n`,
    `# rules\nWrite \`\`${at}AGENTS.md\`\` to import it.\n`,
    `# rules\n${fence}md\n${at}AGENTS.md\n${fence}\n`,
    `# rules\n~~~\n${at}AGENTS.md\n~~~\n`,
    `# rules\n  ${fence}\n${at}AGENTS.md\n  ${fence}\n`,
  ]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    sandbox.write('AGENTS.md', '# shared rules\n');
    assert.notEqual(stepMark(sandbox, 'rules'), 'done', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
    assert.ok(after.startsWith(text.replace(/\n$/, '')), 'the example stays');
    assert.ok(after.endsWith(`-->\n${at}AGENTS.md\n`), after);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test('init: a real import next to a fenced or quoted example is left as it is (#206)', () => {
  const fence = '```';
  for (const text of [
    `# rules\n${at}AGENTS.md\n\nExample:\n${fence}\n${at}AGENTS.md\n${fence}\n`,
    `# rules\nExample: \`${at}AGENTS.md\`.\n${at}AGENTS.md\n`,
    `# rules\n${fence}\n${at}other.md\n${fence}\n${at}AGENTS.md\n`,
  ]) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /CLAUDE\.md/, text);
    assert.equal(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), text);
    assert.equal(stepMark(sandbox, 'rules'), 'done', text);
  }
});

test("init: a CLAUDE.md with mixed line endings gets the file's main ending and one blank line (#206)", () => {
  const cases = [
    { text: '# rules\r\nOne.\r\nTwo.\n', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\r\nOne.\r\nTwo.', want: '# rules\r\nOne.\r\nTwo.\r\n\r\n<!--' },
    { text: '# rules\nOne.\nTwo.\r\n', want: '# rules\nOne.\nTwo.\n\n<!--' },
    { text: '# rules\nOne.\n\n\n', want: '# rules\nOne.\n\n<!--' },
  ];
  for (const { text, want } of cases) {
    const sandbox = makeSandbox();
    sandbox.write('CLAUDE.md', text);
    const result = sandbox.run(['init']);
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8');
    const newline = want.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(after.slice(0, want.length), want, JSON.stringify(after));
    assert.ok(after.endsWith(`-->${newline}${at}AGENTS.md${newline}`), JSON.stringify(after));
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
  assert.match(result.stdout, /wrote \.husky\/pre-merge-commit: the commit check \(kept core\.hooksPath \(husky\)/, 'a merge commit is checked too (#239)');
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-merge-commit'), 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\n`);
  assert.ok(statSync(join(sandbox.repo, '.husky/pre-merge-commit')).mode & 0o100, 'executable');
  assert.doesNotMatch(result.stdout, /set git core\.hooksPath/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.husky', 'the project\'s hooks folder stays');
  assert.ok(!existsSync(join(sandbox.repo, '.githooks')), 'no second hooks folder that git never runs');
  const hook = readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8');
  assert.equal(hook, `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\ntouch own-hook-ran\n`);
  assert.match(hook, /\n\[ -f "\.yokoten\/bin\/yokoten\.ts" \] 2>\/dev\/null \|\| \{ echo [^\n]* >&2; exit 1; \}; node "\.yokoten\/bin\/yokoten\.ts" check --staged \|\| exit 1\n/);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  // Again: the hook already runs yokoten.
  result = sandbox.run(['init']);
  assert.match(result.stdout, /same \.husky\/pre-commit/);
  assert.match(result.stdout, /same \.husky\/pre-merge-commit/);
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), hook);
  // A real commit runs both: the project's hook and the yokoten check.
  sandbox.git('add', '.');
  const commit = sandbox.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  assert.ok(existsSync(join(sandbox.repo, 'own-hook-ran')), 'the project\'s own hook still runs');
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0);
  sandbox.git('reset', '-q', 'leak.md');
  // Without the runtime, one plain line and no commit, never a stack trace (#204).
  rmSync(join(sandbox.repo, '.yokoten'), { recursive: true });
  sandbox.write('b.md', 'fine\n');
  sandbox.git('add', 'b.md');
  assert.deepEqual(pick(sandbox.git('commit', '-qm', 'b')), [1, '', 'yokoten: the commit check cannot run, because .yokoten/bin/yokoten.ts is missing. Restore it from git, or run yokoten init again\n']);
});

test('init: husky not yet installed in this clone; init leaves core.hooksPath unset and says to run npm install (#206)', () => {
  const sandbox = makeSandbox();
  sandbox.write('.husky/pre-commit', 'npm test\n');
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /added the check to \.husky\/pre-commit/);
  assert.match(result.stdout, /run `npm install`/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '');
  assert.match(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), /^# yokoten: [^\n]*\n\[ -f [^\n]*; node [^\n]*\nnpm test\n$/);
  // A hook that init changed before the runtime guard (#204) already runs the check.
  const before = '# yokoten: the commit check\nnode ".yokoten/bin/yokoten.ts" check --staged || exit 1\nnpm test\n';
  sandbox.write('.husky/pre-commit', before);
  assert.match(sandbox.run(['init']).stdout, /^same \.husky\/pre-commit/m);
  assert.equal(readFileSync(join(sandbox.repo, '.husky/pre-commit'), 'utf8'), before);
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done', 'git runs no hook yet');
  assert.match(sandbox.run(['doctor']).stdout, /run `npm install` so husky sets core\.hooksPath/);
  sandbox.git('config', 'core.hooksPath', '.husky/_');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done', "husky 9's folder runs .husky/pre-commit");
});

// git runs pre-merge-commit, not pre-commit, for a merge it commits itself (#239).
test('init: a merge commit runs the commit check too (#239)', () => {
  const sandbox = makeSandbox();
  let result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote \.githooks\/pre-merge-commit/);
  const mergeHook = join(sandbox.repo, '.githooks', 'pre-merge-commit');
  const hook = readFileSync(mergeHook, 'utf8');
  assert.equal(hook, readFileSync(join(sandbox.repo, '.githooks', 'pre-commit'), 'utf8'), 'the same check as pre-commit');
  assert.ok(statSync(mergeHook).mode & 0o100, 'executable');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  // Again: nothing changes.
  result = sandbox.run(['init']);
  assert.match(result.stdout, /kept \.githooks\/pre-merge-commit/);
  assert.equal(readFileSync(mergeHook, 'utf8'), hook);
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'adopt yokoten').status, 0);
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('topic.md', 'fine\n');
  sandbox.git('add', 'topic.md');
  assert.equal(sandbox.git('commit', '-qm', 'topic').status, 0);
  sandbox.git('checkout', '-q', 'main');
  const merge = (zone: string) => spawnSync('git', ['merge', '--no-ff', '-q', '-m', 'merge topic', 'topic'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: zone }, encoding: 'utf8' });
  // A merge with the author's time zone is refused, and the zone is never printed.
  const zoned = merge('Asia/Tokyo');
  assert.notEqual(zoned.status, 0, 'the merge commit is checked');
  assert.match(zoned.stderr, /carries your time zone/);
  assert.doesNotMatch(zoned.stderr, /\+0900/);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '0');
  sandbox.git('merge', '--abort');
  const plain = merge('UTC');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '1');
  // Doctor names a missing pre-merge-commit, and init writes it back.
  rmSync(mergeHook);
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done');
  const doctor = sandbox.run(['doctor']).stdout;
  // Ordinary commits are still checked; only merge commits are not.
  assert.match(doctor, /merge commits are not checked: there is no \.githooks\/pre-merge-commit/);
  assert.doesNotMatch(doctor, /(?<!merge )commits are not checked/);
  assert.doesNotMatch(doctor, /\.githooks\/pre-commit/);
  assert.match(doctor, /`yokoten init` sets up \.githooks\/pre-merge-commit/);
  // A pre-merge-commit of the project's own keeps its lines and gets the check.
  writeFileSync(mergeHook, '#!/bin/sh\necho own\n');
  result = sandbox.run(['init']);
  assert.match(result.stdout, /added the check to \.githooks\/pre-merge-commit/);
  assert.equal(readFileSync(mergeHook, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\necho own\n`);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
});

test('init: a core.hooksPath outside the repo is kept, and the advice is the line init would write (#204)', () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'core.hooksPath', join(sandbox.home, 'hooks'));
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(result.stdout.includes(`Add this line to its pre-commit and pre-merge-commit: ${checkLine}\n`), result.stdout);
});

test("init: another core.hooksPath is kept, and its pre-commit is made with the check (#206)", () => {
  const sandbox = makeSandbox();
  sandbox.write('tools/hooks/commit-msg', '#!/bin/sh\n');
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  const doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): commits are not checked: there is no tools\/hooks\/pre-commit; there is no tools\/hooks\/pre-merge-commit/);
  // The advice shows the line init writes, runtime guard included (#204). A new file needs
  // a `#!` line and the execute bit, or git skips it (#239).
  const [, checkLine] = checkLines('.yokoten/bin/yokoten.ts');
  assert.ok(doctor.includes(`or do it yourself: make tools/hooks/pre-commit and tools/hooks/pre-merge-commit with \`#!/bin/sh\` as the first line and the line below after it; run \`chmod +x tools/hooks/pre-commit tools/hooks/pre-merge-commit\`. The line: ${checkLine}`), doctor);
  const result = sandbox.run(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote tools\/hooks\/pre-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/);
  assert.match(result.stdout, /wrote tools\/hooks\/pre-merge-commit: the commit check \(kept core\.hooksPath \(tools\/hooks\)/);
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), 'tools/hooks');
  for (const hook of ['pre-commit', 'pre-merge-commit']) {
    const path = join(sandbox.repo, 'tools/hooks', hook);
    assert.equal(readFileSync(path, 'utf8'), `#!/bin/sh\n${checkLines('.yokoten/bin/yokoten.ts').join('\n')}\n`, hook);
    assert.ok(statSync(path).mode & 0o100, `${hook} is executable`);
  }
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  sandbox.git('add', '.');
  assert.equal(sandbox.git('commit', '-qm', 'adopt yokoten').status, 0);
  sandbox.write('leak.md', `me${at}gmail.com\n`);
  sandbox.git('add', 'leak.md');
  assert.notEqual(sandbox.git('commit', '-qm', 'leak').status, 0, 'the check runs from the project\'s folder');
  sandbox.git('rm', '-q', '--cached', 'leak.md');
  rmSync(join(sandbox.repo, 'leak.md'));
  // A real merge commit with the author's time zone is refused from the project's folder (#239).
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('topic.md', 'fine\n');
  sandbox.git('add', 'topic.md');
  assert.equal(sandbox.git('commit', '-qm', 'topic').status, 0);
  sandbox.git('checkout', '-q', 'main');
  const merge = spawnSync('git', ['merge', '--no-ff', '-q', '-m', 'merge topic', 'topic'], { cwd: sandbox.repo, env: { ...sandbox.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' });
  assert.notEqual(merge.status, 0, 'tools/hooks/pre-merge-commit runs the check');
  assert.match(merge.stderr, /carries your time zone/);
  assert.equal(sandbox.git('rev-list', '--count', '--merges', 'HEAD').stdout.trim(), '0');
  sandbox.git('merge', '--abort');
});

// git skips a hook without the execute bit, so the check in it never runs (#239).
test('doctor: a hook in the project\'s folder that is not executable is not checked, and init makes it executable (#239)', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'core.hooksPath', 'tools/hooks');
  assert.equal(sandbox.run(['init']).status, 0);
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  const mergeHook = join(sandbox.repo, 'tools/hooks/pre-merge-commit');
  chmodSync(mergeHook, 0o644);
  assert.notEqual(stepMark(sandbox, 'commit-check'), 'done', 'the check is in the file, but git does not run it');
  let doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): merge commits are not checked: tools\/hooks\/pre-merge-commit is not executable, so git skips it/);
  assert.match(doctor, /run `chmod \+x tools\/hooks\/pre-merge-commit`, or `yokoten init`/);
  const result = sandbox.run(['init']);
  assert.match(result.stdout, /made executable tools\/hooks\/pre-merge-commit/);
  assert.ok(statSync(mergeHook).mode & 0o100, 'executable');
  assert.equal(stepMark(sandbox, 'commit-check'), 'done');
  // A pre-commit without the check and without the execute bit: add the line, and chmod.
  const preCommit = join(sandbox.repo, 'tools/hooks/pre-commit');
  writeFileSync(preCommit, '#!/bin/sh\necho own\n');
  chmodSync(preCommit, 0o644);
  doctor = sandbox.run(['doctor']).stdout;
  assert.match(doctor, /commit-check \(OSPS-BR-07\.01\): commits are not checked: tools\/hooks\/pre-commit does not run yokoten; `yokoten init` adds the check to tools\/hooks\/pre-commit,/);
  assert.match(doctor, /or do it yourself: add the line below to tools\/hooks\/pre-commit, after its `#!` line; run `chmod \+x tools\/hooks\/pre-commit`\. The line: /);
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
  // No package.json: the message does not name it (#257).
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no workflow runs a test command/);
  // npm's placeholder script only fails: it is no test command.
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no test command/);
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): CI does not run the tests/);
  sandbox.write('.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npm run test\n');
  assert.match(line(), /^ +done +tests/);
  // A project with no package.json: CI that runs a test runner is enough.
  rmSync(join(sandbox.repo, 'package.json'));
  assert.match(line(), /^ +to do +tests \(Best Practices: test\): no workflow runs a test command such as `go test`, `pytest` or `cargo test`/);
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

// The guide says: run install again to update, and init again to refresh .yokoten/. Run
// from the copy it would replace, that copy was deleted (#204).
test('install: run from the installed copy, it keeps that copy, and the next run works (#204)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['install']).status, 0);
  const installed = join(sandbox.home, '.local/share/yokoten/bin/yokoten.ts');
  for (let run = 0; run < 2; run++) {
    const result = spawnSync('node', [installed, 'install'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^kept: ~\/\.local\/share\/yokoten is the copy running now$/m);
    assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
    assert.ok(existsSync(installed), 'the installed copy is still there');
  }
});

test('install: the session doctor and the command guard for Codex and Gemini CLI, safe twice (#211)', () => {
  const sandbox = makeSandbox();
  const codexFile = join(sandbox.home, '.codex', 'hooks.json');
  const geminiFile = join(sandbox.home, '.gemini', 'settings.json');
  // No ~/.codex or ~/.gemini: install makes neither, and says so.
  const skipped = sandbox.run(['install']);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /^skipped Codex CLI: ~\/\.codex not found \(run `yokoten install` again after installing Codex\)$/m);
  assert.match(skipped.stdout, /^skipped Gemini CLI: ~\/\.gemini not found \(run `yokoten install` again after installing Gemini CLI\)$/m);
  assert.ok(!existsSync(dirname(codexFile)), 'no ~/.codex made');
  assert.ok(!existsSync(dirname(geminiFile)), 'no ~/.gemini made');
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  mkdirSync(dirname(codexFile));
  mkdirSync(dirname(geminiFile));
  writeFileSync(codexFile, JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  writeFileSync(geminiFile, JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.ts"';
  const line = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';
  const atStart = (args: string) => `[ -f ${cli} ] 2>/dev/null || { echo '${line}'; exit 0; }; node ${cli} ${args}`;
  const onCall = (args: string) => onToolCall(`[ -f ${cli} ] 2>/dev/null || { echo '${line}' >&2; exit 1; }; `, cli, args);
  let result = sandbox.run(['install']);
  assert.equal(result.status, 0, result.stderr);
  for (const what of ['Codex SessionStart doctor', 'Codex command guard', 'Gemini CLI SessionStart doctor', 'Gemini CLI command guard']) assert.match(result.stdout, new RegExp(`^added the ${what} in ~/`, 'm'));
  result = sandbox.run(['install']);
  for (const what of ['Codex SessionStart doctor', 'Codex command guard', 'Gemini CLI SessionStart doctor', 'Gemini CLI command guard']) assert.match(result.stdout, new RegExp(`^same the ${what} in ~/`, 'm'));
  const codex = JSON.parse(readFileSync(codexFile, 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.deepEqual(codex.hooks.SessionStart, [{ hooks: [{ type: 'command', command: atStart('doctor --session --agent codex') }] }]);
  assert.deepEqual(codex.hooks.PreToolUse, [...mine('PreToolUse').PreToolUse, { hooks: [{ type: 'command', command: onCall('hook --agent codex --commands-only') }], matcher: 'Bash' }]);
  const gemini = JSON.parse(readFileSync(geminiFile, 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.deepEqual(gemini.hooks.SessionStart, [{ hooks: [{ type: 'command', command: atStart('doctor --session --agent gemini').replace(`echo '${line}'`, `echo '{"hookSpecificOutput":{"additionalContext":"${line}"}}'`), name: 'yokoten-session' }] }]);
  assert.deepEqual(gemini.hooks.BeforeTool, [...mine('BeforeTool').BeforeTool, { hooks: [{ type: 'command', command: onCall('hook --agent gemini --commands-only'), name: 'yokoten-guard' }], matcher: 'run_shell_command' }]);
  // The command guard stops a tag push in any repo, adopted or not.
  const shell = (text: string, input: object) => spawnSync(text, { shell: '/bin/sh', cwd: sandbox.repo, env: sandbox.env, input: JSON.stringify(input), encoding: 'utf8' });
  const push = { session_id: 's1', cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_input: { command: 'git push --tags' } };
  assert.equal(shell(codex.hooks.PreToolUse[1].hooks[0].command, { ...push, tool_name: 'Bash' }).status, 2, 'Codex');
  assert.equal(shell(gemini.hooks.BeforeTool[1].hooks[0].command, { ...push, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command' }).status, 2, 'Gemini CLI');
});

// #248: a hooks file that won't parse, or where a key yokoten edits has the wrong type, is
// named and skipped, byte for byte as it was; the other CLI still gets its hooks, and install
// fails. A parse error asks for valid JSON; a wrong shape names the key instead.
test('install: an unreadable Codex or Gemini CLI hooks file is skipped, the rest goes on, and install exits 1 (#248)', () => {
  const agents = [
    { name: 'Codex', cli: 'Codex CLI', file: '.codex/hooks.json', id: 'codex-user-hook', guard: 'PreToolUse' },
    { name: 'Gemini CLI', cli: 'Gemini CLI', file: '.gemini/settings.json', id: 'gemini-user-hook', guard: 'BeforeTool' },
  ];
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [bad, good] of [agents, [...agents].reverse()]) {
    const shown = `~/${bad.file}`;
    const cases: [content: string, skip: string, doctor: string][] = [
      ['{ not json', `can't read ${shown} (make it valid JSON, then run \`yokoten install\` again)`, `can't read ${shown}; make it valid JSON`],
      ...(
        [
          ['{"hooks": "x"}\n', '`hooks` should be an object'],
          ['{"hooks": []}', '`hooks` should be an object'],
          ['[]', 'the file should be a JSON object'],
          ['{"hooks": {"SessionStart": "x"}}', '`hooks.SessionStart` should be a list of objects'],
          // Deep shapes, once a crash: a number for a group's hooks, a null handler. The bad
          // guard event leaves the file whole, though the doctor hook comes first.
          [`{"hooks":{"${bad.guard}":[{"hooks":5}]}}`, `\`hooks.${bad.guard}[0].hooks\` should be a list of objects`],
          ['{"hooks":{"SessionStart":[{"hooks":[null]}]}}', '`hooks.SessionStart[0].hooks` should be a list of objects'],
        ] as const
      ).map(([content, hint]): [string, string, string] => [content, `${shown} has an unexpected shape (${hint})`, `${shown} has an unexpected shape; ${hint}; fix it`]),
    ];
    for (const [content, skip, doctor] of cases) {
      const sandbox = makeSandbox();
      const badPath = join(sandbox.home, bad.file);
      const goodPath = join(sandbox.home, good.file);
      mkdirSync(dirname(badPath));
      mkdirSync(dirname(goodPath));
      writeFileSync(badPath, content);
      const result = sandbox.run(['install']);
      const what = `${bad.name}, ${JSON.stringify(content)}`;
      assert.equal(result.status, 1, what);
      assert.ok(result.stdout.split('\n').includes(`skipped ${bad.cli}: ${skip}`), `${what}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stderr, '', what);
      assert.doesNotMatch(result.stdout, new RegExp(`the ${bad.name} (SessionStart doctor|command guard)`), what);
      assert.ok(!result.stdout.includes(sandbox.home) && !result.stderr.includes(sandbox.home), `${what}: the home path is shown`);
      assert.equal(readFileSync(badPath, 'utf8'), content, `${what}: the file changed`);
      // Every other step still ran: the other CLI, Claude Code's hooks, and the marks file.
      assert.match(result.stdout, new RegExp(`^added the ${good.name} command guard in ~/`, 'm'), what);
      assert.ok(hasHook(goodPath, 'SessionStart', 'doctor'), `${what}: no ${good.name} hooks`);
      assert.match(result.stdout, /^added the user-level command guard$/m, what);
      assert.match(result.stdout, /^wrote ~\/\S*private-marks /m, what);
      // Doctor names the same problem.
      assert.match(sandbox.run(['doctor']).stdout, new RegExp(`^  note {4}${bad.id}: ${escape(doctor)}`, 'm'), what);
    }
  }
});

test('init: an unreadable project .codex/hooks.json or .gemini/settings.json is skipped, the rest goes on, and init exits 1 (#248)', () => {
  for (const [bad, good, name, stop] of [['.codex/hooks.json', '.gemini/settings.json', 'the Codex hooks', 'Stop'], ['.gemini/settings.json', '.codex/hooks.json', 'the Gemini CLI hooks', 'AfterAgent']]) {
    const cases = [
      ['{ not json', `can't read ${bad} (make it valid JSON, then run \`yokoten init\` again)`],
      ['{"hooks": "x"}', `${bad} has an unexpected shape (\`hooks\` should be an object)`],
      // The stop event is added second: a bad one leaves the file whole.
      [`{"hooks":{"${stop}":[{"hooks":[1]}]}}`, `${bad} has an unexpected shape (\`hooks.${stop}[0].hooks\` should be a list of objects)`],
    ];
    for (const [content, skip] of cases) {
      const sandbox = makeSandbox();
      mkdirSync(join(sandbox.repo, dirname(bad)));
      writeFileSync(join(sandbox.repo, bad), content);
      const result = sandbox.run(['init']);
      const what = `${bad}, ${JSON.stringify(content)}`;
      assert.equal(result.status, 1, what);
      assert.ok(result.stdout.split('\n').includes(`skipped ${name}: ${skip}`), `${what}: ${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(join(sandbox.repo, bad), 'utf8'), content, `${what}: the file changed`);
      assert.ok(hasHook(join(sandbox.repo, good), dirname(good) === '.codex' ? 'Stop' : 'AfterAgent', 'hook'), `${what}: no stop check in ${good}`);
      assert.match(result.stdout, /TZ=UTC for agent sessions/, what);
    }
  }
});

// #248 review: yokoten checks only the keys it edits. Other keys under `hooks`, such as
// Gemini CLI's `hooks.disabled` list, are the user's: install adds its hooks and keeps them.
test('install: other keys under hooks, such as Gemini CLI hooks.disabled, are kept and the hooks added (#248)', () => {
  for (const [dir, file, guard] of [['.gemini', 'settings.json', 'BeforeTool'], ['.codex', 'hooks.json', 'PreToolUse']]) {
    const sandbox = makeSandbox();
    const path = join(sandbox.home, dir, file);
    mkdirSync(dirname(path));
    writeFileSync(path, '{"hooks":{"disabled":["x"],"Other":5}}');
    const result = sandbox.run(['install']);
    assert.equal(result.status, 0, `${dir}: ${result.stdout}${result.stderr}`);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.hooks.disabled, ['x'], dir);
    assert.equal(settings.hooks.Other, 5, dir);
    assert.ok(hasHook(path, 'SessionStart', 'doctor'), `${dir}: no doctor hook`);
    assert.ok(hasHook(path, guard, 'hook'), `${dir}: no guard`);
    assert.match(sandbox.run(['doctor']).stdout, new RegExp(`^  ok {6}${dir.slice(1)}-user-hook$`, 'm'), dir);
  }
});

// Codex adds a SessionStart hook's plain stdout to the context; Gemini CLI reads JSON only (#211).
test('doctor --session --agent: plain text for Codex, hookSpecificOutput JSON for Gemini CLI (#211)', () => {
  const sandbox = makeSandbox();
  const plain = sandbox.run(['doctor', '--session']);
  assert.match(plain.stdout, /^yokoten: stage 1 of 5/);
  assert.deepEqual(pick(sandbox.run(['doctor', '--session', '--agent', 'codex'])), pick(plain));
  const result = sandbox.run(['doctor', '--session', '--agent', 'gemini']);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['additionalContext']);
  assert.equal(out.hookSpecificOutput.additionalContext, plain.stdout.trimEnd());
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // Outside a repo there is nothing to say, and no JSON either.
  assert.equal(sandbox.run(['doctor', '--session', '--agent', 'gemini'], { cwd: sandbox.home }).stdout, '');
  assert.equal(sandbox.run(['doctor', '--session', '--agent', 'cursor']).status, 1);
});

test('init: run from the project\'s .yokoten/, it keeps .yokoten/ (#204)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const vendored = () => spawnSync('node', ['.yokoten/bin/yokoten.ts', 'init'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  let result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.yokoten\/ \(the copy running now\)$/m);
  result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
});

test('install: a copy that fails half way leaves the old copy working (#204)', () => {
  const sandbox = makeSandbox();
  const dest = join(sandbox.home, '.local', 'share', 'yokoten');
  assert.equal(copyRuntime(dest, { withKit: true }), 'wrote');
  writeFileSync(join(dest, 'VERSION'), 'old\n');
  let calls = 0;
  const failing = ((source: string, target: string, options: object) => {
    if (++calls === 2) throw new Error('disk full');
    cpSync(source, target, options);
  }) as typeof cpSync;
  assert.throws(() => copyRuntime(dest, { withKit: true, copy: failing }), /disk full/);
  assert.equal(readFileSync(join(dest, 'VERSION'), 'utf8'), 'old\n', 'the old copy is in place');
  assert.deepEqual(readdirSync(dirname(dest)), ['yokoten'], 'no half copy is left next to it');
  const doctor = spawnSync('node', [join(dest, 'bin', 'yokoten.ts'), 'doctor', '--session'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  // A good copy then takes its place.
  assert.equal(copyRuntime(dest, { withKit: true }), 'wrote');
  assert.notEqual(readFileSync(join(dest, 'VERSION'), 'utf8'), 'old\n');
  assert.deepEqual(readdirSync(dirname(dest)), ['yokoten']);
});

// A temp folder left beside the copy, in a repo root, is one `git add -A` away from a commit (#204).
test('install: a rename that fails leaves the old copy and no temp folder (#204)', () => {
  const sandbox = makeSandbox();
  const dest = join(sandbox.home, '.local', 'share', 'yokoten');
  assert.equal(copyRuntime(dest, { withKit: true }), 'wrote');
  writeFileSync(join(dest, 'VERSION'), 'old\n');
  const failing = (() => {
    throw new Error('busy');
  }) as typeof renameSync;
  assert.throws(() => copyRuntime(dest, { withKit: true, rename: failing }), /busy/);
  assert.equal(readFileSync(join(dest, 'VERSION'), 'utf8'), 'old\n', 'the old copy is in place');
  assert.deepEqual(readdirSync(dirname(dest)), ['yokoten'], 'no temp folder is left next to it');
});

test('install: temp folders that an earlier crash left are removed, and only those (#204)', () => {
  const sandbox = makeSandbox();
  const parent = join(sandbox.home, '.local', 'share');
  const kept = ['.yokoten-newer', '.other-new-abc123', 'notes'];
  for (const name of ['.yokoten-new-abc123', '.yokoten-old-def456', ...kept]) mkdirSync(join(parent, name), { recursive: true });
  assert.equal(copyRuntime(join(parent, 'yokoten'), { withKit: true }), 'wrote');
  assert.deepEqual(readdirSync(parent).sort(), [...kept, 'yokoten'].sort());
});

// A repo inside the clone that runs init was told "kept", with nothing written (#204).
test('init: a repo inside the running copy gets its own .yokoten/, unless the copy would hold itself (#204)', () => {
  const sandbox = makeSandbox();
  const clone = join(sandbox.home, 'clone');
  for (const part of ['bin', 'src', 'kit', 'package.json']) cpSync(join(dirname(CLI), '..', part), join(clone, part), { recursive: true });
  const initIn = (path: string) => {
    mkdirSync(path, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: path, env: sandbox.env });
    return spawnSync('node', [join(clone, 'bin', 'yokoten.ts'), 'init'], { cwd: path, env: sandbox.env, encoding: 'utf8' });
  };
  const project = join(clone, 'project');
  let result = initIn(project);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^wrote \.yokoten\/ /m);
  assert.ok(existsSync(join(project, '.yokoten', 'VERSION')), 'the project has its own runtime');
  // Copying src/ into a folder inside src/ never ends, so init writes nothing and says why.
  const inside = join(clone, 'src', 'project');
  result = initIn(inside);
  assert.deepEqual(pick(result), [1, '', 'yokoten init: cannot copy the runtime to src/project/.yokoten, because it is inside src/ of the copy running now. Run yokoten from a copy outside that folder\n']);
  assert.deepEqual(readdirSync(inside), ['.git'], 'nothing is written');
  assert.ok(!readdirSync(join(clone, 'src')).some((name) => name.startsWith('.')), 'no temp folder is left');
});

// The line goes into a single-quoted echo, and into JSON for Gemini CLI, as it is (#204).
test('guardCommand: refuses a missing-runtime line with a quote or a backslash (#204)', () => {
  for (const line of ["it's gone", 'say "gone"', 'a\\b']) assert.throws(() => guardCommand('p', 'hook', line), /quote or a backslash/, line);
  assert.doesNotThrow(() => guardCommand('p', 'hook', 'yokoten: gone; run the install again'));
});

test('hooks: a missing runtime says one plain line with no path, never a stack trace (#204)', () => {
  const sandbox = makeSandbox();
  // A hook from before #204 is updated in place, never added twice.
  const old = 'node "$HOME/.local/share/yokoten/bin/yokoten.ts" doctor --session';
  mkdirSync(join(sandbox.home, '.claude'));
  // Codex and Gemini CLI get user hooks only when their folders exist (#211).
  mkdirSync(join(sandbox.home, '.codex'));
  mkdirSync(join(sandbox.home, '.gemini'));
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: old }] }] } }));
  assert.match(sandbox.run(['install']).stdout, /^updated the SessionStart doctor$/m);
  assert.equal(sandbox.run(['init']).status, 0);
  rmSync(join(sandbox.home, '.local', 'share', 'yokoten'), { recursive: true });
  rmSync(join(sandbox.repo, '.yokoten'), { recursive: true });
  const shell = (command: string, extra: Record<string, string> = {}) =>
    spawnSync(command, { shell: '/bin/sh', cwd: sandbox.repo, env: { ...sandbox.env, CLAUDE_PROJECT_DIR: sandbox.repo, GEMINI_PROJECT_DIR: sandbox.repo, ...extra }, input: '{}', encoding: 'utf8' });
  const commands = (file: string) => {
    const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks as Record<string, { hooks: { command: string }[] }[]>;
    return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups.flatMap((g) => g.hooks.map((h) => h.command))]));
  };
  const user = commands(join(sandbox.home, '.claude', 'settings.json'));
  assert.equal(user.SessionStart.length, 1);
  const machineLine = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again\n';
  // At session start the line goes to the agent; a tool call goes on, with the line shown.
  assert.deepEqual(pick(shell(user.SessionStart[0])), [0, machineLine, '']);
  assert.deepEqual(pick(shell(user.PreToolUse[0])), [1, '', machineLine]);
  // The same for Codex and Gemini CLI (#211).
  const codexUser = commands(join(sandbox.home, '.codex', 'hooks.json'));
  const geminiUser = commands(join(sandbox.home, '.gemini', 'settings.json'));
  for (const command of codexUser.SessionStart) assert.deepEqual(pick(shell(command)), [0, machineLine, ''], command);
  // Gemini CLI reads only JSON at session start.
  const geminiStart = shell(geminiUser.SessionStart[0]);
  assert.equal(geminiStart.status, 0, geminiStart.stderr);
  assert.deepEqual(JSON.parse(geminiStart.stdout), { hookSpecificOutput: { additionalContext: machineLine.trimEnd() } });
  for (const command of [...codexUser.PreToolUse, ...geminiUser.BeforeTool]) assert.deepEqual(pick(shell(command)), [1, '', machineLine], command);
  const project = commands(join(sandbox.repo, '.claude', 'settings.json'));
  const projectLine = `${MISSING_PROJECT}\n`;
  const codexProject = commands(join(sandbox.repo, '.codex', 'hooks.json'));
  const geminiProject = commands(join(sandbox.repo, '.gemini', 'settings.json'));
  for (const command of [...project.PreToolUse, ...project.Stop, ...codexProject.PreToolUse.slice(-1), ...codexProject.Stop, ...geminiProject.BeforeTool, ...geminiProject.AfterAgent]) {
    assert.deepEqual(pick(shell(command)), [1, '', projectLine], command);
  }
  // A project path with a space: the `[` test's own error, with the full path, is not shown.
  for (const command of [...geminiProject.BeforeTool, ...geminiProject.AfterAgent]) {
    assert.deepEqual(pick(shell(command, { GEMINI_PROJECT_DIR: join(sandbox.home, 'a b') })), [1, '', projectLine], command);
  }
  // The commit check stops the commit, with one plain line: a commit now would delete .yokoten/.
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', 'a.md');
  const commit = sandbox.git('commit', '-qm', 'a');
  assert.deepEqual(pick(commit), [1, '', 'yokoten: the commit check cannot run, because .yokoten/bin/yokoten.ts is missing. Restore it from git, or run yokoten init again\n']);
  for (const out of [commit.stderr, projectLine, machineLine]) assert.ok(!out.includes(sandbox.home) && !out.includes(sandbox.repo), 'no absolute path');
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
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
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
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
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
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: `tier ${tier}` }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
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
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
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

// #267: a commit the checkout does not have is one finding with the fix, in text, JSON
// and the job summary; git's raw error never reaches the output.
test('check --pr: a base or head commit not in the checkout is one finding, never a git crash (#267)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const base = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('src/a.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
  const event = (shas: { base: string; head: string }) => {
    const file = join(sandbox.home, 'event.json');
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: shas.base }, head: { sha: shas.head } } }));
    return file;
  };
  const noGitError = (out: string) => assert.doesNotMatch(out, /fatal|Command failed|symmetric difference|Invalid/i, out);
  // The positive control: both commits here, so the check passes.
  assert.equal(sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base, head }) } }).status, 0);

  // A depth-1 clone has the head but not the base.
  const clone = join(sandbox.home, 'clone');
  const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${sandbox.repo}`, clone], { env: sandbox.env, encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr);
  const summary = join(sandbox.home, 'summary.md');
  let result = sandbox.run(['check', '--pr'], { cwd: clone, extra: { GITHUB_EVENT_PATH: event({ base, head }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's base commit is not in this checkout\. .+\. Use `fetch-depth: 0` in actions\/checkout, so the checkout has the whole history\.\n  docs: \S+#use-it-as-a-github-action\n$/);
  noGitError(result.stderr);
  result = sandbox.run(['check', '--pr', '--json'], { cwd: clone, extra: { GITHUB_EVENT_PATH: event({ base, head }), GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  let report = JSON.parse(result.stdout);
  assert.deepEqual([report.check, report.ok, report.findings.map((f: { id: string }) => f.id)], ['pr', false, ['pr-commits']]);
  assert.match(report.findings[0].what, /base commit/);
  assert.match(report.findings[0].fix, /fetch-depth: 0/);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check --pr: 1 problem\n\n\| Place \| Rule \| What \| Why \| Fix \|\n\|[-|]+\|\n\|  \| \[pr-commits\]\(\S+\) \| the pull request's base commit is not in this checkout \| .+ \| Use `fetch-depth: 0` in actions\/checkout/);

  // A full clone, with a head that was never fetched.
  const missing = 'f'.repeat(40);
  result = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base, head: missing }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's head commit is not in this checkout\. .+fetch-depth: 0/);
  noGitError(result.stderr);
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event({ base, head: missing }) } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  report = JSON.parse(result.stdout);
  assert.deepEqual([report.ok, report.findings.length, report.findings[0].id], [false, 1, 'pr-commits']);
  assert.match(report.findings[0].what, /head commit/);
  // Both missing: one finding that names both. A value that is not a commit id is missing too.
  result = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: event({ base: missing, head: '--output=x' }) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten check --pr: 1 problem\(s\)\n- the pull request's base and head commits are not in this checkout\./);
  assert.ok(!existsSync(join(sandbox.repo, 'x')), 'a sha is never read as an option');
  // Both here, but with no common commit: git can't read base...head either.
  sandbox.git('checkout', '-q', '--orphan', 'other');
  sandbox.git('commit', '-qm', 'unrelated');
  const unrelated = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: event({ base, head: unrelated }) } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.match(JSON.parse(result.stdout).findings[0].what, /no common commit/);
});

test('check --pr and --issue: an event file that is missing or broken is one finding; odd fields are skipped (#267)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const file = join(sandbox.home, 'event.json');
  const summary = join(sandbox.home, 'summary.md');
  const cases: [string | null, RegExp][] = [
    [null, /can't be read/],
    ['{ broken', /is not valid JSON/],
    ['null', /is not a JSON object/],
    ['[1]', /is not a JSON object/],
  ];
  for (const mode of ['--pr', '--issue']) {
    for (const [content, what] of cases) {
      rmSync(file, { force: true });
      if (content !== null) writeFileSync(file, content);
      let result = sandbox.run(['check', mode], { extra: { GITHUB_EVENT_PATH: file } });
      assert.equal(result.status, 1, `${mode} ${content}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`^yokoten check ${mode}: 1 problem\\(s\\)\\n- the CI event file \\(GITHUB_EVENT_PATH\\) ${what.source}\\. .+\\. Run it in a GitHub Actions job`));
      assert.doesNotMatch(result.stderr, /ENOENT|SyntaxError|TypeError|Unexpected token/);
      assert.ok(!result.stderr.includes(sandbox.home), 'the path is not printed');
      result = sandbox.run(['check', mode, '--json'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout).findings.map((f: { id: string }) => f.id), ['ci-event']);
    }
  }
  assert.equal(readFileSync(summary, 'utf8').split('| [ci-event](').length - 1, 8, 'each run wrote its summary');
  // A label that is null or has no name, and a title that is not text, are skipped, not a crash.
  writeFileSync(file, JSON.stringify({ issue: { title: 'check: a symptom', labels: [null, 7, { name: 'incident' }, {}] } }));
  let result = sandbox.run(['check', '--issue'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(file, JSON.stringify({ issue: { title: 42, labels: null } }));
  result = sandbox.run(['check', '--issue', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(JSON.parse(result.stdout).findings.length > 0, 'an empty title fails its rule');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: null, labels: [null], milestone: 'M0', base: { sha: head }, head: { sha: head } } }));
  result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.ok(JSON.parse(result.stdout).findings.some((f: { id: string }) => f.id === 'pr-labels'));
  // An event with neither is not a run to check, as before.
  writeFileSync(file, JSON.stringify({ action: 'opened', pull_request: null, issue: 'x' }));
  for (const mode of ['--pr', '--issue']) assert.match(sandbox.run(['check', mode], { extra: { GITHUB_EVENT_PATH: file } }).stdout, /in this run/);
});

// #273: an event whose base or head commit id is empty, missing or not text is one
// finding, never an empty diff that lets the file rules pass.
test('check --pr: a pull request event with no base or head commit id is one finding (#273)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'Short.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  const head = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  const file = join(sandbox.home, 'event.json');
  const body = 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\nNo changelog: a test\n';
  const cases: [object, object, string][] = [
    [{}, { sha: head }, 'base commit is'],
    [{ sha: head }, { sha: 7 }, 'head commit is'],
    [{ sha: '' }, { sha: '' }, 'base and head commits are'],
  ];
  for (const [baseField, headField, what] of cases) {
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }], milestone: { title: 'M0' }, base: baseField, head: headField } }));
    let result = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
    assert.equal(result.status, 1, what);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`^yokoten check --pr: 1 problem\\(s\\)\\n- the pull request's ${what} missing from the event\\. .+\\. Run it in a GitHub Actions job on a \`pull_request\` event`));
    result = sandbox.run(['check', '--pr', '--json'], { extra: { GITHUB_EVENT_PATH: file } });
    assert.equal(result.status, 1, what);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.deepEqual([report.check, report.ok, report.findings.map((f: { id: string }) => f.id)], ['pr', false, ['pr-commits']]);
    assert.match(report.findings[0].what, new RegExp(`${what} missing from the event`));
  }
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
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body, labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: { title: 'M0' }, base: { sha: base }, head: { sha: head } } }));
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
  writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat: a', body: 'tier: B\nCloses #1\n## Why\nx\n## What changed\nx\n## How tested\nx\n', labels: [{ name: 'feat' }, { name: 'tier B' }], milestone: null, base: { sha: base }, head: { sha: head } } }));
  const summary = join(sandbox.home, 'summary.md');
  const r = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.status, 1, 'no milestone');
  assert.match(r.stdout, /^::error title=yokoten pr-milestone::/m, 'a finding with no place has no file');
  assert.match(r.stdout, /^::warning file=README\.md,line=2,title=yokoten long-sentence::a sentence of 30 words\. /m);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /^### yokoten check --pr: 1 problem\n/);
  assert.match(text, /\n#### Notes \(1\): these never fail the check\n\n\| Place \| Rule \| What \| Why \| Fix \|\n\|[-|]+\|\n\| README\.md:2 \| long-sentence \| a sentence of 30 words \|/);
});

// #208: a clone install puts no `yokoten` on the PATH, so install says how to call it.
test('install: prints the alias when no yokoten on the PATH runs this copy, and edits no shell file (#208)', () => {
  const sandbox = makeSandbox();
  const alias = "alias yokoten='node ~/.local/share/yokoten/bin/yokoten.ts'";
  let result = sandbox.run(['install']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trimEnd().endsWith(`then open a new shell: ${alias}`), result.stdout);
  for (const file of ['.bashrc', '.zshrc', '.profile', '.local/bin']) assert.ok(!existsSync(join(sandbox.home, file)), `${file} was written`);
  // A yokoten on the PATH that runs the installed copy: the line is left out.
  const bin = join(sandbox.home, 'bin');
  mkdirSync(bin);
  symlinkSync(join(sandbox.home, '.local/share/yokoten/bin/yokoten.ts'), join(bin, 'yokoten'));
  result = sandbox.run(['install'], { extra: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('alias yokoten'), result.stdout);
});

// #208: steps left on the road are to do, not problems. Exit 1 is for a problem.
test('doctor: exits 0 on a set-up project with steps to do, and 1 on a problem (#208)', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['install']).status, 0);
  writeFileSync(join(sandbox.home, '.config/yokoten/private-marks'), 'mycity\n');
  sandbox.withTests();
  assert.equal(sandbox.run(['init']).status, 0);
  let result = sandbox.run(['doctor']);
  assert.match(result.stdout, /\n +next +codeowners[^]*\n +to do +bot/, 'later steps are left');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(sandbox.run(['doctor', '--json']).stdout).ok, true);
  // A problem: a private mark in the tree.
  sandbox.write('notes.md', 'I live in MyCity\n');
  sandbox.git('add', 'notes.md');
  result = sandbox.run(['doctor']);
  assert.match(result.stdout, /MISSING tree: 1 problem/);
  assert.equal(result.status, 1);
  assert.equal(sandbox.run(['doctor', '--session']).status, 0, 'a session always starts');
});

test('update: a folder that does not exist is said plainly (#208)', () => {
  const sandbox = makeSandbox();
  const result = sandbox.run(['update', 'typo']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'yokoten update: typo does not exist; nothing to update.\n']);
  assert.ok(!existsSync(join(sandbox.repo, 'typo')));
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
  assert.equal(sandbox.run(['doctor']).status, 1, 'nothing is installed on this machine: a problem');
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

test('outside a git repo: every command that needs one says so plainly, exits 1 and writes nothing (#205)', () => {
  const sandbox = makeSandbox();
  // Inside the sandbox home, so the folder shows as ~.
  const away = join(sandbox.home, 'away');
  mkdirSync(away);
  const said = (command: string) => new RegExp(`^yokoten ${command}: ~/away is not inside a git repo\\. The checks read commits, so yokoten needs git history\\. Run it inside your project, or \`git init\` first\\.\\n  docs: \\S+#commands\\n$`);
  const runs: [string[], string, Record<string, string>?][] = [
    [['doctor'], 'doctor'],
    [['check'], 'check'],
    [['check', '--staged'], 'check'],
    [['check', '--history'], 'check'],
    [['check', '--pr'], 'check'],
    [['check', '--issue'], 'check'],
    [['adopt'], 'adopt'],
    [['update'], 'update'],
    [['update', '--write'], 'update'],
    [['init'], 'init'],
    [['init', '--github', '--yes'], 'init'],
    [['bot', '--', 'gh', 'issue', 'list'], 'bot', { YOKOTEN_BOT_APP_ID: '1' }],
  ];
  for (const [args, command, extra] of runs) {
    const result = sandbox.run(args, { cwd: away, extra });
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '', `${args.join(' ')}: nothing on stdout`);
    assert.match(result.stderr, said(command), args.join(' '));
    assert.deepEqual(readdirSync(away), [], `${args.join(' ')}: nothing written`);
  }
  // --json: the same finding, as data.
  for (const args of [['check', '--json'], ['doctor', '--json']]) {
    const result = sandbox.run(args, { cwd: away });
    assert.equal(result.status, 1, args.join(' '));
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, false);
    const found = out.findings.find((f: { id: string }) => f.id === 'not-a-repo');
    assert.equal(found?.what, '~/away is not inside a git repo', args.join(' '));
  }
  // init in a folder that does not exist creates nothing: a typo never becomes a project.
  const result = sandbox.run(['init', 'typo'], { cwd: away });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'yokoten init: typo does not exist; nothing was written. Create it and run `git init` there first.\n');
  assert.deepEqual(readdirSync(away), [], 'no folder made');
  // A session in a non-repo folder gets no noise, and starts.
  const session = sandbox.run(['doctor', '--session'], { cwd: away });
  assert.deepEqual([session.status, session.stdout, session.stderr], [0, '', '']);
  // changelog reads changes/ only, and needs no git.
  assert.equal(sandbox.run(['changelog'], { cwd: away }).status, 0);
});

test('git not installed: a command that needs a repo says git is missing, not "not a repo" (#205)', () => {
  const sandbox = makeSandbox();
  // Only node on the PATH.
  const noGit = join(sandbox.home, 'no-git');
  mkdirSync(noGit);
  symlinkSync(process.execPath, join(noGit, 'node'));
  for (const command of ['check', 'doctor']) {
    const result = sandbox.run([command], { extra: { PATH: noGit } });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, new RegExp(`^yokoten ${command}: git is not installed \\(or not on PATH\\); yokoten needs git\\. `), command);
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
});

test('explain with no id lists the ids on stdout and exits 0; --json gives { ids } (#247)', () => {
  const sandbox = makeSandbox();
  let result = sandbox.run(['explain']);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  assert.match(result.stdout, /^Ids: release, .*\bsecret\b.*\n$/);
  result = sandbox.run(['explain', '--json']);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(listed), ['ids']);
  assert.ok(listed.ids.includes('release') && listed.ids.includes('secret'));
  // An unknown id is still an error.
  result = sandbox.run(['explain', 'nope']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no rule or step is called nope\.\nIds: release, /);
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
  // --github --yes asked for changes on GitHub; with no remote none were made, so it fails (#208).
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because there is no origin remote yet\. Add one on GitHub, then run `yokoten init --github --yes`/);
  assert.match(result.stderr, /\nyokoten init: --github --yes changed nothing on GitHub \(the reason is above\)\. The project files are as listed above\.\n$/);
  assert.equal(calls().length, 0);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  result = sandbox.run(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: example\/repo\n- 1 of the 12 standard labels are there; kept\n- not in the standard set: question\./);
  assert.match(result.stdout, /Would do:\n- make label "feat"[^]*- make milestone "First release"\nNothing changed\./);
  assert.deepEqual(changed(), [], 'plain init only reads');
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- done: make label "good first issue"[^\n]*\n[^]*- done: make milestone "First release"/);
  assert.equal(changed().length, 12);
  result = sandbox.run(['init', '--github', '--yes'], { extra });
  assert.match(result.stdout, /- 12 of the 12 standard labels are there; kept\n- a milestone is open; kept\n[^]*Nothing to change\./);
  assert.equal(changed().length, 12, 'the second run changed nothing');
  // Without gh on the PATH, plain init still succeeds and says so. Only node and git are there.
  const noGh = join(sandbox.home, 'no-gh');
  mkdirSync(noGh);
  const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(noGh, 'node'));
  symlinkSync(join(gitPath, 'git'), join(noGh, 'git'));
  result = sandbox.run(['init'], { extra: { PATH: noGh } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because gh is not installed/);
  // init --github --yes fails: it was asked to change GitHub and could not (#208).
  result = sandbox.run(['init', '--github', '--yes'], { extra: { PATH: noGh } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because gh is not installed[^\n]*\nyokoten init: --github --yes changed nothing on GitHub/);
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
  // Claude Code keeps the plugin's copy, so only install's commands check that the copy is there (#204).
  const unguard = (command: string) => command.replace(/^\[ -f .*?; \}; (?=node |command -v node )/, '');
  const shape = (h: typeof hooks, cli: string) => Object.fromEntries(Object.entries(h).map(([event, groups]) => [event, groups.map((g) => ({ matcher: g.matcher, commands: g.hooks.map((x) => `${x.type}: ${unguard(x.command).replace(cli, 'CLI')}`) }))]));
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

// #211: Codex's and Gemini CLI's user hooks, only once the CLI's folder exists; a note
// that never changes the exit code, and ok after `install`.
test('doctor: notes the Codex and Gemini CLI user hooks when that CLI is used (#211)', () => {
  for (const [agent, dir, file] of [['codex', '.codex', 'hooks.json'], ['gemini', '.gemini', 'settings.json']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const before = sandbox.run(['doctor']);
    assert.doesNotMatch(before.stdout, new RegExp(name), `${agent}: no ~/${dir}, no line`);
    mkdirSync(join(sandbox.home, dir));
    const noted = sandbox.run(['doctor']);
    assert.match(noted.stdout, new RegExp(`^  note {4}${name}: no session-start doctor and no command guard in ~/${dir}/${file}; \`yokoten install\` adds them$`, 'm'));
    assert.equal(noted.status, before.status, `${agent}: a note never changes the exit code`);
    const json = JSON.parse(sandbox.run(['doctor', '--json']).stdout);
    assert.ok(json.notes.some((n: { id: string }) => n.id === name), `${agent}: a note in --json, under its own id`);
    assert.ok(!json.notes.some((n: { id: string; what: string }) => n.id === `${agent}-hook` && n.what.includes(`~/${dir}`)), `${agent}: not under the project rule's id`);
    assert.ok(!json.findings.some((n: { id: string }) => n.id === name), `${agent}: not a finding`);
    // The folder exists by now, so install writes the hooks.
    assert.equal(sandbox.run(['install']).status, 0);
    assert.match(sandbox.run(['doctor']).stdout, new RegExp(`ok {6}${name}\\n`));
    const explain = sandbox.run(['explain', `${agent}-hook`]).stdout;
    assert.match(explain, /tool-call guard and stop check/);
    assert.match(explain, agent === 'codex' ? /a Stop hook/ : /an AfterAgent hook/);
    assert.doesNotMatch(explain, new RegExp(`~/${dir}`), `${agent}-hook is about the project only`);
    const explainUser = sandbox.run(['explain', name]).stdout;
    assert.match(explainUser, /session-start doctor and command guard/);
    assert.match(explainUser, new RegExp(`~/${dir}/${file}`));
  }
});

// #211 review: doctor compares each user hook with what install writes, so one missing,
// an old one, or a file it can't read each says so; a ~/.codex that is a file is no folder.
test('doctor: a missing, out-of-date or unreadable Codex or Gemini CLI user hook (#211)', () => {
  for (const [agent, dir, file, guardEvent] of [['codex', '.codex', 'hooks.json', 'PreToolUse'], ['gemini', '.gemini', 'settings.json', 'BeforeTool']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const path = join(sandbox.home, dir, file);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = (text: string) => new RegExp(`^  note {4}${name}: ${escape(text)}$`, 'm');
    mkdirSync(join(sandbox.home, dir));
    assert.equal(sandbox.run(['install']).status, 0);
    const written = readFileSync(path, 'utf8');
    type Hooks = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const edit = (change: (s: Hooks) => void) => {
      const settings: Hooks = JSON.parse(written);
      change(settings);
      writeFileSync(path, JSON.stringify(settings));
    };
    // Only the guard missing: its exact line, and "it".
    edit((s) => delete s.hooks[guardEvent]);
    assert.match(sandbox.run(['doctor']).stdout, line(`no command guard in ~/${dir}/${file}; \`yokoten install\` adds it`));
    // The doctor hook from an older runtime path: out of date, not ok.
    edit((s) => {
      const hook = s.hooks.SessionStart[0].hooks[0];
      hook.command = hook.command.replace('.local/share/yokoten', '.yokoten');
    });
    assert.match(sandbox.run(['doctor']).stdout, line(`the session-start doctor in ~/${dir}/${file} is out of date; \`yokoten install\` updates it`));
    // The guard on another matcher: out of date too.
    edit((s) => {
      s.hooks[guardEvent][0].matcher = 'other';
    });
    assert.match(sandbox.run(['doctor']).stdout, line(`the command guard in ~/${dir}/${file} is out of date; \`yokoten install\` updates it`));
    assert.match(sandbox.run(['install']).stdout, /^updated the .* command guard in /m);
    assert.match(sandbox.run(['doctor']).stdout, new RegExp(`^  ok {6}${name}$`, 'm'));
    // A file that won't parse: can't read it, never "missing".
    writeFileSync(path, '{ not json');
    const unread = sandbox.run(['doctor']);
    assert.match(unread.stdout, line(`can't read ~/${dir}/${file}; make it valid JSON, then run \`yokoten install\``));
    assert.doesNotMatch(unread.stdout, new RegExp(`${name}: no `));
    // A ~/.codex that is a file: not a folder, so doctor says nothing and install skips it.
    rmSync(join(sandbox.home, dir), { recursive: true });
    writeFileSync(join(sandbox.home, dir), 'a file');
    assert.doesNotMatch(sandbox.run(['doctor']).stdout, new RegExp(name));
    const install = sandbox.run(['install']);
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, new RegExp(`^skipped .*: ~/\\${dir} not found`, 'm'));
    assert.equal(readFileSync(join(sandbox.home, dir), 'utf8'), 'a file');
  }
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
  const jsonNote = json.notes.find((n: { what: string }) => olderNote.test(n.what));
  assert.ok(jsonNote, 'a note in JSON');
  assert.equal(jsonNote.id, 'plugin-version', 'its own rule, so `yokoten explain` tells the right thing');
  assert.match(jsonNote.docs, /#the-claude-code-plugin$/);
  assert.match(sandbox.run(['explain', jsonNote.id]).stdout, /plugin is not older than the yokoten/);
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
    // Every spelling gh takes (#279): `new` for `create`, and an option before the noun or the verb.
    for (const command of [['gh', 'issue', 'new', '--title', 'host: add a step.'], ['gh', 'issue', '-R', 'o/r', 'create', '--title', 'host: add a step.'], ['gh', '--repo', 'o/r', 'issue', 'edit', '5', '-t', 'host: add a step.']]) {
      await refused(command, /title: a full stop at the end\. A title is a name/);
    }
    for (const command of [['gh', 'pr', 'new', '--title', 'feat(host): add a step.'], ['gh', 'pr', '-R', 'o/r', 'edit', '5', '--title', 'feat(host): add a step.'], ['gh', '--repo=o/r', 'pr', 'create', '-t', 'feat(host): add a step.']]) {
      await refused(command, /title: a full stop at the end\. A commit title has no full stop/);
    }
    // Short flags run together (#290): read as gh reads them, and refused when a letter is unknown.
    await refused(['gh', 'pr', 'create', '-dt', 'feat(host): add a step.'], /title: a full stop at the end\. A commit title has no full stop/);
    await refused(['gh', 'issue', 'create', '-wthost: add a step.'], /title: a full stop at the end\. A title is a name/);
    await refused(['gh', 'pr', 'create', '-dzt', 'feat(host): add a step'], /title: can't read the title in `-dzt`\. .+\. Write --title on its own\.$/m);
    // With no bot set up at all, the title is still the reason given.
    await refused(['gh', 'pr', 'create', '--title', 'feat(host): add a step.'], /full stop/, path);
    const missing = await run(['gh', 'pr', 'create', '--title', 'feat(host): add a step'], path);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^yokoten bot: YOKOTEN_BOT_APP_ID is not set/, 'a good title goes on to the bot setup');

    // A good title, and commands with no title, take the normal bot path.
    const good: string[][] = [
      ['gh', 'issue', 'create', '--title', 'host: check the title', '--label', 'incident', '--body', '-t'],
      ['gh', 'pr', 'create', '-t', 'feat(host): check the title', '--body', 'x'],
      ['gh', 'issue', '-R', 'me/repo', 'new', '--title', 'host: check the title'],
      ['gh', 'pr', 'new', '-t', 'feat(host): check the title'],
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

// A guard that crashes, runs out of memory or is killed must refuse the call: the agents
// run a call on any exit but 2 (#260). Each tool-call hook, as init, install and the plugin
// write it, runs through sh with its runtime replaced by a script that ends one way.
test('hooks: a tool-call guard that fails refuses the call; the stop check does not (#260)', () => {
  const sandbox = makeSandbox();
  // Codex and Gemini CLI are installed, so install writes their home hooks too.
  for (const dir of ['.codex', '.gemini']) mkdirSync(join(sandbox.home, dir), { recursive: true });
  assert.equal(sandbox.run(['install']).status, 0);
  assert.equal(sandbox.run(['init']).status, 0);
  const commands = (file: string) => {
    const hooks = JSON.parse(readFileSync(file, 'utf8')).hooks as Record<string, { hooks: { command: string }[] }[]>;
    return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, groups.flatMap((g) => g.hooks.map((h) => h.command))]));
  };
  const project = commands(join(sandbox.repo, '.claude', 'settings.json'));
  const codex = commands(join(sandbox.repo, '.codex', 'hooks.json'));
  const gemini = commands(join(sandbox.repo, '.gemini', 'settings.json'));
  const user = commands(join(sandbox.home, '.claude', 'settings.json'));
  const codexUser = commands(join(sandbox.home, '.codex', 'hooks.json'));
  const geminiUser = commands(join(sandbox.home, '.gemini', 'settings.json'));
  const plugin = (manifest('plugin.json').hooks.PreToolUse[0].hooks[0].command as string).replaceAll(PLUGIN_ROOT, '$PLUGIN');
  const calls = [...project.PreToolUse, ...codex.PreToolUse.slice(-1), ...gemini.BeforeTool.slice(-1), ...user.PreToolUse, ...codexUser.PreToolUse, ...geminiUser.BeforeTool, plugin];
  assert.equal(calls.length, 7);
  // The project, the home and the plugin all sit under a path with a space.
  const base = join(sandbox.home, 'a b');
  const repo = join(base, 'my repo');
  const home = join(base, 'home');
  const pluginRoot = join(base, 'plugin');
  mkdirSync(repo, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const runtimes = [join(repo, '.yokoten', 'bin', 'yokoten.ts'), join(home, '.local', 'share', 'yokoten', 'bin', 'yokoten.ts'), join(pluginRoot, 'bin', 'yokoten.ts')];
  const runtime = (body: string) => {
    for (const file of runtimes) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  };
  const env = { ...sandbox.env, HOME: home, CLAUDE_PROJECT_DIR: repo, GEMINI_PROJECT_DIR: repo, PLUGIN: pluginRoot };
  // Gemini CLI puts $GEMINI_PROJECT_DIR in the command shell-quoted itself, as shell-quote writes it.
  const quoted = `'${repo.replaceAll("'", "'\\''")}'`;
  // dash (Linux's /bin/sh) and bash each print a job line for a killed child; bash's holds
  // the whole command, paths included. Each command runs under both.
  const shells = ['/bin/sh', '/bin/bash'].filter((sh) => existsSync(sh));
  const shell = (command: string, sh = '/bin/sh', extra: Record<string, string> = {}) =>
    spawnSync(command.replaceAll('$GEMINI_PROJECT_DIR', quoted), { shell: sh, cwd: repo, env: { ...env, ...extra }, input: '{}', encoding: 'utf8' });
  const each = (commands: string[], expected: unknown[]) => {
    for (const sh of shells) for (const command of commands) assert.deepEqual(pick(shell(command, sh)), expected, `${sh}: ${command}`);
  };
  const refused = (code: number) => `yokoten's guard failed (exit ${code}), so the command is refused; run \`yokoten doctor\`\n`;
  // A failure gives our one line on stderr and nothing else: node's own error is dropped.
  runtime("process.stderr.write('a trace with /a/path\\n'); process.exit(1);\n");
  each(calls, [2, '', refused(1)]);
  runtime("process.stderr.write('/a/path\\n'); process.kill(process.pid, 'SIGKILL');\n");
  each(calls, [2, '', refused(137)]);
  // A guard's own answer passes as it is, stdout and stderr byte for byte.
  runtime("process.stdout.write('{\"a\":1}\\n\\n'); process.stderr.write('note\\n\\n'); process.exit(0);\n");
  each(calls, [0, '{"a":1}\n\n', 'note\n\n']);
  runtime("process.stdout.write('{}'); process.stderr.write('no\\n'); process.exit(2);\n");
  each(calls, [2, '{}', 'no\n']);
  // A runaway read stops at the small heap and is refused, without swapping, and without
  // the heap trace V8 writes.
  runtime('const a = []; for (;;) a.push(new Array(1e6).fill(1));\n');
  each([project.PreToolUse[0], plugin], [2, '', refused(134)]);
  // No node on the agent's PATH: one line, and the call goes on, so `yokoten doctor` can run.
  const noNode = join(base, 'no-node');
  mkdirSync(noNode);
  symlinkSync(spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(noNode, 'git'));
  runtime('process.exit(0);\n');
  for (const sh of shells) for (const command of calls) assert.deepEqual(pick(shell(command, sh, { PATH: noNode })), [1, '', `${MISSING_NODE}\n`], `${sh}: ${command}`);
  // The stop check and the session doctor pass a failure on: exit 2 at stop would send the
  // agent back to work on a guard that cannot run.
  runtime('process.exit(1);\n');
  for (const command of [...project.Stop, ...codex.Stop, ...gemini.AfterAgent, ...user.SessionStart, ...codexUser.SessionStart, ...geminiUser.SessionStart]) {
    assert.deepEqual(pick(shell(command)), [1, '', ''], command);
  }
  // A missing runtime still says its line and goes on, as before.
  for (const file of runtimes) rmSync(file);
  const machineLine = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again\n';
  each([...project.PreToolUse, ...codex.PreToolUse.slice(-1), ...gemini.BeforeTool.slice(-1)], [1, '', `${MISSING_PROJECT}\n`]);
  each([...user.PreToolUse, ...codexUser.PreToolUse, ...geminiUser.BeforeTool], [1, '', machineLine]);
});

// The plugin's guard is the text the builder makes, so the two cannot drift (#260).
test('plugin: its tool-call guard is the command refuseOnFailure builds', () => {
  assert.equal(manifest('plugin.json').hooks.PreToolUse[0].hooks[0].command, refuseOnFailure(`"${PLUGIN_ROOT}/bin/yokoten.ts"`, 'hook --commands-only'));
});
