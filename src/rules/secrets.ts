// The secrets half of the privacy rule: a credential in the repo is a key handed to anyone
// who can read it, and git keeps it after the file is gone. Each pattern asks for the
// token's real prefix, charset and length, so ordinary words and ids are not caught.
// A hit names the kind of secret, never the secret: the output may land in a CI log.

import type { Env } from './config.ts';
import type { FindingGrade } from './message.ts';

/** What `yokoten redact` writes in place of a secret (#390). */
export const SECRET = '<secret>';

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

/** What a check found on one line: the words for its kind, how sure the check is, and where it is. */
export interface SecretHit {
  line: number;
  kind: string;
  grade: FindingGrade;
  start: number;
  end: number;
}

/** One ignore line: the rule it names and the reviewer's reason. */
export interface IgnoreDirective {
  rule: string;
  reason: string;
  /** The line in `.yokotenignore`, when the directive came from that file. */
  line?: number;
}

/** An ignore line that cannot be used: it has no rule, or no reason. */
export interface IgnoreProblem {
  line: number;
  what: string;
}

/** The parts of an ignore file a check reads. */
export interface IgnoreFile {
  entries: IgnoreDirective[];
  problems: IgnoreProblem[];
}

// The examples AWS prints in its own docs (AKIAIOSFODNN7EXAMPLE) open nothing.
const PLACEHOLDER = /EXAMPLE$/;

// A PEM private key: RSA, EC, DSA, OpenSSH, PKCS#8 (plain or encrypted), PGP.
const PEM = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
// What follows a real key's header: a base64 body or the headers of an encrypted key,
// on the next line (past one blank line, as PGP has) or after an escaped newline in a JSON
// or .env string. A header alone, as in code that looks for one, is not a key.
const PEM_BODY = /^\s*(?:[A-Za-z0-9+/=]{16,}|Proc-Type:|Version:|Comment:)/;
const PEM_INLINE = /PRIVATE KEY(?: BLOCK)?-----(?:\\r)?\\n(?:[A-Za-z0-9+/=]{16,}|Proc-Type:)/;

// A variable whose name says it holds a secret. Words are split, so AUTHORS is not AUTH.
const SECRET_WORDS = new Set(['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'PASSWD', 'AUTH', 'CREDENTIAL', 'CREDENTIALS', 'PRIVATE']);
const NOT_SECRET_SUFFIX = /(?:_|^)(?:DIR|PATH|FILE|URL|URI|HOME|USER|NAME|HOST|PORT|SOCK|MODE|TYPE|MARKS|ID)$/i;
const NOT_SECRET_ENV = new Set(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'GPG_KEY']);
const NOT_SECRET_ENV_NAME = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;
const PLACEHOLDER_VALUE = /^(?:true|false|null|undefined|none|empty|example|sample|test|demo|changeme|change-me|redacted|placeholder|your[-_].*|\$\{.*\}|<.*>)$/i;

// A key assignment with a value. The name must say what it holds; the value must look intact.
const KEY_ASSIGNMENT = /(?:^|[^A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]{0,64})\s*[:=]\s*(?:"([^"\n]{8,4096})"|'([^'\n]{8,4096})'|`([^`\n]{8,4096})`|([^\s"'`,;]{8,4096}))/g;
const TOKEN_VALUE = /^[A-Za-z0-9_+=/.-]+$/;
const CODE_REFERENCE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
const PROCESS_LOOKUP = /^(?:process\.env|os\.environ|os\.getenv|env\.|Deno\.env|import\.meta\.env)/;
const PATH_VALUE = /^(?:[.~]?[/\\]|[A-Za-z]:[/\\])/;
const FAKE_VALUE = /never|not[-_]?real|fake|dummy|redacted|placeholder/i;

/** Whether a variable name says it holds a secret, as `SERVICE_TOKEN` or `apiKey` does. */
export function isSecretName(name: string): boolean {
  if (NOT_SECRET_ENV.has(name) || NOT_SECRET_ENV_NAME.test(name) || NOT_SECRET_SUFFIX.test(name)) return false;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((word) => SECRET_WORDS.has(word));
}

// Shorter values, and values of one kind of character, match too much: a port, a count,
// a word. A real key is longer and mixes kinds.
const MIN_ENV_VALUE = 12;
const charKinds = (value: string): number => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;

