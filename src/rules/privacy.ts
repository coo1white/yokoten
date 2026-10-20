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

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { Config, Env } from './config.ts';
import { type Finding, finding, type RuleId } from './message.ts';
import { findSecrets, makeSecretHider, SECRET } from './secrets.ts';

/** Where the system says the home folder is, with no $HOME: the password file. Empty when it can't tell. */
export const systemHome = (): string => {
  try {
    return homedir() || userInfo().homedir || '';
  } catch {
    return '';
  }
};

/**
 * The home folder: $HOME, else the system's, the first that is an absolute path. Null when
 * neither is (#392): then there is no place outside the repo, and a relative `.config`
 * would land in the folder the command runs in.
 */
export function homeOf(env: Env, system: () => string = systemHome): string | null {
  for (const home of [env.HOME, system()]) if (home && isAbsolute(home)) return home;
  return null;
}

/** Thrown when there is no home folder, so nothing outside the repo can be read or written. */
export const NO_HOME = 'yokoten finds no home folder (HOME is empty or not a full path), so it has no place outside the repo';

/** The private-marks file. With no home folder (and no YOKOTEN_PRIVATE_MARKS), it throws NO_HOME. */
export function marksFile(env: Env): string {
  if (env.YOKOTEN_PRIVATE_MARKS) return env.YOKOTEN_PRIVATE_MARKS;
  const home = homeOf(env);
  if (!home) throw new Error(NO_HOME);
  return join(home, '.config', 'yokoten', 'private-marks');
}

/** The owner's marks, lowercased. An empty list when the file is missing. */
export function loadMarks(env: Env): string[] {
  let text = '';
  try {
    text = readFileSync(marksFile(env), 'utf8');
  } catch (err) {
    if ((err as Error).message === NO_HOME) return [];
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.toLowerCase());
}

/** The comment above the marks yokoten adds from this machine. They run to the next comment line. */
export const FOUND_HEADER = '# added by yokoten from this machine';

/** The comment above the marks yokoten adds of one kind: `# added by yokoten from this machine: forge login`. */
export const foundHeader = (kind: string): string => `${FOUND_HEADER}: ${kind}`;

/** One line of the private-marks file: the mark, lowercased, and the kind yokoten added it as, or null for one the owner wrote. */
export interface Mark {
  value: string;
  kind: string | null;
}

/**
 * The owner's marks with where each came from (#410). A mark under `# added by yokoten from
 * this machine: <kind>` has that kind. Under the plain header, which yokoten wrote before it
 * named the kind, the kind is read from the shape: an address is a git email, a domain a
 * remote host, anything else the forge login. Every other line is the owner's own: null.
 */
export function loadMarkKinds(env: Env): Mark[] {
  let text = '';
  try {
    text = readFileSync(marksFile(env), 'utf8');
  } catch (err) {
    if ((err as Error).message === NO_HOME) return [];
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const marks: Mark[] = [];
  let section: string | null = null;
  for (const line of text.split(/\r?\n/).map((part) => part.trim())) {
    if (line.startsWith('#')) {
      section = line === FOUND_HEADER ? '' : line.startsWith(`${FOUND_HEADER}: `) ? line.slice(FOUND_HEADER.length + 2).trim() : null;
      continue;
    }
    if (!line) continue;
    const value = line.toLowerCase();
    const kind = section === null ? null : section || (isEmailShaped(value) ? 'git email' : isDomainShaped(value) ? 'private remote host' : 'forge login');
    marks.push({ value, kind });
  }
  return marks;
}

/** The forge logins yokoten added to the marks, lowercased: the places that name accounts may hold them (#410). */
export const autoLogins = (marks: Mark[]): string[] => marks.filter((mark) => mark.kind === 'forge login').map((mark) => mark.value);

// ---- Where an added forge login is fine (#410) ----
//
// Some files exist to name an account: CODEOWNERS, the author of a package or plugin, the
// copyright line of a license. There the login yokoten added from this machine is not a
// leak. The place is told by the file's path and the line's shape alone: no git call.

const CODEOWNERS_FILE = /(^|\/)CODEOWNERS$/;
const GITHUB_FILE = /^\.github\//;
const LICENSE_FILE = /(^|\/)(LICEN[CS]E|COPYING)([.-][^/]*)?$/i;
const MANIFEST_FILE = /(^|\/)(package|plugin|marketplace)\.json$/;
const COPYRIGHT_LINE = /^\s*(copyright\b|\(c\)|©|spdx-filecopyrighttext:)/i;
// The manifest keys whose value names a person or an account.
const PERSON_KEYS = new Set(['author', 'authors', 'owner', 'owners', 'maintainer', 'maintainers', 'publisher']);
const KEY_LINE = /^\s*"([^"\\]+)"\s*:/;

