// Tests for src/setup/init/index.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  at,
  CLI,
  COMMENTED,
  commentedGemini,
  doctorHandAdd,
  handAdd,
  JSON_FIX,
  makeSandbox,
  MISSING_PROJECT,
  onToolCall,
  pick,
} from '../../repo/helpers.ts';
import { hasHook } from '../../../src/agents/hooks-file.ts';
const guarded = (path: string, args: string) => `[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; node ${path} ${args}`;

const guardedCall = (path: string, args: string) => onToolCall(`[ -f ${path} ] 2>/dev/null || { echo '${MISSING_PROJECT}' >&2; exit 1; }; `, path, args);

const BAD_PROJECT_SETTINGS: [content: string, reason: (file: string) => string][] = [
  ['{ not json', (file) => `can't read ${file} ${JSON_FIX('init')}`],
  ['{"hooks": "x"}\n', (file) => `${file} has an unexpected shape (\`hooks\` should be an object)`],
  ['[]', (file) => `${file} has an unexpected shape (the file should be a JSON object)`],
  ['{"env": "x"}', (file) => `${file} has an unexpected shape (\`env\` should be an object)`],
  // The stop check is the second hook init adds: checked before the first is written.
  ['{"hooks":{"Stop":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (\`hooks.Stop[0].hooks\` should be a list of objects)`],
  ['{"hooks":{"SubagentStop":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (\`hooks.SubagentStop[0].hooks\` should be a list of objects)`],
];

// Gemini CLI (v0.64.0) swaps `$GEMINI_PROJECT_DIR` in the command text for the shell-quoted
// launch folder, then runs the text in a shell (#210). This copies that against a repo whose
// path has a space and an @.
test('init: the Gemini hook command runs when Gemini quotes a path with a space (#210)', async () => {
  const sandbox = makeSandbox();
  // An older yokoten wrote the folder in double quotes; init updates that hook in place.
  const old = 'node "$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.ts" hook --agent gemini';
  sandbox.write('.gemini/settings.json', JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: old, name: 'yokoten' }] }] } }));
  const result = sandbox.run(['init']); // a real process: the entry point of init, end to end
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated the Gemini CLI tool-call hook/);
  const repo = join(dirname(sandbox.repo), 'my repo@1');
  renameSync(sandbox.repo, repo);
  const groups = JSON.parse(readFileSync(join(repo, '.gemini', 'settings.json'), 'utf8')).hooks.BeforeTool;
  assert.equal(groups.length, 1, 'updated, not added');
  const command: string = groups[0].hooks[0].command;
  assert.equal(command, guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --agent gemini'));
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

test('init: adds the practices, keeps what is there, and doctor goes on to stage 4', async () => {
  const sandbox = makeSandbox();
  // An AGENTS.md with `## This project` is left to `update` (#378).
  const ours = '# our own rules\n\n## This project\n\nours\n';
  sandbox.write('AGENTS.md', ours);
  sandbox.write('.github/SECURITY.md', '# email us\n');
  // The user's own Codex and Gemini CLI settings stay.
  const mine = (event: string) => ({ [event]: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'mine' }] }] });
  sandbox.write('.codex/hooks.json', JSON.stringify({ description: 'ours', hooks: mine('PreToolUse') }));
  sandbox.write('.gemini/settings.json', JSON.stringify({ theme: 'x', hooks: mine('BeforeTool') }));
  assert.match(sandbox.run(['doctor']).stdout, /note +codex-hook: no tool-call guard/, 'reported, not counted as missing'); // a real process: the entry point of doctor
  assert.match((await sandbox.call(['doctor'])).stdout, /note +antigravity-hook: no tool-call guard in \.agents\/hooks\.json/, 'the positive control for the Antigravity CLI step (#30)');
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kept AGENTS\.md/);
  assert.match(result.stdout, /wrote \.githooks\/pre-commit/);
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), ours);
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
  assert.match(workflow, /^  ci:\n    if: always\(\)\n    needs: \[changes, check, lint\]$/m, 'one required check that waits for the rest (#36)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --pr/, 'the pull request check (#47)');
  assert.match(readFileSync(join(sandbox.repo, '.github/workflows/issue.yml'), 'utf8'), /node \.yokoten\/bin\/yokoten\.ts check --issue/, 'the issue title check');
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
  assert.equal(sandbox.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  // Again: nothing changes.
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /kept \.github\/SECURITY\.md/);
  assert.match(result.stdout, /kept \.github\/dependabot\.yml/);
  assert.match(result.stdout, /kept CHANGELOG\.md/);
  assert.match(result.stdout, /same the tool-call hook/);
  assert.match(result.stdout, /same TZ=UTC for agent sessions/);
  const settings = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(result.stdout, /same the stop check/);
  const stopHook = { hooks: [{ type: 'command', command: guarded('"$CLAUDE_PROJECT_DIR/.yokoten/bin/yokoten.mjs"', 'hook --stop'), timeout: 600 }] };
  assert.deepEqual(settings.hooks.Stop, [stopHook], 'the stop check, once (#92)');
  assert.deepEqual(settings.hooks.SubagentStop, [stopHook], 'SubagentStop, once (#614)');
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  assert.match(result.stdout, /same the Codex tool-call hook/);
  assert.match(result.stdout, /same the Gemini CLI tool-call hook/);
  const codex = JSON.parse(readFileSync(join(sandbox.repo, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(codex.description, 'ours');
  assert.equal(codex.hooks.PreToolUse.length, 2);
  assert.deepEqual(codex.hooks.PreToolUse[1], {
    hooks: [{ type: 'command', command: guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --agent codex') }],
    matcher: 'Bash|apply_patch',
  });
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(gemini.theme, 'x');
  assert.equal(gemini.hooks.BeforeTool.length, 2);
  assert.deepEqual(gemini.hooks.BeforeTool[1], {
    hooks: [{ type: 'command', command: guardedCall('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --agent gemini'), name: 'yokoten' }],
    matcher: 'run_shell_command|write_file|replace',
  });
  // The stop checks (#211): Codex's Stop and Gemini's AfterAgent take no matcher, once each.
  assert.match(result.stdout, /same the Codex stop check/);
  assert.match(result.stdout, /same the Gemini CLI stop check/);
  assert.deepEqual(codex.hooks.Stop, [{ hooks: [{ type: 'command', command: guarded('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --stop --agent codex'), timeout: 600 }] }]);
  assert.deepEqual(gemini.hooks.AfterAgent, [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --stop --agent gemini'), name: 'yokoten-stop', timeout: 600_000 }] }]);
  // Codex's hooks are in place; this home has no ~/.codex, so doctor says nothing of its trust (#341).
  assert.match((await sandbox.call(['doctor'])).stdout, /ok +codex-hook: \.codex\/hooks\.json is in place; trust not checked, no ~\/\.codex\n +ok +gemini-hook\n +ok +antigravity-hook/);
  assert.match(result.stdout, /Codex runs the hooks in \.codex\/hooks\.json only after you trust this folder and the hooks\n.*to trust them in Codex: run `codex` in this folder, trust it, then trust both yokoten hooks in `\/hooks`/);
  // Antigravity CLI (#30): its own file, and Copilot CLI reads .claude/settings.json.
  assert.match(result.stdout, /same the Antigravity CLI tool-call hook in \.agents\/hooks\.json/);
  assert.match(result.stdout, /GitHub Copilot CLI runs the hooks in \.claude\/settings\.json only after you trust this folder\n.*to trust this folder in Copilot CLI: run `copilot` in this folder/);
  const agents = JSON.parse(readFileSync(join(sandbox.repo, '.agents', 'hooks.json'), 'utf8'));
  assert.deepEqual(agents.yokoten.PreToolUse[0].hooks[0].command, guardedCall('"$(git rev-parse --show-toplevel)/.yokoten/bin/yokoten.mjs"', 'hook --agent antigravity'));
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
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /^yokoten: stage 1 of 5, safety net\. Next: no workflow runs a test command/);
  sandbox.withTests();
  result = await sandbox.call(['doctor', '--session']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^yokoten: stage 4 of 5, a team of agents\. Next: \.github\/CODEOWNERS names no owner yet \(@YOUR_GITHUB_HANDLE\); put your GitHub handle in \.github\/CODEOWNERS/);
});

test('init: an unreadable project .codex/hooks.json or .gemini/settings.json is skipped, the rest goes on, and init exits 1 (#248)', async () => {
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
      const result = await sandbox.call(['init']);
      const what = `${bad}, ${JSON.stringify(content)}`;
      assert.equal(result.status, 1, what);
      assert.ok(result.stdout.split('\n').includes(`skipped ${name}: ${skip}`), `${what}: ${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(join(sandbox.repo, bad), 'utf8'), content, `${what}: the file changed`);
      assert.ok(hasHook(join(sandbox.repo, good), dirname(good) === '.codex' ? 'Stop' : 'AfterAgent', 'hook'), `${what}: no stop check in ${good}`);
      assert.match(result.stdout, /TZ=UTC for agent sessions/, what);
    }
  }
});

test('init: a commented .gemini/settings.json is left as it was and gets the hooks to add by hand; with them, it is ok (#258)', async () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.repo, '.gemini', 'settings.json');
  const before = commentedGemini('{ "BeforeTool": [] }');
  sandbox.write('.gemini/settings.json', before);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /can't read|unexpected shape/);
  assert.equal(readFileSync(file, 'utf8'), before, 'the file changed');
  const add = handAdd(result.stdout, `skipped the Gemini CLI hooks: ${COMMENTED('.gemini/settings.json')}, then run \`yokoten init\` again:`);
  // The tool-call command may carry a fail-closed wrapper (#260); either way it checks for the
  // project runtime first, then runs the yokoten guard with node.
  const runtimePath = '$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs';
  const guardCall = String((add.BeforeTool?.[0] as { hooks?: { command?: unknown }[] } | undefined)?.hooks?.[0]?.command);
  const missingCheck = guarded(runtimePath, 'x').slice(0, -`node ${runtimePath} x`.length);
  assert.ok(guardCall.startsWith(missingCheck), guardCall);
  assert.match(guardCall, /\bnode(?: --\S+)* \$GEMINI_PROJECT_DIR\/\.yokoten\/bin\/yokoten\.mjs hook --agent gemini(?: |$)/);
  assert.deepEqual(add, {
    BeforeTool: [{ hooks: [{ type: 'command', command: guardCall, name: 'yokoten' }], matcher: 'run_shell_command|write_file|replace' }],
    AfterAgent: [{ hooks: [{ type: 'command', command: guarded('$GEMINI_PROJECT_DIR/.yokoten/bin/yokoten.mjs', 'hook --stop --agent gemini'), name: 'yokoten-stop', timeout: 600_000 }] }],
  });
  assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), 'no Codex stop check');
  assert.deepEqual(doctorHandAdd((await sandbox.call(['doctor'])).stdout, 'gemini-hook', '.gemini/settings.json'), add);

  const after = commentedGemini(JSON.stringify(add, null, 2)).replace(/\n}\n$/, `,\n  "security": {\n    "disableYoloMode": true\n  }\n}\n`);
  writeFileSync(file, after);
  const again = await sandbox.call(['init']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^same the Gemini CLI tool-call hook in \.gemini\/settings\.json$/m);
  assert.match(again.stdout, /^same the Gemini CLI stop check in \.gemini\/settings\.json/m);
  assert.equal(readFileSync(file, 'utf8'), after, 'the file changed');
  assert.match((await sandbox.call(['doctor'])).stdout, /^ {2}ok {6}gemini-hook$/m);
});

test('init: an unreadable project .claude/settings.json is skipped, the rest goes on, and init exits 1 (#254)', async () => {
  for (const [content, reason] of BAD_PROJECT_SETTINGS) {
    const sandbox = makeSandbox();
    const file = join(sandbox.repo, '.claude', 'settings.json');
    mkdirSync(dirname(file));
    writeFileSync(file, content);
    const result = await sandbox.call(['init']);
    const what = JSON.stringify(content);
    assert.equal(result.status, 1, `${what}: ${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split('\n').includes(`skipped the Claude Code settings: ${reason('.claude/settings.json')}`), `${what}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /in \.claude\/settings\.json/, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: the file changed`);
    // Every other step still ran: the Codex and Gemini CLI hooks, and the commit check.
    assert.ok(hasHook(join(sandbox.repo, '.codex', 'hooks.json'), 'Stop', 'hook'), `${what}: no Codex stop check`);
    assert.ok(hasHook(join(sandbox.repo, '.gemini', 'settings.json'), 'AfterAgent', 'hook'), `${what}: no Gemini CLI stop check`);
    assert.match(result.stdout, /the commit check/, what);
    const doctor = await sandbox.call(['doctor']);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: doctor changed the file`);
  }
});

test('init: run from the project\'s .yokoten/, it keeps .yokoten/ (#204)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const vendored = () => spawnSync('node', ['.yokoten/bin/yokoten.ts', 'init'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  let result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.yokoten\/ \(the copy running now\)$/m);
  result = vendored();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(sandbox.repo, '.yokoten', 'VERSION')));
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

test('init: reads GitHub and says what it would do; --github --yes does it, and a second run changes nothing (#10)', async () => {
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
  let result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because there is no origin remote yet/);
  assert.equal(calls().length, 0);
  assert.equal((await sandbox.call(['init', '--yes'], { extra })).status, 1, '--yes alone is refused');
  assert.equal((await sandbox.call(['init', '--remove-default-labels'], { extra })).status, 1, 'so is --remove-default-labels');
  assert.equal((await sandbox.call(['init', '--board'], { extra })).status, 1, 'and --board (#156)');
  // --github --yes asked for changes on GitHub; with no remote none were made, so it fails (#208).
  result = await sandbox.call(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because there is no origin remote yet\. Add one on GitHub, then run `yokoten init --github --yes`/);
  assert.match(result.stderr, /\nyokoten init: --github --yes changed nothing on GitHub \(the reason is above\)\. The project files are as listed above\.\n$/);
  assert.equal(calls().length, 0);
  sandbox.git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  result = await sandbox.call(['init'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: example\/repo\n- 1 of the 12 standard labels are there; kept\n- not in the standard set: question\./);
  assert.match(result.stdout, /Would do:\n- make label "feat"[^]*- make milestone "First release"\nNothing changed\./);
  assert.deepEqual(changed(), [], 'plain init only reads');
  result = await sandbox.call(['init', '--github', '--yes'], { extra });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- done: make label "good first issue"[^\n]*\n[^]*- done: make milestone "First release"/);
  assert.equal(changed().length, 12);
  result = await sandbox.call(['init', '--github', '--yes'], { extra });
  assert.match(result.stdout, /- 12 of the 12 standard labels are there; kept\n- a milestone is open; kept\n[^]*Nothing to change\./);
  assert.equal(changed().length, 12, 'the second run changed nothing');
  // Without gh on the PATH, plain init still succeeds and says so. Only node and git are there.
  const noGh = join(sandbox.home, 'no-gh');
  mkdirSync(noGh);
  const gitPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(process.execPath, join(noGh, 'node'));
  symlinkSync(join(gitPath, 'git'), join(noGh, 'git'));
  result = await sandbox.call(['init'], { extra: { PATH: noGh } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub: skipped, because gh is not installed/);
  // init --github --yes fails: it was asked to change GitHub and could not (#208).
  result = await sandbox.call(['init', '--github', '--yes'], { extra: { PATH: noGh } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub: skipped, because gh is not installed[^\n]*\nyokoten init: --github --yes changed nothing on GitHub/);
});

test('init: a yokoten.json "areas" that is not a list stops init before it writes a file (#156)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: 'cli' }));
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten init: yokoten\.json: "areas" must be a list of names/);
  assert.doesNotMatch(result.stderr, /is not a function/);
  assert.ok(!existsSync(join(sandbox.repo, 'AGENTS.md')), 'nothing written');
  // The control: the same project with a list runs.
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['cli'] }));
  result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(sandbox.repo, 'AGENTS.md')));
});

