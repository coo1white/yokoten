// `yokoten board --text` (#601, #603): the board's data as plain text, for a terminal or an agent.

import { terminalText } from '../../../run/learn.ts';
import { BOARD_AGENT_FILE } from './agents.ts';
import type { AgentView, BoardData, PullView } from './view.ts';

/** One agent as plain words: its name, vendor, role, task, worktree, what it does now, and how long ago. */
function formatAgent(agent: AgentView): string {
  const vendor = agent.vendor.name === 'Unknown' ? '' : ` (${agent.vendor.name})`;
  const head = `${agent.name}${vendor}${agent.role ? ` [${agent.role}]` : ''}`;
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

/** The board as plain text: the same data the page shows. Agents write it, so control and bidi characters show escaped. */
export function renderBoardText(board: BoardData): string[] {
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
    ...(board.agents.length ? board.agents.map((agent) => `- ${formatAgent(agent)}`) : [`- none. An agent joins by writing ${BOARD_AGENT_FILE} in its worktree.`]),
    '',
    'Pull requests:',
    ...(typeof board.pulls === 'string' ? [`- ${board.pulls}`] : pulls.length ? pulls.map((pull) => `- ${formatPull(pull)}`) : ['- none open.']),
    ...board.merged.map((pull) => `- #${pull.number} ${pull.title}: merged`),
    '',
    'Worktrees:',
    ...(typeof board.worktrees === 'string' ? [`- ${board.worktrees}`] : worktrees.length ? worktrees.map((tree) => `- ${tree.path}${tree.branch ? ` (${tree.branch})` : ''}`) : ['- none.']),
  ].map(terminalText);
}
