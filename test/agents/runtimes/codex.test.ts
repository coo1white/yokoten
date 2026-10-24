// Tests for src/agents/runtimes/codex.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addProjectSandbox, blankedToml, hasTomlKey, hasTomlTable, hookHash, isInsideProject, parseToml, readModelIdentity, readTrust, readTrustTables, sandboxProblem } from '../../../src/agents/runtimes/codex.ts';
import { makeSandbox, makeTempDir } from '../../repo/helpers.ts';

// Each call is shaped as the runtime's hook docs show it (#30): Codex's PreToolUse
// (developers.openai.com/codex/hooks) and Gemini CLI's BeforeTool (geminicli.com/docs/hooks).
test('hook --agent codex: shell calls by command, apply_patch by the files it touches (#30)', async () => {
  const sandbox = makeSandbox();
  const call = (tool_name: string, command: string, extra?: Record<string, string>, fields: object = {}) =>
    sandbox.call(['hook', '--agent', 'codex'], {
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
  let result = await call('Bash', 'git push --tags');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /owner decides when to release/);
  assert.equal((await call('Bash', 'git status')).status, 0);
  const patch = (header: string) => `*** Begin Patch\n${header}\n@@\n-old\n+new\n*** End Patch\n`;
  const worker = { YOKOTEN_ROLE: 'worker' };
  result = await call('apply_patch', patch('*** Update File: AGENTS.md'), worker);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lead-only/);
  assert.equal((await call('apply_patch', patch('*** Update File: src/a.ts\n*** Move to: .codex/hooks.json'), worker)).status, 2, 'a move into a lead-only path');
  assert.equal((await call('apply_patch', patch(`*** Add File: ${join(sandbox.repo, '.github', 'x.yml')}`), worker)).status, 2, 'an absolute path');
  assert.equal((await call('apply_patch', patch('*** Update File: src/a.ts'), worker)).status, 0);
  assert.equal((await call('apply_patch', patch('*** Update File: AGENTS.md'))).status, 0, 'the lead may');
  // A worker subagent's call names its role (Codex rust-v0.163.0, #210); no env needed.
  assert.equal((await call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a1', agent_type: 'worker' })).status, 2, 'a worker subagent');
  assert.equal((await call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a2', agent_type: 'explorer' })).status, 0, 'an explorer is not a worker');
  assert.equal((await call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a3', agent_type: 'coworker' })).status, 0, 'a name that only contains worker is not a worker');
  assert.equal((await call('apply_patch', patch('*** Update File: AGENTS.md'), {}, { agent_id: 'a4', agent_type: 'yokoten:worker' })).status, 2, 'a type that ends with :worker');
  // A shell-run apply_patch is a Bash call, with no second hook (#209): its files count too.
  const heredoc = (header: string, before = '') => `${before}apply_patch <<'EOF'\n${patch(header)}EOF\n`;
  result = await call('Bash', heredoc('*** Update File: AGENTS.md'), worker);
  assert.equal(result.status, 2, 'a heredoc to apply_patch');
  assert.match(result.stderr, /AGENTS\.md/);
  assert.match((await call('Bash', `${heredoc('*** Update File: src/a.ts')}git push --tags\n`, worker)).stderr, /owner decides when to release/, 'the command is still checked');
  assert.equal((await call('Bash', `${heredoc('*** Update File: src/a.ts')}git push --tags\n`, worker)).status, 2);
  assert.equal((await call('Bash', `applypatch '${patch('*** Delete File: .github/x.yml')}'`, worker)).status, 2, 'the envelope as an argument');
  assert.equal((await call('Bash', heredoc('*** Add File: workflows/x.yml', 'cd .github && '), worker)).status, 2, 'after a cd');
  assert.equal((await call('Bash', heredoc('*** Add File: workflows/x.yml', 'cd .github; pwd\n'), worker)).status, 2, 'a cd further back');
  assert.equal((await call('Bash', heredoc('*** Add File: workflows/x.yml', 'pushd ".github" >/dev/null; ls; '), worker)).status, 2, 'a quoted pushd');
  assert.equal((await call('Bash', heredoc('*** Update File: a.ts', 'cd src; '), worker)).status, 0, 'a cd into a normal dir');
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
  for (const [way, command] of Object.entries(ways)) assert.equal((await call('Bash', command, worker)).status, 2, way);
  assert.equal((await call('Bash', heredoc('*** Update File: src/a.ts', 'command '), worker)).status, 0, 'a normal file');
  // A dir only the shell knows: each path counts from every folder above the cwd too.
  sandbox.write('src/a.ts', '');
  const deeper = { cwd: join(sandbox.repo, 'src') };
  assert.equal((await call('Bash', heredoc('*** Update File: AGENTS.md', 'cd "$(git rev-parse --show-toplevel)" && '), worker, deeper)).status, 2, 'cd to an unknown dir');
  assert.equal((await call('Bash', heredoc('*** Update File: AGENTS.md', 'cd ~/x; cd -; '), worker, deeper)).status, 2, 'cd ~ and cd -');
  assert.equal((await call('Bash', heredoc('*** Update File: AGENTS.md', 'cd "$HOME"; '), {}, deeper)).status, 0, 'the lead may');
  assert.equal((await call('Bash', heredoc('*** Update File: src/a.ts\n*** Move to: CLAUDE.md'), worker)).status, 2, 'a move');
  assert.equal((await call('Bash', heredoc('*** Update File: src/a.ts'), worker)).status, 0);
  assert.equal((await call('Bash', heredoc('*** Update File: AGENTS.md'))).status, 0, 'the lead may');
  assert.equal((await call('Bash', `cat > notes.md <<'EOF'\n${patch('*** Update File: AGENTS.md')}EOF\n`, worker)).status, 0, 'an envelope as data');
  // A patch is not a command, and an unknown tool is neither.
  assert.equal((await call('apply_patch', 'git push --tags')).status, 0);
  assert.equal((await call('mcp__fs__write', 'git push --tags')).status, 0);
});

test('codex config.toml: the model and provider it names, or null (#748)', () => {
  const home = makeTempDir('codex-');
  const config = (text: string) => writeFileSync(join(home, 'config.toml'), text);
  assert.equal(readModelIdentity({ CODEX_HOME: home }), null, 'no file yet');
  config('model = "deepseek-flash"\nmodel_provider = "deepseek"\n\n[model_providers.deepseek]\nname = "DeepSeek"\n');
  assert.deepEqual(readModelIdentity({ CODEX_HOME: home }), { model: 'deepseek-flash', provider: 'deepseek' });
  config('model = "gpt-6.1-sol"\n');
  assert.deepEqual(readModelIdentity({ CODEX_HOME: home }), { model: 'gpt-6.1-sol', provider: '' }, 'the provider is optional');
  config('sandbox_mode = "workspace-write"\n');
  assert.equal(readModelIdentity({ CODEX_HOME: home }), null, 'no model key');
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

test('codex config.toml: an array never swallows the next table header, so no key lands in the wrong project (#354)', () => {
  const read = (lines: string[]) => Object.fromEntries([...readTrustTables(lines.join('\n')).projects].map(([key, fields]) => [key, fields.trust_level]));
  // The known-bad case: an array closed on its line, then a comment, read as an open array.
  assert.deepEqual(read(['[projects."/r"]', 'args = ["a"] # note', '[projects."/other"]', 'trust_level = "trusted"']), { '/r': undefined, '/other': 'trusted' });
  // A bracket in a string or a comment counts for nothing; nested arrays close at the right line.
  assert.deepEqual(read(['[projects."/r"]', 'args = ["a]", [', '  "b", # ]', '], ["c"]]', 'trust_level = "untrusted"']), { '/r': 'untrusted' });
  // An array left open: the header still ends it, and its key stays in its own table.
  assert.deepEqual(read(['[projects."/r"]', 'args = [', '  "a",', '  ["b"],', '[projects."/other"]', 'trust_level = "trusted"']), { '/other': 'trusted' });
});

test('codex trust (#341): doctor says when Codex skips the hooks, and ok only when the folder and both hooks are trusted', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const root = realpathSync(sandbox.repo);
  const config = join(sandbox.home, '.codex', 'config.toml');
  const writeConfig = (text: string) => {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, text);
  };
  const doctor = async () => (await sandbox.call(['doctor'])).stdout;
  // No Codex home: Codex looks unused here, so no trust line, and no claim that it is trusted.
  assert.match(await doctor(), /ok +codex-hook: \.codex\/hooks\.json is in place; trust not checked, no ~\/\.codex\n/);
  assert.doesNotMatch(await doctor(), /Codex trusts|codex-hook: can't check/);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'no home');
  // A home without a store: can't check, and never ok.
  mkdirSync(dirname(config), { recursive: true });
  assert.match(await doctor(), /note +codex-hook: can't check whether Codex trusts this folder: no ~\/\.codex\/config\.toml; if you use Codex: run `codex` in this folder, trust it, then trust both yokoten hooks in `\/hooks`/);
  // The positive control: a store without this folder.
  writeConfig('model = "x"\n');
  assert.match(await doctor(), /note +codex-hook: Codex skips \.codex\/hooks\.json until you trust this folder; run `codex` in this folder/);
  // Codex compares the key exactly: a parent folder or a trailing slash trusts nothing.
  writeConfig(`[projects."${dirname(root)}"]\ntrust_level = "trusted"\n[projects."${root}/"]\ntrust_level = "trusted"\n`);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  // An array and a comment in this folder's own table: the trusted table below is not this folder's (#354).
  writeConfig(`[projects."${root}"]\nargs = ["a"] # note\n[projects."/other"]\ntrust_level = "trusted"\n`);
  assert.equal(readTrust(root, { HOME: sandbox.home }).state, 'untrusted');
  const project = `[projects."${root}"]\ntrust_level = "trusted"\n`;
  writeConfig(project);
  assert.match(await doctor(), /note +codex-hook: Codex trusts this folder, but not yokoten's hooks in \.codex\/hooks\.json, so it skips them; in a Codex session here, trust both in `\/hooks`/);
  // Both hooks trusted, by the hash of what init wrote: ok.
  const hooks = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).hooks;
  const state = (event: string, hash: string, extra = '') => `[hooks.state."${join(root, '.codex', 'hooks.json')}:${event}:0:0"]\ntrusted_hash = "${hash}"\n${extra}`;
  const guardHash = hookHash('pre_tool_use', hooks.PreToolUse[0].matcher, hooks.PreToolUse[0].hooks[0]);
  const stopHash = hookHash('stop', undefined, hooks.Stop[0].hooks[0]);
  writeConfig(project + state('pre_tool_use', guardHash) + state('stop', stopHash));
  assert.match(await doctor(), /ok +codex-hook\n/);
  assert.equal(readTrust(root, { CODEX_HOME: dirname(config) }).store, '$CODEX_HOME/config.toml', 'named by the variable, never by the real path');
  // A hook that changed after it was trusted, and one turned off.
  writeConfig(project + state('pre_tool_use', 'sha256:old') + state('stop', stopHash));
  assert.match(await doctor(), /note +codex-hook: yokoten's hooks in \.codex\/hooks\.json changed after you trusted them, so Codex skips them/);
  writeConfig(project + state('pre_tool_use', guardHash, 'enabled = false\n') + state('stop', stopHash));
  assert.match(await doctor(), /note +codex-hook: a yokoten hook in \.codex\/hooks\.json is turned off in Codex/);
  // Without the hooks, the note is the missing hook, not the trust.
  writeFileSync(join(root, '.codex', 'hooks.json'), '{"hooks":{}}');
  assert.match(await doctor(), /note +codex-hook: no tool-call guard and no stop check in \.codex\/hooks\.json/);
});

// ---- The project's sandbox (#589) ----

/** A project folder with `.codex/config.toml` holding `text`. */
function configProject(text: string): string {
  const root = makeTempDir('yokoten-codex-');
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex', 'config.toml'), text);
  return root;
}

const GOOD_CONFIG = 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n';

test('sandbox toml: tables, dotted keys, inline tables and lists read; the rest is skipped, never an error', () => {
  const parsed = parseToml(
    [
      '# a comment',
      'top = "a # not a comment [x]"',
      'flag = true',
      'count = 3',
      'dotted.here = "yes"',
      'pair = { inner = "v", deep.key = 1 }',
      'list = ["a", "b,c", "#d", "e=f", "g[h]i"]',
      'multi = [',
      '  "a", # a comment in a list',
      '  "b",',
      ']',
      'empty = []',
      '[table.sub]',
      'key = "v"',
      '["quoted".key]',
      'q = 1',
      '[[skipped]]',
      'key = "never"',
      '[table]',
      'after = "yes"',
      'broken line without a value',
      'unclosed = ["a"',
    ].join('\n'),
  );
  assert.equal(parsed.top, 'a # not a comment [x]');
  assert.equal(parsed.flag, true);
  assert.equal(parsed.count, 3);
  assert.deepEqual(parsed.dotted, { here: 'yes' });
  assert.deepEqual(parsed.pair, { inner: 'v', deep: { key: 1 } });
  assert.deepEqual(parsed.list, ['a', 'b,c', '#d', 'e=f', 'g[h]i']);
  assert.deepEqual(parsed.multi, ['a', 'b']);
  assert.deepEqual(parsed.empty, []);
  assert.deepEqual(parsed.table, { sub: { key: 'v' }, after: 'yes' });
  assert.deepEqual(parsed.quoted, { key: { q: 1 } });
  assert.equal(parsed.skipped, undefined);
  assert.equal(parsed.broken, undefined);
  assert.equal(parsed.unclosed, undefined);
  assert.deepEqual(parseToml(''), {});
});

test('sandbox toml: the key and table search never matches inside a string or a comment', () => {
  const blanked = blankedToml(['# sandbox_mode = "x"', 'note = "sandbox_mode = [x]"', "note2 = 'has #',", 'real = 1'].join('\n'));
  assert.equal(hasTomlKey(blanked, 'sandbox_mode'), false);
  assert.equal(hasTomlKey(blankedToml('sandbox_mode = "x"'), 'sandbox_mode'), true);
  assert.equal(hasTomlKey(blankedToml('[a]\nsandbox_mode = "x"'), 'sandbox_mode'), true, 'any table counts');
  assert.equal(hasTomlKey(blankedToml('a.sandbox_mode = "x"'), 'sandbox_mode'), true, 'a dotted key counts');
  assert.equal(hasTomlKey(blankedToml('other = { sandbox_mode = "x" }'), 'sandbox_mode'), true, 'an inline table counts');
  assert.equal(hasTomlKey(blankedToml('sandbox_modes = "x"'), 'sandbox_mode'), false, 'a longer name is not the key');
  assert.equal(hasTomlTable(blankedToml('[profiles.yokoten]'), ['profiles', 'yokoten']), true);
  assert.equal(hasTomlTable(blankedToml('[ profiles.yokoten ]'), ['profiles', 'yokoten']), true, 'spaces');
  assert.equal(hasTomlTable(blankedToml('# [profiles.yokoten]'), ['profiles', 'yokoten']), false, 'a commented header is not a table');
  assert.equal(hasTomlTable(blankedToml('[[profiles]]'), ['profiles']), false, 'an array of tables is not a table');
});

test('sandbox write: a missing file is written, and a file with the keys is same, never rewritten', () => {
  const root = makeTempDir('yokoten-codex-');
  assert.equal(addProjectSandbox(root), 'added');
  const path = join(root, '.codex', 'config.toml');
  const fresh = readFileSync(path, 'utf8');
  assert.match(fresh, /sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n\[sandbox_workspace_write\]\nnetwork_access = false\n/);
  assert.equal(addProjectSandbox(root), 'same');
  assert.equal(readFileSync(path, 'utf8'), fresh, 'same writes nothing');
});

test('sandbox write: missing keys are added where they belong, and the rest of the file stays', () => {
  const root = configProject(['model = "x"', '', '[other]', 'kept = true'].join('\n'));
  assert.equal(addProjectSandbox(root), 'added');
  assert.equal(
    readFileSync(join(root, '.codex', 'config.toml'), 'utf8'),
    ['model = "x"', '', 'sandbox_mode = "workspace-write"', 'approval_policy = "on-request"', '[other]', 'kept = true', '', '[sandbox_workspace_write]', 'network_access = false', ''].join('\n'),
  );
  // A table already there takes the key; the user's keys stay, even when they differ.
  const kept = configProject('[sandbox_workspace_write]\nwritable_roots = ["sub"]\n');
  assert.equal(addProjectSandbox(kept), 'added');
  assert.match(readFileSync(join(kept, '.codex', 'config.toml'), 'utf8'), /\[sandbox_workspace_write\]\nnetwork_access = false\nwritable_roots = \["sub"\]/);
  const danger = configProject(GOOD_CONFIG.replace('workspace-write', 'danger-full-access'));
  assert.equal(addProjectSandbox(danger), 'kept', "the user's mode stays");
  assert.match(readFileSync(join(danger, '.codex', 'config.toml'), 'utf8'), /danger-full-access/);
  const dotted = configProject('sandbox_workspace_write.network_access = false\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\n');
  assert.equal(addProjectSandbox(dotted), 'same', 'a dotted key counts as set');
  const quoted = configProject('"sandbox_mode" = "danger-full-access"\n"approval_policy" = "on-request"\n["sandbox_workspace_write"]\n"network_access" = false\n');
  assert.equal(addProjectSandbox(quoted), 'kept', 'quoted keys read, so nothing is written twice');
  assert.equal(sandboxProblem(quoted, { HOME: '/nonexistent-yokoten-home' })?.what, 'the Codex sandbox is danger-full-access, so nothing is contained');
});

test("sandbox write: a name taken in another shape is skipped, never written twice (the file would break)", () => {
  const root = configProject('[sandbox_mode]\nvalue = 1\n');
  assert.equal(addProjectSandbox(root), 'added', 'the other missing keys are still added');
  const text = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(text, /sandbox_mode = /);
  assert.match(text, /approval_policy = "on-request"/);
  const table = configProject('sandbox_workspace_write = "kept"\n');
  assert.equal(addProjectSandbox(table), 'added');
  const kept = readFileSync(join(table, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(kept, /\[sandbox_workspace_write\]/);
  assert.match(kept, /sandbox_mode = "workspace-write"/);
});

test('sandbox write: a quoted or array table header is never doubled, and doctor flags the shape (#589)', () => {
  const env = { HOME: '/nonexistent-yokoten-home' };
  for (const header of ['["sandbox_workspace_write"]', '[[sandbox_workspace_write]]']) {
    const before = `sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n${header}\n`;
    const root = configProject(before);
    assert.equal(addProjectSandbox(root), 'kept', `${header}: the table is skipped, not doubled`);
    const after = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
    assert.equal(after, before, `${header}: the file is left byte for byte`);
    assert.equal(after.split('sandbox_workspace_write').length - 1, 1, `${header}: one header, still valid TOML`);
    assert.deepEqual(sandboxProblem(root, env), { what: '.codex/config.toml has an unexpected shape', fix: 'fix it, then run `yokoten init`' }, `${header}: doctor flags the shape`);
  }
});

test('sandbox problem: missing, off, narrow, wide and unreadable, each with its one fix', () => {
  const env = { HOME: makeTempDir('yokoten-codex-home-') };
  assert.deepEqual(sandboxProblem(makeTempDir('yokoten-codex-'), env), { what: 'no Codex sandbox in .codex/config.toml', fix: '`yokoten init` adds it' });
  assert.equal(sandboxProblem(configProject(GOOD_CONFIG), env), null);
  const problem = (text: string) => sandboxProblem(configProject(text), env);
  assert.deepEqual(problem(GOOD_CONFIG.replace('workspace-write', 'danger-full-access'))?.what, 'the Codex sandbox is danger-full-access, so nothing is contained');
  assert.deepEqual(problem(GOOD_CONFIG.replace('workspace-write', 'danger-full-access'))?.fix, 'set sandbox_mode to "workspace-write" in .codex/config.toml');
  assert.deepEqual(problem(GOOD_CONFIG.replace('workspace-write', 'read-only'))?.what, "the Codex sandbox is read-only, so workers can't write");
  assert.deepEqual(problem(GOOD_CONFIG.replace('"workspace-write"', '"yolo"'))?.what, 'the Codex sandbox has an unknown mode');
  assert.deepEqual(problem(GOOD_CONFIG.replace('on-request', 'never'))?.what, 'Codex never asks before risky commands (approval_policy is never)');
  assert.deepEqual(problem(GOOD_CONFIG.replace('network_access = false', 'network_access = true'))?.what, 'the Codex sandbox allows network (network_access)');
  assert.deepEqual(problem('model = "x"\n')?.what, 'the Codex sandbox in .codex/config.toml is missing sandbox_mode, approval_policy, network_access');
  assert.deepEqual(problem('model = "x"\n')?.fix, '`yokoten init` adds it');
  assert.deepEqual(problem('[sandbox_mode]\nvalue = 1\n')?.what, '.codex/config.toml has an unexpected shape', 'a blocked key is a shape problem, not "init adds it"');
  assert.deepEqual(problem('sandbox_mode = "workspace-write"\n[sandbox_mode]\nvalue = 1\n')?.what, '.codex/config.toml has an unexpected shape', 'a name taken twice is a shape problem');
});

test('sandbox problem: writable roots inside the project or temp pass; anything else, or unsure, does not', () => {
  // A home outside the temp folder: makeTempDir lives under it, which would pass as temp.
  const env = { HOME: '/nonexistent-yokoten-home', INSIDE: 'sub/dir' };
  const root = configProject(GOOD_CONFIG);
  const withRoots = (roots: string) => {
    writeFileSync(join(root, '.codex', 'config.toml'), `${GOOD_CONFIG}writable_roots = ${roots}\n`);
    return sandboxProblem(root, env);
  };
  assert.equal(withRoots('[]'), null);
  assert.equal(withRoots('["sub/dir"]'), null, 'a relative path that stays in');
  assert.equal(withRoots(`["${root}/sub"]`), null, 'an absolute path in the project');
  assert.equal(withRoots('["/tmp"]'), null, "temp is Codex's own default");
  assert.equal(withRoots(`["${tmpdir()}"]`), null, 'the system temp folder');
  assert.deepEqual(withRoots('["/"]')?.what, 'the Codex sandbox may write outside the project (writable_roots)');
  // Enough `..` to reach the root from any depth: resolve stops there, outside temp too.
  assert.deepEqual(withRoots('["../../../../../../../../escape"]')?.what, 'the Codex sandbox may write outside the project (writable_roots)');
  assert.deepEqual(withRoots('["~/outside"]')?.what, 'the Codex sandbox may write outside the project (writable_roots)');
  assert.deepEqual(withRoots('["$UNKNOWN_VAR_HERE/sub"]')?.what, 'the Codex sandbox may write outside the project (writable_roots)', 'unsure is not fine');
  assert.equal(withRoots('["$INSIDE"]'), null, 'a variable that stays in');
  assert.deepEqual(withRoots('[1]')?.what, 'the Codex sandbox may write outside the project (writable_roots)', 'a root that is not a path');
  assert.deepEqual(withRoots('["ok", "/"]')?.what, 'the Codex sandbox may write outside the project (writable_roots)', 'one outside is enough');
  const multi = `${GOOD_CONFIG}writable_roots = [\n  "sub",\n  "/",\n]\n`;
  assert.deepEqual(sandboxProblem(configProject(multi), env)?.what, 'the Codex sandbox may write outside the project (writable_roots)', 'a multi-line list reads too');
});

test('sandbox inside: ~ grows from HOME, and a relative path is read from the project', () => {
  const root = makeTempDir('yokoten-codex-');
  const home = '/nonexistent-yokoten-home';
  assert.equal(isInsideProject('~', root, { HOME: home }), false, 'home itself is outside');
  assert.equal(isInsideProject('~/x', root, { HOME: root }), true, 'home inside the project');
  assert.equal(isInsideProject('~/x', root, {}), false, 'no home to grow from');
  assert.equal(isInsideProject('', root, { HOME: home }), false);
  assert.equal(isInsideProject('.', root, { HOME: home }), true);
});