// The kit version mark in AGENTS.md (#141): newer is never "behind", and no mark compares by content.

test('init: writes each agent sandbox, and a second run changes nothing (#589)', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^added the Claude Code sandbox in \.claude\/settings\.json \(shell commands stay in the project/m);
  assert.match(result.stdout, /^added the Codex sandbox in \.codex\/config\.toml \(writes stay in the project/m);
  assert.match(result.stdout, /^added the Gemini sandbox in \.gemini\/settings\.json \(YOLO mode/m);
  assert.match(result.stdout, /^added the Grok sandbox in \.grok\/sandbox\.toml \(the yokoten profile/m);
  const claude = JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claude.sandbox, { enabled: true });
  assert.ok(claude.hooks.PreToolUse.length === 1, 'the sandbox keeps the hooks');
  assert.equal(claude.env.TZ, 'UTC');
  const codex = readFileSync(join(sandbox.repo, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /^sandbox_mode = "workspace-write"$/m);
  assert.match(codex, /^approval_policy = "on-request"$/m);
  assert.match(codex, /^\[sandbox_workspace_write\]$/m);
  assert.match(codex, /^network_access = false$/m);
  const gemini = JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8'));
  assert.deepEqual(gemini.security, { disableYoloMode: true });
  assert.ok(gemini.hooks.BeforeTool.length >= 1, 'the sandbox keeps the hooks');
  const grok = readFileSync(join(sandbox.repo, '.grok', 'sandbox.toml'), 'utf8');
  assert.match(grok, /^\[profiles\.yokoten\]$/m);
  assert.match(grok, /^extends = "workspace"$/m);
  const again = await sandbox.call(['init']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^same the Claude Code sandbox in \.claude\/settings\.json$/m);
  assert.match(again.stdout, /^same the Codex sandbox in \.codex\/config\.toml$/m);
  assert.match(again.stdout, /^same the Gemini sandbox in \.gemini\/settings\.json$/m);
  assert.match(again.stdout, /^same the Grok sandbox in \.grok\/sandbox\.toml$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8')).sandbox, { enabled: true });
});

test('init: keeps a sandbox the user set, and still exits 0 (#589)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.claude/settings.json', JSON.stringify({ sandbox: { enabled: false } }));
  sandbox.write('.gemini/settings.json', JSON.stringify({ security: { disableYoloMode: false } }));
  sandbox.write('.codex/config.toml', 'sandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n');
  sandbox.write('.grok/sandbox.toml', '[profiles.yokoten]\nextends = "devbox"\n');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^kept your Claude Code sandbox in \.claude\/settings\.json \(doctor names what differs\)$/m);
  assert.match(result.stdout, /^kept your Codex sandbox in \.codex\/config\.toml \(doctor names what differs\)$/m);
  assert.match(result.stdout, /^kept your Gemini sandbox in \.gemini\/settings\.json \(doctor names what differs\)$/m);
  assert.match(result.stdout, /^kept your Grok sandbox in \.grok\/sandbox\.toml \(doctor names what differs\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.repo, '.claude', 'settings.json'), 'utf8')).sandbox, { enabled: false });
  assert.ok(hasHook(join(sandbox.repo, '.claude', 'settings.json'), 'PreToolUse', 'hook'), 'the hooks still go in');
  assert.deepEqual(JSON.parse(readFileSync(join(sandbox.repo, '.gemini', 'settings.json'), 'utf8')).security, { disableYoloMode: false });
  assert.match(readFileSync(join(sandbox.repo, '.codex', 'config.toml'), 'utf8'), /^sandbox_mode = "danger-full-access"$/m);
  assert.match(readFileSync(join(sandbox.repo, '.grok', 'sandbox.toml'), 'utf8'), /^extends = "devbox"$/m);
});
