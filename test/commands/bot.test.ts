// Tests for src/commands/bot.ts.

import '../repo/home.ts';
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
import { invoke } from '../repo/invoke.ts';

// #117: the bot checks a title before it sends anything, by the rules CI uses. A fake gh
// and a local API server stand in for GitHub; the real ones are never reached.
test('bot: a bad title is refused before the token is asked for; a good one runs (#117)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host', 'check'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  // The fake gh lists no labels (#422: the bot then adds the best names), and logs the rest.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nif (process.argv[2] === 'label') process.exit(1);\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN }) + '\\n');\n`);
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
  // In this process (#475): the server answers while the command runs.
  const run = (command: string[], extra: Record<string, string> = bot, before: string[] = []) => sandbox.call(['bot', ...before, '--', ...command], { extra });
  // The entry, on a child (#475): exit code and output through the real binary. Not spawnSync:
  // the server must answer while the CLI runs.
  const viaChild = (command: string[], extra: Record<string, string> = bot, before: string[] = []) =>
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
      ['gh', 'issue', 'create', '--title', 'host: check the title', '--label', 'incident', '--body', '-t\n\nMade with worker (opus)\n'],
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
    // #422: a pull request gets the type label its title says.
    const added: Record<number, string[]> = { 1: ['--label', 'feat'], 3: ['--label', 'feat'], 7: ['--label', 'feat'], 8: ['--label', 'bug'] };
    assert.deepEqual(ran(), good.map((command, index) => ({ args: [...command.slice(1), ...(added[index] ?? [])], token: 'ghs_test' })));
    assert.equal(requests.length, good.length * 2, 'one installation lookup and one token per run');

    // bot has no options of its own (#203): one before `--` is refused, and nothing runs.
    const unknown = await viaChild(['echo'], bot, ['--x']);
    assert.deepEqual([unknown.status, unknown.stderr], [1, 'yokoten bot: unknown option --x. Run `yokoten bot --help`.\n']);
    assert.equal(ran().length, good.length, 'gh did not run');
    assert.equal(requests.length, good.length * 2, 'no token was asked for');
    // Everything after `--` is the command's, passed on unchanged.
    const passed = await viaChild(['gh', '--anything', 'issue', 'list']);
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

// #488: gh sends a Time-Zone header from TZ, and GitHub writes it into the commits it
// makes, such as a merge. The bot runs its command with TZ=UTC, whatever the session sets.
test('bot: the child runs with TZ=UTC, even from a session in another zone (#488)', async () => {
  const sandbox = makeSandbox();
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.env.TZ + '\\n');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const key = join(sandbox.home, 'bot.pem');
    writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const extra = { PATH: `${bin}:${process.env.PATH}`, TZ: 'Asia/Tokyo', YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    const r = await sandbox.call(['bot', '--', 'gh', 'issue', 'list'], { extra });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), 'UTC', 'the child saw the session zone');
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
  // origin is a bare repo on this machine, at a path the bot reads as github.com/me/repo,
  // so `git fetch origin` works and GitHub is never reached.
  const origin = join(sandbox.home, 'github.com', 'me', 'repo.git');
  mkdirSync(origin, { recursive: true });
  sandbox.git('init', '-q', '--bare', origin);
  sandbox.git('remote', 'add', 'origin', origin);
  sandbox.git('push', '-q', 'origin', 'main');
  sandbox.git('checkout', '-qb', 'topic');
  sandbox.write('src/owned.ts', 'export const a = 2;\n');
  sandbox.write('kit/a.md', 'A kit file.\n');
  sandbox.write('changes/1-a.md', 'Added\n\nA kit file (#1).\n');
  sandbox.git('add', '.');
  sandbox.git('commit', '-qm', 'head');
  sandbox.git('push', '-q', 'origin', 'topic');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  // The fake gh answers `pr view` for pull request 5 (branch topic) and 6 (a branch origin
  // does not have), and logs each view apart from the commands it sends.
  const views = join(sandbox.home, 'views.log');
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    'if (args[0] === "label") process.exit(1);',
    // #512: issue 1 has the milestone M0, which a new pull request takes.
    'if (args[0] === "issue" && args[1] === "view") { console.log(JSON.stringify({ milestone: { title: "M0" } })); process.exit(0); }',
    `if (args[0] === "pr" && args[1] === "view") { fs.appendFileSync(${JSON.stringify(views)}, JSON.stringify({ args, token: process.env.GH_TOKEN }) + "\\n"); const n = args[2].split("/").pop(); if (n === "5" || n === "6") { console.log(JSON.stringify({ headRefName: n === "5" ? "topic" : "gone", baseRefName: "main" })); process.exit(0); } process.exit(1); }`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, "utf8") }) + "\\n");`,
  ].join('\n'));
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
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  // What `check --pr` says in CI about the same body on the same branch, under its first line.
  const ciSays = async (body: string) => {
    const file = join(sandbox.home, 'event.json');
    const sha = (ref: string) => sandbox.git('rev-parse', ref).stdout.trim();
    const tier = /^tier: ([ABC])/.exec(body)?.[1] ?? 'A';
    writeFileSync(file, JSON.stringify({ pull_request: { title: 'feat(kit): a', body, labels: [{ name: 'feat' }, { name: `tier ${tier}` }], milestone: { title: 'M0' }, base: { sha: sha('origin/main') }, head: { sha: sha('HEAD') } } }));
    const r = await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: file } });
    return r.stderr.trim().split('\n').slice(1);
  };
  const good = 'tier: A\nCloses #1\n\n## Why\nx\n\n## What changed\nEvery project gets the new kit file on its next init.\n\n## How tested\nx\n\nMade with worker (opus)\n';
  const refused = async (command: string[], body: string, id: RegExp, input?: string) => {
    const r = await run(command, input);
    assert.equal(r.status, 1, command.join(' '));
    const [head, ...lines] = r.stderr.trim().split('\n');
    assert.equal(head, 'yokoten bot: 1 problem(s) in the body; nothing was sent. Fix the body and run it again:');
    assert.match(lines[0], id);
    assert.deepEqual(lines, await ciSays(body), 'the same message CI gives');
    assert.deepEqual(ran(), [], `gh did not run: ${command.join(' ')}`);
  };
  try {
    assert.deepEqual(await ciSays(good), [], 'the good body passes in CI');
    assert.equal((await sandbox.call(['check', '--pr'], { extra: { GITHUB_EVENT_PATH: join(sandbox.home, 'event.json') } })).status, 0);
    // (a) tier B on a branch that changes a file CODEOWNERS owns.
    const tierB = good.replace('tier: A', 'tier: B');
    await refused(['gh', 'pr', 'create', '-t', 'feat(kit): a', '--body', tierB], tierB, /^- body: `tier: B`, and this changes 1 file\(s\) that CODEOWNERS owns \(read from the base branch\): src\/owned\.ts\./);
    // (b) a kit/ change whose body does not say every project gets it on the next init.
    const noKit = good.replace('Every project gets the new kit file on its next init.', 'A file.');
    writeFileSync(join(sandbox.home, 'body.md'), noKit);
    await refused(['gh', 'pr', 'create', '-t', 'feat(kit): a', '--body-file', join(sandbox.home, 'body.md')], noKit, /^- body: this changes `kit\/` and does not say so\./);
    await refused(['gh', 'pr', 'edit', '--body-file', '-'], noKit, /kit/, noKit);
    await refused(['gh', 'pr', 'edit', 'topic', `--body=${noKit}`], noKit, /kit/);
    // (c) No `Made with` line: refused with what to add, like no `Closes #N` (#570).
    const noMade = good.replace('\n\nMade with worker (opus)\n', '\n');
    await refused(['gh', 'pr', 'create', '-t', 'feat(kit): a', '--body', noMade], noMade, /^- body: no `Made with` line at the end\. .+ End the body with `🤖 Made with <agent> \(<model>\)/);
    // A pull request named by number or URL: gh says its branches, with the bot's token, and
    // every body rule runs on origin/main...origin/topic. A branch not here yet is fetched.
    sandbox.git('update-ref', '-d', 'refs/remotes/origin/topic');
    await refused(['gh', 'pr', 'edit', '5', '--body', tierB], tierB, /CODEOWNERS owns/);
    assert.equal(sandbox.git('rev-parse', 'origin/topic').stdout.trim(), sandbox.git('rev-parse', 'HEAD').stdout.trim(), 'fetched');
    await refused(['gh', 'pr', 'edit', 'https://github.com/me/repo/pull/5', '--body-file', join(sandbox.home, 'body.md')], noKit, /kit/);
    const viewed = readFileSync(views, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(viewed, [5, 'https://github.com/me/repo/pull/5'].map((n) => ({ args: ['pr', 'view', String(n), '--json', 'headRefName,baseRefName'], token: 'ghs_test' })));

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
    // #422, #512: a new pull request also gets the type and tier labels and its issue's milestone; nothing else changes.
    const labelled = (args: string[]) => (args[1] === 'create' && !args.includes('-R') ? [...args, '--label', 'feat', '--label', 'tier A', '--milestone', 'M0'] : args);
    assert.deepEqual(ran(), passes.map(([command, input]) => ({ args: labelled(command.slice(1)), input })));
    // A branch git can't fetch, or a pull request gh can't look up: the body alone is checked, with a note.
    for (const [n, why] of [['6', "git can't compare origin/gone with origin/main"], ['7', 'gh could not say the branches of pull request `7`']]) {
      const r = await run(['gh', 'pr', 'edit', n, '--body', good]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, `yokoten bot: note: ${why}, so the body was checked without the changed files; CI checks the rest\n`);
    }
    assert.equal(ran().length, passes.length + 2, 'both edits were sent');
  } finally {
    server.close();
  }
});

// #422: `gh pr create` gets the type label its title says and the tier label its body
// says, by the names the repo has. A fake gh and a local API server stand in for GitHub.
test('bot: a new pull request gets its type and tier labels; a contradicting one is refused (#422)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  const lists = join(sandbox.home, 'lists.log');
  const repoLabels = join(sandbox.home, 'labels.json');
  mkdirSync(bin);
  // The fake gh answers `label list` from labels.json, and logs it apart from the commands it sends.
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    // #512: issue 1 has the milestone M0, which a new pull request takes.
    'if (args[0] === "issue" && args[1] === "view") { console.log(JSON.stringify({ milestone: { title: "M0" } })); process.exit(0); }',
    `if (args[0] === "label") { fs.appendFileSync(${JSON.stringify(lists)}, JSON.stringify(args) + "\\n"); process.stdout.write(fs.readFileSync(${JSON.stringify(repoLabels)}, "utf8")); process.exit(0); }`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, "utf8") }) + "\\n");`,
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const setLabels = (names: string[]) => writeFileSync(repoLabels, JSON.stringify(names.map((name) => ({ name }))));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  // The branch can't be compared with origin here, so each body check ends with this note.
  const note = 'yokoten bot: note: git can\'t compare HEAD with origin/main, so the body was checked without the changed files; CI checks the rest\n';
  const body = (tier: string) => `tier: ${tier}\nCloses #1\n\n## Why\nx\n\n## What changed\nx\n\n## How tested\nx\n\nMade with worker (opus)\n`;
  const bodyFile = join(sandbox.home, 'body.md');
  writeFileSync(bodyFile, body('C'));
  try {
    setLabels(['bug', 'feat', 'docs', 'tier A', 'tier B', 'tier C']);
    // (a) Missing labels are added, from --body, --body-file and standard input.
    const cases: [command: string[], input: string, args: string[]][] = [
      [['gh', 'pr', 'create', '-t', 'fix(host): a', '--body', body('B')], '', ['--label', 'bug', '--label', 'tier B']],
      [['gh', 'pr', 'create', '-t', 'docs: a', '--body-file', bodyFile], '', ['--label', 'docs', '--label', 'tier C']],
      [['gh', 'pr', 'new', '--title=feat: a', '-F', '-'], body('A'), ['--label', 'feat', '--label', 'tier A']],
      // Only the missing one: a type label the caller gave stays, and is not added twice.
      [['gh', 'pr', 'create', '-t', 'feat: a', '-l', 'feat', '--body', body('B')], '', ['--label', 'tier B']],
      [['gh', 'pr', 'create', '-t', 'fix: a', '--label=tier: B', '--body', body('B')], '', ['--label', 'bug']],
    ];
    for (const [command, input, args] of cases) {
      const r = await run(command, input);
      assert.deepEqual([r.status, r.stderr], [0, note], command.join(' '));
      assert.deepEqual(read(log).at(-1), { args: [...command.slice(1), ...args, '--milestone', 'M0'], input }, command.join(' '));
    }
    assert.equal(read(lists).length, cases.length, 'one label list per run');
    assert.deepEqual(read(lists)[0], ['label', 'list', '--json', 'name', '--limit', '1000']);

    // (b) Correct labels and a milestone already given: the command is sent unchanged, and no list is read.
    const before = read(lists).length;
    const given = ['gh', 'pr', 'create', '-t', 'fix: a', '--label', 'bug,tier B', '-m', 'M1', '--body', body('B')];
    const unchanged = await run(given);
    assert.deepEqual([unchanged.status, unchanged.stderr], [0, note]);
    assert.deepEqual(read(log).at(-1), { args: given.slice(1), input: '' });
    assert.equal(read(lists).length, before, 'no label list');

    // (c) A tier label the body contradicts is refused with the message of `check --pr`,
    // before the token is asked for, and nothing is sent.
    const sent = read(log).length;
    const asked = requests.length;
    for (const [labels, what] of [[['--label', 'tier A'], /^- labels: `tier A` does not match the body's `tier: B`\. .+ Change the label to `tier B`, or the first line of the body to `tier: A`\.$/m], [['-l', 'tier A', '-l', 'tier: C'], /^- labels: 2 tier labels\. .+ Keep one tier label: `tier B`\.$/m]] as const) {
      const command = ['gh', 'pr', 'create', '-t', 'feat: a', ...labels, '--body', body('B')];
      const r = await run(command);
      assert.equal(r.status, 1, command.join(' '));
      assert.match(r.stderr, /^yokoten bot: note: .+\nyokoten bot: 1 problem\(s\) in the labels; nothing was sent\. Fix the labels and run it again:\n/);
      assert.match(r.stderr, what);
    }
    assert.equal(requests.length, asked, 'no token was asked for');
    assert.equal(read(log).length, sent, 'gh did not run');

    // (d) A label the repo does not have is said plainly and left out; one it has by another name is used.
    setLabels(['bug', 'enhancement', 'tier: A']);
    const other = await run(['gh', 'pr', 'create', '-t', 'feat: a', '--body', body('A')]);
    assert.deepEqual([other.status, other.stderr], [0, note]);
    assert.deepEqual(read(log).at(-1)?.args.slice(-6, -2), ['--label', 'enhancement', '--label', 'tier: A']);
    const absent = await run(['gh', 'pr', 'create', '-t', 'perf: a', '--body', body('B')]);
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stderr, /^yokoten bot: note: the repo has no label `perf`, so the pull request gets none; create it on GitHub, or pass another with --label\. `check --pr` asks for it\nyokoten bot: note: the repo has no label `tier B`, /m);
    assert.deepEqual(read(log).at(-1)?.args, ['pr', 'create', '-t', 'perf: a', '--body', body('B'), '--milestone', 'M0'], 'no label was created or added');

    // (e) Other gh commands are sent unchanged, with no label list. `gh issue create`
    // is not among them: it gets its own label check (#544).
    const lists0 = read(lists).length;
    const others: string[][] = [
      ['gh', 'pr', 'list'],
      ['gh', 'pr', 'edit', '5', '-t', 'feat: a'],
      ['gh', 'pr', 'create', '-R', 'other/repo', '-t', 'feat: a', '--body', body('B')],
      ['gh', 'pr', 'create', '--fill'],
    ];
    for (const command of others) {
      const r = await run(command);
      assert.deepEqual([r.status, r.stderr], [0, ''], command.join(' '));
      assert.deepEqual(read(log).at(-1)?.args, command.slice(1), command.join(' '));
    }
    assert.equal(read(lists).length, lists0, 'no label list');
  } finally {
    server.close();
  }
});

