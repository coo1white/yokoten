// Tests for src/agents/desk/proxy.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAllowedTarget, type ProxyEvent, readConnectTarget, startProxy } from '../../../src/agents/desk/proxy.ts';
import { makeTempDir } from '../../repo/helpers.ts';

test('readConnectTarget: a CONNECT line with a host name and a port; nothing else', () => {
  assert.deepEqual(readConnectTarget('CONNECT API.Example.com.:443 HTTP/1.1\r\nHost: x'), { host: 'api.example.com', port: 443 });
  assert.equal(readConnectTarget('GET http://example.com/ HTTP/1.1'), null);
  assert.equal(readConnectTarget('CONNECT [::1]:443 HTTP/1.1'), null);
  assert.equal(readConnectTarget('CONNECT example.com HTTP/1.1'), null);
  assert.equal(readConnectTarget('CONNECT a b:443 HTTP/1.1'), null);
});

test('isAllowedTarget: the exact host on 443, or the port its entry names', () => {
  const hosts = ['api.example.com', 'localhost:8443'];
  assert.ok(isAllowedTarget({ host: 'api.example.com', port: 443 }, hosts));
  assert.ok(isAllowedTarget({ host: 'localhost', port: 8443 }, hosts));
  // Positive controls: each near miss is refused.
  assert.ok(!isAllowedTarget({ host: 'api.example.com', port: 22 }, hosts));
  assert.ok(!isAllowedTarget({ host: 'evil.api.example.com', port: 443 }, hosts));
  assert.ok(!isAllowedTarget({ host: 'example.com', port: 443 }, hosts));
  assert.ok(!isAllowedTarget({ host: 'localhost', port: 443 }, hosts));
});

/** Send `text` to the socket at `path`, and read until `until` shows or the socket closes. */
const talk = (path: string, text: string, until = '\u0000') =>
  new Promise<string>((resolve) => {
    let got = '';
    const socket = connect(path, () => socket.write(text));
    socket.on('data', (chunk) => {
      got += chunk;
      if (got.includes(until)) socket.destroy();
    });
    socket.on('close', () => resolve(got));
    socket.on('error', () => resolve(got));
  });

test('startProxy: tunnels to an allowed host, refuses others and anything not CONNECT', async () => {
  const echo = createServer((socket) => socket.on('data', (chunk) => socket.end(`echo:${chunk}`)));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const port = (echo.address() as { port: number }).port;
  const events: ProxyEvent[] = [];
  const path = join(makeTempDir('proxy-'), 'proxy.sock');
  const proxy = await startProxy(path, [`localhost:${port}`], (event) => events.push(event));
  try {
    const allowed = await talk(path, `CONNECT localhost:${port} HTTP/1.1\r\n\r\nhi`, 'echo:hi');
    assert.match(allowed, /^HTTP\/1\.1 200 Connection Established\r\n\r\necho:hi$/);
    assert.match(await talk(path, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.match(await talk(path, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n'), /^HTTP\/1\.1 405/);
    assert.match(await talk(path, `CONNECT localhost:${port} HTTP/1.1\r\n${'x'.repeat(9000)}`), /^HTTP\/1\.1 431/);
    assert.deepEqual(events, [
      { target: `localhost:${port}`, isAllowed: true },
      { target: 'example.com:443', isAllowed: false },
      { target: 'GET http://example.com/', isAllowed: false },
    ]);
  } finally {
    await proxy.close();
    echo.close();
  }
});

test('startProxy: listens on a port too, for a backend that has no socket', async () => {
  const proxy = await startProxy(0, []);
  try {
    const address = proxy.server.address() as { address: string; port: number };
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
  } finally {
    await proxy.close();
  }
});

test('startProxy: past the tunnel cap a CONNECT is refused; a still tunnel is closed', async () => {
  const echo = createServer((socket) => socket.on('data', (chunk) => socket.write(`echo:${chunk}`)));
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const port = (echo.address() as { port: number }).port;
  const path = join(makeTempDir('proxy-'), 'proxy.sock');
  const proxy = await startProxy(path, [`localhost:${port}`], () => {}, { maxTunnels: 1, idleMs: 200 });
  try {
    // The first tunnel stays open and still; the second is over the cap.
    const first = connect(path, () => first.write(`CONNECT localhost:${port} HTTP/1.1\r\n\r\n`));
    const closed = new Promise<number>((resolve) => {
      const opened = Date.now();
      first.on('close', () => resolve(Date.now() - opened));
    });
    await new Promise((resolve) => first.once('data', resolve));
    assert.match(await talk(path, `CONNECT localhost:${port} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 503/);
    assert.ok((await closed) >= 150, 'the still tunnel is closed after its idle time');
  } finally {
    await proxy.close();
    echo.close();
  }
});
