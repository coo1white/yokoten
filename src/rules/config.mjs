// yokoten.json at the repo root. Every key is optional; a missing file means the defaults.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = {
  // At most this many entries in a folder. The root is never counted: tools expect their
  // files there. A folder in `exempt` is a log (records, root-cause reports) and may grow.
  layout: { maxEntries: 7, exempt: [] },
  // What counts as a test file. A fix task must not change one.
  tests: ['*.test.*', '*.spec.*', '*_test.go', 'test/**', 'tests/**'],
  // What only the lead (the session that reviews and pushes) may change: the rules the
  // agents work under, and the CI that checks them.
  leadOnly: ['AGENTS.md', 'CLAUDE.md', 'yokoten.json', '.claude/**', '.muse/**', '.githooks/**', '.github/**'],
  // `allow`: literal strings the privacy check lets through (a public support address).
  // `skip`: files it does not read (lockfiles, vendored code).
  privacy: { allow: [], skip: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum'] },
  // Practices this project has decided not to take up yet, by doctor's name for them, each
  // with the reason and when to look again: { "ci": "no remote yet; revisit on first push" }.
  notNow: {},
};

export function loadConfig(root) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(root, 'yokoten.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`yokoten.json: ${err.message}`);
  }
  return {
    layout: { ...DEFAULTS.layout, ...file.layout },
    tests: file.tests ?? DEFAULTS.tests,
    leadOnly: file.leadOnly ?? DEFAULTS.leadOnly,
    privacy: { ...DEFAULTS.privacy, ...file.privacy },
    notNow: file.notNow ?? {},
  };
}
