// Tests for src/agents/desk/start.ts, and the desk contract on this system (#637).
//
// The contract test starts a real desk with the backend this system has (bwrap on Linux
// and WSL2, sandbox-exec on macOS), runs a probe inside as the "agent", and checks each
// rule of the contract by what the probe could and could not do. It never names a
// backend's own words, so the same test holds every backend. It is skipped, with the
// reason, where the backend can't run.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { planDesk } from '../../../src/agents/desk/desk.ts';
import { chooseBackend, startDesk } from '../../../src/agents/desk/start.ts';
import { CLI, makeTempDir } from '../../repo/helpers.ts';

test('chooseBackend: native Windows is sent to WSL2, an unknown system is named', () => {
  assert.match(chooseBackend('win32', {}) as string, /WSL2/);
  assert.match(chooseBackend('aix', {}) as string, /not on aix/);
});

// The probe runs inside the desk. Each check is one line of its JSON answer. It is plain
// JavaScript written into the desk, so it needs nothing but Node.
const PROBE = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const [cli, outsideFile, otherProject, echoPort] = process.argv.slice(2);
const answer = {};
const tryIt = (fn) => { try { return fn(); } catch (error) { return 'failed: ' + (error.code || error.message); } };
answer.deskWrite = tryIt(() => { fs.writeFileSync('written.txt', 'x'); return 'ok'; });
const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
git('add', 'written.txt');
answer.commit = git('commit', '-qm', 'desk').status;
answer.outsideWrite = tryIt(() => { fs.writeFileSync(outsideFile, 'x'); return 'ok'; });
answer.homeWrite = tryIt(() => { fs.writeFileSync(process.env.HOME + '/outside.txt', 'x'); return 'ok'; });
answer.otherList = tryIt(() => fs.readdirSync(otherProject).join(','));
answer.otherRead = tryIt(() => fs.readFileSync(otherProject + '/notes.txt', 'utf8'));
const piped = spawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'through a pipe', encoding: 'utf8' });
answer.hostDoors = ['/run/WSL', '/run/user', '/var/run/docker.sock'].filter((path) => fs.existsSync(path));
answer.pipes = piped.error ? 'failed: ' + piped.error.code : piped.stdout;
answer.role = process.env.YOKOTEN_ROLE;
answer.tz = process.env.TZ;
answer.token = process.env.GH_TOKEN === undefined ? 'absent' : 'present';
const guard = spawnSync(process.execPath, [cli, 'hook'], { input: JSON.stringify({ tool_input: { command: 'git -c core.hooksPath=/dev/null commit -m x' } }), encoding: 'utf8' });
answer.guard = guard.status;
const proxy = new URL(process.env.HTTPS_PROXY);
const connectTo = (host, port, send) => new Promise((resolve) => {
  const socket = net.connect({ host, port }, () => socket.write(send));
  let text = '';
  socket.setTimeout(5000, () => { socket.destroy(); resolve(text || 'failed: timeout'); });
  socket.on('data', (chunk) => { text += chunk; if (text.includes('hello back')) { socket.destroy(); resolve(text); } });
  socket.on('error', (error) => resolve('failed: ' + error.code));
  socket.on('close', () => resolve(text || 'failed: closed'));
});
(async () => {
  answer.direct = await connectTo('127.0.0.1', Number(echoPort), 'hello');
  answer.allowed = await connectTo(proxy.hostname, Number(proxy.port), 'CONNECT localhost:' + echoPort + ' HTTP/1.1\r\nHost: localhost\r\n\r\nhello');
  answer.refused = await connectTo(proxy.hostname, Number(proxy.port), 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n');
  console.log(JSON.stringify(answer));
})();
`;

const backend = chooseBackend(process.platform, process.env);

test('the desk contract holds on this system', { skip: typeof backend === 'string' && backend }, async () => {
  if (typeof backend === 'string') return;
  const projects = makeTempDir('projects-');
  const origin = join(projects, 'origin');
  mkdirSync(origin);
  execFileSync('git', ['init', '-q', origin]);
  execFileSync('git', ['-C', origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'start']);
  const desk = join(projects, 'desk');
  execFileSync('git', ['clone', '-q', origin, desk]);
  const other = join(projects, 'other-project');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.txt'), 'not for the desk');
  writeFileSync(join(desk, 'probe.cjs'), PROBE);
  // A server outside the desk: reached through the proxy, never straight.
  const echo = createServer((socket) => socket.on('data', () => socket.end('hello back')));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const echoPort = (echo.address() as { port: number }).port;
  const outsideFile = join(dirname(desk), 'outside.txt');
  try {
    const plan = planDesk({
      runtime: 'claude-code',
      desk,
      command: [process.execPath, 'probe.cjs', CLI, outsideFile, other, String(echoPort)],
      env: { ...process.env, GH_TOKEN: 'not-a-real-token' },
      extraHosts: [`localhost:${echoPort}`],
    });
    const result = await startDesk(plan, backend, { stdio: 'pipe' });
    assert.equal(result.code, 0, result.stderr);
    const answer = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    assert.equal(answer.deskWrite, 'ok', 'a write in the desk works');
    assert.equal(answer.commit, 0, 'git commit works in the desk');
    assert.match(answer.outsideWrite, /^failed/, 'a write next to the desk fails');
    assert.match(answer.homeWrite, /^failed/, 'a write in the home folder fails');
    assert.ok(!existsSync(outsideFile) && !existsSync(join(process.env.HOME ?? '', 'outside.txt')), 'nothing was written outside');
    assert.match(answer.otherList, /^failed/, 'another project is not listed');
    assert.match(answer.otherRead, /^failed/, "another project's file is not read");
    assert.deepEqual(answer.hostDoors, [], 'no socket to the host: WSL interop, the session bus, Docker');
    assert.equal(answer.pipes, 'through a pipe', 'a child process with pipes works');
    assert.deepEqual([answer.role, answer.tz, answer.token], ['worker', 'UTC', 'absent'], 'role and time zone are set; a token is not passed in');
    assert.equal(answer.guard, 2, 'the guard refuses a commit that turns off the commit check');
    assert.match(answer.direct, /^failed/, 'a command has no network of its own');
    assert.match(answer.allowed, /^HTTP\/1\.1 200[^]*hello back$/, 'a CONNECT to an allowed host goes through the proxy');
    assert.match(answer.refused, /^HTTP\/1\.1 403/, 'a CONNECT to any other host is refused');
  } finally {
    echo.close();
  }
});
