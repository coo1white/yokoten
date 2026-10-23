// Tests for src/run/check/loosen.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, ROOT } from '../../repo/helpers.ts';
import { ruleChange, ruleChangeFindings, type RuleChange, type RuleReason } from '../../../src/run/check/loosen.ts';

const GUARD = `export function checkCommand(command: string, _options: { env: Record<string, string>; cwd: string | null }): { id: string } | null {
  if (command.includes('push --force')) return { id: 'force-push' };
  return null;
}
`;

const RULES = `export const RULES = {
  'force-push': { rule: 'no force push', why: 'it drops commits', check: 'the guard' },
};
`;

const REFUSED = `test('force push is refused', () => {
  blocked('git push --force');
});
`;

const TEST = `import { test } from 'node:test';
const blocked = (command: string) => command;
const allowed = (command: string) => command;
${REFUSED}test('status is allowed', () => {
  allowed('git status');
});
`;

const SPEC = 'test/rules/guards.test.ts';

function setup(files: Record<string, string> = {}) {
  const sandbox = makeSandbox();
  const write = (more: Record<string, string>) => {
    for (const [path, text] of Object.entries(more)) sandbox.write(path, text);
  };
  const commit = (message: string) => {
    const added = sandbox.git('add', '-A');
    assert.equal(added.status, 0, added.stderr);
    const committed = sandbox.git('commit', '-qm', message);
    assert.equal(committed.status, 0, committed.stderr);
    return sandbox.git('rev-parse', 'HEAD').stdout.trim();
  };
  write({ 'src/rules/guards.ts': GUARD, 'src/rules/message.ts': RULES, [SPEC]: TEST, 'README.md': 'One.\n', ...files });
  const base = commit('base');
  const judge = () => ruleChange(sandbox.repo, base, commit('head'), sandbox.env);
  return { sandbox, write, commit, base, judge };
}

function texts(change: RuleChange, kind: RuleReason['kind']): string[] {
  return change.reasons.filter((reason) => reason.kind === kind).map((reason) => reason.text);
}

function assertShape(change: RuleChange): void {
  assert.ok(change.reasons.length > 0);
  for (const reason of change.reasons) {
    assert.ok(reason.file.length > 0, reason.text);
    assert.ok(reason.line >= 1, reason.text);
    assert.equal(reason.text.endsWith('.'), false, reason.text);
  }
}

function assertLooser(change: RuleChange, pattern: RegExp): void {
  assertShape(change);
  assert.equal(change.verdict, 'looser', texts(change, 'looser').join('; '));
  assert.ok(texts(change, 'looser').some((text) => pattern.test(text)), texts(change, 'looser').join('; '));
  assert.ok(ruleChangeFindings(change).every((item) => item.id === 'rules-looser' && item.what.startsWith('this change makes the rules looser')));
}

test('a removed guard test is looser (#697)', () => {
  const box = setup();
  box.write({ [SPEC]: TEST.replace(REFUSED, '') });
  assertLooser(box.judge(), /test "force push is refused" was removed/);
});

test('a refusal that becomes an allow is looser (#697)', () => {
  const box = setup();
  box.write({ [SPEC]: TEST.replace("blocked('git push --force')", "allowed('git push --force')") });
  assertLooser(box.judge(), /now allows `git push --force`/);
});

test('a test turned to skip is looser (#697)', () => {
  const skipped = [
    TEST.replace("test('force push is refused'", "test.skip('force push is refused'"),
    TEST.replace("test('force push is refused', () => {", "test('force push is refused', { skip: true }, () => {"),
    TEST.replace("test('force push is refused', () => {", "test('force push is refused', { skip: 'not today' }, () => {"),
    TEST.replace("test('force push is refused', () => {", "test.todo('force push is refused', () => {"),
  ];
  for (const source of skipped) {
    const box = setup();
    box.write({ [SPEC]: source });
    assertLooser(box.judge(), /is skipped/);
  }
  const box = setup();
  box.write({ [SPEC]: TEST.replace("test('force push is refused', () => {", "test('force push is refused', { skip: process.platform === 'linux' }, () => {") });
  assertLooser(box.judge(), /may be skipped/);
});

