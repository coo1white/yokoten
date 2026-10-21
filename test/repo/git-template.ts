// A git repo for a test, copied from one built once per test process (#475). A test that ran
// `git init`, two `git config` and maybe a commit started three to seven git processes before
// it checked anything; a copy starts none. Each copy is a plain file copy, .git and all: it
// shares no objects with the template or with another copy, and a fresh `git init` writes no
// path into .git, so nothing in a copy points back at the template.

import './home.ts';
import { cpSync, existsSync } from 'node:fs';

/**
 * A function that fills a folder with a copy of the repo `build` makes. The first call makes
 * the template, in a folder from `makeFolder` that must outlive the test; later calls copy it.
 * Commits in the template keep the time and id they got then, the same in every copy.
 */
export function templateRepo(makeFolder: () => string, build: (dir: string) => void): (dest: string) => void {
  let template = '';
  return (dest) => {
    if (!template || !existsSync(template)) {
      template = makeFolder();
      build(template);
    }
    cpSync(template, dest, { recursive: true });
  };
}
