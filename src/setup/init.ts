// `yokoten init`: put the practices into a project. It only adds: a file that is already
// there is kept, and the report says so. Two files get lines added, never removed: a
// CLAUDE.md, and a project's own pre-commit (#206). Deciding what to do with a project's
// own rules (keep, merge, or say not now) is the yokoten skill's job, not this command's.
//
// `yokoten update` is the one command here that replaces text: the core rules in
// AGENTS.md, and only with --write. It is at the end of this file.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { addProjectHook, addProjectStopHook, setProjectEnv } from '../agents/claude-code.ts';
import * as codex from '../agents/codex.ts';
import * as gemini from '../agents/gemini.ts';
import { runs } from '../run/cli.ts';
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
    const copied = copyRuntime(join(root, '.yokoten'));
    report.push(copied === 'kept' ? 'kept .yokoten/ (the copy running now)' : 'wrote .yokoten/ (the runtime the hooks run; commit it)');
  }
  const hooks = readHookSetup(root);
  const kit = join(KIT, 'project');
  for (const file of walk(kit)) {
    const rel = relative(kit, file).split('\\').join('/');
    // A project with its own hooks folder keeps it, so .githooks/ would be a hook git never runs.
    if (hooks.kind === 'own' && rel.startsWith('.githooks/')) continue;
    const result = writeNew(join(root, rel), render(readFileSync(file, 'utf8'), { cli, version: VERSION }));
    report.push(`${result} ${rel}`);
  }
  if (hooks.kind !== 'own') chmodSync(join(root, '.githooks', 'pre-commit'), 0o755);
  const imported = importRules(root);
  if (imported) report.push(imported);
  const hook = addProjectHook(root, cli);
  report.push(`${hook} the tool-call hook in .claude/settings.json`);
  report.push(`${addProjectStopHook(root, cli)} the stop check in .claude/settings.json (changed files, before the agent ends its turn)`);
  // Codex and Gemini CLI get the same guard, whether or not they are installed here: two
  // small files are easier to predict than a guess about which agents someone uses.
  report.push(`${codex.addProjectHook(root, cli)} the Codex tool-call hook in .codex/hooks.json (Codex asks you to trust it once, in /hooks)`);
  report.push(`${gemini.addProjectHook(root, cli)} the Gemini CLI tool-call hook in .gemini/settings.json`);
  report.push(`${codex.addProjectStopHook(root, cli)} the Codex stop check in .codex/hooks.json`);
  report.push(`${gemini.addProjectStopHook(root, cli)} the Gemini CLI stop check in .gemini/settings.json (AfterAgent)`);
  report.push(`${setProjectEnv(root, 'TZ', 'UTC')} TZ=UTC for agent sessions in .claude/settings.json (commit times carry no time zone)`);
  report.push(...setCommitCheck(root, cli, hooks));
  return report;
}

// ---- A project's own CLAUDE.md and commit hooks (#206) ----
//
// init adds; it never switches a project's setup off without saying so. Claude Code reads
// AGENTS.md only when there is no CLAUDE.md, so a CLAUDE.md gets one line that imports it.
// A project with its own hooks folder (husky, or another core.hooksPath) keeps it, and
// that folder's pre-commit gets the yokoten check: one hooks folder, so nothing is turned off.

/** A CLAUDE.md line that imports AGENTS.md (`@AGENTS.md`) or links to it. */
const RULES_IMPORT = /(?:^|\s)@(?:\.\/)?AGENTS\.md\b|\]\((?:\.\/)?AGENTS\.md\)/m;

/** True when Claude Code reads AGENTS.md here: there is no CLAUDE.md, or it imports AGENTS.md. */
export function claudeReadsRules(root: string): boolean {
  const path = join(root, 'CLAUDE.md');
  return !existsSync(path) || RULES_IMPORT.test(readFileSync(path, 'utf8'));
}

/** Add the AGENTS.md import to a CLAUDE.md that lacks it. Returns the report line, or null when nothing changed. */
function importRules(root: string): string | null {
  if (claudeReadsRules(root)) return null;
  const path = join(root, 'CLAUDE.md');
  const text = readFileSync(path, 'utf8');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const gap = text === '' ? '' : text.endsWith(newline) ? newline : newline + newline;
  writeFileSync(path, `${text}${gap}<!-- Added by yokoten: Claude Code reads AGENTS.md only through this import. -->${newline}@AGENTS.md${newline}`);
  return 'updated CLAUDE.md: it now reads AGENTS.md (Claude Code reads AGENTS.md only when CLAUDE.md imports it)';
}