// #544: `gh issue create` gets its type and tier labels checked, by the names the repo
// has. A bad issue is refused before it is sent, and nothing is added: no line of the
// command names the type. A fake gh and a local API server stand in for GitHub.
test('bot: a new issue needs the type and tier labels its repo has; a bad one is refused (#544)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  const lists = join(sandbox.home, 'lists.log');
  const repoLabels = join(sandbox.home, 'labels.json');
  mkdirSync(bin);
  // The fake gh answers `label list` from labels.json, and logs the commands it sends.
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    `if (args[0] === "label") { fs.appendFileSync(${JSON.stringify(lists)}, JSON.stringify(args) + "\\n"); process.stdout.write(fs.readFileSync(${JSON.stringify(repoLabels)}, "utf8")); process.exit(0); }`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, "utf8") }) + "\\n");`,
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const setLabels = (names: string[]) => writeFileSync(repoLabels, JSON.stringify(names.map((name) => ({ name }))));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  try {
    setLabels(['bug', 'feat', 'docs', 'tier A', 'tier B', 'tier C']);
    // (a) A missing label is refused with the message of `check --issue`, and nothing is sent.
    const refused: [string[], number, RegExp][] = [
      [['gh', 'issue', 'create', '-t', 'host: a', '--body', 'An issue.\n\nMade with worker (opus)\n'], 2, /no type label[\s\S]*no tier label/],
      [['gh', 'issue', 'create', '-t', 'host: a', '-l', 'bug', '--body', 'An issue.\n\nMade with worker (opus)\n'], 1, /no tier label/],
      [['gh', 'issue', 'new', '--title=host: a', '--label', 'tier A', '--body', 'An issue.\n\nMade with worker (opus)\n'], 1, /no type label/],
    ];
    for (const [command, count, missing] of refused) {
      const r = await run(command);
      assert.equal(r.status, 1, command.join(' '));
      assert.match(r.stderr, new RegExp(`^yokoten bot: ${count} problem\\(s\\) in the labels; nothing was sent\\. Fix the labels and run it again:`), command.join(' '));
      assert.match(r.stderr, missing, command.join(' '));
    }
    assert.deepEqual(read(log), [], 'gh did not run the create');
    // (b) Both labels: sent unchanged, with no added label.
    const good = ['gh', 'issue', 'create', '-t', 'host: a', '-l', 'bug,tier B', '--body', 'An issue.\n\nMade with worker (opus)\n'];
    const sent = await run(good);
    assert.deepEqual([sent.status, sent.stderr], [0, ''], good.join(' '));
    assert.deepEqual(read(log).at(-1), { args: good.slice(1), input: '' });
    // (c) A repo without tier labels: no line for the tier.
    setLabels(['bug', 'feat']);
    const noTier = await run(['gh', 'issue', 'create', '-t', 'host: a', '--label', 'bug', '--body', 'An issue.\n\nMade with worker (opus)\n']);
    assert.deepEqual([noTier.status, noTier.stderr], [0, ''], 'the repo has no tier labels');
    // (d) An edit and another repo: sent unchanged, with no label list.
    const lists0 = read(lists).length;
    const others: string[][] = [
      ['gh', 'issue', 'edit', '5', '-t', 'host: a'],
      ['gh', 'issue', 'create', '-R', 'other/repo', '-t', 'host: a', '--body', 'x'],
    ];
    for (const command of others) {
      const r = await run(command);
      assert.deepEqual([r.status, r.stderr], [0, ''], command.join(' '));
      assert.deepEqual(read(log).at(-1)?.args, command.slice(1), command.join(' '));
    }
    assert.equal(read(lists).length, lists0, 'no label list');
  } finally {
    server.close();
  }
});

// #475: in this process, `--body-file -` reads the body from the invocation's stdin, and
// gh's own output lands on the invocation's streams, not the test runner's.
test('bot --body-file -: in-process, the body comes from the given stdin and gh writes to the given streams (#475)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    'if (args[0] === "label") { process.stdout.write(JSON.stringify([{ name: "docs" }, { name: "tier C" }])); process.exit(0); }',
    'if (args[0] === "issue" && args[1] === "view") { console.log(JSON.stringify({ milestone: { title: "M0" } })); process.exit(0); }',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, "utf8") }) + "\\n");`,
    'process.stdout.write("created\\n"); process.stderr.write("a gh note\\n");',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const env = { ...sandbox.env, PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const body = 'tier: C\nCloses #1\n\n## Why\nx\n\n## What changed\nx\n\n## How tested\nx\n\nMade with worker (opus)\n';
  const command = ['bot', '--', 'gh', 'pr', 'create', '-t', 'docs: a', '--body-file', '-'];
  try {
    // A body CI would refuse, given on stdin: refused before anything is sent.
    const refused = await invoke(command, { env, cwd: sandbox.repo, stdin: body.replace('## How tested\nx\n', '') });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^yokoten bot: 1 problem\(s\) in the body; nothing was sent/);
    assert.equal(existsSync(log), false, 'gh did not run');
    // A good one: gh gets it the same way, and what gh prints is the command's output.
    const sent = await invoke(command, { env, cwd: sandbox.repo, stdin: body });
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(sent.stdout, 'created\n');
    assert.match(sent.stderr, /a gh note\n$/);
    const [ran] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(ran, { args: ['pr', 'create', '-t', 'docs: a', '--body-file', '-', '--label', 'docs', '--label', 'tier C', '--milestone', 'M0'], input: body });
  } finally {
    server.close();
  }
});

