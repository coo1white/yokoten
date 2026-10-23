// Tests for src/run/check/cases.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHardLinePath, isWatchedTest, parseTests, refusalIds } from '../../../src/run/check/cases.ts';

const FILE = 'test/rules/guards.test.ts';

test('watched tests and hard lines are the paths the check names (#697)', () => {
  assert.equal(isWatchedTest('test/rules/guards.test.ts'), true);
  assert.equal(isWatchedTest('test/run/hook.test.ts'), true);
  assert.equal(isWatchedTest('test/commands/hook-extra.test.ts'), true);
  assert.equal(isWatchedTest('test/run/check/loosen.test.ts'), true);
  assert.equal(isWatchedTest('test/run/check/cases.test.ts'), true);
  assert.equal(isWatchedTest('test/run/checkout.test.ts'), false);
  assert.equal(isWatchedTest('src/rules/guards.ts'), false);
  assert.equal(isHardLinePath('.github/workflows/ci.yml'), true);
  assert.equal(isHardLinePath('.github/CODEOWNERS'), true);
  assert.equal(isHardLinePath('CODEOWNERS'), true);
  assert.equal(isHardLinePath('docs/CODEOWNERS'), true);
  assert.equal(isHardLinePath('docs/records/0026-leads.md'), true);
  assert.equal(isHardLinePath('docs/records/0009-release.md'), false);
  assert.equal(isHardLinePath('README.md'), false);
});

test('a test reads refusals, allows, a table, a skip and a flag (#697)', () => {
  const source = `
const worker = { YOKOTEN_ROLE: 'worker' };
const blocked = (command: string) => command;
const allowed = (command: string) => command;
test('force', () => { blocked('git push --force'); });
test('ok', () => { allowed('git status'); });
test('table', () => {
  for (const command of ['git push --force', 'git push --delete']) blocked(command);
});
test('worker', () => {
  for (const command of ['git push']) blocked(command, { env: { YOKOTEN_ROLE: 'worker' } });
});
test('named worker', () => {
  for (const command of ['git push']) blocked(command, { env: worker });
});
test.skip('gone', () => { blocked('git push --force'); });
test('opt', { skip: true }, () => { blocked('git push --force'); });
test('why', { skip: 'not today' }, () => { blocked('git push --force'); });
test('todo', { todo: true }, () => { blocked('git push --force'); });
test('maybe', { skip: process.platform === 'linux' }, () => { blocked('git push --force'); });
test('kept', { skip: false }, () => { blocked('git push --force'); });
test('allow call', () => { assert.equal(checkCommand('git status', { env: {}, cwd: null }), null); });
test('id call', () => { assert.equal(checkCommand('git push --force', { env: {}, cwd: null })?.id, 'force-push'); });
test('flag', () => { assert.equal(refused, true); });
`;
  const { tests, helpers } = parseTests(FILE, source);
  const byName = (name: string) => tests.find((item) => item.name === name);
  const commands = (keys: string[] | undefined) => (keys ?? []).map((key) => key.split('\0')[0]);
  assert.equal(helpers.length, 2);
  assert.deepEqual(commands(byName('force')?.refuses), ['git push --force']);
  assert.deepEqual(commands(byName('ok')?.allows), ['git status']);
  assert.deepEqual(commands(byName('table')?.refuses), ['git push --force', 'git push --delete']);
  assert.equal(byName('worker')?.refuses[0]?.split('\0')[1], '{"YOKOTEN_ROLE":"worker"}');
  assert.equal(byName('named worker')?.refuses[0]?.split('\0')[1], '{"YOKOTEN_ROLE":"worker"}');
  for (const name of ['gone', 'opt', 'why', 'todo']) {
    assert.equal(byName(name)?.skipped, true, name);
    assert.equal(byName(name)?.refuses.length, 0, name);
  }
  assert.equal(byName('maybe')?.skipped, false);
  assert.match(byName('maybe')?.skipText ?? '', /process\.platform/);
  assert.equal(commands(byName('maybe')?.refuses).length, 1);
  assert.equal(byName('kept')?.skipped, false);
  assert.equal(byName('kept')?.skipText, '');
  assert.deepEqual(commands(byName('allow call')?.allows), ['git status']);
  assert.deepEqual(commands(byName('id call')?.refuses), ['git push --force']);
  assert.deepEqual(byName('flag')?.flags, ['refused=true']);
});

test('a refusal id is a key of RULES (#697)', () => {
  const source = "export const RULES = {\n  'force-push': { rule: 'a', why: 'b', check: 'c' },\n  other: { rule: 'a', why: 'b', check: 'c' },\n};\n";
  const ids = refusalIds(source);
  assert.equal(ids.get('force-push'), 2);
  assert.equal(ids.get('other'), 3);
  assert.equal(ids.has('rule'), false);
});

test('a refusal the reader cannot reach is opaque (#697)', () => {
  const forms = [
    "if (false) blocked('git push --force');",
    "if (false) { blocked('git push --force'); } else blocked('git push --force');",
    "false && blocked('git push --force');",
    "true || blocked('git push --force');",
    "cond ? blocked('git push --force') : blocked('git push --delete');",
    "const hide = () => { blocked('git push --force'); };",
    "function hide() { blocked('git push --force'); }",
    "return; blocked('git push --force');",
  ];
  for (const form of forms) {
    const { tests } = parseTests(FILE, `test('force', () => { ${form} });\n`);
    assert.equal(tests[0]?.opaque, true, form);
    assert.equal(tests[0]?.refuses.length, 0, form);
  }
  const reached = [
    "blocked('git push --force'); return;",
    "return blocked('git push --force');",
    "const hide = () => { blocked('git push --force'); }; hide();",
    "blocked('git push --force') && later;",
    "if (false) blocked('git push --delete'); blocked('git push --force');",
  ];
  for (const form of reached) {
    const { tests } = parseTests(FILE, `test('force', () => { ${form} });\n`);
    assert.equal(tests[0]?.refuses[0]?.split('\0')[0], 'git push --force', form);
  }
});

test('a wrapper the reader cannot see makes the test opaque (#697)', () => {
  const source = "test('wrap', () => {\n  const run = (command: string) => checkCommand(command, { env: {}, cwd: null });\n  assert.equal(run('git push --force')?.id, 'force-push');\n});\n";
  const { tests } = parseTests(FILE, source);
  assert.equal(tests[0]?.opaque, true);
  assert.equal(tests[0]?.refuses.length, 0);
});
