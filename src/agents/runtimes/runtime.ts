// One contract every agent adapter fills (#395). An adapter says how its runtime reads a
// tool call, how a refusal reaches the agent, whether it can change a command, where its
// project and user hooks live, and what it can and cannot do. The core asks this table,
// never an agent's name: a new agent is one new file that fills the contract and passes
// the conformance suite in test/agents/runtimes/runtime.test.ts.
//
// The guide's "Works with" table is generated here from the same capabilities, plus the
// dated end-to-end notes. A test fails when docs/guide.md and this module differ.

import type { Env } from '../../rules/config.ts';
import type { Action, StopEvent } from '../../run/hook.ts';
import type { RuntimeEnv } from '../desk/agent-env.ts';
import type { RuntimeDesk } from '../desk/desk.ts';
import { ADAPTER as CLAUDE_CODE } from './claude-code.ts';
import { ADAPTER as CODEX } from './codex.ts';
import { ADAPTER as GEMINI } from './gemini.ts';
import { ADAPTER as GROK } from './grok.ts';
import { ADAPTER as MUSE } from './muse.ts';
import { ADAPTER as ANTIGRAVITY } from './small/antigravity.ts';
import { ADAPTER as DEEPSEEK_HARNESS } from './small/deepseek-harness.ts';
import { ADAPTER as OPENCODE } from './small/opencode.ts';

/** What an adapter can do. A case it cannot do names its fallback in the conformance suite. */
export interface Capabilities {
  /** The hook can change a command before it runs (`formatRewrite`). */
  canRewrite: boolean;
  /** The runtime sends an event at the end of a turn (`readStop`). */
  hasStopHook: boolean;
  /** The runtime runs project hooks only in a folder the owner trusted. */
  needsTrust: boolean;
  /** A hook that fails or times out lets the call go on. */
  failsOpen: boolean;
  /** The runtime passes `YOKOTEN_ROLE` to its hook. */
  passesRole: boolean;
}

/** The contract one runtime fills: its shape, its refusal, its hooks and its capabilities. */
export interface AgentAdapter {
  /** The name `--agent` takes. */
  name: string;
  /** The agent's name in the guide. */
  label: string;
  /** The project hook file `init` writes, and the events it holds, as the guide says it. */
  projectHook: string;
  /** The user hook file `install` writes, or null when it writes none. */
  userHook: string | null;
  /** How a refusal reaches the agent, as the guide says it. */
  blocking: string;
  capabilities: Capabilities;
  /** How the runtime sends a tool call, as the Action the guard reads. */
  readToolCall: (input: unknown) => Action;
  /** The end of a turn, when the runtime has one. */
  readStop?: (input: unknown) => StopEvent | null;
  /** The refusal this runtime reads, or absent: the core writes the reason on stderr and exits 2. */
  formatDenial?: (reason: string, env?: Env) => { stdout: string; exitCode: number };
  /** Text added to the agent's context by an allowed tool call, when the runtime takes it. */
  formatContext?: (text: string) => string;
  /** A question shown before a call runs, when the runtime has such a decision. */
  formatAsk?: (reason: string) => string;
  /** The same command with its output wrapped for `yokoten redact`, when the runtime takes it. */
  formatRewrite?: (input: unknown, command: string, reason: string) => string;
  /** The fix a release refusal names for this runtime. */
  releaseFix: string;
  /** The environment names this runtime needs. */
  agentEnv: RuntimeEnv;
  /** The desk this runtime can start in, when it can. */
  desk?: RuntimeDesk;
  /**
   * One shell command in this runtime's own call shape, for the conformance suite. The
   * suite sends the same cases to every adapter; this is the one place a shape lives.
   */
  call: (command: string) => unknown;
}

