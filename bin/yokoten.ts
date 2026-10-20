#!/usr/bin/env node
// yokoten: carry what one project learned into every project.
//
// The name older hooks, the git hook, CI and the docs use. It loads bin/yokoten.mjs, which
// the agent hooks now run (#408): a .ts entry makes Node load its type stripper first.
// By its URL, so tsc leaves the import as it is: the npm build copies yokoten.mjs too.
await import(new URL('yokoten.mjs', import.meta.url).href);
