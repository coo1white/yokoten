// `yokoten finish`: close a run whose agent stopped beating (#761).
//
// The controller itself is in round.ts. This module finds the agents whose status files
// this repo, its worktrees and its desks hold, and hands each one over.
// It writes nothing itself: the dry run and the checks belong to the controller.

import { readBoardAgents, readBoardWorktrees } from '../board/agents.ts';
import { type FinishResult, finishTarget, GONE_MINUTES } from './round.ts';
import { workerRole } from '../../../rules/guards.ts';
import { findStatusCheckout } from '../../../run/hook.ts';
import { type Invocation, parse, print, printJson, requireRoot, usage } from '../../shared.ts';

/** A run the controller never saw: its folder or its status file is not usable as a worktree. */
const skippedResult = (name: string, worktree: string, reason: string): FinishResult => ({
  kind: 'skipped',
  name,
  worktree,
  reason,
  report: '',
  check: { ok: true, findings: [], problem: '' },
});

/** One result as one line, for a person reading the terminal. */
function resultLine(result: FinishResult): string {
  const where = result.worktree ? ` (${result.worktree})` : '';
  const report = result.report === 'written' ? '; report written' : result.report === 'kept' ? '; its own report kept' : '';
  const work = result.kind === 'finished' || result.kind === 'would-finish' ? result.check.ok ? '; check ok' : result.check.problem ? `; ${result.check.problem}` : `; check found ${result.check.findings.length}` : '';
  const verb = result.kind === 'would-finish' ? 'would finish' : result.kind;
  return `- ${result.name}${where}: ${verb}: ${result.reason}${report}${work}`;
}

export function runFinish(invocation: Invocation): number {
  const options = parse('finish', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const json = options.flags.has('--json');
  // Closing other sessions is the lead's call, as dispatch and the board are. The guard
  // and the commit check read the same worker role (#555).
  if (workerRole(invocation.env, [invocation.cwd])) {
    const refusal = 'a worker does not close runs; the lead finishes a run its agent stopped';
    if (json) printJson(invocation, { finish: [], ok: false, error: refusal });
    else print(invocation, [`yokoten finish: ${refusal}`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, invocation.cwd, json ? () => ({ finish: [], ok: false }) : undefined);
  if (!root) return 1;
  const asked = options.values['--after'];
  let goneMinutes = GONE_MINUTES;
  if (asked !== undefined) {
    goneMinutes = Number(asked);
    if (!Number.isInteger(goneMinutes) || goneMinutes < 1) return usage(invocation, '--after needs a whole number of minutes above 0');
  }
  const trees = readBoardWorktrees(root, invocation.env);
  if (typeof trees === 'string') {
    if (json) printJson(invocation, { finish: [], ok: false, error: trees });
    else print(invocation, [`yokoten finish: ${trees}`], invocation.stderr);
    return 1;
  }
  const isDryRun = options.flags.has('--dry-run');
  const results = readBoardAgents(trees).map(({ agent, tree }): FinishResult => {
    const checkout = findStatusCheckout(tree.path);
    if (!checkout) return skippedResult(agent.name, tree.path, 'its folder is not a yokoten worktree');
    return finishTarget(
      { name: agent.name, vendor: agent.vendor, model: agent.model, role: agent.role, state: agent.state, updated: agent.updated, branch: tree.branch, checkout },
      { env: invocation.env, goneMs: goneMinutes * 60_000, isDryRun },
    );
  });
  const finished = results.filter((result) => result.kind === 'finished').length;
  const would = results.filter((result) => result.kind === 'would-finish').length;
  const failed = results.filter((result) => result.kind === 'failed').length;
  if (json) printJson(invocation, { finish: results, ok: failed === 0, goneMinutes, dryRun: isDryRun });
  else if (!results.length) print(invocation, ['yokoten finish: no agent has a status file here, so nothing is running']);
  else {
    const counts = [`${finished} finished`, ...(isDryRun ? [`${would} would finish`] : []), `${results.length - finished - would - failed} left alone`, ...(failed ? [`${failed} failed`] : [])];
    print(invocation, [`yokoten finish: ${counts.join(', ')}`, ...results.map(resultLine)], failed ? invocation.stderr : invocation.stdout);
  }
  return failed ? 1 : 0;
}
