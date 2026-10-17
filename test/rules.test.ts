import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../src/rules/config.ts';
import { matcher } from '../src/rules/glob.ts';
import { checkLayout } from '../src/rules/layout.ts';

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

test('layout: a folder over the cap is reported once, the root never', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `docs/f${i}.md`);
  const rootFiles = Array.from({ length: 20 }, (_, i) => `r${i}`);
  const problems = checkLayout([...eight, ...rootFiles, 'docs/sub/a.md'], DEFAULTS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^docs\/ has 9 entries/);
  assert.deepEqual(checkLayout(eight.slice(0, 7), DEFAULTS), []);
});

test('layout: an exempt folder may grow', () => {
  const records = Array.from({ length: 30 }, (_, i) => `docs/records/${i}.md`);
  assert.deepEqual(checkLayout(records, { layout: { maxEntries: 7, exempt: ['docs/records/'] } }), []);
});

test('config: missing file means defaults, a key overrides, bad JSON says where', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  assert.deepEqual(loadConfig(dir).layout, DEFAULTS.layout);
  writeFileSync(join(dir, 'yokoten.json'), JSON.stringify({ layout: { maxEntries: 9 }, notNow: { ci: 'later' } }));
  const c = loadConfig(dir);
  assert.equal(c.layout.maxEntries, 9);
  assert.deepEqual(c.layout.exempt, []);
  assert.equal(c.notNow.ci, 'later');
  assert.deepEqual(c.tests, DEFAULTS.tests);
  writeFileSync(join(dir, 'yokoten.json'), '{ nope');
  assert.throws(() => loadConfig(dir), /^Error: yokoten\.json:/);
});
