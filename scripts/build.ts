// Builds what the runtime runs besides the .ts files:
// - dist/, the .js the npm package runs (#31). Node does not strip types under
//   node_modules, so the package can't run the .ts files.
// - bin/bundle/, bin/ and src/ bundled into two .mjs files (#408). A copy of the runtime
//   (install, init) runs them, so a hook skips type stripping and loading ~45 modules.
//   bin/bundle/sources.sha256 says which .ts files it was built from; a copy takes the
//   bundle only when they are the files it copies (src/setup/files.ts).
// The repo never needs either: it runs bin/yokoten.ts as it is. `npm pack` runs this
// first (the prepack script), and the bench job in CI before it measures.
//
// Both folders are emptied first, so a deleted source file leaves nothing stale behind.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BUNDLE, BUNDLE_SOURCES, sourceHash } from '../src/setup/files.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.build.json')], { cwd: ROOT, stdio: 'inherit' });

// Two files, so a copy's bin/bundle/ stays within the layout cap of the projects it lands in:
// - main.mjs, the whole command. A command's module still runs only when its command does:
//   esbuild wraps each one that bin/main.ts imports lazily in a function.
// - guard.mjs, the guard's worker (src/run/hook.ts): it loads only the rules, not the
//   command. In main.mjs, YOKOTEN_GUARD_WORKER names it; the .ts files leave it undefined.
// Not minified, so a reviewer can read a copy. They are .mjs, at the depth of src/setup/:
// files.ts finds the home folder from its own path (`homeDirOf`).
const outdir = join(ROOT, BUNDLE);
rmSync(outdir, { recursive: true, force: true });
const options = { bundle: true, format: 'esm', platform: 'node', target: 'node22.18', logLevel: 'warning' } as const;
await build({ ...options, entryPoints: [join(ROOT, 'bin', 'main.ts')], outfile: join(outdir, 'main.mjs'), define: { YOKOTEN_GUARD_WORKER: JSON.stringify('./guard.mjs') } });
await build({ ...options, entryPoints: [join(ROOT, 'src', 'run', 'hook.ts')], outfile: join(outdir, 'guard.mjs') });
writeFileSync(join(outdir, BUNDLE_SOURCES), `${sourceHash(ROOT)}\n`);