/** How git runs commit hooks here: yokoten's .githooks, the project's own folder, or no git repo. */
type HookSetup = { kind: 'plain' } | { kind: 'own'; hooksPath: string } | { kind: 'no repo' };

/** The repo's own core.hooksPath (not the user's global one), '' when unset, or null outside a git repo. */
function readLocalHooksPath(root: string): string | null {
  try {
    return execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    return (error as { status?: number }).status === 1 ? '' : null;
  }
}

function readHookSetup(root: string): HookSetup {
  const hooksPath = readLocalHooksPath(root);
  if (hooksPath === null) return { kind: 'no repo' };
  const isHusky = existsSync(join(root, '.husky'));
  if (!isHusky && (hooksPath === '' || hookFile(root, hooksPath) === '.githooks/pre-commit')) return { kind: 'plain' };
  return { kind: 'own', hooksPath };
}

/**
 * The pre-commit file git runs for this core.hooksPath, relative to the root, or null when
 * the folder is outside the repo. husky's folder (`.husky/_`, or `.husky` before husky 9)
 * runs `.husky/pre-commit`.
 */
export function hookFile(root: string, hooksPath: string): string | null {
  const folder = relative(root, resolve(root, hooksPath)).split('\\').join('/');
  if (folder === '..' || folder.startsWith('../') || isAbsolute(folder)) return null;
  if (folder === '.husky' || folder.startsWith('.husky/')) return '.husky/pre-commit';
  return folder ? `${folder}/pre-commit` : 'pre-commit';
}

/**
 * The lines init adds to a project's own pre-commit. `exit 1` because a hook may go on after
 * them. Without the runtime, one plain line, as in the kit's pre-commit (#204).
 */
const checkLines = (cli: string) => [
  '# yokoten: the commit check (lead-only files, test files in a fix task, layout and privacy)',
  `[ -f "${cli}" ] || { echo 'yokoten: the commit check cannot run, because ${cli} is missing. Restore it from git, or run yokoten init again' >&2; exit 1; }`,
  `node "${cli}" check --staged || exit 1`,
];

/** Add the yokoten check to a pre-commit, after its `#!` line, so a later `exec` can't skip it. Its own lines stay. */
function addCheckLines(path: string, cli: string): 'added the check to' | 'wrote' | 'same' {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ['#!/bin/sh', ...checkLines(cli), ''].join('\n'), { mode: 0o755 });
    chmodSync(path, 0o755);
    return 'wrote';
  }
  const text = readFileSync(path, 'utf8');
  if (runs('check').test(text)) return 'same';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, ...checkLines(cli));
  writeFileSync(path, lines.join(newline));
  chmodSync(path, statSync(path).mode | 0o111);
  return 'added the check to';
}

