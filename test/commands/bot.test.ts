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
    // #422: a pull request gets the type label its title says.
    const added: Record<number, string[]> = { 1: ['--label', 'feat'], 3: ['--label', 'feat'], 7: ['--label', 'feat'], 8: ['--label', 'bug'] };
    assert.deepEqual(ran(), good.map((command, index) => ({ args: [...command.slice(1), ...(added[index] ?? [])], token: 'ghs_test' })));
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
    // #422: a new pull request also gets the type and tier labels; nothing else changes.
    const labelled = (args: string[]) => (args[1] === 'create' && !args.includes('-R') ? [...args, '--label', 'feat', '--label', 'tier A'] : args);
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
  const run = (command: string[], input = '') =>
    new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn('node', [CLI, 'bot', '--', ...command], { cwd: sandbox.repo, env: { ...sandbox.env, ...bot } });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => done({ status, stderr }));
      child.stdin.end(input);
    });
  // The branch can't be compared with origin here, so each body check ends with this note.
  const note = 'yokoten bot: note: git can\'t compare HEAD with origin/main, so the body was checked without the changed files; CI checks the rest\n';
  const body = (tier: string) => `tier: ${tier}\nCloses #1\n\n## Why\nx\n\n## What changed\nx\n\n## How tested\nx\n`;
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
      assert.deepEqual(read(log).at(-1), { args: [...command.slice(1), ...args], input }, command.join(' '));
    }
    assert.equal(read(lists).length, cases.length, 'one label list per run');
    assert.deepEqual(read(lists)[0], ['label', 'list', '--json', 'name', '--limit', '1000']);

    // (b) Correct labels already given: the command is sent unchanged, and no list is read.
    const before = read(lists).length;
    const given = ['gh', 'pr', 'create', '-t', 'fix: a', '--label', 'bug,tier B', '--body', body('B')];
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
    assert.deepEqual(read(log).at(-1)?.args.slice(-4), ['--label', 'enhancement', '--label', 'tier: A']);
    const absent = await run(['gh', 'pr', 'create', '-t', 'perf: a', '--body', body('B')]);
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stderr, /^yokoten bot: note: the repo has no label `perf`, so the pull request gets none; create it on GitHub, or pass another with --label\. `check --pr` asks for it\nyokoten bot: note: the repo has no label `tier B`, /m);
    assert.deepEqual(read(log).at(-1)?.args, ['pr', 'create', '-t', 'perf: a', '--body', body('B')], 'no label was created or added');

    // (e) Other gh commands are sent unchanged, with no label list.
    const lists0 = read(lists).length;
    const others: string[][] = [
      ['gh', 'issue', 'create', '-t', 'host: a', '--body', body('B')],
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
