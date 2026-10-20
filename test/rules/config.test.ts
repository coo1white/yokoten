// Tests for src/rules/config.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../repo/helpers.ts';
import {
  type Config,
  DEFAULTS,
  findUnknownKeys,
  loadConfig,
  matcher,
} from '../../src/rules/config.ts';
import {
  checkCommand,
  checkEdit,
} from '../../src/rules/guards.ts';
import { loadHookConfig } from '../../src/run/hook.ts';

// #228: each key with the wrong shape, by its key path, and the key it falls back on.
const WRONG_KEYS: [string, Record<string, unknown>][] = [
  ['layout', { layout: 'x' }],
  ['layout.maxEntries', { layout: { maxEntries: '7', exempt: ['docs/records'] } }],
  ['layout.maxEntries', { layout: { maxEntries: 0 } }],
  ['layout.maxEntries', { layout: { maxEntries: 1.5 } }],
  ['layout.exempt', { layout: { exempt: 'docs/records' } }],
  ['tests', { tests: 5 }],
  ['leadOnly', { leadOnly: 'x' }],
  ['leadOnly', { leadOnly: ['ok', 3] }],
  ['privacy', { privacy: [] }],
  ['privacy.allow', { privacy: { allow: 'a' } }],
  ['privacy.skip', { privacy: { skip: [1] } }],
  ['privacy.utc', { privacy: { utc: 'yes' } }],
  ['privacy.skipOwnName', { privacy: { skipOwnName: 'no' } }],
  ['notNow', { notNow: ['ci'] }],
  ['notNow', { notNow: { ci: 1 } }],
  ['allowBuild', { allowBuild: 'dist/**' }],
  ['areas', { areas: 'doctor' }],
  ['translations', { translations: true }],
  ['translations.fail', { translations: { fail: 'no' } }],
  ['commands', { commands: 'python3' }],
  ['commands', { commands: { block: ['python3'] } }],
];

test('glob: a slash anchors at the root, no slash matches in any folder', () => {
  const m = (g: string, p: string) => matcher([g])(p);
  assert.ok(m('test/**', 'test/a/b.ts'));
  assert.ok(!m('test/**', 'src/test/a.ts'));
  assert.ok(m('*.test.*', 'src/deep/a.test.ts'));
  assert.ok(m('.github/**', '.github/workflows/ci.yml'));
  assert.ok(!m('.github/**', 'kit/.github/x'));
  assert.ok(m('src/**/x.ts', 'src/x.ts'));
  assert.ok(m('src/**/x.ts', 'src/a/b/x.ts'));
  assert.ok(m('a?.md', 'ab.md'));
  assert.ok(!m('a?.md', 'a/.md'));
  assert.ok(!m('a.md', 'aXmd'), 'a dot is a dot');
});

test('config: missing file means defaults, a key overrides, bad JSON says where', () => {
  const dir = makeTempDir();
  assert.deepEqual(loadConfig(dir).layout, DEFAULTS.layout);
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ layout: { maxEntries: 9 }, notNow: { ci: 'later' } }));
  const c = loadConfig(dir);
  assert.equal(c.layout.maxEntries, 9);
  assert.deepEqual(c.layout.exempt, []);
  assert.equal(c.notNow.ci, 'later');
  assert.deepEqual(c.tests, DEFAULTS.tests);
  assert.deepEqual(c.allowBuild, []);
  writeFileSync(join(dir, 'yokoten.json'), '{ nope');
  assert.throws(() => loadConfig(dir), /^Error: yokoten\.json:/);
});

test('config: "areas" must be a list of names, or loading says so (#156)', () => {
  const dir = makeTempDir();
  const areas = (value: unknown) => {
    writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ areas: value }));
    return () => loadConfig(dir).areas;
  };
  assert.deepEqual(areas(['cli', 'docs'])(), ['cli', 'docs'], 'the control: a list of names loads');
  assert.deepEqual(areas([])(), []);
  // null is a missing key, as for every key (#228): the default, with no problem.
  assert.deepEqual(areas(null)(), []);
  for (const bad of ['cli', ['cli', ''], ['cli', 1], { cli: true }]) {
    assert.throws(areas(bad), /^Error: yokoten\.json: "areas" must be a list of names, like \["cli", "docs"\]$/, JSON.stringify(bad));
  }
});

