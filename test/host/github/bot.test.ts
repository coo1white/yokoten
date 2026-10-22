// Tests for src/host/github/bot.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../../repo/helpers.ts';
import { DEFAULTS, type Env } from '../../../src/rules/config.ts';
import { checkIssueTitle, checkPullRequestTitle } from '../../../src/rules/pr.ts';
import { appJwt, botConfig, botEnv, botProgram, cleanChildEnv, hasBot, installationToken, readCommandTitle, shellValue } from '../../../src/host/github/bot.ts';

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

test('env: gh gets the token, and git asks gh for github.com instead of the owner\'s login', () => {
  const e = botEnv({ PATH: '/bin', GIT_CONFIG_COUNT: '1' }, 'tok');
  assert.equal(e.GH_TOKEN, 'tok');
  assert.equal(e.GIT_CONFIG_COUNT, '3');
  assert.equal(e.GIT_CONFIG_VALUE_1, '');
  assert.equal(e.GIT_CONFIG_VALUE_2, '!gh auth git-credential');
  assert.equal(e.PATH, '/bin');
  // gh sends TZ as its Time-Zone header, so the bot always runs on UTC (#488).
  assert.equal(e.TZ, 'UTC');
  assert.equal(botEnv({ TZ: 'Asia/Tokyo' }, 'tok').TZ, 'UTC', 'the session zone never reaches the child');
});

// #612: GH_REPO names the repo gh acts on when no --repo flag names one, and GH_HOST
// names another host. The Approve check and the merge read the origin checkout, so the
// bot drops both: a stale session value must never merge another repo's pull request.
test('env: the bot drops GH_REPO and GH_HOST, so gh never acts on another repo (#612)', () => {
  const e = botEnv({ PATH: '/bin', GH_REPO: 'other/repo', GH_HOST: 'example.com' }, 'tok');
  assert.equal(e.GH_REPO, undefined);
  assert.equal(e.GH_HOST, undefined);
  assert.equal(e.GH_TOKEN, 'tok', 'the token still reaches gh');
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
