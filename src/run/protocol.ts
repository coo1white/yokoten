// The guard protocol (#898): one fixed call that any agent tool can send, and one fixed
// answer. A tool translates its own tool call into a `GuardInput`, runs
// `yokoten hook --protocol` with it, and reads a `GuardOutput` from stdout. The version is
// in every message, so a newer yokoten never answers an older tool by accident.
//
// The spec is docs/records/0039-the-guard-protocol.md. `CONFORMANCE_CASES` and `checkGuardIntegration` are
// the test a toolkit runs against its own integration: test/run/protocol.test.ts runs them
// for yokoten's command line and for the OpenCode plugin.
//
// Version 1 has no rewrite and no runtime name: a tool either runs the action as written
// or refuses it, and a refusal names no agent.

import { type Finding, formatFinding, formatRefusal, refusalParts } from '../rules/message.ts';
import type { Action } from './hook.ts';

/** The protocol's name, without its version. */
export const GUARD_PROTOCOL = 'yokoten-guard';

/** The protocol's version. A new shape gets a new number, never a new meaning. */
export const GUARD_PROTOCOL_VERSION = 1;

/** The name and version a caller sends and yokoten answers: `yokoten-guard/1`. */
export const GUARD_PROTOCOL_ID = `${GUARD_PROTOCOL}/${GUARD_PROTOCOL_VERSION}`;

/** What the agent is about to do, in no runtime's terms. */
export interface GuardAction {
  /** The tool's own name, such as `shell` or `edit`. Kept for the stop log only. */
  tool?: string;
  /** A shell command, as the agent wrote it. */
  command?: string;
  /** Every command on one call. The guard refuses when any entry is refused. */
  commands?: string[];
  /** The files an edit touches, absolute or relative to the project folder. */
  paths?: string[];
  /** The folder the action runs in. Defaults to `project`. */
  cwd?: string;
}

/** The role the caller claims. The guard still reads a worker mark on its own. */
export type GuardRole = 'lead' | 'worker';

/** One call to the guard. */
export interface GuardInput {
  protocol: typeof GUARD_PROTOCOL_ID;
  action: GuardAction;
  role: GuardRole;
  /** The project's folder, absolute: the repo root, or the folder outside a repo. */
  project: string;
}

/** The three answers. `ask` means the owner decides; the guard does not refuse. */
export type GuardDecision = 'allow' | 'refuse' | 'ask';

/** Why the guard refused, or what it asks. */
export interface GuardReason {
  /** The rule id, as `yokoten explain` knows it. */
  id: string;
  /** The answer as one text, ready to show to the agent. */
  message: string;
  /** Why it matters, as one sentence. */
  why: string;
  /** The safe way, as one sentence. */
  fix: string;
  /** Where the rule is explained in full. */
  docs: string;
}

/** The guard's answer. */
export interface GuardOutput {
  protocol: typeof GUARD_PROTOCOL_ID;
  decision: GuardDecision;
  /** There when the decision is `refuse` or `ask`. */
  reason?: GuardReason;
}

/** One case the conformance test sends, and the answer it expects. */
export interface ConformanceCase {
  name: string;
  input: GuardInput;
  decision: GuardDecision;
  /** The rule id the answer must name, when the answer names one. */
  id?: string;
}

/** A GuardInput with the one placeholder project, for a case that names no real repo. */
const caseInput = (command: string): GuardInput => ({
  protocol: GUARD_PROTOCOL_ID,
  action: { command },
  role: 'lead',
  project: '/conformance',
});

/**
 * The cases every integration runs (#898). They need no repo, no home folder and no
 * network, so a toolkit can send them as they are.
 */
export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  { name: 'a plain read is allowed', input: caseInput('git status'), decision: 'allow' },
  { name: 'a force push is refused', input: caseInput('git push --force origin main'), decision: 'refuse', id: 'force-push' },
  { name: 'a tag push is refused', input: caseInput('git push origin --tags'), decision: 'refuse', id: 'release' },
  { name: 'a skipped commit check is refused', input: caseInput('git commit --no-verify -m x'), decision: 'refuse', id: 'skip-check' },
];

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const stringsOf = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const found: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') return undefined;
    found.push(item);
  }
  return found;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The action, when it is the fixed shape; else a line that says what is wrong. */
function readAction(value: unknown): GuardAction | string {
  if (!isRecord(value)) return 'action must be an object';
  const action: GuardAction = {};
  const tool = textOf(value.tool);
  if (tool !== undefined) action.tool = tool;
  const command = textOf(value.command);
  if (command !== undefined) action.command = command;
  if (value.commands !== undefined) {
    const commands = stringsOf(value.commands);
    if (commands === undefined || commands.length === 0) return 'action.commands must be a non-empty list of commands';
    action.commands = commands;
  }
  if (value.paths !== undefined) {
    const paths = stringsOf(value.paths);
    if (paths === undefined) return 'action.paths must be a list of file paths';
    action.paths = paths;
  }
  const cwd = textOf(value.cwd);
  if (cwd !== undefined) action.cwd = cwd;
  if (action.command === undefined && (action.commands === undefined || action.commands.length === 0) && (action.paths === undefined || action.paths.length === 0)) {
    return 'action needs a command, a list of commands, or a list of paths';
  }
  return action;
}

