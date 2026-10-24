// What yokoten knows about Google's Gemini CLI: the shape of its BeforeTool and AfterAgent events, and where
// its project and user hooks live. Source: https://geminicli.com/docs/hooks/ (reference, and the
// tools pages for each tool's arguments).
//
// Gemini CLI fingerprints a project hook by its name and command, and warns once before
// it first runs a new or changed one.
//
// Gemini CLI reads settings.json with comments allowed (packages/cli/src/config/settings.ts,
// `JSON.parse(stripJsonComments(content))`), so yokoten reads it the same way. A file with
// comments is never rewritten, since that would drop them: a hook not there yet is printed
// for the user to add by hand (#258).

import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { releaseFix } from '../../rules/guard/guards.ts';
import { homeIn } from '../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import type { Action } from '../../run/hook.ts';
import { type Added, addHook, checkHooks, hasHook, type HookArgs, type HookState, hookState, isObject, type Problem, readTable, type ReadOptions, type Settings, writeSettings } from '../hooks-file.ts';
import type { RuntimeEnv } from '../desk/agent-env.ts';
import { readStop } from './claude-code.ts';
import type { AgentAdapter } from './runtime.ts';

/** How yokoten reads a Gemini CLI settings file: comments allowed, as Gemini CLI allows them. */
const READ: ReadOptions = { comments: true };

// run_shell_command takes `command`; write_file and replace take `file_path`.
const SHELL = 'run_shell_command';
// Milliseconds Gemini CLI waits for the stop check. Gemini reads `timeout` in
// milliseconds (its default is 60000). 600000 is 10 minutes, so the done-when
// command can finish (#614).
const STOP_TIMEOUT = 600_000;
const EDITS = new Set(['write_file', 'replace']);

/** A BeforeTool call, as an Action. Any other tool (read_file, MCP) is neither. */
export function readToolCall(input: unknown): Action {
  const call = (input ?? {}) as { cwd?: unknown; tool_name?: unknown; tool_input?: unknown };
  const tool = (typeof call.tool_input === 'object' && call.tool_input !== null ? call.tool_input : {}) as Record<string, unknown>;
  const name = typeof call.tool_name === 'string' ? call.tool_name : '';
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const file = text(tool.file_path);
  return {
    command: name === SHELL && typeof tool.command === 'string' ? tool.command : undefined,
    paths: EDITS.has(name) && file ? [file] : [],
    cwd: text(call.cwd),
    // A BeforeTool call names no subagent type; YOKOTEN_ROLE decides. Gemini's strict
    // environment sanitization removes YOKOTEN_ROLE, and then no session is a worker.
    worker: false,
  };
}

const projectSettings = (root: string) => join(root, '.gemini', 'settings.json');

/**
 * The two project hooks, as `addHook`'s arguments.
 *
 * - guard: the tool-call guard. GEMINI_PROJECT_DIR is the folder Gemini CLI was started
 *   in, not a repo root. Gemini (v0.64.0) puts it into the command text already
 *   shell-quoted, so the command leaves it unquoted, as the docs example does: quoting it
 *   again breaks a path with a space, and the hook would fail open. An older quoted hook
 *   is updated in place.
 * - stop: the stop check (#211, #614). Gemini's AfterAgent event runs when the agent ends
 *   its turn; its input has `cwd` and `stop_hook_active`, and exit 2 with a reason on
 *   stderr makes the agent try again. The timeout covers the done-when command.
 */
const projectHookArgs = (root: string, cli: string): Record<'guard' | 'stop', HookArgs> => ({
  guard: [projectSettings(root), 'BeforeTool', 'run_shell_command|write_file|replace', guardCommand(`$GEMINI_PROJECT_DIR/${cli}`, 'hook --agent gemini', missingProjectRuntime(cli), { isToolCall: true }), { name: 'yokoten' }, READ],
  stop: [projectSettings(root), 'AfterAgent', undefined, guardCommand(`$GEMINI_PROJECT_DIR/${cli}`, 'hook --stop --agent gemini', missingProjectRuntime(cli)), { name: 'yokoten-stop', timeout: STOP_TIMEOUT }, READ],
});

