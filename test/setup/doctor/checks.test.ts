// Tests for src/setup/doctor/checks.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, makeTempDir, ROOT } from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { launcherDir, setUpLauncher } from '../../../src/setup/install.ts';
import { doctor, launcherCheck, privacyNotes } from '../../../src/setup/doctor/index.ts';

// #522: install fills the git name, so the marks are in place. One run gives one answer.
test('install then doctor: the private-marks lines agree, in full doctor and a session (#522)', async () => {
  const sandbox = makeSandbox();
  const name = ['Kit', 'Sample'].join(' ');
  sandbox.git('config', 'user.name', name);
  const installed = await sandbox.call(['install']);
  assert.equal(installed.status, 0, installed.stderr);
  const marksLines = (text: string) => text.split('\n').filter((line) => /private.marks?|private marks/.test(line));
  const said = [installed.stdout, installed.stderr];
  const full = await sandbox.call(['doctor']);
  said.push(full.stdout, full.stderr);
  const lines = marksLines(full.stdout);
  assert.ok(lines.some((line) => /^ +ok +private-marks$/.test(line)), lines.join('\n'));
  assert.match(lines.join('\n'), /^ +note +private-mark-kinds: optional: add your city or your domains too/m);
  for (const line of [...lines, ...marksLines(installed.stdout)]) assert.doesNotMatch(line, /MISSING|missing|may lack|already has what/, line);
  const session = await sandbox.call(['doctor', '--session']);
  said.push(session.stdout, session.stderr);
  assert.deepEqual(marksLines(session.stdout), [], 'a session says nothing about marks that are in place');
  const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout) as { findings: { id: string }[] };
  assert.ok(!json.findings.some((found) => found.id === 'private-marks'), 'no private-marks finding');
  assert.ok(!said.some((text) => /kit|sample/i.test(text)), 'no output holds the name');
  // The positive control: a file with no marks is missing, in both. A shared name is never added.
  sandbox.git('config', 'user.name', 'Test');
  writeFileSync(join(sandbox.home, '.config/yokoten/private-marks'), '# only a comment\n');
  assert.match((await sandbox.call(['doctor'])).stdout, /^ +MISSING private-marks: ~\/\.config\/yokoten\/private-marks is missing or has no marks; run `(npx )?yokoten marks add`/m);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /private-marks is missing or has no marks/);
});

test('doctor: the plugin, when on, stands in for install', async () => {
  const sandbox = makeSandbox();
  const machine = async () => (await sandbox.call(['doctor'])).stdout;
  assert.match(await machine(), /MISSING session-doctor: sessions do not start with doctor; run `yokoten install`, or install the Claude Code plugin/);
  assert.match(await machine(), /MISSING runtime: no runtime installed/);
  mkdirSync(join(sandbox.home, '.claude'));
  const settings = (enabledPlugins: unknown) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }));
  settings({ 'yokoten@yokoten': false });
  assert.match(await machine(), /MISSING session-doctor/, 'off is off');
  settings({ 'yokoten@yokoten': true });
  const out = await machine();
  assert.match(out, /ok {6}session-doctor/);
  assert.match(out, /ok {6}runtime/);
  assert.match(out, /^ +(done|to do|next) +skills$/m);
  assert.doesNotMatch(out, /skills: the yokoten skills are not in/);
  assert.doesNotMatch(out, /plugin-and-install/, 'no install pieces, no note');
  writeFileSync(join(sandbox.home, '.claude', 'settings.json'), 'not json');
  assert.match(await machine(), /MISSING session-doctor/, 'a broken settings file enables nothing');
});

