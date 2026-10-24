
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { findMainNewline } from './claude-hooks.ts';
import { KIT, render, VERSION } from '../files.ts';
import { cliPath } from './project-files.ts';

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

// ---- The core rules into an AGENTS.md the project already has (#378) ----
//
// Without `## This project`, yokoten can't tell the core rules from the project's own, so
// doctor can only ask the owner to merge the two by hand. init does the merge: the kit's
// core rules on top, then `## This project`, then the project's text. Its headings go one
// level down, so they sit under that heading; every other byte stays. A file that has the
// heading is left to `update`.

/** One heading the move took one level down, as it read before and reads after, ready to print. */
export interface MovedHeading {
  before: string;
  after: string;
}

/** The new AGENTS.md, and what the move changed in the project's text. */
export interface MovedRules {
  text: string;
  /** The project's lines that moved; 0 for an empty file. */
  lines: number;
  headings: MovedHeading[];
  /** `######` headings: Markdown has no seventh level, so they stay as they are. */
  deepest: string[];
  hadBom: boolean;
  /** Whether the file started with YAML front matter, which stays at the very top. */
  frontMatter: boolean;
}

/**
 * Split off YAML front matter: a first line `---` and a closing `---` or `...` line, with
 * their line ends. Without a closing line there is no front matter, and `front` is empty.
 */
export function splitFrontMatter(text: string): { front: string; rest: string } {
  const found = /^---[ \t]*\r?\n(?:[^\n]*\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return found ? { front: found[0], rest: text.slice(found[0].length) } : { front: '', rest: text };
}

const ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
const SETEXT_LINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** A line that can't be the text of a setext heading: a heading or a rule. */
const NOT_PARAGRAPH = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$)/;
/** A list item, a quote or HTML: the lines after it, up to a blank line, belong to it, never to a heading. */
const OTHER_BLOCK = /^ {0,3}(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|<)/;

/**
 * The project's text with each heading one level down: `#` to `##`, a `===` underline to
 * `---`, and a `---` underline to a `###` line (Markdown has no third underline). Headings
 * inside fenced code blocks stay. Line endings stay as each line has them.
 */
export function demoteHeadings(text: string): { text: string; headings: MovedHeading[]; deepest: string[] } {
  // Each line with its own ending, so CRLF and LF lines both stay as they are.
  const lines = (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((piece) => {
    const end = piece.match(/\r?\n$/)?.[0] ?? '';
    return { body: piece.slice(0, piece.length - end.length), end };
  });
  const headings: MovedHeading[] = [];
  const deepest: string[] = [];
  const out: { body: string; end: string }[] = [];
  let fence: { mark: string; length: number } | null = null;
  // Where the paragraph that ends at the current line starts in `out`, or -1.
  let paragraph = -1;
  // Inside a list item, a quote or HTML, where a line under the text is never a heading underline.
  let other = false;
  for (const line of lines) {
    const found = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.body);
    if (fence) {
      if (found && found[1][0] === fence.mark && found[1].length >= fence.length && found[2].trim() === '') fence = null;
      out.push(line);
      continue;
    }
    if (found && !(found[1][0] === '`' && found[2].includes('`'))) {
      fence = { mark: found[1][0], length: found[1].length };
      paragraph = -1;
      out.push(line);
      continue;
    }
    if (paragraph !== -1 && SETEXT_LINE.test(line.body)) {
      const words = out.slice(paragraph).map((part) => part.body.trim()).join(' ');
      const before = `\`${words}\` (underlined with ${line.body.trim()[0]})`;
      if (line.body.includes('=')) {
        out.push({ body: line.body.replaceAll('=', '-'), end: line.end });
        headings.push({ before, after: `\`${words}\` (underlined with -)` });
      } else {
        const heading = `### ${words}`;
        out.splice(paragraph, out.length - paragraph, { body: heading, end: line.end });
        headings.push({ before, after: `\`${heading}\`` });
      }
      paragraph = -1;
      continue;
    }
    const atx = ATX_HEADING.exec(line.body);
    if (atx) {
      if (atx[2].length === 6) deepest.push(`\`${line.body.trim()}\``);
      else {
        const body = `${atx[1]}#${line.body.slice(atx[1].length)}`;
        headings.push({ before: `\`${line.body.trim()}\``, after: `\`${body.trim()}\`` });
        line.body = body;
      }
      paragraph = -1;
      other = false;
    } else if (line.body.trim() === '') {
      paragraph = -1;
      other = false;
    } else if (NOT_PARAGRAPH.test(line.body) || OTHER_BLOCK.test(line.body)) {
      paragraph = -1;
      other = OTHER_BLOCK.test(line.body);
    } else if (paragraph === -1 && !other) {
      // Four spaces where no paragraph goes on start a code block, not a paragraph.
      if (!/^ {4}|^\t/.test(line.body)) paragraph = out.length;
    }
    out.push(line);
  }
  return { text: out.map((line) => line.body + line.end).join(''), headings, deepest };
}

