// Builds dist/, the .js the npm package runs (#31). Node does not strip types under
// node_modules, so the package can't run the .ts files. The repo never needs this: it
// runs bin/yokoten.ts as it is. `npm pack` runs it first (the prepack script).
//
// dist/ is emptied first, so a deleted source file leaves no stale .js in the package.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.build.json')], { cwd: ROOT, stdio: 'inherit' });
