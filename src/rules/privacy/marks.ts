import type { Env } from '../config.ts';
import { noteWork } from '../message.ts';
import { marksTexts } from './home.ts';

export const isEmailShaped = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value);
/** A domain or host name: words joined by dots, ending in a top-level name. */
export const isDomainShaped = (value: string): boolean => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value);

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
  const seen = new Set<string>();
  // Each file on its own, so a header in one never names the kind of a line in the next.
  return marksTexts(env).flatMap((text) => markLines(text).flatMap((mark) => (mark && !seen.has(mark.value) && seen.add(mark.value) ? [mark] : [])));
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

/** Each mark's kind, by its value, for `scanText` to name it (#523). */
export const mapMarkKinds = (marks: Mark[]): Map<string, string | null> => new Map(marks.map((mark) => [mark.value, mark.kind]));

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
export function loginPlaces(file: string, lines: string[]): ((line: string, index: number, login: string) => string) | null {
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
export const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A browser version in a user agent (Chrome/120.0.0.0) is not an address. Only the
// browser product names are skipped, case-sensitive as a user agent writes them: an
// address in a path (api/192.0.2.1) or a URL (http://192.0.2.1) is still caught.
// Only IPv4 is checked, private ranges included; IPv6 is not.
const BROWSER = 'Chrome|Chromium|CriOS|Edg|EdgA|EdgiOS|Edge|OPR|Opera|Version|Firefox|FxiOS|Safari|AppleWebKit|Gecko|Mozilla|YaBrowser|SamsungBrowser|UCBrowser|Electron';
export const IPV4 = new RegExp(`(?<![\\w.])(?<!\\b(?:${BROWSER})/)(?:\\d{1,3}\\.){3}\\d{1,3}(?![\\w.])`, 'g');

/** The public code hosts: a remote there names no private server. */
export const PUBLIC_FORGES = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'ssh.dev.azure.com', 'dev.azure.com'];
/** `text` with every regex special character escaped, for a pattern built from strings. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Addresses that point at no person. A personal address at the same domains
// (someone at gmail.com, or at github.com) is still caught.
export const OK_EMAIL = [
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
export const OK_IP = [/^127\./, /^0\.0\.0\.0$/, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];

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
export function isSectionNumber(line: string, index: number, hit: string): boolean {
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

// ---- One form for marks and text (#507) ----
//
// The same letters can be written in more than one Unicode form: é as one code point or as
// e plus a combining accent, full-width Latin (`ｓａｍ`), a zero-width space inside a word. The
// check and `redact` fold the mark and the text the same way before they match: NFKD, then
// lowercase. NFKD, not NFKC: a mark found as a part (`sam_1a`, a Hangul name) is still found
// when an accent or a final consonant joins its last letter in the text, as it was before
// the fold. A mark drops U+200B to U+200D and U+2060; the text keeps them, and the pattern
// lets them sit between any two letters of a mark, so one inside a word is skipped and one
// next to a name is still an edge (`x\u200Bsam`). The text keeps its case after the fold,
// because a change from a small letter to a capital is an edge; its pattern ignores case
// instead (`caseless`). Homoglyphs, such as a Cyrillic letter that looks Latin, stay out.

const ZERO_WIDTH = /[\u200B-\u200D\u2060]/g;
const ZERO_WIDTH_RUN = '[\\u200B-\\u200D\\u2060]*';
const NON_ASCII = /[^\x00-\x7f]/;
// A character that NFKD may join onto the one before it: a combining mark, a Hangul vowel or
// final consonant, a half-width voicing mark. It is folded with that character.
const JOINER = /^[\p{M}\u1160-\u11FF\uFF9E\uFF9F]/u;
// At most 30 such characters are folded with one letter, the stream-safe limit of Unicode
// (UAX #15): a normalize of a longer run takes time that grows with its square. A text with
// a longer run is folded piece by piece, with the run cut every 30.
const MAX_JOINED = 30;
// Whether each character below U+10000 joins, found the first time it is seen: a test of
// `JOINER` on every character of a long line costs more than the normalize (#507).
const joinsKnown = new Uint8Array(0x10000);

/** How many code units the character at `index` takes when it joins the one before it, or 0. */
function joinerWidth(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code < 0x300) return 0;
  if (code >= 0xd800 && code <= 0xdbff) return JOINER.test(text.slice(index, index + 2)) ? 2 : 0;
  if (!joinsKnown[code]) joinsKnown[code] = JOINER.test(text[index]) ? 2 : 1;
  return joinsKnown[code] === 2 ? 1 : 0;
}

