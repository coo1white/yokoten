// What yokoten knows about OpenCode: the shape of a tool call, how a plugin blocks it,
// and where the plugin file lives.
//
// OpenCode 2, from opencode.ai/v2/docs/build/plugins and probes on 2.1.4:
// - The default export is Plugin.define({ id, setup(ctx) }) from '@opencode/plugin'.
//   OpenCode resolves that import itself.
// - ctx.permission.hook('evaluate', ...) runs for allow and ask. Set event.effect to
//   'deny' and event.message to the reason. That is the documented refusal.
// - Do not wait on the hook call. Waiting on permission.hook hung a 2.1.4 run.
//   A call that does not wait still registers.
// - ctx.shell.hook('create.before', ...) sees command, cwd and env. A throw is only a
//   backup. The docs do not say that a throw blocks the shell.
// - ctx.tool.hook('execute.before') sees the code tool, not a shell started from inside
//   it. This plugin does not use that hook.
//
// OpenCode 1 still loads server(). tool.execute.before throws to block a call.
// input.tool is the tool name. output.args holds the arguments.
//
// Not known, so the reader fails closed (see readToolCall):
// - The action string for a shell call. This tries bash and shell.
// - The action string for a file write. This tries edit, write and patch.
// - Whether resources holds the command text or the file paths.
// A known shell reads the command from resources, then metadata.command, then metadata.input.
// An unknown action is judged on every command field: metadata.command, metadata.input,
// metadata.input.command, metadata.input.code, and each resource. One refusal blocks it.
// OpenCode 1 reads command and code from any tool, and filePath, path and file_path.
// An action that is not plainly read-only, with no command and no path, is refused
// in the plugin. An empty Action would let the hook allow it.
//
// The plugin runs yokoten hook through guardCommand. The call is JSON on stdin.
// Exit 2 denies with stderr. Exit 0 and exit 1 let the call go on.
// A crash, a signal or a timeout denies.

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

/** What the plugin says when an evaluate event has no command and no path. */
export const UNREADABLE_CALL = 'yokoten could not read this OpenCode call, so it is refused; run `yokoten doctor`';

// Shared with the emitted plugin, so the two readers keep the same names.
const SHELL_ACTIONS = ['shell', 'bash'];
const EDIT_ACTIONS = ['write', 'edit', 'patch'];
const READ_ACTIONS = ['read', 'glob', 'grep', 'list', 'search'];
const SHELL = new Set(SHELL_ACTIONS);
const EDITS = new Set(EDIT_ACTIONS);
const READS = new Set(READ_ACTIONS);

/** A problem reading the plugin: it is there, but not text yokoten can replace. */
const UNREADABLE: Problem = { kind: 'shape', hint: 'the plugin file should be readable text' };

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const asRecord = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

const stringList = (value: unknown): string[] => {
  if (typeof value === 'string' && value !== '') return [value];
  if (!Array.isArray(value)) return [];
  const found: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '') found.push(item);
  }
  return found;
};

/** The command text: one resource, or several joined; else metadata, else metadata.input. */
const commandText = (resources: string[], metadata: Record<string, unknown>): string | undefined => {
  if (resources.length === 1) return resources[0];
  if (resources.length > 1) return resources.join(' ');
  const named = textOf(metadata.command);
  if (named !== undefined) return named;
  const input = metadata.input;
  const direct = textOf(input);
  if (direct !== undefined) return direct;
  return textOf(asRecord(input).command);
};

/**
 * Every command-like string on an action that is not a known shell or edit.
 * A benign resource must not hide a command in another field. Each one is judged
 * on its own. The guard refuses the call when any of them is refused.
 */
const unknownCommands = (resources: string[], metadata: Record<string, unknown>): string[] => {
  const input = metadata.input;
  const nested = asRecord(input);
  const found: string[] = [];
  const add = (value: string | undefined) => {
    if (value !== undefined && !found.includes(value)) found.push(value);
  };
  add(textOf(metadata.command));
  add(textOf(input));
  add(textOf(nested.command));
  add(textOf(nested.code));
  for (const item of resources) add(item);
  return found;
};

/** One file from metadata, when resources are not the paths. */
const filePathOf = (metadata: Record<string, unknown>): string | undefined => {
  const input = asRecord(metadata.input);
  return textOf(metadata.filePath) ?? textOf(metadata.path) ?? textOf(input.filePath) ?? textOf(input.path) ?? textOf(input.file_path);
};

const pathList = (resources: string[], metadata: Record<string, unknown>, useResources: boolean): string[] => {
  if (useResources && resources.length > 0) return resources;
  const file = filePathOf(metadata);
  return file !== undefined ? [file] : [];
};

/** A resource with no shell marks that looks like a file. Used only when the action is unknown. */
const looksLikePath = (value: string): boolean => !/[\s;&|`$<>]/.test(value) && (value.includes('/') || value.includes('\\') || value.startsWith('.'));

const hasShellMark = (value: string): boolean => /[\s;&|`$<>]/.test(value);

