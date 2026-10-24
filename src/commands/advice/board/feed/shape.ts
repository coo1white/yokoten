// The framework's standard for an agent's session (#698). Every vendor's reader maps
// its log onto these kinds and these tool names. The page draws only this. A new
// vendor is one reader, and nothing else.

import type { Refusal } from '../../../../rules/message.ts';

/** The tool names the board shows, whoever ran the tool. */
export const TOOL_NAMES = ['Bash', 'Read', 'Edit', 'Write', 'Search', 'Web', 'Agent', 'Other'] as const;

/** One name from {@link TOOL_NAMES}. */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * One thing an agent did, the same for every vendor.
 * `say` is the agent's own words. `think` is a reasoning summary.
 * `tool` is one step: `tool` is the common name, and `text` is the short note or the command.
 * `result` is that step's output. `stop` is a call the guard refused.
 */
export interface StreamItem {
  kind: 'say' | 'think' | 'tool' | 'result' | 'stop';
  text: string;
  /** On a stop, the refusal by its parts when the text has them (#707). */
  refusal?: Refusal;
  /** The common tool name, on a tool step. */
  tool?: ToolName;
  /** True when `text` is a command, shown in monospace. */
  isCommand?: boolean;
  /** True when the step failed. The page draws a red dot. */
  isFailed?: boolean;
  /** The whole call, on a tool step. The page keeps it closed. */
  full?: string;
  /** The call, as the runtime names it. tail.ts numbers it before it leaves. */
  call?: string;
  /** When, as an ISO time, or '' when the log does not say. */
  time: string;
}

/** The runtimes whose session log the board reads, and `plain`, a runner's own text log. */
export type StreamSource = 'claude' | 'muse' | 'grok' | 'codex' | 'plain';

/** A vendor's own tool name as one common name. The first match wins. */
export function commonTool(name: string): ToolName {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (/^(?:bash|shell|exec_command|exec|run_terminal_command|run_command|terminal)$/.test(key)) return 'Bash';
  if (/web|fetch_url|browse/.test(key)) return 'Web';
  if (/search_replace|str_replace|apply_patch|edit|patch|replace/.test(key)) return 'Edit';
  if (/grep|glob|search|find_file|rg/.test(key)) return 'Search';
  if (/^write|create_file/.test(key)) return 'Write';
  if (/read|view_file|^cat$|open_file/.test(key)) return 'Read';
  if (/agent|subagent|^task$|spawn/.test(key)) return 'Agent';
  return 'Other';
}
