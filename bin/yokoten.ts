#!/usr/bin/env node
// yokoten: carry what one project learned into every project.
//
// This file turns on Node's compile cache, then loads the command (bin/main.ts). The
// cache keeps the compiled form of each module, so the next run skips type-stripping
// and parsing (#286). It lives in the system temp folder unless NODE_COMPILE_CACHE names
// another, and NODE_DISABLE_COMPILE_CACHE turns it off; Node reads both itself. The cache
// only speeds up a run: an older Node, a folder that can't be written, or any other error
// leaves the command running as before. A static import is compiled before any code here
// runs, so the command comes in by a dynamic import, after the cache is on.
//
// A copy of the runtime (install, init: it has a VERSION file) runs the prebuilt bundle
// in bundle/ when it has one (#408): the hooks then load two .mjs files, not ~45 .ts files.
// A copy takes the bundle only when it was built from the .ts files copied with it
// (src/setup/files.ts). The repo has no VERSION file, so it always runs the .ts files.
import { existsSync } from 'node:fs';
import module from 'node:module';

try {
  module.enableCompileCache?.();
} catch {
  // Run without the cache.
}
const bundle = new URL('bundle/main.mjs', import.meta.url);
await (existsSync(new URL('../VERSION', import.meta.url)) && existsSync(bundle) ? import(bundle.href) : import('./main.ts'));
