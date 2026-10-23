// Tests for src/commands/hook.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import {
  at,
  makeSandbox,
  pick,
  makeTempDir,
  runChild,
} from '../repo/helpers.ts';
import { invoke } from '../repo/invoke.ts';
import { redactCommand } from '../../src/commands/hook.ts';

// A session started outside the repo, or a worker in a worktree elsewhere, loads no project
// hook: the user-level guard applies the file's own repo's rules, if yokoten is set up there (#307).
test('hook --commands-only: an edit in a yokoten repo gets its file rules wherever the session started (#307)', async () => {
  const sandbox = makeSandbox();
  const away = makeTempDir('yokoten-away-');
  const edit = (file_path: string, extra?: Record<string, string>) =>
    sandbox.call(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Edit', tool_input: { file_path } }), extra });
  const worker = { YOKOTEN_ROLE: 'worker' };
  // No yokoten.json: not a yokoten repo, so no file rules.
  assert.equal((await edit(join(sandbox.repo, 'AGENTS.md'), worker)).status, 0);
  sandbox.write('yokoten.json', '{}\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  let result = await edit(join(sandbox.repo, 'AGENTS.md'), worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal((await edit(join(sandbox.repo, '.githooks', 'pre-commit'), worker)).status, 2, 'a file in a folder that does not exist yet');
  assert.equal((await edit(join(sandbox.repo, 'AGENTS.md'))).status, 0, 'the lead may');
  assert.equal((await edit(join(sandbox.repo, 'src', 'a.ts'), worker)).status, 0, 'a worker may edit code');
  // A worker subagent in a lead session.
  result = await sandbox.call(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, agent_type: 'worker', tool_name: 'Edit', tool_input: { file_path: join(sandbox.repo, 'AGENTS.md') } }) });
  assert.equal(result.status, 2);
  // A relative path, from the session's folder.
  const parent = dirname(sandbox.repo);
  result = await sandbox.call(['hook', '--commands-only'], { cwd: parent, input: JSON.stringify({ cwd: parent, tool_name: 'Edit', tool_input: { file_path: 'repo/AGENTS.md' } }), extra: worker });
  assert.equal(result.status, 2);
  // A worktree in another folder: its own checkout, the same rules.
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  result = await edit(join(tree, 'AGENTS.md'), worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal((await edit(join(tree, 'AGENTS.md'))).status, 0);
  // The full hook too, from a session outside the repo.
  result = await sandbox.call(['hook'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Edit', tool_input: { file_path: join(tree, 'AGENTS.md') } }), extra: worker });
  assert.equal(result.status, 2);
  // Commands are unchanged.
  const bash = (command: string) => sandbox.call(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Bash', tool_input: { command } }), extra: worker });
  assert.equal((await bash(`cat ${join(sandbox.repo, 'AGENTS.md')}`)).status, 0);
  assert.equal((await bash('git push --tags')).status, 2);
  // A patch run through Codex's shell edits files too (#221): they get their repo's rules.
  const patch = (file: string) => `apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\nEOF\n`;
  const codex = (command: string) =>
    sandbox.call(['hook', '--agent', 'codex', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), extra: worker });
  result = await codex(patch(join(sandbox.repo, 'AGENTS.md')));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal((await codex(patch(join(sandbox.repo, 'src', 'a.ts')))).status, 0);
});

test('hook --stop: sends the agent back once with the findings in changed files, never twice (#92)', async () => {
  const sandbox = makeSandbox();
  const event = (active: boolean) => JSON.stringify({ session_id: 'abc123', cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: 'done' });
  const stop = (active = false, extra?: Record<string, string>) => sandbox.call(['hook', '--stop'], { input: event(active), extra });
  // The entry, on a child (#475): the stop hook's exit 0 and exit 2 through the real binary.
  const stopChild = () => sandbox.run(['hook', '--stop'], { input: event(false) });
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  // Clean: the turn ends.
  let result: { status: number | null; stdout: string; stderr: string } = stopChild();
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // A fake secret in a new, untracked file, written by a script the tool hook never saw.
  const key = `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}`;
  sandbox.write('scripts/out.txt', `${key}\n`);
  result = stopChild();
  assert.equal(result.status, 2, 'blocked');
  assert.match(result.stderr, /^yokoten: 1 problem\(s\) in the changed files\. Fix them before you end the turn:\n- scripts\/out\.txt:1: a secret \(AWS access key id\)\. .+\. .+\.\n  docs: https:\/\/\S+#privacy\n$/);
  assert.ok(!result.stderr.includes(key), 'the secret is never printed');
  assert.equal(result.stdout, '', 'stdout stays empty for the runtime');
  // Already sent back once: the turn ends, whatever is found. No loop.
  result = await stop(true);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  // Staged and changed files count too; a lead-only file only for a worker.
  rmSync(join(sandbox.repo, 'scripts'), { recursive: true });
  sandbox.write('a.md', `mail me${at}gmail.com\n`);
  assert.match((await stop()).stderr, /a\.md:1: an email/);
  sandbox.write('a.md', 'fine\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', 'AGENTS.md');
  assert.equal((await stop()).status, 0);
  result = await stop(false, { YOKOTEN_ROLE: 'worker' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  // --json: the same Finding shape.
  result = await sandbox.call(['hook', '--stop', '--json'], { input: JSON.stringify({ cwd: sandbox.repo, stop_hook_active: false }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.deepEqual([out.blocked, out.stop, out.findings[0].id], [true, true, 'lead-only']);
  for (const k of ['what', 'why', 'fix']) assert.ok(out.findings[0][k]);
  // Not a Stop event, or not a repo: the turn ends.
  for (const input of ['not json', '', 'null', '[1]']) assert.equal((await sandbox.call(['hook', '--stop'], { input })).status, 0, input);
  const away = makeTempDir('yokoten-away-');
  assert.equal((await sandbox.call(['hook', '--stop'], { input: JSON.stringify({ cwd: away }) })).status, 0);
  // Outside a repo the guard still stops a tag push, and git's own error stays hidden:
  // an agent read it as the result of the stopped command.
  result = await sandbox.call(['hook', '--commands-only'], { cwd: away, input: JSON.stringify({ cwd: away, tool_name: 'Bash', tool_input: { command: 'git push --tags' } }) });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /fatal|not a git repository/);
  assert.match(result.stderr, /^yokoten: git push --tags pushes tags\..*`YOKOTEN_RELEASE_APPROVAL=1 claude` \(or your agent's command\)/);
  // A broken config is an internal error: the turn ends, with one line on stderr.
  sandbox.write('yokoten.json', '{ broken');
  result = await sandbox.call(['hook', '--stop'], { input: JSON.stringify({ cwd: sandbox.repo }) });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^yokoten hook --stop: skipped, [^\n]+\n$/);
  // --stop takes a known agent only, and never with --commands-only.
  assert.equal((await sandbox.call(['hook', '--stop', '--agent', 'cursor'], { input: '{}' })).status, 1);
  assert.equal((await sandbox.call(['hook', '--stop', '--commands-only'], { input: '{}' })).status, 1);
});

// Each end-of-turn event as the runtime sends it (#211): Codex's Stop (rust-v0.163.0
// schema) and Gemini CLI's AfterAgent (v0.64.0). Both send the agent back on exit 2.
test('hook --stop --agent codex|gemini: the end-of-turn event sends the agent back once (#211)', async () => {
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
    const stop = (active: boolean) => sandbox.call(['hook', '--stop', '--agent', agent], { input: JSON.stringify(event(active)) });
    assert.deepEqual(pick(await stop(false)), [0, '', ''], `${agent}: clean`);
    sandbox.write('a.md', `mail me${at}gmail.com\n`);
    const result = await stop(false);
    assert.equal(result.status, 2, `${agent}: sent back`);
    assert.match(result.stderr, /^yokoten: 1 problem\(s\) in the changed files\. Fix them before you end the turn:\n- a\.md:1: an email/);
    assert.equal(result.stdout, '', `${agent}: stdout stays empty`);
    assert.deepEqual(pick(await stop(true)), [0, '', ''], `${agent}: already sent back once`);
    sandbox.write('a.md', 'fine\n');
  }
  // The hooks init writes run the same check, from the vendored copy.
  // On a child (#475): each hook config runs from a shell, as the agent's runtime runs it.
  assert.equal((await sandbox.call(['init'])).status, 0);
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
  assert.match((await sandbox.call(['doctor'])).stdout, /note +codex-hook: no stop check in \.codex\/hooks\.json/);
});

// The release refusal names the command that starts the agent the hook ran for (#350). Copilot
// CLI sends Claude Code's shape, so that one says "or your agent's command". Muse Code passes
// the approval to no hook, so it says so instead of naming a command.
test('hook --agent: the release refusal names the agent\'s own command (#350)', async () => {
  const sandbox = makeSandbox();
  const cwd = sandbox.repo;
  const command = 'git push --tags origin';
  const shell = (tool_name: string, extra: object = {}) => ({ cwd, hook_event_name: 'PreToolUse', tool_name, tool_input: { command, ...extra } });
  const agents: Record<string, [object, RegExp]> = {
    'claude-code': [shell('Bash'), /they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 claude` \(or your agent's command\); do not look/],
    codex: [shell('Bash'), /they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 codex`; do not look/],
    gemini: [{ ...shell('run_shell_command'), hook_event_name: 'BeforeTool' }, /they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 gemini` \(if its strict environment sanitization is on, the variable is dropped: the owner releases outside Gemini CLI\); do not look/],
    antigravity: [{ toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd } }, workspacePaths: [cwd] }, /they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 agy`; do not look/],
    muse: [shell('bash', { workdir: cwd }), /Muse Code is not known to pass YOKOTEN_RELEASE_APPROVAL to its hooks: it passes them only a short list of variables\. If the owner asked for this, stop and tell them to release outside Muse Code; do not look/],
    'deepseek-harness': [shell('bash'), /they start a new session with `YOKOTEN_RELEASE_APPROVAL=1 dsh tui --patch \.dsh\/yokoten\.patch\.yml`; do not look/],
    opencode: [{ tool: 'shell', args: { command }, directory: cwd }, /OpenCode is not known to pass YOKOTEN_RELEASE_APPROVAL to its plugin/],
  };
  for (const [agent, [input, fix]] of Object.entries(agents)) {
    const result = await sandbox.call(['hook', '--agent', agent], { input: JSON.stringify(input) });
    assert.match(result.stderr, /^yokoten: git push --tags pushes tags\. Only the owner decides when to release\./, agent);
    assert.match(result.stderr, fix, agent);
    // --json carries the same fix.
    const json = JSON.parse((await sandbox.call(['hook', '--agent', agent, '--json'], { input: JSON.stringify(input) })).stdout);
    assert.ok(result.stderr.includes(`${json.finding.fix.slice(1)}.`), `${agent} --json`); // the text form capitalizes it
    // Another refusal keeps its own fix.
    const force = await sandbox.call(['hook', '--agent', agent], { input: JSON.stringify(input).replace('--tags', '--force') });
    assert.match(force.stderr, /git push --force/, `${agent}: a force push`);
    assert.doesNotMatch(force.stderr, /RELEASE_APPROVAL/, `${agent}: a force push`);
  }
});

// ---- Commands that print account details (#390) ----

test('hook: Claude Code gets a plain read rewritten through redact, with allow, and the rewrite runs (#390)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', 'Jane Example');
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  const call = (command: string, agent = 'claude-code') =>
    sandbox.call(['hook', '--commands-only', '--agent', agent], { input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command, description: 'Show' } }) });
  const result = await call('git log -1');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'allow');
  assert.equal(output.permissionDecisionReason, 'yokoten: `git log` prints author names and emails, so its output goes through yokoten redact');
  assert.equal(output.updatedInput.description, 'Show');
  assert.match(output.updatedInput.command, /^set -o pipefail # yokoten-redact\n\(\ngit log --no-ext-diff --no-textconv --no-show-signature -1\n\) 2>&1 \| \{ "[^"]+" "[^"]*yokoten\.ts" redact \|\| cat; \}$/);
  // The rewritten command runs, and prints the placeholder.
  // On a child (#475): the rewrite runs yokoten redact as its own process.
  const ran = spawnSync('bash', ['-c', output.updatedInput.command], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /Author: <owner> /);
  assert.ok(!ran.stdout.includes('Jane'));
  // Not a plain read from the table: the normal flow, no decision. A push is never rewritten.
  for (const command of ['git status', 'git push origin main', 'git fetch', 'wrangler deploy', 'cd sub && git log', 'git log -1 | head', 'env', output.updatedInput.command]) {
    assert.deepEqual(pick(await call(command)), [0, '', ''], command);
  }
  // A command the guard refuses is refused, not rewritten.
  assert.equal((await call('git push --force')).status, 2);
});

test('hook: a custom format, shortlog -sne and blame -e come back rewritten, and the name and email are hidden (#413)', async () => {
  const sandbox = makeSandbox();
  const email = `jane${at}personal-mail.dev`;
  sandbox.git('config', 'user.name', 'Jane Example');
  sandbox.git('config', 'user.email', email);
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  const call = (command: string) =>
    sandbox.call(['hook', '--commands-only', '--agent', 'claude-code'], { input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command } }) });
  const commands = ['git log --format=%an', 'git log --pretty=format:%ae', "git log --format='%an <%ae>'", 'git shortlog -sne HEAD', 'git blame -e README.md', "git for-each-ref --format='%(authorname) %(authoremail)'", 'git cat-file -p HEAD'];
  for (const command of commands) {
    const result = await call(command);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'allow', command);
    // Positive control: the same command, not rewritten, prints the name and email.
    const plain = spawnSync('bash', ['-c', command], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
    assert.ok(plain.stdout.includes('Jane') || plain.stdout.includes(email), `${command}: ${plain.stdout}`);
    const ran = spawnSync('bash', ['-c', output.updatedInput.command], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /<owner>|<email>/, command);
    assert.ok(!ran.stdout.includes('Jane') && !ran.stdout.includes(email), `${command}: ${ran.stdout}`);
  }
  // A compound or writing command gets no decision.
  for (const command of ['git log --format=%an | head', "git log --format='%an'; ls", 'git log --format=%an > out', 'git commit --amend --no-edit']) {
    assert.deepEqual(pick(await call(command)), [0, '', ''], command);
  }
});

