import type { Finding } from '../../message.ts';

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
export interface Piece {
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
export const POSTS: Record<string, string[]> = {
  issue: ['create', 'new', 'comment', 'edit', 'close'],
  pr: ['create', 'new', 'comment', 'edit', 'review', 'merge', 'close'],
  release: ['create', 'new', 'edit'],
};

// gh options that hold text to post, and those that name a file of it. `-F` is a file in
// every one of these commands (`--body-file`, or `--notes-file` for a release).
export const TEXT_OPTIONS = new Set(['--title', '-t', '--body', '-b', '--notes', '-n', '--subject']);
// `close` takes a comment as text; in `pr review`, `--comment` is a switch.
export const CLOSE_OPTIONS = new Set([...TEXT_OPTIONS, '--comment', '-c']);
export const FILE_OPTIONS = new Set(['--body-file', '--notes-file', '-F']);
// The api subcommand: each field is key=value; `-F key=@file` reads a file, and `--input` sends one.
export const FIELD_OPTIONS = new Set(['-f', '--raw-field', '-F', '--field']);
export const INPUT_OPTIONS = new Set(['--input']);
// gh's global option that takes a value before the subcommand: `gh -R o/r issue create`.
export const GLOBAL_VALUES = new Set(['-R', '--repo']);
export const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT']);
// A GraphQL document that changes something: comments first, then `mutation`.
export const MUTATION = /^\s*(?:#[^\n]*\n\s*)*mutation\b/;
// The largest file the guard reads.
export const MAX_FILE_BYTES = 1024 * 1024;

const programName = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).replace(/\.exe$/i, '');
const isYokoten = (name: string) => /^yokoten(\.ts|\.js)?$/.test(name);

/**
 * Where gh starts in a command's words, or -1. `places` are the programs the command
 * runs, each with its index in `words` (the guard's findPrograms): gh itself, or yokoten
 * (or node) running `bot -- gh`. An index below 0 is an `env -S` program, which has no
 * word in `words`. The index is the program's place, not the first word equal to its name.
 */
export function ghIndex(words: string[], places: { word: string; index: number }[]): number {
  for (const place of places) {
    if (place.index < 0 || place.index >= words.length) continue;
    const name = programName(words[place.index]);
    if (name === 'gh') return place.index;
    if (isYokoten(name) || name === 'node' || name === 'npx') {
      const bot = words.indexOf('bot', place.index + 1);
      if (bot !== -1 && words[bot + 1] === '--' && programName(words[bot + 2] ?? '') === 'gh') return bot + 2;
    }
  }
  return -1;
}

/** An option and its value: `--body x`, `--body=x`, `-bx`. Null when `word` is not one of `names`. */
export function optionValue(words: string[], index: number, names: Set<string>): { value: string | undefined; name: string; next: number } | null {
  const word = words[index];
  const equals = word.indexOf('=');
  if (word.startsWith('--') && equals !== -1 && names.has(word.slice(0, equals))) return { name: word.slice(0, equals), value: word.slice(equals + 1), next: index + 1 };
  if (names.has(word)) return { name: word, value: words[index + 1], next: index + 2 };
  // A short option with its value joined on: `-bx`, `-b=x`.
  if (/^-[A-Za-z]./.test(word) && names.has(word.slice(0, 2))) return { name: word.slice(0, 2), value: word.slice(2).replace(/^=/, ''), next: index + 1 };
  return null;
}

/** A host API call as the adapter reads it. The guard does not know which host this is. */
export interface HostApiCall {
  /** Upper case, or empty when the call names no method. */
  method: string;
  /** The endpoint word as written, before the path is normalized. */
  rawPath: string;
  /** The endpoint with the URL, query, `.` and `..` removed. */
  path: string;
  /** Whether the call sends a field or an input file. */
  hasFields: boolean;
  /** Whether short options are joined, so the method is not clear. */
  cluster: boolean;
}

/** How a host adapter reads its API command. */
export interface HostApi {
  read(args: string[]): HostApiCall;
  clusterFinding(): Finding;
  values(): Set<string>;
}

/** No adapter yet. Until one loads, the guard refuses every `gh` command (see guards.ts). */
let hostApi: HostApi | undefined;

/** No API options until a host adapter registers. */
const NO_API_VALUES = new Set<string>();

/** The host adapter registers how to read its API command, once: a second registration is refused. */
export function useHostApi(reader: HostApi): void {
  if (hostApi && hostApi !== reader) throw new Error('the host API reader is already registered');
  hostApi = reader;
}

/** The API call in `args`, or undefined when no host adapter has registered. */
export function readHostApi(args: string[]): HostApiCall | undefined {
  return hostApi?.read(args);
}

/** The finding for joined short options, or undefined when no host adapter has registered. */
export function hostApiClusterFinding(): Finding | undefined {
  return hostApi?.clusterFinding();
}

/** Options of the host API command that take a value. Empty until an adapter registers. */
export function hostApiValues(): Set<string> {
  return hostApi?.values() ?? NO_API_VALUES;
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