/**
 * For each line of a JSON manifest, whether it sits in a person field: the line opens with
 * such a key, or it is inside the object or list such a key holds. A minified file is one
 * line that opens with `{`, so it never counts.
 */
function personLines(lines: string[]): boolean[] {
  const inside: boolean[] = [];
  const stack: boolean[] = [];
  const top = () => stack.length > 0 && stack[stack.length - 1];
  let isString = false;
  let isEscaped = false;
  let current = '';
  let lastString = '';
  let key: string | null = null;
  for (const line of lines) {
    const opens = KEY_LINE.exec(line)?.[1];
    inside.push(top() || (opens !== undefined && PERSON_KEYS.has(opens.toLowerCase())));
    for (const char of line) {
      if (isString) {
        if (isEscaped) isEscaped = false;
        else if (char === '\\') isEscaped = true;
        else if (char === '"') {
          isString = false;
          lastString = current;
        } else current += char;
      } else if (char === '"') {
        isString = true;
        current = '';
      } else if (char === ':') key = lastString;
      else if (char === '{' || char === '[') {
        stack.push(top() || (key !== null && PERSON_KEYS.has(key.toLowerCase())));
        key = null;
      } else if (char === '}' || char === ']') stack.pop();
      else if (char === ',') key = null;
    }
  }
  return inside;
}

/**
 * For a file with places that name accounts: a function that gives a lowercased line back
 * without the places where `login` is fine. Null when the file has no such place.
 */
function loginPlaces(file: string, lines: string[]): ((lower: string, index: number, login: string) => string) | null {
  const isMentions = CODEOWNERS_FILE.test(file) || GITHUB_FILE.test(file);
  const isLicense = LICENSE_FILE.test(file);
  const persons = MANIFEST_FILE.test(file) ? personLines(lines) : null;
  if (!isMentions && !isLicense && !persons) return null;
  return (lower, index, login) => {
    if (isLicense && COPYRIGHT_LINE.test(lower)) return '';
    if (persons?.[index]) return '';
    // `@login` and `@login/team`, but not the login in the domain of an email address.
    if (isMentions) return lower.replace(new RegExp(String.raw`(?<![\w.+-])@${escapeRegExp(login)}(?![\w-]|\.\w)`, 'g'), '');
    return lower;
  };
}

// A match starts only where a word starts, so a long run with no @ is read once, not once per letter.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A browser version in a user agent (Chrome/120.0.0.0) is not an address. Only the
// browser product names are skipped, case-sensitive as a user agent writes them: an
// address in a path (api/192.0.2.1) or a URL (http://192.0.2.1) is still caught.
// Only IPv4 is checked, private ranges included; IPv6 is not.
const BROWSER = 'Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS|Edge|OPR|Opera|Version|Firefox|FxiOS|Safari|AppleWebKit|Gecko|Mozilla|YaBrowser|SamsungBrowser|UCBrowser|Electron';
const IPV4 = new RegExp(`(?<![\\w.])(?<!\\b(?:${BROWSER})/)(?:\\d{1,3}\\.){3}\\d{1,3}(?![\\w.])`, 'g');

