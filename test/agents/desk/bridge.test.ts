// Tests for src/agents/desk/bridge.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { readBridgeArgs, runBridge, startBridge } from '../../../src/agents/desk/bridge.ts';
import { makeTempDir } from '../../repo/helpers.ts';

test('readBridgeArgs: socket, port, --, then the command', () => {
  assert.deepEqual(readBridgeArgs(['/s.sock', '3128', '--', 'claude', '-p', 'x']), { socket: '/s.sock', port: 3128, command: ['claude', '-p', 'x'] });
  assert.match(readBridgeArgs(['/s.sock', '3128', 'claude']) as string, /^usage/);
  assert.match(readBridgeArgs(['/s.sock', 'port', '--', 'claude']) as string, /^usage/);
  assert.match(readBridgeArgs(['/s.sock', '70000', '--', 'claude']) as string, /^usage/);
  assert.match(readBridgeArgs(['/s.sock', '3128', '--']) as string, /^usage/);
});

test('startBridge: a connection to the port reaches the socket, both ways', { skip: process.platform === 'win32' && 'the bridge runs in the Linux desk only' }, async () => {
  const path = join(makeTempDir('bridge-'), 'proxy.sock');
  const upstream = createServer((socket) => socket.on('data', (chunk) => socket.end(`back:${chunk}`)));
  await new Promise<void>((resolve) => upstream.listen(path, resolve));
  const bridge = await startBridge(path, 0);
  try {
    const port = (bridge.address() as { port: number }).port;
    const got = await new Promise<string>((resolve) => {
      let text = '';
      const socket = connect({ host: '127.0.0.1', port }, () => socket.write('ping'));
      socket.on('data', (chunk) => (text += chunk));
      socket.on('close', () => resolve(text));
    });
    assert.equal(got, 'back:ping');
  } finally {
    bridge.close();
    upstream.close();
  }
});

test('runBridge: a bad command line is refused with the usage, and nothing starts', async () => {
  let said = '';
  assert.equal(await runBridge(['/s.sock', '3128'], { write: (text: string) => (said += text) }), 1);
  assert.match(said, /^yokoten desk: usage: /);
});
