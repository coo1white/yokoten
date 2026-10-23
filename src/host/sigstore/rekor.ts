// Rekor, Sigstore's public transparency log, as the outside witness of one daily hash (#768).
//
// The nightly workflow signs the day's hash with its own OIDC identity and uploads the
// signature as a hashedrekord entry. This adapter asks Rekor for the entries of one hash,
// keeps one this repo's workflow signed, and checks four things:
//
// - the entry's signed entry timestamp (SET) verifies with Rekor's own public key, so
//   Rekor recorded this body at that log index and time;
// - the body is a hashedrekord whose data hash is the SHA-256 of the 64 hex characters,
//   so the entry commits to this hash and no log content;
// - the workflow's signature over those characters verifies with the certificate in the
//   entry;
// - the certificate's URI names this repo's anchor workflow, and it was valid when Rekor
//   took the entry.
//
// Only the 64 hex characters are sent. No log line, path or name is. Plain HTTPS and the
// standard library only: no runtime dependency, and no key on the machine (record 0029).

import { createHash, verify, X509Certificate } from 'node:crypto';

/** Rekor's public instance, the default and the one the workflow writes to. */
export const REKOR_API = 'https://rekor.sigstore.dev';

/** The workflow that signs an anchor, and the ref whose identity does it. */
export const ANCHOR_WORKFLOW = '.github/workflows/anchor.yml';
export const ANCHOR_REF = 'refs/heads/main';

/** How long one Rekor read waits. */
const REKOR_TIMEOUT_MS = 15000;

/** The identity Fulcio gives a GitHub workflow: a URI, never a name or an email. */
export const workflowIdentity = (repo: string, workflow = ANCHOR_WORKFLOW, ref = ANCHOR_REF): string =>
  `https://github.com/${repo}/${workflow}@${ref}`;

/** The SHA-256 of the 64 hex characters, as the hashedrekord entry stores it. */
export const anchoredDigest = (hash: string): string => createHash('sha256').update(hash).digest('hex');

/** What one check needs: the API, the identity expected, and a fetch for tests. */
export interface RekorOptions {
  /** The API's base URL; a test points it at its own server. */
  api?: string;
  /** The certificate URI that must have signed the anchor. */
  identity: string;
  /** The fetch to use; the process's own by default. */
  fetch?: typeof fetch;
}

/** One anchor as Rekor holds it: where it sits, when it was taken, and its id. */
export interface RekorAnchor {
  uuid: string;
  logIndex: number;
  /** Seconds since the Unix epoch, UTC. */
  integratedTime: number;
}

export type RekorFind = { found: RekorAnchor } | { problem: string };

/** The PEM of Rekor's public key, fetched once per API for a whole check. */
const rekorKeys = new Map<string, Promise<string>>();

/** One HTTP answer, as text, with a failure of our own that never names the address. */
async function read(call: typeof fetch, url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  let response: Response;
  try {
    response = await call(url, { ...init, signal: AbortSignal.timeout(REKOR_TIMEOUT_MS) });
  } catch {
    throw new Error('Rekor could not be reached');
  }
  return { status: response.status, text: await response.text() };
}

/** Rekor's public key, for a test server or the real one. */
function rekorKey(options: RekorOptions, api: string): Promise<string> {
  let key = rekorKeys.get(api);
  if (!key) {
    key = (async () => {
      const { status, text } = await read(options.fetch ?? fetch, `${api}/api/v1/log/publicKey`);
      if (status !== 200 || !text.includes('BEGIN PUBLIC KEY')) throw new Error('Rekor did not give its public key');
      return text;
    })();
    rekorKeys.set(api, key);
    key.catch(() => rekorKeys.delete(api));
  }
  return key;
}

const base64 = (value: unknown): Buffer | null => (typeof value === 'string' ? Buffer.from(value, 'base64') : null);

/** The URI names in a certificate's subject alternative name, without the `URI:` prefix. */
function certificateUris(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? '')
    .split(/,\s*/)
    .filter((name) => name.startsWith('URI:'))
    .map((name) => name.slice(4));
}

/**
 * One Rekor entry, checked. Returns the anchor, or the one reason to report. The reason
 * is about what is wrong, never about what the entry holds: a certificate may name a
 * person, and core rule 11 keeps that out of every message.
 */
