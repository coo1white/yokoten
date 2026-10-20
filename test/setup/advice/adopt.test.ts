// Tests for src/setup/advice/adopt.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  answer,
  FACTS,
  fixture,
  makeSandbox,
} from '../../repo/helpers.ts';
import {
  draft,
  type Fact,
  facts,
  parseAnswer,
  prompt,
  promptProblems,
  ruleDraft,
  table,
} from '../../../src/setup/advice/adopt.ts';
import { ROAD } from '../../../src/setup/road.ts';

const statusOf = (rows: Fact[]) => Object.fromEntries(rows.map((r) => [r.key, r.status]));

const GOOD = [
  { key: 'rules', decision: 'as-is', reason: 'Already there.' },
  { key: 'ci', decision: 'lighter', reason: 'Keep the existing CI and add one step.' },
  { key: 'codeowners', decision: 'not-now', reason: 'One person; look again at the first outside contributor.' },
];

test('adopt: with no key, the rule-based draft and how to set the key; it changes no file (#6)', () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# rules\n');
  sandbox.write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const before = sandbox.git('status', '--porcelain', '--ignored').stdout;
  const r = sandbox.run(['adopt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| Practice \| The project today \| Draft \| Why \|/);
  assert.match(r.stdout, /\| rules \| partial: no AGENTS\.md, but CLAUDE\.md \| lighter \|/);
  assert.match(r.stdout, /set MODEL_API_KEY \(or LLAMA_API_KEY\)/);
  assert.match(r.stdout, /You decide every row/);
  const json = sandbox.run(['adopt', '--json']);
  const rows = JSON.parse(json.stdout) as { key: string; decision: string }[];
  assert.equal(rows.find((row) => row.key === 'tests')?.decision, 'as-is');
  assert.match(json.stderr, /drafted by rules/);
  assert.equal(sandbox.git('status', '--porcelain', '--ignored').stdout, before, 'adopt writes nothing');
});

test('adopt facts: an empty repo has every project step missing, and no evidence names a path outside it', () => {
  const dir = fixture({});
  const rows = facts(dir, { HOME: dir });
  assert.deepEqual(rows.map((r) => r.key), ROAD.map((s) => s.key), 'a row for every step on the road, in its order');
  assert.equal(statusOf(rows)['no-build-output'], 'done', 'a step with no reading of its own gets a row from its own check');
  assert.match(rows.find((r) => r.key === 'protection')?.evidence ?? '', /can't check/, 'a server step is not read here');
  // A setting yokoten can't read is unknown, never missing: the draft must not tell the user to turn on what may be on.
  for (const key of ['protection', 'merge-settings', 'security-settings']) assert.equal(statusOf(rows)[key], 'unknown', key);
  assert.match(ruleDraft(rows).find((r) => r.key === 'protection')?.reason ?? '', /yokoten doctor/, 'the rule draft says to check it with doctor');
  const s = statusOf(rows);
  for (const key of ['rules', 'tool-hook', 'commit-check', 'runtime', 'tests', 'ci', 'templates', 'changelog', 'titles', 'codeowners', 'bot', 'security-files']) assert.equal(s[key], 'missing', key);
  assert.equal(s.issues, 'done', 'no todo file');
  for (const r of rows) assert.ok(!r.evidence.includes(dir) && r.evidence.length < 160, r.key);
});

test("adopt facts: the project's own way counts as partial, the road's checks as done", () => {
  const dir = fixture({
    'CLAUDE.md': '# rules\n',
    '.husky/pre-commit': 'npm test\n',
    '.github/workflows/test.yml': 'on: push\n',
    '.github/pull_request_template.md': '## Why\n',
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n',
    'commitlint.config.js': 'export default {};\n',
    LICENSE: 'MIT\n',
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'TODO.md': '- a thing\n',
    '.github/CODEOWNERS': '* @someone\n',
  });
  const rows = facts(dir, { HOME: dir });
  const s = statusOf(rows);
  assert.deepEqual(
    { rules: s.rules, hook: s['commit-check'], ci: s.ci, templates: s.templates, changelog: s.changelog, titles: s.titles, security: s['security-files'], tests: s.tests, issues: s.issues, owners: s.codeowners },
    { rules: 'partial', hook: 'partial', ci: 'partial', templates: 'partial', changelog: 'partial', titles: 'partial', security: 'partial', tests: 'done', issues: 'missing', owners: 'done' },
  );
  const ev = Object.fromEntries(rows.map((r) => [r.key, r.evidence]));
  assert.match(ev.rules, /CLAUDE\.md/);
  assert.match(ev['commit-check'], /husky/);
  assert.match(ev.ci, /1 workflow/);
  assert.match(ev.issues, /TODO\.md/);
  // npm init's placeholder is not a test command.
  assert.equal(statusOf(facts(fixture({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), {})).tests, 'missing');
});

test('adopt answer: a valid answer becomes rows in the facts order, with a code fence allowed', () => {
  const parsed = parseAnswer(answer([...GOOD].reverse()), FACTS);
  assert.ok('rows' in parsed);
  assert.deepEqual(parsed.rows.map((r) => [r.key, r.decision, r.status]), [['rules', 'as-is', 'done'], ['ci', 'lighter', 'partial'], ['codeowners', 'not-now', 'missing']]);
  assert.ok('rows' in parseAnswer(`\`\`\`json\n${answer(GOOD)}\n\`\`\``, FACTS));
});

test('adopt answer: anything off is not valid, and a partial answer is not valid', () => {
  const bad: [string, RegExp][] = [
    ['here you go', /not JSON/],
    ['[]', /no "rows"/],
    [JSON.stringify({ rows: GOOD, extra: 1 }), /other than/],
    [answer(GOOD.slice(0, 2)), /no decision for codeowners/],
    [answer([...GOOD, GOOD[0]]), /twice/],
    [answer([...GOOD, { key: 'deploy', decision: 'as-is', reason: 'x' }]), /unknown key/],
    [answer([{ ...GOOD[0], decision: 'skip' }, ...GOOD.slice(1)]), /unknown decision/],
    [answer([{ ...GOOD[0], reason: '' }, ...GOOD.slice(1)]), /reason/],
    [answer([{ ...GOOD[0], reason: 'one\ntwo' }, ...GOOD.slice(1)]), /reason/],
    [answer([{ ...GOOD[0], note: 'x' }, ...GOOD.slice(1)]), /unknown fields/],
  ];
  for (const [content, error] of bad) {
    const parsed = parseAnswer(content, FACTS);
    assert.ok('error' in parsed && error.test(parsed.error), `${content.slice(0, 40)}: ${JSON.stringify(parsed)}`);
  }
});

test('adopt draft: no key, a failed call or a bad answer fall back to the rules, and say why', async () => {
  const rules = ruleDraft(FACTS).map((r) => r.decision);
  assert.deepEqual(rules, ['as-is', 'lighter', 'as-is']);
  let calls = 0;
  const noKey = await draft(FACTS, { env: {}, send: async () => (calls++, answer(GOOD)) });
  assert.equal(calls, 0, 'no key, no call');
  assert.equal(noKey.by, 'rules');
  assert.match(noKey.note ?? '', /LLAMA_API_KEY/);
  const env = { LLAMA_API_KEY: 'test-key', HOME: '/nowhere' };
  const failed = await draft(FACTS, { env, send: async () => Promise.reject(new Error('the model endpoint answered HTTP 500')) });
  assert.deepEqual([failed.by, failed.rows.map((r) => r.decision)], ['rules', rules]);
  assert.match(failed.note ?? '', /HTTP 500/);
  const invalid = await draft(FACTS, { env, send: async () => 'not json' });
  assert.match(invalid.note ?? '', /not valid/);
  const good = await draft(FACTS, { env, send: async () => answer(GOOD) });
  assert.equal(good.by, 'the model (muse-spark-1.3)');
  assert.deepEqual(good.rows.map((r) => r.decision), ['as-is', 'lighter', 'not-now']);
  const out = table(good).join('\n');
  assert.match(out, /^\| Practice \| The project today \| Draft \| Why \|/);
  assert.match(out, /You decide every row/);
  // A backslash before a pipe would end the cell early: both are escaped, the backslash first.
  const tricky = table({ ...good, rows: [{ ...good.rows[0], reason: 'ends in \\| x' }] }).join('\n');
  assert.ok(tricky.includes('| ends in \\\\\\| x |'), 'a backslash and a pipe stay inside the cell');
  for (const d of [noKey, failed, invalid, good]) assert.ok(!JSON.stringify(d).includes('test-key') && !table(d).join('\n').includes('test-key'), 'the key is never in the output');
});

test('adopt draft: facts with an email, a secret, a private mark or a home path are never sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-marks-'));
  writeFileSync(join(dir, 'marks'), 'secret-city\n');
  const cases = [`write to someone${'@'}personal-mail.com`, `ghp_${'a'.repeat(36)}`, 'from Secret-City', '/home/someone/project', 'C:\\Users\\someone'];
  for (const evidence of cases) {
    let sent = false;
    const d = await draft([{ ...FACTS[0], evidence }], { env: { LLAMA_API_KEY: 'test-key', HOME: '/nowhere', YOKOTEN_PRIVATE_MARKS: join(dir, 'marks') }, send: async () => ((sent = true), answer(GOOD)) });
    assert.equal(sent, false, evidence);
    assert.match(d.note ?? '', /nothing was sent/);
    assert.ok(!(d.note ?? '').includes(evidence), 'the finding is never printed');
  }
  assert.deepEqual(promptProblems(prompt(FACTS), { HOME: '/nowhere' }), [], 'clean facts may go');
});
