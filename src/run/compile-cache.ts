// Node's compile cache keeps the compiled form of each module, so the next run skips
// type-stripping and parsing (#286). It lives in the system temp folder unless
// NODE_COMPILE_CACHE names another, and NODE_DISABLE_COMPILE_CACHE turns it off; Node
// reads both itself. The cache only speeds up a run: an older Node, a folder that can't
// be written, or any other error leaves the command running as before.
import module from 'node:module';

export function enableCompileCache(): void {
  try {
    module.enableCompileCache?.();
  } catch {
    // Run without the cache.
  }
}
