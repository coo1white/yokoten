// yokoten.json at the repo root. Every key is optional; a missing file means the defaults.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, finding } from './message.ts';

export interface Config {
  layout: { maxEntries: number; exempt: string[] };
  tests: string[];
  leadOnly: string[];
  privacy: { allow: string[]; skip: string[]; utc: boolean };
  notNow: Record<string, string>;
  allowBuild: string[];
  areas: string[];
  translations: { fail: boolean };
  commands: { block: Record<string, string> };
}

/** The guard's own environment (process.env, or a test's stand-in). */
export type Env = Record<string, string | undefined>;

export const DEFAULTS: Config = {
  // At most this many entries in a folder. The root is never counted: tools expect their
  // files there. A folder in `exempt` is a log (records, root-cause reports) and may grow.
  layout: { maxEntries: 7, exempt: [] },
  // What counts as a test file. A fix task must not change one.
  tests: ['*.test.*', '*.spec.*', '*_test.go', 'test/**', 'tests/**'],
  // What only the lead (the session that reviews and pushes) may change: the rules the
  // agents work under, and the CI that checks them.
  leadOnly: ['AGENTS.md', 'CLAUDE.md', 'yokoten.json', '.claude/**', '.claude-plugin/**', '.codex/**', '.gemini/**', '.muse/**', '.githooks/**', '.github/**'],
  // `allow`: literal strings the privacy check lets through (a public support address).
  // `skip`: files it does not read (lockfiles, vendored code).
  // `utc`: commits must record their time in UTC, not the machine's time zone.
  privacy: { allow: [], skip: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum'], utc: true },
  // Practices this project has decided not to take up yet, by doctor's name for them, each
  // with the reason and when to look again: { "ci": "no remote yet; revisit on first push" }.
  notNow: {},
  // Build output and binaries the commit check lets through, as globs: ["dist/**", "*.pdf"].
  allowBuild: [],
  // The areas an issue title (`area: ...`) and a pull request title (`type(area): ...`)
  // may name: ["doctor", "check"]. Empty means any lowercase word.
  areas: [],
  // A translation behind its English source (#87) is a note; `fail` makes it a problem.
  translations: { fail: false },
  // Programs no agent may run here, each with the reason (#192):
  // { "block": { "python3": "this project is TypeScript only" } }.
  commands: { block: {} },
};

/**
 * The part of yokoten.json the hook ignored: "file" for the whole file, or the key path
 * of one key that has the wrong shape, such as "leadOnly" or "layout.maxEntries".
 */
export type IgnoredPart = string;

/** What one value must look like: the problem with a value (null when it fits), and its copy. */
interface Shape {
  problem: (value: unknown, path: string) => string | null;
  read?: (value: unknown) => unknown;
}

/** A key that holds an object: what the object looks like, and a shape for each field. */
interface Fields {
  example: string;
  fields: Record<string, Shape>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTextList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');

// A shape said in words. The message names the key and what it must be (#228).
const shape = (text: string, fits: (value: unknown) => boolean): Shape => ({
  problem: (value, path) => (fits(value) ? null : `yokoten.json: "${path}" must be ${text}`),
});
const textList = (example: string) => shape(`a list of text, such as ${example}`, isTextList);
const trueOrFalse = shape('true or false', (value) => typeof value === 'boolean');

// "commands": { "block": { "<program>": "<reason>" } }. A wrong shape drops the whole
// block list, so the guard never runs on a list it misread (#192).
const blockList: Shape = {
  problem: (commands) => {
    const looks = 'yokoten.json: "commands" must look like { "block": { "<program>": "<reason>" } }';
    if (!isPlainObject(commands)) return looks;
    const block = commands.block;
    if (block === undefined) return null;
    if (!isPlainObject(block)) return looks;
    for (const [program, reason] of Object.entries(block)) {
      if (!/^[^\s/\\]+$/.test(program)) return `yokoten.json: "commands.block" names a program by its name alone, with no path or space: ${JSON.stringify(program)}`;
      if (typeof reason !== 'string' || !reason.trim()) return `yokoten.json: "commands.block.${program}" must be the reason, as text`;
    }
    return null;
  },
  read: (commands) => ({ block: { ...((commands as { block?: Record<string, string> }).block ?? {}) } }),
};

/**
 * Every key yokoten.json may hold, and its shape (#228). The one place a key is checked:
 * code that reads a Config can trust its types. A key not listed here is unknown.
 */
const SHAPES: Record<keyof Config, Shape | Fields> = {
  layout: {
    example: '{ "maxEntries": 7, "exempt": ["docs/records"] }',
    fields: { maxEntries: shape('a whole number above 0, such as 7', (value) => Number.isInteger(value) && (value as number) > 0), exempt: textList('["docs/records"]') },
  },
  tests: textList('["*.test.*", "test/**"]'),
  leadOnly: textList('["AGENTS.md", ".github/**"]'),
  privacy: {
    example: '{ "allow": [], "skip": ["package-lock.json"], "utc": true }',
    fields: { allow: textList('["support@example.com"]'), skip: textList('["package-lock.json"]'), utc: trueOrFalse },
  },
  notNow: shape('an object of reasons by step name, such as { "ci": "no remote yet" }', (value) => isPlainObject(value) && Object.values(value).every((reason) => typeof reason === 'string')),
  allowBuild: textList('["dist/**"]'),
  areas: textList('["doctor", "check"]'),
  translations: { example: '{ "fail": true }', fields: { fail: trueOrFalse } },
  commands: blockList,
};

/**
 * yokoten.json, or the defaults. A problem in the file throws. `onProblem` is for the hook
 * (#192, #218, #228): it gets each problem instead, and the hook keeps its core checks. A
 * file that cannot be read or is not one JSON object then gives the defaults. A key with
 * the wrong shape gives that key's default, and the rest of the file still counts.
 * Without it (check, doctor), each is a config problem. An unknown key is never a problem
 * here: `findUnknownKeys` makes it a note.
 */
export function loadConfig(root: string, { onProblem }: { onProblem?: (problem: string, ignored: IgnoredPart) => void } = {}): Config {
  let file: Record<string, unknown>;
  try {
    file = readConfigFile(root);
  } catch (err) {
    if (!onProblem) throw err;
    onProblem((err as Error).message, 'file');
    return DEFAULTS;
  }
  // The value at `path` if it fits its shape, or the default.
  const readValue = (entry: Shape, value: unknown, path: string, fallback: unknown): unknown => {
    if (value === undefined) return fallback;
    const problem = entry.problem(value, path);
    if (problem === null) return entry.read ? entry.read(value) : value;
    if (!onProblem) throw new Error(problem);
    onProblem(problem, path);
    return fallback;
  };
  const config: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(SHAPES) as [keyof Config, Shape | Fields][]) {
    const fallback = DEFAULTS[key];
    if (!('fields' in entry)) {
      config[key] = readValue(entry, file[key], key, fallback);
      continue;
    }
    const object = readValue(shape(`an object, such as ${entry.example}`, isPlainObject), file[key], key, fallback) as Record<string, unknown>;
    const defaults = fallback as unknown as Record<string, unknown>;
    config[key] = Object.fromEntries(Object.entries(entry.fields).map(([field, fieldShape]) => [field, object === defaults ? defaults[field] : readValue(fieldShape, object[field], `${key}.${field}`, defaults[field])]));
  }
  return config as unknown as Config;
}

/**
 * A note for each key in yokoten.json that yokoten does not know (#228): a misspelled
 * key does nothing. It is a note, not a problem, so a config written for a newer yokoten
 * still works with an older one. A file that cannot be read gives no notes: `loadConfig`
 * reports it.
 */
export function findUnknownKeys(root: string): Finding[] {
  let file: Record<string, unknown>;
  try {
    file = readConfigFile(root);
  } catch {
    return [];
  }
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(file)) {
    const entry: Shape | Fields | undefined = Object.hasOwn(SHAPES, key) ? SHAPES[key as keyof Config] : undefined;
    if (!entry) unknown.push(key);
    else if ('fields' in entry && isPlainObject(value)) unknown.push(...Object.keys(value).filter((field) => !Object.hasOwn(entry.fields, field)).map((field) => `${key}.${field}`));
  }
  return unknown.map((key) => finding('config-key', `"${key}" is not a key this version of yokoten knows`, `check the spelling against the guide, or update yokoten if a newer version added "${key}"`, { file: 'yokoten.json' }));
}

