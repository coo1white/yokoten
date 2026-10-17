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
  leadOnly: ['AGENTS.md', 'CLAUDE.md', 'yokoten.json', '.claude/**', '.codex/**', '.gemini/**', '.muse/**', '.githooks/**', '.github/**'],
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
};

export function loadConfig(root: string): Config {
  let file: ConfigFile = {};
  try {
    file = JSON.parse(readFileSync(join(root, 'yokoten.json'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`yokoten.json: ${(err as Error).message}`);
  }
  return {
    layout: { ...DEFAULTS.layout, ...file.layout },
    tests: file.tests ?? DEFAULTS.tests,
    leadOnly: file.leadOnly ?? DEFAULTS.leadOnly,
    privacy: { ...DEFAULTS.privacy, ...file.privacy },
    notNow: file.notNow ?? {},
    allowBuild: file.allowBuild ?? DEFAULTS.allowBuild,
    areas: file.areas ?? DEFAULTS.areas,
  };
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
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`);
}

/** A function that says whether a path matches any of the globs. */
export function matcher(globs: string[]): (path: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((re) => re.test(path));
}