test('doctor: the plugin and install both on is a note that says to uninstall (#300)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install'])).status, 0);
  const file = join(sandbox.home, '.claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), enabledPlugins: { 'yokoten@yokoten': true } }));
  const out = (await sandbox.call(['doctor'])).stdout;
  assert.match(out, /^ {2}note {4}plugin-and-install: the yokoten plugin is on, and `yokoten install` put these here too: the SessionStart doctor and the command guard in ~\/\.claude\/settings\.json; the skills in ~\/\.claude\/skills and ~\/\.agents\/skills; the agents in ~\/\.claude\/agents; ~\/\.local\/share\/yokoten; remove the home copy with `yokoten uninstall`/m);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /^yokoten: the yokoten plugin is on, and `yokoten install` put these here too: .*Remove the home copy with `yokoten uninstall`/m);
  // An older runtime from install, with the plugin on: remove it, never install again.
  writeFileSync(join(sandbox.home, '.local/share/yokoten/VERSION'), '0.0.1\n');
  assert.match((await sandbox.call(['doctor'])).stdout, /MISSING runtime: the installed runtime is 0\.0\.1, this yokoten is \S+; remove it with `yokoten uninstall`; the plugin brings its own/);
  // After uninstall the note is gone, and the plugin stands in for everything.
  assert.equal((await sandbox.call(['uninstall'])).status, 0);
  const after = (await sandbox.call(['doctor'])).stdout;
  assert.doesNotMatch(after, /plugin-and-install/);
  assert.match(after, /ok {6}runtime/);
  assert.match(after, /ok {6}session-doctor/);
});

test('doctor: a skills-only copy alone is a note that names the duplicate (#540)', async () => {
  const sandbox = makeSandbox();
  const settings = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  const skill = readFileSync(join(ROOT, 'kit/user/skills/inspect/SKILL.md'), 'utf8');
  const copy = join(sandbox.home, '.agents/skills/inspect/SKILL.md');
  mkdirSync(dirname(copy), { recursive: true });
  writeFileSync(copy, skill);
  const out = (await sandbox.call(['doctor'])).stdout;
  assert.match(out, /^ {2}note {4}plugin-and-install: the yokoten plugin is on, and a skills-only copy is here too: the skills in ~\/\.agents\/skills; remove the home copy with `yokoten uninstall`; the plugin brings its own/m);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /a skills-only copy is here too/);
});

test('doctor: a home install and a project copy each get their own fix (#540)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['install'])).status, 0);
  const file = join(sandbox.home, '.claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), enabledPlugins: { 'yokoten@yokoten': true } }));
  sandbox.write('.agents/skills/dispatch/SKILL.md', readFileSync(join(ROOT, 'kit/user/skills/dispatch/SKILL.md'), 'utf8'));
  sandbox.write('.claude/skills/rca/SKILL.md', readFileSync(join(ROOT, 'kit/user/skills/rca/SKILL.md'), 'utf8'));
  const out = (await sandbox.call(['doctor'])).stdout;
  assert.match(out, /^ {2}note {4}plugin-and-install: the yokoten plugin is on, and `yokoten install` put these here too: the SessionStart doctor and the command guard in ~\/\.claude\/settings\.json; the skills in ~\/\.claude\/skills and ~\/\.agents\/skills; the agents in ~\/\.claude\/agents; ~\/\.local\/share\/yokoten; `npx skills add` put a copy in this project too: `\.agents\/skills\/dispatch` and `\.claude\/skills\/rca`; remove the home copy with `yokoten uninstall` and delete `\.agents\/skills\/dispatch` and `\.claude\/skills\/rca`; the plugin brings its own/m);
  assert.doesNotMatch(out, /delete `\.agents\/skills`(?!\/)|delete `\.claude\/skills`(?!\/)/, 'the fix never names a whole skills folder');
});

test('doctor: a runtime-only home with a project copy says only which folder to delete (#540)', async () => {
  const sandbox = makeSandbox();
  const settings = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  mkdirSync(join(sandbox.home, '.local/share/yokoten'), { recursive: true });
  sandbox.write('.agents/skills/rca/SKILL.md', readFileSync(join(ROOT, 'kit/user/skills/rca/SKILL.md'), 'utf8'));
  const out = (await sandbox.call(['doctor'])).stdout;
  assert.match(out, /^ {2}note {4}plugin-and-install: the yokoten plugin is on, and `yokoten install` put these here too: ~\/\.local\/share\/yokoten; `npx skills add` put a copy in this project too: `\.agents\/skills\/rca`; delete `\.agents\/skills\/rca`; the plugin brings its own/m);
  assert.doesNotMatch(out, /plugin-and-install: .*remove the home copy/, 'the runtime is not a skill copy, so nothing at home is called one');
});