// The file as one JSON object; a missing file is an empty one. The message names the file
// and never holds a path, so the hook can print it as it is (core rule 11).
function readConfigFile(root: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(join(root, 'yokoten.json'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw new Error(`yokoten.json: cannot be read (${code ?? 'unknown error'})`);
  }
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch (err) {
    throw new Error(`yokoten.json: ${(err as Error).message.replace(/\s+/g, ' ')}`);
  }
  if (!isPlainObject(file)) throw new Error('yokoten.json: the file must hold one JSON object, such as {}');
  return file;
}

// Globs, as yokoten.json names files. Matched against a path relative to the repo root,
// with forward slashes.
//
// `*` matches inside one name, `?` one character, `**/` any number of folders (none too),
// and a trailing `**` everything below. A glob with a slash is anchored at the root
// (`test/**` is the root's test folder); a glob without one matches a name in any folder
// (`*.test.*`).

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        re += '(?:.*/)?';
        index += 2;
      } else {
        re += '.*';
        index += 1;
      }
    } else if (character === '*') {
      re += '[^/]*';
    } else if (character === '?') {
      re += '[^/]';
    } else {
      re += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`);
}

/** A function that says whether a path matches any of the globs. */
export function matcher(globs: string[]): (path: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((re) => re.test(path));
}
