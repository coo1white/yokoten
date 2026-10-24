
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type Finding, finding } from '../../rules/message.ts';
import { fileHash, KIT, lfText, normalizeText, readWorkflowHashes, render, textHash, VERSION, writeNew } from '../files.ts';
import { isCiOffIn } from './ci-off.ts';
import { isInHead } from './core-rules.ts';
import { cliPath, isSelf } from './project-files.ts';

// ---- The kit's workflows: update a copy the project never changed (#456) ----
//
// A project set up by an older yokoten has that kit's workflows. When its copy is byte for
// byte one the kit wrote (kit/workflow-hashes.json lists each version), init replaces it
// with the newest: there is nothing of the project's to keep, and git has the old file,
// because init never commits (record 0014). A copy with the project's changes is kept, and
// init and full doctor say how to see the difference. A symlink is never written through.

export const WORKFLOWS_DIR = '.github/workflows/';

/** How a project's copy of a kit workflow compares with the kit's newest one. */
export type WorkflowState = 'missing' | 'same' | 'older' | 'changed' | 'link';

/** The first part of `rel`, a folder or the file itself, that is a symlink in `root`; null when none is. */
function findLinkOnPath(root: string, rel: string): string | null {
  const parts = rel.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const part = parts.slice(0, depth).join('/');
    try {
      if (lstatSync(join(root, part)).isSymbolicLink()) return part;
    } catch {
      return null;
    }
  }
  return null;
}

/** A blank line or a comment: no job, and never a difference between two copies of one. */
const isFillerLine = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#');

/** The indent of `line`: the spaces and tabs before its first other character. */
const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

/**
 * A workflow's `jobs:` block: the lines before it (its opening line last), each job's lines
 * (its header line first) by name, and the lines after the next top-level key, if any.
 * Null when no top-level `jobs:` key opens one.
 */
