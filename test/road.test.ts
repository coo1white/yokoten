// The road's logic, apart from the checks: where a project is, from what each check found.
// Then adoption (#6), which reads the road's checks for an old project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { chat, type LlamaConfig, llamaConfig } from '../src/agents/llama.ts';
import { draft, type Fact, facts, parseAnswer, prompt, promptProblems, ruleDraft, table } from '../src/setup/advice/adopt.ts';
import { type Found, onPullRequest, ROAD, runsTests, STAGES, type Step, walk, yokotenActions } from '../src/setup/road.ts';
import { codeOwnersText } from '../src/setup/init.ts';

const step = (stage: number, key: string): Step => ({ stage, key, check: () => false, what: () => key, fix: () => key, why: key, how: key });
const steps = [step(1, 'a'), step(1, 'b'), step(2, 'c'), step(3, 'd')];
const at = (found: Found[], notNow: Record<string, string> = {}) => walk(steps.map((s, i) => ({ step: s, found: found[i] })), notNow);
const marks = (found: Found[], notNow: Record<string, string> = {}) => at(found, notNow).steps.map((w) => w.mark);

/**
 * Proves `read` takes linear time by how its time grows, not by a wall-clock limit, which
 * fails on a slow runner (#275, #315). It reads an input of `size` and one of 8x that: linear time
 * grows about 8x, quadratic about 64x, so more than 24x fails. Each size takes its fastest read
 * of several: a GC or JIT pause lands on some reads, not all, and a total over many reads grew
 * past 24x on a 4 GB machine from GC alone (#321). 30 s on one read catches a hang.
 */