/** The real values of secret-looking variables, when they are worth matching. */
export function findEnvironmentValues(env: Env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !isSecretName(name) || value.length < MIN_ENV_VALUE || value.length > 4096 || /\s/.test(value)) continue;
    if (PLACEHOLDER_VALUE.test(value) || PROCESS_LOOKUP.test(value) || CODE_REFERENCE.test(value) || PATH_VALUE.test(value) || FAKE_VALUE.test(value)) continue;
    const unique = new Set(value).size;
    if (!(charKinds(value) >= 2 && unique >= 8) && !(value.length >= 24 && unique >= 10)) continue;
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

/** The kind in words for a generic key name. */
function describeKeyKind(name: string): string {
  const upper = name.toUpperCase();
  if (/PASSWORD|PASSWD/.test(upper)) return 'password';
  if (/TOKEN/.test(upper)) return 'token';
  if (/PRIVATE/.test(upper)) return 'private key';
  if (/SECRET/.test(upper)) return 'secret value';
  return 'API key';
}

/** Whether a generic value looks like a key, rather than a word or a code reference. */
function gradeGenericValue(value: string): FindingGrade | null {
  if (value.length < 16) return null;
  const unique = new Set(value).size;
  const mixedCase = /[A-Z]/.test(value) && /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  if (unique >= 8 && (mixedCase || hasDigit)) return 'likely';
  return value.length >= 32 && unique >= 12 ? 'unknown' : null;
}

const hasOverlap = (hits: SecretHit[], start: number, end: number): boolean => hits.some((hit) => start < hit.end && end > hit.start);

/** Secret hits in a text: known shapes, real values from the environment, and key-like assignments. */
export function findSecretHits(lines: string[], { allow = [], env = {} }: { allow?: string[]; env?: Env } = {}): SecretHit[] {
  const found: SecretHit[] = [];
  const fromEnvironment = findEnvironmentValues(env);
  lines.forEach((line, lineIndex) => {
    const onLine: SecretHit[] = [];
    for (const { kind, re } of PATTERNS) {
      for (const match of line.matchAll(re)) {
        const hit = match[0];
        if (PLACEHOLDER.test(hit) || allow.includes(hit)) continue;
        const start = match.index ?? 0;
        onLine.push({ line: lineIndex, kind, grade: 'sure', start, end: start + hit.length });
      }
    }
    const pem = PEM.exec(line);
    const next = lines[lineIndex + 1]?.trim() ? lines[lineIndex + 1] : (lines[lineIndex + 2] ?? '');
    if (pem && !allow.includes(pem[0]) && (PEM_INLINE.test(line) || PEM_BODY.test(next))) {
      const start = pem.index;
      onLine.push({ line: lineIndex, kind: 'private key', grade: 'sure', start, end: start + pem[0].length });
    }
    for (const value of fromEnvironment) {
      if (allow.includes(value)) continue;
      for (let start = line.indexOf(value); start !== -1; start = line.indexOf(value, start + value.length)) {
        if (!hasOverlap(onLine, start, start + value.length)) onLine.push({ line: lineIndex, kind: 'environment value', grade: 'sure', start, end: start + value.length });
      }
    }
    for (const match of line.matchAll(KEY_ASSIGNMENT)) {
      const name = match[1];
      const value = match[2] ?? match[3] ?? match[4] ?? match[5];
      if (!isSecretName(name) || allow.includes(value) || value.includes('${') || value.includes('{{')) continue;
      if (!TOKEN_VALUE.test(value) || CODE_REFERENCE.test(value) || PROCESS_LOOKUP.test(value) || PLACEHOLDER_VALUE.test(value) || PATH_VALUE.test(value) || FAKE_VALUE.test(value)) continue;
      const start = (match.index ?? 0) + match[0].lastIndexOf(value);
      const end = start + value.length;
      if (hasOverlap(onLine, start, end)) continue;
      const grade = gradeGenericValue(value);
      if (grade) onLine.push({ line: lineIndex, kind: describeKeyKind(name), grade, start, end });
    }
    onLine.sort((a, b) => a.start - b.start || a.end - b.end);
    found.push(...onLine);
  });
  return found;
}

/** The kinds of secret in each line of a text, as [line index, kind], in order. */
export function findSecrets(lines: string[], allow: string[] = [], env: Env = {}): [number, string][] {
  return findSecretHits(lines, { allow, env }).map((hit) => [hit.line, hit.kind]);
}