export const addProjectHook = (root: string, cli: string) => addHook(...projectHookArgs(root, cli).guard);
export const hasProjectHook = (root: string): boolean => hasHook(projectSettings(root), 'BeforeTool', 'hook', READ);
export const addProjectStopHook = (root: string, cli: string) => addHook(...projectHookArgs(root, cli).stop);
export const hasProjectStopHook = (root: string): boolean => hasHook(projectSettings(root), 'AfterAgent', 'hook', READ);

/**
 * Throw `UnreadableHooksFile` unless both project hooks can go in the file: check before
 * adding either. A file with comments and a hook missing throws both hooks to add by hand.
 */
export const checkProjectHooks = (root: string, cli: string): void => {
  const args = projectHookArgs(root, cli);
  checkHooks([args.guard, args.stop]);
};

/** The project hooks against what `init` would write with the same `cli`, read-only (see `hookState`). */
export function projectHooksState(root: string, cli: string): { guard: HookState; stop: HookState } {
  const args = projectHookArgs(root, cli);
  return { guard: hookState(...args.guard), stop: hookState(...args.stop) };
}

/** An AfterAgent event: the same fields as Claude Code's Stop (`cwd`, `stop_hook_active`). */
export { readStop };

/**
 * What a SessionStart hook prints: Gemini CLI reads the agent's context from JSON
 * (`hookSpecificOutput.additionalContext`), not from plain text.
 */
export const formatSessionContext = (text: string): string => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });

const userSettings = (env: Env) => join(homeIn(env), '.gemini', 'settings.json');

/** The two user hooks, as `addHook`'s arguments: one builder for `addUserHooks` and `userHooksState`. */
const userHookArgs = (env: Env, cli: string, missing: string): Record<'doctor' | 'guard', HookArgs> => ({
  doctor: [userSettings(env), 'SessionStart', undefined, guardCommand(cli, 'doctor --session --agent gemini', missing, { isSessionStart: true, sessionOutput: 'json' }), { name: 'yokoten-session' }, READ],
  guard: [userSettings(env), 'BeforeTool', SHELL, guardCommand(cli, 'hook --agent gemini --commands-only', missing, { isToolCall: true }), { name: 'yokoten-guard' }, READ],
});

/** The user's hooks, in every repo: doctor at session start, and the command guard on shell calls. `missing` is what they say when `cli` is gone. */
export function addUserHooks(env: Env, cli: string, missing: string): { doctor: Added; guard: Added } {
  const args = userHookArgs(env, cli, missing);
  checkHooks([args.doctor, args.guard]);
  return { doctor: addHook(...args.doctor), guard: addHook(...args.guard) };
}

