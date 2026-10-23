// What yokoten knows about OpenCode: the shape of a tool call, how a plugin blocks it,
// and where the plugin file lives. Source: the plugins page at opencode.ai/docs/plugins.
// No OpenCode binary was run. That page was the only source.
//
// What that page shows:
// - OpenCode loads plugins from `.opencode/plugins/` and `~/.config/opencode/plugins/`.
// - A plugin exports an async function. `tool.execute.before` runs before a tool call.
// - `input.tool` is the tool name. `output.args` holds the arguments.
// - Throwing an Error blocks the call. The message is what the model reads.
// - The shell tool is `shell` (`output.args.command`). Older OpenCode names it `bash`.
// - File tools take `output.args.filePath`. `write`, `edit` and `patch` are edits.
// - `session.idle` is the closest stop event. It has no loop guard, so there is no stop hook.
//
// The plugin runs `yokoten hook` through `guardCommand`. Exit 2 throws the reason on stderr.
// Exit 1 lets the call go on: the runtime or node is missing (#260). Any other failure, or a
// timeout, refuses the call.
//
// This file sits in `small/` because `src/agents/runtimes/` was already at the folder cap of 7.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from '../../../rules/config.ts';
import { homeIn, homeOf } from '../../../rules/privacy.ts';
import { guardCommand, missingProjectRuntime } from '../../../run/cli.ts';
import type { Action } from '../../../run/hook.ts';
import type { RuntimeEnv } from '../../desk/agent-env.ts';
import { isFolder } from '../../folder-trust.ts';
import { type Added, type HookState, isObject, type Problem, UnreadableHooksFile } from '../../hooks-file.ts';

/** The project plugin `init` writes. OpenCode loads every file in this folder at startup. */
export const PLUGIN_FILE = '.opencode/plugins/yokoten.ts';

/** How long the plugin waits for the guard, in milliseconds. Past this, the call is refused. */
export const PLUGIN_TIMEOUT_MS = 60000;

/** What the plugin throws when the guard cannot answer: a crash, a signal, or a timeout. */
export const GUARD_FAILED = "yokoten's guard failed, so this call is refused; run `yokoten doctor`";

// `shell` is the name in the docs. `bash` is the older name. Both are the shell.
const SHELL = new Set(['shell', 'bash']);
// File tools that write. A read is not one of these, so it is not an edit.
const EDITS = new Set(['write', 'edit', 'patch']);

/** A problem reading the plugin: it is there, but not text yokoten can replace. */
const UNREADABLE: Problem = { kind: 'shape', hint: 'the plugin file should be readable text' };

/**
 * A tool call, as an Action. `shell` and `bash` give the command. `write`, `edit` and
 * `patch` give the file. Anything else is neither. The call names no subagent role.
 */
export function readToolCall(input: unknown): Action {
  const call = isObject(input) ? input : {};
  const args = isObject(call.args) ? call.args : {};
  const name = typeof call.tool === 'string' ? call.tool : '';
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  const file = text(args.filePath);
  return {
    command: SHELL.has(name) ? text(args.command) : undefined,
    paths: EDITS.has(name) && file ? [file] : [],
    cwd: text(call.directory),
    worker: false,
  };
}

/**
 * How a refusal reaches OpenCode. The plugin throws the reason, which the hook already
 * writes on stderr, and exits 2. Stdout stays empty, so the plugin does not read it twice.
 */
export const formatDenial = (reason: string): { stdout: string; exitCode: number } => ({
  stdout: reason.slice(0, 0),
  exitCode: 2,
});

/**
 * The plugin text. `command` is the shell line that runs the guard (`guardCommand`).
 * The call goes to that line as JSON on stdin. Exit 0 and exit 1 let the call go on.
 * Exit 2 throws the guard's reason. A crash, a signal or a timeout throws `GUARD_FAILED`.
 */