/** Point git at the commit check: set .githooks, or add the check to the project's own pre-commit. */
function setCommitCheck(root: string, cli: string, hooks: HookSetup): string[] {
  if (hooks.kind === 'no repo') return ['not a git repo: run `git init`, then `git config core.hooksPath .githooks`'];
  if (hooks.kind === 'plain') {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
    return ['set git core.hooksPath to .githooks (the commit check)'];
  }
  const { hooksPath } = hooks;
  const file = hooksPath ? hookFile(root, hooksPath) : '.husky/pre-commit';
  const owner = hooksPath ? `core.hooksPath (${file === '.husky/pre-commit' ? 'husky' : hooksPath})` : 'husky';
  if (file === null) {
    return [`kept core.hooksPath: it is outside this repo, so yokoten did not change it. Add this line to its pre-commit: node "${cli}" check --staged || exit 1`];
  }
  const lines = [`${addCheckLines(join(root, file), cli)} ${file}: the commit check (kept ${owner}, so the project's own hooks still run)`];
  if (!hooksPath) lines.push('husky is not set up in this clone yet: run `npm install` (husky sets core.hooksPath), and the check runs from .husky/pre-commit');
  return lines;
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

// ---- The kit version in AGENTS.md (#141) ----
//
// The first line of the kit's AGENTS.md says which kit wrote the core rules, as an HTML
// comment, so GitHub shows nothing. With it, a project written by a newer yokoten is not
// "behind", and `update --write` never takes it back to an older kit. A file without the
// mark (every project before #141) has an unknown version and compares by content only.

/** The kit version mark, for example `<!-- yokoten kit 0.1.0 -->`. */
const KIT_MARK = /^<!-- yokoten kit (\S+) -->[ \t]*$/;

const isMarkLine = (line: string): boolean => KIT_MARK.test(line);

/** The kit version that a core part names, or null when it has no mark. */
export const readKitVersion = (core: string): string | null => {
  for (const line of splitLines(core)) {
    const found = line.match(KIT_MARK);
    if (found) return found[1];
  }
  return null;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver order of two pre-release tags, like `beta.2` and `beta.10`. */
function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    const [a, b] = [leftParts[index], rightParts[index]];
    if (a === b) continue;
    const [isNumberA, isNumberB] = [/^\d+$/.test(a), /^\d+$/.test(b)];
    if (isNumberA && isNumberB) return Math.sign(Number(a) - Number(b));
    if (isNumberA !== isNumberB) return isNumberA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return Math.sign(leftParts.length - rightParts.length);
}

/** -1, 0 or 1 as `left` is older than, the same as, or newer than `right`; null when either is not a semver version. */
export function compareVersions(left: string, right: string): number | null {
  const a = left.match(SEMVER);
  const b = right.match(SEMVER);
  if (!a || !b) return null;
  for (let part = 1; part <= 3; part++) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference) return Math.sign(difference);
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  return comparePrerelease(a[4], b[4]);
}

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
  | { state: 'behind'; changes: LineChange[]; sections: SectionChanges; updated: string }
  | { state: 'newer'; version: string; kitVersion: string };

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
 * Compare a project's AGENTS.md with the kit's, rendered. Line ends and the kit version
 * mark do not count, so a checkout with CRLF is not behind. When the text differs and the
 * project's mark is newer than the kit's, it is `newer`, never `behind` (#141). `updated` is the file with the kit's core part and
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
  const before = splitLines(project.slice(0, start)).filter((line) => !isMarkLine(line));
  const after = splitLines(kit.slice(0, kitStart)).filter((line) => !isMarkLine(line));
  if (before.join('\n') === after.join('\n')) return { state: 'same' };
  const version = readKitVersion(project.slice(0, start));
  const kitVersion = readKitVersion(kit.slice(0, kitStart));
  if (version !== null && kitVersion !== null && compareVersions(version, kitVersion) === 1) return { state: 'newer', version, kitVersion };
  const kitCore = splitLines(kit.slice(0, kitStart));
  const core = project.slice(0, start).includes('\r\n') ? kitCore.join('\r\n') : kitCore.join('\n');
  return { state: 'behind', changes: diffLines(before, after), sections: compareSections(before, after), updated: core + project.slice(start) };
}

/** The kit's AGENTS.md, rendered for this project, or null when this copy of yokoten has no kit. A project's .yokoten/ has this one kit file (#145). */
function readKitRules(root: string): string | null {
  const path = join(KIT, 'project', 'AGENTS.md');
  return existsSync(path) ? render(readFileSync(path, 'utf8'), { cli: cliPath(root), version: VERSION }) : null;
}

/** The project's core rules against the kit's, or null when the project has no AGENTS.md. */
export function readCoreRules(root: string): CoreRules | null {
  const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) return null;
  const kit = readKitRules(root);
  if (kit === null) {
    return { state: "can't compare", why: 'this copy of yokoten has no kit (a .yokoten/ copy made before #145 has none)', fix: 'run `yokoten init` again to refresh .yokoten/, or run the command from an installed yokoten, the Claude Code plugin (/yokoten:update), or a clone' };
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
  if (rules.state === 'newer') {
    return { ok: false, lines: [`AGENTS.md was written by yokoten ${rules.version}, newer than this yokoten ${VERSION}. Nothing was written: an update would take the core rules back to an older kit. Update yokoten itself instead, then run \`yokoten update\` again`] };
  }
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
