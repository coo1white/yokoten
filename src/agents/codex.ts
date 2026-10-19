// What yokoten knows about OpenAI's Codex CLI: the shape of its PreToolUse call and where
// its project hooks live. Source: https://developers.openai.com/codex/hooks
//
// Codex runs a project's hooks only after the user trusts the project's .codex/ folder
// and reviews the hook (`/hooks`). It records trust against the hook's hash, so a changed
// command has to be trusted again.

import { isAbsolute, join, resolve, sep } from 'node:path';
import { guardCommand, missingProjectRuntime } from '../run/cli.ts';
import type { Action } from '../run/hook.ts';
import { addHook, hasHook } from './hooks-file.ts';

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
  addHook(projectHooks(root), 'PreToolUse', 'Bash|apply_patch', guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --agent codex', missingProjectRuntime(cli)));
export const hasProjectHook = (root: string): boolean => hasHook(projectHooks(root), 'PreToolUse', 'hook');
