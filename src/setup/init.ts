// `yokoten init`: put the practices into a project. It only adds: a file that is already
// there is kept, and the report says so. Deciding what to do with a project's own rules
// (keep, merge, or say not now) is the yokoten skill's job, not this command's.
//
// `yokoten update` is the one command here that replaces text: the core rules in
// AGENTS.md, and only with --write. It is at the end of this file.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { addProjectHook, addProjectStopHook, setProjectEnv } from '../agents/claude-code.ts';
import * as codex from '../agents/codex.ts';
import * as gemini from '../agents/gemini.ts';
import { copyRuntime, HOME_DIR, KIT, render, VERSION, writeNew } from './files.ts';

/** yokoten's own repo runs its own bin; every other project runs a vendored copy. */
export const isSelf = (root: string): boolean => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'yokoten' && existsSync(join(root, 'bin', 'yokoten.ts'));
  } catch {
    return false;
  }
};

export const cliPath = (root: string): string => (isSelf(root) ? 'bin/yokoten.ts' : '.yokoten/bin/yokoten.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Returns one line per thing done or kept. */
export function init(root: string): string[] {
  const report: string[] = [];
  const cli = cliPath(root);
  if (!isSelf(root) && root !== HOME_DIR) {
    copyRuntime(join(root, '.yokoten'));
    report.push('wrote .yokoten/ (the runtime the hooks run; commit it)');
  }
  const kit = join(KIT, 'project');
  for (const file of walk(kit)) {
    const rel = relative(kit, file).split('\\').join('/');
    const result = writeNew(join(root, rel), render(readFileSync(file, 'utf8'), { cli }));
    report.push(`${result} ${rel}`);
  }
  chmodSync(join(root, '.githooks', 'pre-commit'), 0o755);
  const hook = addProjectHook(root, cli);
  report.push(`${hook} the tool-call hook in .claude/settings.json`);
  report.push(`${addProjectStopHook(root, cli)} the stop check in .claude/settings.json (changed files, before the agent ends its turn)`);
  // Codex and Gemini CLI get the same guard, whether or not they are installed here: two
  // small files are easier to predict than a guess about which agents someone uses.
  report.push(`${codex.addProjectHook(root, cli)} the Codex tool-call hook in .codex/hooks.json (Codex asks you to trust it once, in /hooks)`);
  report.push(`${gemini.addProjectHook(root, cli)} the Gemini CLI tool-call hook in .gemini/settings.json`);
  report.push(`${setProjectEnv(root, 'TZ', 'UTC')} TZ=UTC for agent sessions in .claude/settings.json (commit times carry no time zone)`);
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
    report.push('set git core.hooksPath to .githooks (the commit check)');
  } catch {
    report.push('not a git repo: run `git init`, then `git config core.hooksPath .githooks`');
  }
  return report;
}

// ---- The core rules in AGENTS.md (#120) ----
//
// init writes AGENTS.md once, so a lesson added to the kit's core rules never reaches a
// project on its own. `doctor` compares the core part with the kit, and `yokoten update`
// replaces it, only when asked. The project's own part, from `## This project` down, is
// the project's file: it is kept byte for byte.

/** The heading where a project's own rules start. Everything above it is the kit's core rules. */
export const PROJECT_HEADING = '## This project';

/** Where the project's own part starts, or -1 when there is no `## This project` line. */
const findProjectStart = (text: string): number => text.search(/^## This project[ \t]*\r?$/m);

const splitLines = (text: string): string[] => text.split(/\r?\n/);

/** One line the update adds or removes. */
export interface LineChange {
  kind: 'added' | 'removed';
  line: string;
}

/** The `##` sections of the core part that the update adds, removes or changes. The text above the first is "the opening". */
export interface SectionChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/** How a project's core rules compare with the kit's. */
export type CoreRules =
  | { state: 'same' }
  | { state: "can't compare"; why: string; fix: string }
  | { state: 'behind'; changes: LineChange[]; sections: SectionChanges; updated: string };

/** The lines to remove and add to turn `before` into `after`, from their longest common run. */
function diffLines(before: string[], after: string[]): LineChange[] {
  // common[row][column]: the longest common run of before[row..] and after[column..].
  const common = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let row = before.length - 1; row >= 0; row--) {
    for (let column = after.length - 1; column >= 0; column--) {
      common[row][column] = before[row] === after[column] ? common[row + 1][column + 1] + 1 : Math.max(common[row + 1][column], common[row][column + 1]);
    }
  }
  const changes: LineChange[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length || column < after.length) {
    if (row < before.length && column < after.length && before[row] === after[column]) {
      row++;
      column++;
    } else if (column === after.length || (row < before.length && common[row + 1][column] >= common[row][column + 1])) {
      changes.push({ kind: 'removed', line: before[row++] });
    } else {
      changes.push({ kind: 'added', line: after[column++] });
    }
  }
  return changes;
}

