// Tests for src/agents/llama.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  answer,
  FACTS,
} from '../repo/helpers.ts';
import {
  chat,
  llamaConfig,
  type LlamaConfig,
} from '../../src/agents/llama.ts';
import {
  draft,
  prompt,
} from '../../src/setup/advice/adopt.ts';

const GOOD = [
  { key: 'rules', decision: 'as-is', reason: 'Already there.' },
  { key: 'ci', decision: 'lighter', reason: 'Keep the existing CI and add one step.' },
  { key: 'codeowners', decision: 'not-now', reason: 'One person; look again at the first outside contributor.' },
];

test('adopt chat: one OpenAI-style call with the key in the header only, against a local server', async () => {
  const seen: { url?: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let reply: (res: import('node:http').ServerResponse) => void = (res) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer(GOOD) } }] }));
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data) });
      res.setHeader('content-type', 'application/json');
      reply(res);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const env = { LLAMA_API_KEY: 'test-key', LLAMA_API_BASE: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`, LLAMA_MODEL: 'test-model', HOME: '/nowhere' };
  // With NODE_USE_ENV_PROXY=1, fetch sends even a local call through the shell's proxy,
  // which closes it. The fake API is on this machine, so the call goes to it directly.
  // Node reads both spellings of the variable, so both are set, then put back.
  const saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  try {
    const d = await draft(FACTS, { env });
    assert.equal(d.by, 'the model (test-model)');
    assert.deepEqual(d.rows.map((r) => r.decision), ['as-is', 'lighter', 'not-now']);
    const [call] = seen;
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.auth, 'Bearer test-key');
    assert.equal(call.body?.model, 'test-model');
    assert.equal((call.body?.response_format as { type: string }).type, 'json_schema');
    assert.ok(!JSON.stringify(call.body).includes('test-key'), 'the key is not in the body');
    reply = (res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'bad key test-key' } }));
    };
    const denied = await draft(FACTS, { env });
    assert.equal(denied.by, 'rules');
    assert.match(denied.note ?? '', /HTTP 401/);
    assert.ok(!(denied.note ?? '').includes('test-key'), 'an error body is not echoed');
    reply = () => {}; // never answers
    await assert.rejects(chat(llamaConfig(env) as LlamaConfig, prompt(FACTS), { timeoutMs: 200 }), /did not answer in/);
  } finally {
    server.closeAllConnections();
    server.close();
    for (const [name, value] of [['NO_PROXY', saved.upper], ['no_proxy', saved.lower]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(llamaConfig({}), null);
  assert.deepEqual(llamaConfig({ MODEL_API_KEY: 'test-key' }), { base: 'https://api.meta.ai/v1', model: 'muse-spark-1.3', key: 'test-key' });
});
