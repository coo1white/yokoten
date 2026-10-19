// What yokoten knows about Google's Gemini CLI: the shape of its BeforeTool call and where
// its project hooks live. Source: https://geminicli.com/docs/hooks/ (reference, and the
// tools pages for each tool's arguments).
//
// Gemini CLI fingerprints a project hook by its name and command, and warns once before
// it first runs a new or changed one.

import { join } from 'node:path';
import { guardCommand, missingProjectRuntime } from '../run/cli.ts';
import type { Action } from '../run/hook.ts';
import { addHook, hasHook } from './hooks-file.ts';

// run_shell_command takes `command`; write_file and replace take `file_path`.
const SHELL = 'run_shell_command';
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
    // A BeforeTool call names no subagent type; YOKOTEN_ROLE decides.
    worker: false,
  };
}

const projectSettings = (root: string) => join(root, '.gemini', 'settings.json');

/**
 * The project's tool-call guard. GEMINI_PROJECT_DIR is the folder Gemini CLI was started
 * in, not a repo root. Gemini (v0.64.0) puts it into the command text already shell-quoted,
 * so the command leaves it unquoted, as the docs example does: quoting it again breaks a
 * path with a space, and the hook would fail open. An older quoted hook is updated in place.
 */
export const addProjectHook = (root: string, cli: string) =>
  addHook(projectSettings(root), 'BeforeTool', 'run_shell_command|write_file|replace', guardCommand(`$GEMINI_PROJECT_DIR/${cli}`, 'hook --agent gemini', missingProjectRuntime(cli)), {
    name: 'yokoten',
  });
export const hasProjectHook = (root: string): boolean => hasHook(projectSettings(root), 'BeforeTool', 'hook');
