#!/usr/bin/env node
// yokoten: carry what one project learned into every project. The hooks run this file.
//
// It is plain JavaScript, so Node starts it without its type stripper (#408). It turns on
// Node's compile cache, then loads the command (bin/main.ts) and runs it. The cache keeps
// each module type-stripped and compiled, so a warm run loads no stripper at all: a hook
// starts about as fast as plain JavaScript. A static import is compiled before any code here runs, so
// the command comes in by a dynamic import, after the cache is on (#286).
//
// The cache lives in the user's cache folder, which a restart does not empty, as the
// system temp folder may: ~/.cache/yokoten (or $XDG_CACHE_HOME), ~/Library/Caches/yokoten
// on macOS, %LOCALAPPDATA%\yokoten\cache on Windows. NODE_COMPILE_CACHE names another
// folder, and NODE_DISABLE_COMPILE_CACHE turns it off. The cache only speeds up a run:
// an older Node, a folder that can't be written, or any other error leaves the command
// running as before, with Node's own folder, or none.
//
// bin/yokoten.ts, the name older hooks and the docs use, loads this file.
import module from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The user's cache folder for yokoten, or undefined when there is no home folder. */
function cacheDir(env) {
  if (env.NODE_COMPILE_CACHE) return env.NODE_COMPILE_CACHE;
  let home = '';
  try {
    home = homedir();
  } catch {
    // No home folder: Node's own folder.
  }
  if (process.platform === 'win32') return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'yokoten', 'cache') : undefined;
  if (!home) return undefined;
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'yokoten');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'yokoten');
}

try {
  // A folder that can't be made fails the call without an error: Node's own folder then.
  const started = module.enableCompileCache?.(cacheDir(process.env));
  if (started?.status === module.constants?.compileCacheStatus?.FAILED) module.enableCompileCache();
} catch {
  // Run without the cache.
}
// A tool-call guard starts its worker first, so the worker starts while the command loads
// and reads the call: it is the slowest part of the hook (src/run/hook.ts).
if (process.argv[2] === 'hook' && !process.argv.includes('--stop')) (await import('../src/run/hook.ts')).startGuardEarly();
await (await import('./main.ts')).runFromProcess();
