// Tests for src/setup/install.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  at,
  COMMENTED,
  commentedGemini,
  doctorHandAdd,
  handAdd,
  JSON_FIX,
  makeSandbox,
  onToolCall,
} from '../repo/helpers.ts';
import { hasHook } from '../../src/agents/hooks-file.ts';
import { copyRuntime } from '../../src/setup/files.ts';
import { countOwnMarks, fillMarks, install, machineStateFile, machineUserNames, migrateMarks, paths, type UserNameProbe } from '../../src/setup/install.ts';
import { autoLogins, loadMarkKinds, makeRedactor } from '../../src/rules/privacy.ts';

const BAD_USER_SETTINGS: [content: string, reason: (file: string) => string][] = [
  ['{ not json', (file) => `can't read ${file} ${JSON_FIX('install')}`],
  ['{"hooks": "x"}\n', (file) => `${file} has an unexpected shape (\`hooks\` should be an object)`],
  ['[]', (file) => `${file} has an unexpected shape (the file should be a JSON object)`],
  // A deep shape in the second event install adds: checked before the first is written.
  ['{"hooks":{"PreToolUse":[{"hooks":5}]}}', (file) => `${file} has an unexpected shape (\`hooks.PreToolUse[0].hooks\` should be a list of objects)`],
];

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
  // The git display name is no mark: a common name would flag every file holding the word.
  assert.ok(!readFileSync(marks, 'utf8').includes('Jane Example'));
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

