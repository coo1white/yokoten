// What yokoten knows about OpenAI's Codex CLI: the shape of its PreToolUse and Stop events, and where
// its project and user hooks live. Source: https://developers.openai.com/codex/hooks
//
// Codex runs a project's hooks only after the user trusts the project's .codex/ folder
// and reviews the hook (`/hooks`). It records trust against the hook's hash, so a changed
// command has to be trusted again.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { guardCommand, missingProjectRuntime } from '../run/cli.ts';
import type { Action } from '../run/hook.ts';
import { type Added, addHook, hasHook } from './hooks-file.ts';

// The docs: "Bash and apply_patch use tool_input.command", and unified exec reports as Bash.
const SHELL = 'Bash';

/** The files an apply_patch envelope adds, updates, deletes or moves to. */
function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)[ \t]*$/gm)].map((m) => m[1]);
}

/**
 * A PreToolUse call, as an Action. A shell call's `tool_input.command` is the command; an
 * apply_patch call's `tool_input.command` is the patch, and its file headers are the paths.
 * Any other tool (MCP, update_plan) is neither.
 */
export function readToolCall(input: unknown): Action {
  const call = (input ?? {}) as { cwd?: unknown; tool_name?: unknown; tool_input?: unknown; agent_type?: unknown };
  const tool = (typeof call.tool_input === 'object' && call.tool_input !== null ? call.tool_input : {}) as Record<string, unknown>;
  const name = typeof call.tool_name === 'string' ? call.tool_name : '';
  const command = typeof tool.command === 'string' ? tool.command : undefined;
  return {
    command: name === SHELL ? command : undefined,
    paths: name === 'apply_patch' && command ? patchPaths(command) : [],
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
  addHook(projectHooks(root), 'PreToolUse', 'Bash|apply_patch', guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --agent codex', missingProjectRuntime(cli), { isToolCall: true }));
export const hasProjectHook = (root: string): boolean => hasHook(projectHooks(root), 'PreToolUse', 'hook');

/**
 * The project's stop check (#211): Codex's Stop event takes no matcher. Its input has
 * `cwd` and `stop_hook_active`, as Claude Code's does; exit 2 with a reason on stderr
 * makes the agent go on.
 */
export const addProjectStopHook = (root: string, cli: string) =>
  addHook(projectHooks(root), 'Stop', undefined, guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --stop --agent codex', missingProjectRuntime(cli)));
export const hasProjectStopHook = (root: string): boolean => hasHook(projectHooks(root), 'Stop', 'hook');

/** A Stop event: the same fields as Claude Code's (`cwd`, `stop_hook_active`). */
export { readStop } from './claude-code.ts';

const userHooks = (env: Env) => join(env.HOME || homedir(), '.codex', 'hooks.json');

/**
 * The user's hooks, in every repo: doctor at session start, and the command guard on
 * shell calls. Codex adds a SessionStart hook's plain stdout to the agent's context.
 * `missing` is what they say when `cli` is gone.
 */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  return {
    doctor: addHook(userHooks(env), 'SessionStart', undefined, guardCommand(cli, 'doctor --session --agent codex', missing, { isSessionStart: true })),
    guard: addHook(userHooks(env), 'PreToolUse', SHELL, guardCommand(cli, 'hook --agent codex --commands-only', missing, { isToolCall: true })),
  };
}