interface ReadEvent {
  command?: string;
  /** Set when the action carries more than one command. Each entry is judged alone. */
  commands?: string[];
  paths: string[];
  cwd?: string;
  /** skip: plainly read-only. deny: nothing to judge. ask: send it to the guard. */
  kind: 'skip' | 'ask' | 'deny';
}

/** An evaluate event, read the same way the emitted plugin decides skip, ask or deny. */
function readEvaluate(call: Record<string, unknown>): ReadEvent {
  const name = (textOf(call.action) ?? '').trim().toLowerCase();
  const metadata = asRecord(call.metadata);
  const resources = stringList(call.resources);
  const cwd = textOf(call.directory) ?? textOf(call.cwd);
  if (READS.has(name)) return { paths: [], cwd, kind: 'skip' };
  if (SHELL.has(name)) {
    const command = commandText(resources, metadata);
    return { command, paths: [], cwd, kind: command === undefined ? 'deny' : 'ask' };
  }
  if (EDITS.has(name)) {
    const paths = pathList(resources, metadata, true);
    // A shell line filed as a path is still judged as a command.
    const command = commandText([], metadata) ?? paths.find(hasShellMark);
    const kind = paths.length === 0 && command === undefined ? 'deny' : 'ask';
    return { command, paths, cwd, kind };
  }
  const commands = unknownCommands(resources, metadata);
  const fromFields = pathList([], metadata, false);
  const fromResources = resources.filter(looksLikePath);
  const paths = [...fromResources, ...fromFields.filter((item) => !fromResources.includes(item))];
  const kind = commands.length === 0 && paths.length === 0 ? 'deny' : 'ask';
  // One command stays in `command`. Several stay apart, so a quote in one cannot hide the next.
  return {
    command: commands.length === 1 ? commands[0] : undefined,
    commands: commands.length > 1 ? commands : undefined,
    paths,
    cwd,
    kind,
  };
}

/**
 * A tool call, as an Action. OpenCode 1 sends `{ tool, args, directory }`.
 * OpenCode 2's evaluate event sends `{ action, resources, metadata }`.
 * Any other tool gives `command` and `code`, and a file from `filePath`, `path` or `file_path`.
 * A plainly read-only tool gives neither. So does a call with no command and no path:
 * the hook would allow that empty Action, so the plugin refuses it before the guard runs.
 * The call names no subagent role.
 */
export function readToolCall(input: unknown): Action {
  const call = isObject(input) ? input : {};
  if (typeof call.action === 'string' && typeof call.tool !== 'string') {
    const read = readEvaluate(call);
    return { command: read.command, ...(read.commands !== undefined ? { commands: read.commands } : {}), paths: read.paths, cwd: read.cwd, worker: false };
  }
  const args = isObject(call.args) ? call.args : {};
  const name = (typeof call.tool === 'string' ? call.tool : '').trim().toLowerCase();
  const cwd = textOf(call.directory) ?? textOf(call.cwd);
  if (READS.has(name)) return { command: undefined, paths: [], cwd, worker: false };
  const lines: string[] = [];
  const addLine = (value: string | undefined) => {
    if (value !== undefined && !lines.includes(value)) lines.push(value);
  };
  addLine(textOf(args.command));
  addLine(textOf(args.code));
  const file = textOf(args.filePath) ?? textOf(args.path) ?? textOf(args.file_path);
  // A shell line filed as a path is still judged as a command.
  if (file !== undefined && hasShellMark(file)) addLine(file);
  const many = lines.length > 1 ? lines : undefined;
  return {
    command: lines.length === 1 ? lines[0] : undefined,
    ...(many !== undefined ? { commands: many } : {}),
    paths: file !== undefined ? [file] : [],
    cwd,
    worker: false,
  };
}

/**
 * How a refusal reaches OpenCode. The plugin reads the reason on stderr and exits 2.
 * Stdout stays empty, so the plugin does not read it twice.
 */
export const formatDenial = (reason: string): { stdout: string; exitCode: number } => ({
  stdout: reason.slice(0, 0),
  exitCode: 2,
});

/**
 * The plugin text. `command` is the shell line that runs the guard (`guardCommand`).
 * The call goes to that line as JSON on stdin. Exit 0 and exit 1 let the call go on.
 * Exit 2 denies with the guard's reason. A crash, a signal or a timeout denies.
 * OpenCode 2 registers in setup. OpenCode 1 uses server().
 */