test('dropping a conditional skip is not looser (#697)', () => {
  const source = TEST.replace("test('force push is refused', () => {", "test('force push is refused', { skip: process.platform === 'linux' }, () => {");
  const box = setup({ [SPEC]: source });
  box.write({ [SPEC]: TEST });
  const change = box.judge();
  assert.equal(change.verdict, 'stricter-or-neutral', texts(change, 'looser').join('; '));
  assert.equal(texts(change, 'looser').length, 0);
});

test('a removed refusal id is looser (#697)', () => {
  const box = setup();
  box.write({ 'src/rules/message.ts': 'export const RULES = {\n};\n' });
  assertLooser(box.judge(), /refusal id force-push was removed/);
});

test('an early return in the guard is looser when a base case then passes (#697)', () => {
  const box = setup();
  box.write({
    'src/rules/guards.ts': `export function checkCommand(command: string, _options: { env: Record<string, string>; cwd: string | null }): { id: string } | null {
  return null;
  if (command.includes('push --force')) return { id: 'force-push' };
}
`,
  });
  assertLooser(box.judge(), /`git push --force` is refused on the base and allowed on the head/);
});

test('a narrowed pattern in the guard is looser when a base case then passes (#697)', () => {
  const box = setup();
  box.write({ 'src/rules/guards.ts': GUARD.replace("includes('push --force')", "includes('push --force-with-lease')") });
  assertLooser(box.judge(), /`git push --force` is refused on the base and allowed on the head/);
});

test('a narrowed pattern in a file the guard imports is looser (#697)', () => {
  const guard = `import { FORCE_REF } from './force-pattern.ts';
export function checkCommand(command: string, _options: { env: Record<string, string>; cwd: string | null }): { id: string } | null {
  if (FORCE_REF.test(command)) return { id: 'force-push' };
  return null;
}
`;
  const spec = `import { test } from 'node:test';
const blocked = (command: string) => command;
test('plus main is refused', () => {
  blocked('git push origin +main');
});
`;
  const box = setup({ 'src/rules/guards.ts': guard, 'src/rules/force-pattern.ts': 'export const FORCE_REF = /\\+/;\n', [SPEC]: spec });
  box.write({ 'src/rules/force-pattern.ts': 'export const FORCE_REF = /\\+main/;\n' });
  assertLooser(box.judge(), /a file the guard imports changed/);
  const comment = setup({ 'src/rules/guards.ts': guard, 'src/rules/force-pattern.ts': 'export const FORCE_REF = /\\+/;\n', [SPEC]: spec });
  comment.write({ 'src/rules/force-pattern.ts': '// wider on purpose\nexport const FORCE_REF = /\\+/;\n' });
  const noted = comment.judge();
  assert.equal(noted.verdict, 'stricter-or-neutral', texts(noted, 'looser').join('; '));
  assert.equal(texts(noted, 'looser').length, 0);
});

test('a guard import outside src/rules is replayed from the head copy (#697)', () => {
  const guard = `import { FORCE_REF } from '../run/force-pattern.ts';
export function checkCommand(command: string, _options: { env: Record<string, string>; cwd: string | null }): { id: string } | null {
  if (FORCE_REF.test(command)) return { id: 'force-push' };
  return null;
}
`;
  const box = setup({ 'src/rules/guards.ts': guard, 'src/run/force-pattern.ts': 'export const FORCE_REF = /push --force/;\n' });
  box.write({ 'src/run/force-pattern.ts': 'export const FORCE_REF = /push --force-with-lease/;\n' });
  assertLooser(box.judge(), /`git push --force` is refused on the base and allowed on the head/);
});

test('deleting one case from a table is looser (#697)', () => {
  const table = `import { test } from 'node:test';
const blocked = (command: string) => command;
test('pushes', () => {
  for (const command of ['git push --force', 'git push --delete']) blocked(command);
});
`;
  const box = setup({ [SPEC]: table });
  box.write({ [SPEC]: table.replace(", 'git push --delete'", '') });
  assertLooser(box.judge(), /no longer refuses `git push --delete`/);
});

