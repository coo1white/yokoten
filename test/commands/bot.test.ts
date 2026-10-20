// Tests for src/commands/bot.ts.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  CLI,
  makeSandbox,
} from '../repo/helpers.ts';

// #117: the bot checks a title before it sends anything, by the rules CI uses. A fake gh
// and a local API server stand in for GitHub; the real ones are never reached.
test('bot: a bad title is refused before the token is asked for; a good one runs (#117)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host', 'check'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN }) + '\\n');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  copyFileSync(join(bin, 'gh'), join(bin, 'gh.exe'));
  const ran =() => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  // A throwaway key, made for this test run only.
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const path = { PATH: `${bin}:${process.env.PATH}` };
  const bot = { ...path, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  // Not spawnSync: the server must answer while the CLI runs.
  const run = (command: string[], extra: Record<string, string> = bot, before: string[] = []) =>
    new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn('node', [CLI, 'bot', ...before, '--', ...command], { cwd: sandbox.repo, env: { ...sandbox.env, ...extra } });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => done({ status, stderr }));
    });
  const refused = async (command: string[], pattern: RegExp, extra?: Record<string, string>) => {
    const r = await run(command, extra);
    assert.equal(r.status, 1, command.join(' '));
    assert.match(r.stderr, /^yokoten bot: 1 problem\(s\) in the title; nothing was sent\. Fix the title and run it again:\n- title: /, command.join(' '));
    assert.match(r.stderr, pattern, command.join(' '));
    assert.doesNotMatch(r.stderr, /YOKOTEN_BOT|bot\.pem|GitHub said/, 'the title is the reason, not the bot setup');
    assert.deepEqual(requests, [], `no token was asked for: ${command.join(' ')}`);
    assert.deepEqual(ran(), [], `gh did not run: ${command.join(' ')}`);
  };
  try {
    // Positive controls: each bad title is refused with what, why and the fix.
    await refused(['gh', 'issue', 'create', '--title', `host: ${'a'.repeat(60)}`, '--body', 'x'], /title: 66 characters, over 60\. .+\. Shorten it/);
    await refused(['gh', 'issue', 'create', '-t', 'guard: add a step', '-l', 'feat'], /not in yokoten\.json "areas"\. .+\. Use one of: host, check\.$/m);
    await refused(['gh', 'issue', 'edit', '5', '--title=host: add a step.'], /title: a full stop at the end\. A title is a name/);
    await refused(['gh', 'pr', 'create', `--title=feat(host): ${'a'.repeat(62)}`, '--body', 'x'], /title: 74 characters, over 72\. .+\. Shorten it/);
    await refused(['gh', 'pr', 'edit', '5', '-t', 'feat(host): add a step.'], /title: a full stop at the end\. A commit title has no full stop\. Remove the full stop\./);
    await refused(['gh', 'pr', 'create', '-t', 'feat(guard): add a step'], /the area `guard` is not in yokoten\.json "areas"/);
    // Every spelling gh takes (#279): `new` for `create`, and an option before the noun or the verb.
    for (const command of [['gh', 'issue', 'new', '--title', 'host: add a step.'], ['gh', 'issue', '-R', 'o/r', 'create', '--title', 'host: add a step.'], ['gh', '--repo', 'o/r', 'issue', 'edit', '5', '-t', 'host: add a step.']]) {
      await refused(command, /title: a full stop at the end\. A title is a name/);
    }
    for (const command of [['gh', 'pr', 'new', '--title', 'feat(host): add a step.'], ['gh', 'pr', '-R', 'o/r', 'edit', '5', '--title', 'feat(host): add a step.'], ['gh', '--repo=o/r', 'pr', 'create', '-t', 'feat(host): add a step.']]) {
      await refused(command, /title: a full stop at the end\. A commit title has no full stop/);
    }
    // Short flags run together (#290): read as gh reads them, and refused when a letter is unknown.
    await refused(['gh', 'pr', 'create', '-dt', 'feat(host): add a step.'], /title: a full stop at the end\. A commit title has no full stop/);
    await refused(['gh', 'issue', 'create', '-wthost: add a step.'], /title: a full stop at the end\. A title is a name/);
    await refused(['gh', 'pr', 'create', '-dzt', 'feat(host): add a step'], /title: can't read the title: a run-together short option hides it\. .+\. Write --title on its own\.$/m);
    // gh api on an issue or pull request path (#295): its title= field is checked too.
    await refused(['gh', 'api', 'repos/o/r/issues', '-f', 'title=Broken'], /title: /);
    await refused(['gh', 'api', '-X', 'PATCH', '/repos/o/r/pulls/5', '--field=title=feat(host): add a step.'], /title: a full stop at the end\. A commit title has no full stop/);
    // gh by another name runs, so its title is checked (#295).
    await refused(['gh.exe', 'issue', 'create', '-t', 'Broken'], /title: /);
    await refused([join(bin, 'gh'), 'issue', 'create', '-t', 'Broken'], /title: /);
    // The bot runs gh and git only (#295): a wrapper would hide the title, so it is refused
    // before the token is asked for, and nothing runs.
    for (const command of [['env', 'gh', 'issue', 'create', '-t', 'Broken'], ['/usr/bin/env', 'gh', 'issue', 'create', '-t', 'Broken'], ['sh', '-c', 'gh issue create -t Broken'], ['node', 'x']]) {
      const r = await run(command);
      assert.deepEqual([r.status, r.stderr], [1, `yokoten bot: runs gh and git only; run \`${command[0]}\` without the bot\n`], command.join(' '));
      assert.deepEqual(requests, [], `no token was asked for: ${command.join(' ')}`);
      assert.deepEqual(ran(), [], `nothing ran: ${command.join(' ')}`);
    }
    // With no bot set up at all, the title is still the reason given.
    await refused(['gh', 'pr', 'create', '--title', 'feat(host): add a step.'], /full stop/, path);
    const missing = await run(['gh', 'pr', 'create', '--title', 'feat(host): add a step'], path);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^yokoten bot: YOKOTEN_BOT_APP_ID is not set/, 'a good title goes on to the bot setup');

    // A good title, and commands with no title, take the normal bot path.
    const good: string[][] = [
      ['gh', 'issue', 'create', '--title', 'host: check the title', '--label', 'incident', '--body', '-t'],
      ['gh', 'pr', 'create', '-t', 'feat(host): check the title', '--body', 'x'],
      ['gh', 'issue', '-R', 'me/repo', 'new', '--title', 'host: check the title'],
      ['gh', 'pr', 'new', '-t', 'feat(host): check the title'],
      ['gh', 'pr', 'create', '--fill'],
      ['gh', 'issue', 'list'],
      // #295: gh by another name, -t=X as gh reads it, gh api with a good title, and other gh api calls unchecked.
      ['gh.exe', 'issue', 'create', '-t', 'host: check the title'],
      [join(bin, 'gh'), 'pr', 'create', '-t', 'feat(host): check the title'],
      ['gh', 'pr', 'create', '-t=fix: good title'],
      ['gh', 'api', 'repos/o/r/issues', '-f', 'title=host: check the title'],
      ['gh', 'api', 'graphql', '-f', 'query=x', '-f', 'title=Broken'],
    ];
    for (const command of good) {
      const r = await run(command);
      assert.equal(r.status, 0, `${command.join(' ')}: ${r.stderr}`);
    }
    assert.deepEqual(ran(), good.map((command) => ({ args: command.slice(1), token: 'ghs_test' })));
    assert.equal(requests.length, good.length * 2, 'one installation lookup and one token per run');

    // bot has no options of its own (#203): one before `--` is refused, and nothing runs.
    const unknown = await run(['echo'], bot, ['--x']);
    assert.deepEqual([unknown.status, unknown.stderr], [1, 'yokoten bot: unknown option --x. Run `yokoten bot --help`.\n']);
    assert.equal(ran().length, good.length, 'gh did not run');
    assert.equal(requests.length, good.length * 2, 'no token was asked for');
    // Everything after `--` is the command's, passed on unchanged.
    const passed = await run(['gh', '--anything', 'issue', 'list']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(ran().at(-1), { args: ['--anything', 'issue', 'list'], token: 'ghs_test' });
    // --help after `--` is the command's own (#207): gh runs, and yokoten prints no help.
    const helped = await run(['gh', '--help']);
    assert.equal(helped.status, 0, helped.stderr);
    assert.deepEqual(ran().at(-1), { args: ['--help'], token: 'ghs_test' });
    // Before `--`, it is bot's help: no bot setup needed, no token, nothing runs.
    const own = await run(['gh', 'issue', 'list'], path, ['--help']);
    assert.equal(own.status, 0, own.stderr);
    assert.equal(ran().length, good.length + 2, 'gh did not run for bot --help');
    // A command that is not there, or that a signal ends, is named with the reason (#282).
    // The bot runs gh and git only (#295), so both are a gh: one at no path, one a script.
    const noGh = join(bin, 'none', 'gh');
    const absent = await run([noGh, 'arg']);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /^yokoten bot: could not run \S*\/none\/gh: ENOENT\n$/);
    const killedGh = join(bin, 'killed', 'gh');
    mkdirSync(dirname(killedGh));
    writeFileSync(killedGh, '#!/bin/sh\nkill -TERM $$\n');
    chmodSync(killedGh, 0o755);
    const killed = await run([killedGh]);
    assert.equal(killed.status, 1);
    assert.match(killed.stderr, /^yokoten bot: \S*\/killed\/gh was ended by SIGTERM\n$/);
    for (const said of [absent.stderr, killed.stderr]) assert.doesNotMatch(said, /ghs_test|bot\.pem|GH_TOKEN/, 'no token or env');
  } finally {
    server.close();
  }
});
