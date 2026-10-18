// `yokoten init --github`: the planning setup on the code host (#10, record 0004 stage 2).
// The standard labels and a first milestone, which the pull request check asks for.
//
// It changes a remote, so it is opt-in. Without --yes it only says what it would make.
// It only adds: a label or milestone that is there is kept, and nothing is renamed or
// deleted. So it is safe to run twice.

import { createLabel, createMilestone, type Gh, readPlanning } from '../host/github.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

/**
 * The standard set, as agreed for yokoten (#10): a type, the same words as commit types,
 * and the flow labels. No status or priority labels: the board holds status, milestones
 * hold timing. Area labels are each project's own, so they are not here.
 */
export const LABELS: Label[] = [
  { name: 'bug', color: 'd73a4a', description: 'Something does not work as it should' },
  { name: 'feat', color: 'a2eeef', description: 'A new feature or a change in behaviour' },
  { name: 'docs', color: '0075ca', description: 'Documentation only' },
  { name: 'refactor', color: 'cfd3d7', description: 'A code change that keeps the behaviour' },
  { name: 'ci', color: 'fbca04', description: 'CI workflows and checks' },
  { name: 'owner', color: '5319e7', description: 'Needs the owner: a decision, a setting or an approval' },
  { name: 'incident', color: 'b60205', description: 'Something went wrong; the fix adds a check' },
  { name: 'good first issue', color: '7057ff', description: 'A small, clear task for a new contributor' },
  { name: 'hotfix', color: 'e11d21', description: 'Urgent: fix and release soon' },
];

/** The milestone made when the repo has no open one. */
export const FIRST_MILESTONE = 'First release';

// GitHub's default labels that the standard set replaces. They are named, never deleted.
const HOST_DEFAULTS = ['documentation', 'duplicate', 'enhancement', 'help wanted', 'invalid', 'question', 'wontfix'];

/** Returns the report lines, and whether it worked. With `apply` false, it changes nothing. */
export function setUpPlanning(gh: Gh, apply: boolean): { ok: boolean; lines: string[] } {
  const found = readPlanning(gh);
  if (typeof found === 'string') return { ok: false, lines: [`GitHub: ${found}`] };
  const have = new Set(found.labels.map((l) => l.toLowerCase()));
  const labels = LABELS.filter((l) => !have.has(l.name.toLowerCase()));
  // An open milestone is a plan already. A closed one with the same title would make the host refuse.
  const milestone = found.milestones.some((m) => m.open || m.title === FIRST_MILESTONE) ? null : FIRST_MILESTONE;
  const kept = LABELS.length - labels.length;
  const lines = [`GitHub: ${found.repo}`];
  if (kept) lines.push(`- ${kept} of the ${LABELS.length} standard labels are there; kept`);
  if (!milestone) lines.push('- a milestone is there; kept');
  const extra = found.labels.filter((l) => HOST_DEFAULTS.includes(l.toLowerCase()));
  if (extra.length) lines.push(`- not in the standard set: ${extra.join(', ')}. yokoten never deletes a label; delete them by hand if you don't use them`);
  if (!labels.length && !milestone) return { ok: true, lines: [...lines, 'Nothing to make.'] };
  const todo = [...labels.map((l) => `label "${l.name}" (${l.description})`), ...(milestone ? [`milestone "${milestone}"`] : [])];
  if (!apply) return { ok: true, lines: [...lines, 'Would make:', ...todo.map((t) => `- ${t}`), 'Nothing changed. Run `yokoten init --github --yes` to make them.'] };
  // Each one on its own: one refusal does not stop the rest, and the report says which.
  let ok = true;
  const make = (what: string, run: () => void) => {
    try {
      run();
      lines.push(`- made ${what}`);
    } catch (err) {
      ok = false;
      const said = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0];
      lines.push(`- could not make ${what}: ${said}`);
    }
  };
  for (const label of labels) make(`label "${label.name}"`, () => createLabel(gh, label));
  if (milestone) make(`milestone "${milestone}"`, () => createMilestone(gh, found.repo, milestone));
  return { ok, lines };
}