test('assert.equal(refused, true) flipped to false is looser (#697)', () => {
  const flag = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('the flag', () => {
  const refused = true;
  assert.equal(refused, true);
});
`;
  const box = setup({ [SPEC]: flag });
  box.write({ [SPEC]: flag.replace('assert.equal(refused, true)', 'assert.equal(refused, false)') });
  assertLooser(box.judge(), /no longer expects refused to be refused/);
});

test('renaming a test is looser, and so is moving it out of the watched folders (#697)', () => {
  const renamed = setup();
  renamed.write({ [SPEC]: TEST.replace('force push is refused', 'force push stays refused') });
  const change = renamed.judge();
  assertLooser(change, /test "force push is refused" was removed/);
  assert.ok(texts(change, 'stricter').some((text) => text.includes('was added')));

  const moved = setup();
  rmSync(join(moved.sandbox.repo, SPEC));
  moved.write({ 'test/other/guards.test.ts': TEST });
  assertLooser(moved.judge(), /was removed/);
});

test('moving a watched test to another watched file is not looser (#697)', () => {
  const box = setup();
  rmSync(join(box.sandbox.repo, SPEC));
  box.write({ 'test/rules/push.test.ts': TEST });
  const change = box.judge();
  assert.equal(change.verdict, 'stricter-or-neutral', texts(change, 'looser').join('; '));
  assert.equal(texts(change, 'looser').length, 0);
  assert.equal(texts(change, 'hard-line').length, 0);
});

test('a test that moves to another file with a changed helper is looser (#697)', () => {
  const baseSpec = `import { test } from 'node:test';
const blocked = (command: string) => command;
test('force push is refused', () => {
  blocked('git push --force');
});
`;
  const kept = `import { test } from 'node:test';
const blocked = (command: string) => command;
test('another refusal still runs', () => {
  blocked('git push --force-with-lease');
});
`;
  const moved = `import { test } from 'node:test';
const blocked = (_command: string) => undefined;
test('force push is refused', () => {
  blocked('git push --force');
});
`;
  const box = setup({ [SPEC]: baseSpec });
  box.write({ [SPEC]: kept, 'test/rules/push.test.ts': moved });
  assertLooser(box.judge(), /moved to another file with a changed helper/);
});

test('a refusal the reader cannot reach is looser (#697)', () => {
  const forms = [
    "if (false) blocked('git push --force');",
    "false && blocked('git push --force');",
    "true || blocked('git push --force');",
    "const hide = () => { blocked('git push --force'); };",
    "function hide() { blocked('git push --force'); }",
    "return;\n  blocked('git push --force');",
  ];
  for (const form of forms) {
    const box = setup();
    box.write({ [SPEC]: TEST.replace("blocked('git push --force');", form) });
    assertLooser(box.judge(), /no longer refuses `git push --force`/);
  }
});

test('renaming a test under test/run/check is looser (#697)', () => {
  const file = 'test/run/check/sample.test.ts';
  const box = setup({ [file]: TEST });
  box.write({ [file]: TEST.replace('force push is refused', 'force push stays refused') });
  assertLooser(box.judge(), /test "force push is refused" was removed/);
});

test('a changed helper is looser (#697)', () => {
  const box = setup();
  box.write({ [SPEC]: TEST.replace('const blocked = (command: string) => command;', 'const blocked = (command: string) => command.length > 0 ? command : command;') });
  assertLooser(box.judge(), /the helper blocked changed/);
});

test('a new test or a new refusal id is stricter, and that is a note (#697)', () => {
  const addedTest = setup();
  addedTest.write({ [SPEC]: `${TEST}test('also refused', () => {\n  blocked('rm -rf .git');\n});\n` });
  const fromTest = addedTest.judge();
  assert.equal(fromTest.verdict, 'stricter-or-neutral');
  assert.ok(texts(fromTest, 'stricter').some((text) => text.includes('was added')));
  assert.equal(texts(fromTest, 'looser').length, 0);
  assert.match(ruleChangeFindings(fromTest)[0]?.what ?? '', /^the rules got stricter:/);

  const addedId = setup();
  addedId.write({ 'src/rules/message.ts': RULES.replace('};', "  'new-id': { rule: 'a new refusal', why: 'stricter', check: 'the guard' },\n};") });
  const fromId = addedId.judge();
  assert.equal(fromId.verdict, 'stricter-or-neutral', texts(fromId, 'looser').join('; '));
  assert.ok(texts(fromId, 'stricter').some((text) => text.includes('refusal id new-id was added')));
  assert.equal(ruleChangeFindings(fromId)[0]?.fix, 'no change is required');
});

test('a docs-only change is neutral, on the line that changed (#697)', () => {
  const box = setup();
  box.write({ 'README.md': 'One.\nTwo.\n' });
  const change = box.judge();
  assertShape(change);
  assert.equal(change.verdict, 'stricter-or-neutral');
  assert.deepEqual(texts(change, 'neutral'), ['this change does not make the rules looser']);
  const neutral = change.reasons.find((reason) => reason.kind === 'neutral');
  assert.equal(neutral?.file, 'README.md');
  assert.equal(neutral?.line, 2);
  assert.deepEqual(ruleChangeFindings(change), []);
});

test('a workflow change is a hard line, and so are CODEOWNERS, record 0026 and the release environment (#697)', () => {
  const box = setup({
    '.github/workflows/ci.yml': 'name: ci\non: push\n',
    '.github/workflows/release.yml': 'name: release\njobs:\n  publish:\n    environment: release\n',
    '.github/CODEOWNERS': '/kit/ @owner\n',
    'docs/records/0026-leads.md': 'One.\n',
    'deploy.yml': 'name: deploy\njobs:\n  publish:\n    runs-on: ubuntu-latest\n',
  });
  const check = (file: string, text: string, expect: string, line: number) => {
    const reset = box.sandbox.git('reset', '--hard', box.base);
    assert.equal(reset.status, 0, reset.stderr);
    box.write({ [file]: text });
    const change = ruleChange(box.sandbox.repo, box.base, box.commit('head'), box.sandbox.env);
    assertShape(change);
    assert.equal(change.verdict, 'hard-line', texts(change, 'looser').concat(texts(change, 'hard-line')).join('; '));
    const reason = change.reasons.find((item) => item.kind === 'hard-line' && item.file === file);
    assert.match(reason?.text ?? '', new RegExp(expect));
    assert.equal(reason?.line, line, reason?.text);
    assert.match(ruleChangeFindings(change)[0]?.what ?? '', /^this change moves a hard line:/);
  };
  check('.github/workflows/ci.yml', 'name: ci\non: pull_request\n', 'a workflow file is a hard line', 2);
  check('.github/workflows/release.yml', 'name: cut\njobs:\n  publish:\n    environment: release\n', 'sets the release environment', 1);
  check('.github/CODEOWNERS', '/src/ @owner\n', 'this CODEOWNERS file is a hard line', 1);
  check('docs/records/0026-leads.md', 'Two.\n', 'record 0026 is a hard line', 1);
  check('deploy.yml', 'name: deploy\njobs:\n  publish:\n    environment: release\n', 'the release environment is a hard line', 4);
});

test('a looser change is reported with a hard line, and the verdict is looser (#697)', () => {
  const box = setup();
  box.write({ [SPEC]: TEST.replace(REFUSED, ''), '.github/workflows/ci.yml': 'on: push\n' });
  const change = box.judge();
  assert.equal(change.verdict, 'looser');
  assert.ok(texts(change, 'looser').length > 0);
  assert.ok(texts(change, 'hard-line').some((text) => text.includes('workflow')));
  const found = ruleChangeFindings(change);
  assert.ok(found.length >= 2);
  assert.ok(found.every((item) => item.id === 'rules-looser'));
});

test('this repo against itself is not looser, and the replay finishes in under 30s (#697)', () => {
  const started = Date.now();
  const change = ruleChange(ROOT, 'HEAD', 'HEAD', process.env);
  const elapsed = Date.now() - started;
  assert.equal(change.verdict, 'stricter-or-neutral', texts(change, 'looser').concat(texts(change, 'hard-line')).join('; '));
  assert.equal(texts(change, 'looser').length, 0);
  assert.equal(texts(change, 'hard-line').length, 0);
  assert.ok(elapsed < 30_000, `${elapsed} ms`);
});