test('hook: a quote that hides a redirect gets no allow, and the file is not written (#413)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.name', 'Jane Example');
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  const call = (command: string) =>
    sandbox.call(['hook', '--commands-only', '--agent', 'claude-code'], { input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command } }) });
  for (const command of [`git log --format="%an %ae'$x" > out.txt --invert-grep --grep='"'`, `git log "'$x" >> out.txt '"'`]) {
    assert.deepEqual(pick(await call(command)), [0, '', ''], command);
    assert.equal(existsSync(join(sandbox.repo, 'out.txt')), false, command);
  }
});

test('hook: a glob that a file name turns into an option gets no allow (#413)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('--output=leak.txt', 'x\n');
  const result = await sandbox.call(['hook', '--commands-only', '--agent', 'claude-code'], { input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command: 'git log *' } }) });
  assert.deepEqual(pick(result), [0, '', '']);
  assert.equal(existsSync(join(sandbox.repo, 'leak.txt')), false);
});

test("hook: the rewritten log runs no textconv the repo's config names (#413)", async () => {
  const sandbox = makeSandbox();
  const marker = join(sandbox.repo, 'ran-textconv');
  sandbox.write('.gitattributes', '*.txt diff=tc\n');
  sandbox.write('a.txt', 'one\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: one');
  sandbox.git('config', 'diff.tc.textconv', `touch '${marker}'; cat`);
  const result = await sandbox.call(['hook', '--commands-only', '--agent', 'claude-code'], { input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command: 'git log -p -1' } }) });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'allow');
  const ran = spawnSync('bash', ['-c', output.updatedInput.command], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /\+one/);
  assert.equal(existsSync(marker), false);
  // Positive control: the same log, not rewritten, runs the textconv.
  spawnSync('git', ['log', '-p', '-1'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.equal(existsSync(marker), true);
});