// Whether NFKD leaves each character below U+10000 as it is, found the first time it is seen:
// most characters of a long line need no normalize of their own.
const stableKnown = new Uint8Array(0x10000);

/** Whether NFKD leaves the one code unit at `index` as it is (a surrogate never). */
function isStable(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code < 0xa0) return true;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  if (!stableKnown[code]) stableKnown[code] = text[index].normalize('NFKD') === text[index] ? 2 : 1;
  return stableKnown[code] === 2;
}

/** Whether `text` has a run of more than `MAX_JOINED` characters that join. */
function hasLongJoin(text: string): boolean {
  for (let index = 0, run = 0; index < text.length; ) {
    const width = joinerWidth(text, index);
    noteWork(width || 1);
    if (!width) run = 0;
    else if (++run > MAX_JOINED) return true;
    index += width || 1;
  }
  return false;
}

/**
 * Text after the fold, case kept. `starts[i]` and `ends[i]` are where the piece of the
 * original that gave code unit `i` starts and ends, so a match maps back to the original.
 * Both are null when the fold changes nothing: the positions are the same.
 */
export interface FoldedText {
  text: string;
  starts: number[] | null;
  ends: number[] | null;
}

/**
 * The fold with no positions, for the check: one normalize of the whole text when no run of
 * joined characters is over the limit. It gives the same text as `foldText`: NFKD of a text
 * cut before each character that does not join is NFKD of its pieces.
 */
export function foldPlain(text: string): string {
  if (!NON_ASCII.test(text)) {
    noteWork(text.length);
    return text;
  }
  if (!hasLongJoin(text)) {
    noteWork(text.length);
    return text.normalize('NFKD');
  }
  return foldText(text).text;
}

/** The one fold of text, for the check and for `redact` (#507). A line of ASCII costs one test. */
export function foldText(text: string): FoldedText {
  if (!NON_ASCII.test(text) || (!hasLongJoin(text) && text.normalize('NFKD') === text)) return { text, starts: null, ends: null };
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let start = 0; start < text.length; ) {
    let end = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
    for (let joined = 0, width = 0; joined < MAX_JOINED && end < text.length && (width = joinerWidth(text, end)); joined++) end += width;
    noteWork(end - start);
    const piece = end === start + 1 && isStable(text, start) ? text[start] : text.slice(start, end).normalize('NFKD');
    folded += piece;
    for (let i = 0; i < piece.length; i++) {
      starts.push(start);
      ends.push(end);
    }
    start = end;
  }
  return { text: folded, starts, ends };
}

/** A mark as the check matches it: folded, with no zero-width characters, and lowercased (#507). Empty for a mark of only those. */
export const foldMark = (mark: string): string => foldPlain(mark).replace(ZERO_WIDTH, '').trim().toLowerCase();

/** One line folded for the check: the text with its case and zero-width characters, and lowercased without them. Fold a line once, for all its marks. */
export interface FoldedLine {
  text: string;
  lower: string;
}
export const foldLine = (line: string): FoldedLine => {
  if (!NON_ASCII.test(line)) {
    noteWork(line.length);
    return { text: line, lower: line.toLowerCase() };
  }
  const long = hasLongJoin(line);
  // One normalize of the whole line when no joined run is over the limit.
  if (!long) noteWork(line.length);
  const text = long ? foldText(line).text : line.normalize('NFKD');
  return { text, lower: text.replace(ZERO_WIDTH, '').toLowerCase() };
};

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
export const ENCODED_EDGE = '%(?:2[Ff]|5[Cc]|20)';
const NAME_SHAPED = /^[\p{L}\p{M}]+(?: [\p{L}\p{M}]+)*$/u;
const JOINED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Arabic}\p{Script=Hebrew}]/u;
const LETTER = String.raw`[\p{L}\p{M}]`;
// What may sit right before a name: no letter, or a letter that ends an escape or an encoded
// edge, or a small letter before the name's capital.
const NAME_START = String.raw`(?:(?<!${LETTER})|(?<=\\[ntrbf])|(?<=\\u[0-9A-Fa-f]{4})|(?<=${ENCODED_EDGE})|(?<=\p{Ll})(?=\p{Lu}))`;
// What may sit right after it: no letter, or a capital after the name's small letter.
const NAME_END = String.raw`(?:(?!${LETTER})|(?<=\p{Ll})(?=\p{Lu}))`;
const NAME_JOINER = String.raw`[\s._\u200B-\u200D\u2060-]*`;

