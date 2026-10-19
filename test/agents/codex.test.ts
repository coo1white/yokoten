// Tests for src/agents/codex.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../helpers.ts';

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