/**
 * The kit's core rules, then `## This project`, then the project's own text with its
 * headings one level down. `kit` is the kit's AGENTS.md, rendered. The new lines take the
 * line ending most of the project's lines use. A byte order mark is dropped: the kit
 * version mark must start the file.
 */
export function moveUnderProjectHeading(project: string, kit: string): MovedRules {
  const hadBom = project.startsWith('\uFEFF');
  const { front, rest: own } = splitFrontMatter(hadBom ? project.slice(1) : project);
  const frontMatter = front !== '';
  const newline = findMainNewline(front + own);
  // Front matter stays on top, and ends in a newline so the kit's first line starts a line.
  const top = front === '' || /\n$/.test(front) ? front : front + newline;
  const kitStart = findProjectStart(kit);
  if (own.trim() === '') return { text: top + splitLines(kit).join(newline), lines: 0, headings: [], deepest: [], hadBom, frontMatter };
  const core = splitLines(kit.slice(0, kitStart)).join(newline);
  const demoted = demoteHeadings(own);
  return {
    frontMatter,
    text: `${top}${core}${PROJECT_HEADING}${newline}${newline}${demoted.text}`,
    lines: splitLines(own.replace(/\r?\n$/, '')).length,
    headings: demoted.headings,
    deepest: demoted.deepest,
    hadBom,
  };
}
/** The name of the copy init keeps of an AGENTS.md that git can't give back. */
export const AGENTS_BACKUP = 'AGENTS.md.before-yokoten';

/** Whether HEAD has this file with these exact bytes, so git can give it back. */
export function isInHead(root: string, rel: string, bytes: Buffer, env: Env): boolean {
  try {
    const committed = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return committed.equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Put the core rules into the project's AGENTS.md when it has no `## This project`
 * heading. Returns the report lines. The old file can always come back: from git when
 * HEAD has it as it is, or else from a copy next to it.
 */
export function addCoreRules(root: string, kit: string, env: Env): string[] {
  const path = join(root, 'AGENTS.md');
  if (lstatSync(path).isSymbolicLink()) {
    return [`kept AGENTS.md: it is a link to ${readlinkSync(path)}, so yokoten did not write the core rules into it. Put them in by hand, above a \`${PROJECT_HEADING}\` heading`];
  }
  const bytes = readFileSync(path);
  const project = bytes.toString('utf8');
  if (findProjectStart(project) !== -1) return ['kept AGENTS.md (`yokoten update` brings its core rules up to date)'];
  if (findProjectStart(kit) === -1) return [`kept AGENTS.md: the kit's AGENTS.md has no \`${PROJECT_HEADING}\` heading; report it in an issue at yokoten`];
  let restore = 'to get the old file back: `git checkout HEAD -- AGENTS.md`';
  if (!isInHead(root, 'AGENTS.md', bytes, env)) {
    const backup = join(root, AGENTS_BACKUP);
    if (existsSync(backup) && !readFileSync(backup).equals(bytes)) {
      return [`kept AGENTS.md: it has no \`${PROJECT_HEADING}\` heading, and ${AGENTS_BACKUP} is there already, so yokoten kept both as they are. Move ${AGENTS_BACKUP} away, then run \`yokoten init\` again`];
    }
    writeFileSync(backup, bytes);
    restore = `kept the old file as ${AGENTS_BACKUP}; delete it once the new AGENTS.md reads right`;
  }
  const moved = moveUnderProjectHeading(project, kit);
  writeFileSync(path, moved.text);
  if (moved.lines === 0) return [`wrote AGENTS.md: it had no text${moved.frontMatter ? ' below its front matter' : ''}, so it now has the core rules and an empty \`${PROJECT_HEADING}\` section (${restore})`];
  const lines = [`updated AGENTS.md: the core rules are on top, and your ${moved.lines} line(s) moved under \`${PROJECT_HEADING}\`; only their heading levels changed (${restore})`];
  for (const heading of moved.headings) lines.push(`  heading one level down: ${heading.before} is now ${heading.after}`);
  if (moved.deepest.length) lines.push(`  kept at level 6 (Markdown has no level 7): ${moved.deepest.join(', ')}`);
  if (moved.frontMatter) lines.push('  kept the front matter at the very top, as it was');
  if (moved.hadBom) lines.push('  dropped the byte order mark at the start: the kit version line must come first');
  lines.push('  read the core rules, and remove any rule of yours under them that says the same thing');
  return lines;
}

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
export function compareCoreRules(file: string, kit: string): CoreRules {
  // Front matter above the core rules is the project's: not compared, and kept by an update (#378).
  const { front, rest: project } = splitFrontMatter(file);
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
  return { state: 'behind', changes: diffLines(before, after), sections: compareSections(before, after), updated: front + core + project.slice(start) };
}

/** The kit's AGENTS.md, rendered for this project, or null when this copy of yokoten has no kit. A project's .yokoten/ has this kit file (#145) and the kit's lessons (#77). */
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
