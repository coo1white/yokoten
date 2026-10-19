// The road's logic, apart from the checks: where a project is, from what each check found.
// Then adoption (#6), which reads the road's checks for an old project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, type LlamaConfig, llamaConfig } from '../src/agents/llama.ts';
import { draft, type Fact, facts, parseAnswer, prompt, promptProblems, ruleDraft, table } from '../src/setup/advice/adopt.ts';
import { type Found, ROAD, STAGES, type Step, walk } from '../src/setup/road.ts';

const step = (stage: number, key: string): Step => ({ stage, key, check: () => false, what: () => key, fix: () => key, why: key, how: key });
const steps = [step(1, 'a'), step(1, 'b'), step(2, 'c'), step(3, 'd')];
const at = (found: Found[], notNow: Record<string, string> = {}) => walk(steps.map((s, i) => ({ step: s, found: found[i] })), notNow);
const marks = (found: Found[], notNow: Record<string, string> = {}) => at(found, notNow).steps.map((w) => w.mark);

test('road: the stage is the first one with a step neither done nor not now', () => {
  assert.equal(at([false, false, false, false]).stage, 1);
  assert.equal(at([true, true, false, false]).stage, 2);
  assert.equal(at([true, true, true, false]).stage, 3);
  assert.deepEqual(marks([true, false, false, false]), ['done', 'next', 'to do', 'to do']);
  assert.equal(at([true, false, false, false]).next?.key, 'b');
});

test('road: a later step done early counts as done', () => {
  assert.deepEqual(marks([false, true, true, true]), ['next', 'done', 'done', 'done']);
  assert.equal(at([false, true, true, true]).stage, 1);
});

test('road: not now skips a step, and done wins over not now', () => {
  assert.equal(at([true, false, false, false], { b: 'later' }).stage, 2);
  assert.deepEqual(marks([true, false, false, false], { a: 'x', b: 'later' }), ['done', 'not now', 'next', 'to do']);
});

test("road: a step yokoten can't check shows so, and never holds the stage", () => {
  assert.deepEqual(marks([true, null, false, true]), ['done', "can't check", 'next', 'done']);
  assert.equal(at([true, null, false, true]).stage, 2);
});

test('road: nothing left means no stage and no next step', () => {
  const end = at([true, null, true, false], { d: 'not public yet' });
  assert.equal(end.stage, null);
  assert.equal(end.next, null);
});

test('road: five stages, each step in one of them, each key once, each why a sentence', () => {
  assert.equal(STAGES.length, 5);
  assert.deepEqual(ROAD.map((s) => s.stage), [...ROAD.map((s) => s.stage)].sort(), 'the table is in stage order');
  assert.ok(ROAD.every((s) => s.stage >= 1 && s.stage <= STAGES.length));
  assert.equal(new Set(ROAD.map((s) => s.key)).size, ROAD.length);
  // The keys a project may already have in yokoten.json "notNow" keep working.
  for (const key of ['rules', 'commit-check', 'tool-hook', 'ci', 'runtime', 'issues']) assert.ok(ROAD.some((s) => s.key === key), key);
  for (const s of ROAD) assert.ok(!/[.]$/.test(s.why) && s.why.split(' ').length <= 25, `${s.key}: a why has no full stop and at most 25 words`);
  for (const s of ROAD) assert.ok(s.how && !/[.]$/.test(s.how), `${s.key}: says how it is checked, with no full stop`);
});

// ---- Adoption (#6): the facts from files, then a draft from a model or the rules. ----

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-adopt-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const statusOf = (rows: Fact[]) => Object.fromEntries(rows.map((r) => [r.key, r.status]));

test('adopt facts: an empty repo has every project step missing, and no evidence names a path outside it', () => {
  const dir = fixture({});
  const rows = facts(dir, { HOME: dir });
  assert.deepEqual(rows.map((r) => r.key), ROAD.map((step) => step.key), 'every step on the road, in its order');
  assert.ok(rows.some((r) => r.key === 'no-build-output'), 'a step with no reading of its own still gets a row');
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

const FACTS: Fact[] = [
  { key: 'rules', status: 'done', evidence: 'AGENTS.md', why: 'an agent follows the rules it can read' },
  { key: 'ci', status: 'partial', evidence: 'CI exists', why: 'a commit made with the hook off would reach main unchecked' },
  { key: 'codeowners', status: 'missing', evidence: 'no CODEOWNERS file', why: 'the host then asks you to review' },
];
const answer = (rows: unknown) => JSON.stringify({ rows });
const GOOD = [
  { key: 'rules', decision: 'as-is', reason: 'Already there.' },
  { key: 'ci', decision: 'lighter', reason: 'Keep the existing CI and add one step.' },
  { key: 'codeowners', decision: 'not-now', reason: 'One person; look again at the first outside contributor.' },
];

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

test('adopt chat: one OpenAI-style call with the key in the header only, against a local server', async () => {
  const seen: { url?: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let reply: (res: import('node:http').ServerResponse) => void = (res) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer(GOOD) } }] }));
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data) });
      res.setHeader('content-type', 'application/json');
      reply(res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const env = { LLAMA_API_KEY: 'test-key', LLAMA_API_BASE: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`, LLAMA_MODEL: 'test-model', HOME: '/nowhere' };
  try {
    const d = await draft(FACTS, { env });
    assert.equal(d.by, 'the model (test-model)');
    assert.deepEqual(d.rows.map((r) => r.decision), ['as-is', 'lighter', 'not-now']);
    const [call] = seen;
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.auth, 'Bearer test-key');
    assert.equal(call.body?.model, 'test-model');
    assert.equal((call.body?.response_format as { type: string }).type, 'json_schema');
    assert.ok(!JSON.stringify(call.body).includes('test-key'), 'the key is not in the body');
    reply = (res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'bad key test-key' } }));
    };
    const denied = await draft(FACTS, { env });
    assert.equal(denied.by, 'rules');
    assert.match(denied.note ?? '', /HTTP 401/);
    assert.ok(!(denied.note ?? '').includes('test-key'), 'an error body is not echoed');
    reply = () => {}; // never answers
    await assert.rejects(chat(llamaConfig(env) as LlamaConfig, prompt(FACTS), { timeoutMs: 200 }), /did not answer in/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  assert.equal(llamaConfig({}), null);
  assert.deepEqual(llamaConfig({ MODEL_API_KEY: 'test-key' }), { base: 'https://api.meta.ai/v1', model: 'muse-spark-1.3', key: 'test-key' });
});
test('road: every outside standard has the form "<standard>: <item>" or an item id, joined by " · " (#58)', () => {
  const named = ROAD.filter((s) => s.standard);
  assert.ok(named.length >= 10, 'most steps name a standard');
  for (const { key, standard } of named) {
    for (const part of (standard ?? '').split(' · ')) {
      assert.match(part, /^[A-Za-z][\w .-]*(?:: \S(?:.*\S)?)?$/, `${key}: "${part}"`);
      if (part.startsWith('OSPS')) assert.match(part, /^OSPS-[A-Z]{2}-\d{2}\.\d{2}$/, `${key}: an OSPS Baseline id`);
    }
  }
});