// The lowercase of the capital İ (U+0130) is two code units: i and a combining dot above.
const DOTTED_I = 'i\u0307';
const DOTTED_I_PATTERN = `(?:[iI]${ZERO_WIDTH_RUN}\u0307|\u0130)`;

/**
 * A lowercased value as a pattern that matches it in any case, with no `i` flag, so the
 * edges can tell a capital from a small letter. A dotted i also matches İ, and a zero-width
 * character may sit between any two letters (#507).
 */
const caseless = (value: string): string => value.split(DOTTED_I).map(caselessPart).join(`${ZERO_WIDTH_RUN}${DOTTED_I_PATTERN}${ZERO_WIDTH_RUN}`);
const caselessPart = (value: string): string =>
  [...value]
    .map((char) => {
      const [low, up] = [char.toLowerCase(), char.toUpperCase()];
      if (low === up) return escapeRegExp(char);
      return [...low].length === 1 && [...up].length === 1 ? `[${escapeRegExp(low)}${escapeRegExp(up)}]` : `(?:${escapeRegExp(low)}|${escapeRegExp(up)})`;
    })
    .join(ZERO_WIDTH_RUN);

/** The words of a mark found as whole words, or null for a mark found as a part. */
function nameWords(mark: string): string[] | null {
  const words = mark.split(/\s+/);
  return NAME_SHAPED.test(words.join(' ')) && !JOINED_SCRIPT.test(mark) ? words : null;
}

/**
 * The one pattern for a mark, for the check and for `redact` (use flag `u`, never `i`). It
 * matches text folded by `foldText`. A mark that folds to nothing matches nothing.
 */
export function markPattern(mark: string): string {
  const value = foldMark(mark);
  if (!value) return '(?!)';
  const words = nameWords(value);
  return words ? `${NAME_START}${words.map(caseless).join(NAME_JOINER)}${NAME_END}` : caseless(value);
}

/** Each mark's test, made once per process: the scan runs it on every line. */
const markTests = new Map<string, (text: string, lower: string) => boolean>();

/**
 * Whether `text` holds `mark`, in any Unicode form (#507). `folded` is `foldLine(text)`,
 * when the caller has it: a scan folds each line once, for all its marks. The one test every scan uses.
 */
export function hasMark(text: string, mark: string, folded: FoldedLine = foldLine(text)): boolean {
  let test = markTests.get(mark);
  if (!test) {
    const value = foldMark(mark);
    const words = nameWords(value);
    if (!value) test = () => false;
    else if (!words) test = (_, low) => low.includes(value);
    else {
      const pattern = new RegExp(markPattern(mark), 'u');
      // The first word as a part comes first: most lines have none, and includes is fast.
      test = (whole, low) => low.includes(words[0]) && pattern.test(whole);
    }
    markTests.set(mark, test);
  }
  noteWork(folded.text.length);
  return test(folded.text, folded.lower);
}

// ---- What a stopped mark is (#523) ----
// A finding names the kind of mark, never its value, so the owner knows which line to look at.

const MARK_KINDS: Record<string, { name: string; off?: string }> = {
  'git name': { name: 'your git name', off: 'git-name' },
  'git email': { name: 'your git email', off: 'git-email' },
  'forge login': { name: 'your forge login', off: 'forge-login' },
  'private remote host': { name: 'the name of a private server in your git remotes' },
};
const MARK_REWORD = 'remove it or reword the line; the mark itself is never printed';
const MARK_ALLOW = 'If this repo may name it, run `yokoten marks allow <mark> --here`';

/**
 * The text of a private-mark finding for a mark of `kind`, as `Mark` gives it: null for one
 * the owner wrote, undefined when the caller does not know. The fix says how to change it.
 */
export function describeMark(kind: string | null | undefined): { what: string; fix: string } {
  if (kind === undefined) return { what: 'matches a line of your private-marks file', fix: MARK_REWORD };
  if (kind === null) return { what: 'matches a word you added to your private marks', fix: `${MARK_REWORD}. ${MARK_ALLOW}. To take the mark out, run \`yokoten marks remove\`` };
  const known = MARK_KINDS[kind];
  const what = `matches ${known?.name ?? `your ${kind}`} (a private mark yokoten added by itself)`;
  return { what, fix: known?.off ? `${MARK_REWORD}. To stop checking ${known.name}, run \`yokoten marks off ${known.off}\`` : `${MARK_REWORD}. ${MARK_ALLOW}` };
}

/** The tracked file that gives a reason for a finding the project lets through. */
