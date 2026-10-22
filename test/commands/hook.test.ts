// Tests for src/commands/hook.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
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
  for (const command of ['git push -u origin task', `git worktree remove ${tree}`, 'gh api -X PUT repos/a/b/pulls/1/merge', 'git -c alias.p=push p', 'chmod 000 .gi?']) {
    assert.equal((await lead({ command })).status, 0, command);
  }
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
  assert.match((await start()).stdout, /this session is a worker, because its worktree carries the worker mark/);
  // The main checkout stays the lead's.
  sandbox.write('AGENTS.md', '# lead\n');
  sandbox.git('add', 'AGENTS.md');
  assert.doesNotMatch((await sandbox.call(['check', '--staged'])).stderr, /lead-only/);
  assert.doesNotMatch((await sandbox.call(['doctor', '--session', '--agent', 'muse'])).stdout, /this session is a worker/);
});

// #555 (L3): `worker mark` says plainly what it can't do.
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