export function pluginSource(command: string, timeoutMs = PLUGIN_TIMEOUT_MS): string {
  const wait = Number.isFinite(timeoutMs) && timeoutMs >= 1 ? Math.floor(timeoutMs) : PLUGIN_TIMEOUT_MS;
  const body = `
    import { spawnSync } from 'node:child_process';
    import { Plugin } from '@opencode/plugin';

    const guardLine = ${JSON.stringify(command)};
    const waitMs = ${wait};
    const failed = ${JSON.stringify(GUARD_FAILED)};
    const unreadable = ${JSON.stringify(UNREADABLE_CALL)};
    const reads = new Set(${JSON.stringify(READ_ACTIONS)});
    const shells = new Set(${JSON.stringify(SHELL_ACTIONS)});
    const edits = new Set(${JSON.stringify(EDIT_ACTIONS)});

    const text = (value) => (typeof value === 'string' && value !== '' ? value : undefined);
    const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const list = (value) => {
      if (typeof value === 'string' && value !== '') return [value];
      if (!Array.isArray(value)) return [];
      return value.filter((item) => typeof item === 'string' && item !== '');
    };

    const commandOf = (resources, metadata) => {
      if (resources.length === 1) return resources[0];
      if (resources.length > 1) return resources.join(' ');
      const meta = record(metadata);
      const named = text(meta.command);
      if (named) return named;
      const input = meta.input;
      const direct = text(input);
      if (direct) return direct;
      return text(record(input).command);
    };

    // An unknown action: every command-like field, so one benign resource cannot hide code.
    const commandFields = (resources, metadata) => {
      const meta = record(metadata);
      const input = meta.input;
      const nested = record(input);
      const found = [];
      const add = (value) => {
        const item = text(value);
        if (item && !found.includes(item)) found.push(item);
      };
      add(meta.command);
      add(text(input));
      add(nested.command);
      add(nested.code);
      for (const item of list(resources)) add(item);
      return found;
    };

    const pathsOf = (resources, metadata, fromResources) => {
      if (fromResources && resources.length > 0) return resources;
      const meta = record(metadata);
      const input = record(meta.input);
      const file = text(meta.filePath) || text(meta.path) || text(input.filePath) || text(input.path) || text(input.file_path);
      return file ? [file] : [];
    };

    const kindOf = (action, resources, metadata) => {
      const name = typeof action === 'string' ? action.trim().toLowerCase() : '';
      const items = list(resources);
      if (reads.has(name)) return 'skip';
      if (shells.has(name)) return commandOf(items, metadata) ? 'ask' : 'deny';
      if (edits.has(name)) {
        if (pathsOf(items, metadata, true).length > 0) return 'ask';
        return commandOf([], metadata) ? 'ask' : 'deny';
      }
      if (commandFields(items, metadata).length > 0) return 'ask';
      return pathsOf([], metadata, false).length > 0 ? 'ask' : 'deny';
    };

    const ask = (payload, folder) => {
      const options = { input: JSON.stringify(payload), encoding: 'utf8', timeout: waitMs };
      const cwd = text(folder);
      if (cwd) options.cwd = cwd;
      const result = spawnSync('bash', ['-c', guardLine], options);
      const refused = Boolean(result.error) || result.status === null || (result.status !== 0 && result.status !== 1);
      if (!refused) return '';
      const reason = !result.error && result.status !== null ? String(result.stderr ?? '').trim() : failed;
      return reason || failed;
    };

    const rootOf = (ctx) => text(ctx && ctx.directory) || text(ctx && ctx.worktree);

    const onEvaluate = (root) => async (event) => {
      const call = record(event);
      const folder = text(call.cwd) || text(call.directory) || root;
      const kind = kindOf(call.action, call.resources, call.metadata);
      if (kind === 'skip') return;
      const payload = { action: typeof call.action === 'string' ? call.action : '', resources: call.resources, metadata: call.metadata, directory: folder };
      const reason = kind === 'deny' ? unreadable : ask(payload, folder);
      if (!reason) return;
      call.effect = 'deny';
      call.message = reason;
    };

    const onShell = (root) => (event) => {
      const call = record(event);
      const commandText = text(call.command);
      const folder = text(call.cwd) || root;
      if (!commandText) throw new Error(unreadable);
      const payload = { action: 'bash', resources: [commandText], metadata: { command: commandText }, directory: folder };
      const reason = ask(payload, folder);
      if (reason) throw new Error(reason);
    };

    export default {
      ...Plugin.define({
        id: 'yokoten',
        setup(ctx) {
          // Register only. OpenCode 2.1.4 hangs when setup waits on permission.hook.
          const root = rootOf(ctx);
          const permission = ctx && ctx.permission;
          const shell = ctx && ctx.shell;
          if (permission && typeof permission.hook === 'function') permission.hook('evaluate', onEvaluate(root));
          if (shell && typeof shell.hook === 'function') shell.hook('create.before', onShell(root));
        },
      }),
      async server(input) {
        const root = rootOf(input);
        return {
          'tool.execute.before': async (hookInput, output) => {
            const tool = hookInput && typeof hookInput.tool === 'string' ? hookInput.tool : '';
            const name = tool.trim().toLowerCase();
            if (reads.has(name)) return;
            const args = output && output.args && typeof output.args === 'object' && !Array.isArray(output.args) ? output.args : {};
            const command = text(args.command) || text(args.code);
            const file = text(args.filePath) || text(args.path) || text(args.file_path);
            if (!command && !file) throw new Error(unreadable);
            const reason = ask({ tool, args, directory: root }, root);
            if (reason) throw new Error(reason);
          },
        };
      },
    };
  `;
  return `${body.replace(/^ {4}/gm, '').trim()}\n`;
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