function readJobs(text: string): { before: string; jobs: Map<string, string[]>; after: string } | null {
  const lines = lfText(text).split('\n');
  const open = lines.findIndex((line) => /^jobs\s*:(?:\s+#.*)?$/.test(line));
  if (open === -1) return null;
  const jobs = new Map<string, string[]>();
  let at: string | null = null;
  let indent = 0;
  const after = lines.slice(open + 1);
  for (let index = 0; index < after.length; index++) {
    const line = after[index];
    if (isFillerLine(line)) {
      if (at !== null) jobs.get(at)!.push(line);
      continue;
    }
    if (/^\S/.test(line)) return { before: lines.slice(0, open + 1).join('\n'), jobs, after: after.slice(index).join('\n') };
    if (at === null) {
      const head = /^(\s*)([A-Za-z0-9_.-]+):/.exec(line);
      if (!head) return null;
      indent = head[1].length;
      at = head[2];
      jobs.set(at, [line]);
      continue;
    }
    const head = /^(\s*)([A-Za-z0-9_.-]+):/.exec(line);
    if (head !== null && head[1].length === indent) {
      at = head[2];
      jobs.set(at, [line]);
    } else jobs.get(at)!.push(line);
  }
  return { before: lines.slice(0, open + 1).join('\n'), jobs, after: '' };
}

/** The job names a `needs:` value and its list lines hold: a flow list, a block list, or one name. */
function needNames(value: string, extra: string[]): string[] {
  const clean = (word: string): string => word.replace(/#.*$/, '').trim().replace(/^(['"`])(.*)\1$/, '$2').trim();
  const flow = /\[([^\]]*)\]/.exec(`${value} ${extra.join(' ')}`);
  if (flow !== null) return flow[1].split(',').map(clean).filter((word) => word !== '');
  const items = extra.map((line) => /^-\s+(.*)$/.exec(line.trim())).filter((found): found is RegExpExecArray => found !== null);
  if (items.length > 0) return items.map((found) => clean(found[1])).filter((word) => word !== '');
  const single = clean(value);
  return single === '' ? [] : [single];
}

/**
 * A job's `needs` names, and its other lines without filler. The `needs` key sits with the
 * job's other keys; its list lines sit further in.
 */
function splitNeeds(body: string[]): { needs: string[]; rest: string[] } {
  const skip = new Set<number>();
  let needs: string[] = [];
  const keyIndent = indentOf(body[0]) + 2;
  const at = body.findIndex((line, index) => index > 0 && !isFillerLine(line) && indentOf(line) === keyIndent && /^\s*needs\s*:(.*)$/.test(line));
  if (at !== -1) {
    const value = /^\s*needs\s*:(.*)$/.exec(body[at])![1];
    skip.add(at);
    const extra: string[] = [];
    for (let i = at + 1; i < body.length && !isFillerLine(body[i]) && indentOf(body[i]) > indentOf(body[at]); i++) {
      skip.add(i);
      extra.push(body[i]);
    }
    needs = needNames(value, extra);
  }
  return { needs, rest: body.filter((line, index) => !skip.has(index) && !isFillerLine(line)) };
}

/**
 * Whether the project's copy keeps every job the kit's copy has (#552): the same block, but
 * a `needs` list may name more jobs, and the project may add its own. Only the kit's jobs
 * are read: a job the user added under `jobs:`, the way doctor's tests step says, never
 * makes the copy look out of date on its own. False when either copy has no `jobs:` block.
 */
export function hasIntactKitJobs(projectText: string, kitText: string): boolean {
  const project = readJobs(projectText);
  const kit = readJobs(kitText);
  if (project === null || kit === null) return false;
  if (project.before !== kit.before || project.after !== kit.after) return false;
  for (const [name, lines] of kit.jobs) {
    const mine = project.jobs.get(name);
    if (!mine) return false;
    const kept = splitNeeds(mine);
    const wanted = splitNeeds(lines);
    if (!wanted.needs.every((need) => kept.needs.includes(need))) return false;
    if (kept.rest.join('\n') !== wanted.rest.join('\n')) return false;
  }
  return true;
}

/** The state of the project's `rel` against `kitText`, the kit's file rendered for this project. */
export function compareWorkflow(root: string, rel: string, kitText: string, hashes: Record<string, string[]> = readWorkflowHashes()): WorkflowState {
  if (findLinkOnPath(root, rel)) return 'link';
  const path = join(root, rel);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 'missing';
  }
  // A folder or another odd thing at the path is not a copy of the kit's: keep it.
  if (!stat.isFile()) return 'changed';
  const text = lfText(readFileSync(path, 'utf8'));
  if (text === kitText) return 'same';
  if ((hashes[rel] ?? []).includes(fileHash(text))) return 'older';
  // The project's own jobs stay: only the kit's own jobs falling behind says so (#552).
  if (hasIntactKitJobs(text, kitText)) return 'same';
  return 'changed';
}

/** The command that shows how the project's `rel` differs from the kit's copy in its .yokoten/ (or in yokoten itself). */
export const workflowDiffCommand = (root: string, rel: string): string => `git diff --no-index ${rel} ${isSelf(root) ? '' : '.yokoten/'}kit/project/${rel}`;

/** Write one kit workflow: new, or in place of an old kit copy; a changed copy or a symlink is kept. */
export function writeWorkflow(root: string, rel: string, kitText: string, env: Env): string {
  const state = compareWorkflow(root, rel, kitText);
  if (state === 'missing') return `${writeNew(join(root, rel), kitText)} ${rel}`;
  if (state === 'same') return `kept ${rel}`;
  if (state === 'link') return `kept ${rel}: it is a symlink, so yokoten did not write through it`;
  if (state === 'changed') return `kept ${rel}: it has your changes. To see how the kit's newest copy differs: \`${workflowDiffCommand(root, rel)}\``;
  const path = join(root, rel);
  // Replace the file only when git can give the old one back: tracked, and the same as HEAD
  // (record 0014: unsure means keep).
  const bytes = readFileSync(path);
  if (!isInHead(root, rel, bytes, env)) return `kept ${rel}: it is an older kit copy that is not committed, so commit it and run init again`;
  // A file with Windows line ends keeps them, so git shows only the lines that changed.
  const isCrlf = bytes.includes('\r\n');
  writeFileSync(path, isCrlf ? normalizeText(kitText).replace(/\n/g, '\r\n') : kitText);
  return `updated ${rel} to the kit's newest copy (you had not changed it; \`git restore --source=HEAD -- ${rel}\` brings the old one back)`;
}

/** The kit's workflows, by path in a project, rendered for `root`; empty when this copy of yokoten has none. */
function readKitWorkflows(root: string): Map<string, string> {
  const dir = join(KIT, 'project', WORKFLOWS_DIR);
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).sort().map((name) => [`${WORKFLOWS_DIR}${name}`, render(readFileSync(join(dir, name), 'utf8'), { cli: cliPath(root), version: VERSION })]));
}

/**
 * For full doctor: one note for each kit workflow that is an old copy, or has the project's
 * changes. A changed copy's note has a `seen` key, the file and the kit's version, so doctor
 * can say it once per kit version (#456); an old copy is noted each time, until init updates it.
 */
export function workflowNotes(root: string): { note: Finding; seen?: string }[] {
  const notes: { note: Finding; seen?: string }[] = [];
  // With CI off init keeps the workflows, so there is nothing to tell the user to run init for.
  if (isCiOffIn(root)) return notes;
  const hashes = readWorkflowHashes();
  for (const [rel, kitText] of readKitWorkflows(root)) {
    const state = compareWorkflow(root, rel, kitText, hashes);
    if (state === 'older') notes.push({ note: finding('kit-workflows', `${rel} is an older copy of the kit's, and you never changed it`, 'run `yokoten init` to update it') });
    if (state === 'changed') {
      const note = finding('kit-workflows', `${rel} has your changes, and the kit's newest copy differs`, `to see how: \`${workflowDiffCommand(root, rel)}\`; copy what you want by hand`);
      notes.push({ note, seen: `${rel} ${textHash(kitText)}` });
    }
  }
  return notes;
}