test('config: "commands.block" is read, and a wrong shape is a config problem (#192)', () => {
  const dir = makeTempDir();
  assert.deepEqual(loadConfig(dir).commands, { block: {} });
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands: { block: { python3: 'TypeScript only' } } }));
  assert.deepEqual(loadConfig(dir).commands.block, { python3: 'TypeScript only' });
  for (const commands of [[], 'python3', { block: ['python3'] }, { block: { python3: 1 } }, { block: { python3: ' ' } }, { block: { '/usr/bin/python3': 'no' } }, { block: { 'py thon': 'no' } }]) {
    writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands }));
    assert.throws(() => loadConfig(dir), /^Error: yokoten\.json: "commands/, JSON.stringify(commands));
  }
});

test('config: for the hook, a wrong "commands" drops only the block list, said once (#192)', () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ leadOnly: ['secret/**'], commands: { block: ['python3'] } }));
  const lines: string[] = [];
  const config = loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(config.commands.block, {});
  assert.deepEqual(config.leadOnly, ['secret/**'], 'the rest of the file still counts');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^yokoten hook: yokoten\.json "commands" was ignored, .*core checks still run\. yokoten\.json: "commands" must look like/);
  assert.equal(checkCommand('git push --force', { env: {}, config })?.id, 'force-push', 'the core checks still run');
  // Positive control: check and doctor still see it as a config problem.
  assert.throws(() => loadConfig(dir), /^Error: yokoten\.json: "commands/);
  // A good list says nothing; outside a repo, the defaults.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands: { block: { python3: 'TypeScript only' } } }));
  assert.deepEqual(loadHookConfig(dir, (line) => lines.push(line)).commands.block, { python3: 'TypeScript only' });
  assert.equal(loadHookConfig(null, (line) => lines.push(line)), DEFAULTS);
  assert.equal(lines.length, 1);
  // A file that is not one JSON object gives the defaults, said once (#218).
  for (const text of ['{ nope', '[]', 'null']) {
    writeFileSync(join(dir, 'yokoten.json'), text);
    assert.throws(() => loadConfig(dir), /^Error: yokoten\.json: /, text);
    assert.equal(loadHookConfig(dir, (line) => lines.push(line)), DEFAULTS, text);
    assert.match(lines.at(-1) ?? '', /^yokoten hook: yokoten\.json was ignored, so the defaults apply; the core checks still run\. yokoten\.json: \S/);
  }
  assert.equal(lines.length, 4);
});

test('config: a key with the wrong shape is a config error that names it, and the hook uses its default (#228)', () => {
  const dir = makeTempDir();
  for (const [path, file] of WRONG_KEYS) {
    const label = JSON.stringify(file);
    writeFileSync(join(dir, 'yokoten.json'), JSON.stringify(file));
    // check and doctor: a config error that names the key.
    assert.throws(() => loadConfig(dir), (err: Error) => err.message.startsWith(`yokoten.json: "${path.split('.')[0]}`) && err.message.includes(`"${path}"`), label);
    // The hook: one line names the key, that key has its default, and the core checks run.
    const lines: string[] = [];
    const config = loadHookConfig(dir, (line) => lines.push(line));
    assert.equal(lines.length, 1, label);
    assert.ok(lines[0].startsWith(`yokoten hook: yokoten.json "${path}" was ignored, so its default applies; the core checks still run. yokoten.json: `), `${label}: ${lines[0]}`);
    const [key, field] = path.split('.') as [keyof Config, string | undefined];
    const got = config[key] as unknown as Record<string, unknown>;
    const want = DEFAULTS[key] as unknown as Record<string, unknown>;
    assert.deepEqual(field ? got[field] : got, field ? want[field] : want, label);
    assert.equal(checkCommand('git push --force', { env: {}, config })?.id, 'force-push', `${label}: the core checks still run`);
    assert.equal(checkEdit('AGENTS.md', { config, env: { YOKOTEN_ROLE: 'worker' } })?.id, 'lead-only', label);
  }
  // Only the wrong field falls back; the rest of the file still counts.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ layout: { maxEntries: '7', exempt: ['docs/records'] }, tests: ['spec/**'], leadOnly: 'x' }));
  const lines: string[] = [];
  const config = loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(config.layout, { maxEntries: 7, exempt: ['docs/records'] });
  assert.deepEqual(config.tests, ['spec/**']);
  assert.deepEqual(config.leadOnly, DEFAULTS.leadOnly);
  assert.deepEqual(lines.map((line) => /"([^"]+)" was ignored/.exec(line)?.[1]), ['layout.maxEntries', 'leadOnly'], 'one line for each wrong key');
});