/** Whether Gemini CLI looks used on this machine: its user folder, ~/.gemini, is a folder. */
export function hasUserDir(env: Env): boolean {
  try {
    return statSync(dirname(userSettings(env))).isDirectory();
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

// ---- The project's sandbox (#589) ----
//
// Gemini CLI reads `.gemini/settings.json` from the folder it starts in, and refuses YOLO
// mode (approve everything) when `security.disableYoloMode` is true: read in its own code
// (`settings.security?.disableYoloMode`, @google/gemini-cli 0.64.0). yokoten pins that. Its
// container sandbox (`tools.sandbox`) stays the user's own: `true` with neither Docker nor
// Podman installed is a fatal error, not a run without a sandbox, so no safe default fits
// every machine.

/** The project's sandbox file, relative to the root. */
export const SANDBOX_FILE = '.gemini/settings.json';

/** The sandbox block for a commented settings file, to add by hand. */
export const SANDBOX_HAND_ADD = '{"security": {"disableYoloMode": true}}';

/** The hook events init writes: the sandbox read respects their shape too, so a bad hooks table skips both. */
const PROJECT_EVENTS = ['BeforeTool', 'AfterAgent'];

/** The settings with a well-shaped `security` block, or the shape problem. */
function withSecurity(settings: Settings): { settings: Settings } | { problem: { kind: 'shape'; hint: string } } {
  if (settings.security !== undefined && !isObject(settings.security)) return { problem: { kind: 'shape', hint: '`security` should be an object' } };
  return { settings };
}

/**
 * Write the project's Gemini sandbox: `security.disableYoloMode` when it is missing, and
 * nothing else. `false` stays: the user's explicit choice is theirs. A commented file
 * without the key is `hand`: yokoten won't rewrite comments, so init prints what to add.
 */
export function addProjectSandbox(root: string): 'added' | 'same' | 'kept' | 'hand' | Problem {
  const path = projectSettings(root);
  const table = readTable(path, PROJECT_EVENTS, READ);
  if ('problem' in table) return table.problem;
  const shaped = withSecurity(table.settings);
  if ('problem' in shaped) return shaped.problem;
  const security = table.settings.security as Record<string, unknown> | undefined;
  if (security !== undefined && Object.hasOwn(security, 'disableYoloMode')) return security.disableYoloMode === true ? 'same' : 'kept';
  if (table.commented) return 'hand';
  table.settings.security = { ...security, disableYoloMode: true };
  writeSettings(path, table.settings);
  return 'added';
}

/**
 * The Gemini sandbox against what init writes, or null when YOLO mode is blocked: a
 * missing or allowed key, or a commented file that needs the block by hand.
 */
export function sandboxProblem(root: string): { what: string; fix: string } | null {
  const file = SANDBOX_FILE;
  const table = readTable(join(root, file), PROJECT_EVENTS, READ);
  if ('problem' in table) {
    // readTable never reports comments (only checkHooks builds that one): json or shape.
    const problem = table.problem as { kind: 'json' } | { kind: 'shape'; hint: string };
    return problem.kind === 'json'
      ? { what: `can't read ${file}`, fix: 'make it valid JSON, then run `yokoten init`' }
      : { what: `${file} has an unexpected shape`, fix: `${problem.hint}; fix it, then run \`yokoten init\`` };
  }
  const shaped = withSecurity(table.settings);
  if ('problem' in shaped) return { what: `${file} has an unexpected shape`, fix: `${shaped.problem.hint}; fix it, then run \`yokoten init\`` };
  const security = table.settings.security as Record<string, unknown> | undefined;
  if (security !== undefined && Object.hasOwn(security, 'disableYoloMode')) {
    return security.disableYoloMode === true ? null : { what: `Gemini YOLO mode is allowed in ${file}`, fix: `set security.disableYoloMode to true in ${file}` };
  }
  if (table.commented) return { what: `${file} has comments and no YOLO block`, fix: `add ${SANDBOX_HAND_ADD} to ${file} by hand` };
  return { what: `nothing blocks Gemini YOLO mode in ${file}`, fix: '`yokoten init` blocks it' };
}

/** The names this runtime's agent gets on top of the shared ones (#613). Gemini CLI: only its own key. GOOGLE_API_KEY and GOOGLE_APPLICATION_CREDENTIALS open all of Google Cloud, so a Vertex AI setup needs the lead to pass them on purpose. */
export const AGENT_ENV: RuntimeEnv = { login: ['GEMINI_API_KEY'], config: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI'] };

const approve = (start: string) => `\`YOKOTEN_RELEASE_APPROVAL=1 ${start}\``;

/** The contract every adapter fills (#395). */
export const ADAPTER: AgentAdapter = {
  name: 'gemini',
  label: 'Gemini CLI',
  projectHook: '`.gemini/settings.json`: BeforeTool and AfterAgent',
  userHook: '~/.gemini/settings.json',
  blocking: 'exit 2, the reason on stderr',
  capabilities: { canRewrite: false, hasStopHook: true, needsTrust: true, failsOpen: false, passesRole: false },
  readToolCall,
  readStop,
  releaseFix: releaseFix(`${approve('gemini')} (if its strict environment sanitization is on, the variable is dropped: the owner releases outside Gemini CLI)`),
  agentEnv: AGENT_ENV,
  call: (command) => ({ cwd: '/repo', tool_name: 'run_shell_command', tool_input: { command } }),
};