test("hook: an agent that can't rewrite runs the command, or with privacy.output stop is told the filtered one (#390)", async () => {
  const sandbox = makeSandbox();
  const codexCall = (command = 'git remote -v') => sandbox.call(['hook', '--commands-only', '--agent', 'codex'], { input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Bash', tool_input: { command } }) });
  // By default the command runs as it is.
  assert.deepEqual(pick(await codexCall()), [0, '', '']);
  sandbox.write('yokoten.json', JSON.stringify({ privacy: { output: 'stop' } }));
  const result = await codexCall();
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^yokoten: `git remote` prints remote URLs, and this agent can't filter it\./);
  assert.match(result.stderr, /Run it as `set -o pipefail # yokoten-redact\n\(\ngit remote -v\n\) 2>&1 \| \{ "[^"]+" "[^"]+" redact \|\| cat; \}`\./);
  // A push still runs: only plain reads are ever stopped.
  assert.deepEqual(pick(await codexCall('git push origin main')), [0, '', '']);
  const json = await sandbox.call(['hook', '--json'], { input: JSON.stringify({ tool_input: { command: 'npm whoami' } }) });
  assert.equal(JSON.parse(json.stdout).rewritten.startsWith('set -o pipefail # yokoten-redact\n(\nnpm whoami\n) 2>&1 | { "'), true);
});

test('redactCommand: this node and this copy of yokoten, with the home folder as $HOME (#390)', () => {
  assert.equal(redactCommand('/usr/bin/node', '/home/someone/tools/yokoten/bin/yokoten.ts', '/home/someone'), '"/usr/bin/node" "$HOME/tools/yokoten/bin/yokoten.ts" redact');
  assert.equal(redactCommand('/home/someone/.nvm/node', '/opt/yo$ten/bin/yokoten.ts', '/home/someone'), '"$HOME/.nvm/node" "/opt/yo\\$ten/bin/yokoten.ts" redact');
  assert.equal(redactCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\someone\\y\\bin\\yokoten.ts', 'C:\\Users\\someone'), '"C:/Program Files/nodejs/node.exe" "$HOME/y/bin/yokoten.ts" redact');
});

// #475: in this process, the hook reads the tool call from the invocation's stdin, never the
// test runner's. The child-process tests above keep the real entry covered.
test('hook: in-process, the tool call and the end-of-turn event come from the given stdin (#475)', async () => {
  const sandbox = makeSandbox();
  const run = (args: string[], stdin: string) => invoke(['hook', ...args], { env: sandbox.env, cwd: sandbox.repo, stdin });
  const call = (command: string) => JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const force = await run([], call('git push --force'));
  assert.equal(force.code, 2);
  assert.match(force.stderr, /^yokoten: git push --force forces the push\./);
  assert.deepEqual(await run([], call('git status')), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await run(['--json'], 'not json'), { code: 0, stdout: `${JSON.stringify({ blocked: false, toolCall: false }, null, 2)}\n`, stderr: '' });
  // The stop check: a secret in a changed file sends the agent back, once.
  const key = `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}`;
  sandbox.write('out.txt', `${key}\n`);
  const stop = (active: boolean) => run(['--stop'], JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: active }));
  const sentBack = await stop(false);
  assert.equal(sentBack.code, 2);
  assert.match(sentBack.stderr, /out\.txt:1: a secret/);
  assert.deepEqual(await stop(true), { code: 0, stdout: '', stderr: '' });
});

test('hook --stop: a worker is done only when the done-when check passes (#614)', { skip: process.platform === 'win32' && 'the done-when commands use sh syntax' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const event = (extra: object = {}) => JSON.stringify({ session_id: 'task-614', cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: false, ...extra });
  const stop = (doneWhen: string, extra: Record<string, string> = {}, input = event()) =>
    sandbox.call(['hook', '--stop'], { input, extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: doneWhen, ...extra } });
  // A passing check lets the worker stop.
  let result = await stop('true');
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
  // A failing check refuses, with the reason in short.
  result = await stop('echo fail-614 >&2; exit 1');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the done-when check failed/);
  assert.match(result.stderr, /fail-614/);
  assert.match(result.stderr, /This was try 1 of 3/);
  assert.doesNotMatch(result.stderr, /next stop is let through/);
  // stop_hook_active does not let a worker skip the check.
  result = await sandbox.call(['hook', '--stop'], {
    input: event({ stop_hook_active: true }),
    extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'echo still-fail >&2; exit 1' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /still-fail/);
  assert.match(result.stderr, /This was try 2 of 3/);
  assert.doesNotMatch(result.stderr, /next stop is let through/);
  result = await stop('echo third-fail >&2; exit 1');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /This was try 3 of 3/);
  assert.match(result.stderr, /next stop is let through/);
  assert.match(result.stderr, /NOT DONE: checks failing/);
  // The loop guard ends after the limit: the worker may stop, never as done.
  result = await stop('echo last-fail >&2; exit 1');
  assert.equal(result.status, 0);
  assert.match(result.stderr, /stopped with failing checks/);
  assert.doesNotMatch(result.stderr, /this task is done/i);
  assert.equal(existsSync(join(sandbox.repo, '.yokoten-agent.json')), false, 'the main checkout is not written');
  assert.equal(existsSync(join(sandbox.home, '.config', 'yokoten', 'done-tries', 'task-614')), false, 'the count is cleared after the give-up');
  // A resumed worker is checked again, from try 1.
  result = await stop('echo again-fail >&2; exit 1');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /This was try 1 of 3/);
  assert.doesNotMatch(result.stderr, /next stop is let through/);
  // A new session key starts the count again.
  result = await sandbox.call(['hook', '--stop'], {
    input: event({ session_id: 'task-614-b' }),
    extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'false' },
  });
  assert.equal(result.status, 2);
  // SubagentStop of a worker subagent, with no YOKOTEN_ROLE: still a worker.
  result = await sandbox.call(['hook', '--stop'], {
    input: event({ hook_event_name: 'SubagentStop', agent_type: 'worker', agent_id: 'agent-614' }),
    extra: { YOKOTEN_DONE_WHEN: 'echo sub-fail >&2; exit 1' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sub-fail/);
  // Grok's Stop: a passing check lets the worker stop; a failing one refuses.
  const grokEvent = (active = false) =>
    JSON.stringify({ cwd: sandbox.repo, reason: 'end_turn', stopHookActive: active, sessionId: 'grok-614' });
  result = await sandbox.call(['hook', '--stop', '--agent', 'grok'], { input: grokEvent(), extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'true' } });
  assert.equal(result.status, 0);
  result = await sandbox.call(['hook', '--stop', '--agent', 'grok'], { input: grokEvent(), extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'echo grok-fail >&2; exit 1' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /grok-fail/);
  // The git-folder file is the command when the env is empty; the env wins when both are set.
  writeFileSync(join(sandbox.repo, '.git', 'yokoten-done-when'), 'echo from-file >&2; exit 1\n');
  result = await sandbox.call(['hook', '--stop'], { input: event({ session_id: 'from-file' }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /from-file/);
  result = await sandbox.call(['hook', '--stop'], { input: event({ session_id: 'from-env' }), extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'true' } });
  assert.equal(result.status, 0);
  // --json: the same fields, and skipped names the loop end.
  result = await sandbox.call(['hook', '--stop', '--json'], {
    input: event({ session_id: 'json-614' }),
    extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'echo json-fail >&2; exit 1' },
  });
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.blocked, true);
  assert.equal(out.doneWhen.ok, false);
  assert.match(out.doneWhen.output, /json-fail/);
});

// A missing count used to refuse every later stop (`3 > 3` is false). Five stops refuse at most three.
test('hook --stop: a read-only home cannot trap a worker (#614)', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'no read-only folder for root or on Windows' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const fail = join(sandbox.repo, 'fail.mjs');
  writeFileSync(fail, 'process.exit(1);\n');
  chmodSync(sandbox.home, 0o555);
  try {
    const stop = (active: boolean) =>
      sandbox.call(['hook', '--stop'], {
        input: JSON.stringify({ session_id: 'ro-614', cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: active }),
        extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: `${process.execPath} ${fail}` },
      });
    const results = [];
    for (let index = 0; index < 5; index += 1) results.push(await stop(index > 0));
    const refused = results.filter((item) => item.status === 2);
    assert.ok(refused.length <= 3, `refused ${refused.length} times`);
    assert.equal(results[0]?.status, 2);
    assert.match(results[0]?.stderr ?? '', /next stop is let through/);
    assert.match(results[0]?.stderr ?? '', /NOT DONE: checks failing/);
    assert.equal(results[1]?.status, 0, results[1]?.stderr);
    assert.match(results[1]?.stderr ?? '', /stopped with failing checks/);
    assert.equal(results[4]?.status, 0);
    assert.equal(existsSync(join(sandbox.repo, '.yokoten-agent.json')), false, 'the main checkout is not written');
    assert.equal(existsSync(join(sandbox.home, '.config', 'yokoten', 'done-tries', 'ro-614')), false, 'no try count was saved');
  } finally {
    chmodSync(sandbox.home, 0o755);
  }
});

