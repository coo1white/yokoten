// Tests for src/host/github.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../repo/helpers.ts';
import {
  DEFAULTS,
  type Env,
} from '../../src/rules/config.ts';
import {
  checkIssueTitle,
  checkPullRequestTitle,
} from '../../src/rules/pr.ts';
import { GitReadError } from '../../src/run/check.ts';
import {
  draftLesson,
  type Incident,
} from '../../src/run/learn.ts';
import {
  annotation,
  annotations,
  appJwt,
  botConfig,
  botEnv,
  botProgram,
  cleanChildEnv,
  type Gh,
  hasBot,
  installationToken,
  readBranchFiles,
  readCodeOwners,
  readCommandTitle,
  readIncident,
  readIssueMilestone,
  readLocalLogins,
  readLogin,
  repoOf,
  shellValue,
  stepSummary,
} from '../../src/host/github.ts';
import { syncBoard } from '../../scripts/board-sync.ts';
import { makeSandbox } from '../repo/helpers.ts';

// A throwaway key, made for this test run only.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

test('JWT: RS256, issued by the App, nine minutes, and the signature checks out', () => {
  const jwt = appJwt('12345', pem, 1_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), { iat: 999_940, exp: 1_000_540, iss: '12345' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
});

test('token: finds the installation from the repo, then exchanges the JWT', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? '')}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const dir = makeTempDir();
  writeFileSync(join(dir, 'bot.pem'), pem);
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // With NODE_USE_ENV_PROXY=1, fetch sends even a local call through the shell's proxy,
  // which closes it. The fake API is on this machine, so the call goes to it directly.
  // Node reads both spellings of the variable, so both are set, then put back.
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  try {
    const token = await installationToken({ appId: '1', keyFile: join(dir, 'bot.pem'), api }, 'me/repo');
    assert.equal(token, 'ghs_test');
    assert.deepEqual(seen, ['GET /repos/me/repo/installation true', 'POST /app/installations/77/access_tokens true']);
  } finally {
    server.close();
    for (const [name, value] of [['NO_PROXY', saved.upper], ['no_proxy', saved.lower]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('config: the App ID is required, the key has a default place', () => {
  assert.match(botConfig({}) as string, /YOKOTEN_BOT_APP_ID/);
  const c = botConfig({ YOKOTEN_BOT_APP_ID: '9', HOME: '/h' });
  assert.ok(typeof c !== 'string');
  assert.equal(c.keyFile, join('/h', '.config', 'yokoten', 'bot.pem'));
  assert.equal(c.api, 'https://api.github.com');
  // No HOME: no default key file, rather than one in the folder the command runs in (#356).
  assert.match(botConfig({ YOKOTEN_BOT_APP_ID: '9' }) as string, /no home folder/);
  assert.equal((botConfig({ YOKOTEN_BOT_APP_ID: '9', YOKOTEN_BOT_KEY: '/k.pem' }) as { keyFile: string }).keyFile, '/k.pem');
});

test('config: the keys file gives the bot settings the session does not have (#405)', () => {
  const home = makeTempDir('yokoten-keys-');
  const config = join(home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  assert.equal(hasBot({ HOME: home }), false, 'nothing set up');
  writeFileSync(join(config, 'bot.pem'), 'not a real key\n');
  assert.equal(hasBot({ HOME: home }), false, 'a key file with no App ID is no bot: `yokoten bot` would stop too');
  writeFileSync(join(config, 'keys.env'), '# keys\nOTHER_API_KEY=placeholder\nexport YOKOTEN_BOT_APP_ID="42"\nYOKOTEN_BOT_INSTALLATION=\x277\x27\n');
  const c = botConfig({ HOME: home });
  assert.ok(typeof c !== 'string', 'the App ID comes from the keys file');
  assert.deepEqual([c.appId, c.installation, c.keyFile], ['42', '7', join(config, 'bot.pem')]);
  assert.equal(hasBot({ HOME: home }), true, 'the road and `yokoten bot` agree');
  assert.equal(Object.hasOwn(c, 'OTHER_API_KEY'), false);
  // The environment comes first.
  const fromEnv = botConfig({ HOME: home, YOKOTEN_BOT_APP_ID: '9' });
  assert.ok(typeof fromEnv !== 'string');
  assert.equal(fromEnv.appId, '9');
  // No HOME: the keys file is not read.
  assert.equal(typeof botConfig({}), 'string');
});

test('config: a keys file value reads as a shell profile line gives it (#405)', () => {
  const home = '/home/someone';
  const cases: [string, string][] = [
    ['42', '42'],
    ['42 # the App ID', '42'],
    ['a#b', 'a#b'],
    ['"42" # quoted', '42'],
    ["'42'", '42'],
    ['"a # b"', 'a # b'],
    ['~/keys/bot.pem', '/home/someone/keys/bot.pem'],
    ['$HOME/keys/bot.pem # moved', '/home/someone/keys/bot.pem'],
    ['"${HOME}/keys/bot.pem"', '/home/someone/keys/bot.pem'],
    ["'$HOME/x'", '$HOME/x'],
    ['"~/x"', '~/x'],
    ['~user/x', '~user/x'],
  ];
  for (const [raw, value] of cases) assert.equal(shellValue(raw, home), value, raw);
  const dir = makeTempDir('yokoten-keys-');
  mkdirSync(join(dir, '.config', 'yokoten'), { recursive: true });
  writeFileSync(join(dir, '.config', 'yokoten', 'keys.env'), 'export YOKOTEN_BOT_APP_ID=42 # the App ID\nYOKOTEN_BOT_KEY="$HOME/elsewhere.pem"\n');
  const c = botConfig({ HOME: dir });
  assert.ok(typeof c !== 'string');
  assert.deepEqual([c.appId, c.keyFile], ['42', join(dir, 'elsewhere.pem')]);
});

test('repo: read from https and ssh remotes', () => {
  assert.equal(repoOf('https://github.com/me/repo.git\n'), 'me/repo');
  assert.equal(repoOf('git@github.com:me/repo.git'), 'me/repo');
  assert.equal(repoOf('https://github.com/me/repo'), 'me/repo');
  assert.equal(repoOf('https://example.com/me/repo.git'), null);
});

test('env: gh gets the token, and git asks gh for github.com instead of the owner\'s login', () => {
  const e = botEnv({ PATH: '/bin', GIT_CONFIG_COUNT: '1' }, 'tok');
  assert.equal(e.GH_TOKEN, 'tok');
  assert.equal(e.GIT_CONFIG_COUNT, '3');
  assert.equal(e.GIT_CONFIG_VALUE_1, '');
  assert.equal(e.GIT_CONFIG_VALUE_2, '!gh auth git-credential');
  assert.equal(e.PATH, '/bin');
});

// A child `node --test` that inherits NODE_TEST_CONTEXT reports to the parent run and exits 0
// whatever happens (#168). The control proves the trap is real, so the fix is not a no-op.
test('child env: a failing child node --test fails only once NODE_TEST_CONTEXT is gone (#168)', () => {
  const file = join(makeTempDir('yokoten-child-'), 'fail.test.ts');
  writeFileSync(file, "import { test } from 'node:test';\ntest('fails', () => { throw new Error('fails on purpose'); });\n");
  // The parent's own env when this runs under node --test; the same value when run alone.
  const parentEnv = { ...process.env, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? 'child-v8' };
  const runChild = (env: Env) => spawnSync(process.execPath, ['--test', file], { env, encoding: 'utf8' }).status;
  assert.equal(runChild(parentEnv), 0, 'the trap is gone: a child with the parent env now fails on its own');
  assert.equal(runChild(cleanChildEnv(parentEnv)), 1, 'a failing child test passed with a clean env');
  assert.equal(cleanChildEnv(parentEnv).PATH, process.env.PATH);
  assert.equal(botEnv(parentEnv, 'tok').NODE_TEST_CONTEXT, undefined, 'yokoten bot -- <command> passes the test context on');
});

test('command title: the title gh issue or gh pr create or edit sets; null for anything else (#117)', () => {
  const read = (line: string) => readCommandTitle(line.split(' '));
  assert.deepEqual(read('gh issue create --title host:x --label feat,incident -l tier'), { kind: 'issue', title: 'host:x', labels: ['feat', 'incident', 'tier'] });
  assert.deepEqual(read('gh issue edit 5 --title=a --add-label incident'), { kind: 'issue', title: 'a', labels: ['incident'] });
  assert.deepEqual(read('gh pr create -t a --body b'), { kind: 'pr', title: 'a', labels: [] });
  assert.deepEqual(read('/usr/bin/gh pr edit 5 -ta'), { kind: 'pr', title: 'a', labels: [] }, 'a path to gh, and an attached short value');
  assert.equal(read('gh pr create -t a -t b')?.title, 'b', 'the last one wins, as in gh');
  assert.equal(read('gh pr create --body -t --title a')?.title, 'a', 'the value of another option is not read as an option');
  assert.equal(read('gh pr create --body -t'), null);
  assert.equal(read('gh pr create --fill'), null, 'no title: CI checks it');
  assert.equal(read('gh pr create -- --title a'), null, 'nothing after --');
  assert.equal(read('gh pr create --title'), null, 'no value');
  for (const line of ['gh pr view --title a', 'gh repo create --title a', 'git commit --title a', 'gh issue']) assert.equal(read(line), null, line);
});

test('command title: every spelling gh takes for create and edit is read (#279)', () => {
  const read = (line: string) => readCommandTitle(line.split(' '));
  const spellings: [string, 'issue' | 'pr'][] = [
    ['gh issue new --title Broken', 'issue'],
    ['gh pr new --title Broken', 'pr'],
    ['gh issue -R o/r create --title Broken', 'issue'],
    ['gh issue --repo=o/r new -t Broken', 'issue'],
    ['gh --repo o/r pr create --title Broken', 'pr'],
    ['gh -Ro/r issue create --title=Broken', 'issue'],
    ['gh pr -R o/r edit 5 --title Broken', 'pr'],
    ['gh issue --title Broken create', 'issue'],
    ['gh issue --body-file f -t Broken new', 'issue'],
    ['gh issue create --parent 3 --type Bug --title Broken', 'issue'],
  ];
  for (const [line, kind] of spellings) assert.deepEqual(read(line), { kind, title: 'Broken', labels: [] }, line);
  assert.deepEqual(read('gh -R o/r issue -l feat new -t a'), { kind: 'issue', title: 'a', labels: ['feat'] }, 'a label before the verb');
  assert.equal(read('gh -R issue pr create --title a')?.kind, 'pr', 'the value of -R is not the noun');
  assert.equal(read('gh issue --body create view --title a'), null, 'the value of --body is not the verb');
  for (const line of ['gh -R o/r issue view --title a', 'gh --repo o/r repo create --title a', 'gh issue new -- --title a', 'gh -R o/r']) assert.equal(read(line), null, line);
});

test('command title: short flags run together are read as gh reads them (#290)', () => {
  const read = (line: string) => readCommandTitle(line.split(' '));
  const spellings: [string, 'issue' | 'pr', string[]][] = [
    ['gh pr create -dt Broken', 'pr', []],
    ['gh pr create -dtBroken', 'pr', []],
    ['gh pr create -dlbug -t Broken', 'pr', ['bug']],
    ['gh pr create -dl bug -dwt Broken', 'pr', ['bug']],
    ['gh issue create -et Broken', 'issue', []],
    ['gh issue create -t Broken', 'issue', []],
    ['gh issue create -tBroken', 'issue', []],
    ['gh issue -Ro/r create -wtBroken', 'issue', []],
    ['gh pr edit 5 -t Broken -dfb -t', 'pr', []],
  ];
  for (const [line, kind, labels] of spellings) assert.deepEqual(read(line), { kind, title: 'Broken', labels }, line);
  assert.equal(read('gh pr create -dt a -t b')?.title, 'b', 'the last one still wins');
  assert.equal(read('gh pr create -df'), null, 'switches only: no title');
  // A letter gh's create and edit don't have: the bot can't tell what the word holds, so it refuses.
  assert.deepEqual(read('gh pr create -dzt Broken'), { kind: 'pr', unreadable: '-dzt' });
  assert.deepEqual(read('gh issue create -zt Broken --title Fine'), { kind: 'issue', unreadable: '-zt' }, 'even with a readable title after it');
  assert.deepEqual(read('gh issue edit 5 -dz'), { kind: 'issue', unreadable: '-dz' });
  assert.equal(read('gh pr view -zt a'), null, 'only create and edit are checked');
  assert.deepEqual(read('gh pr create --body -zt --title a'), { kind: 'pr', title: 'a', labels: [] }, 'the value of another option is not read');
});

test('command title: good titles in run-together short flags pass the title rules (#290)', () => {
  const config = { ...DEFAULTS, areas: ['host'] };
  const good = 'feat(host): check the title';
  for (const command of [['gh', 'pr', 'create', '-dt', good], ['gh', 'pr', 'create', `-dt${good}`], ['gh', 'pr', 'create', '-dlbug', '-t', good]]) {
    const found = readCommandTitle(command);
    assert.ok(found && !('unreadable' in found), command.join(' '));
    assert.deepEqual(checkPullRequestTitle(found.title, config), [], command.join(' '));
  }
  const issue = readCommandTitle(['gh', 'issue', 'create', '-wlbug', '-thost: check the title']);
  assert.ok(issue && !('unreadable' in issue));
  assert.deepEqual(issue.labels, ['bug']);
  assert.deepEqual(checkIssueTitle(issue.title, config, issue.labels), []);
});

test('bot program: gh and git by base name, .exe stripped; anything else is null (#295)', () => {
  for (const file of ['gh', 'gh.exe', 'gh.EXE', '/usr/bin/gh', 'C:\\tools\\gh.exe']) assert.equal(botProgram(file), 'gh', file);
  for (const file of ['git', 'git.exe', '/usr/bin/git']) assert.equal(botProgram(file), 'git', file);
  for (const file of ['env', '/usr/bin/env', 'sh', 'bash', 'node', 'npx', 'ghx', 'gh.sh', 'xgh', '']) assert.equal(botProgram(file), null, file);
});

test('command title: gh.exe, a path to gh, and -t=X are read as gh reads them (#295)', () => {
  const read = (line: string) => readCommandTitle(line.split(' '));
  for (const line of ['gh.exe issue create -t Broken', 'gh.EXE issue create -t Broken', '/usr/bin/gh issue create -t Broken', 'gh issue create -t=Broken', 'gh issue create -dt=Broken']) {
    assert.deepEqual(read(line), { kind: 'issue', title: 'Broken', labels: [] }, line);
  }
  assert.equal(read('gh pr create -t==Broken')?.title, '=Broken', 'only one = is dropped');
  assert.equal(read('gh pr create --title==Broken')?.title, '=Broken', 'a long option keeps what follows its =');
  const found = readCommandTitle(['gh', 'pr', 'create', '-t=feat(host): check the title']);
  assert.ok(found && !('unreadable' in found));
  assert.deepEqual(checkPullRequestTitle(found.title, { ...DEFAULTS, areas: ['host'] }), [], 'a good title written -t=X passes');
});

test('command title: gh api reads title= on an issue or pull request path (#295)', () => {
  const read = (line: string) => readCommandTitle(line.split(' '));
  const issues: string[] = [
    'gh api repos/o/r/issues -f title=Broken',
    'gh api /repos/o/r/issues -F title=Broken',
    'gh api repos/o/r/issues/5 -X PATCH --field title=Broken',
    'gh api -X PATCH repos/o/r/issues/5 --raw-field title=Broken',
    'gh api repos/{owner}/{repo}/issues --field=title=Broken',
    'gh api repos/o/r/issues -ftitle=Broken',
    'gh api repos/o/r/issues -f=title=Broken',
    'gh api repos/o/r/issues -iftitle=Broken',
    'gh api repos/o/r/issues -f title=a -f body=b -f title=Broken',
  ];
  for (const line of issues) assert.deepEqual(read(line), { kind: 'issue', title: 'Broken', labels: [] }, line);
  assert.deepEqual(read('gh api -X PATCH repos/o/r/pulls/5 -f title=Broken'), { kind: 'pr', title: 'Broken', labels: [] });
  assert.deepEqual(read('gh api repos/o/r/issues -F title=@title.txt'), { kind: 'issue', unreadable: 'title=@title.txt' }, 'a title gh reads from a file');
  assert.equal(read('gh api repos/o/r/issues -f title=@x')?.title, '@x', 'a raw field is the text itself');
  assert.deepEqual(read('gh api repos/o/r/pulls -zf title=Broken'), { kind: 'pr', unreadable: '-zf' });
  for (const line of [
    'gh api graphql -f query=x -f title=Broken',
    'gh api repos/o/r/issues/5/comments -f title=Broken',
    'gh api repos/o/r/labels -f title=Broken',
    'gh api repos/o/r/issues -f body=x',
    'gh api repos/o/r/issues -t title=Broken',
    'gh api -H title=x repos/o/r/issues',
  ]) assert.equal(read(line), null, line);
});

// #91: workflow commands, escaped as GitHub's runner decodes them
// (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands).
test('annotations: escape the message and the properties; a history place goes in the message (#91)', () => {
  const f = { id: 'layout', what: '100% full,\nline two\r', why: 'a: b', fix: 'see a, b', file: 'docs/a,b:c.md', line: 7 };
  assert.equal(annotation(f, 'error'), '::error file=docs/a%2Cb%3Ac.md,line=7,title=yokoten layout::100%25 full,%0Aline two%0D. A: b. See a, b.');
  assert.equal(annotation({ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }, 'warning'), '::warning title=yokoten large-diff::big. W. F.');
  assert.equal(annotation({ ...f, what: 'x', file: 'commit abc (message)', line: 1 }, 'error', false), '::error title=yokoten layout::commit abc (message):1: x. A: b. See a, b.');
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.equal(annotation(linked, 'error'), '::error file=a.md,line=1,title=yokoten email::an email. W. F.%0A  docs: https://example.com/guide#privacy', 'the link goes in the message (#94)');
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const lines = annotations(many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.equal(lines.length, 50, 'GitHub shows at most 50 per job');
  assert.ok(lines.every((l) => l.startsWith('::error ')), 'problems come before notes');
});

test('step summary: a heading with the result, a table, notes apart, at most 50 rows (#91)', () => {
  assert.equal(stepSummary('yokoten check', [], []), '### yokoten check: ok\n\n');
  // GitHub renders the summary as HTML: a `<` in a cell would hide the text after it.
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'an email', why: 'w', fix: 'f', file: '<draft>.md', line: 1 }], []), /\| &lt;draft>\.md:1 \|/);
  assert.match(stepSummary('yokoten check', [{ id: 'email', what: 'a\\|b', why: 'w', fix: 'f' }], []), /\| a\\\\\\\|b \|/);
  const one = stepSummary('yokoten check --pr', [{ id: 'pr-title', what: 'title: a | b', why: 'why', fix: 'fix it' }], [{ id: 'long-sentence', what: 'long', why: 'w', fix: 'f', file: 'a.md', line: 2 }]);
  assert.equal(one, [
    '### yokoten check --pr: 1 problem',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '|  | pr-title | title: a \\| b | Why | Fix it |',
    '',
    '#### Notes (1): these never fail the check',
    '',
    '| Place | Rule | What | Why | Fix |',
    '|-------|------|------|-----|-----|',
    '| a.md:2 | long-sentence | long | W | F |',
    '',
    '',
  ].join('\n'));
  // The id links to its section (#94).
  const linked = { id: 'email', what: 'an email', why: 'w', fix: 'f', docs: 'https://example.com/guide#privacy', file: 'a.md', line: 1 };
  assert.match(stepSummary('yokoten check', [linked], []), /\n\| a\.md:1 \| \[email\]\(https:\/\/example\.com\/guide#privacy\) \| an email \| W \| F \|\n/);
  const many = Array.from({ length: 53 }, (_, i) => ({ id: 'email', what: `e${i}`, why: 'w', fix: 'f', file: 'a.md', line: i + 1 }));
  const text = stepSummary('yokoten check', many, [{ id: 'large-diff', what: 'big', why: 'w', fix: 'f' }]);
  assert.match(text, /^### yokoten check: 53 problems\n/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('| a.md:')).length, 50);
  assert.match(text, /\nAnd 3 more\. The job log lists them all\.\n/);
  assert.match(text, /#### Notes \(1\): these never fail the check\n\nThe job log lists them\.\n/);
});

// `yokoten learn` (#77) reads an incident through gh. A fake gh stands in; GitHub is never reached.
test('incident: read through gh issue view; a bad reference or a gh failure is a reason, never a crash', () => {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    return JSON.stringify({ number: 12, title: 'check: misses a key', body: '## Fix\n\nA check.', url: 'https://example.com/issues/12', labels: [{ name: 'incident' }, { name: 'bug' }] });
  };
  assert.deepEqual(readIncident(gh, '12'), { number: 12, title: 'check: misses a key', body: '## Fix\n\nA check.', url: 'https://example.com/issues/12', labels: ['incident', 'bug'] });
  assert.deepEqual(calls, [['issue', 'view', '12', '--json', 'number,title,body,url,labels']]);
  assert.equal(typeof readIncident(gh, 'https://github.com/owner/repo/issues/12'), 'object');
  for (const bad of ['--web', '12; rm', 'https://example.com/issues/12']) assert.match(String(readIncident(gh, bad)), /is not an issue: give its number, or a URL/);
  assert.equal(calls.length, 2, 'a bad reference never reaches gh');
  const missing: Gh = () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  assert.match(String(readIncident(missing, '12')), /^gh is not installed/);
  const refused: Gh = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'GraphQL: Could not resolve to an issue\nmore' });
  };
  assert.equal(readIncident(refused, '99'), 'gh can\'t read issue 99 (GraphQL: Could not resolve to an issue): run `gh auth login`, and check the number and the repo');
  const escaping: Gh = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'bad \u001b[2K\u001b]8;;https://example.com\u0007link' });
  };
  assert.ok(!/[\u001b\u0007]/.test(String(readIncident(escaping, '99'))), 'gh\'s error text reaches the terminal with no raw escape');
});

