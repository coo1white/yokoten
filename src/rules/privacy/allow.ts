import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Config, Env } from '../config.ts';
import { noteWork } from '../message.ts';
import { homeIn, NO_HOME, ownMarks } from './home.ts';
import { loadMarkKinds, type Mark } from './marks.ts';

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

/**
 * The machine allow file: beside the default private-marks file, never beside the one
 * YOKOTEN_PRIVATE_MARKS names, so the setting can't bring its own allow (#656). With no home
 * folder it throws NO_HOME, and the machine allows nothing.
 */
export const machineAllowFile = (env: Env): string => join(homeIn(env), '.config', 'yokoten', 'private-marks-allow.json');

/** The port each scheme uses when the URL names none: such a port is left out of the key. */
const DEFAULT_PORTS: Record<string, string> = { https: '443', http: '80', ssh: '22', 'git+ssh': '22', 'ssh+git': '22', git: '9418' };

/** `text` without any of `chars` at its end. A loop, so it is linear on any input. */
function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) {
    noteWork(1);
    end--;
  }
  return text.slice(0, end);
}

/** `text` without any of `chars` at its start. */
export function trimStart(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text[start])) {
    noteWork(1);
    start++;
  }
  return text.slice(start);
}

/** A path with no slash and no `.git` at its end. */
function withoutGit(path: string): string {
  const bare = trimEnd(path, '/\\');
  return trimEnd(bare.toLowerCase().endsWith('.git') ? bare.slice(0, -4) : bare, '/\\');
}

/** A local path as a key: absolute, links followed, against `base` when relative. Null for a relative one with no base. */
export function localKey(path: string, base?: string): string | null {
  if (!path || (!isAbsolute(path) && !base)) return null;
  const full = resolve(base ?? '', path);
  // The deepest folder that exists, with links followed, then the rest: a link such as
  // macOS's /var gives one key whether or not the path exists yet.
  for (let head = full, rest = ''; ; rest = rest ? join(basename(head), rest) : basename(head), head = dirname(head)) {
    noteWork(1);
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
  noteWork(url.length);
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
export function gitAnswer(dir: string, args: string[], env: Env): { out: string } | { status: number | null } {
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
