// `yokoten board --text` (#601, #603): the board's data as plain text, for a terminal or an agent.

import { terminalText } from '../../../../run/learn.ts';
import type { BoardRun, BoardWaiting } from '../controls.ts';
import { type BoardUsage, costWords, tokenText, totalOf } from '../feed/read/usage.ts';
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
}

/** One waiting row as plain words, the same data the page shows. */
function formatBoardWaiting(row: BoardWaiting): string {
  const kind = row.kind === 'approve' ? 'Needs the owner go-ahead' : row.kind === 'guard' ? 'Guard stop' : 'Question';
  const head = [kind, row.agent, row.role ? `[${row.role}]` : '', row.wait].filter(Boolean).join(' ');
  return `${head}: ${row.why}${row.link ? ` (${row.link})` : ''}`;
}

/** One started run as plain words, the same data the page shows. */
function formatBoardRun(run: BoardRun): string {
  return `${run.name} ${run.vendor} ${run.model} issue ${run.issue} ${run.status}${run.worktree ? ` in ${run.worktree}` : ''}`;
}

/** A token count and a price, in plain words. */
function formatUsageAmount(input: number, cached: number, output: number, cost: string): string {
  return `${tokenText(input)} in, ${tokenText(cached)} cached, ${tokenText(output)} out: ${cost}`;
}

/**
 * The usage view as plain words: each agent, model and day, then the total, what is
 * partial, and when the prices were checked. Only numbers, a model name and a day leave
 * here: a session log's text never does.
 */
function formatUsage(usage: BoardUsage): string[] {
  if (!usage.cells.length) {
    return [`Usage${usage.filter ? ` (${usage.filter})` : ''}:`, usage.filter ? '- no rows for that filter.' : '- no token counts in a local log yet.'];
  }
  const rows = usage.cells.map((cell) => {
    const who = [cell.vendor, cell.agent, cell.role ? `[${cell.role}]` : ''].filter(Boolean).join(' ');
    const day = cell.day || 'day unknown';
    const total = totalOf([cell]);
    return `- ${who} · ${cell.model} · ${day}: ${formatUsageAmount(cell.input, cell.cached, cell.output, costWords(total, cell.isLocal))}`;
  });
  const total = totalOf(usage.cells);
  const all = formatUsageAmount(total.input, total.cached, total.output, costWords(total, usage.cells.every((cell) => cell.isLocal)));
  return [
    `Usage${usage.filter ? ` (${usage.filter})` : ''} (estimates from the last 7 days of local session logs; nothing leaves this machine):`,
    ...rows,
    `- Total: ${all}`,
    ...(usage.partial.length ? ['Partial:', ...usage.partial.map((note) => `- ${note}.`)] : []),
    `Prices checked ${usage.checked}; each row is the vendor's list price, as if this use was paid by API.`,
  ];
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
        ]),
    'Pull requests:',
    ...(typeof board.pulls === 'string' ? [`- ${board.pulls}`] : pulls.length ? pulls.map((pull) => `- ${formatPull(pull)}`) : ['- none open.']),
    ...board.merged.map((pull) => `- #${pull.number} ${pull.title}: merged`),
    '',
    'Worktrees:',
    ...(typeof board.worktrees === 'string' ? [`- ${board.worktrees}`] : worktrees.length ? worktrees.map((tree) => `- ${tree.path}${tree.branch ? ` (${tree.branch})` : ''}`) : ['- none.']),
    ...(board.usage && (board.usage.cells.length || board.usage.partial.length || board.usage.filter) ? ['', ...formatUsage(board.usage)] : []),
  ].map(terminalText);
}