test('incident: the number gh gives must be a whole number above 0, since it names the draft\'s folder', () => {
  const ghWith = (number: unknown): Gh => () => JSON.stringify({ number, title: 'check: misses a key', body: '', url: 'https://example.com/issues/1', labels: [] });
  for (const bad of ['1/../../x', 0, -1, 1.5, 2 ** 53, null, undefined]) {
    const result = readIncident(ghWith(bad), '1');
    assert.equal(result, 'gh gave no issue number for 1: it must be a whole number above 0', `number ${String(bad)}`);
  }
  assert.equal((readIncident(ghWith(7), '1') as { number: number }).number, 7);
});

test('incident: an odd title is a reason; an odd body or url is empty, and the draft has a TODO for the url', () => {
  const ghWith = (fields: Record<string, unknown>): Gh => () => JSON.stringify({ number: 3, title: 'check: misses a key', body: '## Fix\n\nA check.', url: 'https://example.com/issues/3', labels: [], ...fields });
  for (const odd of [null, 7, { text: 'x' }, ['x'], undefined]) {
    assert.equal(readIncident(ghWith({ title: odd }), '3'), 'gh gave no title for 3', `title ${JSON.stringify(odd)}`);
    const noBody = readIncident(ghWith({ body: odd }), '3') as Incident;
    assert.equal(noBody.body, '', `body ${JSON.stringify(odd)}`);
    assert.equal(typeof draftLesson(noBody).finding.fix, 'string');
    const noUrl = readIncident(ghWith({ url: odd }), '3') as Incident;
    assert.equal(noUrl.url, '', `url ${JSON.stringify(odd)}`);
    assert.match(draftLesson(noUrl).files[0].text, /^\/\/ TODO\(reviewer\): gh gave no URL for the issue$/m);
    assert.deepEqual((readIncident(ghWith({ labels: odd }), '3') as Incident).labels, [], `labels ${JSON.stringify(odd)}`);
  }
  // Only entries with a string name are kept.
  const mixed = [{ name: 'incident' }, null, 7, 'bug', { name: 5 }, { name: null }, {}, { name: '' }, [{ name: 'x' }], { name: 'bug' }];
  assert.deepEqual((readIncident(ghWith({ labels: mixed }), '3') as Incident).labels, ['incident', 'bug']);
});

