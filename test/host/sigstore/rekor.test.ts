// Tests for src/host/sigstore/rekor.ts: one hash found, and every way an entry can fail (#768).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { anchoredDigest, findAnchor, workflowIdentity } from '../../../src/host/sigstore/rekor.ts';
import { makeTempDir } from '../../repo/helpers.ts';

const HASH = 'a'.repeat(64);
const IDENTITY = workflowIdentity('octo/app');
const OTHER = workflowIdentity('octo/other');

/** A certificate from Fulcio's shape: an EC key, a URI SAN, and one day of life. */
function certificate(identity: string): { cert: string; key: KeyObject } {
  const dir = makeTempDir();
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-nodes', '-subj', '/CN=anchor', '-addext', `subjectAltName=URI:${identity}`,
    ],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: createPrivateKey(readFileSync(join(dir, 'key.pem'), 'utf8')) };
}

const rekor = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rekorPublic = rekor.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const mine = certificate(IDENTITY);
const theirs = certificate(OTHER);

interface Entry {
  integratedTime: number;
  logIndex: number;
  logID: string;
  body: string;
  verification: { signedEntryTimestamp: string };
}

/** One hashedrekord as cosign uploads it, and Rekor's SET over the same fields. */
function entryFor(hash: string, pair: { cert: string; key: KeyObject }): Entry {
  const signature = sign('sha256', Buffer.from(hash), pair.key);
  const body = Buffer.from(
    JSON.stringify({
      apiVersion: '0.0.1',
      kind: 'hashedrekord',
      spec: {
        signature: { content: signature.toString('base64'), publicKey: { content: Buffer.from(pair.cert).toString('base64') } },
        data: { hash: { algorithm: 'sha256', value: anchoredDigest(hash) } },
      },
    }),
  ).toString('base64');
  const entry: Entry = {
    integratedTime: Math.floor(Date.now() / 1000),
    logIndex: 42,
    logID: 'ab'.repeat(32),
    body,
    verification: { signedEntryTimestamp: '' },
  };
  return reseal(entry);
}

/** Rekor's SET over one entry, as the log makes it after it takes the body. */
function reseal(entry: Entry): Entry {
  entry.verification.signedEntryTimestamp = sign(
    'sha256',
    Buffer.from(JSON.stringify({ body: entry.body, integratedTime: entry.integratedTime, logID: entry.logID, logIndex: entry.logIndex })),
    rekor.privateKey,
  ).toString('base64');
  return entry;
}

/** The body as an object, changed by `change`, and sealed again. */
function bodyOf(entry: Entry): { spec: { data: { hash: { value: string } }; signature: { content: string } } } {
  return JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8'));
}

/** A Rekor that answers one entry: `read` names it by hash, or undefined. */
async function fakeRekor(read: (hash: string) => Entry | undefined) {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/v1/log/publicKey') {
      res.end(rekorPublic);
      return;
    }
    if (req.url === '/api/v1/index/retrieve' && req.method === 'POST') {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        const hash = String(JSON.parse(text).hash ?? '').replace(/^sha256:/, '');
        asked.push(hash);
        if (read(hash) === undefined) {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(['uuid-1']));
      });
      return;
    }
    if (req.url === '/api/v1/log/entries/uuid-1') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ 'uuid-1': read(asked[asked.length - 1]) }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The test's server answers the paths findAnchor asks for; Rekor's own address stays fixed.
  const call = ((input: string | URL | Request, init?: RequestInit) => fetch(new URL(new URL(String(input)).pathname, base), init)) as typeof fetch;
  return { asked, call, close: () => server.close() };
}

test('rekor: an entry this workflow signed is found, with its log index', async () => {
  const good = entryFor(HASH, mine);
  const fake = await fakeRekor((hash) => (hash === HASH ? good : undefined));
  try {
    assert.deepEqual(await findAnchor(HASH, { identity: IDENTITY, fetch: fake.call }), { found: { uuid: 'uuid-1', logIndex: 42, integratedTime: good.integratedTime } });
    assert.deepEqual(fake.asked, [HASH]);
  } finally {
    fake.close();
  }
});

test('rekor: a hash Rekor does not hold is not anchored', async () => {
  const fake = await fakeRekor(() => undefined);
  try {
    assert.deepEqual(await findAnchor(HASH, { identity: IDENTITY, fetch: fake.call }), { problem: 'Rekor holds no entry for this hash' });
  } finally {
    fake.close();
  }
});

test('rekor: another identity signed it, so it is not an anchor of this repo', async () => {
  const other = entryFor(HASH, theirs);
  const fake = await fakeRekor(() => other);
  try {
    assert.deepEqual(await findAnchor(HASH, { identity: IDENTITY, fetch: fake.call }), { problem: 'another identity signed the anchor' });
  } finally {
    fake.close();
  }
});

test('rekor: a body changed after the SET was signed is refused', async () => {
  const changed = entryFor(HASH, mine);
  const body = bodyOf(changed);
  body.spec.data.hash.value = anchoredDigest('c'.repeat(64));
  changed.body = Buffer.from(JSON.stringify(body)).toString('base64');
  const fake = await fakeRekor(() => changed);
  try {
    assert.deepEqual(await findAnchor(HASH, { identity: IDENTITY, fetch: fake.call }), { problem: 'the signed entry timestamp does not verify with Rekor\'s public key' });
  } finally {
    fake.close();
  }
});

test('rekor: a re-sealed entry that commits to another hash is refused', async () => {
  const wrong = entryFor(HASH, mine);
  const body = bodyOf(wrong);
  body.spec.data.hash.value = anchoredDigest('c'.repeat(64));
  wrong.body = Buffer.from(JSON.stringify(body)).toString('base64');
  reseal(wrong);
  const fake = await fakeRekor(() => wrong);
  try {
    assert.deepEqual(await findAnchor(HASH, { identity: IDENTITY, fetch: fake.call }), { problem: 'the entry commits to another hash' });
  } finally {
    fake.close();
  }
});

test('rekor: a signature over another hash is refused', async () => {
  const wrong = entryFor(HASH, mine);
  const body = bodyOf(wrong);
  body.spec.signature.content = sign('sha256', Buffer.from('b'.repeat(64)), mine.key).toString('base64');
  wrong.body = Buffer.from(JSON.stringify(body)).toString('base64');
  reseal(wrong);
  const fake = await fakeRekor(() => wrong);
  try {
    assert.deepEqual(await findAnchor(HASH, { identity: IDENTITY, fetch: fake.call }), { problem: 'the workflow\'s signature over the hash does not verify' });
  } finally {
    fake.close();
  }
});

test('rekor: the certificate must be valid when Rekor took the entry', async () => {
  const old = entryFor(HASH, mine);
  old.integratedTime = 0;
  reseal(old);
  const fake = await fakeRekor(() => old);
  try {
    assert.deepEqual(await findAnchor(HASH, { identity: IDENTITY, fetch: fake.call }), { problem: 'the certificate was not valid when Rekor took the entry' });
  } finally {
    fake.close();
  }
});
