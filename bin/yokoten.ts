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
import module from 'node:module';

// Grok CLI also runs Claude Code's hooks (its Claude compatibility), so a Grok tool call
// would start the guard twice. Under Grok (it sets GROK_HOOK_EVENT and GROK_SESSION_ID for
// every hook), the Claude Code hook answers nothing and exits at once, before any module
// loads: Grok's own hook in .grok/hooks/yokoten.json guards the call (#407).
const words = process.argv.slice(2);
const agentAt = words.indexOf('--agent');
const agent = agentAt < 0 ? 'claude-code' : words[agentAt + 1];
if (words[0] === 'hook' && agent === 'claude-code' && (process.env.GROK_HOOK_EVENT || process.env.GROK_SESSION_ID)) process.exit(0);

try {
  module.enableCompileCache?.();
} catch {
  // Run without the cache.
}
await import('./main.ts');
