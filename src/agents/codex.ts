// What yokoten knows about OpenAI's Codex CLI: the shape of its PreToolUse and Stop events, and where
// its project and user hooks live. Source: https://developers.openai.com/codex/hooks
//
// Codex runs a project's hooks only after the user trusts the project's .codex/ folder
// and reviews the hook (`/hooks`). It records trust against the hook's hash, so a changed
// command has to be trusted again.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Env } from '../rules/config.ts';
import { guardCommand, missingProjectRuntime } from '../run/cli.ts';
import type { Action } from '../run/hook.ts';
import { type Added, addHook, hasHook, type HookArgs, type HookState, hookState } from './hooks-file.ts';

// The docs: "Bash and apply_patch use tool_input.command", and unified exec reports as Bash.
const SHELL = 'Bash';

/** The files an apply_patch envelope adds, updates, deletes or moves to. */
function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)[ \t]*$/gm)].map((m) => m[1]);
}

// A file header anywhere in a shell command: at a line start, or after a written `\n`
// (as in `printf '*** Begin Patch\n*** Add File: a\n'`). A `+` line is patch content.
const SHELL_HEADER = /(?:^|\\n)[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): ([^\n]+?)[ \t]*(?=\\n|$)/gm;
// A `cd`, `pushd`, `env -C` or `--chdir`, quoted or bare. Group 1, 2 or 3 is the dir.
const DIR_CHANGE = /(?:^|[\s;&|(`'"])(?:cd|pushd|-C|--chdir)[\s=]+(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/g;

/**
 * The files a shell command's apply_patch may touch. Codex sends a shell-run apply_patch
 * as a Bash call and fires no second hook (rust-v0.163.0). The shell can reach apply_patch
 * in many ways (`command apply_patch`, `FOO=1 apply_patch`, `| apply_patch`), so when the
 * command names apply_patch at all, every file header in it counts. A command that does
 * not, such as `cat > notes.md <<'EOF'`, only writes data. This errs toward refusing.
 *
 * The shell may change dir first. Each relative path counts from the session's cwd and
 * from every dir the command changes to. A dir only the shell knows (`~`, `-`, `$X`) may
 * be any folder above: then the path counts from each of those too, the repo root among them.
 */
function shellPatchPaths(command: string, cwd: string | undefined): string[] {
  if (!/apply_?patch/.test(command)) return [];
  const dirs = [...command.matchAll(DIR_CHANGE)].map((m) => m[1] ?? m[2] ?? m[3]);
  const knownDirs = dirs.filter((dir) => dir !== '' && !/^[~-]|\$/.test(dir));
  if (cwd && knownDirs.length < dirs.length) {
    const depth = resolve(cwd).split(sep).filter(Boolean).length;
    for (let up = 1; up <= depth; up++) knownDirs.push('../'.repeat(up));
  }
  const paths: string[] = [];
  for (const [, path] of command.matchAll(SHELL_HEADER)) {
    paths.push(path);
    if (!isAbsolute(path)) paths.push(...knownDirs.map((dir) => join(dir, path)));
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
  const cwd = typeof call.cwd === 'string' && call.cwd !== '' ? call.cwd : undefined;
  return {
    command: name === SHELL ? command : undefined,
    paths: !command ? [] : name === 'apply_patch' ? patchPaths(command) : name === SHELL ? shellPatchPaths(command, cwd) : [],
    cwd,
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

/** The two user hooks, as `addHook`'s arguments: one builder for `addUserHooks` and `userHooksState`. */
const userHookArgs = (env: Env, cli: string, missing: string): Record<'doctor' | 'guard', HookArgs> => ({
  doctor: [userHooks(env), 'SessionStart', undefined, guardCommand(cli, 'doctor --session --agent codex', missing, { isSessionStart: true })],
  guard: [userHooks(env), 'PreToolUse', SHELL, guardCommand(cli, 'hook --agent codex --commands-only', missing, { isToolCall: true })],
});

/**
 * The user's hooks, in every repo: doctor at session start, and the command guard on
 * shell calls. Codex adds a SessionStart hook's plain stdout to the agent's context.
 * `missing` is what they say when `cli` is gone.
 */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  const args = userHookArgs(env, cli, missing);
  return { doctor: addHook(...args.doctor), guard: addHook(...args.guard) };
}

/** Whether Codex looks used on this machine: its user folder, ~/.codex, is a folder. */
export function hasUserDir(env: Env): boolean {
  try {
    return statSync(dirname(userHooks(env))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The user's hooks against what `addUserHooks` would write with the same `cli` and
 * `missing`, read-only (see `hookState`): a hook with another command, matcher or runtime
 * path is 'updated', one not there is 'added'.
 */
export function userHooksState(env: Env, cli: string, missing: string): { doctor: HookState; guard: HookState } {
  const args = userHookArgs(env, cli, missing);
  return { doctor: hookState(...args.doctor), guard: hookState(...args.guard) };
}