test('hook --stop: a reviewer subagent is not checked, and coworker is not a worker (#614)', async () => {
  const sandbox = makeSandbox();
  const key = `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}`;
  sandbox.write('out.txt', `${key}\n`);
  const reviewer = await sandbox.call(['hook', '--stop'], {
    input: JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'SubagentStop', agent_type: 'reviewer', agent_id: 'rev-614' }),
  });
  assert.deepEqual([reviewer.status, reviewer.stdout, reviewer.stderr], [0, '', '']);
  // The same file still sends the lead back. The reviewer skip did not drop the check.
  const lead = await sandbox.call(['hook', '--stop'], {
    input: JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: false }),
  });
  assert.equal(lead.status, 2);
  assert.match(lead.stderr, /out\.txt:1: a secret/);
  const marker = join(sandbox.repo, 'coworker-ran');
  const script = join(sandbox.repo, 'mark.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(1);\n`);
  const coworker = await sandbox.call(['hook', '--stop'], {
    input: JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'SubagentStop', agent_type: 'coworker', agent_id: 'co-614' }),
    extra: { YOKOTEN_DONE_WHEN: `${process.execPath} ${script}` },
  });
  assert.deepEqual([coworker.status, coworker.stderr], [0, '']);
  assert.equal(existsSync(marker), false, 'a non-worker subagent does not run the check');
  // A reviewer started by a worker is still not a worker. Its own type decides.
  const reviewerRan = join(sandbox.repo, 'reviewer-ran');
  const reviewerScript = join(sandbox.repo, 'reviewer-fail.mjs');
  writeFileSync(reviewerScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(reviewerRan)}, 'ran');\nprocess.exit(1);\n`);
  const asWorker = await sandbox.call(['hook', '--stop'], {
    input: JSON.stringify({ cwd: sandbox.repo, hook_event_name: 'SubagentStop', agent_type: 'reviewer', agent_id: 'rev-role-614', stop_hook_active: false }),
    extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: `${process.execPath} ${reviewerScript}` },
  });
  assert.equal(asWorker.status, 0, asWorker.stderr);
  assert.equal(asWorker.stderr, '');
  assert.equal(existsSync(reviewerRan), false, 'the done-when command did not run');
  assert.equal(existsSync(join(sandbox.home, '.config', 'yokoten', 'done-tries', 'rev-role-614')), false, 'no try was used');
});

// The count cannot be saved, and the runtime never sets stop_hook_active. One refusal, then the same worker may stop.
test('hook --stop: a read-only home lets the same worker through for 5 minutes (#614)', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'no read-only folder for root or on Windows' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const fail = join(sandbox.repo, 'fail.mjs');
  writeFileSync(fail, 'process.exit(1);\n');
  const marker = (id: string) => join(sandbox.repo, '.git', 'yokoten-stop-refused', id);
  chmodSync(sandbox.home, 0o555);
  try {
    const stop = (id: string) =>
      sandbox.call(['hook', '--stop'], {
        input: JSON.stringify({ session_id: id, cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: false }),
        extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: `${process.execPath} ${fail}` },
      });
    const first = await stop('mark-a');
    assert.equal(first.status, 2, first.stderr);
    assert.match(first.stderr, /next stop is let through/);
    assert.equal(existsSync(marker('mark-a')), true, 'the refusal is remembered in the git folder');
    const second = await stop('mark-a');
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /stopped with failing checks/);
    const other = await stop('mark-b');
    assert.equal(other.status, 2, other.stderr);
    assert.match(other.stderr, /This was try 1 of 3/);
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    writeFileSync(marker('mark-a'), `${stale}\n`);
    const again = await stop('mark-a');
    assert.equal(again.status, 2, again.stderr);
    const later = await stop('mark-a');
    assert.equal(later.status, 0, later.stderr);
    assert.equal(existsSync(join(sandbox.home, '.config', 'yokoten', 'done-tries')), false, 'no try count was saved');
    assert.equal(existsSync(join(sandbox.repo, '.yokoten-agent.json')), false, 'the main checkout is not written');
  } finally {
    chmodSync(sandbox.home, 0o755);
  }
});

test('hook --stop: a linked worktree records failing, then passing, and a link is left unchanged (#614)', { skip: process.platform === 'win32' && 'the done-when commands use sh syntax' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'checks-614', tree);
  const statusPath = join(tree, '.yokoten-agent.json');
  writeFileSync(statusPath, `${JSON.stringify({ name: 'worker-1', role: 'engineer' })}\n`);
  const stop = (id: string, doneWhen: string) =>
    sandbox.call(['hook', '--stop'], {
      cwd: tree,
      input: JSON.stringify({ session_id: id, cwd: tree, hook_event_name: 'Stop', stop_hook_active: false }),
      extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: doneWhen },
    });
  for (let tryNumber = 1; tryNumber <= 3; tryNumber += 1) {
    const refused = await stop('checks-614', 'exit 1');
    assert.equal(refused.status, 2, refused.stderr);
  }
  let result = await stop('checks-614', 'exit 1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /stopped with failing checks/);
  let status = JSON.parse(readFileSync(statusPath, 'utf8')) as { name: string; role: string; checks: string; updated: string };
  assert.equal(status.name, 'worker-1');
  assert.equal(status.role, 'engineer');
  assert.equal(status.checks, 'failing');
  assert.match(status.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(lstatSync(statusPath).isFile(), true);
  assert.equal(existsSync(join(sandbox.repo, '.yokoten-agent.json')), false, 'the main checkout is not written');
  result = await stop('checks-614', 'true');
  assert.equal(result.status, 0, result.stderr);
  status = JSON.parse(readFileSync(statusPath, 'utf8')) as { name: string; role: string; checks: string; updated: string };
  assert.equal(status.checks, 'passing');
  assert.equal(status.name, 'worker-1');
  assert.equal(status.role, 'engineer');
  assert.match(status.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  rmSync(statusPath);
  const outside = join(sandbox.home, 'outside.json');
  const outsideText = `${JSON.stringify({ keep: true })}\n`;
  writeFileSync(outside, outsideText);
  symlinkSync(outside, statusPath);
  result = await stop('checks-link', 'true');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /is not a regular file, so it was left unchanged/);
  assert.equal(readFileSync(outside, 'utf8'), outsideText);
  assert.equal(readlinkSync(statusPath), outside);
  rmSync(statusPath);
  const notes = join(sandbox.home, 'notes.txt');
  writeFileSync(notes, 'keep notes\n');
  symlinkSync(notes, statusPath);
  result = await stop('checks-notes', 'true');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(notes, 'utf8'), 'keep notes\n');
  assert.equal(lstatSync(statusPath).isSymbolicLink(), true);
});

// cwd `sub` is a link to another worktree. The status file there must stay as it was.
test('hook --stop: a link to another worktree does not change that worktree status file (#614)', { skip: process.platform === 'win32' && 'symlinks need extra rights on Windows' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  const other = join(makeTempDir('yokoten-other-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'checks-link-a', tree);
  sandbox.git('worktree', 'add', '-q', '-b', 'checks-link-b', other);
  const otherStatus = join(other, '.yokoten-agent.json');
  const otherText = `${JSON.stringify({ checks: 'keep', name: 'other' })}\n`;
  writeFileSync(otherStatus, otherText);
  const sub = join(tree, 'sub');
  symlinkSync(other, sub);
  const result = await sandbox.call(['hook', '--stop'], {
    cwd: sub,
    input: JSON.stringify({ session_id: 'link-out-614', cwd: sub, hook_event_name: 'Stop', stop_hook_active: false }),
    extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: `${process.execPath} -e "process.exit(0)"` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(otherStatus, 'utf8'), otherText);
  assert.equal(lstatSync(otherStatus).isFile(), true);
});

test('hook --stop: a subagent runs the done-when command only in the worktree the event names (#614)', { skip: process.platform === 'win32' && 'a node path with a space needs shell quoting' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  const record = join(sandbox.repo, 'record.mjs');
  writeFileSync(record, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], process.cwd());\n`);
  const leadMarker = join(sandbox.repo, 'lead-ran');
  const treeMarker = join(tree, 'tree-ran');
  const command = (marker: string) => `${process.execPath} ${record} ${marker}\n`;
  writeFileSync(join(sandbox.repo, '.git', 'yokoten-done-when'), command(leadMarker));
  const gitdir = /^gitdir:[ \t]*(.+)$/m.exec(readFileSync(join(tree, '.git'), 'utf8'));
  assert.ok(gitdir);
  writeFileSync(join(resolve(tree, gitdir[1].trim()), 'yokoten-done-when'), command(treeMarker));
  const stop = (cwd: string) =>
    sandbox.call(['hook', '--stop'], {
      cwd,
      input: JSON.stringify({ cwd, hook_event_name: 'SubagentStop', agent_type: 'worker', agent_id: `wt-${cwd.length}`, stop_hook_active: false }),
    });
  let result = await stop(tree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(leadMarker), false, 'the lead command did not run');
  assert.equal(realpathSync(readFileSync(treeMarker, 'utf8')), realpathSync(tree), 'the command ran in the worktree');
  rmSync(treeMarker);
  result = await stop(sandbox.repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(treeMarker), false, 'the worktree command did not run');
  assert.equal(realpathSync(readFileSync(leadMarker, 'utf8')), realpathSync(sandbox.repo), 'the command ran in the event folder');
  rmSync(leadMarker);
  const nested = join(sandbox.repo, 'src');
  mkdirSync(nested);
  result = await stop(nested);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(readFileSync(leadMarker, 'utf8')), realpathSync(nested), 'a subagent in the lead folder runs in the event folder');
});