const assertLinear = (name: string, make: (n: number) => string, read: (input: string) => void, size = 1 << 16) => {
  const fastest = (input: string, reps: number) => {
    let best = Infinity;
    for (let i = 0; i < reps; i++) {
      const start = performance.now();
      read(input);
      best = Math.min(best, performance.now() - start);
      assert.ok(best < 30_000, `${name}: ${best.toFixed(0)} ms for ${input.length} chars, a hang`);
    }
    return best;
  };
  const small = make(size);
  const big = make(8 * size);
  // Enough reads of the small input to add up to about 20 ms, from 3 to 64.
  const reps = Math.min(64, Math.max(3, Math.ceil(20 / Math.max(fastest(small, 1), 0.01))));
  // Below 0.1 ms the timer is noise; a quadratic read of 8x the size still takes far longer.
  const base = Math.max(0.1, fastest(small, reps));
  const ms = fastest(big, reps);
  assert.ok(ms <= 24 * base, `${name}: ${ms.toFixed(2)} ms for 8x the input of ${base.toFixed(2)} ms, ${(ms / base).toFixed(0)}x; linear is about 8x`);
};

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
  // With NODE_USE_ENV_PROXY=1, fetch sends even a local call through the shell's proxy,
  // which closes it. The fake API is on this machine, so the call goes to it directly.
  // Node reads both spellings of the variable, so both are set, then put back.
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
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
    for (const [name, value] of [['NO_PROXY', saved.upper], ['no_proxy', saved.lower]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

// ---- The tests step (#257): the common test commands in a workflow count, in any kind of project. ----

/** The tests step on a scratch repo with these files: whether it is done, and what it says when not. */
const testsStep = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-tests-step-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const tests = ROAD.find((s) => s.key === 'tests');
    assert.ok(tests);
    return { done: tests.check(dir, {}, undefined), what: tests.what(dir, {}, undefined) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const workflow = (run: string) => ({ '.github/workflows/ci.yml': `jobs:\n  t:\n    steps:\n      - run: ${run}\n` });

// Each case: the workflow (a `- run:` value, or a whole workflow when it has a newline), the project, and whether the step is done.
const PLAIN = {};
const SCRIPT = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) };
const NPM_WS = { 'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }) };
const PNPM_WS = { 'package.json': JSON.stringify({ private: true }), 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' };
const NO_SCRIPT = { 'package.json': JSON.stringify({ private: true }) };
const TESTS_CASES: [string, Record<string, string>, boolean][] = [
  // The common runners.
  ...['python -m unittest discover', 'python -m pytest', 'tox', 'nox', 'make test', 'npx vitest run', 'npx jest', 'pnpm exec vitest run', 'pnpm exec jest', 'yarn vitest run', 'yarn jest',
    'uv run pytest', 'go test ./...', 'node --test', 'pytest'].map((run): [string, Record<string, string>, boolean] => [run, PLAIN, true]),
  ['jobs:\n  t:\n    steps:\n      - run: |\n          pip install tox\n          tox -e py\n', PLAIN, true],
  ['jobs:\n  t:\n    steps:\n      - name: test\n        run: >-\n          go test ./...\n', PLAIN, true],
  ['npm ci && npx jest --ci', PLAIN, true],
  // Easy wins (#257 review): more ways to start a runner.
  ...['pnpm vitest', 'pnpm jest', 'npx --yes jest', 'npm exec vitest', 'npm exec -- vitest run', 'poetry run pytest', 'pipenv run pytest', 'coverage run -m pytest', 'poetry run python -m unittest',
    'CI=true npx vitest run', 'FOO="a b" pytest', 'env CI=1 pytest', 'time go test ./...', 'make tests', 'make -C backend test', '"tox -e py"', "'go test ./...'", '(cd app && go test ./...)',
    'node --experimental-strip-types --test'].map((run): [string, Record<string, string>, boolean] => [run, PLAIN, true]),
  // Not a test run: installing a runner, a name that only starts like one, asking a runner its version.
  ...['pip install tox nox', 'pip install pytest', 'make test-deps', 'yarn jest-junit', 'npm install && jest-preview', 'npx jest --version', 'pytest --help', '# python -m unittest', 'unittest',
    'echo tox'].map((run): [string, Record<string, string>, boolean] => [run, PLAIN, false]),
  // Not a run step at all: a job id, a matrix item, a setting, a broken key, a comment.
  ['jobs:\n  jest:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n', PLAIN, false],
  ['jobs:\n  tox:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n', PLAIN, false],
  ['jobs:\n  t:\n    strategy:\n      matrix:\n        runner:\n          - jest\n          - tox\n    steps:\n      - run: npm ci\n', PLAIN, false],
  ['jobs:\n  t:\n    with:\n      tox-version: 4\n    steps:\n      - run: echo hi\n', PLAIN, false],
  ['jobs:\n  t:\n    steps:\n      -run: tox\n', PLAIN, false],
  ['jobs:\n  t:\n    steps:\n      - run: |\n          # python -m unittest\n          echo skipped\n', PLAIN, false],
  ['jobs:\n  t:\n    steps:\n      - run: |\n          echo one\n      - name: tox\n        uses: some/action@v1\n', PLAIN, false],
  // The package.json script.
  ['npm test', SCRIPT, true],
  ['npm run test', SCRIPT, true],
  ['pnpm t', SCRIPT, true],
  ['npm test', NO_SCRIPT, false],
  ['npm run test:lint', SCRIPT, false],
  // Workspaces with no root script: only a command that runs each package's tests.
  ...['npm test --workspaces', 'npm run test -ws', 'npm test --workspace=app', 'npm -w app test', 'npm run test -w app', 'pnpm -r test', 'pnpm --recursive run test', 'pnpm --filter app test',
    'pnpm -r --parallel test', 'yarn workspaces run test', 'yarn workspaces foreach -A run test', 'yarn workspaces foreach --all --topological run test']
    .flatMap((run): [string, Record<string, string>, boolean][] => [[run, NPM_WS, true], [run, PNPM_WS, true]]),
  ...['npm test', 'pnpm test', 'npm run test:lint', 'npm run test:lint -ws', 'pnpm -r test:lint', 'npm run lint', 'yarn workspaces run test:e2e']
    .flatMap((run): [string, Record<string, string>, boolean][] => [[run, NPM_WS, false], [run, PNPM_WS, false]]),
];

test('road: the tests step counts a test command only in a run step, and not a look-alike (#257)', () => {
  for (const [run, project, done] of TESTS_CASES) {
    const ci = run.includes('\n') ? { '.github/workflows/ci.yml': run } : workflow(run);
    assert.equal(testsStep({ ...project, ...ci }).done, done, `${done ? 'done' : 'next'}: ${JSON.stringify(run)} with ${Object.keys(project).join(', ') || 'no package.json'}`);
  }
});

test('road: the tests step reads a big workflow in linear time (#257)', () => {
  // Each input is about n characters.
  const inputs: [string, (n: number) => string][] = [
    ['newlines', (n) => '\n'.repeat(n)],
    ['run: and spaces', (n) => `run: ${' '.repeat(n)}`],
    ['blank indented lines', (n) => '    \n'.repeat(n / 5)],
    ['a run block of blank lines', (n) => `      - run: |\n${'\n'.repeat(n)}`],
    ['semicolons', (n) => `- run: ${';'.repeat(n)}`],
    ['flags', (n) => `- run: npm ${'-a '.repeat(n / 3)}`],
    ['flags with values', (n) => `- run: pnpm ${'-a b '.repeat(n / 5)}`],
    ['variables', (n) => `- run: ${'A=b '.repeat(n / 4)}`],
  ];
  for (const [name, make] of inputs) {
    for (const workspaces of [false, true]) {
      assertLinear(`${name}, workspaces ${workspaces}`, make, (ci) => assert.equal(runsTests(ci, 'vitest run x', workspaces), false, name));
    }
  }
});

test('road: the tests step stays next with only a lint step, and says what is missing by project type (#257)', () => {
  const lint = testsStep({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }), ...workflow('npm run lint') });
  assert.deepEqual(lint, { done: false, what: 'no test command: no "test" script in package.json, and no workflow runs a test runner' });
  const go = testsStep({ 'go.mod': 'module example.com/x\n' });
  assert.deepEqual(go, { done: false, what: 'no workflow runs a test command such as `go test`' });
  assert.equal(testsStep({ 'pyproject.toml': '[project]\nname = "x"\n' }).what, 'no workflow runs a test command such as `pytest`');
  assert.equal(testsStep({}).what, 'no workflow runs a test command such as `go test`, `pytest` or `cargo test`');
  for (const files of [{ 'go.mod': '' }, { 'pyproject.toml': '' }, {}] as Record<string, string>[]) assert.doesNotMatch(testsStep(files).what, /package\.json/);
  // A workspaces root with no script: each package's tests, not a root script.
  assert.equal(testsStep(NPM_WS).what, "no workflow runs each package's tests (e.g. `npm test --workspaces`)");
  assert.equal(testsStep(PNPM_WS).what, "no workflow runs each package's tests (e.g. `pnpm -r test`)");
  const tests = ROAD.find((s) => s.key === 'tests');
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-tests-fix-'));
  try {
    writeFileSync(join(dir, 'package.json'), NPM_WS['package.json']);
    assert.equal(tests?.fix(dir, {}, undefined), 'add a step that runs `npm test --workspaces` to a workflow in .github/workflows');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The ci and titles steps (#298): the yokoten Action and `npx yokoten check` count. ----

// The guide's "Use it as a GitHub Action" example, as it stands.
const GUIDE_ACTION = `# .github/workflows/yokoten.yml
name: yokoten
on:
  pull_request:
    # \`edited\`, \`labeled\` and \`milestoned\` run \`check --pr\` again after a fix.
    types: [opened, edited, synchronize, reopened, labeled, unlabeled, milestoned, demilestoned]
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  yokoten:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: yokoten-labs/yokoten@<full commit SHA>
`;
/** Whether the ci and titles steps are done on a scratch repo with this one workflow. */
const ciSteps = (workflowText: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-ci-step-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'yokoten.yml'), workflowText);
    const done = (key: string) => ROAD.find((s) => s.key === key)!.check(dir, {}, undefined);
    return { ci: done('ci'), titles: done('titles') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const withAction = (step: string, on = 'pull_request') => `on: ${on}\njobs:\n  y:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;
const CI_CASES: [string, string, { ci: boolean; titles: boolean }][] = [
  ['the guide example', GUIDE_ACTION, { ci: true, titles: true }],
  ['pr-check: false', GUIDE_ACTION.replace('yokoten@<full commit SHA>\n', 'yokoten@<full commit SHA>\n        with:\n          pr-check: false\n'), { ci: true, titles: false }],
  ["pr-check: 'false' before uses", withAction("      - name: yokoten\n        with:\n          pr-check: 'false' # not yet\n        uses: yokoten-labs/yokoten@v1\n"), { ci: true, titles: false }],
  ['pr-check: true, quoted ref and a comment', withAction('      - uses: "yokoten-labs/yokoten@0123abc" # v0.1\n        with:\n          pr-check: true\n'), { ci: true, titles: true }],
  ['push only', withAction('      - uses: yokoten-labs/yokoten@v1\n', '[push]'), { ci: true, titles: false }],
  ['pull_request_target in a list', withAction('      - uses: yokoten-labs/yokoten@v1\n', '[push, pull_request_target]'), { ci: true, titles: true }],
  ['npx yokoten check', withAction('      - run: npx yokoten check\n'), { ci: true, titles: false }],
  ['npx --yes yokoten check --pr', withAction('      - run: npx --yes yokoten@latest check --pr\n'), { ci: false, titles: true }],
  ['a run block with bunx and pnpm dlx', withAction('      - run: |\n          bunx yokoten check\n          pnpm dlx yokoten check --pr\n'), { ci: true, titles: true }],
  // Look-alikes: another action, a package with a longer name, an echo, a comment, a commented-out step.
  ['another action', withAction('      - uses: yokoten-labs/yokoten-extra@v1\n'), { ci: false, titles: false }],
  ['npx yokoten-check', withAction('      - run: npx yokoten-check check\n'), { ci: false, titles: false }],
  ['echo yokoten check', withAction('      - run: echo yokoten check && echo npx yokoten check\n'), { ci: false, titles: false }],
  ['a comment', withAction('      - run: |\n          # npx yokoten check\n          echo hi\n'), { ci: false, titles: false }],
  ['a commented-out step', withAction('      # - uses: yokoten-labs/yokoten@v1\n      - run: echo hi\n'), { ci: false, titles: false }],
];

test('road: the ci and titles steps count the yokoten Action and npx yokoten, and not a look-alike (#298)', () => {
  for (const [name, text, want] of CI_CASES) assert.deepEqual(ciSteps(text), want, name);
});

test('road: the Action and its trigger read a big workflow in linear time (#298)', () => {
  // Each input is about n characters.
  const inputs: [string, (n: number) => string][] = [
    ['newlines', (n) => '\n'.repeat(n)],
    ['list items', (n) => '- a\n'.repeat(n / 4)],
    ['nested dashes', (n) => `- ${'- '.repeat(n / 2)}`],
    ['one item of key lines', (n) => `- uses: x/y@v1\n${'  a: b\n'.repeat(n / 7)}`],
    ['on: and indented lines', (n) => `on:\n${'  push:\n'.repeat(n / 8)}`],
    ['npx flags', (n) => `- run: npx ${'-y '.repeat(n / 3)}`],
    ['a uses ref of words', (n) => `- uses: yokoten-labs/yokoten@${'a '.repeat(n / 2)}"`],
  ];
  for (const [name, make] of inputs) {
    assertLinear(name, make, (ci) => {
      assert.deepEqual(yokotenActions(ci), [], name);
      assert.equal(onPullRequest(ci), false, name);
      assert.equal(ciSteps(ci).ci, false, name);
    });
  }
});

test("road: init's CODEOWNERS with the placeholder owner is to do; with a real owner, or a project's own file, it is done (#304)", () => {
  const codeowners = ROAD.find((s) => s.key === 'codeowners')!;
  const placeholder = fixture({ '.github/CODEOWNERS': codeOwnersText(null) });
  assert.equal(codeowners.check(placeholder, {}, undefined), false);
  assert.equal(codeowners.what(placeholder, {}, undefined), '.github/CODEOWNERS names no owner yet (@YOUR_GITHUB_HANDLE)');
  assert.equal(codeowners.fix(placeholder, {}, undefined), 'put your GitHub handle in .github/CODEOWNERS');
  assert.equal(codeowners.check(fixture({ '.github/CODEOWNERS': codeOwnersText('octo') }), {}, undefined), true);
  assert.equal(codeowners.check(fixture({ 'docs/CODEOWNERS': '* @octo\n' }), {}, undefined), true);
  // The owner put in on every rule line, with init's comment that names the placeholder left as it was.
  const filled = codeOwnersText(null).split('\n').map((line) => (line.startsWith('#') ? line : line.split('@YOUR_GITHUB_HANDLE').join('@octo'))).join('\n');
  assert.match(filled, /^#.*@YOUR_GITHUB_HANDLE/m, 'the comment still names the placeholder');
  assert.equal(codeowners.check(fixture({ '.github/CODEOWNERS': filled }), {}, undefined), true);
  const none = fixture({});
  assert.equal(codeowners.check(none, {}, undefined), false);
  assert.equal(codeowners.what(none, {}, undefined), 'no CODEOWNERS file');
});