/** The public code hosts: a remote there names no private server. */
export const PUBLIC_FORGES = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'ssh.dev.azure.com', 'dev.azure.com'];
/** `text` with every regex special character escaped, for a pattern built from strings. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Addresses that point at no person. A personal address at the same domains
// (someone at gmail.com, or at github.com) is still caught.
const OK_EMAIL = [
  /@users\.noreply\.(github|gitlab)\.com$/i,
  // A team's inbox at a public service, quoted in a commit message or a doc.
  /^(noreply|no-reply|support|security|privacy|notifications)@(github\.com|gitlab\.com|bitbucket\.org|anthropic\.com|npmjs\.com)$/i,
  /@example\.(com|org|net)$/i,
  // Names reserved for tests, docs and local networks (RFC 2606, RFC 6762).
  /@[\w.-]+\.(test|example|invalid|localhost|local)$/i,
];
// An SSH remote (git@host:owner/repo) at a public forge. One at a private host is still
// caught: it names the host.
const isForgeRemote = (hit: string): boolean => hit.slice(0, 4).toLowerCase() === 'git@' && PUBLIC_FORGES.includes(hit.slice(4).toLowerCase());
// A retina image name (logo@2x.png) looks like an email address at the domain 2x.png.
const RETINA = /@\d+x\.(png|jpe?g|gif|webp|svg|avif)$/i;
// Localhost, "any", and the three ranges RFC 5737 keeps for documentation.
const OK_IP = [/^127\./, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];

/** Whether an address found in text may point at a person: not a noreply, team, example or retina name. */
export const isPersonalEmail = (hit: string, allow: string[] = []): boolean => !OK_EMAIL.some((re) => re.test(hit)) && !isForgeRemote(hit) && !RETINA.test(hit) && !allow.includes(hit);

/**
 * Problems in one file's text. `allow` holds literal strings the project has said are
 * fine (yokoten.json "privacy.allow"), such as a public support address.
 */