export function pluginSource(command: string, timeoutMs = PLUGIN_TIMEOUT_MS): string {
  const wait = Number.isFinite(timeoutMs) && timeoutMs >= 1 ? Math.floor(timeoutMs) : PLUGIN_TIMEOUT_MS;
  const lines = [
    "import { spawnSync } from 'node:child_process';",
    '',
    'export const Yokoten = async ({ directory }) => ({',
    "  'tool.execute.before': async (input, output) => {",
    "    const tool = input && typeof input.tool === 'string' ? input.tool : '';",
    "    const args = output && output.args && typeof output.args === 'object' ? output.args : {};",
    "    const folder = typeof directory === 'string' ? directory : undefined;",
    '    const payload = JSON.stringify({ tool, args, directory: folder });',
    `    const result = spawnSync('bash', ['-c', ${JSON.stringify(command)}], {`,
    '      input: payload,',
    "      encoding: 'utf8',",
    `      timeout: ${wait},`,
    '      cwd: folder,',
    '    });',
    `    const failed = ${JSON.stringify(GUARD_FAILED)};`,
    '    const refused = result.error || result.status === null || (result.status !== 0 && result.status !== 1);',
    '    if (!refused) return;',
    "    const reason = !result.error && result.status !== null ? String(result.stderr ?? '').trim() : failed;",
    '    throw new Error(reason || failed);',
    '  },',
    '});',
    '',
  ];
  return lines.join('\n');
}

/** The project's guard: the repo's own yokoten, so a file edit is judged too. */
const projectCommand = (cli: string) =>
  guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --agent opencode', missingProjectRuntime(cli), { isToolCall: true });

/** The user's command guard, in every repo. `missing` is what it says when `cli` is gone. */
const userCommand = (cli: string, missing: string) => guardCommand(cli, 'hook --agent opencode --commands-only', missing, { isToolCall: true });

/** The plugin's text, or why yokoten will not replace it. A missing file is empty text. */
function readPlugin(path: string): { text: string } | { problem: Problem } {
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '' };
    return { problem: UNREADABLE };
  }
}

/** What writing `source` over the plugin at `path` would do, read-only. */
function pluginState(path: string, source: string): HookState {
  const read = readPlugin(path);
  if ('problem' in read) return read.problem;
  if (read.text === '') return 'added';
  return read.text === source ? 'same' : 'updated';
}

/** Write `source` over the plugin at `path`. A file yokoten cannot read throws and stays as it was. */
function writePlugin(path: string, source: string): Added {
  const state = pluginState(path, source);
  if (typeof state === 'object') throw new UnreadableHooksFile(path, state);
  if (state === 'same') return state;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return state;
}

/** What `addProjectPlugin` would do, read-only. */
export const projectPluginState = (root: string, cli: string): HookState => pluginState(join(root, PLUGIN_FILE), pluginSource(projectCommand(cli)));

/** Write the tool-call plugin into `.opencode/plugins/yokoten.ts`. */
export const addProjectPlugin = (root: string, cli: string): Added => writePlugin(join(root, PLUGIN_FILE), pluginSource(projectCommand(cli)));

/** True when the project looks set up for OpenCode: `opencode.json`, or a `.opencode` folder. */
export const usesOpenCode = (root: string): boolean => existsSync(join(root, 'opencode.json')) || existsSync(join(root, '.opencode'));

/** OpenCode's config folder: `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`. */
const configDir = (env: Env): string => join(env.XDG_CONFIG_HOME || join(homeIn(env), '.config'), 'opencode');

/** The user plugin, as the user would type it. */
export const userPluginFile = (env: Env): string => (env.XDG_CONFIG_HOME ? '$XDG_CONFIG_HOME/opencode/plugins/yokoten.ts' : '~/.config/opencode/plugins/yokoten.ts');

/** The user plugin's path on disk. With no home folder, and no XDG dir, it throws NO_HOME. */
const userPluginPath = (env: Env): string => join(configDir(env), 'plugins', 'yokoten.ts');

/** Whether OpenCode looks used on this machine: its config folder is there. */
export function hasUserDir(env: Env): boolean {
  try {
    const home = homeOf(env);
    const base = env.XDG_CONFIG_HOME || (home ? join(home, '.config') : '');
    return base !== '' && isFolder(join(base, 'opencode'));
  } catch {
    return false;
  }
}

/** What `addUserPlugin` would do, read-only. */
export const userPluginState = (env: Env, cli: string, missing: string): HookState => pluginState(userPluginPath(env), pluginSource(userCommand(cli, missing)));

/** The user's command guard, in `~/.config/opencode/plugins/yokoten.ts`. */
export const addUserPlugin = (env: Env, cli: string, missing: string): Added => writePlugin(userPluginPath(env), pluginSource(userCommand(cli, missing)));

/** The names this runtime's agent gets on top of the shared ones. OpenCode's login name was not in the docs. */
export const AGENT_ENV: RuntimeEnv = { login: [], config: [] };