// The board sync (#165), against a fake GraphQL API. Two pages of items; the mutations
// are recorded and applied to the fake board, never sent anywhere, so a second run sees
// what the first one wrote.
test('board sync: fills empty fields, keeps filled ones and Done, a dry run writes nothing, and a second run changes nothing', async () => {
  const issue = (number: number, state: string, created: string, closed: string | null, extra: Record<string, unknown> = {}) => ({
    __typename: 'Issue', number, state, createdAt: `${created}T08:00:00Z`, closedAt: closed && `${closed}T09:00:00Z`,
    milestone: null, repository: { nameWithOwner: 'octo/demo' }, timelineItems: { nodes: [] }, ...extra,
  });
  const date = (value: string) => ({ date: value });
  const pages = [[
    { id: 'empty', start: null, target: null, status: null, content: issue(1, 'OPEN', '2026-10-01', null, { milestone: { dueOn: '2026-10-26T07:00:00Z' } }) },
    { id: 'filled', start: date('2026-09-01'), target: date('2026-09-30'), status: { name: 'In progress' }, content: issue(2, 'CLOSED', '2026-10-01', '2026-10-05') },
    { id: 'done-open', start: date('2026-10-01'), target: date('2026-10-02'), status: { name: 'Done', updatedAt: '2026-10-03T00:00:00Z' }, content: issue(3, 'OPEN', '2026-10-01', null) },
    { id: 'done-closed', start: date('2026-09-20'), target: date('2026-09-25'), status: { name: 'Done', updatedAt: '2026-09-25T10:00:00Z' }, content: issue(7, 'CLOSED', '2026-10-01', '2026-10-05') },
  ], [
    { id: 'pr', start: date('2026-10-01'), target: null, status: { name: 'Todo' }, content: { ...issue(4, 'OPEN', '2026-10-01', null), __typename: 'PullRequest' } },
    { id: 'reopened', start: date('2026-10-01'), target: date('2026-10-02'), status: { name: 'Done', updatedAt: '2026-10-03T00:00:00Z' }, content: issue(5, 'OPEN', '2026-10-01', null, { timelineItems: { nodes: [{ createdAt: '2026-10-04T00:00:00Z' }] } }) },
    { id: 'early-close', start: date('2026-10-12'), target: null, status: { name: 'Done' }, content: { ...issue(6, 'MERGED', '2026-10-10', '2026-10-11'), __typename: 'PullRequest' } },
    { id: 'draft', start: null, target: null, status: null, content: { __typename: 'DraftIssue' } },
  ]];
  const writes: Array<{ item: string; field: string; value: any }> = [];
  // The fake board applies each write, as GitHub would.
  const applyWrite = (write: { item: string; field: string; value: any }) => {
    const item: any = pages.flat().find((node) => node.id === write.item);
    if (write.field === 'F-start') item.start = date(write.value.date);
    else if (write.field === 'F-target') item.target = date(write.value.date);
    else if (write.field === 'F-status') item.status = { name: write.value.singleSelectOptionId.replace(/^O-/, ''), updatedAt: new Date().toISOString() };
    else throw new Error(`unknown field ${write.field}`);
  };
  const before = JSON.stringify(pages);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { query, variables } = JSON.parse(raw);
      assert.equal(req.headers.authorization, 'Bearer t');
      let data: unknown;
      if (query.startsWith('mutation')) {
        writes.push({ item: variables.item, field: variables.field, value: variables.value });
        applyWrite(writes.at(-1)!);
        data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } };
      } else if (query.includes('fields(first')) {
        data = { organization: { projectV2: { id: 'P1', fields: { nodes: [
          { id: 'F-title', name: 'Title' }, { id: 'F-start', name: 'Start' }, { id: 'F-target', name: 'Target' },
          { id: 'F-status', name: 'Status', options: ['Todo', 'In progress', 'In review', 'Done'].map((name) => ({ id: `O-${name}`, name })) },
        ] } } } };
      } else {
        const index = variables.after === null ? 0 : 1;
        data = { organization: { projectV2: { items: { pageInfo: { hasNextPage: index === 0, endCursor: 'c1' }, nodes: pages[index] } } } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  // As in the token test: the fake API is local, so fetch must not use the shell's proxy.
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  try {
    const lines: string[] = [];
    const options = { owner: 'octo', number: 1, token: 't', api, isDryRun: true, log: (line: string) => lines.push(line) };
    const planned = await syncBoard(options);
    assert.deepEqual(writes, [], 'a dry run writes nothing');
    assert.equal(JSON.stringify(pages), before, 'a dry run leaves the board as it was');
    assert.deepEqual(planned.map((c) => `${c.item} ${c.field}=${c.value}`), [
      'empty Start=2026-10-01', 'empty Target=2026-10-26', 'empty Status=Todo',
      'filled Status=Done',
      'pr Status=In review',
      'reopened Status=Todo',
      'early-close Target=2026-10-12',
    ]);
    assert.match(lines.at(-1)!, /^8 items, 7 change\(s\) \(dry run: nothing written\)$/);
    assert.match(lines[0], /^would set octo\/demo#1 Start: 2026-10-01$/);

    const written = await syncBoard({ ...options, isDryRun: false });
    assert.deepEqual(written, planned);
    assert.deepEqual(writes.slice(0, 3), [
      { item: 'empty', field: 'F-start', value: { date: '2026-10-01' } },
      { item: 'empty', field: 'F-target', value: { date: '2026-10-26' } },
      { item: 'empty', field: 'F-status', value: { singleSelectOptionId: 'O-Todo' } },
    ]);
    assert.equal(writes.length, 7);

    // A Done item keeps Done and its dates.
    const doneItems = () => pages.flat().filter((node) => node.id.startsWith('done-')).map((node) => JSON.stringify(node));
    const doneBefore = JSON.parse(before).flat().filter((node: { id: string }) => node.id.startsWith('done-')).map((node: unknown) => JSON.stringify(node));
    assert.deepEqual(doneItems(), doneBefore, 'the first run keeps Done items as they were');

    // The second run, on the board the first one wrote: no mutation, nothing changed.
    lines.length = 0;
    const second = await syncBoard({ ...options, isDryRun: false });
    assert.deepEqual(second, [], 'a second run plans nothing');
    assert.equal(writes.length, 7, 'a second run sends no mutation');
    assert.deepEqual(lines, ['8 items, 0 change(s)']);
    assert.deepEqual(doneItems(), doneBefore, 'the second run keeps Done items as they were');
  } finally {
    server.close();
    for (const [name, value] of [['NO_PROXY', saved.upper], ['no_proxy', saved.lower]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('readLogin: the signed-in login, or null when gh fails or answers something else (#390)', () => {
  const asked: string[][] = [];
  assert.equal(readLogin((args) => (asked.push(args), 'someone-1\n')), 'someone-1');
  assert.deepEqual(asked, [['api', 'user', '--jq', '.login']]);
  assert.equal(readLogin(() => { throw new Error('not signed in'); }), null);
  assert.equal(readLogin(() => '{"message":"Bad credentials"}'), null);
  assert.equal(readLogin(() => ''), null);
});

// #392: the gh login, read from gh's own file on this machine, with no network call.
test('readLocalLogins: the user under each host in hosts.yml; none when the file is missing', () => {
  const home = makeTempDir('yokoten-gh-');
  assert.deepEqual(readLocalLogins({ HOME: home }), []);
  mkdirSync(join(home, '.config', 'gh'), { recursive: true });
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    users:\n        octo-jane:\n    user: octo-jane\n    git_protocol: https\nghe.example.com:\n    user: "jroe"\n');
  assert.deepEqual(readLocalLogins({ HOME: home }), ['octo-jane', 'jroe']);
  const other = makeTempDir('yokoten-gh-');
  writeFileSync(join(other, 'hosts.yml'), 'github.com:\n    user: someone-else\n');
  assert.deepEqual(readLocalLogins({ HOME: home, GH_CONFIG_DIR: other }), ['someone-else'], 'GH_CONFIG_DIR first, as gh reads it');
});

// #406: the bot reads the branch's files as check --pr reads a pull request's: a rename is its new path.
test('branch files: changed, renamed and deleted paths since the base, from one local diff (#406)', () => {
  const dir = makeTempDir('yokoten-');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'old.ts'), 'export const long = "a long enough line for git to see a rename";\n');
  writeFileSync(join(dir, 'gone.md'), 'Gone.\n');
  writeFileSync(join(dir, 'same.md'), 'Same.\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('mv', 'src/old.ts', 'src/new name.ts');
  git('rm', '-q', 'gone.md');
  writeFileSync(join(dir, 'kit.md'), 'New.\n');
  git('add', '.');
  git('commit', '-qm', 'head');
  const read = readBranchFiles(dir, 'origin/main', 'HEAD', process.env);
  assert.deepEqual({ files: read?.files.sort(), deleted: read?.deleted }, { files: ['gone.md', 'kit.md', 'src/new name.ts'], deleted: ['gone.md'] });
  assert.equal(readBranchFiles(dir, 'origin/none', 'HEAD', process.env), null, 'a base git does not have');
});

// No answer from git is never "no CODEOWNERS", which would let a pull request lower its tier (#403).
test('readCodeOwners: the first place the base commit has; a base git can\'t read throws, never null (#403)', () => {
  const sandbox = makeSandbox();
  sandbox.write('README.md', 'a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'none');
  const none = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  sandbox.write('docs/CODEOWNERS', '/docs/ @b\n');
  sandbox.write('CODEOWNERS', '/kit/ @a\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'owners');
  const owners = sandbox.git('rev-parse', 'HEAD').stdout.trim();
  // The work tree has another file, which a pull request run must not read.
  sandbox.write('CODEOWNERS', '');
  assert.equal(readCodeOwners(sandbox.repo, none, process.env), null);
  assert.deepEqual(readCodeOwners(sandbox.repo, owners, process.env), { text: '/kit/ @a\n', from: 'the base branch' });
  assert.throws(() => readCodeOwners(sandbox.repo, 'f'.repeat(40), process.env), GitReadError);
});

// #512: an issue's milestone, from one `gh issue view`; a fake gh stands in for GitHub.
test('readIssueMilestone: the title, null for none, undefined when gh cannot read it (#512)', () => {
  const calls: string[][] = [];
  const answer = (said: string): Gh => (args) => {
    calls.push(args);
    return said;
  };
  assert.equal(readIssueMilestone(answer(JSON.stringify({ milestone: { number: 1, title: 'v0.1.0' } })), 5, null), 'v0.1.0');
  assert.deepEqual(calls, [['issue', 'view', '5', '--json', 'milestone']]);
  assert.equal(readIssueMilestone(answer(JSON.stringify({ milestone: null })), 5, 'o/r'), null);
  assert.deepEqual(calls.at(-1), ['issue', 'view', '5', '--json', 'milestone', '--repo', 'o/r']);
  for (const said of ['', 'not json', '{}', '[]', JSON.stringify({ milestone: { title: '' } })]) {
    assert.equal(readIssueMilestone(answer(said), 5, null), undefined, said);
  }
  const failing: Gh = () => {
    throw new Error('gh: network');
  };
  assert.equal(readIssueMilestone(failing, 5, null), undefined);
});