test('config: null is a missing key; check lists every wrong key at once; unknown "commands" fields are notes (#228)', () => {
  const dir = makeTempDir();
  // null gives the default, as before #228: no problem, no note, no hook line.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ leadOnly: null, notNow: null, layout: null, privacy: { utc: null }, commands: { block: null } }));
  assert.deepEqual(loadConfig(dir), { ...DEFAULTS, privacy: { ...DEFAULTS.privacy } });
  const lines: string[] = [];
  loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(lines, []);
  assert.deepEqual(findUnknownKeys(dir), []);
  // Three wrong keys: one error names all three, so one run shows them.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ leadOnly: 'x', tests: 5, layout: { maxEntries: '7' } }));
  assert.throws(() => loadConfig(dir), (err: Error) => {
    const [head, ...rest] = err.message.split('\n');
    assert.equal(head, 'yokoten.json: 3 keys have the wrong shape:');
    assert.deepEqual(rest.map((line) => /^- "([^"]+)" must be /.exec(line)?.[1]), ['layout.maxEntries', 'tests', 'leadOnly']);
    return true;
  });
  // A misspelled field under "commands" blocks nothing: a note for check, and the hook stays quiet.
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ commands: { blok: { python3: 'TypeScript only' } } }));
  assert.deepEqual(loadConfig(dir).commands.block, {});
  const quiet: string[] = [];
  loadHookConfig(dir, (line) => quiet.push(line));
  assert.deepEqual(quiet, []);
  assert.deepEqual(findUnknownKeys(dir).map((note) => /^"([^"]+)"/.exec(note.what)?.[1]), ['commands.blok']);
});

test('config: an unknown key is a note, never a problem; yokoten\'s own files and the kit\'s pass with no note (#228)', () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ colour: 'blue', layout: { maxEntry: 9 }, tests: ['spec/**'] }));
  assert.deepEqual(loadConfig(dir).tests, ['spec/**']);
  const lines: string[] = [];
  loadHookConfig(dir, (line) => lines.push(line));
  assert.deepEqual(lines, [], 'the hook says nothing');
  const notes = findUnknownKeys(dir);
  assert.deepEqual(notes.map((note) => [note.id, note.file, /^"([^"]+)"/.exec(note.what)?.[1]]), [['config-key', 'yokoten.json', 'colour'], ['config-key', 'yokoten.json', 'layout.maxEntry']]);
  // A broken file gives no notes: loadConfig reports it.
  writeFileSync(join(dir, 'yokoten.json'), '{ nope');
  assert.deepEqual(findUnknownKeys(dir), []);
  for (const root of [join(import.meta.dirname, '../..'), join(import.meta.dirname, '../..', 'kit', 'project')]) {
    assert.ok(existsSync(join(root, 'yokoten.json')), root);
    const problems: string[] = [];
    loadConfig(root, { onProblem: (problem) => problems.push(problem) });
    assert.deepEqual(problems, [], root);
    assert.deepEqual(findUnknownKeys(root), [], root);
  }
});

test('config: yokoten\'s own areas cover its open work', () => {
  const own = loadConfig(join(import.meta.dirname, '../..'));
  assert.ok(own.areas.includes('doctor') && own.areas.includes('owner'));
  assert.ok(Object.hasOwn(own.commands.block, 'python') && Object.hasOwn(own.commands.block, 'python3'), 'no Python here (#192)');
  assert.deepEqual(DEFAULTS.areas, []);
});
