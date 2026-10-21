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
    // #516: one CI run (Node 22) got ENOENT inside this copy, in a test that did nothing else
    // wrong, and no run since has shown it again. Node 22's cpSync lists a folder, then copies
    // each entry, and fails if the template changed or went in between. So the template is only
    // kept once it is fully built (a build that threw used to leave a half-made one to copy), and
    // a copy that hits ENOENT starts again, with a new template if the old one is gone.
    for (let attempt = 1; ; attempt++) {
      try {
        if (!template || !existsSync(template)) {
          template = '';
          const folder = makeFolder();
          build(folder);
          template = folder;
        }
        cpSync(template, dest, { recursive: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === 3) throw error;
      }
    }
  };
}
