// yokoten.json at the repo root. Every key is optional; a missing file means the defaults.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** What yokoten.json may hold: any key, or part of one. */
interface ConfigFile {
  layout?: Partial<Config['layout']>;
  tests?: string[];
  leadOnly?: string[];
  privacy?: Partial<Config['privacy']>;
  notNow?: Record<string, string>;
  allowBuild?: string[];
  areas?: string[];
  translations?: Partial<Config['translations']>;
  commands?: { block?: Record<string, string> };
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

/** The part of yokoten.json the hook ignored: the whole file, or only "commands". */
export type IgnoredPart = 'file' | 'commands';

/**
 * yokoten.json, or the defaults. A problem in the file throws. `onProblem` is for the hook
 * (#192, #218): it gets the problem instead, and the hook keeps its core checks. A file
 * that cannot be read or is not one JSON object then gives the defaults. A wrong
 * "commands" drops only the block list. Without it (check, doctor), each is a config problem.
 */
export function loadConfig(root: string, { onProblem }: { onProblem?: (problem: string, ignored: IgnoredPart) => void } = {}): Config {
  let file: ConfigFile;
  try {
    file = readConfigFile(root);
  } catch (err) {
    if (!onProblem) throw err;
    onProblem((err as Error).message, 'file');
    return DEFAULTS;
  }
  return {
    layout: { ...DEFAULTS.layout, ...file.layout },
    tests: file.tests ?? DEFAULTS.tests,
    leadOnly: file.leadOnly ?? DEFAULTS.leadOnly,
    privacy: { ...DEFAULTS.privacy, ...file.privacy },
    notNow: file.notNow ?? {},
    allowBuild: file.allowBuild ?? DEFAULTS.allowBuild,
    areas: file.areas ?? DEFAULTS.areas,
    translations: { ...DEFAULTS.translations, ...file.translations },
    commands: { block: readBlockListOr(file.commands, onProblem) },
  };
}

// The file as one JSON object; a missing file is an empty one. The message names the file
// and never holds a path, so the hook can print it as it is (core rule 11).
function readConfigFile(root: string): ConfigFile {
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
  return file as ConfigFile;
}

function readBlockListOr(commands: unknown, onProblem?: (problem: string, ignored: IgnoredPart) => void): Record<string, string> {
  if (!onProblem) return readBlockList(commands);
  try {
    return readBlockList(commands);
  } catch (err) {
    onProblem((err as Error).message, 'commands');
    return {};
  }
}

// "commands": { "block": { "<program>": "<reason>" } }. A wrong shape is a config problem,
// said as one, so the guard never runs on a list it misread.
function readBlockList(commands: unknown): Record<string, string> {
  if (commands === undefined) return {};
  const shape = 'yokoten.json: "commands" must look like { "block": { "<program>": "<reason>" } }';
  if (!isPlainObject(commands)) throw new Error(shape);
  const block = commands.block;
  if (block === undefined) return {};
  if (!isPlainObject(block)) throw new Error(shape);
  for (const [program, reason] of Object.entries(block)) {
    if (!/^[^\s/\\]+$/.test(program)) throw new Error(`yokoten.json: "commands.block" names a program by its name alone, with no path or space: ${JSON.stringify(program)}`);
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(`yokoten.json: "commands.block.${program}" must be the reason, as text`);
  }
  return { ...(block as Record<string, string>) };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
