// `yokoten board --text` (#601, #603): the board's data as plain text, for a terminal or an agent.

import { terminalText } from '../../../../run/learn.ts';
import type { MachineStatus } from '../../machine.ts';
import type { BoardRun, BoardWaiting } from '../controls.ts';
import type { AgentView, BoardData, PullView } from '../view.ts';

/** One agent as plain words: its nickname, vendor, role, task, worktree, what it does now, and how long ago. */
function formatAgent(agent: AgentView): string {
  const vendor = agent.vendor.name === 'Unknown' ? '' : ` (${agent.vendor.name})`;
  const who = agent.nickname || agent.name;
  const head = `${who}${vendor}${agent.role ? ` [${agent.role}]` : ''}`;
  const state = agent.dot === 'waiting' || agent.dot === 'failing' || agent.dot === 'done' ? agent.dot : '';
  const parts = [agent.task, agent.key ? `in ${agent.key}` : '', agent.doing, state, agent.age].filter(Boolean);
  return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

/** One pull request as plain words: its number, title, branch, tier and current step. */
function formatPull(pull: PullView): string {
  return `#${pull.number} ${pull.title} [${pull.branch}]: ${pull.label}, ${pull.tier ? `tier ${pull.tier}` : 'no tier'}`;
}

/** `1 agent`, `2 agents`: the count with the word. */
function countText(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** What `--text` adds past the agents, pulls and worktrees: the waiting list and the runs the board started. */
export interface BoardTextExtra {
  waiting: BoardWaiting[];
  runs: BoardRun[];
  /** The machines the owner added: name, reach, load. Never a target. */
  machines?: MachineStatus[];
}

/** One waiting row as plain words, the same data the page shows. */
function formatBoardWaiting(row: BoardWaiting): string {
  const kind = row.kind === 'approve' ? 'Needs the owner go-ahead' : row.kind === 'guard' ? 'Guard stop' : 'Question';
  const head = [kind, row.agent, row.role ? `[${row.role}]` : '', row.wait].filter(Boolean).join(' ');
  return `${head}: ${row.why}${row.link ? ` (${row.link})` : ''}`;
}

/** One started run as plain words, the same data the page shows. */
function formatBoardRun(run: BoardRun): string {
  return `${run.name} ${run.vendor} ${run.model} issue ${run.issue} ${run.status}${run.machine ? ` on ${run.machine}` : ''}${run.worktree ? ` in ${run.worktree}` : ''}`;
}

/** One added machine as plain words: its name, reach and load, never its target. */
function formatBoardMachine(machine: MachineStatus): string {
  return `${machine.name}: ${machine.isReachable ? `reachable${machine.load ? `, load ${machine.load}` : ''}` : 'not reachable'}`;
}

/**
 * The board as plain text: the same data the page shows. With `extra` it also shows the
 * waiting list and the runs the board started; without it the text stays as before.
 * Agents write it, so control and bidi characters show escaped.
 */
export function renderBoardText(board: BoardData, extra?: BoardTextExtra): string[] {
  const pulls = typeof board.pulls === 'string' ? [] : board.pulls;
  const worktrees = typeof board.worktrees === 'string' ? [] : board.worktrees;
  return [
    `yokoten board: ${board.repo}`,
    `${countText(board.agents.length, 'agent')}, ${countText(pulls.length, 'open pull request')}, ${countText(worktrees.length, 'worktree')}.`,
    '',
    'Needs you:',
    ...(board.needs.length ? board.needs.map((need) => `- ${need.title}: ${need.why}`) : ['- nothing.']),
    '',
    'Agents:',
    ...(board.agents.length ? board.agents.map((agent) => `- ${formatAgent(agent)}`) : [`- none. Start an agent in this repo or its worktrees, or from the board page: it shows here by itself.`]),
    '',
    ...(extra === undefined
      ? []
      : [
          'Waiting for you:',
          ...(extra.waiting.length ? extra.waiting.map((row) => `- ${formatBoardWaiting(row)}`) : ['- Nothing waits for you.']),
          '',
          'Started here:',
          ...(extra.runs.length ? extra.runs.map((run) => `- ${formatBoardRun(run)}`) : ['- No agents started here yet.']),
          '',
          ...(extra.machines === undefined || extra.machines.length === 0
            ? []
            : ['Machines:', ...extra.machines.map((machine) => `- ${formatBoardMachine(machine)}`), '']),
        ]),
    'Pull requests:',
    ...(typeof board.pulls === 'string' ? [`- ${board.pulls}`] : pulls.length ? pulls.map((pull) => `- ${formatPull(pull)}`) : ['- none open.']),
    ...board.merged.map((pull) => `- #${pull.number} ${pull.title}: merged`),
    '',
    'Worktrees:',
    ...(typeof board.worktrees === 'string' ? [`- ${board.worktrees}`] : worktrees.length ? worktrees.map((tree) => `- ${tree.path}${tree.branch ? ` (${tree.branch})` : ''}`) : ['- none.']),
  ].map(terminalText);
}