test('uninstall: takes back what install wrote, keeps the user\'s own files and settings (#300)', () => {
  const sandbox = makeSandbox();
  const claude = join(sandbox.home, '.claude');
  mkdirSync(join(claude, 'skills', 'mine'), { recursive: true });
  writeFileSync(join(claude, 'skills', 'mine', 'SKILL.md'), 'my own skill\n');
  // The user's own skill with a kit skill's name, and a file of theirs next to a managed one.
  mkdirSync(join(sandbox.home, '.agents', 'skills', 'rca'), { recursive: true });
  writeFileSync(join(sandbox.home, '.agents', 'skills', 'rca', 'SKILL.md'), 'my own rca\n');
  const own = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } };
  writeFileSync(join(claude, 'settings.json'), JSON.stringify(own));
  assert.equal(sandbox.run(['install']).status, 0);
  writeFileSync(join(claude, 'skills', 'release', 'notes.txt'), 'mine\n');
  const before = readdirSync(join(sandbox.home, '.local/share/yokoten/kit/user/skills'));

  const result = sandbox.run(['uninstall']);
  assert.equal(result.status, 0, result.stderr);
  for (const name of before) assert.match(result.stdout, new RegExp(`^removed skill ${name} in ~/\\.claude/skills$`, 'm'));
  assert.match(result.stdout, /^kept \(yours\) skill rca in ~\/\.agents\/skills$/m);
  assert.match(result.stdout, /^removed agent worker$/m);
  assert.match(result.stdout, /^removed the SessionStart doctor$/m);
  assert.match(result.stdout, /^removed the user-level command guard$/m);
  assert.match(result.stdout, /^removed ~\/\.local\/share\/yokoten$/m);
  assert.match(result.stdout, /^kept ~\/\.config\/yokoten \(your keys and private marks\)$/m);
  assert.ok(!result.stdout.includes(sandbox.home), 'output shows the home path');
  // No file with the managed mark is left anywhere in the home.
  const left = readdirSync(sandbox.home, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  assert.deepEqual(left.filter((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8').includes('managed by yokoten')).map((entry) => entry.name), []);
  assert.ok(!existsSync(join(sandbox.home, '.local/share/yokoten')));
  assert.equal(readFileSync(join(claude, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'my own skill\n');
  assert.equal(readFileSync(join(sandbox.home, '.agents', 'skills', 'rca', 'SKILL.md'), 'utf8'), 'my own rca\n');
  assert.equal(readFileSync(join(claude, 'skills', 'release', 'notes.txt'), 'utf8'), 'mine\n');
  assert.ok(existsSync(join(sandbox.home, '.config/yokoten/private-marks')));
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')), own);

  // A second run finds nothing to remove and changes nothing.
  const homeBefore = readdirSync(sandbox.home, { recursive: true }).sort();
  const again = sandbox.run(['uninstall']);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^removed/m);
  assert.match(again.stdout, /^not there the SessionStart doctor$/m);
  assert.deepEqual(readdirSync(sandbox.home, { recursive: true }).sort(), homeBefore);

  // A settings file that is not JSON is left as it is, and the report says so.
  writeFileSync(join(claude, 'settings.json'), 'not json');
  const broken = sandbox.run(['uninstall']);
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(broken.stdout, /^kept ~\/\.claude\/settings\.json: it is not JSON/m);
  assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), 'not json');
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

test('install: a commented ~/.gemini/settings.json is left as it was and gets the hooks to add by hand; with them, it is ok (#258)', () => {
  const sandbox = makeSandbox();
  const file = join(sandbox.home, '.gemini', 'settings.json');
  mkdirSync(dirname(file));
  const before = commentedGemini('{}');
  writeFileSync(file, before);
  const result = sandbox.run(['install']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /can't read|unexpected shape/);
  assert.ok(!result.stdout.includes(sandbox.home), 'the home path is shown');
  assert.equal(readFileSync(file, 'utf8'), before, 'the file changed');
  const add = handAdd(result.stdout, `skipped Gemini CLI: ${COMMENTED('~/.gemini/settings.json')}, then run \`yokoten install\` again:`);
  assert.deepEqual(Object.keys(add), ['SessionStart', 'BeforeTool']);
  assert.deepEqual(
    Object.values(add).map((groups) => (groups as { hooks: { name: string }[] }[]).map((g) => g.hooks[0].name)),
    [['yokoten-session'], ['yokoten-guard']],
  );
  // The rest still ran.
  assert.match(result.stdout, /^added the user-level command guard$/m);
  // Doctor gives the same hooks to add, on one line.
  assert.deepEqual(doctorHandAdd(sandbox.run(['doctor']).stdout, 'gemini-user-hook', '~/.gemini/settings.json'), add);

  // Added by hand, comments and all: install finds them the same and leaves the file.
  const after = commentedGemini(JSON.stringify(add, null, 2));
  writeFileSync(file, after);
  const again = sandbox.run(['install']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^same the Gemini CLI SessionStart doctor in ~\/\.gemini\/settings\.json$/m);
  assert.match(again.stdout, /^same the Gemini CLI command guard in ~\/\.gemini\/settings\.json$/m);
  assert.equal(readFileSync(file, 'utf8'), after, 'the file changed');
  assert.match(sandbox.run(['doctor']).stdout, /^ {2}ok {6}gemini-user-hook$/m);
});

test('install: Gemini CLI allows comments but not trailing commas, and Codex allows neither (#258)', () => {
  for (const [dir, file, cli, content] of [
    ['.gemini', 'settings.json', 'Gemini CLI', '{ // c\n  "theme": "dark",\n}\n'],
    ['.codex', 'hooks.json', 'Codex CLI', '{ // c\n  "hooks": {}\n}\n'],
  ]) {
    const sandbox = makeSandbox();
    mkdirSync(join(sandbox.home, dir));
    writeFileSync(join(sandbox.home, dir, file), content);
    const result = sandbox.run(['install']);
    assert.equal(result.status, 1, cli);
    assert.ok(result.stdout.split('\n').includes(`skipped ${cli}: can't read ~/${dir}/${file} (make it valid JSON, then run \`yokoten install\` again)`), `${cli}: ${result.stdout}`);
    assert.equal(readFileSync(join(sandbox.home, dir, file), 'utf8'), content, cli);
  }
});

test('install: an unreadable ~/.claude/settings.json is skipped, the rest goes on, and install exits 1 (#254)', () => {
  for (const [content, reason] of BAD_USER_SETTINGS) {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, '.claude', 'settings.json');
    for (const dir of ['.claude', '.codex', '.gemini']) mkdirSync(join(sandbox.home, dir));
    writeFileSync(file, content);
    const result = sandbox.run(['install']);
    const what = JSON.stringify(content);
    assert.equal(result.status, 1, `${what}: ${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split('\n').includes(`skipped Claude Code: ${reason('~/.claude/settings.json')}`), `${what}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /the SessionStart doctor$|the user-level command guard$/m, what);
    assert.ok(!result.stdout.includes(sandbox.home) && !result.stderr.includes(sandbox.home), `${what}: the home path is shown`);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: the file changed`);
    // Every other step still ran: the Codex and Gemini CLI hooks, and the marks file.
    assert.match(result.stdout, /^added the Codex command guard in ~\//m, what);
    assert.match(result.stdout, /^added the Gemini CLI command guard in ~\//m, what);
    assert.match(result.stdout, /^wrote ~\/\S*private-marks /m, what);
    // Doctor names the same problem, never that the hook is missing, and doesn't crash.
    const doctor = sandbox.run(['doctor']);
    const said = content.startsWith('{ not') ? "can't read ~/.claude/settings.json" : '~/.claude/settings.json has an unexpected shape';
    assert.ok(doctor.stdout.split('\n').some((line) => line.startsWith(`  MISSING session-doctor: ${said}`)), `${what}: ${doctor.stdout}${doctor.stderr}`);
    assert.doesNotMatch(doctor.stderr, /SyntaxError|TypeError|at /, what);
    assert.equal(readFileSync(file, 'utf8'), content, `${what}: doctor changed the file`);
  }
});

// #254: only the keys install edits are checked. Another event, or an `env` install never
// touches, is the user's: install adds its hooks and keeps the key as it was.
test('install: keys in ~/.claude/settings.json that install does not edit are kept and the hooks added (#254)', () => {
  for (const [content, key, value] of [
    ['{"hooks":{"Notification":"x"}}', 'Notification', 'x'],
    ['{"env":"x"}', 'env', 'x'],
  ] as const) {
    const sandbox = makeSandbox();
    const file = join(sandbox.home, '.claude', 'settings.json');
    mkdirSync(dirname(file));
    writeFileSync(file, content);
    const result = sandbox.run(['install']);
    assert.equal(result.status, 0, `${content}: ${result.stdout}${result.stderr}`);
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(key === 'env' ? settings.env : settings.hooks.Notification, value, content);
    assert.ok(hasHook(file, 'SessionStart', 'doctor'), `${content}: no doctor hook`);
    assert.ok(hasHook(file, 'PreToolUse', 'hook'), `${content}: no guard`);
    assert.match(sandbox.run(['doctor']).stdout, /^  ok {6}session-doctor$/m, content);
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

// #77: a project's .yokoten/ copy is what a teammate without yokoten installed runs. With
// no lessons in it, its doctor ran none and said nothing. Positive control: a test with the
// incident-138 mistake must get the lesson's note from the copy's own doctor.
test('install: a project copy carries the kit lessons, and doctor from it runs them (#77)', () => {
  const sandbox = makeSandbox();
  const dest = join(sandbox.repo, '.yokoten');
  assert.equal(copyRuntime(dest), 'wrote');
  assert.ok(existsSync(join(dest, 'kit', 'lessons', 'README.md')), 'the lessons table');
  assert.ok(!existsSync(join(dest, 'kit', 'user')), 'only the project parts of the kit');
  sandbox.write('test/api.test.js', "await fetch('http://127.0.0.1:8080/health');\n");
  const doctor = spawnSync('node', [join(dest, 'bin', 'yokoten.ts'), 'doctor'], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  assert.match(doctor.stdout, /\n {2}note {4}lesson incident-138: test\/api\.test\.js: a test calls a server on this machine and does not set NO_PROXY; /);
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

test("install: adds the machine's marks and a git mailmap, and never prints a value (#390)", () => {
  const sandbox = makeSandbox();
  const email = `jane${at}personal-mail.dev`;
  sandbox.git('config', 'user.name', 'Jane Example');
  sandbox.git('config', 'user.email', email);
  sandbox.git('remote', 'add', 'origin', 'https://build.private-host.dev/jane/app.git');
  sandbox.write('README.md', 'Hello.\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'docs: hello');
  const marks = join(sandbox.home, '.config', 'yokoten', 'private-marks');
  let result = sandbox.run(['install']);
  assert.equal(result.status, 0, result.stderr);
  for (const value of ['Jane', 'personal-mail', 'private-host']) assert.ok(!(result.stdout + result.stderr).includes(value), 'install printed a value');
  assert.match(result.stdout, /^added to ~\/\.config\/yokoten\/private-marks from this machine: git email, private remote host \(the values are not shown\)$/m);
  assert.match(result.stdout, /^add your real name, your city, your domains to ~\/\.config\/yokoten\/private-marks, one per line; yokoten can't find these on its own$/m);
  assert.match(result.stdout, /^wrote ~\/\.config\/yokoten\/mailmap, and git log and git show now print your emails as a placeholder$/m);
  assert.match(readFileSync(marks, 'utf8'), /# added by yokoten from this machine: git email\njane@personal-mail\.dev\n# added by yokoten from this machine: private remote host\nbuild\.private-host\.dev\n$/);
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  // git prints the placeholder at the source.
  assert.equal(sandbox.git('config', '--global', '--get', 'mailmap.file').stdout, '~/.config/yokoten/mailmap\n');
  assert.match(sandbox.git('log', '-1').stdout, /^Author: owner <owner@noreply\.invalid>$/m);
  // A second run appends nothing.
  const before = readFileSync(marks, 'utf8');
  result = sandbox.run(['install']);
  assert.match(result.stdout, /^kept ~\/\.config\/yokoten\/private-marks: it already has what this machine knows$/m);
  assert.match(result.stdout, /^kept ~\/\.config\/yokoten\/mailmap: it already maps your emails$/m);
  assert.equal(readFileSync(marks, 'utf8'), before);
  // The user's own mailmap.file stays.
  sandbox.git('config', '--global', 'mailmap.file', '/elsewhere/mailmap');
  result = sandbox.run(['install']);
  assert.match(result.stdout, /^kept your own git mailmap.file setting; add the lines of ~\/\.config\/yokoten\/mailmap to that file$/m);
  assert.equal(sandbox.git('config', '--global', '--get', 'mailmap.file').stdout, '/elsewhere/mailmap\n');
});

test('install: an existing mailmap keeps its lines and gets only the missing ones; a privacy step never stops install (#390)', () => {
  const sandbox = makeSandbox();
  sandbox.git('config', 'user.email', `jane${at}personal-mail.dev`);
  const mailmap = join(sandbox.home, '.config', 'yokoten', 'mailmap');
  mkdirSync(dirname(mailmap), { recursive: true });
  const own = `Me <me${at}example.com> <old${at}example.com>\n`;
  writeFileSync(mailmap, own);
  let result = sandbox.run(['install']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(mailmap, 'utf8'), `${own}owner <owner@noreply.invalid> <jane${at}personal-mail.dev>\n`);
  assert.match(result.stdout, /^wrote|^kept ~\/\.config\/yokoten\/mailmap, and git log/m);
  // A marks path that is a folder: install says what it skipped, and goes on.
  const broken = join(sandbox.home, 'marks-folder');
  mkdirSync(broken);
  result = sandbox.run(['install'], { extra: { YOKOTEN_PRIVATE_MARKS: broken } });
  assert.match(result.stdout, /^skipped the marks from this machine: /m);
  assert.match(result.stdout, /^skipped the git mailmap: /m);
  assert.match(result.stdout, /skill /, 'the rest of install ran');
});

// ---- The machine's user names (#404) ----

/** A fake machine for machineUserNames: its account name, its home, its folders and files. */
function fakeUsers(username: string, home: string, folders: Record<string, string[]> = {}): UserNameProbe & { files: Map<string, string>; listed: string[] } {
  const files = new Map<string, string>();
  const listed: string[] = [];
  return {
    files,
    listed,
    username: () => username,
    systemHome: () => home,
    listFolders(path) {
      listed.push(path);
      return folders[path] ?? null;
    },
    readText: (path) => files.get(path) ?? null,
    writeText: (path, text) => void files.set(path, text),
  };
}

test('machineUserNames: the Linux and Windows user names, though no git or forge list has them (#404)', () => {
  const env = { HOME: '/home/jdoe', WSL_DISTRO_NAME: '<distro>' };
  const probe = fakeUsers('jdoe', '/home/jdoe', { '/mnt': ['c', 'd', 'wslg'], '/mnt/c/Users': ['Public', 'Default', 'JaneD'], '/mnt/d/Users': null as unknown as string[] });
  const names = machineUserNames(env, probe);
  assert.deepEqual(names, ['jdoe', 'JaneD']);
  // Read once: the second run reads machine.json, not the drives.
  assert.deepEqual(JSON.parse(probe.files.get(machineStateFile(env)) ?? '{}').windowsUsers, ['JaneD']);
  probe.listed.length = 0;
  assert.deepEqual(machineUserNames(env, probe), ['jdoe', 'JaneD']);
  assert.deepEqual(probe.listed, []);
  const redact = makeRedactor({ owners: names }, { HOME: '/home/jdoe' });
  const text = ['/home/jdoe/x', '/mnt/c/Users/janed/y', 'C:\\Users\\JaneD\\z', '"C:\\\\Users\\\\JaneD"', 'jdoe and JaneD', 'jdoes and janedoe stay'].join('\n');
  assert.equal(redact(text), ['~/x', '/mnt/c/Users/<owner>/y', 'C:\\Users\\<owner>\\z', '"C:\\\\Users\\\\<owner>"', '<owner> and <owner>', 'jdoes and janedoe stay'].join('\n'));
});

test('machineUserNames: USERPROFILE gives the Windows name without reading the drives; shared and short names stay out (#404)', () => {
  const probe = fakeUsers('runner', '/root', { '/mnt': ['c'] });
  assert.deepEqual(machineUserNames({ HOME: '/home/jd', WSL_INTEROP: '/run/x', USERPROFILE: 'C:\\Users\\JaneD' }, probe), ['JaneD']);
  assert.deepEqual(probe.listed, []);
  assert.deepEqual(machineUserNames({ HOME: '/tmp/tmp.AbCd' }, probe), [], 'a home outside a users folder names nobody; no WSL, no drives');
  assert.deepEqual(probe.listed, []);
});

test('install: with no absolute home it refuses and writes nothing (#404)', () => {
  const result = install({ HOME: '' }, { system: () => '' });
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /no home folder/);
  assert.equal(install({ HOME: 'relative/home' }, { system: () => 'also/relative' }).ok, false);
  assert.throws(() => paths({ HOME: '' }, () => ''), /no home folder/);
  assert.equal(existsSync('relative') || existsSync('.local'), false, 'nothing lands in the folder the test runs in');
});

test('migrateMarks: an old block is split by kind; a value it cannot place stays strict (#410)', () => {
  const old = `# mine\nmycity\n# added by yokoten from this machine\nocto-jdoe\njane${at}personal-mail.dev\nnas\nbuild.private-host.dev\nbox\n\n# later\nmyserver\n`;
  assert.equal(migrateMarks('# mine\nmycity\n', { logins: [], hosts: [] }), null);
  assert.equal(
    migrateMarks(old, { logins: ['Octo-Jdoe'], hosts: ['nas'] }),
    `# mine\nmycity\n# added by yokoten from this machine: forge login\nocto-jdoe\n# added by yokoten from this machine: git email\njane${at}personal-mail.dev\n# added by yokoten from this machine: private remote host\nnas\nbuild.private-host.dev\n# your own marks\nbox\n# later\nmyserver\n`,
  );
  // With no login known, a bare name is never taken for one.
  assert.ok(!migrateMarks(old, { logins: [], hosts: [] })?.includes('forge login'));
});

test('fillMarks: rewrites an old block in a fake home, by the gh login on file, and keeps mode 600 (#410)', () => {
  const home = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const env = { HOME: home };
  const marks = join(home, '.config', 'yokoten', 'private-marks');
  mkdirSync(dirname(marks), { recursive: true });
  writeFileSync(marks, '# added by yokoten from this machine\nocto-jdoe\nnas\n', { mode: 0o600 });
  mkdirSync(join(home, '.config', 'gh'), { recursive: true });
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    user: octo-jdoe\n    git_protocol: https\n');
  // Before the rewrite, the old block gives no login: a bare name is strict.
  assert.deepEqual(autoLogins(loadMarkKinds(env)), []);
  assert.deepEqual(fillMarks(env, []), []);
  assert.equal(readFileSync(marks, 'utf8'), '# added by yokoten from this machine: forge login\nocto-jdoe\n# your own marks\nnas\n');
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  assert.deepEqual(autoLogins(loadMarkKinds(env)), ['octo-jdoe']);
  assert.equal(countOwnMarks(env), 1);
  assert.deepEqual(readdirSync(dirname(marks)), ['private-marks'], 'no temp file is left');
  // A second run changes nothing.
  fillMarks(env, []);
  assert.equal(readFileSync(marks, 'utf8'), '# added by yokoten from this machine: forge login\nocto-jdoe\n# your own marks\nnas\n');
});
