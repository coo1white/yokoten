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

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
 * The home folder: $HOME when it is an absolute path. Null when it is not (#392): then there
 * is no place outside the repo, and a relative `.config` would land in the folder the
 * command runs in. Only the CLI's entry falls back to the system's home (withHome), so an
 * env without HOME, as a test passes, never reaches the real home folder (#356).
 */
export function homeOf(env: Env): string | null {
  return env.HOME && isAbsolute(env.HOME) ? env.HOME : null;
}

/** The home folder, as homeOf finds it. With none, it throws NO_HOME. */
export function homeIn(env: Env): string {
  const home = homeOf(env);
  if (!home) throw new Error(NO_HOME);
  return home;
}

/**
 * The CLI's environment: `env` with HOME from the system when HOME is empty or not a full
 * path (#392). The one place yokoten falls back to the system's home (#356); everything
 * else reads HOME from the env it is given.
 */
export function withHome(env: Env, system: () => string = systemHome): Env {
  if (homeOf(env)) return env;
  const home = system();
  return home && isAbsolute(home) ? { ...env, HOME: home } : env;
}

/** Thrown when there is no home folder, so nothing outside the repo can be read or written. */
export const NO_HOME = 'yokoten finds no home folder (HOME is empty or not a full path), so it has no place outside the repo';

/** The private-marks file. With no home folder (and no YOKOTEN_PRIVATE_MARKS), it throws NO_HOME. */
export function marksFile(env: Env): string {
  if (env.YOKOTEN_PRIVATE_MARKS) return env.YOKOTEN_PRIVATE_MARKS;
  return join(homeIn(env), '.config', 'yokoten', 'private-marks');
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

/**
 * The marks a project allows in its own repo (#424): those its yokoten.json "privacy.allow"
 * lists as the same string, case aside. Never a part: allowing `foo` does not allow `foobar`.
 */
export function ownMarks(marks: string[], allow: string[] = []): string[] {
  const allowed = new Set(allow.map((entry) => entry.toLowerCase()));
  return marks.filter((mark) => allowed.has(mark.toLowerCase()));
}

// ---- The machine's allow, for one repo (#447) ----
// A repo with no yokoten.json, or one that must not name yokoten in public, can't use
// "privacy.allow". The same allow is then kept on this machine, beside the marks file, for
// one repo: the one whose origin remote an entry names. It allows marks only, never an
// address or a secret, and it never makes a repo count as one with yokoten.json. A repo with
// no origin gets none. Unsure allows nothing: git can't read the repo; it has a remote other
// than origin, or gh or a push may go elsewhere (gh-resolved, remote.pushDefault,
// branch.*.pushRemote); origin has two addresses; the file can't be read; two entries match.

/** One repo's entry in the machine allow file: its normalized origin remote, and the marks allowed there. */
export interface AllowEntry {
  remote: string;
  allow: string[];
}

/** The repo, as the machine allow file names it. `local` when origin is a folder on this machine, not a host. */
export type RepoKey = { remote: string; local?: boolean };

/** The machine allow file: beside the private-marks file. With no home folder, it throws NO_HOME. */
export const machineAllowFile = (env: Env): string => join(dirname(marksFile(env)), 'private-marks-allow.json');

/** The port each scheme uses when the URL names none: such a port is left out of the key. */
const DEFAULT_PORTS: Record<string, string> = { https: '443', http: '80', ssh: '22', 'git+ssh': '22', 'ssh+git': '22', git: '9418' };

/** `text` without any of `chars` at its end. A loop, so it is linear on any input. */
function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

/** `text` without any of `chars` at its start. */
function trimStart(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text[start])) start++;
  return text.slice(start);
}

/** A path with no slash and no `.git` at its end. */
function withoutGit(path: string): string {
  const bare = trimEnd(path, '/\\');
  return trimEnd(bare.toLowerCase().endsWith('.git') ? bare.slice(0, -4) : bare, '/\\');
}

/** A local path as a key: absolute, links followed, against `base` when relative. Null for a relative one with no base. */
function localKey(path: string, base?: string): string | null {
  if (!path || (!isAbsolute(path) && !base)) return null;
  const full = resolve(base ?? '', path);
  // The deepest folder that exists, with links followed, then the rest: a link such as
  // macOS's /var gives one key whether or not the path exists yet.
  for (let head = full, rest = ''; ; rest = rest ? join(basename(head), rest) : basename(head), head = dirname(head)) {
    try {
      return rest ? join(realpathSync(head), rest) : realpathSync(head);
    } catch {
      if (dirname(head) === head) return full;
    }
  }
}

/**
 * An origin remote as the machine allow file keys it: host and path, with no scheme, no
 * user info and no `.git`. The host is lowercased and keeps a port other than its scheme's
 * default; the path keeps its case. `git@host:path` and `ssh://host/path` give the same
 * key, as the forges treat them. A local path (or `file://`) becomes its absolute real path,
 * a relative one against `base`, the repo's top folder. Null when it can't be read.
 */
export function normalizeRemote(url: string, base?: string): string | null {
  const split = splitRemote(url);
  if (!split) return null;
  return 'local' in split ? localKey(split.local, base) : hostKey(split.host, split.path);
}

/** A remote as a host and its path, or as a local path. Null when it is empty. */
function splitRemote(url: string): { host: string; path: string } | { local: string } | null {
  const text = url.trim();
  if (!text || REMOTE_HELPER.test(text)) return null;
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (scheme) {
    const kind = scheme[1].toLowerCase();
    const rest = scheme[2];
    const slash = rest.indexOf('/');
    const path = slash === -1 ? '' : rest.slice(slash);
    if (kind === 'file') return { local: path };
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const colon = hostPort.lastIndexOf(':');
    const hasPort = colon !== -1 && !hostPort.endsWith(']');
    const host = hasPort ? hostPort.slice(0, colon) : hostPort;
    const port = hasPort ? hostPort.slice(colon + 1) : '';
    return { host: port && port !== DEFAULT_PORTS[kind] ? `${host}:${port}` : host, path };
  }
  // scp-like `user@host:path`. A path that starts with `/` or `.`, or a Windows drive, is local.
  if (!/^[a-z]:[\\/]/i.test(text) && !/^[/.\\]/.test(text)) {
    const scp = text.match(/^(?:[^@/]+@)?(\[[^\]/]*\]|[^:/]+):(.*)$/);
    if (scp) return { host: scp[1], path: scp[2] };
  }
  return { local: text };
}

// `ext::`, `gcrypt::` and any other `<transport>::<address>`: git hands it to a remote helper, which may read it any way.
const REMOTE_HELPER = /^[A-Za-z][\w+.-]*::/;