// #555: Muse Code passes its hooks no YOKOTEN_ROLE. A worktree the lead marks makes every
// agent in it a worker, whatever env reaches the hook; the lead's main checkout is not affected.
// Every call here is Muse-shaped, piped to `hook --agent muse`, with YOKOTEN_ROLE unset.
test('worker mark: a marked worktree is a worker for every agent; the plain ways to drop the mark are refused (#555)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  // A Muse call: no YOKOTEN_ROLE, the hook's cwd at the workspace root.
  const muse = (toolInput: Record<string, string>, folder = tree, extra?: Record<string, string>) => {
    const name = 'command' in toolInput ? 'bash' : 'write_file';
    return sandbox.call(['hook', '--agent', 'muse'], { cwd: folder, input: JSON.stringify({ cwd: folder, hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput }), extra });
  };
  const refused = async (command: string, id: RegExp, folder = tree) => {
    const result = await muse({ command }, folder);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, id, command);
    return result;
  };
  // Before the mark, a Muse worker looks like the lead: the gap #555 closes.
  assert.equal((await muse({ path: join(tree, 'AGENTS.md') })).status, 0);
  // The main checkout is the lead's: it is never marked.
  let result = await sandbox.call(['worker', 'mark', sandbox.repo]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /main checkout/);
  assert.equal((await sandbox.call(['worker', 'mark'])).status, 1, 'no folder is a usage error');
  // A subfolder marks its worktree, and names the worktree's top folder.
  mkdirSync(join(tree, 'src'));
  result = await sandbox.call(['worker', 'mark', join(tree, 'src')]);
  assert.equal(result.status, 0, result.stderr);
  const top = realpathSync(tree);
  assert.ok(result.stdout.includes(`marked the worktree at ${top}.`), result.stdout);
  assert.ok(result.stdout.includes(`\`git worktree remove ${top}\``), result.stdout);
  // Positive controls: with the mark and no env, a lead-only edit and a push are refused.
  result = await muse({ path: join(tree, 'AGENTS.md') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  result = await refused('git push -u origin task', /worker does not push/);
  // The refusal says the role came from the mark, and where the lead works (L4).
  assert.match(result.stderr, /carries the worker mark/);
  assert.ok(result.stderr.includes(`the lead works in the main checkout, ${realpathSync(sandbox.repo)}`), result.stderr);
  // A call that names another folder (Muse's workdir) is still the worker's: the hook runs in the worktree.
  result = await sandbox.call(['hook', '--agent', 'muse'], { cwd: tree, input: JSON.stringify({ cwd: tree, tool_name: 'bash', tool_input: { command: 'git push', workdir: sandbox.repo } }) });
  assert.equal(result.status, 2);
  // The mark only adds the role: a session that says it is the lead is still a worker.
  assert.equal((await muse({ path: join(tree, 'AGENTS.md') }, tree, { YOKOTEN_ROLE: 'lead' })).status, 2);
  // Claude Code, in a subfolder of the worktree, is a worker too.
  result = await sandbox.call(['hook'], { cwd: tree, input: JSON.stringify({ cwd: join(tree, 'src'), tool_name: 'Edit', tool_input: { file_path: join(tree, 'AGENTS.md') } }) });
  assert.equal(result.status, 2);
  // What a worker sends: the lead pushes and posts after review (M2).
  for (const command of [
    'yokoten bot -- gh pr create --fill',
    'yokoten bot -- git push',
    'git -c alias.p=push p',
    'git config alias.p push',
    'git send-pack origin HEAD:main',
    'git subtree push --prefix=docs origin pages',
    'gh pr create --fill',
    'gh pr merge 1 --squash',
    'gh api -X PUT repos/a/b/pulls/1/merge',
    'gh api repos/a/b/issues -f title=x',
  ]) {
    result = await refused(command, /worker-push|worker does not push|pushes|host|alias|bot/);
    assert.match(result.stderr, /commit in your worktree and report; the lead pushes after review/i, command);
  }
  // The reviewer's ways to drop the mark (H1, L2).
  const gitDir = runChild('git', ['rev-parse', '--absolute-git-dir'], { cwd: tree }).stdout.trim();
  const mark = join(gitDir, 'yokoten-worker');
  assert.ok(existsSync(mark));
  for (const command of [
    'rm "$(sed "s/gitdir: //" .gi?)"/yokoten-w*',
    `rm ${mark}`,
    'rm -rf "$(git rev-parse --absolute-git-dir)"',
    `rm -rf ${join(sandbox.repo, '.git', 'worktrees')}`,
    'chmod 000 .gi?',
    'mv .gi? x',
    'mkfifo .git',
    'echo "gitdir: ../repo/.git" > .git',
    'GIT_DIR=../repo/.git git status',
    `git worktree remove --force ${tree}`,
    'git worktree prune',
    'git -C ../repo worktree move wt wt2',
  ]) await refused(command, /worker mark/);
  for (const path of [mark, join(tree, '.git'), join(sandbox.repo, '.git', 'config')]) {
    result = await muse({ path });
    assert.equal(result.status, 2, path);
    assert.match(result.stderr, /worker mark/, path);
  }
  assert.ok(existsSync(mark), 'the mark is still there');
  // Work goes on: code edits, commits, and reads that name .git or GIT_DIR pass (L2).
  assert.equal((await muse({ path: join(tree, 'src', 'a.ts') })).status, 0);
  for (const command of [
    'git commit -qm "fix: a"',
    'git status && cat .gitignore',
    'git worktree list',
    'grep -rn foo --exclude-dir=.git .',
    'find . -path ./.git -prune -o -print',
    'grep -rn GIT_DIR src',
    'tree -I .git',
    'gh pr view 1',
  ]) assert.equal((await muse({ command })).status, 0, command);
  // Fails closed (H1): a .git the guard can't read makes the session a worker, and is never
  // read when it is a FIFO. Modes need a user they stop: not root.
  const dotGit = join(tree, '.git');
  const link = readFileSync(dotGit, 'utf8');
  rmSync(mark);
  // The mark has two parts since #566 (the file and the worker list): `unmark` drops both.
  result = await sandbox.call(['worker', 'unmark', tree]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await muse({ command: 'git push' })).status, 0, 'negative control: unmarked, the push passes');
  if (process.getuid?.() !== 0) {
    chmodSync(dotGit, 0o000);
    result = await refused('git push', /worker does not push/);
    assert.match(result.stderr, /can't be read/);
    chmodSync(dotGit, 0o644);
  }
  rmSync(dotGit);
  runChild('mkfifo', [dotGit]);
  const started = Date.now();
  await refused('git push', /worker does not push/);
  assert.ok(Date.now() - started < 5000, 'a FIFO named .git does not block the guard');
  rmSync(dotGit);
  writeFileSync(dotGit, 'gitdir: ../gone\n');
  await refused('git push', /worker does not push/);
  writeFileSync(dotGit, link);
  assert.equal((await muse({ command: 'git push' })).status, 0, 'readable again and unmarked: the lead');
  writeFileSync(mark, 'x\n');
  // The lead in the main checkout, with no mark, is not affected.
  const lead = (toolInput: Record<string, string>) => muse(toolInput, sandbox.repo);
  assert.equal((await lead({ path: join(sandbox.repo, 'AGENTS.md') })).status, 0);
  for (const command of ['git push -u origin task', `git worktree remove ${tree}`, 'gh api -X PUT repos/a/b/pulls/1/merge', 'chmod 000 .gi?']) {
    assert.equal((await lead({ command })).status, 0, command);
  }
  // An alias is refused for the lead too: the guard never reads a hidden command as safe (#560).
  result = await lead({ command: 'git -c alias.p=push p' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /run the full command instead/i);
  // The way back: removing the worktree removes the mark.
  sandbox.git('worktree', 'remove', '--force', tree);
  assert.ok(!existsSync(mark));
});

// #555: the stop check, the commit check and the session start ask the same role question.
test('worker mark: the stop check, the commit check and the session start see a marked worker (#555)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  writeFileSync(join(tree, 'AGENTS.md'), '# changed\n');
  runChild('git', ['add', 'AGENTS.md'], { cwd: tree });
  const stop = () => sandbox.call(['hook', '--stop', '--agent', 'muse'], { cwd: tree, input: JSON.stringify({ cwd: tree, stop_hook_active: false }) });
  const commit = () => sandbox.call(['check', '--staged'], { cwd: tree });
  const start = () => sandbox.call(['doctor', '--session', '--agent', 'muse'], { cwd: tree });
  // Negative controls: unmarked, the session is the lead's.
  assert.equal((await stop()).status, 0);
  assert.doesNotMatch((await commit()).stderr, /lead-only/);
  assert.doesNotMatch((await start()).stdout, /this session is a worker/);
  assert.equal((await sandbox.call(['worker', 'mark', tree])).status, 0);
  let result = await stop();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  result = await commit();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md is lead-only/);
  assert.match((await start()).stdout, /this session is a worker, because its worktree or clone carries the worker mark/);
  // The main checkout stays the lead's.
  sandbox.write('AGENTS.md', '# lead\n');
  sandbox.git('add', 'AGENTS.md');
  assert.doesNotMatch((await sandbox.call(['check', '--staged'])).stderr, /lead-only/);
  assert.doesNotMatch((await sandbox.call(['doctor', '--session', '--agent', 'muse'])).stdout, /this session is a worker/);
});