/** Every runtime yokoten knows, in the order the `--agent` help names them. */
export const ADAPTERS: Readonly<Record<string, AgentAdapter>> = {
  'claude-code': CLAUDE_CODE,
  codex: CODEX,
  gemini: GEMINI,
  antigravity: ANTIGRAVITY,
  muse: MUSE,
  'deepseek-harness': DEEPSEEK_HARNESS,
  grok: GROK,
  opencode: OPENCODE,
};

/** The adapter for a `--agent` name, or undefined when no runtime has that name. */
export const adapterFor = (name: string): AgentAdapter | undefined => (Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined);

/** The refusal shape for a runtime: its own, or the core's fallback of the reason on stderr and exit 2. */
export function denialOf(name: string, reason: string): { stdout: string; exitCode: number } {
  const denial = adapterFor(name)?.formatDenial?.(reason);
  return denial ?? { stdout: '', exitCode: 2 };
}

/** The rewritten command for a runtime, or null when it cannot rewrite: the core then refuses a private read. */
export function rewriteOf(name: string, input: unknown, command: string, reason: string): string | null {
  return adapterFor(name)?.formatRewrite?.(input, command, reason) ?? null;
}

/** The context text for a runtime, or null when it takes none. */
export function contextOf(name: string, text: string): string | null {
  return adapterFor(name)?.formatContext?.(text) ?? null;
}

/** The question for a runtime that shows one before a call runs, or null when it has no ask decision. */
export function askOf(name: string): ((reason: string) => string) | null {
  return adapterFor(name)?.formatAsk ?? null;
}

/** The release fix for a runtime, or undefined when the table does not know it. */
export const releaseFixOf = (name: string): string | undefined => adapterFor(name)?.releaseFix;

/** The stop reader for a runtime, or undefined when it has no stop hook. */
export const stopReaderOf = (name: string): ((input: unknown) => StopEvent | null) | undefined => adapterFor(name)?.readStop;

/** One row of the guide's table: an adapter, its own words, and the dated run note. */
export interface GuideEntry {
  label: string;
  /** The adapter that guards this agent. Copilot CLI reads Claude Code's hooks, so it shares one. */
  adapter: string;
  /** The hook file and events, when the agent's own row says it differently. */
  projectHook?: string;
  /** How a refusal reaches the agent, when its own row says it differently. */
  blocking?: string;
  /** A capability this agent differs on, such as one its runtime shares only in part. */
  changes?: Partial<Capabilities>;
  /** The dated end-to-end run, or why there is none yet. */
  verified: string;
  /** What the owner must know before trusting this agent with a worker. */
  caveats: string;
}

