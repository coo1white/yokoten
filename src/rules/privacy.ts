// The privacy rule: nothing in the repo points at the person behind it, or opens their
// accounts. Three kinds of check:
//
// - Patterns anyone can see: email addresses and IPv4 addresses. A few are always fine
//   (GitHub's noreply addresses, the documentation ranges, localhost).
// - Marks only the owner knows: their name, their city, their domain, a server's name.
//   These live in a file OUTSIDE the repo (~/.config/yokoten/private-marks, one per line),
//   because a list of what must not be published cannot itself be published. CI does not
//   have the file, so CI checks the patterns only; the commit check on the owner's machine
//   checks both.
// - Secrets: tokens and private keys, in secrets.ts. Their hits pass through scanText too,
//   so every caller (the commit, CI, the history) catches them.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from './config.ts';
import { type Finding, finding } from './message.ts';
import { findSecrets } from './secrets.ts';

export const marksFile = (env: Env): string => env.YOKOTEN_PRIVATE_MARKS || join(env.HOME || homedir(), '.config', 'yokoten', 'private-marks');

/** The owner's marks, lowercased. An empty list when the file is missing. */
export function loadMarks(env: Env): string[] {
  let text = '';
  try {
    text = readFileSync(marksFile(env), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.toLowerCase());
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;

// Addresses that point at no person. A personal address at the same domains
// (someone at gmail.com, or at github.com) is still caught.
const OK_EMAIL = [
  /@users\.noreply\.(github|gitlab)\.com$/i,
  // A team's inbox at a public service, quoted in a commit message or a doc.
  /^(noreply|no-reply|support|security|privacy|notifications)@(github\.com|gitlab\.com|bitbucket\.org|anthropic\.com|npmjs\.com)$/i,
  // An SSH remote (git@host:owner/repo) at a public forge. One at a private host is
  // still caught: it names the host.
  /^git@(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|ssh\.dev\.azure\.com)$/i,
  /@example\.(com|org|net)$/i,
  // Names reserved for tests, docs and local networks (RFC 2606, RFC 6762).
  /@[\w.-]+\.(test|example|invalid|localhost|local)$/i,
];
// Localhost, "any", and the three ranges RFC 5737 keeps for documentation.
const OK_IP = [/^127\./, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];

/**
 * Problems in one file's text. `allow` holds literal strings the project has said are
 * fine (yokoten.json "privacy.allow"), such as a public support address.
 */
export function scanText(text: string, { file, marks = [], allow = [] }: { file: string; marks?: string[]; allow?: string[] }): Finding[] {
  const problems: Finding[] = [];
  const lines = text.split('\n');
  const secrets = findSecrets(lines, allow);
  lines.forEach((line, i) => {
    const where = { file, line: i + 1 };
    // The secret itself is never printed either, only its kind.
    for (const [at, kind] of secrets) if (at === i) problems.push(finding('secret', `a secret (${kind})`, 'remove it, rotate it, and keep it outside the repo', where));
    for (const [hit] of line.matchAll(EMAIL)) {
      if (!OK_EMAIL.some((re) => re.test(hit)) && !allow.includes(hit)) {
        problems.push(finding('email', 'an email address', 'use your GitHub noreply address, or a placeholder at example.com', where));
      }
    }
    for (const [hit] of line.matchAll(IPV4)) {
      const octets = hit.split('.').map(Number);
      if (octets.some((n) => n > 255) || OK_IP.some((re) => re.test(hit)) || allow.includes(hit)) continue;
      problems.push(finding('ip', 'an IP address', 'use a placeholder from 192.0.2.0/24', where));
    }
    const lower = line.toLowerCase();
    for (const mark of marks) {
      // The mark itself is never printed: the output may land in a CI log or a chat.
      if (lower.includes(mark)) problems.push(finding('private-mark', 'matches a line of your private-marks file', 'remove it or reword the line; the mark itself is never printed', where));
    }
  });
  return problems;
}

/**
 * Text as yokoten may show it: the home folder, which names the machine's user, becomes
 * `~`. Everything yokoten prints passes through this.
 */
export function hideHome(text: string, env: Env): string {
  const home = (env.HOME || homedir()).replace(/[\\/]+$/, '');
  return home.length > 1 ? text.split(home).join('~') : text;
}

/**
 * Whether a git ident ("Name <email> 1760745600 +0700") carries a time zone other than
 * UTC. A commit records its author's and committer's UTC offset, and an offset narrows
 * down where someone lives. The offset itself is never printed.
 */
export function notUtc(ident: string): boolean {
  const zone = /\s([+-]\d{4})\s*$/.exec(ident)?.[1];
  return zone !== undefined && zone !== '+0000' && zone !== '-0000';
}

export const TIME_ZONE_FIX = 'commit with TZ=UTC (`TZ=UTC git commit`, or `export TZ=UTC` in your shell); yokoten init sets it for agent sessions';

/**
 * A known-bad sample, so a check can prove it still catches what it should. It is built
 * from pieces so this file does not fail its own check.
 */
export const POSITIVE_CONTROL = [`contact: someone${'@'}personal-mail.com`, `server: ${[100, 64, 1, 2].join('.')}`].join('\n');