// #555 (L3): `worker mark` says plainly what it can't do.
// #672 (review): a clone is marked only by the lead, from the lead's own checkout, and
// always in the clone's own `.git`, whatever GIT_DIR the caller has.
test("worker mark: a clone is marked only by the lead, from its own checkout, in the clone's own .git (#672)", async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const desk = join(makeTempDir('yokoten-desk-'), 'desk');
  runChild('git', ['clone', '-q', sandbox.repo, desk], { env: sandbox.env });
  const leadMark = join(sandbox.repo, '.git', 'yokoten-worker');
  const deskMark = join(desk, '.git', 'yokoten-worker');
  // The lead's checkout, from a folder outside every checkout: refused, nothing written.
  const elsewhere = makeTempDir('yokoten-elsewhere-');
  let result = await sandbox.call(['worker', 'mark', sandbox.repo], { cwd: elsewhere });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /from your own checkout, the lead's/);
  assert.ok(!existsSync(leadMark));
  // A worker may not mark: by YOKOTEN_ROLE.
  result = await sandbox.call(['worker', 'mark', desk], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only the lead marks a worktree or a clone: this session is a worker/);
  assert.ok(!existsSync(deskMark));
  // GIT_DIR and GIT_WORK_TREE that name the lead's checkout don't move the mark there.
  result = await sandbox.call(['worker', 'mark', desk], { extra: { GIT_DIR: join(sandbox.repo, '.git'), GIT_WORK_TREE: sandbox.repo, GIT_COMMON_DIR: join(sandbox.repo, '.git') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /marked the clone at /);
  assert.ok(existsSync(deskMark), "the mark is in the clone's own .git");
  assert.ok(!existsSync(leadMark), "the lead's .git has no mark");
  // In the marked clone every session is a worker: mark and unmark say to run them from outside.
  for (const action of ['mark', 'unmark']) {
    result = await sandbox.call(['worker', action, desk], { cwd: desk });
    assert.equal(result.status, 1, action);
    assert.match(result.stderr, /this session is a worker\. .*The lead runs this from its own checkout, outside the marked one\./, action);
  }
  // Negative control: the lead, from its own checkout, unmarks with GIT_DIR set too.
  result = await sandbox.call(['worker', 'unmark', desk], { extra: { GIT_DIR: join(sandbox.repo, '.git') } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(deskMark));
});

test('worker mark: a missing folder, a submodule and an unwritable git folder each get one plain line (#555)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('a.md', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  let result = await sandbox.call(['worker', 'mark', join(sandbox.repo, 'nowhere')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a folder\. Make the worktree first: `git worktree add/);
  // A submodule's checkout is not the main checkout, and not a worktree.
  const other = makeSandbox();
  other.write('b.md', 'b\n');
  other.git('add', '.');
  other.git('commit', '-qm', 'other');
  sandbox.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', other.repo, 'sub');
  result = await sandbox.call(['worker', 'mark', join(sandbox.repo, 'sub')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is a submodule's checkout, not a worktree/);
  assert.doesNotMatch(result.stderr, /main checkout/);
  // A git folder the lead can't write: one line, no stack trace. Modes need a user they stop.
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  const gitDir = runChild('git', ['rev-parse', '--absolute-git-dir'], { cwd: tree }).stdout.trim();
  chmodSync(gitDir, 0o555);
  try {
    result = await sandbox.call(['worker', 'mark', tree]);
  } finally {
    chmodSync(gitDir, 0o755);
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten worker: can't write the mark in .*\(EACCES\)/);
  assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
});

// #566: `worker mark` keeps the role on the worker list when `.git` is moved away;
// `worker unmark` clears it, and only the lead runs it.
test('worker list: mark keeps the role with .git moved away; unmark clears it (#566)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  // A Muse call: no YOKOTEN_ROLE, the hook's cwd at the workspace root.
  const muse = (toolInput: Record<string, string>, folder = tree, extra?: Record<string, string>) => {
    const name = 'command' in toolInput ? 'bash' : 'write_file';
    return sandbox.call(['hook', '--agent', 'muse'], { cwd: folder, input: JSON.stringify({ cwd: folder, hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput }), extra });
  };
  // `mark` writes the worktree's path outside the worktree, under yokoten's config folder.
  let result = await sandbox.call(['worker', 'mark', tree]);
  assert.equal(result.status, 0, result.stderr);
  const top = realpathSync(tree);
  const workers = readFileSync(join(sandbox.home, '.config', 'yokoten', 'workers'), 'utf8');
  assert.ok(workers.includes(top), workers);
  assert.match(result.stdout, /`yokoten worker unmark/);
  // Positive control: with `.git` moved away, the session is still a worker.
  renameSync(join(tree, '.git'), join(tree, 'dot-git-moved'));
  result = await muse({ command: 'git push' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /worker does not push/);
  assert.match(result.stderr, /worker list/);
  // `unmark` is the lead's: a worker's session is refused.
  result = await sandbox.call(['worker', 'unmark', tree], { extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only the lead/);
  // With `.git` moved away, `unmark` still clears the list entry by path.
  result = await sandbox.call(['worker', 'unmark', tree]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unmarked/);
  assert.ok(!readFileSync(join(sandbox.home, '.config', 'yokoten', 'workers'), 'utf8').includes(top));
  // Back to a plain worktree: restore `.git`, unmark again to drop the mark file too.
  renameSync(join(tree, 'dot-git-moved'), join(tree, '.git'));
  result = await sandbox.call(['worker', 'unmark', tree]);
  assert.equal(result.status, 0, result.stderr);
  // Negative control: unmarked, the session is the lead's again.
  assert.equal((await muse({ path: join(tree, 'AGENTS.md') })).status, 0);
  assert.equal((await muse({ command: 'git push' })).status, 0);
});

// #566: `worker unmark` is the lead's: from a marked tree with no YOKOTEN_ROLE (a Muse
// session), even `cd /tmp && yokoten worker unmark <tree>` is refused, since the role
// comes from the session's folders, never from the command text.
test('worker list: a marked worker cannot unmark its own worktree, even after cd-ing away (#566)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  sandbox.write('AGENTS.md', '# rules\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(makeTempDir('yokoten-tree-'), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'task', tree);
  const top = realpathSync(tree);
  assert.equal((await sandbox.call(['worker', 'mark', tree])).status, 0);
  // A Muse call: no YOKOTEN_ROLE, the hook's cwd in the marked tree.
  const muse = (command: string, folder = tree) =>
    sandbox.call(['hook', '--agent', 'muse'], { cwd: folder, input: JSON.stringify({ cwd: folder, hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command } }) });
  // Positive controls: the plain unmark, and one that cds away first.
  for (const command of [`yokoten worker unmark ${top}`, `cd /tmp && yokoten worker unmark ${top}`]) {
    const result = await muse(command);
    assert.equal(result.status, 2, command);
    assert.match(result.stderr, /only the lead unmarks a worktree/, command);
  }
  // Negative control: the lead, in an unmarked checkout with no worker role, passes.
  assert.equal((await muse(`yokoten worker unmark ${top}`, sandbox.repo)).status, 0);
  // The mark is still there: nothing was cleared.
  const gitDir = runChild('git', ['rev-parse', '--absolute-git-dir'], { cwd: tree }).stdout.trim();
  assert.ok(existsSync(join(gitDir, 'yokoten-worker')));
  sandbox.git('worktree', 'remove', '--force', tree);
});

// `worker env` lists the names an agent would get, and counts the rest; it never prints a
// value (#613). The values are fake; each token is joined from parts.
test('worker env: it names what an agent gets and counts what is dropped, and prints no value (#613)', async () => {
  const cwd = makeTempDir('yokoten-worker-env-');
  const token = `${'gh'}p_${'a1B2c3D4e5F6g7H8'.repeat(3)}`;
  const key = `${'sk'}-ant-api03-${'a1B2c3D4e5F6g7H8'.repeat(4)}`;
  const url = `postgres://fakeuser:${'fake'}pass${'@'}db.example.invalid/app`;
  const env = { PATH: '/usr/bin', HOME: cwd, GH_TOKEN: token, ANTHROPIC_API_KEY: key, LC_FAKE: url, EDITOR: 'vi' };
  const plain = await invoke(['worker', 'env'], { env, cwd });
  assert.equal(plain.code, 0, plain.stderr);
  for (const value of [token, key, url]) assert.ok(!(plain.stdout + plain.stderr).includes(value), 'worker env printed a value');
  assert.match(plain.stdout, /would get 2 names from this shell/);
  assert.match(plain.stdout, /HOME, PATH/);
  assert.match(plain.stdout, /Dropped: 2 with a secret-looking name, 1 with a value shaped like a key or token, 0 too long to check, 1 not on the list/);
  const claude = await invoke(['worker', 'env', 'claude-code'], { env, cwd });
  for (const value of [token, key, url]) assert.ok(!(claude.stdout + claude.stderr).includes(value), 'worker env claude-code printed a value');
  assert.match(claude.stdout, /ANTHROPIC_API_KEY, HOME, PATH/);
  const unknown = await invoke(['worker', 'env', 'nope'], { env, cwd });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown runtime "nope"/);
});

// `desk` starts a worker's agent in a fenced desk (#637). The fence itself is tested in
// test/agents/desk/; here, what the command refuses before it starts anything.
test('desk: names what is missing, refuses a worker, and refuses a folder that is no clone (#637)', async () => {
  const cwd = makeTempDir('yokoten-desk-');
  const env = { PATH: process.env.PATH ?? '', HOME: cwd };
  const missing = await invoke(['desk', 'claude-code', cwd], { env, cwd });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /name the agent, the folder and the command/);
  const worker = await invoke(['desk', 'claude-code', cwd, '--', 'node'], { env: { ...env, YOKOTEN_ROLE: 'worker' }, cwd });
  assert.equal(worker.code, 1);
  assert.match(worker.stderr, /only the lead starts a desk/);
  const help = await invoke(['desk', 'claude-code', cwd, '--', 'agent', '--help'], { env, cwd });
  assert.doesNotMatch(help.stdout, /^Usage: yokoten desk/, "--help after -- is the agent's");
  const plain = await invoke(['desk', 'claude-code', cwd, '--', 'node'], { env, cwd });
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /not a git clone|not built yet|not installed|can't make a sandbox|sandbox-exec/);
});

/** The named fields of a status file, for a short compare. */
const fieldsOf = (status: Record<string, string>, names: string[]) => Object.fromEntries(names.map((name) => [name, status[name]]));

/** A repo that uses yokoten, with one commit and a linked worktree for a worker (#685). */
function makeBoardRepo() {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', '{}\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const tree = join(realpathSync(makeTempDir('yokoten-tree-')), 'wt');
  sandbox.git('worktree', 'add', '-q', '-b', 'board-685', tree);
  const status = (folder: string) => (existsSync(join(folder, '.yokoten-agent.json')) ? (JSON.parse(readFileSync(join(folder, '.yokoten-agent.json'), 'utf8')) as Record<string, string>) : null);
  // The throttle skips a write within a few seconds; a test moves the file's time back.
  const age = (folder: string) => {
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(folder, '.yokoten-agent.json'), past, past);
  };
  return { sandbox, tree, status, age };
}

/** One shell call in each runtime's own shape. */
const SHELL_CALLS: Record<string, (cwd: string, command: string) => unknown> = {
  'claude-code': (cwd, command) => ({ cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
  grok: (cwd, command) => ({ cwd, hookEventName: 'PreToolUse', toolName: 'run_terminal_command', toolInput: { command } }),
  muse: (cwd, command) => ({ cwd, hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command } }),
  'deepseek-harness': (cwd, command) => ({ cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
};

// #685: the hooks keep a worker's status file by themselves, for every vendor: the session
// start, an allowed call (throttled), a refusal, and the stop. Fields the agent wrote stay.
test('hook: the session start, a call, a refusal and the stop keep the status file, for each vendor (#685)', { skip: process.platform === 'win32' && 'the done-when command uses sh syntax' }, async () => {
  for (const agent of ['claude-code', 'grok', 'muse', 'deepseek-harness']) {
    const { sandbox, tree, status, age } = makeBoardRepo();
    const worker = { YOKOTEN_ROLE: 'worker', YOKOTEN_MODEL: 'model-a' };
    const call = (command: string) => sandbox.call(['hook', '--agent', agent], { cwd: tree, input: JSON.stringify(SHELL_CALLS[agent](tree, command)), extra: worker });
    // Grok has no session-start hook: its first call writes the start fields.
    if (agent !== 'grok') {
      assert.equal((await sandbox.call(['doctor', '--session', '--agent', agent], { cwd: tree, extra: worker })).status, 0);
      assert.deepEqual(fieldsOf(status(tree) ?? {}, ['vendor', 'model', 'role', 'state', 'worktree', 'doing']), { vendor: agent, model: 'model-a', role: 'engineer', state: 'working', worktree: tree, doing: 'started' }, `${agent}: the session start`);
      writeFileSync(join(tree, '.yokoten-agent.json'), JSON.stringify({ ...status(tree), task: 'issue 685 the board', question: 'which port?' }));
      age(tree);
    }
    assert.equal((await call('npm test')).status, 0);
    const called = status(tree) ?? {};
    assert.equal(called.doing, 'running npm test', `${agent}: an allowed call says what it does`);
    assert.equal(called.vendor, agent);
    assert.equal(called.role, 'engineer');
    assert.match(called.updated ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    if (agent !== 'grok') assert.deepEqual([called.task, called.question], ['issue 685 the board', 'which port?'], `${agent}: the agent's own fields stay`);
    assert.equal((await call('npm run lint')).status, 0);
    assert.equal(status(tree)?.doing, 'running npm test', `${agent}: a second call within seconds is not written`);
    const refused = await call('git push origin board-685');
    assert.notEqual(refused.status, 0, `${agent}: a worker's push is refused`);
    assert.match(status(tree)?.blocked ?? '', /^the guard stopped this: /, `${agent}: a refusal sets blocked`);
    age(tree);
    assert.equal((await call('npm test')).status, 0);
    assert.equal(status(tree)?.blocked, undefined, `${agent}: the next allowed call clears blocked`);
    if (agent === 'deepseek-harness') continue;
    const stop = await sandbox.call(['hook', '--stop', '--agent', agent], { cwd: tree, input: JSON.stringify({ cwd: tree, session_id: `s-${agent}`, hook_event_name: 'Stop', stop_hook_active: false }), extra: { ...worker, YOKOTEN_DONE_WHEN: 'true' } });
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(fieldsOf(status(tree) ?? {}, ['state', 'checks']), { state: 'done', checks: 'passing' }, `${agent}: the stop`);
    // The file is git-ignored by the repo's own exclude list, so a worker never commits it.
    assert.equal(sandbox.git('-C', tree, 'status', '--porcelain').stdout, '', `${agent}: git status stays clean`);
    assert.match(readFileSync(join(sandbox.repo, '.git', 'info', 'exclude'), 'utf8'), /^\.yokoten-agent\.json$/m);
  }
});

// #685: the main checkout's file is the lead's. The lead's session start and calls write
// it, with role lead, and its stop says it waits for the owner. A worker there never
// writes it. A repo without yokoten.json never gets the file.
test('hook: the lead keeps the main checkout\'s file; a worker and a repo without yokoten do not (#685)', async () => {
  const { sandbox, status } = makeBoardRepo();
  const lead = { YOKOTEN_ROLE: '' };
  assert.equal((await sandbox.call(['hook'], { input: JSON.stringify(SHELL_CALLS['claude-code'](sandbox.repo, 'npm test')), extra: { YOKOTEN_ROLE: 'worker' } })).status, 0);
  assert.equal(status(sandbox.repo), null, 'a worker leaves the main checkout alone');
  assert.equal((await sandbox.call(['doctor', '--session'], { extra: lead })).status, 0);
  assert.deepEqual(fieldsOf(status(sandbox.repo) ?? {}, ['vendor', 'role', 'state']), { vendor: 'claude-code', role: 'lead', state: 'working' });
  const stop = await sandbox.call(['hook', '--stop'], { input: JSON.stringify({ cwd: sandbox.repo, session_id: 'lead-685', hook_event_name: 'Stop', stop_hook_active: false }), extra: lead });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(status(sandbox.repo)?.state, 'waiting', 'a lead whose turn ended waits for the owner');
  assert.equal(sandbox.git('status', '--porcelain').stdout, '', 'git status stays clean');
  const plain = makeSandbox();
  assert.equal((await plain.call(['doctor', '--session'], { extra: lead })).status, 0);
  assert.equal((await plain.call(['hook'], { input: JSON.stringify(SHELL_CALLS['claude-code'](plain.repo, 'npm test')), extra: lead })).status, 0);
  assert.equal(existsSync(join(plain.repo, '.yokoten-agent.json')), false, 'no yokoten.json, no file');
});

// #700: a lead session records its log path in the repo's git folder. A worker never does.
// A later lead session replaces the path. The file is one line and readable only by this user.
test('session start: a lead registers its log path; a worker does not (#700)', async () => {
  const { sandbox, tree } = makeBoardRepo();
  const file = join(sandbox.repo, '.git', 'yokoten-lead-session');
  const start = (cwd: string, transcriptPath: string, extra: Record<string, string> = {}) =>
    sandbox.call(['doctor', '--session'], {
      cwd,
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'lead-700', source: 'startup', transcript_path: transcriptPath }),
      extra: { CLAUDE_PROJECT_DIR: cwd, ...extra },
    });
  assert.equal((await sandbox.call(['doctor', '--session'])).status, 0);
  assert.equal(existsSync(file), false, 'no transcript path, no registration');
  const workerLog = join(sandbox.home, '.claude', 'projects', 'worker', 'w.jsonl');
  assert.equal((await start(sandbox.repo, workerLog, { YOKOTEN_ROLE: 'worker' })).status, 0);
  assert.equal((await start(tree, workerLog, { YOKOTEN_ROLE: 'worker' })).status, 0);
  assert.equal(existsSync(file), false, 'a worker does not register');
  const live = join(sandbox.home, '.claude', 'projects', 'parent', 'live.jsonl');
  assert.equal((await start(sandbox.repo, live)).status, 0);
  assert.equal(readFileSync(file, 'utf8'), `${live}\n`);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  const next = join(sandbox.home, '.claude', 'projects', 'parent', 'next.jsonl');
  assert.equal((await start(sandbox.repo, next)).status, 0);
  assert.equal(readFileSync(file, 'utf8'), `${next}\n`, 'a new lead session overwrites it');
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal((await start(sandbox.repo, workerLog, { YOKOTEN_ROLE: 'worker' })).status, 0);
  assert.equal(readFileSync(file, 'utf8'), `${next}\n`, 'a worker leaves the lead path in place');
  assert.equal(sandbox.git('status', '--porcelain').stdout, '', 'the path stays in the git folder');
});

// #621: a stop writes one line to the stop log on this computer, with the command masked.
test('hook: a stop writes a masked line to the stop log (#621)', async () => {
  const sandbox = makeSandbox();
  const log = join(sandbox.home, '.config', 'yokoten', 'stops.jsonl');
  // A fake token, built from pieces so this file passes the repo's own privacy check.
  const token = ['gh', 'p_', 'a'.repeat(36)].join('');
  const command = `GH_TOKEN=${token} git push --tags`;
  const result = await sandbox.call(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command } }) });
  assert.equal(result.status, 2);
  const text = readFileSync(log, 'utf8');
  assert.ok(!text.includes(token), 'the token is not in the log');
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.vendor, 'claude-code');
  assert.equal(line.role, 'lead');
  assert.ok(line.rule);
  assert.equal(line.answer, 'refused');
  assert.match(line.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(line.command, /<secret>/);
  assert.ok(!line.command.includes(token), 'the command holds no secret');
  // An edit writes no path and no file text.
  sandbox.write('yokoten.json', '{}\n');
  sandbox.write('AGENTS.md', '# the private file text\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const edit = await sandbox.call(['hook'], {
    input: JSON.stringify({ cwd: sandbox.repo, tool_name: 'Edit', tool_input: { file_path: join(sandbox.repo, 'AGENTS.md') } }),
    extra: { YOKOTEN_ROLE: 'worker' },
  });
  assert.equal(edit.status, 2);
  const second = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[1]);
  assert.equal(second.rule, 'lead-only');
  assert.equal(second.role, 'worker');
  assert.equal(second.command, undefined, 'an edit writes no command or path');
  assert.ok(!readFileSync(log, 'utf8').includes('the private file text'), 'no file text goes in the log');
});

