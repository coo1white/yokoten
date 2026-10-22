// Agent Skills: SKILL.md is an open format, not one runtime's, and most agents (Codex,
// Gemini CLI, Copilot, Cursor) read it from one shared folder, `.agents/skills`. So that
// folder gets its own file here. Claude Code reads only its own folder, in
// runtimes/claude-code.ts; setup keeps the real copy there and links it from the shared
// one, so Muse, which reads both, sees each skill once (#557).

import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { homeIn } from '../rules/privacy.ts';

/** Where the shared Agent Skills folder keeps a user's skills. */
export const userDir = (env: Env): string => join(homeIn(env), '.agents');
export const skillFile = (env: Env, name: string): string => join(userDir(env), 'skills', name, 'SKILL.md');