test('doctor: a project skills-only copy is named, and the fix deletes it (#540)', async () => {
  const sandbox = makeSandbox();
  const settings = join(sandbox.home, '.claude', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  const skill = readFileSync(join(ROOT, 'kit/user/skills/rca/SKILL.md'), 'utf8');
  sandbox.write('.agents/skills/rca/SKILL.md', skill);
  const out = (await sandbox.call(['doctor'])).stdout;
  assert.match(out, /^ {2}note {4}plugin-and-install: the yokoten plugin is on, and `npx skills add` put a copy in this project too: `\.agents\/skills\/rca`; delete `\.agents\/skills\/rca`; the plugin brings its own/m);
});

// #211: Codex's and Gemini CLI's user hooks, only once the CLI's folder exists; a note
// that never changes the exit code, and ok after `install`.
test('doctor: notes the Codex and Gemini CLI user hooks when that CLI is used (#211)', async () => {
  for (const [agent, dir, file] of [['codex', '.codex', 'hooks.json'], ['gemini', '.gemini', 'settings.json']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const before = await sandbox.call(['doctor']);
    assert.doesNotMatch(before.stdout, new RegExp(name), `${agent}: no ~/${dir}, no line`);
    mkdirSync(join(sandbox.home, dir));
    const noted = await sandbox.call(['doctor']);
    assert.match(noted.stdout, new RegExp(`^  note {4}${name}: no session-start doctor and no command guard in ~/${dir}/${file}; \`yokoten install\` adds them$`, 'm'));
    assert.equal(noted.status, before.status, `${agent}: a note never changes the exit code`);
    const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout);
    assert.ok(json.notes.some((n: { id: string }) => n.id === name), `${agent}: a note in --json, under its own id`);
    assert.ok(!json.notes.some((n: { id: string; what: string }) => n.id === `${agent}-hook` && n.what.includes(`~/${dir}`)), `${agent}: not under the project rule's id`);
    assert.ok(!json.findings.some((n: { id: string }) => n.id === name), `${agent}: not a finding`);
    // The folder exists by now, so install writes the hooks.
    assert.equal((await sandbox.call(['install'])).status, 0);
    assert.match((await sandbox.call(['doctor'])).stdout, new RegExp(`ok {6}${name}\\n`));
    const explain = (await sandbox.call(['explain', `${agent}-hook`])).stdout;
    assert.match(explain, /tool-call guard and stop check/);
    assert.match(explain, agent === 'codex' ? /a Stop hook/ : /an AfterAgent hook/);
    assert.doesNotMatch(explain, new RegExp(`~/${dir}`), `${agent}-hook is about the project only`);
    const explainUser = (await sandbox.call(['explain', name])).stdout;
    assert.match(explainUser, /session-start doctor and command guard/);
    assert.match(explainUser, new RegExp(`~/${dir}/${file}`));
  }
});

// #211 review: doctor compares each user hook with what install writes, so one missing,
// an old one, or a file it can't read each says so; a ~/.codex that is a file is no folder.
test('doctor: a missing, out-of-date or unreadable Codex or Gemini CLI user hook (#211)', async () => {
  for (const [agent, dir, file, guardEvent] of [['codex', '.codex', 'hooks.json', 'PreToolUse'], ['gemini', '.gemini', 'settings.json', 'BeforeTool']]) {
    const sandbox = makeSandbox();
    const name = `${agent}-user-hook`;
    const path = join(sandbox.home, dir, file);
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = (text: string) => new RegExp(`^  note {4}${name}: ${escape(text)}$`, 'm');
    mkdirSync(join(sandbox.home, dir));
    assert.equal((await sandbox.call(['install'])).status, 0);
    const written = readFileSync(path, 'utf8');
    type Hooks = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const edit = (change: (s: Hooks) => void) => {
      const settings: Hooks = JSON.parse(written);
      change(settings);
      writeFileSync(path, JSON.stringify(settings));
    };
    // Only the guard missing: its exact line, and "it".
    edit((s) => delete s.hooks[guardEvent]);
    assert.match((await sandbox.call(['doctor'])).stdout, line(`no command guard in ~/${dir}/${file}; \`npx yokoten install\` adds it`));
    // The doctor hook from an older runtime path: out of date, not ok.
    edit((s) => {
      const hook = s.hooks.SessionStart[0].hooks[0];
      hook.command = hook.command.replace('.local/share/yokoten', '.yokoten');
    });
    assert.match((await sandbox.call(['doctor'])).stdout, line(`the session-start doctor in ~/${dir}/${file} is out of date; \`npx yokoten install\` updates it`));
    // The guard on another matcher: out of date too.
    edit((s) => {
      s.hooks[guardEvent][0].matcher = 'other';
    });
    assert.match((await sandbox.call(['doctor'])).stdout, line(`the command guard in ~/${dir}/${file} is out of date; \`npx yokoten install\` updates it`));
    assert.match((await sandbox.call(['install'])).stdout, /^updated the .* command guard in /m);
    assert.match((await sandbox.call(['doctor'])).stdout, new RegExp(`^  ok {6}${name}$`, 'm'));
    // A file that won't parse: can't read it, never "missing".
    writeFileSync(path, '{ not json');
    const unread = await sandbox.call(['doctor']);
    assert.match(unread.stdout, line(`can't read ~/${dir}/${file}; make it valid JSON, then run \`npx yokoten install\``));
    assert.doesNotMatch(unread.stdout, new RegExp(`${name}: no `));
    // A ~/.codex that is a file: not a folder, so doctor says nothing and install skips it.
    rmSync(join(sandbox.home, dir), { recursive: true });
    writeFileSync(join(sandbox.home, dir), 'a file');
    assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, new RegExp(name));
    const install = await sandbox.call(['install']);
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, new RegExp(`^skipped .*: ~/\\${dir} not found`, 'm'));
    assert.equal(readFileSync(join(sandbox.home, dir), 'utf8'), 'a file');
  }
});

