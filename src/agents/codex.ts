// What yokoten knows about OpenAI's Codex CLI: the shape of its PreToolUse call and where
// its project hooks live. Source: https://developers.openai.com/codex/hooks
//
// Codex runs a project's hooks only after the user trusts the project's .codex/ folder
// and reviews the hook (`/hooks`). It records trust against the hook's hash, so a changed
// command has to be trusted again.

import { isAbsolute, join } from 'node:path';
import type { Action } from '../run/hook.ts';
import { addHook, hasHook } from './hooks-file.ts';

// The docs: "Bash and apply_patch use tool_input.command", and unified exec reports as Bash.
const SHELL = 'Bash';

/** The files an apply_patch envelope adds, updates, deletes or moves to. */
function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)[ \t]*$/gm)].map((m) => m[1]);
}

const ENVELOPE = /\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g;
// What the shell runs right before an envelope: `apply_patch <<'EOF'` (a heredoc) or
// `apply_patch "` (an argument), after an optional `cd <dir> &&`. Group 1, 2 or 3 is the dir.
const PATCH_COMMAND = /(?:^|[\n;&|(`'"])\s*(?:cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;|\n)\s*)?(?:apply_patch|applypatch)\b[^\n]*\n?\s*$/;

/**
 * The files a shell command's apply_patch envelopes touch. Codex sends a shell-run
 * apply_patch as a Bash call and fires no second hook (rust-v0.163.0). An envelope that
 * another command reads, such as `cat > notes.md <<'EOF'`, is data, not an edit.
 */
function shellPatchPaths(command: string): string[] {
  const paths: string[] = [];
  let start = 0;
  for (const envelope of command.matchAll(ENVELOPE)) {
    const before = PATCH_COMMAND.exec(command.slice(start, envelope.index));
    start = envelope.index + envelope[0].length;
    if (!before) continue;
    const dir = before[1] ?? before[2] ?? before[3];
    for (const path of patchPaths(envelope[0])) paths.push(dir && !isAbsolute(path) ? join(dir, path) : path);
  }
  return paths;
}

/**
 * A PreToolUse call, as an Action. A shell call's `tool_input.command` is the command, and
 * the file headers of an apply_patch it runs are the paths. An apply_patch call's
 * `tool_input.command` is the patch, and its file headers are the paths.
 * Any other tool (MCP, update_plan) is neither.
 */
export function readToolCall(input: unknown): Action {
  const call = (input ?? {}) as { cwd?: unknown; tool_name?: unknown; tool_input?: unknown; agent_type?: unknown };
  const tool = (typeof call.tool_input === 'object' && call.tool_input !== null ? call.tool_input : {}) as Record<string, unknown>;
  const name = typeof call.tool_name === 'string' ? call.tool_name : '';
  const command = typeof tool.command === 'string' ? tool.command : undefined;
  return {
    command: name === SHELL ? command : undefined,
    paths: !command ? [] : name === 'apply_patch' ? patchPaths(command) : name === SHELL ? shellPatchPaths(command) : [],
    cwd: typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : undefined,
    // Since rust-v0.163.0 a subagent's call may carry `agent_type`: a built-in role
    // (default, worker, explorer) or a custom one's name from .codex/agents/*.toml. Not
    // on the docs page yet, so it is optional; without it YOKOTEN_ROLE decides.
    worker: /worker/i.test(typeof call.agent_type === 'string' ? call.agent_type : ''),
  };
}

const projectHooks = (root: string) => join(root, '.codex', 'hooks.json');

/**
 * The project's tool-call guard. Codex runs a hook in the session's cwd and documents no
 * project-dir variable; its docs advise a path from the git root, as here.
 */
export const addProjectHook = (root: string, cli: string) =>
  addHook(projectHooks(root), 'PreToolUse', 'Bash|apply_patch', `node "$(git rev-parse --show-toplevel)/${cli}" hook --agent codex`);
export const hasProjectHook = (root: string): boolean => hasHook(projectHooks(root), 'PreToolUse', 'hook');
