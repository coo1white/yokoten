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

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Config, Env } from './config.ts';
import { type Finding, finding, type RuleId } from './message.ts';
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
// A browser version in a user agent (Chrome/120.0.0.0) is not an address. Only the
// browser product names are skipped, case-sensitive as a user agent writes them: an
// address in a path (api/192.0.2.1) or a URL (http://192.0.2.1) is still caught.
// Only IPv4 is checked, private ranges included; IPv6 is not.
const BROWSER = 'Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS|Edge|OPR|Opera|Version|Firefox|FxiOS|Safari|AppleWebKit|Gecko|Mozilla|YaBrowser|SamsungBrowser|UCBrowser|Electron';
const IPV4 = new RegExp(`(?<![\\w.])(?<!\\b(?:${BROWSER})/)(?:\\d{1,3}\\.){3}\\d{1,3}(?![\\w.])`, 'g');

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
// A retina image name (logo@2x.png) looks like an email address at the domain 2x.png.
const RETINA = /@\d+x\.(png|jpe?g|gif|webp|svg|avif)$/i;
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
      if (!OK_EMAIL.some((re) => re.test(hit)) && !RETINA.test(hit) && !allow.includes(hit)) {
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

// A character that can sit next to a path segment and continue it. A dot continues it
// only when a name character follows, so a full stop after a path still ends it.
const PATH_CHAR = String.raw`[\p{L}\p{N}_\-+@%~#$]`;
const BEFORE_HOME = String.raw`(?<!${PATH_CHAR}|[.\\/])`;
const AFTER_HOME = String.raw`(?!${PATH_CHAR}|\.${PATH_CHAR})`;

/** The forms of one home folder that text may hold: as given, its real path, and on Windows its MSYS form. */
function homeForms(home: string | undefined): string[] {
  if (!home) return [];
  let real = home;
  try {
    real = realpathSync(home);
  } catch {}
  const forms = [home, real].map((path) => path.replace(/[\\/]+$/, ''));
  // C:\Users\me is /c/Users/me in Git Bash.
  for (const path of [...forms]) {
    const drive = /^([A-Za-z]):([\\/].*)$/.exec(path);
    if (drive) forms.push(`/${drive[1].toLowerCase()}${drive[2]}`);
  }
  return forms.filter((path) => path.length > 1 && !/^[A-Za-z]:$/.test(path));
}

/**
 * Text as yokoten may show it: the home folder, which names the machine's user, becomes
 * `~`. Everything yokoten prints passes through this. Both homes are hidden: $HOME and the
 * system's (they differ under sudo, in CI, or with HOME=/tmp/x), each also by its real path
 * (on macOS a temp or home folder resolves to /private/...). A home is replaced only where
 * its path ends, so /data/u never touches /data/users. On Windows `\` and `/` match each
 * other, and case does not count.
 */
export function hideHome(text: string, env: Env, { platform = process.platform as string, systemHome = homedir() } = {}): string {
  const homes = [...new Set([...homeForms(env.HOME), ...homeForms(systemHome)])].sort((a, b) => b.length - a.length);
  if (!homes.length) return text;
  const isWindows = platform === 'win32';
  const pattern = homes.map((home) => home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\|\//g, String.raw`[\\/]`)).join('|');
  return text.replace(new RegExp(`${BEFORE_HOME}(?:${pattern})${AFTER_HOME}`, isWindows ? 'giu' : 'gu'), '~');
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

// ---- Text an agent posts ----
//
// Text an agent posts (#391). An issue, a pull request, a comment or a release note is
// public the moment it is sent, so the tool-call guard runs the privacy check on it first:
// the same patterns, private marks and secrets as the commit check, with the same fixes.
//
// It reads the text the command carries: `--title`, `--body`, `--notes` and their short
// forms, the fields of an API call (`gh` `api -f body=...`), and the files that
// `--body-file`, `--notes-file`, `-F key=@file` and `--input` name. A body read from
// stdin (`-`) is not a file: the guard scans the whole command text instead, so a heredoc
// fed to it is checked too. Text the command builds when it runs (`$(cat notes.md)`, a
// variable, a pipe from another program) is not seen.

/** One piece of text the command posts: where it comes from, and the text. */
interface Piece {
  /** How the message names it: `the --body text`, or a file's path. */
  source: string;
  /** Whether `source` is a file, so the finding gives it as `file:line`. */
  isFile: boolean;
  text: string;
}

// The gh commands that post text, by group and subcommand.
const POSTS: Record<string, string[]> = {
  issue: ['create', 'comment', 'edit'],
  pr: ['create', 'comment', 'edit', 'review'],
  release: ['create', 'edit'],
};

// gh options that hold text to post, and those that name a file of it. `-F` is a file in
// every one of these commands (`--body-file`, or `--notes-file` for a release).
const TEXT_OPTIONS = new Set(['--title', '-t', '--body', '-b', '--notes', '-n']);
const FILE_OPTIONS = new Set(['--body-file', '--notes-file', '-F']);
// The api subcommand: each field is key=value; `-F key=@file` reads a file, and `--input` sends one.
const FIELD_OPTIONS = new Set(['-f', '--raw-field', '-F', '--field']);
// gh's global option that takes a value before the subcommand: `gh -R o/r issue create`.
const GLOBAL_VALUES = new Set(['-R', '--repo']);

const programName = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).replace(/\.exe$/i, '');
const isYokoten = (name: string) => /^yokoten(\.ts|\.js)?$/.test(name);

/**
 * Where gh starts in a command's words, or -1. `programs` are the programs the command
 * runs (the guard's findPrograms): gh itself, or yokoten (or node) running `bot -- gh`.
 */
export function ghIndex(words: string[], programs: string[]): number {
  for (const program of programs) {
    const name = programName(program);
    const at = words.indexOf(program);
    if (name === 'gh') return at;
    if (isYokoten(name) || name === 'node' || name === 'npx') {
      const bot = words.indexOf('bot', at);
      if (bot !== -1 && words[bot + 1] === '--' && programName(words[bot + 2] ?? '') === 'gh') return bot + 2;
    }
  }
  return -1;
}

/** An option and its value: `--body x`, `--body=x`, `-bx`. Null when `word` is not one of `names`. */
function optionValue(words: string[], i: number, names: Set<string>): { value: string | undefined; name: string; next: number } | null {
  const word = words[i];
  const eq = word.indexOf('=');
  if (word.startsWith('--') && eq !== -1 && names.has(word.slice(0, eq))) return { name: word.slice(0, eq), value: word.slice(eq + 1), next: i + 1 };
  if (names.has(word)) return { name: word, value: words[i + 1], next: i + 2 };
  // A short option with its value joined on: `-bx`, `-b=x`.
  if (/^-[A-Za-z]./.test(word) && names.has(word.slice(0, 2))) return { name: word.slice(0, 2), value: word.slice(2).replace(/^=/, ''), next: i + 1 };
  return null;
}

/** The text pieces a gh command posts, or null when it posts nothing. `stdin` is set when a piece comes from stdin. */
function postedPieces(args: string[], readFile: (path: string) => string | null): { pieces: Piece[]; stdin: boolean } | null {
  // The group and its subcommand: the first two words that are not options.
  const plain: string[] = [];
  for (let i = 0; i < args.length && plain.length < 2; i++) {
    if (GLOBAL_VALUES.has(args[i])) i++;
    else if (!args[i].startsWith('-')) plain.push(args[i]);
  }
  const [group, sub] = plain;
  const isApi = group === 'api';
  if (!isApi && !POSTS[group]?.includes(sub)) return null;
  const pieces: Piece[] = [];
  let stdin = false;
  const addFile = (path: string | undefined) => {
    if (path === undefined) return;
    if (path === '-') {
      stdin = true;
      return;
    }
    const text = readFile(path);
    if (text !== null) pieces.push({ source: path, isFile: true, text });
  };
  for (let index = 0; index < args.length; ) {
    if (isApi) {
      const input = optionValue(args, index, new Set(['--input']));
      if (input) {
        addFile(input.value);
        index = input.next;
        continue;
      }
      const field = optionValue(args, index, FIELD_OPTIONS);
      if (field) {
        const value = field.value ?? '';
        const eq = value.indexOf('=');
        const key = eq === -1 ? value : value.slice(0, eq);
        const content = eq === -1 ? '' : value.slice(eq + 1);
        // `-F key=@file` reads the file; `-f` always takes the text as it is.
        if ((field.name === '-F' || field.name === '--field') && content.startsWith('@')) addFile(content.slice(1));
        else if (content) pieces.push({ source: `the ${key} field`, isFile: false, text: content });
        index = field.next;
        continue;
      }
    } else {
      const file = optionValue(args, index, FILE_OPTIONS);
      if (file) {
        addFile(file.value);
        index = file.next;
        continue;
      }
      const text = optionValue(args, index, TEXT_OPTIONS);
      if (text) {
        if (text.value) pieces.push({ source: `the ${text.name} text`, isFile: false, text: text.value });
        index = text.next;
        continue;
      }
    }
    index++;
  }
  return { pieces, stdin };
}

// The commit check's reasons end on what git does; a post is public as soon as it is sent.
const postWhy = (why: string) => why.replace(/, and git keeps it after the file is gone$/, '').replace('read the repo', 'read it').concat(', and a post is public the moment it is sent');

// The commit check's fix, and for an address the way to let a public one through.
const ALLOW_FIX = 'If it is public on purpose, add it to "privacy.allow" in yokoten.json';
const postFix = (f: Finding) =>
  f.id === 'email' || f.id === 'ip' ? `${f.fix}. ${ALLOW_FIX}` : f.id === 'secret' ? 'take it out of the text, and rotate it if it was ever sent' : f.fix;

/**
 * The first privacy problem in the text a gh command (from `ghAt` in `words`) is about to
 * post, or null. `command` is the whole command text, scanned when a body comes from stdin.
 * `cwd` is where the command runs, for a relative file; null when the guard cannot tell.
 */
export function checkPost(
  words: string[],
  ghAt: number,
  { env, privacy, cwd, command }: { env: Env; privacy?: Pick<Config['privacy'], 'allow'>; cwd: string | null; command: string },
): Finding | null {
  const readFile = (path: string): string | null => {
    const home = env.HOME;
    const full = path.startsWith('~/') && home ? join(home, path.slice(2)) : path;
    if (!isAbsolute(full) && cwd === null) return null;
    try {
      return readFileSync(resolve(cwd ?? '', full), 'utf8');
    } catch {
      // A missing file: gh fails on its own, and nothing is posted.
      return null;
    }
  };
  const posted = postedPieces(words.slice(ghAt + 1), readFile);
  if (!posted) return null;
  const { pieces } = posted;
  if (posted.stdin) pieces.push({ source: 'the command text (its body comes from stdin)', isFile: false, text: command });
  if (!pieces.length) return null;
  const marks = loadMarks(env);
  const allow = privacy?.allow ?? [];
  for (const piece of pieces) {
    const [hit] = scanText(piece.text, { file: piece.source, marks, allow });
    if (!hit) continue;
    const more = { why: postWhy(hit.why) };
    if (piece.isFile) return finding(hit.id as RuleId, hit.what, postFix(hit), { ...more, file: piece.source, line: hit.line });
    const line = piece.text.includes('\n') ? `, line ${hit.line},` : '';
    const what = hit.id === 'private-mark' ? `${piece.source}${line} ${hit.what}` : `${piece.source}${line} holds ${hit.what}`;
    return finding(hit.id as RuleId, what, postFix(hit), more);
  }
  return null;
}
