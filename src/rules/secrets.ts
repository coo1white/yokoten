// The secrets half of the privacy rule: a credential in the repo is a key handed to anyone
// who can read it, and git keeps it after the file is gone. Each pattern asks for the
// token's real prefix, charset and length, so ordinary words and ids are not caught.
// A hit names the kind of secret, never the secret: the output may land in a CI log.

// Not part of a longer token: a match must not start or end inside a run of these.
const EDGE = 'A-Za-z0-9_\\-';
const token = (body: string) => new RegExp(`(?<![${EDGE}])${body}(?![${EDGE}])`, 'g');

const PATTERNS: { kind: string; re: RegExp }[] = [
  // GitHub personal, OAuth, user-to-server, server-to-server and refresh tokens.
  { kind: 'GitHub token', re: token('gh[pousr]_[A-Za-z0-9]{36,251}') },
  // GitHub fine-grained personal access token.
  { kind: 'GitHub token', re: token('github_pat_[A-Za-z0-9]{22,}_[A-Za-z0-9]{50,}') },
  // npm access token.
  { kind: 'npm token', re: token('npm_[A-Za-z0-9]{36}') },
  // AWS access key id: long-term (AKIA) or temporary (ASIA).
  { kind: 'AWS access key id', re: token('(?:AKIA|ASIA)[A-Z0-9]{16}') },
  // Slack bot, user, app, refresh and legacy tokens.
  { kind: 'Slack token', re: token('xox[abprs]-[0-9]+-[A-Za-z0-9-]{20,}') },
  // Stripe live secret and restricted keys. Test keys (sk_test_) charge nothing.
  { kind: 'Stripe live key', re: token('[sr]k_live_[A-Za-z0-9]{24,}') },
  // Google API key.
  { kind: 'Google API key', re: token('AIza[A-Za-z0-9_\\-]{35}') },
  // Anthropic API and admin keys.
  { kind: 'Anthropic key', re: token('sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_\\-]{32,}') },
  // OpenAI project, service account and admin keys.
  { kind: 'OpenAI key', re: token('sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\\-]{40,}') },
  // OpenAI legacy key, which carries "OpenAI" in base64 (T3BlbkFJ) in its middle.
  { kind: 'OpenAI key', re: token('sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}') },
  // Meta Model API key: LLM_, the numeric app id, then the secret.
  { kind: 'Meta key', re: token('LLM_[0-9]{6,}_[A-Za-z0-9_\\-]{20,}') },
];

// The examples AWS prints in its own docs (AKIAIOSFODNN7EXAMPLE) open nothing.
const PLACEHOLDER = /EXAMPLE$/;

// A PEM private key: RSA, EC, DSA, OpenSSH, PKCS#8 (plain or encrypted), PGP.
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
// What follows a real key's header: a base64 body or the headers of an encrypted key,
// on the next line (past one blank line, as PGP has) or after an escaped newline in a JSON
// or .env string. A header alone, as in code that looks for one, is not a key.
const PEM_BODY = /^\s*(?:[A-Za-z0-9+/=]{16,}|Proc-Type:|Version:|Comment:)/;
const PEM_INLINE = /PRIVATE KEY(?: BLOCK)?-----(?:\\r)?\\n(?:[A-Za-z0-9+/=]{16,}|Proc-Type:)/;

/** The kinds of secret in each line of a text, as [line index, kind], in order. */
export function findSecrets(lines: string[], allow: string[] = []): [number, string][] {
  const found: [number, string][] = [];
  lines.forEach((line, i) => {
    for (const { kind, re } of PATTERNS) {
      for (const [hit] of line.matchAll(re)) {
        if (!PLACEHOLDER.test(hit) && !allow.includes(hit)) found.push([i, kind]);
      }
    }
    const pem = PEM.exec(line);
    const next = lines[i + 1]?.trim() ? lines[i + 1] : (lines[i + 2] ?? '');
    if (pem && !allow.includes(pem[0]) && (PEM_INLINE.test(line) || PEM_BODY.test(next))) found.push([i, 'private key']);
  });
  return found;
}


/**
 * A known-bad sample, so the check can prove it still catches secrets. Built from pieces
 * so this file does not fail its own check.
 */
export const SECRET_CONTROL = [`token: ${'gh'}p_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`, `-----BEGIN RSA ${'PRIVATE'} KEY-----`, 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn'].join('\n');