/**
 * The call in the fixed shape, or a line that says what is wrong. A version this yokoten
 * does not read is a problem, never a guess: the answer is `refuse`.
 */
export function readGuardInput(value: unknown): GuardInput | string {
  if (!isRecord(value)) return 'the input must be one JSON object';
  if (value.protocol !== GUARD_PROTOCOL_ID) {
    const named = textOf(value.protocol) ?? 'nothing';
    return `the protocol is ${named}; this yokoten reads ${GUARD_PROTOCOL_ID}`;
  }
  const action = readAction(value.action);
  if (typeof action === 'string') return action;
  if (value.role !== 'lead' && value.role !== 'worker') return 'role must be "lead" or "worker"';
  const project = textOf(value.project);
  if (project === undefined) return 'project must be the project folder';
  if (!project.startsWith('/')) return 'project must be an absolute folder';
  return { protocol: GUARD_PROTOCOL_ID, action, role: value.role, project };
}

/** The call as text, or a line that says why the text is not one. */
export function parseGuardInput(text: string): GuardInput | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'the input must be JSON';
  }
  return readGuardInput(value);
}

/** The protocol call for an Action an adapter already read. A worker action stays a worker. */
export function toGuardInput(action: Action, role: GuardRole, project: string): GuardInput {
  const { command, commands, paths, cwd } = action;
  return {
    protocol: GUARD_PROTOCOL_ID,
    action: {
      ...(command !== undefined ? { command } : {}),
      ...(commands !== undefined ? { commands } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    },
    role: action.worker ? 'worker' : role,
    project,
  };
}

/** The Action, role and project behind a protocol call. */
export function fromGuardInput(input: GuardInput): { action: Action; role: GuardRole; project: string } {
  const action: Action = { paths: input.action.paths ?? [], worker: input.role === 'worker' };
  if (input.action.command !== undefined) action.command = input.action.command;
  if (input.action.commands !== undefined) action.commands = input.action.commands;
  if (input.action.cwd !== undefined) action.cwd = input.action.cwd;
  return { action, role: input.role, project: input.project };
}

const sentenceOf = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** The answer that lets the action run, with no reason. */
export const allowedOutput = (): GuardOutput => ({ protocol: GUARD_PROTOCOL_ID, decision: 'allow' });

/** The answer that refuses the action, with the same four parts the hook prints. */
export function refusedOutput(finding: Finding): GuardOutput {
  const parts = refusalParts(finding);
  return {
    protocol: GUARD_PROTOCOL_ID,
    decision: 'refuse',
    reason: { id: parts.id, message: formatRefusal(finding), why: parts.why, fix: parts.fix, docs: parts.docs },
  };
}

/** The answer that sends the question to the owner. It never refuses. */
export function askedOutput(finding: Finding): GuardOutput {
  return {
    protocol: GUARD_PROTOCOL_ID,
    decision: 'ask',
    reason: {
      id: finding.id,
      message: `yokoten: ${formatFinding(finding)}`,
      why: sentenceOf(finding.why),
      fix: sentenceOf(finding.fix),
      docs: finding.docs ?? '',
    },
  };
}

/** The answer to an input yokoten cannot read. It refuses: the tool asked for the guard. */
export const protocolRefusal = (problem: string): GuardOutput => ({
  protocol: GUARD_PROTOCOL_ID,
  decision: 'refuse',
  reason: {
    id: 'unreadable-protocol',
    message: `yokoten stopped this: ${problem} [unreadable-protocol]`,
    why: 'a call yokoten cannot read is not checked, so it does not run.',
    fix: `Send {"protocol":"${GUARD_PROTOCOL_ID}","action":{"command":"git status"},"role":"lead","project":"/srv/example/project"}.`,
    docs: 'https://github.com/yokoten-labs/yokoten/blob/main/docs/records/0039-the-guard-protocol.md',
  },
});

/**
 * Run the conformance cases through one integration (#898). `run` sends a call the way the
 * tool really does, and returns the answer it read. The result is one line per failure, so
 * an empty list means the integration conforms.
 */
export async function checkGuardIntegration(run: (input: GuardInput) => Promise<GuardOutput>): Promise<string[]> {
  const failures: string[] = [];
  for (const item of CONFORMANCE_CASES) {
    let answer: GuardOutput;
    try {
      answer = await run(item.input);
    } catch (err) {
      failures.push(`${item.name}: the integration threw ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (answer?.protocol !== GUARD_PROTOCOL_ID) {
      failures.push(`${item.name}: the answer's protocol is ${String(answer?.protocol)}`);
      continue;
    }
    if (answer.decision !== item.decision) failures.push(`${item.name}: expected ${item.decision}, got ${answer.decision}`);
    if (item.id !== undefined && answer.reason?.id !== item.id) failures.push(`${item.name}: expected rule ${item.id}, got ${String(answer.reason?.id)}`);
  }
  return failures;
}