function verifyEntry(body: string, publicKeyPem: string, hash: string, options: RekorOptions): string | null {
  let entry: {
    integratedTime?: unknown;
    logIndex?: unknown;
    logID?: unknown;
    body?: unknown;
    verification?: { signedEntryTimestamp?: unknown };
  };
  try {
    entry = JSON.parse(body);
  } catch {
    return 'the entry is not JSON';
  }
  const timestamp = entry.verification?.signedEntryTimestamp;
  const set = base64(timestamp);
  if (!set || typeof entry.integratedTime !== 'number' || typeof entry.logIndex !== 'number' || typeof entry.logID !== 'string' || typeof entry.body !== 'string') {
    return 'the entry has no signed entry timestamp';
  }
  const payload = JSON.stringify({ body: entry.body, integratedTime: entry.integratedTime, logID: entry.logID, logIndex: entry.logIndex });
  let setHolds: boolean;
  try {
    setHolds = verify('sha256', Buffer.from(payload), publicKeyPem, set);
  } catch {
    setHolds = false;
  }
  if (!setHolds) return 'the signed entry timestamp does not verify with Rekor\'s public key';

  let record: { kind?: unknown; spec?: { signature?: { content?: unknown; publicKey?: { content?: unknown } }; data?: { hash?: { value?: unknown } } } };
  try {
    record = JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8'));
  } catch {
    return 'the entry body is not JSON';
  }
  if (record.kind !== 'hashedrekord') return `the entry is a ${String(record.kind)}, not a hashedrekord`;
  if (record.spec?.data?.hash?.value !== anchoredDigest(hash)) return 'the entry commits to another hash';

  const signature = base64(record.spec.signature?.content);
  const certificatePem = base64(record.spec.signature?.publicKey?.content);
  if (!signature || !certificatePem) return 'the entry has no signature or certificate';
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    return 'the entry\'s certificate cannot be read';
  }
  if (!certificateUris(certificate).includes(options.identity)) return 'another identity signed the anchor';

  const at = entry.integratedTime * 1000;
  if (at < Date.parse(certificate.validFrom) || at > Date.parse(certificate.validTo)) return 'the certificate was not valid when Rekor took the entry';

  let signatureHolds: boolean;
  try {
    signatureHolds = verify('sha256', Buffer.from(hash), certificate.publicKey, signature);
  } catch {
    signatureHolds = false;
  }
  if (!signatureHolds) return 'the workflow\'s signature over the hash does not verify';

  return null;
}

/**
 * The anchor Rekor holds for `hash`, signed by `options.identity`, or why there is none.
 * One hash is looked up, then at most five of its entries are read: a hash can be
 * anchored more than once, and the first entry a workflow signed is the answer.
 */
export async function findAnchor(hash: string, options: RekorOptions): Promise<RekorFind> {
  // Only the one shape an anchor has leaves the machine: 64 lowercase hex characters.
  if (!/^[0-9a-f]{64}$/.test(hash)) return { problem: 'the day has no 64-character lowercase hex hash to look up' };
  const api = (options.api ?? REKOR_API).replace(/\/$/, '');
  const call = options.fetch ?? fetch;
  let index: { status: number; text: string };
  try {
    index = await read(call, `${api}/api/v1/index/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: `sha256:${hash}` }),
    });
  } catch (err) {
    return { problem: (err as Error).message };
  }
  if (index.status === 404) return { problem: 'Rekor holds no entry for this hash' };
  if (index.status !== 200) return { problem: `Rekor answered ${index.status} when asked for this hash` };
  let uuids: unknown;
  try {
    uuids = JSON.parse(index.text);
  } catch {
    uuids = undefined;
  }
  if (!Array.isArray(uuids) || !uuids.length) return { problem: 'Rekor holds no entry for this hash' };

  let key: string;
  try {
    key = await rekorKey(options, api);
  } catch (err) {
    return { problem: (err as Error).message };
  }

  let why = 'Rekor holds no entry this repo\'s workflow signed';
  for (const uuid of uuids.slice(0, 5)) {
    if (typeof uuid !== 'string') continue;
    let answer: { status: number; text: string };
    try {
      answer = await read(call, `${api}/api/v1/log/entries/${encodeURIComponent(uuid)}`);
    } catch (err) {
      why = (err as Error).message;
      continue;
    }
    if (answer.status !== 200) {
      why = `Rekor answered ${answer.status} when asked for the entry`;
      continue;
    }
    let entries: Record<string, unknown>;
    try {
      entries = JSON.parse(answer.text);
    } catch {
      why = 'the entry is not JSON';
      continue;
    }
    const entry = entries[uuid];
    if (!entry || typeof entry !== 'object') {
      why = 'the entry is not the one asked for';
      continue;
    }
    const problem = verifyEntry(JSON.stringify(entry), key, hash, options);
    if (problem === null) {
      const { logIndex, integratedTime } = entry as { logIndex?: unknown; integratedTime?: unknown };
      if (typeof logIndex === 'number' && typeof integratedTime === 'number') return { found: { uuid, logIndex, integratedTime } };
      why = 'the entry has no log index or time';
      continue;
    }
    why = problem;
  }
  return { problem: why };
}