// #198: a plugin older than this yokoten is a note, in full doctor and in a session. A fake
// install in the fake HOME, laid out as Claude Code keeps it; the real one is never read.
test('doctor: notes an installed plugin older than this yokoten (#198)', async () => {
  const sandbox = makeSandbox();
  const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const plugins = join(sandbox.home, '.claude', 'plugins');
  const folder = join(plugins, 'cache', 'yokoten', 'yokoten', 'abc123');
  mkdirSync(folder, { recursive: true });
  const enable = (on: boolean) => writeFileSync(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': on } }));
  const install = (entry: object) => writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: folder, version: 'abc123', ...entry }] } }));
  const pluginVersion = (v: string) => writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'yokoten', version: v }));
  const full = async () => (await sandbox.call(['doctor'])).stdout;
  const olderNote = /the yokoten plugin is older than this yokoten/;

  // Positive control: an old plugin is noted, with the one command, and doctor does not fail on it.
  enable(true);
  install({ gitCommitSha: 'abc123' });
  pluginVersion('0.0.1');
  const lines = (await full()).split('\n');
  const line = `  note    plugin: the yokoten plugin is older than this yokoten (0.0.1 < ${version}); update it: \`claude plugin update yokoten@yokoten\`, then restart Claude Code`;
  assert.ok(lines.includes(line), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('MISSING plugin')));
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, olderNote);
  const json = JSON.parse((await sandbox.call(['doctor', '--json'])).stdout);
  const jsonNote = json.notes.find((n: { what: string }) => olderNote.test(n.what));
  assert.ok(jsonNote, 'a note in JSON');
  assert.equal(jsonNote.id, 'plugin-version', 'its own rule, so `yokoten explain` tells the right thing');
  assert.match(jsonNote.docs, /#the-claude-code-plugin$/);
  assert.match((await sandbox.call(['explain', jsonNote.id])).stdout, /plugin is not older than the yokoten/);
  assert.ok(!json.findings.some((f: { what: string }) => olderNote.test(f.what)), 'not a finding');

  // The same version, or a newer one: nothing.
  pluginVersion(version);
  assert.doesNotMatch(await full(), olderNote);
  pluginVersion('9999.0.0');
  assert.doesNotMatch(await full(), olderNote);
  // Off in the settings: the plugin does not run, so its age does not matter.
  pluginVersion('0.0.1');
  enable(false);
  assert.doesNotMatch(await full(), olderNote);
  enable(true);
  // A project install for another project is not this one's.
  install({ scope: 'project', projectPath: join(sandbox.home, 'elsewhere') });
  assert.doesNotMatch(await full(), olderNote);
  // No install file, or an odd one: no note, no crash.
  for (const text of [null, 'not json', '{"plugins": []}', '{"plugins": {"yokoten@yokoten": "odd"}}', '{"plugins": {"yokoten@yokoten": [null, 7]}}']) {
    rmSync(join(plugins, 'installed_plugins.json'), { force: true });
    if (text !== null) writeFileSync(join(plugins, 'installed_plugins.json'), text);
    const result = await sandbox.call(['doctor']);
    assert.ok(result.stdout.includes('machine:'), `${text}: doctor ran to the end`);
    assert.doesNotMatch(result.stdout, olderNote, String(text));
    assert.doesNotMatch(result.stderr, /Error/, String(text));
  }
  install({ gitCommitSha: 'abc123' });
  rmSync(join(folder, 'package.json'));
  assert.doesNotMatch(await full(), olderNote, 'outside a yokoten checkout, a commit alone tells nothing');
});