/** One ignore marker or line, as `secret: reason`. */
function parseIgnore(text: string): IgnoreDirective | { problem: string } {
  let body = text.trim().replace(/(?:\*\/|--!?>)\s*$/, '').trim();
  if (!body) return { problem: 'an ignore names a rule and gives a reason' };
  if (/^yokoten-ignore\b/i.test(body)) body = body.replace(/^yokoten-ignore\b\s*:?\s*/i, '');
  const colon = body.indexOf(':');
  if (colon === -1) {
    const spaced = /^([a-z][a-z0-9-]*)\s+(.+)$/i.exec(body);
    if (spaced) return { rule: spaced[1].toLowerCase(), reason: spaced[2].trim() };
  }
  const rule = (colon === -1 ? body : body.slice(0, colon)).trim().toLowerCase();
  const reason = colon === -1 ? '' : body.slice(colon + 1).trim();
  if (!/^[a-z][a-z0-9-]*$/.test(rule)) return { problem: 'an ignore names a rule, such as secret, and gives a reason' };
  if (!reason) return { problem: 'an ignore has no reason' };
  return { rule, reason };
}

/** Where a comment starts on a line, or -1: quotes come first, so a marker inside a string is not a comment. */
function findCommentStart(line: string): number {
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    const pair = line.slice(index, index + 2);
    if ((pair === '//' && line[index - 1] !== ':') || pair === '/*' || (pair === '--' && (index === 0 || /\s/.test(line[index - 1])))) return index;
    if (line.startsWith('<!--', index) || char === '#' || (char === '*' && /^\s*$/.test(line.slice(0, index)))) return index;
  }
  return -1;
}

/** Every `yokoten-ignore <rule>: <reason>` marker on one line; with `commentsOnly`, just those in a comment. */
export function findLineIgnores(line: string, { commentsOnly = false }: { commentsOnly?: boolean } = {}): (IgnoreDirective | { problem: string })[] {
  const found: (IgnoreDirective | { problem: string })[] = [];
  const start = commentsOnly ? findCommentStart(line) : 0;
  if (start === -1) return found;
  const comment = line.slice(start);
  const marker = commentsOnly ? /^\s*(?:(?:\/\/|#|\/\*+|<!--|\*|--)\s*)?(yokoten-ignore\b[^\n]*)/i.exec(comment) : /(yokoten-ignore\b[^\n]*)/i.exec(comment);
  if (marker) found.push(parseIgnore(marker[1]));
  return found;
}

/** A `.yokotenignore` file, one `<rule>: <reason>` per line. */
export function parseIgnoreFile(text: string): IgnoreFile {
  const entries: IgnoreDirective[] = [];
  const problems: IgnoreProblem[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const body = line.trim().replace(/^[-*]\s+/, '');
    if (!body || /^(?:#|\/\/|;)/.test(body)) return;
    const parsed = parseIgnore(body);
    if ('problem' in parsed) problems.push({ line: index + 1, what: parsed.problem });
    else entries.push({ ...parsed, line: index + 1 });
  });
  return { entries, problems };
}

/** A reason with every secret-shaped value hidden, so output can show it as written. */
export function makeSafeIgnoreReason(reason: string, env: Env = {}, extraValues: string[] = []): string {
  let safe = reason;
  for (const value of extraValues) if (value) safe = safe.replaceAll(value, SECRET);
  safe = makeSecretHider()(safe);
  for (const value of findEnvironmentValues(env)) safe = safe.replaceAll(value, SECRET);
  return safe;
}

/**
 * A function that puts SECRET in place of each token, and of each line of a private key,
 * in text given to it in order: a key that starts in one piece ends in a later one. A key
 * starts at a line that is its header, or holds the header and the body (JSON, .env).
 */
export function makeSecretHider(): (text: string) => string {
  let isInKey = false;
  return (text) =>
    text
      .split(/(?<=\n)/)
      .map((line) => {
        if (!isInKey && (PEM_INLINE.test(line) || (PEM.test(line) && line.trim().startsWith('-----BEGIN')))) isInKey = true;
        if (isInKey) {
          if (/-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/.test(line)) isInKey = false;
          return line.replace(/[^\r\n]+/, SECRET);
        }
        let out = line;
        for (const { re } of PATTERNS) out = out.replace(re, (hit) => (PLACEHOLDER.test(hit) ? hit : SECRET));
        return out;
      })
      .join('');
}

/**
 * A known-bad sample, so the check can prove it still catches secrets. Built from pieces
 * so this file does not fail its own check.
 */
export const SECRET_CONTROL = [`token: ${'gh'}p_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`, `-----BEGIN RSA ${'PRIVATE'} KEY-----`, 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn'].join('\n');