// #512: `gh pr create` with no milestone takes its linked issue's, from one `gh issue view`.
// A fake gh and a local API server stand in for GitHub.
test('bot: a new pull request takes its issue\'s milestone; none anywhere is refused (#512)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  const views = join(sandbox.home, 'views.log');
  mkdirSync(bin);
  // Issue 1 has the milestone M1, issue 2 has none, and gh can't read issue 3.
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    'if (args[0] === "label") { process.stdout.write(JSON.stringify([{ name: "feat" }, { name: "tier B" }])); process.exit(0); }',
    `if (args[0] === "issue" && args[1] === "view") { fs.appendFileSync(${JSON.stringify(views)}, JSON.stringify(args) + "\\n"); if (args[2] === "3") process.exit(1); console.log(JSON.stringify({ milestone: args[2] === "1" ? { number: 1, title: "M1" } : null })); process.exit(0); }`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[]) => sandbox.call(['bot', '--', ...command], { extra: bot });
  const note = 'yokoten bot: note: git can\'t compare HEAD with origin/main, so the body was checked without the changed files; CI checks the rest\n';
  const body = (links: string) => `tier: B\n${links}\n\n## Why\nx\n\n## What changed\nx\n\n## How tested\nx\n\nMade with worker (opus)\n`;
  const labels = ['--label', 'feat', '--label', 'tier B'];
  try {
    // (1) The milestone is copied from the linked issue, by --body and --body-file.
    const closes = await run(['gh', 'pr', 'create', '-t', 'feat: a', '--body', body('Closes #1')]);
    assert.deepEqual([closes.status, closes.stderr], [0, note]);
    assert.deepEqual(read(log).at(-1), ['pr', 'create', '-t', 'feat: a', '--body', body('Closes #1'), ...labels, '--milestone', 'M1']);
    assert.deepEqual(read(views), [['issue', 'view', '1', '--json', 'milestone']], 'one gh issue view');
    const bodyFile = join(sandbox.home, 'body.md');
    writeFileSync(bodyFile, body('Part of #2\nCloses #1'));
    const first = await run(['gh', 'pr', 'create', '-t', 'feat: a', '--body-file', bodyFile, '--', 'extra']);
    assert.deepEqual([first.status, first.stderr], [0, note]);
    assert.deepEqual(read(log).at(-1), ['pr', 'create', '-t', 'feat: a', '--body-file', bodyFile, ...labels, '--milestone', 'M1', '--', 'extra'], 'the first linked issue that has one, before any --');
    assert.equal(readFileSync(bodyFile, 'utf8'), body('Part of #2\nCloses #1'), 'the body file is not changed');

    // (2) No linked issue has a milestone: nothing is sent, and the message names --milestone.
    const sent = read(log).length;
    const none = await run(['gh', 'pr', 'create', '-t', 'feat: a', '--body', body('Part of #2')]);
    assert.equal(none.status, 1);
    assert.equal(none.stderr, `${note}yokoten bot: 1 problem(s) in the milestone; nothing was sent. Fix the command and run it again:\n- milestone: none given, and the linked issue #2 has none. The board and the roadmap show work by milestone. Add \`--milestone <name>\`, or set a milestone on the issue.\n  docs: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md#the-core-rules\n`);
    assert.equal(read(log).length, sent, 'gh pr create did not run');

    // (3) An explicit milestone is kept, with no gh issue view.
    const viewed = read(views).length;
    for (const given of [['--milestone', 'M9'], ['-m', 'M9'], ['--milestone=M9']]) {
      const command = ['gh', 'pr', 'create', '-t', 'feat: a', ...given, '--body', body('Part of #2')];
      const r = await run(command);
      assert.deepEqual([r.status, r.stderr], [0, note], command.join(' '));
      assert.deepEqual(read(log).at(-1), [...command.slice(1), ...labels], command.join(' '));
    }
    assert.equal(read(views).length, viewed, 'no gh issue view');

    // (4) gh can't read the issue: the pull request is sent without a milestone, with a note.
    const unread = await run(['gh', 'pr', 'create', '-t', 'feat: a', '--body', body('Closes #3')]);
    assert.deepEqual([unread.status, unread.stderr], [0, `${note}yokoten bot: note: gh could not read the milestone of issue #3, so the pull request gets none; pass --milestone. \`check --pr\` asks for it\n`]);
    assert.deepEqual(read(log).at(-1), ['pr', 'create', '-t', 'feat: a', '--body', body('Closes #3'), ...labels]);
  } finally {
    server.close();
  }
});

