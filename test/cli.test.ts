// End to end: the CLI in throwaway git repos, the way a hook or CI runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'yokoten.ts');
const at = '@';

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  // A clean environment: no real HOME, no real marks, no role, and commit times in UTC
  // whatever the machine's time zone (#40).
  const env = { PATH: process.env.PATH, HOME: home, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', `1+test${at}users.noreply.github.com`);
  const run = (args: string[], { input, cwd = repo, extra = {} }: { input?: string; cwd?: string; extra?: Record<string, string> } = {}) => spawnSync('node', [CLI, ...args], { cwd, env: { ...env, ...extra }, input, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  return { home, repo, env, git, run, write };
}

test('hook: blocks with exit 2 and a reason, allows with exit 0', () => {
  const s = sandbox();
  const call = (tool_input: object, extra?: Record<string, string>) => s.run(['hook'], { input: JSON.stringify({ cwd: s.repo, tool_input }), extra });
  let r = call({ command: 'git push --tags' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /owner decides when to release/);
  assert.equal(call({ command: 'git status' }).status, 0);
  assert.equal(call({ file_path: join(s.repo, 'AGENTS.md') }).status, 0);
  r = call({ file_path: join(s.repo, 'AGENTS.md') }, { YOKOTEN_ROLE: 'worker' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /lead-only/);
  // A worker subagent is a worker even in a lead session.
  r = s.run(['hook'], { input: JSON.stringify({ cwd: s.repo, agent_type: 'worker', tool_input: { file_path: 'CLAUDE.md' } }) });
  assert.equal(r.status, 2);
  // The user-level guard leaves files to the project.
  r = s.run(['hook', '--commands-only'], { input: JSON.stringify({ cwd: s.repo, tool_input: { file_path: 'CLAUDE.md' } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(r.status, 0);
  assert.equal(s.run(['hook'], { input: 'not json' }).status, 0);
});

test('hook: a repo reached through a symlink gets the same file rules (#1)', () => {
  const s = sandbox();
  const link = join(s.home, 'link');
  symlinkSync(s.repo, link);
  const call = (file_path: string) => s.run(['hook'], { input: JSON.stringify({ cwd: link, tool_input: { file_path } }), extra: { YOKOTEN_ROLE: 'worker' } });
  assert.equal(call(join(link, 'AGENTS.md')).status, 2, 'absolute path through the link');
  assert.equal(call('AGENTS.md').status, 2, 'relative to a cwd through the link');
  assert.equal(call(join(link, '.github', 'new', 'x.yml')).status, 2, 'a file in a folder that does not exist yet');
  assert.equal(call(join(s.home, 'elsewhere.md')).status, 0, 'outside the repo');
});

test('check --staged: stops a commit with a personal email or a private mark', () => {
  const s = sandbox();
  const marks = join(s.home, 'marks');
  writeFileSync(marks, 'mycity\n');
  s.write('src/a.md', 'fine\n');
  s.git('add', '.');
  assert.equal(s.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } }).status, 0);
  s.write('src/b.md', `write to me${at}gmail.com\nI live in MyCity\n`);
  s.git('add', '.');
  const r = s.run(['check', '--staged'], { extra: { YOKOTEN_PRIVATE_MARKS: marks } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/b\.md:1: an email/);
  assert.match(r.stderr, /src\/b\.md:2: matches a line of your private-marks file/);
  assert.ok(!/mycity/i.test(r.stderr));
});

test('check --staged: stops a commit whose time carries a time zone, never printing it (#40)', () => {
  const s = sandbox();
  s.write('a.md', 'fine\n');
  s.git('add', '.');
  const zoned = { GIT_AUTHOR_DATE: '2026-10-18T09:00:00+0700' };
  let r = s.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries your time zone/);
  assert.ok(!/0700/.test(r.stderr), 'the offset is never printed');
  assert.equal(s.run(['check', '--staged'], { extra: { GIT_AUTHOR_DATE: '2026-10-18T02:00:00+0000' } }).status, 0);
  // A project can turn it off.
  s.write('yokoten.json', JSON.stringify({ privacy: { utc: false } }));
  s.git('add', '.');
  r = s.run(['check', '--staged'], { extra: zoned });
  assert.equal(r.status, 0, r.stderr);
});

test('check --history: counts commits with a time zone, as a note that does not fail (#40)', () => {
  const s = sandbox();
  s.git('commit', '-q', '--allow-empty', '-m', 'utc');
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'zoned'], { cwd: s.repo, env: { ...s.env, TZ: 'Asia/Tokyo' } });
  const r = s.run(['check', '--history']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: 1 commit\(s\) record a time zone other than UTC/);
});

test('check --history: finds what a later commit deleted, and a personal author email', () => {
  const s = sandbox();
  const token = `${'gh'}p_${'x7Y2k9'.repeat(6)}`;
  s.write('notes.md', `server ${[10, 1, 2, 3].join('.')}\ntoken ${token}\n`);
  s.git('add', '.');
  s.git('commit', '-qm', 'add notes');
  s.git('rm', '-q', 'notes.md');
  s.git('commit', '-qm', 'remove notes');
  s.git('-c', `user.email=me${at}gmail.com`, 'commit', '-q', '--allow-empty', '-m', 'oops');
  assert.equal(s.run(['check']).status, 0, 'the tree today is clean');
  const r = s.run(['check', '--history']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /notes\.md @ blob \w+:1: an IP address/);
  assert.match(r.stderr, /notes\.md @ blob \w+:2: a secret \(GitHub token\)/, 'a secret deleted later (#8)');
  assert.ok(!r.stderr.includes(token), 'the secret is never printed');
  assert.match(r.stderr, /\(author\/committer\):1: an email/);
});

test('init: adds the practices, keeps what is there, and doctor then finds nothing missing', () => {
  const s = sandbox();
  s.write('AGENTS.md', '# our own rules\n');
  let r = s.run(['init']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept AGENTS\.md/);
  assert.match(r.stdout, /wrote \.githooks\/pre-commit/);
  assert.equal(readFileSync(join(s.repo, 'AGENTS.md'), 'utf8'), '# our own rules\n');
  assert.ok(statSync(join(s.repo, '.githooks', 'pre-commit')).mode & 0o100);
  const workflow = readFileSync(join(s.repo, '.github/workflows/yokoten.yml'), 'utf8');
  assert.match(workflow, /node \.yokoten\/bin\/yokoten\.ts check/);
  assert.match(workflow, /persist-credentials: false/, 'the hardened workflow (#36)');
  assert.ok(existsSync(join(s.repo, '.yokoten', 'VERSION')));
  assert.equal(s.git('config', 'core.hooksPath').stdout.trim(), '.githooks');
  // Again: nothing changes.
  r = s.run(['init']);
  assert.match(r.stdout, /same the tool-call hook/);
  assert.match(r.stdout, /same TZ=UTC for agent sessions/);
  const settings = JSON.parse(readFileSync(join(s.repo, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.env.TZ, 'UTC', 'agent commits record no time zone (#40)');
  // The pre-commit hook runs the vendored check on a real commit.
  s.git('add', '.');
  const commit = s.git('commit', '-qm', 'adopt yokoten');
  assert.equal(commit.status, 0, commit.stderr);
  s.write('leak.md', `me${at}gmail.com\n`);
  s.git('add', 'leak.md');
  assert.notEqual(s.git('commit', '-qm', 'leak').status, 0);
  s.write('leak.md', `${'AK'}IA${'Q7W3R9T2Y5Q7W3R9'}\n`);
  s.git('add', 'leak.md');
  const secret = s.git('commit', '-qm', 'leak');
  assert.notEqual(secret.status, 0, 'a secret is refused too (#8)');
  assert.match(secret.stderr, /leak\.md:1: a secret \(AWS access key id\)/);
  s.git('reset', '-q', 'leak.md');
  r = s.run(['doctor', '--session']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /missing \d+ practice/);
});

test('doctor --session: names what is missing, and respects notNow', () => {
  const s = sandbox();
  let r = s.run(['doctor', '--session']);
  assert.equal(r.status, 0, 'a session always starts');
  assert.match(r.stdout, /missing 5 practice\(s\)/);
  assert.match(r.stdout, /yokoten skill/);
  s.write('yokoten.json', JSON.stringify({ notNow: { ci: 'no remote yet' } }));
  r = s.run(['doctor', '--session']);
  assert.match(r.stdout, /missing 4 practice\(s\)/);
  assert.doesNotMatch(r.stdout, /- ci:/);
  // Outside a repo it says nothing (unless yokoten itself is broken).
  r = s.run(['doctor', '--session'], { cwd: s.home });
  assert.equal(r.stdout, '');
});

test('install: skills, agents and hooks once, the user\'s own files untouched', () => {
  const s = sandbox();
  const claude = join(s.home, '.claude');
  const shared = join(s.home, '.agents');
  mkdirSync(join(claude, 'agents'), { recursive: true });
  writeFileSync(join(claude, 'agents', 'reviewer.md'), 'my own reviewer\n');
  // The user's own skill in the shared folder, with a kit skill's name.
  mkdirSync(join(shared, 'skills', 'rca'), { recursive: true });
  writeFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'my own rca\n');
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }));
  let r = s.run(['install']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kept \(yours\) agent reviewer/);
  assert.equal(readFileSync(join(claude, 'agents', 'reviewer.md'), 'utf8'), 'my own reviewer\n');
  // Every skill in both folders: Claude Code's, and the shared one other agents read (#29).
  const kitSkills = readdirSync(join(s.home, '.local/share/yokoten/kit/user/skills'));
  assert.ok(kitSkills.length > 0);
  for (const name of kitSkills) {
    assert.ok(existsSync(join(claude, 'skills', name, 'SKILL.md')), `~/.claude/skills/${name}`);
    assert.ok(existsSync(join(shared, 'skills', name, 'SKILL.md')), `~/.agents/skills/${name}`);
    assert.match(r.stdout, new RegExp(`wrote skill ${name} in ~/\\.claude/skills`));
  }
  assert.match(r.stdout, /kept \(yours\) skill rca in ~\/\.agents\/skills/);
  assert.equal(readFileSync(join(shared, 'skills', 'rca', 'SKILL.md'), 'utf8'), 'my own rca\n');
  assert.ok(!existsSync(join(shared, 'agents')), 'agents stay Claude-only');
  const marks = join(s.home, '.config/yokoten/private-marks');
  assert.equal(statSync(marks).mode & 0o777, 0o600);
  r = s.run(['install']);
  for (const name of kitSkills) assert.match(r.stdout, new RegExp(`same skill ${name} in ~/\\.claude/skills`));
  for (const name of kitSkills.filter((n) => n !== 'rca')) assert.match(r.stdout, new RegExp(`same skill ${name} in ~/\\.agents/skills`));
  assert.match(r.stdout, /kept \(yours\) skill rca in ~\/\.agents\/skills/);
  const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'x');
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  // The installed copy runs on its own.
  const doctor = spawnSync('node', [join(s.home, '.local/share/yokoten/bin/yokoten.ts'), 'doctor', '--session'], { cwd: s.repo, env: s.env, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /private-marks is missing or empty/);
  // The home folder names the machine's user; it never shows (#25).
  for (const out of [r.stdout, doctor.stdout]) assert.ok(!out.includes(s.home), 'output shows the home path');
  assert.match(doctor.stdout, /~\/\.config\/yokoten\/private-marks/);
  // The skills check wants every skill in both folders, and names what is missing.
  const skillsLine = () => s.run(['doctor']).stdout.split('\n').find((l) => / skills/.test(l)) ?? '';
  assert.match(skillsLine(), /^\s+ok\s+skills/);
  rmSync(join(shared, 'skills', 'inspect'), { recursive: true });
  assert.match(skillsLine(), /MISSING skills: not in ~\/\.agents\/skills \(inspect\)/);
});
