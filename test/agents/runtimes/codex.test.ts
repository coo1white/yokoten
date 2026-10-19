// Tests for src/agents/runtimes/codex.ts.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { hookHash, readTrust, readTrustTables } from '../../../src/agents/runtimes/codex.ts';
import { makeSandbox } from '../../repo/helpers.ts';

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

// The hooks init wrote in a real run of Codex 0.163.0 on 2026-10-19 (#340), and the hashes
// Codex saved in config.toml when they were trusted in /hooks. A known answer: if the hash
// recipe drifts from Codex's, doctor would call trusted hooks changed, or the reverse.
const REAL_GUARD =
  "[ -f \"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts\" ] 2>/dev/null || { echo 'yokoten: the hook cannot run, because .yokoten/ is missing. Restore it from git, or run yokoten init again' >&2; exit 1; }; command -v node >/dev/null 2>&1 || { echo 'yokoten: the guard cannot run, because node is not on PATH for this agent; run yokoten doctor in a terminal' >&2; exit 1; }; { err=$( ( node --max-old-space-size=256 \"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts\" hook --agent codex 2>&1 1>&3 3>&-; c=$?; printf x; exit $c ) 2>/dev/null ); code=$?; } 3>&1; case $code in 0|2) printf %s \"${err%x}\" >&2;; *) echo \"yokoten's guard failed (exit $code), so the command is refused; run \\`yokoten doctor\\`\" >&2; code=2;; esac; exit $code";
const REAL_STOP =
  "[ -f \"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts\" ] 2>/dev/null || { echo 'yokoten: the hook cannot run, because .yokoten/ is missing. Restore it from git, or run yokoten init again' >&2; exit 1; }; node \"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.ts\" hook --stop --agent codex";

test('codex hook hash: the same as the trusted_hash a real Codex 0.163.0 saved (#341)', () => {
  assert.equal(hookHash('pre_tool_use', 'Bash|apply_patch', { type: 'command', command: REAL_GUARD }), 'sha256:3b4edcb7d369af4ee1fae27683cfa921e1cfa6372b6fadc0446018b407a08bf4');
  assert.equal(hookHash('stop', undefined, { type: 'command', command: REAL_STOP }), 'sha256:a5b74f98dc139898fe576c129283ddebb66b5900ade59048bde590972c980397');
  // A timeout or another command is another hook to Codex.
  assert.notEqual(hookHash('pre_tool_use', 'Bash|apply_patch', { type: 'command', command: REAL_GUARD, timeout: 30 }), hookHash('pre_tool_use', 'Bash|apply_patch', { type: 'command', command: REAL_GUARD }));
  assert.notEqual(hookHash('stop', undefined, { type: 'command', command: `${REAL_STOP} ` }), hookHash('stop', undefined, { type: 'command', command: REAL_STOP }));
});

test('codex config.toml: the trust tables, as headers, dotted keys and one-line tables', () => {
  const tables = readTrustTables(
    [
      'model = "x" # a comment',
      'hooks.state."/e:stop:0:0".trusted_hash = "sha256:1"',
      'notes = """',
      '[projects."/not/a/table"]',
      '"""',
      '[projects."/a/b"]',
      'trust_level = "trusted"',
      "[projects.'/c']",
      'trust_level = "untrusted"',
      '[projects]',
      '"/d" = { trust_level = "trusted" }',
      '[[profiles]]',
      'trust_level = "trusted"',
    ].join('\n'),
  );
  assert.deepEqual(Object.fromEntries(tables.projects), { '/a/b': { trust_level: 'trusted' }, '/c': { trust_level: 'untrusted' }, '/d': { trust_level: 'trusted' } });
  assert.deepEqual(Object.fromEntries(tables.hookStates), { '/e:stop:0:0': { trusted_hash: 'sha256:1' } });
});

test('codex trust (#341): doctor says when Codex skips the hooks, and ok only when the folder and both hooks are trusted', () => {
  const sandbox = makeSandbox();
  assert.equal(sandbox.run(['init']).status, 0);
  const root = realpathSync(sandbox.repo);
  const config = join(sandbox.home, '.codex', 'config.toml');
  const writeConfig = (text: string) => {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, text);
  };
  const doctor = () => sandbox.run(['doctor']).stdout;
  // No store: can't check, and never ok.
  assert.match(doctor(), /note +codex-hook: can't check whether Codex trusts this folder: no ~\/\.codex\/config\.toml; if you use Codex: run `codex` in this folder, trust it, then trust both yokoten hooks in `\/hooks`/);
  // The positive control: a store without this folder.
  writeConfig('model = "x"\n');
  assert.match(doctor(), /note +codex-hook: Codex skips \.codex\/hooks\.json until you trust this folder; run `codex` in this folder/);
  // Codex compares the key exactly: a parent folder or a trailing slash trusts nothing.
  writeConfig(`[projects."${dirname(root)}"]\ntrust_level = "trusted"\n[projects."${root}/"]\ntrust_level = "trusted"\n`);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  const project = `[projects."${root}"]\ntrust_level = "trusted"\n`;
  writeConfig(project);
  assert.match(doctor(), /note +codex-hook: Codex trusts this folder, but not yokoten's hooks in \.codex\/hooks\.json, so it skips them; in a Codex session here, trust both in `\/hooks`/);
  // Both hooks trusted, by the hash of what init wrote: ok.
  const hooks = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).hooks;
  const state = (event: string, hash: string, extra = '') => `[hooks.state."${join(root, '.codex', 'hooks.json')}:${event}:0:0"]\ntrusted_hash = "${hash}"\n${extra}`;
  const guardHash = hookHash('pre_tool_use', hooks.PreToolUse[0].matcher, hooks.PreToolUse[0].hooks[0]);
  const stopHash = hookHash('stop', undefined, hooks.Stop[0].hooks[0]);
  writeConfig(project + state('pre_tool_use', guardHash) + state('stop', stopHash));
  assert.match(doctor(), /ok +codex-hook\n/);
  assert.equal(readTrust(root, { CODEX_HOME: dirname(config) }).store, '$CODEX_HOME/config.toml', 'named by the variable, never by the real path');
  // A hook that changed after it was trusted, and one turned off.
  writeConfig(project + state('pre_tool_use', 'sha256:old') + state('stop', stopHash));
  assert.match(doctor(), /note +codex-hook: yokoten's hooks in \.codex\/hooks\.json changed after you trusted them, so Codex skips them/);
  writeConfig(project + state('pre_tool_use', guardHash, 'enabled = false\n') + state('stop', stopHash));
  assert.match(doctor(), /note +codex-hook: a yokoten hook in \.codex\/hooks\.json is turned off in Codex/);
  // Without the hooks, the note is the missing hook, not the trust.
  writeFileSync(join(root, '.codex', 'hooks.json'), '{"hooks":{}}');
  assert.match(doctor(), /note +codex-hook: no tool-call guard and no stop check in \.codex\/hooks\.json/);
});