// #621: the stop log says what the stop check did, including the let-through after the tries.
test('hook --stop: refusals and the let-through are in the stop log (#621)', { skip: process.platform === 'win32' && 'the done-when command uses sh syntax' }, async () => {
  const sandbox = makeSandbox();
  const log = join(sandbox.home, '.config', 'yokoten', 'stops.jsonl');
  sandbox.write('a.md', 'fine\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'start');
  const event = JSON.stringify({ session_id: 'stop-621', cwd: sandbox.repo, hook_event_name: 'Stop', stop_hook_active: false });
  const stop = () => sandbox.call(['hook', '--stop'], { input: event, extra: { YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'exit 1' } });
  for (let tryNumber = 1; tryNumber <= 3; tryNumber += 1) assert.equal((await stop()).status, 2);
  assert.equal((await stop()).status, 0, 'the next stop is let through');
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.answer), ['refused', 'refused', 'refused', 'allowed once']);
  for (const line of lines) {
    assert.equal(line.vendor, 'claude-code');
    assert.equal(line.role, 'worker');
    assert.equal(line.rule, 'done-when');
    assert.equal(line.command, undefined);
  }
});

// #621: `stops off` deletes the log and stops the writing; `on` starts it again.
test('stops: off and on work, and the state says where the log is (#621)', async () => {
  const sandbox = makeSandbox();
  const log = join(sandbox.home, '.config', 'yokoten', 'stops.jsonl');
  const off = join(sandbox.home, '.config', 'yokoten', 'stops-off');
  const refused = () => sandbox.call(['hook'], { input: JSON.stringify({ cwd: sandbox.repo, tool_input: { command: 'git push --tags' } }) });
  assert.equal((await refused()).status, 2);
  assert.ok(existsSync(log));
  let result = await sandbox.call(['stops', 'off']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(log), 'off deletes the log');
  assert.ok(existsSync(off));
  assert.equal((await refused()).status, 2, 'the guard still stops the call');
  assert.ok(!existsSync(log), 'nothing is written while the log is off');
  result = await sandbox.call(['stops', 'on']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(off));
  assert.equal((await refused()).status, 2);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  const state = await sandbox.call(['stops']);
  assert.equal(state.status, 0, state.stderr);
  assert.match(state.stdout, /stops\.jsonl/);
  assert.match(state.stdout, /on:/);
  assert.match(state.stdout, /Nothing is sent anywhere/);
});
