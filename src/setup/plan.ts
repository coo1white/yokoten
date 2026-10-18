// The planning setup on the code host (#10, record 0004 stage 2): the standard labels and
// a first milestone, which the pull request check asks for.
//
// It changes a remote, so `init` only says what it would do. `init --github --yes` does
// it. A standard label that is there gets the standard colour and description, so a
// second run changes nothing. A label outside the set is deleted only with
// --remove-default-labels: deleting is the owner's call. Without gh, a sign-in or a
// GitHub remote, it says what it skipped and init still succeeds.

import { execFileSync } from 'node:child_process';
import { createLabel, createMilestone, deleteLabel, editLabel, type Gh, type Label, readPlanning, repoOf } from '../host/github.ts';

/**
 * The standard set, as agreed for yokoten (#10): a type, the same words as commit types,
 * the flow labels, and the tier labels the pull request check asks for (#225). No status
 * or priority labels: the board holds status, milestones hold timing. Area labels are each
 * project's own, so they are not here.
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
  { name: 'tier A', color: 'b60205', description: 'Hard to take back: secrets, data, install/update path, releases, going public. Owner reviews.' },
  { name: 'tier B', color: 'fbca04', description: 'Other code. Tests for the change; merges when CI is green.' },
  { name: 'tier C', color: '0e8a16', description: 'Docs, wording, styles. Merges when CI is green.' },
];

/** The milestone made when the repo has no open one. */
export const FIRST_MILESTONE = 'First release';

/** The milestone made instead when a closed one already holds the first title. */
export const NEXT_MILESTONE = 'Next release';

/**
 * The one milestone rule for `init --github` and the road (#178): the repo needs an open
 * milestone. Returns null when one is open, or else the title `init` makes. A closed
 * milestone is the owner's decision, so it is never reopened. The host refuses a title a
 * closed one holds, so the title is the first one that is free: "First release", then
 * "Next release", then "Next release 2" and on.
 */
export function pickNewMilestone(milestones: { title: string; open: boolean }[]): string | null {
  if (milestones.some((m) => m.open)) return null;
  const taken = new Set(milestones.map((m) => m.title.toLowerCase()));
  if (!taken.has(FIRST_MILESTONE.toLowerCase())) return FIRST_MILESTONE;
  let title = NEXT_MILESTONE;
  for (let count = 2; taken.has(title.toLowerCase()); count++) title = `${NEXT_MILESTONE} ${count}`;
  return title;
}

/** GitHub's default labels that the standard set replaces. Deleted only with --remove-default-labels. */
export const HOST_DEFAULTS = ['documentation', 'duplicate', 'enhancement', 'help wanted', 'invalid', 'question', 'wontfix'];

/** The standard labels not in `names`, compared without case. */
export const lackingLabels = (names: string[]): Label[] => {
  const have = new Set(names.map((name) => name.toLowerCase()));
  return LABELS.filter((label) => !have.has(label.name.toLowerCase()));
};

/** The origin remote's URL, or '' when there is none. */
export function readOriginUrl(root: string): string {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export interface PlanningOptions {
  /** Change the host. When false, only say what would change. */
  apply: boolean;
  /** Also delete GitHub's default labels that are not in the standard set. */
  removeDefaults: boolean;
}

/** One change to the host: what it is, in words, and the gh call that makes it. */
interface Change {
  what: string;
  run: () => void;
}

/**
 * Returns the report lines, and whether every change worked. `remote` is the origin URL.
 * A skip (no GitHub remote, no gh, no sign-in) is ok: init goes on and says so.
 */
export function setUpPlanning(gh: Gh, remote: string, { apply, removeDefaults }: PlanningOptions): { ok: boolean; lines: string[] } {
  const repo = repoOf(remote);
  if (!repo) return { ok: true, lines: ['GitHub: skipped, because the origin remote is not on GitHub. Labels and a milestone need a GitHub repo'] };
  const found = readPlanning(gh, repo);
  if ('unread' in found) return { ok: true, lines: [`GitHub: skipped, because ${found.unread}. To set up labels and a milestone, ${found.fix}, then run \`yokoten init --github\``] };

  const lines = [`GitHub: ${found.repo}`];
  const changes: Change[] = [];
  let kept = 0;
  for (const label of LABELS) {
    const there = found.labels.find((l) => l.name.toLowerCase() === label.name.toLowerCase());
    if (!there) changes.push({ what: `make label "${label.name}" (${label.description})`, run: () => createLabel(gh, repo, label) });
    else if (there.color.toLowerCase() !== label.color || there.description !== label.description) {
      changes.push({ what: `update label "${there.name}" to the standard colour and description`, run: () => editLabel(gh, repo, there.name, label) });
    } else kept++;
  }
  if (kept) lines.push(`- ${kept} of the ${LABELS.length} standard labels are there; kept`);
  const milestone = pickNewMilestone(found.milestones);
  if (milestone === null) lines.push('- a milestone is open; kept');
  else changes.push({ what: `make milestone "${milestone}"`, run: () => createMilestone(gh, repo, milestone) });
  const extra = found.labels.filter((l) => HOST_DEFAULTS.includes(l.name.toLowerCase())).map((l) => l.name);
  if (extra.length && removeDefaults) {
    for (const name of extra) changes.push({ what: `delete label "${name}" (the host also takes it off every issue)`, run: () => deleteLabel(gh, repo, name) });
  } else if (extra.length) {
    lines.push(`- not in the standard set: ${extra.join(', ')}. yokoten deletes them only with --remove-default-labels`);
  }

  if (!changes.length) return { ok: true, lines: [...lines, 'Nothing to change.'] };
  if (!apply) {
    const command = `yokoten init --github --yes${removeDefaults ? ' --remove-default-labels' : ''}`;
    return { ok: true, lines: [...lines, 'Would do:', ...changes.map((c) => `- ${c.what}`), `Nothing changed. Run \`${command}\` to do it.`] };
  }
  // Each one on its own: one refusal does not stop the rest, and the report says which.
  let ok = true;
  for (const change of changes) {
    try {
      change.run();
      lines.push(`- done: ${change.what}`);
    } catch (err) {
      ok = false;
      const said = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0];
      lines.push(`- could not ${change.what}: ${said}`);
    }
  }
  return { ok, lines };
}