/** Each `##` section of a core part, by name, with its text. */
function readSections(lines: string[]): Map<string, string> {
  const sections = new Map<string, string>();
  let name = 'the opening';
  let body: string[] = [];
  for (const line of [...lines, '## ']) {
    if (!line.startsWith('## ')) {
      body.push(line);
      continue;
    }
    sections.set(name, body.join('\n'));
    name = line.slice(3).trim();
    body = [];
  }
  return sections;
}

function compareSections(before: string[], after: string[]): SectionChanges {
  const old = readSections(before);
  const next = readSections(after);
  return {
    added: [...next.keys()].filter((name) => !old.has(name)),
    removed: [...old.keys()].filter((name) => !next.has(name)),
    changed: [...next.keys()].filter((name) => old.has(name) && old.get(name) !== next.get(name)),
  };
}

/**
 * Compare a project's AGENTS.md with the kit's, rendered. Line ends do not count, so a
 * checkout with CRLF is not behind. `updated` is the file with the kit's core part and
 * the project's own part as it is.
 */
export function compareCoreRules(project: string, kit: string): CoreRules {
  const kitStart = findProjectStart(kit);
  if (kitStart === -1) return { state: "can't compare", why: `the kit's AGENTS.md has no \`${PROJECT_HEADING}\` heading`, fix: 'report it in an issue at yokoten' };
  const start = findProjectStart(project);
  if (start === -1) {
    return {
      state: "can't compare",
      why: `AGENTS.md has no \`${PROJECT_HEADING}\` heading, so yokoten can't tell the core rules from the project's own`,
      fix: `put the project's own rules under a \`${PROJECT_HEADING}\` heading at the end of AGENTS.md, below the core rules`,
    };
  }
  const before = splitLines(project.slice(0, start));
  const after = splitLines(kit.slice(0, kitStart));
  if (before.join('\n') === after.join('\n')) return { state: 'same' };
  const core = project.slice(0, start).includes('\r\n') ? after.join('\r\n') : after.join('\n');
  return { state: 'behind', changes: diffLines(before, after), sections: compareSections(before, after), updated: core + project.slice(start) };
}

/** The kit's AGENTS.md, rendered for this project, or null when this copy of yokoten has no kit. */
function readKitRules(root: string): string | null {
  const path = join(KIT, 'project', 'AGENTS.md');
  return existsSync(path) ? render(readFileSync(path, 'utf8'), { cli: cliPath(root) }) : null;
}

/** The project's core rules against the kit's, or null when the project has no AGENTS.md. */
export function readCoreRules(root: string): CoreRules | null {
  const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) return null;
  const kit = readKitRules(root);
  if (kit === null) {
    return { state: "can't compare", why: 'this copy of yokoten has no kit (the copy in .yokoten/ leaves it out)', fix: 'run the command from an installed yokoten or a clone, not from .yokoten/' };
  }
  return compareCoreRules(readFileSync(path, 'utf8'), kit);
}

/** A short summary of an update: line counts, then the sections it touches. */
export function summarizeUpdate(rules: { changes: LineChange[]; sections: SectionChanges }): string {
  const count = (kind: LineChange['kind']) => rules.changes.filter((change) => change.kind === kind).length;
  const parts = [`${count('added')} line(s) added, ${count('removed')} removed`];
  for (const kind of ['changed', 'added', 'removed'] as const) {
    if (rules.sections[kind].length) parts.push(`sections ${kind}: ${rules.sections[kind].join(', ')}`);
  }
  return parts.join('; ');
}

/**
 * `yokoten update`: replace the core part of AGENTS.md with the kit's. Without `write`
 * it only shows the change. `ok` is false when there is nothing it can compare.
 */
export function updateCoreRules(root: string, { write }: { write: boolean }): { ok: boolean; lines: string[] } {
  const rules = readCoreRules(root);
  if (rules === null) return { ok: false, lines: ['no AGENTS.md here; nothing was written. Run `yokoten init` to add one'] };
  if (rules.state === "can't compare") return { ok: false, lines: [`can't compare AGENTS.md with the kit: ${rules.why}. Nothing was written. To fix it, ${rules.fix}`] };
  if (rules.state === 'same') return { ok: true, lines: [`the core rules in AGENTS.md are up to date with yokoten ${VERSION}; nothing to change`] };
  const summary = summarizeUpdate(rules);
  if (write) {
    writeFileSync(join(root, 'AGENTS.md'), rules.updated);
    return { ok: true, lines: [`replaced the core rules in AGENTS.md with yokoten ${VERSION}'s: ${summary}. "${PROJECT_HEADING}" and below are unchanged`] };
  }
  return {
    ok: true,
    lines: [
      `the core rules in AGENTS.md differ from yokoten ${VERSION}'s: ${summary}`,
      '',
      ...rules.changes.map((change) => `${change.kind === 'added' ? '+' : '-'} ${change.line.trim() ? change.line : '(a blank line)'}`),
      '',
      'A line marked - is replaced. An older kit wrote it, or someone edited it by hand.',
      `Move any rule of your own under "${PROJECT_HEADING}" first. That part stays as it is.`,
      'Nothing was written. Run `yokoten update --write` to write it.',
    ],
  };
}
