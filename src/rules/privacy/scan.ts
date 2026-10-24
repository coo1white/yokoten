import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../config.ts';
import { type Finding, finding } from '../message.ts';
import { findEnvironmentValues, findLineIgnores, findSecretHits, type IgnoreDirective, makeSafeIgnoreReason, makeSecretHider, parseIgnoreFile, SECRET } from './secrets.ts';
import { ownMarks, systemHome } from './home.ts';
import { describeMark, EMAIL, EMAIL_FIX, ENCODED_EDGE, escapeRegExp, foldLine, foldMark, foldPlain, foldText, hasMark, IPV4, isEmailShaped, isDomainShaped, isPersonalEmail, isSectionNumber, loginPlaces, markPattern, OK_IP, PUBLIC_FORGES } from './marks.ts';

export const IGNORE_FILE = '.yokotenignore';

/** The fix for an ignore only the lead may add: a line in the ignore file, which is lead-only. */
const LEAD_IGNORE_FIX = (rule: string) => `if it is not real, ask the lead to add \`${rule}: <reason>\` to ${IGNORE_FILE}`;

/** An ignore's reason as output may show it: no secret, environment value, mark, home path, email or IP. */
function hideInReason(redact: (text: string) => string, reason: string, env: Env, values: string[] = []): string {
  return redact(makeSafeIgnoreReason(reason, env, values)).replace(IPV4, (hit) => {
    const octets = hit.split('.').map(Number);
    return octets.every((n) => n <= 255) && !OK_IP.some((re) => re.test(hit)) ? SECRET : hit;
  });
}

/**
 * The ignores a pull request adds to one file, as notes for the reviewer: each
 * `yokoten-ignore` comment on an added line, and each added line of `.yokotenignore`.
 * `added` holds the added lines' numbers, from 1. The reason is shown hidden, as in a finding.
 */
export function addedIgnores(file: string, text: string, added: ReadonlySet<number>, env: Env, marks: string[] = []): Finding[] {
  if (!added.size) return [];
  const found: Finding[] = [];
  let redact: ((text: string) => string) | undefined;
  const note = (reason: string, line: number, what: string) => {
    redact ??= makeRedactor({ marks }, env);
    found.push(finding('ignore-added', what, 'check that the reason holds before you approve', { file, line, ignored: hideInReason(redact, reason, env) }));
  };
  if (file === IGNORE_FILE) {
    for (const entry of parseIgnoreFile(text).entries) {
      if (entry.line !== undefined && added.has(entry.line)) note(entry.reason, entry.line, `this pull request lets ${entry.rule} hits through in the whole repo`);
    }
    return found;
  }
  text.split('\n').forEach((line, index) => {
    if (!added.has(index + 1)) return;
    for (const entry of findLineIgnores(line, { commentsOnly: true })) {
      if (!('problem' in entry)) note(entry.reason, index + 1, `this pull request lets a ${entry.rule} hit through on this line`);
    }
  });
  return found;
}

/** The rules an ignore may name. */
const IGNORABLE_RULES = ['secret', 'email', 'ip', 'private-mark'];
const IGNORABLE = new Set(IGNORABLE_RULES);

/** The reasons in `.yokotenignore`, and a failure for each line with no rule, no reason or an unknown rule. */
export function loadIgnores(root: string): { entries: IgnoreDirective[]; problems: Finding[] } {
  let text: string;
  try {
    text = readFileSync(join(root, IGNORE_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], problems: [] };
    return { entries: [], problems: [finding('ignore', `the ignore file can't be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`, `make ${IGNORE_FILE} readable, or remove it`, { file: IGNORE_FILE, grade: 'sure' })] };
  }
  const parsed = parseIgnoreFile(text);
  const problems = parsed.problems.map((problem) => finding('ignore', problem.what, `write \`<rule>: <reason>\` in ${IGNORE_FILE}, such as \`secret: a test fixture\``, { file: IGNORE_FILE, line: problem.line, grade: 'sure' }));
  for (const entry of parsed.entries) {
    if (IGNORABLE.has(entry.rule)) continue;
    problems.push(finding('ignore', 'an ignore names a rule this check does not know', `use one of: ${IGNORABLE_RULES.join(', ')}`, { file: IGNORE_FILE, line: entry.line, grade: 'sure' }));
  }
  return {
    entries: parsed.entries.filter((entry) => IGNORABLE.has(entry.rule)),
    problems,
  };
}