// #609: `gh pr comment` carries the `Made with` line, so a reader can tell which AI
// wrote the comment. A body without it is refused before anything is sent, with the same
// message as a pull request body; one with it is sent unchanged.
test('bot: a pull request comment needs the Made with line; one with it is sent (#609)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8') }) + '\\n');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  try {
    const refused = await run(['gh', 'pr', 'comment', '5', '--body', 'A note.\n']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /^yokoten bot: 1 problem\(s\) in the body; nothing was sent\. Fix the body and run it again:\n- body: no `Made with` line at the end\. .+ End the body with `🤖 Made with <agent> \(<model>\)/);
    assert.deepEqual(ran(), [], 'gh did not run');
    const sent = await run(['gh', 'pr', 'comment', '5', '--body', 'A note.\n\nMade with worker (opus)\n']);
    assert.deepEqual([sent.status, sent.stderr], [0, ''], sent.stderr);
    assert.deepEqual(ran(), [{ args: ['pr', 'comment', '5', '--body', 'A note.\n\nMade with worker (opus)\n'], input: '' }]);
  } finally {
    server.close();
  }
});

// #609: `gh issue comment` carries the `Made with` line too. A body read from standard
// input is checked the same way, and gh gets it the same way when it passes.
test('bot: an issue comment needs the Made with line, from --body or stdin (#609)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8') }) + '\\n');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  try {
    const refused = await run(['gh', 'issue', 'comment', '5', '--body', 'A note.\n']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /^yokoten bot: 1 problem\(s\) in the body; nothing was sent\. Fix the body and run it again:\n- body: no `Made with` line at the end\. .+ End the body with `🤖 Made with <agent> \(<model>\)/);
    assert.deepEqual(ran(), [], 'gh did not run');
    const good = 'A note.\n\nMade with worker (opus)\n';
    const sent = await run(['gh', 'issue', 'comment', '5', '--body-file', '-'], good);
    assert.deepEqual([sent.status, sent.stderr], [0, ''], sent.stderr);
    assert.deepEqual(ran(), [{ args: ['issue', 'comment', '5', '--body-file', '-'], input: good }], 'gh gets the stdin body unchanged');
  } finally {
    server.close();
  }
});