// A host on this machine: localhost, 127.x.x.x or ::1, with or without a port. It counts as a local folder.
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(?::\d+)?$/i;

/**
 * Why yokoten can't be sure which repo an origin address names, or null (#447). A `?` or
 * `#` may hide a part of the address from the key; a host's path must be just
 * `owner/name` (`.git` optional), or the last part may not be the repo's name.
 */
function unsureAddress(url: string): string | null {
  if (REMOTE_HELPER.test(url.trim())) return 'the origin remote runs a remote helper (transport::address)';
  if (/[?#]/.test(url)) return 'the origin remote\'s address has a ? or a #';
  const split = splitRemote(url);
  if (split && 'host' in split && !/^\/?[^/\\]+\/[^/\\]+$/.test(split.path)) return 'the origin remote\'s address is not just owner/name';
  return null;
}

function hostKey(host: string, path: string): string | null {
  const rest = trimStart(withoutGit(path), '/');
  return host && rest ? `${host.toLowerCase()}/${rest}` : null;
}

/** A remote key as stored, with its host lowercased, so a hand-edited case still matches. */
const storedRemote = (key: string): string => {
  const slash = key.indexOf('/');
  return slash <= 0 ? key : `${key.slice(0, slash).toLowerCase()}${key.slice(slash)}`;
};


/** What git says, trimmed, or the error with its exit status. */
function gitAnswer(dir: string, args: string[], env: Env): { out: string } | { status: number | null } {
  try {
    return { out: execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (err) {
    return { status: (err as { status?: number | null }).status ?? null };
  }
}

/** `url` rewritten by the longest prefix among `rules` (base → the prefixes it replaces), as git does; null when none applies. */
function rewriteUrl(url: string, rules: [string, string][]): string | null {
  let best: [string, string] | null = null;
  for (const [base, prefix] of rules) if (url.startsWith(prefix) && (!best || prefix.length > best[1].length)) best = [base, prefix];
  return best ? best[0] + url.slice(best[1].length) : null;
}

/** Why a repo gets no machine allow because it has no origin: not unsure, nothing to name it by. */
export const NO_ORIGIN = 'this repo has no origin remote';

/**
 * The repo at `dir`, as the machine allow file keys it, or why yokoten can't tell (#447).
 * Two git calls: the top folder, and the whole config in one read. origin must be the only
 * remote, with no gh default (gh-resolved) and no push default elsewhere. Its fetch and push
 * addresses, rewritten by insteadOf and pushInsteadOf as git does, must give one key.
 */
export function repoKey(dir: string, env: Env): RepoKey | { unsure: string } | { none: string } {
  const top = gitAnswer(dir, ['rev-parse', '--show-toplevel'], env);
  const topFolder = 'out' in top ? top.out.trim() : '';
  if (!topFolder) return { unsure: "git can't read this repo" };
  const listed = gitAnswer(dir, ['config', '--list', '-z'], env);
  if (!('out' in listed)) return { unsure: "git can't read this repo's settings" };
  const remotes = new Set<string>();
  const urls: string[] = [];
  const pushUrls: string[] = [];
  const insteadOf: [string, string][] = [];
  const pushInsteadOf: [string, string][] = [];
  let elsewhere: string | null = null;
  for (const entry of listed.out.split('\0')) {
    const cut = entry.indexOf('\n');
    const key = cut === -1 ? entry : entry.slice(0, cut);
    const value = cut === -1 ? '' : entry.slice(cut + 1);
    const lower = key.toLowerCase();
    if (lower === 'remote.pushdefault' || (lower.startsWith('branch.') && lower.endsWith('.pushremote'))) elsewhere = 'a push may go to another remote (remote.pushDefault or branch.*.pushRemote)';
    else if (lower.startsWith('remote.') && lower.endsWith('.gh-resolved')) elsewhere = 'gh is set to a repo of its own (gh repo set-default)';
    else if (lower.startsWith('remote.')) {
      const last = key.lastIndexOf('.');
      if (last > 7) remotes.add(key.slice(7, last));
      if (lower === 'remote.origin.url') urls.push(value);
      else if (lower === 'remote.origin.pushurl') pushUrls.push(value);
    } else if (lower.startsWith('url.') && lower.endsWith('.insteadof')) insteadOf.push([key.slice(4, -10), value]);
    else if (lower.startsWith('url.') && lower.endsWith('.pushinsteadof')) pushInsteadOf.push([key.slice(4, -14), value]);
  }
  if (elsewhere) return { unsure: elsewhere };
  if (!remotes.has('origin')) return remotes.size ? { unsure: 'this repo has a remote other than origin' } : { none: NO_ORIGIN };
  if (remotes.size > 1) return { unsure: 'this repo has a remote other than origin' };
  if (!urls.length) return { unsure: "the origin remote can't be read" };
  // Fetch addresses through insteadOf. A push goes to pushurl when set, else to the url through pushInsteadOf first.
  const fetch = urls.map((url) => rewriteUrl(url, insteadOf) ?? url);
  const push = pushUrls.length ? pushUrls.map((url) => rewriteUrl(url, insteadOf) ?? url) : urls.map((url) => rewriteUrl(url, pushInsteadOf) ?? rewriteUrl(url, insteadOf) ?? url);
  const all = [...fetch, ...push];
  for (const url of all) {
    const why = unsureAddress(url);
    if (why) return { unsure: why };
  }
  const base = localKey(topFolder) ?? topFolder;
  const keys = new Set(all.map((url) => normalizeRemote(url, base)));
  if (keys.has(null)) return { unsure: "the origin remote can't be read" };
  if (keys.size !== 1) return { unsure: 'the origin remote has more than one address' };
  const remote = [...keys][0] as string;
  const split = splitRemote(all[0]);
  return split && ('local' in split || LOOPBACK_HOST.test(split.host)) ? { remote, local: true } : { remote };
}

/** Why the machine allow file can't be used, in words that never quote it. */
export const ALLOW_FILE_UNREADABLE = "this machine's allow file can't be read";
export const ALLOW_FILE_SHAPE = "this machine's allow file is not in the shape yokoten writes";

/** The entries of the machine allow file: none when it is missing or there is no home folder. */
export function readMachineAllow(env: Env): { entries: AllowEntry[]; skipOwnName?: false } | { unsure: string } {
  let text: string;
  try {
    text = readFileSync(machineAllowFile(env), 'utf8');
  } catch (err) {
    if ((err as Error).message === NO_HOME) return { entries: [] };
    // Missing is none; a link to nothing is not missing: it can't be read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !isLink(machineAllowFile(env))) return { entries: [] };
    return { unsure: ALLOW_FILE_UNREADABLE };
  }
  let data: unknown;
  try {
    data = JSON.parse(text); // its error quotes the text, so it is never shown
  } catch {
    return { unsure: ALLOW_FILE_SHAPE };
  }
  const { repos, skipOwnName, ...other } = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const isEntry = (entry: unknown): entry is AllowEntry => {
    if (!entry || typeof entry !== 'object') return false;
    const { remote, allow, ...rest } = entry as Record<string, unknown>;
    return typeof remote === 'string' && remote !== '' && Array.isArray(allow) && allow.every((mark) => typeof mark === 'string') && !Object.keys(rest).length;
  };
  // `repos` may be missing, as in a file that holds just `{ "skipOwnName": false }`: no repos.
  const entries = repos === undefined ? [] : repos;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(entries) || !entries.every(isEntry)) return { unsure: ALLOW_FILE_SHAPE };
  if (Object.keys(other).length || (skipOwnName !== undefined && typeof skipOwnName !== 'boolean')) return { unsure: ALLOW_FILE_SHAPE };
  return skipOwnName === false ? { entries, skipOwnName } : { entries };
}

/** Whether `path` is a symbolic link, dangling or not. */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The entries that name this repo's remote. */
export function matchingEntries(entries: AllowEntry[], key: RepoKey): AllowEntry[] {
  return entries.filter((entry) => storedRemote(entry.remote) === key.remote);
}

/** What the machine allows in one repo: the entries' marks, lowercased, or nothing and why when unsure. */
export interface MachineAllowed {
  allow: string[];
  unsure: string | null;
}

/**
 * The marks this machine allows in the repo at `dir` (#447). Nothing, with no git call,
 * when the file is missing or empty. `dir` null (the guard can't tell where a command
 * runs) is unsure; a repo with no origin gets nothing, and is not unsure.
 */
export function machineAllowed(env: Env, dir: string | null, known?: ReturnType<typeof repoKey>): MachineAllowed {
  const read = readMachineAllow(env);
  if ('unsure' in read) return { allow: [], unsure: read.unsure };
  if (!read.entries.length) return { allow: [], unsure: null };
  if (dir === null) return { allow: [], unsure: "yokoten can't tell which repo this runs in" };
  const key = known ?? repoKey(dir, env);
  if ('unsure' in key) return { allow: [], unsure: key.unsure };
  if ('none' in key) return { allow: [], unsure: null };
  const found = matchingEntries(read.entries, key);
  if (found.length > 1) return { allow: [], unsure: "two entries in this machine's allow file match this repo" };
  return { allow: (found[0]?.allow ?? []).map((mark) => mark.toLowerCase()), unsure: null };
}

/**
 * A name as its words, so `Quiet Vale`, `quiet-vale`, `Quiet_Vale` and `quiet.vale` compare
 * equal: case aside, and each run of `-`, `_`, `.` and spaces one separator. A separator
 * is never taken out, so `Li Na` is not `lina`. Empty when the name has no letter or digit.
 */
const plainName = (name: string): string => (/[\p{L}\p{N}]/u.test(name) ? name.toLowerCase().replace(/[-_.\s]+/g, ' ') : '');

/**
 * The marks that are the name of the repo they run in, with no setup (#447, record 0014): a
 * mark that equals the name part of the repo (the last part of its origin remote, on a host,
 * as `owner/name`), case and separators aside (`plainName`). The whole name only, never a
 * part: `quiet vale` is the repo `quiet-vale`, not `quiet-vale-docs`. `repo` is what
 * `repoKey` said; unsure, no origin or a local folder as origin skip nothing.
 */
export function sameNameMarks(marks: string[], repo: ReturnType<typeof repoKey> | null): string[] {
  if (!repo || !('remote' in repo) || repo.local) return [];
  const name = plainName(repo.remote.split('/').pop() ?? '');
  return name ? marks.filter((mark) => plainName(mark) === name) : [];
}

/**
 * Whether a mark that names the repo is skipped there (#447, record 0014): on by default.
 * `"privacy": { "skipOwnName": false }` in yokoten.json turns it off for one repo, and
 * `"skipOwnName": false` in this machine's allow file for every repo here. An allow file
 * yokoten can't read turns it off too: unsure is never fine.
 */
export function skipsOwnName(env: Env, privacy?: Partial<Pick<Config['privacy'], 'skipOwnName'>>): boolean {
  if (privacy?.skipOwnName === false) return false;
  const read = readMachineAllow(env);
  return !('unsure' in read) && read.skipOwnName !== false;
}

/** The marks to look for in the repo at `root`: the owner's, less those the repo is named for and those the machine allows there (#447). */
export function repoMarkKinds(env: Env, root: string, privacy?: Partial<Pick<Config['privacy'], 'skipOwnName'>>): Mark[] {
  const kinds = loadMarkKinds(env);
  if (!kinds.length) return kinds;
  const values = kinds.map((mark) => mark.value);
  const key = repoKey(root, env);
  const named = skipsOwnName(env, privacy) ? sameNameMarks(values, key) : [];
  const own = new Set([...ownMarks(values, machineAllowed(env, root, key).allow), ...named]);
  return own.size ? kinds.filter((mark) => !own.has(mark.value)) : kinds;
}

/** The comment above the marks yokoten adds from this machine. They run to the next comment line. */
export const FOUND_HEADER = '# added by yokoten from this machine';

/** The comment above the marks yokoten adds of one kind: `# added by yokoten from this machine: forge login`. */
export const foundHeader = (kind: string): string => `${FOUND_HEADER}: ${kind}`;

/** The comment above marks yokoten moved out of an old block because it could not tell their kind: they count as the owner's. */
export const OWN_HEADER = '# your own marks';

/** One line of the private-marks file: the mark, lowercased, and the kind yokoten added it as, or null for one the owner wrote. */
export interface Mark {
  value: string;
  kind: string | null;
}

/**
 * The owner's marks with where each came from (#410). A mark under `# added by yokoten from
 * this machine: <kind>` has that kind. Under the plain header, which yokoten wrote before it
 * named the kind and which `fillMarks` rewrites, an address is a git email and a domain a
 * remote host. Anything else there, and every other line, is the owner's own: null. So a
 * bare host name is never taken for a login.
 */
export function loadMarkKinds(env: Env): Mark[] {
  let text = '';
  try {
    text = readFileSync(marksFile(env), 'utf8');
  } catch (err) {
    if ((err as Error).message === NO_HOME) return [];
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return markLines(text).flatMap((mark) => (mark ? [mark] : []));
}

/**
 * Each line of the private-marks text, as `loadMarkKinds` reads it: the mark with its kind,
 * or null for a comment or a blank line. `yokoten marks` uses it to remove lines by kind (#434).
 */
export function markLines(text: string): (Mark | null)[] {
  let section: string | null = null;
  return text.split('\n').map((raw) => {
    const line = raw.trim();
    if (line.startsWith('#')) {
      section = line === FOUND_HEADER ? '' : line.startsWith(`${FOUND_HEADER}: `) ? line.slice(FOUND_HEADER.length + 2).trim() : null;
      return null;
    }
    if (!line) return null;
    const value = line.toLowerCase();
    const kind = section === null ? null : section || (isEmailShaped(value) ? 'git email' : isDomainShaped(value) ? 'private remote host' : null);
    return { value, kind };
  });
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
function loginPlaces(file: string, lines: string[]): ((line: string, index: number, login: string) => string) | null {
  const isMentions = CODEOWNERS_FILE.test(file) || GITHUB_FILE.test(file);
  const isLicense = LICENSE_FILE.test(file);
  const persons = MANIFEST_FILE.test(file) ? personLines(lines) : null;
  if (!isMentions && !isLicense && !persons) return null;
  return (line, index, login) => {
    if (isLicense && COPYRIGHT_LINE.test(line)) return '';
    if (persons?.[index]) return '';
    // `@login` and `@login/team`, but not the login in the domain of an email address.
    if (isMentions) return line.replace(new RegExp(String.raw`(?<![\w.+-])@${escapeRegExp(login)}(?![\w-]|\.\w)`, 'gi'), '');
    return line;
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

// A dotted quad in a spec citation or a version is not an address (#382). The words next to
// it decide, read only around a hit, so a large file gets no extra pass:
// - before it: `§`, "section", "sec." or "sect.", "version", "ver." or "v", or a document
//   name: "MS-OVBA" or "[MS-OVBA]", "RFC 7230", "ECMA-376", "ISO 32000-1", "ISO/IEC 29500";
// - after it: a pre-release or build tag, `-beta` or `+build.5`. A `-` and a second address
//   is a range of addresses, and is caught;
// - a range joined by "to" or "through" whose first end is skipped by the words before it
//   ("MS-OVBA 2.3.1.15 to 2.3.1.17"): both ends are skipped;
// - a bare range that has the shape of section numbers ("2.3.1.15 to 2.3.1.17"): the first
//   number is 9 or less, every number is below 64, the ends differ only in the last number,
//   and the first end is not one number four times (as public resolvers are). Any other
//   range, private or public, is a range of addresses, and is caught.
// A bare address in prose ("connect to <address>") is still caught.
const QUAD = String.raw`\d{1,3}(?:\.\d{1,3}){3}`;
const SPEC_BEFORE = /(?:§|\b(?:section|sect?\.|version|ver\.|v)|(?:\bMS-[A-Z0-9-]+\]?|\bRFC\s?\d+|\bECMA-\d+|\bISO(?:\/IEC)?\s?\d+(?:-\d+)?)[,:]?)\s*$/i;
const TAG_AFTER = new RegExp(String.raw`^[-+](?!${QUAD})\w`);
const RANGE_BEFORE = new RegExp(String.raw`(?<![\w.])(${QUAD})\s+(?:to|through)\s+$`, 'i');
const RANGE_AFTER = new RegExp(String.raw`^\s+(?:to|through)\s+(${QUAD})(?![\w.])`, 'i');
/** Whether the words just before `index` in `line` cite a spec section or a version. */
const hasSpecBefore = (line: string, index: number): boolean => SPEC_BEFORE.test(line.slice(Math.max(0, index - 40), index));
/** Whether the range `first` to `last` has the shape of section numbers, not of addresses. */
function isSectionRange(first: string, last: string): boolean {
  const [a, b, c, d] = first.split('.').map(Number);
  const lastParts = last.split('.').map(Number);
  const isSmall = [a, b, c, d, ...lastParts].every((n) => n < 64);
  const isSamePrefix = lastParts[0] === a && lastParts[1] === b && lastParts[2] === c;
  const isRepeated = a === b && b === c && c === d;
  return a <= 9 && isSmall && isSamePrefix && !isRepeated;
}
/** Whether the dotted quad `hit`, found at `index` in `line`, is a section number or a version. */
function isSectionNumber(line: string, index: number, hit: string): boolean {
  const after = line.slice(index + hit.length, index + hit.length + 40);
  if (hasSpecBefore(line, index) || TAG_AFTER.test(after)) return true;
  const before = line.slice(Math.max(0, index - 40), index);
  const rangeStart = RANGE_BEFORE.exec(before);
  if (rangeStart) return hasSpecBefore(line, index - before.length + rangeStart.index) || isSectionRange(rangeStart[1], hit);
  const rangeEnd = RANGE_AFTER.exec(after);
  return rangeEnd !== null && isSectionRange(hit, rangeEnd[1]);
}

/** The email finding's fix. A project's own public address, such as support@ at its domain, is still found: the project lets it through (#380). */
export const EMAIL_FIX = 'use your GitHub noreply address, or a placeholder at example.com. If it is your project\'s own public address, such as support@ at its domain, add it to "privacy.allow" in yokoten.json';

/** Whether an address found in text may point at a person: not a noreply, team, example or retina name. */
export const isPersonalEmail = (hit: string, allow: string[] = []): boolean => !OK_EMAIL.some((re) => re.test(hit)) && !isForgeRemote(hit) && !RETINA.test(hit) && !allow.includes(hit);

// ---- How a mark is found in text (#434) ----
//
// A mark made of letters and spaces is a name or a place: it is found as whole words, so
// `sam` is not found in `sample`. Only a letter next to it blocks a match. A digit, `_`, `-`,
// `.`, `/`, `@`, a quote, a backslash escape (`\n`, `\u00e9`), a URL-encoded slash, backslash
// or space (`%2F`, `%5C`, `%20`) and a change from a small letter to a capital (`githubNick`,
// `NickDev`) are edges. The words of a longer mark may have any run of spaces, `.`, `_` or `-`
// between them, or none: `sam smith` is found in `samsmith` and `Sam_Smith`. Any other mark (a
// domain, an address, a number) is found as a part, and so is a name in a script that joins
// words or particles onto a name (Chinese, Japanese, Korean, Thai, Arabic, Hebrew). The check
// and `redact` build their patterns here, so they never disagree.

// A slash, a backslash or a space as a URL writes it (`%2F`, `%5C`, `%20`), in either case (#404).
const ENCODED_EDGE = '%(?:2[Ff]|5[Cc]|20)';
const NAME_SHAPED = /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u;
const JOINED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Arabic}\p{Script=Hebrew}]/u;
const LETTER = String.raw`[\p{L}\p{M}]`;
// What may sit right before a name: no letter, or a letter that ends an escape or an encoded
// edge, or a small letter before the name's capital.
const NAME_START = String.raw`(?:(?<!${LETTER})|(?<=\\[ntrbf])|(?<=\\u[0-9A-Fa-f]{4})|(?<=${ENCODED_EDGE})|(?<=\p{Ll})(?=\p{Lu}))`;
// What may sit right after it: no letter, or a capital after the name's small letter.
const NAME_END = String.raw`(?:(?!${LETTER})|(?<=\p{Ll})(?=\p{Lu}))`;
const NAME_JOINER = String.raw`[\s._-]*`;

/** A value as a pattern that matches it in any case, with no `i` flag, so the edges can tell a capital from a small letter. */
const caseless = (value: string): string =>
  [...value]
    .map((char) => {
      const [low, up] = [char.toLowerCase(), char.toUpperCase()];
      if (low === up) return escapeRegExp(char);
      return [...low].length === 1 && [...up].length === 1 ? `[${escapeRegExp(low)}${escapeRegExp(up)}]` : `(?:${escapeRegExp(low)}|${escapeRegExp(up)})`;
    })
    .join('');

/** The words of a mark found as whole words, or null for a mark found as a part. */
function nameWords(mark: string): string[] | null {
  const words = mark.trim().toLowerCase().split(/\s+/);
  return NAME_SHAPED.test(words.join(' ')) && !JOINED_SCRIPT.test(mark) ? words : null;
}

/** The one pattern for a mark, for the check and for `redact` (use flag `u`, never `i`). */
export function markPattern(mark: string): string {
  const words = nameWords(mark);
  return words ? `${NAME_START}${words.map(caseless).join(NAME_JOINER)}${NAME_END}` : caseless(mark.trim().toLowerCase());
}

/** Each mark's test, made once per process: the scan runs it on every line. */
const markTests = new Map<string, (text: string, lower: string) => boolean>();

/** Whether `text` holds `mark` (lowercased, as `loadMarks` gives it). `lower` is `text` lowercased, when the caller has it. The one test every scan uses. */
export function hasMark(text: string, mark: string, lower: string = text.toLowerCase()): boolean {
  let test = markTests.get(mark);
  if (!test) {
    const words = nameWords(mark);
    if (!words) test = (_, low) => low.includes(mark);
    else {
      const pattern = new RegExp(markPattern(mark), 'u');
      // The first word as a part comes first: most lines have none, and includes is fast.
      test = (whole, low) => low.includes(words[0]) && pattern.test(whole);
    }
    markTests.set(mark, test);
  }
  return test(text, lower);
}

/**
 * Problems in one file's text. `allow` holds literal strings the project has said are
 * fine (yokoten.json "privacy.allow"), such as a public support address.
 */
export function scanText(
  text: string,
  { file, marks = [], allow = [], logins = [], ownAllow = allow }: { file: string; marks?: string[]; allow?: string[]; logins?: string[]; ownAllow?: string[] },
): Finding[] {
  const problems: Finding[] = [];
  const lines = text.split('\n');
  // `logins`: the forge logins yokoten added to the marks, fine where a file names accounts (#410).
  const places = logins.length && marks.length ? loginPlaces(file, lines) : null;
  const secrets = findSecrets(lines, allow);
  // `ownAllow`: what may allow a mark, `allow` unless the caller says otherwise (a gh post to another repo, #447).
  const own = ownMarks(marks, ownAllow);
  const stopped = own.length ? marks.filter((mark) => !own.includes(mark)) : marks;
  lines.forEach((line, index) => {
    const where = { file, line: index + 1 };
    // The secret itself is never printed either, only its kind.
    for (const [at, kind] of secrets) if (at === index) problems.push(finding('secret', `a secret (${kind})`, 'remove it, rotate it, and keep it outside the repo', where));
    for (const [hit] of line.matchAll(EMAIL)) {
      if (isPersonalEmail(hit, allow)) {
        problems.push(finding('email', 'an email address', EMAIL_FIX, where));
      }
    }
    for (const { 0: hit, index } of line.matchAll(IPV4)) {
      const octets = hit.split('.').map(Number);
      if (octets.some((n) => n > 255) || OK_IP.some((re) => re.test(hit)) || allow.includes(hit) || isSectionNumber(line, index, hit)) continue;
      problems.push(finding('ip', 'an IP address', 'use a placeholder from 192.0.2.0/24', where));
    }
    const lower = line.toLowerCase();
    for (const mark of stopped) {
      // The mark itself is never printed: the output may land in a CI log or a chat.
      if (!hasMark(line, mark, lower)) continue;
      if (places && logins.includes(mark) && !hasMark(places(line, index, mark), mark)) continue;
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
// Where a cut home path ends: the end of a line, maybe after `…`, `...` or spaces (#404).
const CUT_END = String.raw`(?=(?:…|\.\.\.)?[ \t]*\r?$)`;

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
  const asPattern = (paths: string[], slash = String.raw`[\\/]`) => paths.map((home) => escapeRegExp(home).replace(/\\\\|\//g, slash)).join('|');
  const flags = isWindows ? 'giu' : 'gu';
  const whole = text.replace(new RegExp(`${BEFORE_HOME}(?:${asPattern(homes)})${AFTER_HOME}`, flags), '~');
  // The home inside a URL, its slashes written as %2F or %5C: `vscode-remote://...%2Fhome%2F<name>%2Fx`.
  const encoded = whole.includes('%') ? whole.replace(new RegExp(`${BEFORE_HOME}(?:${asPattern(homes, `%(?:2[Ff]|5[Cc])`)})(?=${ENCODED_EDGE}|$|(?!${PATH_CHAR}|\\.${PATH_CHAR}))`, flags), '~') : whole;
  const cuts = [...new Set(homes.flatMap(cutForms))].sort((a, b) => b.length - a.length);
  return cuts.length ? encoded.replace(new RegExp(`${BEFORE_HOME}(?:${asPattern(cuts)})${CUT_END}`, `${flags}m`), '~') : encoded;
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

export const isEmailShaped = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value);
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
  // One group per value, by the same pattern as the check (#434): a hit names its placeholder by its group.
  const pattern = values.length ? new RegExp(values.map((value) => `(${markPattern(value)})`).join('|'), 'gu') : null;
  const placeholders = values.map((value) => placeholderOf.get(value) ?? PLACEHOLDERS.mark);
  const hideSecrets = makeSecretHider();
  return (text) => {
    // An SSH remote at a private host (git@host) names the host, not a person.
    let out = hideSecrets(text).replace(EMAIL, (hit) => (!isPersonalEmail(hit) ? hit : /^git@/i.test(hit) ? `git@${PLACEHOLDERS.host}` : PLACEHOLDERS.email));
    out = hideHome(out, env);
    return pattern ? out.replace(pattern, (...groups: unknown[]) => placeholders[groups.slice(1, values.length + 1).findIndex((group) => group !== undefined)] ?? PLACEHOLDERS.mark) : out;
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
//
// The guard runs before the command, so a file the same command writes is not there yet
// (#439). It follows one shape only, and refuses the rest (record 0014): see CommandFiles.

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

// A heredoc end word the guard reads exactly: blanks, then a plain name, bare or in single
// or double quotes, then a blank, an operator or the end of the line. Bash reads more (`<<'E:F'`,
// `<<"E"OF`, `<<E\` and a new line); the guard does not, and scans the rest of the text instead.
const END_WORD = /^[ \t]*(?:([A-Za-z_]\w*)|'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)")(?=[ \t;&|<>)]|$)/;

/**
 * The bodies of the heredocs in a command's text, in order. Quoting around `<<` is not read: a
 * body found twice is scanned twice. A `<<` whose end word is not a plain name makes the rest
 * of the text, from the next line, one body: the guard scans more than bash posts, never less.
 */
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
        if (candidate === delimiter) break; // exactly, as bash: `EOF ` or `EOF\r` does not end it
        body.push(lines[index]);
      }
      bodies.push(body.join('\n'));
      continue;
    }
    for (const match of line.matchAll(/(?<!<)<<(?!<)(-?)/g)) {
      const rest = line.slice((match.index as number) + match[0].length);
      const word = END_WORD.exec(rest);
      if (!word) {
        // An end word the guard does not read exactly: the body is the rest of the text.
        bodies.push(lines.slice(index + 1).join('\n'));
        return bodies;
      }
      waiting.push({ delimiter: word[1] ?? word[2] ?? word[3], strip: match[1] === '-' });
    }
  }
  return bodies;
}

/**
 * A file's texts, `skip` for a file the guard does not read, `missing`, or `unsure`: the
 * command may change the file. `saw` is unsure too, and names what in the command (#498).
 */
type FileRead = { texts: string[] } | { saw: Risk } | 'skip' | 'missing' | 'unsure';

/** What in a command may change a body file (#498): its name, and a fix when "leave out" is not the one. */
export type Risk = { what: string; fix?: string };

/**
 * What the rest of the command does to the files gh reads (#439). `heredoc`: the command is
 * exactly `cat > path <<'EOF' && gh …`, and this is the path, as written, and the heredoc's
 * text. `mayWrite`: another command in it may write a file, so a file on disk is not read
 * as the one gh will post. `saw` names what may write it, for the message (#498). It runs
 * only on a refusal, so the marks file is read only then; `isMarked` keeps a private mark
 * out of the name.
 */
export interface CommandFiles {
  heredoc?: { path: string; text: string };
  mayWrite: boolean;
  saw?: (isMarked: (word: string) => boolean) => Risk | undefined;
  /** A cd in the command: a path with `..` goes up from the real folder, behind any symlink. */
  movesFolder?: boolean;
}

/** What a gh command posts: its pieces, or a file the guard can't find. Null when it posts nothing. */
type Missing = { missing: string; unsure: boolean; saw?: Risk };

function postedPieces(gh: GhCommand, readFile: (path: string) => FileRead, command: string): { pieces: Piece[] } | Missing | null {
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
  let missing: Missing | null = null;
  // A file named twice is read once: gh posts one of them, and a long body is scanned once.
  const seen = new Set<string>();
  let method: string | null = null;
  let hasFields = false;
  let query: string | null = null;
  const addFile = (option: string, path: string | undefined, key?: string) => {
    // No file after the option: the shell took it as a redirect, as in `-F <(echo x)` (#439).
    if (path === undefined) {
      missing ??= { missing: option, unsure: true };
      return;
    }
    if (path === '-') {
      // stdin: a here-string, a `< file`, or the heredocs in the command.
      if (gh.hereString !== undefined) pieces.push({ source: 'the here-string text', isFile: false, text: gh.hereString });
      else if (gh.stdinFile !== undefined) addFile('<', gh.stdinFile, key);
      else for (const body of heredocBodies(command)) pieces.push({ source: 'the heredoc text', isFile: false, text: body });
      if (key === 'query') query = [gh.hereString, ...heredocBodies(command)].filter((text) => text !== undefined).join('\n');
      return;
    }
    if (seen.has(path)) return;
    seen.add(path);
    const read = readFile(path);
    if (read === 'missing' || read === 'unsure') missing ??= { missing: option, unsure: read === 'unsure' };
    else if (read === 'skip') return;
    else if ('saw' in read) missing ??= { missing: option, unsure: true, saw: read.saw };
    else {
      for (const text of read.texts) pieces.push({ source: path, isFile: true, text });
      if (key === 'query') query = read.texts.join('\n');
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
  return missing ?? { pieces };
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

// The commit check's fix, and for an IP address the way to let a public one through.
// The email fix names privacy.allow already (EMAIL_FIX).
const ALLOW_FIX = 'If it is public on purpose, add it to "privacy.allow" in yokoten.json';
const postFix = (f: Finding) =>
  f.id === 'ip' ? `${f.fix}. ${ALLOW_FIX}` : f.id === 'secret' ? 'take it out of the text, and rotate it if it was ever sent' : f.fix;

/** A file's path as a finding may show it: home as `~`, and only its name, or no name, when the path holds a mark. */
function shownPath(path: string, env: Env, marks: string[]): string {
  const holdsMark = (text: string) => marks.some((mark) => hasMark(text, mark));
  const shown = hideHome(path, env);
  if (!holdsMark(shown)) return shown;
  const name = basename(shown);
  return holdsMark(name) ? 'the body file' : name;
}

// The characters bash reads as plain text outside quotes: no expansion, glob, brace, operator or comment.
const PLAIN_WORD = /^[A-Za-z0-9_ \t./:,=+@%-]$/;

/**
 * Whether the command line is one gh post and nothing else (#447): `gh …`, or the bot's
 * `yokoten bot -- gh …`, optionally after one plain `cd <folder> &&`. Before it, only
 * NODE_USE_ENV_PROXY, GH_REPO or GH_HOST may be set, to a plain value (#498); GH_REPO and
 * GH_HOST name another target, so namesTarget still keeps the allow. Outside quotes only
 * letters, digits, spaces and `_ . / : , = + @ % -` are trusted, plus one here-string or
 * one heredoc whose end word is a name in single quotes (`<<'EOF'` or `<<-'EOF'`). Bash
 * expands nothing in that body, and the body ends at the first line that is the name alone.
 * After that line only blank lines (spaces and tabs) may follow. Inside double quotes `$`,
 * backquote and backslash are refused; single quotes hold anything. Anything else could
 * change where gh posts before it runs, so no allow applies (record 0014). Listing shell
 * features one by one missed one each round, so the check names what it trusts.
 * `cd` is true when the line starts with that `cd`; its target may start with `~`.
 */
export function lonePost(command: string): { cd: boolean; target?: string } | null {
  let text = trimStart(command, ' \t');
  const cd = text.match(/^cd[ \t]+('[^'\n]*'|"[^"$`\\\n]*"|~?[\w./+@%:,=-]+|~)[ \t]*&&[ \t]*/);
  if (cd) text = text.slice(cd[0].length);
  const start = text.match(/^(?:(?:NODE_USE_ENV_PROXY|GH_REPO|GH_HOST)=[\w./:@-]*[ \t]+)*(?:(?:node[ \t]+)?(?:~?[\w./+@%:-]*\/)?yokoten(?:\.ts|\.mjs|\.js)?[ \t]+bot[ \t]+--[ \t]+)?gh[ \t]/);
  if (!start) return null;
  let quote: string | null = null;
  let heredoc: { word: string; tabs: boolean } | null = null;
  let index = start[0].length;
  for (; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '$' || char === '`' || char === '\\') return null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '\n') break;
    else if (PLAIN_WORD.test(char)) continue;
    else if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      if (heredoc) return null; // one heredoc at most
      // Only <<'NAME' or <<-'NAME', then a space, tab or newline, so bash reads the same end word.
      const quotedName = /<<(-?)'([A-Za-z_][A-Za-z0-9_]*)'(?=[ \t\n]|$)/y;
      quotedName.lastIndex = index;
      const found = quotedName.exec(text);
      if (!found) return null;
      heredoc = { word: found[2], tabs: found[1] === '-' };
      index += found[0].length - 1;
    } else if (char === '<' && text[index + 1] === '<') index += 2; // a here-string: its word is read as any other
    else return null;
  }
  if (quote) return null;
  const lone = cd ? { cd: true, target: cd[1] } : { cd: false };
  if (index >= text.length) return heredoc ? null : lone;
  // A newline: only a heredoc's body may follow, then nothing.
  if (!heredoc) return null;
  const { word, tabs } = heredoc;
  const lines = text.slice(index + 1).split('\n');
  const end = lines.findIndex((line) => (tabs ? trimStart(line, '\t') : line) === word);
  if (end === -1) return null;
  return lines.slice(end + 1).every((line) => /^[ \t]*$/.test(line)) ? lone : null;
}

// The programs a pipe at the end of a gh line may feed (#498): each only reads its input.
// sort, uniq and sed count only with the options readsOnly in guards.ts checks.
export const PIPE_READERS = new Set(['tail', 'head', 'grep', 'cut', 'wc', 'sort', 'uniq', 'tr', 'sed']);
const PIPE_PROGRAM = /[ \t]*([a-z]+)(?=[ \t]|$)/y;

/**
 * The command without a pipe at its end into programs that only read (#498):
 * `gh … 2>&1 | tail -2` gives `gh …`. The commands of a pipe run beside gh and leave this
 * shell's folder alone, so the file gh reads and where it posts stay the same. One shape
 * only: from the first `|` outside quotes to the end of the one line, each command starts
 * with a program in PIPE_READERS and holds only the characters lonePost trusts, plus
 * `$NAME` inside "...". A `2>&1` right before the pipe, or at the end of a line with no
 * pipe, goes too. Any other command comes back as it was, for the rest of the guard to read.
 */
export function withoutReadPipe(command: string): string {
  let quote = '';
  let at = -1;
  for (let index = 0; index < command.length && at === -1; index++) {
    const char = command[index];
    if (char === '\n' || (char === '\\' && quote !== "'")) return command;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '|') at = index;
  }
  if (at !== -1 && !isReadPipe(command, at)) return command;
  return withoutStderrRedirect(at === -1 ? command : command.slice(0, at));
}

// The text without a `2>&1` at its end: stderr goes where stdout goes, and no file is
// opened. Only spaces and tabs count as blanks: bash reads any other character as a word.
function withoutStderrRedirect(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  if (end < 5 || !text.startsWith('2>&1', end - 4)) return text;
  const before = text[end - 5];
  return before === ' ' || before === '\t' ? text.slice(0, end - 4) : text;
}

// Whether the text from `at`, a `|`, to the end is a pipe into PIPE_READERS in plain words.
// A sed may hold no `$` at all, in any quotes: bash fills in a value before sed reads its
// script, and a value can hold the delimiter and then `w` (see sedReadsOnly in guards.ts).
function isReadPipe(text: string, at: number): boolean {
  let quote = '';
  let program = '';
  for (let index = at; index < text.length; index++) {
    const char = text[index];
    if (char === '$' && program === 'sed') return false;
    if (quote === "'") {
      if (char === "'") quote = '';
      else if (char === '\n' || char === '\r') return false;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      // A `$NAME` inside "..." is one word of text: it runs nothing. `$(`, `${` and the rest may.
      else if (char === '$' && !/[A-Za-z_]/.test(text[index + 1] ?? '')) return false;
      else if ('`\\!\n\r'.includes(char)) return false;
    } else if (char === '|') {
      PIPE_PROGRAM.lastIndex = index + 1;
      const found = PIPE_PROGRAM.exec(text);
      if (!found || !PIPE_READERS.has(found[1])) return false;
      program = found[1];
      index += found[0].length;
    } else if (char === "'" || char === '"') quote = char;
    else if (!PLAIN_WORD.test(char)) return false;
  }
  return quote === '';
}

/**
 * Whether a gh command may post somewhere other than the repo it runs in (#447): it names a
 * repo (`-R`, `--repo`, an issue or pull request URL), GH_REPO or GH_HOST is set or appears anywhere in the
 * command, or it runs the api or gist group, whose target the guard does not read. Then no
 * allow for this repo applies.
 */
export function namesTarget(gh: GhCommand, command: string, env: Env): boolean {
  if (env.GH_REPO || env.GH_HOST || /\bGH_(?:REPO|HOST)\b/.test(command)) return true;
  const { args } = gh;
  let group: string | undefined;
  for (let index = 0; index < args.length && group === undefined; index++) {
    if (GLOBAL_VALUES.has(args[index])) index++;
    else if (!args[index].startsWith('-')) group = args[index];
  }
  if (group === 'api' || group === 'gist') return true;
  return args.some((arg) => arg === '-R' || arg === '--repo' || arg.startsWith('--repo=') || (arg.startsWith('-R') && arg.length > 2) || /^https?:\/\//i.test(arg));
}

/** The top folder of the repo at `dir`, links followed, or null. */
function repoTop(dir: string, env: Env): string | null {
  const top = gitAnswer(dir, ['rev-parse', '--show-toplevel'], env);
  return 'out' in top && top.out.trim() ? (localKey(top.out.trim()) ?? null) : null;
}

/**
 * Whether a gh post goes to the repo it runs in, so an allow for that repo may apply (#447):
 * the line is the post alone (`lonePost`), it names no other target, and a `cd` before it
 * stays in the repo the line started in (`from`).
 */
function isPostHere(gh: GhCommand, { env, command, cwd, from }: { env: Env; command: string; cwd: string | null; from?: string | null }): boolean {
  const lone = lonePost(withoutReadPipe(command));
  if (!lone || namesTarget(gh, command, env)) return false;
  if (!lone.cd) return true;
  if (!cwd || !from) return false;
  // bash searches CDPATH for a bare relative folder, and CDPATH may be set in the shell
  // without being exported, so only /, ./, ../ or an unquoted ~ or ~/ say where cd goes. A
  // quoted ~ is not your home: bash keeps it as a folder named ~, and searches CDPATH for it.
  if (lone.target !== undefined && !/^(?:~(?:\/|$)|['"]?(?:\/|\.\/|\.\.\/))/.test(lone.target)) return false;
  const top = repoTop(cwd, env);
  return top !== null && top === repoTop(from, env);
}

/**
 * The first privacy problem in the text a gh command is about to post, or null. `command`
 * is the whole command text, for the heredocs that feed stdin. `cwd` is where the command
 * runs, for a relative file; null when the guard cannot tell.
 */
export function checkPost(
  gh: GhCommand,
  { env, privacy, cwd, command, from, files }: { env: Env; privacy?: Partial<Pick<Config['privacy'], 'allow' | 'skipOwnName'>>; cwd: string | null; command: string; from?: string | null; files?: CommandFiles },
): Finding | null {
  // The path goes to the kernel as bash hands it to gh, never normalized: join and resolve
  // drop `..` as text, but the kernel goes up from the real folder when the working folder
  // or home is a symlink (#470).
  // A word in a refusal is tested against the marks as a path is in shownPath (#498). The
  // marks file is read only when a refusal names a word.
  let namedMarks: string[] | undefined;
  const isMarked = (word: string) => (namedMarks ??= loadMarks(env)).some((mark) => word.toLowerCase().includes(mark));
  const readFile = (path: string): FileRead => {
    let full = path;
    if (path.startsWith('~')) {
      // Bash takes `~` from HOME, or from the system when HOME is unset; only a full HOME
      // tells the guard which, and `~name` is another user's home (#470).
      const home = homeOf(env);
      if (!home || (path !== '~' && !path.startsWith('~/'))) return 'missing';
      full = `${home}/${path.slice(2)}`;
    }
    if (!isAbsolute(full) && cwd === null) return 'unsure';
    if (files?.movesFolder && full.split(/[\\/]/).includes('..')) return { saw: { what: 'a `cd` before a path with `..`' } };
    const at = isAbsolute(full) || !cwd ? full : `${cwd}/${full}`;
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(at);
    } catch {
      // missing, or not readable: as missing
    }
    const isReadable = stat !== null && stat.isFile() && stat.size <= MAX_FILE_BYTES;
    // `cat > path <<'EOF' && gh … path`: the heredoc's text, and what is there now as well,
    // in case cat can't replace it (#439).
    if (files?.heredoc && path === files.heredoc.path) {
      if (stat === null) return { texts: [files.heredoc.text] };
      return isReadable ? { texts: [files.heredoc.text, readFileSync(at, 'utf8')] } : 'unsure';
    }
    if (stat === null) return 'missing';
    if (files?.mayWrite) {
      const risk = files.saw?.(isMarked);
      return risk ? { saw: risk } : 'unsure';
    }
    return isReadable ? { texts: [readFileSync(at, 'utf8')] } : 'skip';
  };
  const posted = postedPieces(gh, readFile, command);
  if (!posted) return null;
  if ('missing' in posted) {
    // The guard runs before the command (#439): a file the command writes, or a path only
    // the running command knows, can't be read yet.
    // What the guard saw is named, so the agent knows what to change (#498).
    const { saw } = posted;
    const what = !posted.unsure
      ? `yokoten can't find the file after ${posted.missing} to check it: the file doesn't exist yet when the guard runs`
      : `yokoten can't tell what the file after ${posted.missing} will hold: the guard runs before the command, and ${saw ? `${saw.what} in this command` : 'this command'} may change the file or where it is`;
    const fix = `${saw ? `${saw.fix ?? `leave out ${saw.what}`}, or ` : ''}write the file in one command, then post it in the next, and give its full path`;
    return finding('unreadable-command', what, fix, {
      why: 'the privacy check reads a body before it is posted, and an unread one could hold anything',
    });
  }
  if (!posted.pieces.length) return null;
  const allow = privacy?.allow ?? [];
  // An allowed mark is left out of the path shown too (#424). The project's and the machine's
  // allow (#447) are for the repo the command runs in: a post gets them only when it is the
  // line's one command (after at most a cd within the same repo) and names no other target.
  const all = loadMarks(env);
  const isHere = all.length > 0 && isPostHere(gh, { env, command, cwd, from });
  const key = isHere && cwd !== null ? repoKey(cwd, env) : null;
  const named = isHere && skipsOwnName(env, privacy) ? sameNameMarks(all, key) : [];
  const own = isHere ? [...ownMarks(all, [...allow, ...machineAllowed(env, cwd, key ?? undefined).allow]), ...named] : [];
  const marks = all.filter((mark) => !own.includes(mark));
  for (const piece of posted.pieces) {
    const [hit] = scanText(piece.text, { file: piece.source, marks, allow, ownAllow: [] });
    if (!hit) continue;
    const more = { why: postWhy(hit.why) };
    if (piece.isFile) return finding(hit.id as RuleId, hit.what, postFix(hit), { ...more, file: shownPath(piece.source, env, marks), line: hit.line });
    const line = piece.text.includes('\n') ? `, line ${hit.line},` : '';
    const what = hit.id === 'private-mark' ? `${piece.source}${line} ${hit.what}` : `${piece.source}${line} holds ${hit.what}`;
    return finding(hit.id as RuleId, what, postFix(hit), more);
  }
  return null;
}
