// Tests for src/agents/desk/agent-env.ts.
//
// Every value here is fake, and each token is joined from parts, so no token sits in this
// file whole. Assertions compare names only: a failure message never shows a value.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAgentEnv,
  isSecretValue,
  RUNTIME_ENVS,
  sortAgentEnv,
} from '../../../src/agents/desk/agent-env.ts';

const run = (chars: string, n: number) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);
const alnum = (n: number) => run('a1B2c3D4e5F6g7H8', n);
const upper = (n: number) => run('Q7W3R9T2Y5', n);

// Shaped like real secrets, under names that do not say so: only the value gives them away.
const SECRET_VALUES: Record<string, string> = {
  GITHUB_LIKE: `${'gh'}p_${alnum(36)}`,
  GITHUB_FINE: `${'github'}_pat_${alnum(22)}_${alnum(59)}`,
  AWS_LIKE: `${'AK'}IA${upper(16)}`,
  GOOGLE_LIKE: `${'AI'}za${alnum(35)}`,
  JWT_LIKE: `${'ey'}J${alnum(20)}.${'ey'}J${alnum(30)}.${alnum(20)}`,
  SLACK_LIKE: `${'xo'}xb-${'1234567890'}-${alnum(24)}`,
  OPENAI_LIKE: `${'sk'}-${alnum(40)}`,
  ANTHROPIC_LIKE: `${'sk'}-ant-api03-${alnum(60)}`,
  PEM_LIKE: `-----BEGIN RSA ${'PRIVATE'} KEY-----\n${alnum(64)}\n`,
  DATABASE_URL: `postgres://fakeuser:${'fake'}pass${'@'}db.example.invalid/app`,
  SLASH_PASSWORD_URL: `https://fakeuser:${'fa/ke'}pa/ss${'@'}db.example.invalid/app`,
  HUGGING_FACE_LIKE: `${'h'}f_${alnum(34)}`,
  GITLAB_LIKE: `${'gl'}pat-${alnum(20)}`,
};

// These names put the values on the allow-list, so only the value filter can drop them.
const listed = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.values(values).map((value, i) => [`LC_FAKE_${i}`, value]));

/** The names each value went to in `listed`, by the original key, for a failure message with names only. */
const listedNames = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(values).map((key, i) => [`LC_FAKE_${i}`, key]));

const SAFE = { PATH: '/usr/bin:/bin', HOME: '/home/fake', LANG: 'en_US.UTF-8', TERM: 'xterm', TMPDIR: '/tmp/fake', SHELL: '/bin/bash', USER: 'fake', LC_ALL: 'C' };

test('agent env: PATH, HOME and the other shared names stay; a name not on the list is dropped', () => {
  const env = buildAgentEnv({ ...SAFE, EDITOR: 'vi', SOME_TOOL_FLAG: '1' });
  assert.deepEqual(Object.keys(env).sort(), Object.keys(SAFE).sort());
  assert.equal(env.PATH, SAFE.PATH);
  assert.equal(env.HOME, SAFE.HOME);
});

test('agent env: a GitHub token, an AWS key and a URL with a password are dropped, by name and by value', () => {
  const byName = {
    GH_TOKEN: `${'gh'}p_${alnum(36)}`,
    GITHUB_TOKEN: `${'gh'}s_${alnum(36)}`,
    AWS_ACCESS_KEY_ID: `${'AK'}IA${upper(16)}`,
    AWS_SECRET_ACCESS_KEY: alnum(40),
    NPM_PASSWORD: 'fake',
  };
  const kept = Object.keys(buildAgentEnv({ ...SAFE, ...byName })).sort();
  assert.deepEqual(kept, Object.keys(SAFE).sort(), 'a secret-named variable reached the agent');

  const byValue = buildAgentEnv({ ...SAFE, ...listed(SECRET_VALUES) });
  const leaked = Object.keys(byValue).filter((name) => name.startsWith('LC_FAKE_')).map((name) => listedNames(SECRET_VALUES)[name]);
  assert.deepEqual(leaked, [], 'these secret-shaped values reached the agent');
});

test('agent env: each secret shape is caught, and ordinary values are not', () => {
  const missed = Object.entries(SECRET_VALUES).filter(([, value]) => !isSecretValue(value)).map(([key]) => key);
  assert.deepEqual(missed, [], 'these shapes were not caught');
  const ordinary = { path: '/usr/local/bin:/usr/bin', url: 'https://example.invalid/a:b', locale: 'en_US.UTF-8', words: 'skip-this-option', email: 'fake@example.invalid' };
  const caught = Object.entries(ordinary).filter(([, value]) => isSecretValue(value)).map(([key]) => key);
  assert.deepEqual(caught, [], 'these ordinary values were taken for secrets');
});

test('agent env: a dropped name is sorted by its reason; the result holds names only', () => {
  const sorted = sortAgentEnv({ ...SAFE, GH_TOKEN: `${'gh'}p_${alnum(36)}`, LC_FAKE: `${'AK'}IA${upper(16)}`, EDITOR: 'vi' });
  assert.deepEqual(sorted.dropped, [
    { name: 'EDITOR', reason: 'not on the list' },
    { name: 'GH_TOKEN', reason: 'secret name' },
    { name: 'LC_FAKE', reason: 'secret value' },
  ]);
  assert.deepEqual(Object.keys(sorted).sort(), ['dropped', 'kept']);
});