/**
 * Problems in one file's text. `allow` holds literal strings the project has said are
 * fine (yokoten.json "privacy.allow"), such as a public support address. `kinds` gives
 * each mark's kind, as `loadMarkKinds` reads it, so a finding can name it (#523).
 * `ignores` holds the reasons from `.yokotenignore`. A privacy hit there is still listed,
 * with its grade and its reason, but does not fail. A `yokoten-ignore` comment on the
 * line works the same, except for a private mark or a `sure` secret: only
 * `.yokotenignore`, which only the lead may change, lets those through.
 * `inlineIgnores: false` reads no comment at all, for text that is not a file (a gh post).
 */
export function scanText(
  text: string,
  { file, marks = [], allow = [], logins = [], ownAllow = allow, kinds, ignores = [], env = {}, inlineIgnores = true }: { file: string; marks?: string[]; allow?: string[]; logins?: string[]; ownAllow?: string[]; kinds?: ReadonlyMap<string, string | null>; ignores?: IgnoreDirective[]; env?: Env; inlineIgnores?: boolean },
): Finding[] {
  const problems: Finding[] = [];
  const lines = text.split('\n');
  // `logins`: the forge logins yokoten added to the marks, fine where a file names accounts (#410).
  const places = logins.length && marks.length ? loginPlaces(file, lines) : null;
  const secrets = findSecretHits(lines, { allow, env });
  const secretValues = secrets.map((hit) => lines[hit.line].slice(hit.start, hit.end));
  const fileIgnore = new Map<string, string>();
  for (const entry of ignores) if (!fileIgnore.has(entry.rule)) fileIgnore.set(entry.rule, entry.reason);
  // `ownAllow`: what may allow a mark, `allow` unless the caller says otherwise (a gh post to another repo, #447).
  const own = ownMarks(marks, ownAllow);
  const stopped = own.length ? marks.filter((mark) => !own.includes(mark)) : marks;
  let cleanReason: ((text: string) => string) | undefined;
  lines.forEach((line, index) => {
    const where = { file, line: index + 1 };
    // The secret itself is never printed either, only its kind. An ignore with no reason
    // is a failure, whether or not a secret is on its line.
    const inline = inlineIgnores ? findLineIgnores(line, { commentsOnly: true }) : [];
    const inlineReason = (rule: string) => inline.find((entry): entry is IgnoreDirective => !('problem' in entry) && entry.rule === rule)?.reason;
    // `isInlineAllowed` false: a private mark or a sure secret, which only the ignore file may let through.
    const ignoreFields = (rule: string, values: string[], isInlineAllowed: boolean): { ignored?: string } => {
      const reason = (isInlineAllowed ? inlineReason(rule) : undefined) ?? fileIgnore.get(rule);
      if (reason === undefined) return {};
      cleanReason ??= makeRedactor({ marks: stopped }, env);
      return { ignored: hideInReason(cleanReason, reason, env, values) };
    };
    for (const entry of inline) {
      if ('problem' in entry) problems.push(finding('ignore', entry.problem, 'add the rule and a reason after yokoten-ignore, or remove the ignore', { ...where, grade: 'sure' }));
      else if (!IGNORABLE.has(entry.rule)) problems.push(finding('ignore', 'an ignore names a rule this check does not know', `use one of: ${IGNORABLE_RULES.join(', ')}`, { ...where, grade: 'sure' }));
      else if (entry.rule === 'private-mark') problems.push(finding('ignore', "a private-mark hit can't be ignored on its line", LEAD_IGNORE_FIX('private-mark'), { ...where, grade: 'sure' }));
    }
    for (const hit of secrets) {
      if (hit.line !== index) continue;
      const isSure = hit.grade === 'sure';
      const fields = ignoreFields('secret', secretValues, !isSure);
      // A sure secret with a comment that tries to ignore it: the fix says who may.
      const fix = isSure && fields.ignored === undefined && inlineReason('secret') !== undefined ? `a sure secret can't be ignored on its line: remove it and rotate it, or ${LEAD_IGNORE_FIX('secret')}` : 'remove it, rotate it, and keep it outside the repo';
      problems.push(finding('secret', `a secret (${hit.kind})`, fix, { ...where, grade: hit.grade, ...fields }));
    }
    for (const [hit] of line.matchAll(EMAIL)) {
      if (isPersonalEmail(hit, allow)) {
        problems.push(finding('email', 'an email address', EMAIL_FIX, { ...where, grade: 'sure', ...ignoreFields('email', [hit], true) }));
      }
    }
    for (const { 0: hit, index } of line.matchAll(IPV4)) {
      const octets = hit.split('.').map(Number);
      if (octets.some((n) => n > 255) || OK_IP.some((re) => re.test(hit)) || allow.includes(hit) || isSectionNumber(line, index, hit)) continue;
      problems.push(finding('ip', 'an IP address', 'use a placeholder from 192.0.2.0/24', { ...where, grade: 'sure', ...ignoreFields('ip', [hit], true) }));
    }
    const folded = stopped.length ? foldLine(line) : null;
    for (const mark of stopped) {
      // The mark itself is never printed: the output may land in a CI log or a chat.
      if (!hasMark(line, mark, folded!)) continue;
      if (places && logins.includes(mark) && !hasMark(places(line, index, mark), mark)) continue;
      const { what, fix } = describeMark(kinds && kinds.has(mark) ? kinds.get(mark) : undefined);
      problems.push(finding('private-mark', what, fix, { ...where, grade: 'sure', ...ignoreFields('private-mark', [mark], false) }));
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
    // Folded first (#507): a mark of only zero-width characters is no mark, and the length
    // that orders the values is the length that is matched.
    const key = foldMark(value);
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
  const placeholderFor = (groups: unknown[]) => placeholders[groups.slice(0, values.length).findIndex((group) => group !== undefined)] ?? PLACEHOLDERS.mark;
  // The marks are found in the folded text (#507), and each hit replaces the pieces of the original it came from.
  const hideMarks = (text: string) => {
    // Most text holds no mark: the fast fold says so, with no positions to keep.
    if (!pattern || foldPlain(text).search(pattern) === -1) return text;
    const { text: folded, starts, ends } = foldText(text);
    if (!starts || !ends) return text.replace(pattern, (...groups: unknown[]) => placeholderFor(groups.slice(1)));
    let out = '';
    let last = 0;
    for (const hit of folded.matchAll(pattern)) {
      // Two hits in one piece (a ligature, say) hide that piece once.
      const end = ends[hit.index + hit[0].length - 1];
      if (end <= last) continue;
      const start = Math.max(last, starts[hit.index]);
      out += text.slice(last, start) + placeholderFor(hit.slice(1));
      last = end;
    }
    return out + text.slice(last);
  };
  const hideSecrets = makeSecretHider();
  const secretValues = findEnvironmentValues(env);
  return (text) => {
    // An SSH remote at a private host (git@host) names the host, not a person.
    let out = hideSecrets(text);
    for (const value of secretValues) out = out.replaceAll(value, SECRET);
    out = out.replace(EMAIL, (hit) => (!isPersonalEmail(hit) ? hit : /^git@/i.test(hit) ? `git@${PLACEHOLDERS.host}` : PLACEHOLDERS.email));
    return hideMarks(hideHome(out, env));
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