// #609: `gh pr review` with a body carries the `Made with` line; a review with no body
// (a plain approve) passes through unchanged.
test('bot: a pull request review with a body needs the Made with line (#609)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input: require('node:fs').readFileSync(0, 'utf8') }) + '\\n');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  try {
    const refused = await run(['gh', 'pr', 'review', '5', '--comment', '-b', 'A review.\n']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /^yokoten bot: 1 problem\(s\) in the body; nothing was sent\. Fix the body and run it again:\n- body: no `Made with` line at the end\. .+ End the body with `🤖 Made with <agent> \(<model>\)/);
    assert.deepEqual(ran(), [], 'gh did not run');
    const sent = await run(['gh', 'pr', 'review', '5', '--comment', '--body', 'A review.\n\nMade with worker (opus)\n']);
    assert.deepEqual([sent.status, sent.stderr], [0, ''], sent.stderr);
    assert.deepEqual(ran().at(-1), { args: ['pr', 'review', '5', '--comment', '--body', 'A review.\n\nMade with worker (opus)\n'], input: '' });
    const plain = await run(['gh', 'pr', 'review', '5', '--approve']);
    assert.deepEqual([plain.status, plain.stderr], [0, ''], plain.stderr);
    assert.deepEqual(ran().at(-1), { args: ['pr', 'review', '5', '--approve'], input: '' }, 'a review with no body passes through');
  } finally {
    server.close();
  }
});

// #609: `gh issue create` carries the `Made with` line too. Its labels are still checked
// (#544); the body check runs first, before anything is sent.
test('bot: a new issue needs the Made with line; its labels are still checked (#609)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  const labels = join(sandbox.home, 'labels.json');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    `if (args[0] === "label") { process.stdout.write(fs.readFileSync(${JSON.stringify(labels)}, "utf8")); process.exit(0); }`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, "utf8") }) + "\\n");`,
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(labels, JSON.stringify([{ name: 'bug' }, { name: 'feat' }, { name: 'tier A' }, { name: 'tier B' }]));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  try {
    const refused = await run(['gh', 'issue', 'create', '-t', 'host: a', '--body', 'An issue.\n']);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /^yokoten bot: 1 problem\(s\) in the body; nothing was sent\. Fix the body and run it again:\n- body: no `Made with` line at the end\. .+ End the body with `🤖 Made with <agent> \(<model>\)/);
    assert.deepEqual(ran(), [], 'gh did not run');
    const sent = await run(['gh', 'issue', 'create', '-t', 'host: a', '-l', 'bug,tier B', '--body', 'An issue.\n\nMade with worker (opus)\n']);
    assert.deepEqual([sent.status, sent.stderr], [0, ''], sent.stderr);
    assert.deepEqual(ran(), [{ args: ['issue', 'create', '-t', 'host: a', '-l', 'bug,tier B', '--body', 'An issue.\n\nMade with worker (opus)\n'], input: '' }]);
  } finally {
    server.close();
  }
});

// #609: the note parser reads flags the way gh does. A value flag never swallows a
// following flag word (`-t --body TEXT` leaves `--body TEXT` for the body), and a
// run-together word expands letter by letter (`-wb` is `-w -b`, `-a` is a boolean on
// `pr review`). Otherwise gh posts a body the bot never checked.
test('bot: a note body gh posts is always checked, whatever the spelling (#609)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  const labels = join(sandbox.home, 'labels.json');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    `if (args[0] === "label") { process.stdout.write(fs.readFileSync(${JSON.stringify(labels)}, "utf8")); process.exit(0); }`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, "utf8") }) + "\\n");`,
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(labels, JSON.stringify([{ name: 'bug' }, { name: 'tier B' }]));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const refused = async (command: string[]) => {
    const r = await run(command);
    assert.equal(r.status, 1, command.join(' '));
    assert.match(r.stderr, /^yokoten bot: 1 problem\(s\) in the body; nothing was sent\. Fix the body and run it again:\n- body: no `Made with` line at the end\. .+ End the body with `🤖 Made with <agent> \(<model>\)/);
    assert.deepEqual(ran(), [], `gh did not run: ${command.join(' ')}`);
  };
  try {
    // A value flag swallowing the body flag: gh still posts the body.
    await refused(['gh', 'pr', 'comment', '5', '-t', '--body', 'A note.\n']);
    await refused(['gh', 'pr', 'comment', '5', '--title', '--body', 'A note.\n']);
    await refused(['gh', 'issue', 'create', '-t', 'host: a', '-l', 'bug,tier B', '-r', '--body', 'An issue.\n']);
    await refused(['gh', 'issue', 'create', '-t', 'host: a', '-l', 'bug,tier B', '--assignee', '--body', 'An issue.\n']);
    // A run-together word starting with a boolean letter: gh expands it.
    await refused(['gh', 'issue', 'create', '-t', 'host: a', '-l', 'bug,tier B', '-wb', 'An issue.\n']);
    await refused(['gh', 'pr', 'comment', '5', '-wb', 'A note.\n']);
    // On `pr review`, `-a` and `-r` are booleans, not values.
    await refused(['gh', 'pr', 'review', '5', '--comment', '-a', '-b', 'A review.\n']);
    await refused(['gh', 'pr', 'review', '5', '--comment', '-rb', 'A review.\n']);
  } finally {
    server.close();
  }
});

// #609: `--attach` uploads land after the body (gh appends every file the body does
// not reference at the very end), past the `Made with` line — on `issue create` and
// both comments (`pr review` takes no `--attach`). A note with `--attach` is refused
// before anything is sent, with or without a body.
test('bot: a note with --attach is refused, since the upload lands past the Made with line (#609)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('yokoten.json', JSON.stringify({ areas: ['host'] }));
  sandbox.git('remote', 'add', 'origin', 'https://github.com/me/repo.git');
  const bin = join(sandbox.home, 'bin');
  const log = join(sandbox.home, 'gh.log');
  const labels = join(sandbox.home, 'labels.json');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs"); const args = process.argv.slice(2);',
    `if (args[0] === "label") { process.stdout.write(fs.readFileSync(${JSON.stringify(labels)}, "utf8")); process.exit(0); }`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input: fs.readFileSync(0, "utf8") }) + "\\n");`,
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(labels, JSON.stringify([{ name: 'bug' }, { name: 'tier B' }]));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 77 } : { token: 'ghs_test' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const key = join(sandbox.home, 'bot.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const bot = { PATH: `${bin}:${process.env.PATH}`, YOKOTEN_BOT_APP_ID: '1', YOKOTEN_BOT_KEY: key, YOKOTEN_GITHUB_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  const run = (command: string[], input = '') => sandbox.call(['bot', '--', ...command], { input, extra: bot });
  const ran = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const refused = async (command: string[], input = '') => {
    const r = await run(command, input);
    assert.equal(r.status, 1, command.join(' '));
    assert.match(r.stderr, /^yokoten bot: 1 problem\(s\) in the body; nothing was sent\. Fix the body and run it again:\n- body: `--attach` appends the upload after the `Made with` line\. .+ Drop `--attach`, or link an uploaded file in the body instead\./);
    assert.deepEqual(ran(), [], `gh did not run: ${command.join(' ')}`);
  };
  try {
    const good = 'An issue.\n\nMade with worker (opus)\n';
    await refused(['gh', 'issue', 'create', '-t', 'host: a', '-l', 'bug,tier B', '--body', good, '--attach', './shot.png']);
    await refused(['gh', 'pr', 'comment', '5', '--body', 'A note.\n\nMade with worker (opus)\n', '--attach', './shot.png']);
    const bodyFile = join(sandbox.home, 'body.md');
    writeFileSync(bodyFile, 'A note.\n\nMade with worker (opus)\n');
    await refused(['gh', 'issue', 'comment', '5', '--body-file', bodyFile, '--attach', './shot.png']);
    // No body at all: gh would post the upload alone, with no `Made with` line.
    await refused(['gh', 'pr', 'comment', '5', '--attach', './shot.png']);
  } finally {
    server.close();
  }
});
