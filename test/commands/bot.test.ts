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
      ['gh', 'pr', 'create', '-t', 'feat(host): check the title'],
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

// #406: the bot checks a pull request's body by the body rules of `check --pr`, against
// this branch's diff and the base branch's CODEOWNERS, before it sends anything.
test('bot: a pull request body CI would refuse is refused locally, with CI\'s message (#406)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host', 'kit'] }));
  sandbox.write('.github/CODEOWNERS', '/src/owned.ts @me\n');
  sandbox.write('src/owned.ts', 'export const a = 1;\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'base');
  sandbox.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('src/owned.ts', 'export const a = 2;\n');
  sandbox.write('kit/a.md', 'A kit file.\n');
  sandbox.write('changes/1-a.md', 'Added\n\nA kit file (#1).\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8') }) + '\\n');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') =>
    new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn('node', [CLI, 'bot', '--', ...command], { cwd: sandbox.repo, env: { ...sandbox.env, ...bot } });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => done({ status, stderr }));
      child.stdin.end(input);
    });
  // What `check --pr` says in CI about the same body on the same branch, under its first line.
  const ciSays = (body: string) => {
    const file = join(sandbox.home, 'event.json');
    const sha = (ref: string) => sandbox.git('rev-parse', ref).stdout.trim();
    const tier = /^tier: ([ABC])/.exec(body)?.[1] ?? 'A';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat(kit): a', body, labels: [{ name: 'feat' }, { name: `tier ${tier}` }], milestone: { title: 'M0' }, base: { sha: sha('origin/main') }, head: { sha: sha('HEAD') } } }));
    const r = sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
    return r.stderr.trim().split('\n').slice(1);
  };
  const good = 'tier: A\nCloses #1\n\n## Why\nx\n\n## What changed\nEvery project gets the new kit file on its next init.\n\n## How tested\nx\n';
  const refused = async (command: string[], body: string, id: RegExp, input?: string) => {
    const r = await run(command, input);
    assert.equal(r.status, 1, command.join(' '));
    const [head, ...lines] = r.stderr.trim().split('\n');
    assert.equal(head, 'yokoten bot: 1 problem(s) in the body; nothing was sent. Fix the body and run it again:');
    assert.match(lines[0], id);
    assert.deepEqual(lines, ciSays(body), 'the same message CI gives');
    assert.deepEqual(ran(), [], `gh did not run: ${command.join(' ')}`);
  };
  try {
    assert.deepEqual(ciSays(good), [], 'the good body passes in CI');
    assert.equal(sandbox.run(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: join(sandbox.home, 'event.json') } }).status, 0);
    // (a) tier B on a branch that changes a file CODEOWNERS owns.
    const tierB = good.replace('tier: A', 'tier: B');
    await refused(['gh', 'pr', 'create', '-t', 'feat(kit): a', '--body', tierB], tierB, /^- body: `tier: B`, and this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): src\/owned\.ts\./);
    // (b) a kit/ change whose body does not say every project gets it on the next init.
    const noKit = good.replace('Every project gets the new kit file on its next init.', 'A file.');
    writeFileSync(join(sandbox.home, 'body.md'), noKit);
    await refused(['gh', 'pr', 'create', '-t', 'feat(kit): a', '--body-file', join(sandbox.home, 'body.md')], noKit, /^- body: this changes `kit\/` and does not say so\./);
    await refused(['gh', 'pr', 'edit', '--body-file', '-'], noKit, /kit/, noKit);
    await refused(['gh', 'pr', 'edit', 'topic', `--body=${noKit}`], noKit, /kit/);
    // A pull request named by number: the body itself is still checked, without the diff.
    const bare = await run(['gh', 'pr', 'edit', '5', '--body', 'x']);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /^yokoten bot: 5 problem\(s\) in the body; nothing was sent\./);
    assert.deepEqual(ran(), []);

    // (c) A good body passes, and gh gets the command and the body unchanged.
    writeFileSync(join(sandbox.home, 'body.md'), good);
    const passes: [string[], string][] = [
      [['gh', 'pr', 'create', '-t', 'feat(kit): a', '--body-file', join(sandbox.home, 'body.md')], ''],
      [['gh', 'pr', 'create', '-t', 'feat(kit): a', '-F', '-'], good],
      // (d) No body: a label edit passes through unchanged.
      [['gh', 'pr', 'edit', '5', '--add-label', 'bug', '--remove-label', 'tier B'], ''],
      // Another repo has its own rules: not checked here.
      [['gh', 'pr', 'create', '-R', 'other/repo', '--body', 'x'], ''],
    ];
    for (const [command, input] of passes) {
      const r = await run(command, input);
      assert.equal(r.status, 0, `${command.join(' ')}: ${r.stderr}`);
      assert.equal(r.stderr, '', command.join(' '));
    }
    assert.deepEqual(ran(), passes.map(([command, input]) => ({ args: command.slice(1), input })));
    // By number, the owned-file rule can't be read locally: the body passes with a note, and CI checks the rest.
    const byNumber = await run(['gh', 'pr', 'edit', '5', '--body', tierB]);
    assert.equal(byNumber.status, 0, byNumber.stderr);
    assert.equal(byNumber.stderr, 'yokoten bot: note: `5` is not a local branch, so the body was checked without the changed files; CI checks the rest\n');
  } finally {
    server.close();
  }
});