export function scanText(text: string, { file, marks = [], allow = [], logins = [] }: { file: string; marks?: string[]; allow?: string[]; logins?: string[] }): Finding[] {
  const problems: Finding[] = [];
  const lines = text.split('\n');
  // `logins`: the forge logins yokoten added to the marks, fine where a file names accounts (#410).
  const places = logins.length && marks.length ? loginPlaces(file, lines) : null;
  const secrets = findSecrets(lines, allow);
  lines.forEach((line, index) => {
    const where = { file, line: index + 1 };
    // The secret itself is never printed either, only its kind.
    for (const [at, kind] of secrets) if (at === index) problems.push(finding('secret', `a secret (${kind})`, 'remove it, rotate it, and keep it outside the repo', where));
    for (const [hit] of line.matchAll(EMAIL)) {
      if (isPersonalEmail(hit, allow)) {
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
      if (!lower.includes(mark)) continue;
      if (places && logins.includes(mark) && !places(lower, index, mark).includes(mark)) continue;
      problems.push(finding('private-mark', 'matches a line of your private-marks file', 'remove it or reword the line; the mark itself is never printed', where));
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
 * The starts of a home path that a line cut short may leave: the parent folder and 4 or
 * more characters of the last part, but not all of it (#404). Empty when the last part is
 * 4 characters or fewer.
 */
function cutForms(home: string): string[] {
  const split = Math.max(home.lastIndexOf('/'), home.lastIndexOf('\\'));
  const last = home.slice(split + 1);
  const forms: string[] = [];
  for (let length = 4; length < last.length; length++) forms.push(home.slice(0, split + 1 + length));
  return forms;
}

/**
 * Text as yokoten may show it: the home folder, which names the machine's user, becomes
 * `~`. Everything yokoten prints passes through this. Both homes are hidden: $HOME and the
 * system's (they differ under sudo, in CI, or with HOME=/tmp/x), each also by its real path
 * (on macOS a temp or home folder resolves to /private/...). A home is replaced only where
 * its path ends, so /data/u never touches /data/users. On Windows `\` and `/` match each
 * other, and case does not count. A home path cut short at the end of a line or the text
 * (`/home/jonat`) becomes `~` too, when it keeps 4 or more characters of the last part (#404).
 */
export function hideHome(text: string, env: Env, { platform = process.platform as string, systemHome: system = systemHome() } = {}): string {
  const homes = [...new Set([...homeForms(env.HOME), ...homeForms(system)])].sort((a, b) => b.length - a.length);
  if (!homes.length) return text;
  const isWindows = platform === 'win32';
  const asPattern = (paths: string[]) => paths.map((home) => escapeRegExp(home).replace(/\\\\|\//g, String.raw`[\\/]`)).join('|');
  const flags = isWindows ? 'giu' : 'gu';
  const whole = text.replace(new RegExp(`${BEFORE_HOME}(?:${asPattern(homes)})${AFTER_HOME}`, flags), '~');
  const cuts = [...new Set(homes.flatMap(cutForms))].sort((a, b) => b.length - a.length);
  return cuts.length ? whole.replace(new RegExp(`${BEFORE_HOME}(?:${asPattern(cuts)})(?=\r?$)`, `${flags}m`), '~') : whole;
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

// ---- Hiding the owner in command output (#390) ----
//
// Once a command's output reaches an agent, it is in the transcript and sent to the model;
// it can't be taken back. So the tool-call hook pipes the commands known to print account
// details through `yokoten redact`, which puts a placeholder in place of each value.

/** The placeholders `redact` writes. A placeholder never names what it hides. */
export const PLACEHOLDERS = { owner: '<owner>', project: '<project>', email: '<email>', host: '<host>', mark: '<mark>', secret: SECRET } as const;

const isEmailShaped = (value: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value);
/** A domain or host name: words joined by dots, ending in a top-level name. */
export const isDomainShaped = (value: string): boolean => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value);

/** What `redact` hides beyond the patterns. Each list may be empty: then only the patterns apply. */
export interface Hidden {
  /** Lines of the private-marks file. */
  marks?: string[];
  /** The owner's own names on this machine: git user.name, the forge login, the Linux and Windows user names. */
  owners?: string[];
  /** Hosts of remotes outside the public forges. */
  hosts?: string[];
  /** The names of the project at hand, for a note that leaves it (#392). */
  projects?: string[];
}

/** The placeholder for one mark, by its shape: an address, a host, or anything else. */
const markPlaceholder = (mark: string) => (isEmailShaped(mark) ? PLACEHOLDERS.email : isDomainShaped(mark) ? PLACEHOLDERS.host : PLACEHOLDERS.mark);

/**
 * One value as a pattern. Where the value starts or ends with a letter or digit, the
 * text next to it must not be one, so a mark `ann` leaves `annual` alone. A value in a
 * script with no spaces between words (Chinese, Japanese) has no such edge.
 */
function valuePattern(value: string): string {
  const escaped = escapeRegExp(value);
  const before = /^[A-Za-z0-9]/.test(value) ? String.raw`(?<![\p{L}\p{N}])` : '';
  const after = /[A-Za-z0-9]$/.test(value) ? String.raw`(?![\p{L}\p{N}])` : '';
  return `${before}${escaped}${after}`;
}

/**
 * A function that hides the owner in text read in pieces, in order: secrets (the same
 * patterns as the privacy check), private email addresses, the home folder, then every
 * value in `hidden` as a whole word. The home goes before the names, so `/home/<name>/x`
 * becomes `~/x` (#404). Case does not count. Line ends are kept.
 */
export function makeRedactor(hidden: Hidden, env: Env): (text: string) => string {
  const placeholderOf = new Map<string, string>();
  const add = (value: string, placeholder: string) => {
    const key = value.trim().toLowerCase();
    // One or two Latin letters would hide half the output, and say little about anyone.
    // Two characters in Chinese or Japanese can be a whole name or city.
    const isTooShort = key.length < 3 && /^[\x20-\x7e]*$/.test(key);
    if (key && !isTooShort && !placeholderOf.has(key)) placeholderOf.set(key, placeholder);
  };
  for (const owner of hidden.owners ?? []) add(owner, isEmailShaped(owner) ? PLACEHOLDERS.email : PLACEHOLDERS.owner);
  for (const host of hidden.hosts ?? []) add(host, PLACEHOLDERS.host);
  for (const project of hidden.projects ?? []) add(project, PLACEHOLDERS.project);
  for (const mark of hidden.marks ?? []) add(mark, markPlaceholder(mark));
  // The longest first, so `jane doe` goes before `jane`.
  const values = [...placeholderOf.keys()].sort((a, b) => b.length - a.length);
  const pattern = values.length ? new RegExp(values.map(valuePattern).join('|'), 'giu') : null;
  const hideSecrets = makeSecretHider();
  return (text) => {
    // An SSH remote at a private host (git@host) names the host, not a person.
    let out = hideSecrets(text).replace(EMAIL, (hit) => (!isPersonalEmail(hit) ? hit : /^git@/i.test(hit) ? `git@${PLACEHOLDERS.host}` : PLACEHOLDERS.email));
    out = hideHome(out, env);
    return pattern ? out.replace(pattern, (hit) => placeholderOf.get(hit.toLowerCase()) ?? PLACEHOLDERS.mark) : out;
  };
}

/**
 * The hosts in remote URLs that are not public forges: `https://host/x`, `ssh://user@host:22/x`,
 * `git@host:x`. A local path names no host.
 */
export function privateRemoteHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    const host = (/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url) ?? /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)/.exec(url))?.[1]?.toLowerCase();
    if (host && host !== 'localhost' && !/^[a-z]$/i.test(host) && !PUBLIC_FORGES.includes(host)) hosts.add(host);
  }
  return [...hosts];
}

// ---- Text an agent posts (#391) ----
//
// An issue, a pull request, a comment or a release note is public the moment it is sent,
// so the tool-call guard runs the privacy check on it first: the same patterns, private
// marks and secrets as the commit check, with the same fixes.
//
// It reads the text the command carries: `--title`, `--body`, `--notes`, `--comment`,
// `--subject` and their short forms, and the files `--body-file`, `--notes-file` and `-F`
// name. For an API call it reads the fields and the `--input` file, but only on a call
// that writes: a POST, PATCH or PUT, fields sent with no method to an issue, pull request,
// comment, release or discussion path, or a GraphQL mutation. A body from stdin is read
// from a heredoc, a here-string or a `< file` redirect. Text the command builds when it
// runs (`$(cat notes.md)`, a variable, a pipe from another program) is not seen.
//
// A file is read only when it is a regular file of at most 1 MB; another one (a device, a
// pipe, a large file) is let through unread. A relative file the guard can't place (after
// `cd "$X"`), or one that is missing, stops the command: an unread body would go out unchecked.

/** One piece of text the command posts: where it comes from, and the text. */
interface Piece {
  /** How the message names it: `the --body text`, or a file's path. */
  source: string;
  /** Whether `source` is a file, so the finding gives it as `file:line`. */
  isFile: boolean;
  text: string;
}

/** A gh command as the guard hands it over: its words after `gh`, without redirects, and what its stdin is. */
export interface GhCommand {
  args: string[];
  /** The file a `< file` redirect feeds to stdin. */
  stdinFile?: string;
  /** The text a `<<<` here-string feeds to stdin. */
  hereString?: string;
}

// The gh commands that post text, by group and subcommand (`new` is gh's alias for `create`).
const POSTS: Record<string, string[]> = {
  issue: ['create', 'new', 'comment', 'edit', 'close'],
  pr: ['create', 'new', 'comment', 'edit', 'review', 'merge', 'close'],
  release: ['create', 'new', 'edit'],
};

// gh options that hold text to post, and those that name a file of it. `-F` is a file in
// every one of these commands (`--body-file`, or `--notes-file` for a release).
const TEXT_OPTIONS = new Set(['--title', '-t', '--body', '-b', '--notes', '-n', '--subject']);
// `close` takes a comment as text; in `pr review`, `--comment` is a switch.
const CLOSE_OPTIONS = new Set([...TEXT_OPTIONS, '--comment', '-c']);
const FILE_OPTIONS = new Set(['--body-file', '--notes-file', '-F']);
// The api subcommand: each field is key=value; `-F key=@file` reads a file, and `--input` sends one.
const FIELD_OPTIONS = new Set(['-f', '--raw-field', '-F', '--field']);
const METHOD_OPTIONS = new Set(['-X', '--method']);
const INPUT_OPTIONS = new Set(['--input']);
// gh's global option that takes a value before the subcommand: `gh -R o/r issue create`.
const GLOBAL_VALUES = new Set(['-R', '--repo']);
// A path that fields with no method write to (gh then sends a POST). A search reads.
const WRITE_PATH = /(^|\/)(issues|pulls|comments|releases|discussions)(\/|$|\?)/;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT']);
// A GraphQL document that changes something: comments first, then `mutation`.
const MUTATION = /^\s*(?:#[^\n]*\n\s*)*mutation\b/;
// The largest file the guard reads.
const MAX_FILE_BYTES = 1024 * 1024;

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
function optionValue(words: string[], index: number, names: Set<string>): { value: string | undefined; name: string; next: number } | null {
  const word = words[index];
  const equals = word.indexOf('=');
  if (word.startsWith('--') && equals !== -1 && names.has(word.slice(0, equals))) return { name: word.slice(0, equals), value: word.slice(equals + 1), next: index + 1 };
  if (names.has(word)) return { name: word, value: words[index + 1], next: index + 2 };
  // A short option with its value joined on: `-bx`, `-b=x`.
  if (/^-[A-Za-z]./.test(word) && names.has(word.slice(0, 2))) return { name: word.slice(0, 2), value: word.slice(2).replace(/^=/, ''), next: index + 1 };
  return null;
}

/** The bodies of the heredocs in a command's text, in order. Quoting around `<<` is not read: a body found twice is scanned twice. */
export function heredocBodies(text: string): string[] {
  const bodies: string[] = [];
  const lines = text.split('\n');
  const waiting: { delimiter: string; strip: boolean }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (waiting.length) {
      const { delimiter, strip } = waiting.shift() as { delimiter: string; strip: boolean };
      const body: string[] = [];
      for (; index < lines.length; index++) {
        const candidate = strip ? lines[index].replace(/^\t+/, '') : lines[index];
        if (candidate === delimiter || candidate.trimEnd() === delimiter) break;
        body.push(lines[index]);
      }
      bodies.push(body.join('\n'));
      continue;
    }
    for (const match of line.matchAll(/(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/g)) waiting.push({ delimiter: match[3], strip: match[1] === '-' });
  }
  return bodies;
}

/** A file's text, `skip` for a file the guard does not read, or `missing`. */
type FileRead = { text: string } | 'skip' | 'missing';

/** What a gh command posts: its pieces, or a file the guard can't find. Null when it posts nothing. */
function postedPieces(gh: GhCommand, readFile: (path: string) => FileRead, command: string): { pieces: Piece[] } | { missing: string } | null {
  const { args } = gh;
  // The group and its subcommand: the first two words that are not options.
  const plain: string[] = [];
  for (let index = 0; index < args.length && plain.length < 2; index++) {
    if (GLOBAL_VALUES.has(args[index])) index++;
    else if (!args[index].startsWith('-')) plain.push(args[index]);
  }
  const [group, sub] = plain;
  const isApi = group === 'api';
  if (!isApi && !POSTS[group]?.includes(sub)) return null;
  const pieces: Piece[] = [];
  let missing: string | null = null;
  let method: string | null = null;
  let hasFields = false;
  let query: string | null = null;
  const addFile = (option: string, path: string | undefined, key?: string) => {
    if (path === undefined) return;
    if (path === '-') {
      // stdin: a here-string, a `< file`, or the heredocs in the command.
      if (gh.hereString !== undefined) pieces.push({ source: 'the here-string text', isFile: false, text: gh.hereString });
      else if (gh.stdinFile !== undefined) addFile('<', gh.stdinFile, key);
      else for (const body of heredocBodies(command)) pieces.push({ source: 'the heredoc text', isFile: false, text: body });
      if (key === 'query') query = [gh.hereString, ...heredocBodies(command)].filter((text) => text !== undefined).join('\n');
      return;
    }
    const read = readFile(path);
    if (read === 'missing') missing ??= option;
    else if (read !== 'skip') {
      pieces.push({ source: path, isFile: true, text: read.text });
      if (key === 'query') query = read.text;
    }
  };
  for (let index = 0; index < args.length; ) {
    if (isApi) {
      const methodOption = optionValue(args, index, METHOD_OPTIONS);
      if (methodOption) {
        method = (methodOption.value ?? '').toUpperCase();
        index = methodOption.next;
        continue;
      }
      const input = optionValue(args, index, INPUT_OPTIONS);
      if (input) {
        hasFields = true;
        addFile(input.name, input.value);
        index = input.next;
        continue;
      }
      const field = optionValue(args, index, FIELD_OPTIONS);
      if (field) {
        hasFields = true;
        const value = field.value ?? '';
        const equals = value.indexOf('=');
        const key = equals === -1 ? value : value.slice(0, equals);
        const content = equals === -1 ? '' : value.slice(equals + 1);
        // `-F key=@file` reads the file; `-f` always takes the text as it is.
        if ((field.name === '-F' || field.name === '--field') && content.startsWith('@')) addFile(field.name, content.slice(1), key);
        else if (content) {
          pieces.push({ source: `the ${key} field`, isFile: false, text: content });
          if (key === 'query') query = content;
        }
        index = field.next;
        continue;
      }
    } else {
      const file = optionValue(args, index, FILE_OPTIONS);
      if (file) {
        addFile(file.name, file.value);
        index = file.next;
        continue;
      }
      const text = optionValue(args, index, sub === 'close' ? CLOSE_OPTIONS : TEXT_OPTIONS);
      if (text) {
        if (text.value) pieces.push({ source: `the ${text.name} text`, isFile: false, text: text.value });
        index = text.next;
        continue;
      }
    }
    index++;
  }
  if (isApi && !apiWrites(apiPath(args.slice(args.indexOf('api') + 1)), method, hasFields, query)) return null;
  return missing === null ? { pieces } : { missing };
}

// The options of the api subcommand that take a value (gh 2.102 help).
const API_VALUES = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

/** The path an API call names: its first word that is not an option or an option's value. */
function apiPath(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    if (API_VALUES.has(args[index])) index++;
    else if (!args[index].startsWith('-')) return args[index];
  }
  return '';
}

/** Whether an API call writes: only then is what it sends posted. */
function apiWrites(path: string, method: string | null, hasFields: boolean, query: string | null): boolean {
  if (path.replace(/^\//, '') === 'graphql') return query !== null && MUTATION.test(query);
  if (method) return WRITE_METHODS.has(method);
  const plain = path.replace(/^\//, '');
  return hasFields && !plain.startsWith('search/') && WRITE_PATH.test(plain);
}

// The commit check's reasons end on what git does; a post is public as soon as it is sent.
const postWhy = (why: string) => why.replace(/, and git keeps it after the file is gone$/, '').replace('read the repo', 'read it').concat(', and a post is public the moment it is sent');

// The commit check's fix, and for an address the way to let a public one through.
const ALLOW_FIX = 'If it is public on purpose, add it to "privacy.allow" in yokoten.json';
const postFix = (f: Finding) =>
  f.id === 'email' || f.id === 'ip' ? `${f.fix}. ${ALLOW_FIX}` : f.id === 'secret' ? 'take it out of the text, and rotate it if it was ever sent' : f.fix;

/** A file's path as a finding may show it: home as `~`, and only its name, or no name, when the path holds a mark. */
function shownPath(path: string, env: Env, marks: string[]): string {
  const hasMark = (text: string) => marks.some((mark) => text.toLowerCase().includes(mark));
  const shown = hideHome(path, env);
  if (!hasMark(shown)) return shown;
  const name = basename(shown);
  return hasMark(name) ? 'the body file' : name;
}

/**
 * The first privacy problem in the text a gh command is about to post, or null. `command`
 * is the whole command text, for the heredocs that feed stdin. `cwd` is where the command
 * runs, for a relative file; null when the guard cannot tell.
 */
export function checkPost(gh: GhCommand, { env, privacy, cwd, command }: { env: Env; privacy?: Pick<Config['privacy'], 'allow'>; cwd: string | null; command: string }): Finding | null {
  const readFile = (path: string): FileRead => {
    const home = env.HOME;
    const full = path.startsWith('~/') && home ? join(home, path.slice(2)) : path;
    if (!isAbsolute(full) && cwd === null) return 'missing';
    const at = resolve(cwd ?? '', full);
    try {
      const stat = statSync(at);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return 'skip';
      return { text: readFileSync(at, 'utf8') };
    } catch {
      return 'missing';
    }
  };
  const posted = postedPieces(gh, readFile, command);
  if (!posted) return null;
  if ('missing' in posted) {
    return finding('unreadable-command', `yokoten can't find the file after ${posted.missing} to check it`, 'give its full path', {
      why: 'the privacy check reads a body before it is posted, and an unread one could hold anything',
    });
  }
  if (!posted.pieces.length) return null;
  const marks = loadMarks(env);
  const allow = privacy?.allow ?? [];
  for (const piece of posted.pieces) {
    const [hit] = scanText(piece.text, { file: piece.source, marks, allow });
    if (!hit) continue;
    const more = { why: postWhy(hit.why) };
    if (piece.isFile) return finding(hit.id as RuleId, hit.what, postFix(hit), { ...more, file: shownPath(piece.source, env, marks), line: hit.line });
    const line = piece.text.includes('\n') ? `, line ${hit.line},` : '';
    const what = hit.id === 'private-mark' ? `${piece.source}${line} ${hit.what}` : `${piece.source}${line} holds ${hit.what}`;
    return finding(hit.id as RuleId, what, postFix(hit), more);
  }
  return null;
}