test("agent env: a vendor's own login name reaches only that vendor's agent", () => {
  const source = { ...SAFE, ANTHROPIC_API_KEY: `${'sk'}-ant-api03-${alnum(60)}`, OPENAI_API_KEY: `${'sk'}-proj-${alnum(60)}` };
  const claude = Object.keys(buildAgentEnv(source, { runtime: 'claude-code' }));
  assert.ok(claude.includes('ANTHROPIC_API_KEY'), 'Claude Code did not get its own login name');
  assert.ok(!claude.includes('OPENAI_API_KEY'), "Claude Code got Codex's login name");
  const codex = Object.keys(buildAgentEnv(source, { runtime: 'codex' }));
  assert.ok(codex.includes('OPENAI_API_KEY'), 'Codex did not get its own login name');
  assert.ok(!codex.includes('ANTHROPIC_API_KEY'), "Codex got Claude Code's login name");
  // Gemini CLI gets its own key, never the general Google Cloud credentials.
  const google = { ...SAFE, GEMINI_API_KEY: `${'AI'}za${alnum(35)}`, GOOGLE_API_KEY: `${'AI'}za${alnum(35)}`, GOOGLE_APPLICATION_CREDENTIALS: '/home/fake/adc.json' };
  assert.deepEqual(Object.keys(buildAgentEnv(google, { runtime: 'gemini' })).sort(), ['GEMINI_API_KEY', ...Object.keys(SAFE)].sort());
  const plain = Object.keys(buildAgentEnv(source));
  assert.deepEqual(plain.sort(), Object.keys(SAFE).sort(), 'an agent with no runtime got a login name');
});

test("agent env: a runtime's config name is still checked; GH_TOKEN never passes as a login name", () => {
  const source = { ...SAFE, GROK_HOME: '/home/fake/.grok', COPILOT_HOME: `https://fakeuser:${'fake'}pass${'@'}host.invalid`, GH_TOKEN: `${'gh'}p_${alnum(36)}` };
  assert.ok(Object.keys(buildAgentEnv(source, { runtime: 'grok' })).includes('GROK_HOME'));
  const copilot = Object.keys(buildAgentEnv(source, { runtime: 'copilot' }));
  assert.ok(!copilot.includes('COPILOT_HOME'), 'a config name with a password in its value passed');
  assert.ok(!copilot.includes('GH_TOKEN'), 'Copilot CLI got the GitHub token');
  for (const [runtime, names] of Object.entries(RUNTIME_ENVS)) {
    const generic = names.login.filter((name) => ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'].includes(name));
    assert.deepEqual(generic, [], `${runtime} names a key that is not its own`);
  }
});

test('agent env: YOKOTEN_* names that make the guard stricter pass; the bot key and the release approval do not', () => {
  const source = { ...SAFE, YOKOTEN_ROLE: 'worker', YOKOTEN_DONE_WHEN: 'node --test', YOKOTEN_PRIVATE_MARKS: '/home/fake/marks', YOKOTEN_BOT_KEY: '/home/fake/key.pem', YOKOTEN_BOT_APP_ID: '1', YOKOTEN_RELEASE_APPROVAL: '1', YOKOTEN_LEAD_ONLY_OK: 'AGENTS.md' };
  const names = Object.keys(buildAgentEnv(source)).filter((name) => name.startsWith('YOKOTEN_')).sort();
  assert.deepEqual(names, ['YOKOTEN_DONE_WHEN', 'YOKOTEN_PRIVATE_MARKS', 'YOKOTEN_ROLE']);
  const set = buildAgentEnv(SAFE, { set: { YOKOTEN_ROLE: 'worker', YOKOTEN_LEAD_ONLY_OK: 'docs/guide.md' } });
  assert.equal(set.YOKOTEN_ROLE, 'worker');
  assert.equal(set.YOKOTEN_LEAD_ONLY_OK, 'docs/guide.md');
  assert.throws(() => buildAgentEnv(SAFE, { set: { GH_TOKEN: 'fake' } }), /only YOKOTEN_\* names/);
});

test('agent env: Windows names pass in any case; an unknown runtime is an error that lists the known ones', () => {
  const windows = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fake', APPDATA: 'C:\\Users\\fake\\AppData\\Roaming', PATHEXT: '.COM;.EXE', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  assert.deepEqual(Object.keys(buildAgentEnv(windows)).sort(), Object.keys(windows).sort());
  assert.throws(() => sortAgentEnv(SAFE, 'nope'), /unknown runtime "nope"\. Runtimes: claude-code, codex/);
  // A long s (U+017F) upper-cases to S in JavaScript; the name must not pass as SHELL.
  const longS = sortAgentEnv({ '\u017FHELL': '/bin/bash' });
  assert.deepEqual(longS.kept, [], 'a name with a long s passed as SHELL');
  assert.deepEqual(longS.dropped.map((drop) => drop.reason), ['not on the list']);
});

test('agent env: a value over 32 KiB is dropped as too long, and a 100k value is sorted fast', () => {
  const long = `/usr/bin:${'a'.repeat(100_000)}`;
  const started = performance.now();
  const sorted = sortAgentEnv({ PATH: long, HOME: '/home/fake' });
  const elapsed = performance.now() - started;
  assert.deepEqual(sorted.kept, ['HOME']);
  assert.deepEqual(sorted.dropped, [{ name: 'PATH', reason: 'too long' }]);
  assert.ok(elapsed < 100, `sorting a 100k value took ${Math.round(elapsed)} ms`);
  // Under the cap, the patterns themselves still take linear time on shapes that nearly match.
  const nearMisses = ['eyJ'.repeat(10_000), `a://${':'.repeat(10_000)}`, `${'a'.repeat(5_000)}://${'b'.repeat(5_000)}`];
  for (const value of nearMisses) {
    const start = performance.now();
    isSecretValue(value);
    assert.ok(performance.now() - start < 100, 'a near-miss value took 100 ms or more');
  }
});