test('doctor: in a yokoten checkout, a plugin commit behind the default branch is a note (#198)', async () => {
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
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote, 'the plugin is main');
  // The plugin is main's tip and doctor runs on a feature branch ahead of main: up to date,
  // though HEAD descends from it. An update could not help, so nothing.
  sandbox.git('checkout', '-q', '-b', 'feature');
  commit('two');
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote, 'the plugin is main, HEAD is ahead');
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, olderNote);
  // Positive control: main moves on, so the plugin is one commit behind it, on any branch.
  sandbox.git('checkout', '-q', 'main');
  const tip = commit('three');
  sandbox.git('checkout', '-q', 'feature');
  const match = (await sandbox.call(['doctor'])).stdout.match(olderNote);
  assert.deepEqual(match?.slice(1), [first.slice(0, 12), tip.slice(0, 12)]);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, olderNote);
  // A commit this repo doesn't know: can't tell, so nothing.
  install('0'.repeat(40));
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote);
  // No origin/HEAD, origin/main or main: no default branch to compare with, so nothing.
  install(first);
  sandbox.git('branch', '-q', '-m', 'main', 'trunk');
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, olderNote, 'no main ref');
});

test('doctor: counts merge commits whose time is not UTC, and prints one command that shows them (#760)', async () => {
  const withMerge = (zone: string | null) => {
    const sandbox = makeSandbox();
    sandbox.write('one.md', 'one\n');
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'one');
    sandbox.git('checkout', '-qb', 'topic');
    sandbox.write('two.md', 'two\n');
    sandbox.git('add', '.');
    sandbox.git('commit', '-qm', 'two');
    sandbox.git('checkout', '-q', 'main');
    const extra = zone === null ? {} : { GIT_AUTHOR_DATE: `2026-10-18T09:00:00${zone}`, GIT_COMMITTER_DATE: `2026-10-18T09:00:00${zone}` };
    const merge = spawnSync('git', ['merge', '--no-ff', '-q', '-m', 'merge topic', 'topic'], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra }, encoding: 'utf8' });
    assert.equal(merge.status, 0, merge.stderr);
    return sandbox;
  };

  // Positive control: one merge in another zone is counted, and the zone itself is not printed.
  const zoned = withMerge('+0900');
  const out = (await zoned.call(['doctor'])).stdout;
  const line = out.split('\n').find((text) => text.includes('time-zone:'));
  assert.ok(line, out);
  assert.match(line, /^ {2}note {4}time-zone: 1 merge commit\(s\) among the last 200 commits on the default branch carry an author or committer time zone other than UTC; see them with /);
  assert.doesNotMatch(out, /\+0900/, 'the time zone value is never printed');
  // The command doctor prints really shows the merge commit.
  const command = /`(git log[^`]+)`/.exec(line)?.[1];
  assert.ok(command, line);
  if (process.platform !== 'win32') {
    const shown = execFileSync('sh', ['-c', command], { cwd: zoned.repo, env: zoned.env, encoding: 'utf8' });
    assert.match(shown, new RegExp(execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: zoned.repo, env: zoned.env, encoding: 'utf8' }).trim()));
  }

  // All UTC: no line at all.
  const plain = withMerge(null);
  assert.doesNotMatch((await plain.call(['doctor'])).stdout, /time-zone:/);
});

test('doctor: the time zone count and the command it prints cover the same commits (#760, #775)', async () => {
  const sandbox = makeSandbox();
  const when = '2026-09-01T00:00:00+0000';
  const env = { ...sandbox.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  const commit = (message: string) => execFileSync('git', ['commit', '--allow-empty', '-q', '-m', message], { cwd: sandbox.repo, env });
  const merge = (zone: string) => {
    execFileSync('git', ['checkout', '-q', '-B', 'topic'], { cwd: sandbox.repo, env });
    commit('on topic');
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: sandbox.repo, env });
    const zoned = { ...env, GIT_AUTHOR_DATE: `2026-09-02T00:00:00${zone}`, GIT_COMMITTER_DATE: `2026-09-02T00:00:00${zone}` };
    execFileSync('git', ['merge', '--no-ff', '-q', '-m', `merge ${zone}`, 'topic'], { cwd: sandbox.repo, env: zoned });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sandbox.repo, env, encoding: 'utf8' }).trim();
  };
  // 216 commits on main: an old merge at #16, outside the last 200, and a new one at #216.
  for (let i = 0; i < 15; i++) commit(`plain ${i}`);
  const old = merge('+0900');
  for (let i = 0; i < 199; i++) commit(`plain ${i}`);
  const recent = merge('+0900');

  const out = (await sandbox.call(['doctor'])).stdout;
  const line = out.split('\n').find((text) => text.includes('time-zone:'));
  assert.ok(line, out);
  assert.match(line, /1 merge commit\(s\) among the last 200 commits on the default branch/);
  // The printed command shows exactly that one merge, not the older one outside the window.
  const command = /`(git log[^`]+)`/.exec(line)?.[1];
  assert.ok(command, line);
  if (process.platform !== 'win32') {
    const shown = execFileSync('sh', ['-c', command], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' }).trim();
    const lines = shown === '' ? [] : shown.split('\n');
    assert.equal(lines.length, 1, shown);
    assert.match(shown, new RegExp(recent.slice(0, 7)), 'the newer merge is shown');
    assert.doesNotMatch(shown, new RegExp(old.slice(0, 7)), 'the older merge is outside the window');
  }
});

test('privacyNotes: the mailmap, and the kinds of mark yokoten cannot find; never a value (#390)', () => {
  const home = makeTempDir('yokoten-privacy-');
  const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const notes = () => privacyNotes(env, null).map((note) => `${note.name}: ${note.finding.what}; ${note.finding.fix}`);
  // No marks at all: the private-marks check says so, and no offer adds a second answer (#522).
  assert.deepEqual(notes(), ['mailmap: git log and git show print your name and email as they are; run `yokoten install`; it writes ~/.config/yokoten/mailmap and sets `git config --global mailmap.file ~/.config/yokoten/mailmap`, so git prints a private address in place of your email']);
  execFileSync('git', ['config', '--global', 'mailmap.file', '~/.config/yokoten/mailmap'], { env: { ...process.env, ...env } });
  mkdirSync(join(home, '.config', 'yokoten'), { recursive: true });
  // Only the name install found: the other kinds are an optional offer. The name is not asked for (#434).
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), '# added by yokoten from this machine: git name\nJane Example\n');
  assert.deepEqual(notes(), ["private-mark-kinds: optional: add your city or your domains too; yokoten can't find them on its own; run `yokoten marks add` and type one; it is not shown"]);
  writeFileSync(join(home, '.config', 'yokoten', 'private-marks'), 'Jane Example\nFakeville\njanex.dev\n');
  assert.deepEqual(notes(), []);
  execFileSync('git', ['config', '--global', 'mailmap.file', '/elsewhere/mailmap'], { env: { ...process.env, ...env } });
  assert.deepEqual(notes(), ['mailmap: git uses your own mailmap file, not ~/.config/yokoten/mailmap; add the lines of ~/.config/yokoten/mailmap to your file']);
  // Another agent on this machine: its output is not filtered, and the note says how to opt in.
  mkdirSync(join(home, '.codex'));
  assert.equal(notes()[0], 'private-output: only Claude Code hides your details in command output; other agents show it as it is; to stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json');
  // Muse alone is enough too, before the project has any yokoten hook (#549).
  rmSync(join(home, '.codex'), { recursive: true, force: true });
  mkdirSync(join(home, '.config', 'muse'), { recursive: true });
  assert.equal(notes()[0], 'private-output: only Claude Code hides your details in command output; other agents show it as it is; to stop those commands there instead, set "privacy": { "output": "stop" } in yokoten.json');
  assert.equal(privacyNotes(env, null, 'stop').length, 1, 'with "stop", only the mailmap note is left');
  rmSync(home, { recursive: true, force: true });
});