/** The dated end-to-end notes, in the guide's order. */
export const GUIDE_AGENTS: readonly GuideEntry[] = [
  {
    label: 'Claude Code',
    adapter: 'claude-code',
    verified: 'yes, 2026-10-19: headless, on DeepSeek `deepseek-flash`',
    caveats: 'none',
  },
  {
    label: 'GitHub Copilot CLI',
    adapter: 'claude-code',
    projectHook: 'the same `.claude/settings.json`: Copilot reads it',
    blocking: 'exit 2, and the reason as JSON on stdout',
    changes: { canRewrite: false, failsOpen: true },
    verified: 'yes, 2026-10-19: Copilot CLI 1.0.98, `copilot -p`, model `gpt-6-luna` (Auto)',
    caveats:
      'Runs repo hooks only after you trust the folder: run `copilot` there and choose "Yes, and remember this folder for future sessions". Skips them without a word otherwise. A hook that times out lets the call go on',
  },
  {
    label: 'Antigravity CLI (`agy`)',
    adapter: 'antigravity',
    verified: 'yes, 2026-10-19: agy 1.4.2, `agy -p`, model `gemini-3.8-flash-high`',
    caveats: 'No stop check yet. Without `.yokoten/`, every call is refused: agy fails closed. The lead runs a worker\'s done-when check',
  },
  {
    label: 'Codex CLI',
    adapter: 'codex',
    verified: 'yes, 2026-10-19: Codex 0.163.0, `codex exec`, on DeepSeek `deepseek-flash`',
    caveats: 'Runs the hooks only after you trust the folder, and then both hooks in `/hooks`. `codex exec` skips an untrusted hook without a word',
  },
  {
    label: 'Muse Code',
    adapter: 'muse',
    verified: 'yes, 2026-10-19: Muse Code 1.4.10, `muse exec --trust-workspace`, model `muse-spark-1.3-contributor`',
    caveats:
      'Runs the hooks only after you trust the folder: run `muse` there and choose "Trust and continue". Muse passes no `YOKOTEN_ROLE` to a hook, so run it in a desk (the desk carries the mark), or mark a worker\'s worktree with `yokoten worker mark <dir> --no-desk`. It is not known to pass `YOKOTEN_RELEASE_APPROVAL` either, so release outside Muse. A hook that fails or times out lets the call go on',
  },
  {
    label: 'DeepSeek Harness (`dsh`)',
    adapter: 'deepseek-harness',
    verified: 'yes, 2026-10-20: dsh 0.2.1-rc.2, `dsh headless --patch .dsh/yokoten.patch.yml`, default DeepSeek model',
    caveats:
      'Runs hooks only through a bridge you add to each profile: see [DeepSeek Harness](#deepseek-harness). Without it, or without the patch, dsh runs no hooks and says nothing. Not guarded on Windows yet (#332). No stop check: the lead runs a worker\'s done-when check',
  },
  {
    label: 'Grok CLI (`grok`)',
    adapter: 'grok',
    verified: 'yes, 2026-10-20: Grok CLI 1.0.52, `grok -p --trust --always-approve`, default model',
    caveats:
      'Runs project hooks only after you trust the folder: run `grok` there and type `/hooks-trust`. Skips them without a word otherwise. Also runs the hooks in `.claude/settings.json`, so the guard may run twice for one call, on purpose',
  },
  {
    label: 'Gemini CLI',
    adapter: 'gemini',
    verified: 'not run end to end: personal sign-in retired 2026-06-18; needs a paid API key or an org license',
    caveats: 'Google\'s agent for individuals is now Antigravity CLI',
  },
  {
    label: 'OpenCode',
    adapter: 'opencode',
    verified: 'yes, 2026-10-23: OpenCode 2.1.4, `opencode-go/deepseek-v4.1-flash`, the plugin as `init` writes it',
    caveats: 'No stop check. A guard that fails or times out refuses the call. So does a call that is not read-only, when no command or path can be read. A subagent call was not part of that run',
  },
];

const OTHER_AGENT_ROW = '| Any other agent | none | the rules in `AGENTS.md`, and the commit check, which stops a bad commit whoever made it | — | | |';

const flag = (on: boolean): string => (on ? 'yes' : 'no');

/** The "Works with" table, generated from the adapters and the dated run notes. */
export function worksWithTable(entries: readonly GuideEntry[] = GUIDE_AGENTS): string {
  const rows = entries.map((entry) => {
    const adapter = ADAPTERS[entry.adapter];
    if (!adapter) throw new Error(`the guide names the adapter ${entry.adapter}, which is not in ADAPTERS`);
    const capabilities = { ...adapter.capabilities, ...entry.changes };
    const cell = [flag(capabilities.canRewrite), flag(capabilities.hasStopHook), flag(capabilities.needsTrust), capabilities.failsOpen ? 'open' : 'closed', flag(capabilities.passesRole)].join(' · ');
    return `| ${entry.label} | ${entry.projectHook ?? adapter.projectHook} | ${entry.blocking ?? adapter.blocking} | ${cell} | ${entry.verified} | ${entry.caveats} |`;
  });
  return [
    '| Agent | Hook file (`init` writes it) | How it blocks | Capabilities (rewrite · stop · trust · fails · role) | Verified | Caveats |',
    '|---|---|---|---|---|---|',
    ...rows,
    OTHER_AGENT_ROW,
  ].join('\n');
}
