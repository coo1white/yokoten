#!/usr/bin/env node
// yokoten: carry what one project learned into every project.
//
// This file turns on Node's compile cache, then loads the command (bin/main.ts). A
// static import is compiled before any code here runs, so the command comes in by a
// dynamic import, after the cache is on (#286).
import { enableCompileCache } from '../src/run/compile-cache.ts';

enableCompileCache();
await import('./main.ts');