// #392: lessons from other projects wait in ~/.config/yokoten/upstream. Only yokoten's own
// repo, found by its package name, hears about them; another repo hears nothing.
test('doctor: a note when no yokoten on the PATH runs the installed copy (#433)', () => {
  const home = makeTempDir('yokoten-launcher-');
  const runtime = join(home, '.local', 'share', 'yokoten');
  const env = { HOME: home, PATH: dirname(process.execPath) };
  // No runtime installed: install's own checks say so, not this note.
  assert.equal(launcherCheck(env), null);
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'yokoten.ts'), '\n');
  const note = launcherCheck(env);
  assert.equal(note?.what, 'the yokoten launcher is not on your PATH, so a bare yokoten command is not found');
  // No launcher yet: the one fix is install, run the way that works now. No line says to type the runtime's path (#500).
  assert.match(note?.fix ?? '', /^run \`npx yokoten install\`; it puts a launcher in .*\.local[\\/]bin/);
  // The launcher in ~/.local/bin, with that folder on the PATH: no note.
  setUpLauncher(env, runtime, home);
  const off = launcherCheck(env);
  assert.notEqual(off, null, 'a launcher off the PATH still gets the note');
  // The launcher is there: the fix is the one line for the PATH, and says npx works meanwhile.
  assert.match(off?.fix ?? '', /^add this line to your shell profile .* then open a new terminal: export PATH=.*; until then, \`npx yokoten\` runs yokoten$/);
  assert.doesNotMatch(`${off?.what} ${off?.fix} ${off?.why}`, /yokoten\.ts/);
  assert.equal(launcherCheck({ ...env, PATH: `${launcherDir(home)}:${env.PATH}` }), null);
  // With the plugin on, its own commands are used: no note.
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  assert.equal(launcherCheck(env), null);
});

// #500: after a fresh install, every line that names a command uses one way to run yokoten.
test('doctor: with the launcher off the PATH, every command in the text is `npx yokoten`; on the PATH, `yokoten` (#500)', () => {
  const home = makeTempDir('yokoten-one-way-');
  const root = join(home, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  const runtime = join(home, '.local', 'share', 'yokoten');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin', 'yokoten.ts'), '\n');
  const gitDir = dirname(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).trim().split('\n')[0]);
  const env = { HOME: home, PATH: [dirname(process.execPath), gitDir].join(delimiter), YOKOTEN_TEMP_DIRS: '' };
  setUpLauncher(env, runtime, home);
  const run = (e: Record<string, string>, session = false) => doctor(root, { env: e, config: DEFAULTS, session, gh: () => { throw new Error('no network'); } });
  for (const session of [false, true]) {
    const text = JSON.stringify(run(env, session));
    assert.doesNotMatch(text, /`yokoten[ `]/, 'no bare yokoten command while the launcher is off the PATH');
    assert.match(text, /`npx yokoten init`/);
    assert.doesNotMatch(text, /node [^"]*yokoten\.ts install/);
  }
  const full = run(env).lines.join('\n');
  assert.match(full, /note +command: the yokoten launcher is not on your PATH.*until then, `npx yokoten` runs yokoten/);
  // The launcher is on the PATH: the messages stay as written, and there is no note.
  const onPath = run({ ...env, PATH: `${launcherDir(home)}${delimiter}${env.PATH}` }).lines.join('\n');
  assert.match(onPath, /`yokoten init`/);
  assert.doesNotMatch(onPath, /npx yokoten|launcher is not on your PATH/);
  // Run by npx with nothing installed: `npx yokoten` too.
  const bare = makeTempDir('yokoten-npx-');
  const viaNpx = doctor(root, { env: { HOME: bare, npm_command: 'exec', PATH: env.PATH, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, gh: () => { throw new Error('no network'); } });
  assert.match(viaNpx.lines.join('\n'), /`npx yokoten init`/);
});
