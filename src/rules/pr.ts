// The pull request rule: a pull request says what it is, why, how it was checked, how
// hard it is to take back, and which issue it closes. Its title becomes the one commit
// on main, so the title has the commit form. A reviewer, the owner or an agent, reads
// the same shape every time, and a beginner learns it from what CI says.
//
// Each problem says what is wrong, why, and how to fix it (a Finding). Text from the pull request is user
// input: it is read here as data, and never printed back in full.

import type { Config } from './config.ts';
import { matcher } from './config.ts';
import { type Finding, finding } from './message.ts';

/** A pull request, as any code host can describe it. */
export interface PullRequest {
  title: string;
  body: string;
  /** Paths the pull request changes, relative to the repo root. */
  files: string[];
  /** The paths in `files` that the pull request deletes. */
  deleted?: string[];
  labels: string[];
  milestone: string | null;
  /** The login of the account that opened it, or '' when the host does not say. */
  author?: string;
}

const TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'chore', 'ci', 'perf', 'build', 'style', 'revert'];
const TITLE = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9./-]*\\))?!?: \\S`);
const SECTIONS = ['Why', 'What changed', 'How tested'];

let graphemes: Intl.Segmenter | null | undefined;

/**
 * The length of text as a person counts it (#268): one per character they see, so an emoji,
 * a flag or a family emoji is 1, not the 2 to 11 UTF-16 code units `.length` gives.
 * The segmenter is made on first use, so a Node built without Intl still runs every other
 * command; there a title counts code points.
 */
export function visibleLength(text: string): number {
  if (graphemes === undefined) graphemes = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
  return graphemes ? [...graphemes.segment(text)].length : [...text].length;
}

/**
 * Label names that also say a type, for projects whose labels do not use the type name
 * itself. This repo names the fix label `bug`; GitHub's defaults say `enhancement` and
 * `documentation`. A label that is the type name itself always counts.
 */
const TYPE_LABEL_ALIASES: Record<string, string[]> = {
  fix: ['bug', 'hotfix', 'incident', 'security'],
  feat: ['feature', 'enhancement'],
  docs: ['documentation'],
};
const TYPE_LABELS = new Set([...TYPES, ...Object.values(TYPE_LABEL_ALIASES).flat()]);
const SHOWN_TYPE_LABELS = ['feat', 'bug', 'docs', 'refactor', 'ci', 'test', 'chore'];

/** The tier on the body's first line, or null when the first line is not a tier. */
const bodyTier = (body: string): string | null => /^tier: ([ABC])\s*$/.exec(body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '')?.[1] ?? null;

/** The tier a label names: `tier B` or `tier: B`, in any case. Null for any other label. The board reads it too (#601), so both agree. */
export const readLabelTier = (label: string): string | null => /^tier:? ?([abc])$/i.exec(label.trim())?.[1].toUpperCase() ?? null;

/**
 * Problems with a pull request's labels: one type label, and one tier label that matches
 * the body's `tier:` line. A body with no tier line is pr-tier's finding, not this one.
 */
function checkLabels(labels: string[], tier: string | null): Finding[] {
  const problems: Finding[] = [];
  if (!labels.some(isTypeLabel)) {
    problems.push(finding('pr-labels', 'labels: no type label', `add one type label, such as ${SHOWN_TYPE_LABELS.join(', ')}; the title's type name also counts`));
  }
  return [...problems, ...checkTierLabel(labels, tier)];
}

/** Whether a label says a type. */
const isTypeLabel = (label: string): boolean => TYPE_LABELS.has(label.trim().toLowerCase());

/** Problems with a pull request's tier labels: exactly one, the same as the body's `tier:` line. */
function checkTierLabel(labels: string[], tier: string | null): Finding[] {
  const problems: Finding[] = [];
  const tiers = [...new Set(labels.map(readLabelTier).filter((t) => t !== null))];
  const wanted = tier ? `\`tier ${tier}\`` : '`tier A`, `tier B` or `tier C`, the same as the first line of the body';
  if (!tiers.length) problems.push(finding('pr-labels', 'labels: no tier label', `add the label ${wanted}`));
  else if (tiers.length > 1) problems.push(finding('pr-labels', `labels: ${tiers.length} tier labels`, `keep one tier label: ${wanted}`));
  else if (tier && tiers[0] !== tier) {
    problems.push(finding('pr-labels', `labels: \`tier ${tiers[0]}\` does not match the body's \`tier: ${tier}\``, `change the label to \`tier ${tier}\`, or the first line of the body to \`tier: ${tiers[0]}\``));
  }
  return problems;
}

/**
 * The folder of change files (#132). Each pull request adds its own file there, so two
 * pull requests never edit the same lines of CHANGELOG.md. `yokoten changelog` collects them.
 */
export const CHANGES_DIR = 'changes';

/** Whether a path is a change file: right in changes/, and not its README or a dotfile. */
export const isChangeFile = (path: string): boolean => {
  const [dir, name, ...deeper] = path.split('/');
  return dir === CHANGES_DIR && !!name && !deeper.length && name !== 'README.md' && !name.startsWith('.');
};

/** The text with fenced code blocks and code spans passed through `blank`. No regex: a PR body comes from anyone. */
function blankCode(text: string, blank: (code: string) => string): string {
  // Fenced blocks, line by line. An unclosed fence runs to the end.
  let fence = '';
  const lines = text.split('\n').map((line) => {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    if (!fence) {
      if (!mark) return line;
      fence = mark;
      return blank(line);
    }
    if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = '';
    return blank(line);
  });
  // Code spans: a run of backticks up to the next run of the same length.
  const rest = lines.join('\n');
  let out = '';
  let at = 0;
  let index = 0;
  while (index < rest.length) {
    if (rest[index] !== '`') {
      index++;
      continue;
    }
    let ticks = 0;
    while (rest[index + ticks] === '`') ticks++;
    let close = -1;
    for (let scan = index + ticks; scan < rest.length; ) {
      if (rest[scan] !== '`') {
        scan++;
        continue;
      }
      let closing = 0;
      while (rest[scan + closing] === '`') closing++;
      if (closing === ticks) {
        close = scan;
        break;
      }
      scan += closing;
    }
    if (close < 0) {
      index += ticks;
      continue;
    }
    out += rest.slice(at, index) + blank(rest.slice(index, close + ticks));
    at = index = close + ticks;
  }
  return out + rest.slice(at);
}

/**
 * The text with each HTML comment turned into spaces, so line numbers stay the same. As
 * on GitHub, a comment that never closes hides the rest of the text, and a `<!--` inside
 * code is only text. A left-to-right scan, not a regex replace, so one pass gives the same
 * result as GitHub's page.
 */
function blankComments(text: string): string {
  // The same text with code turned into spaces: comments are looked for here.
  const blank = (c: string) => c.replace(/[^\n]/g, ' ');
  const plain = blankCode(text, blank);
  let out = '';
  let at = 0;
  for (let open = plain.indexOf('<!--'); open >= 0; open = plain.indexOf('<!--', at)) {
    const close = plain.indexOf('-->', open + 4);
    const end = close < 0 ? text.length : close + 3;
    out += text.slice(at, open) + blank(text.slice(open, end));
    at = end;
  }
  return out + text.slice(at);
}

/** The text under a `## Name` heading, without HTML comments, up to the next heading. */
function section(body: string, name: string): string | null {
  const lines = blankComments(body).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * Problems with a pull request title: the commit form, an area from the list, at most 72
 * characters, no full stop and no issue number. `checkPullRequest` and the bot use it.
 */
export function checkPullRequestTitle(rawTitle: string, config: Partial<Pick<Config, 'areas'>>): Finding[] {
  const problems: Finding[] = [];
  const title = rawTitle.trim();
  if (!TITLE.test(title)) {
    problems.push(finding('pr-title', 'title: not in the commit form', `use \`type(area): summary\` or \`type: summary\`, with a type from ${TYPES.join(', ')}`));
  }
  const area = TITLE.exec(title)?.[2]?.slice(1, -1);
  if (area && config.areas?.length && !config.areas.includes(area)) {
    problems.push(finding('pr-title', `title: the area \`${area}\` is not in yokoten.json "areas"`, `use one of: ${config.areas.join(', ')}`, { why: 'issues and pull requests share one list of areas' }));
  }
  const titleLength = visibleLength(title);
  if (titleLength > 72) problems.push(finding('pr-title', `title: ${titleLength} characters, over 72`, 'shorten it; the details go in the body'));
  if (/\.$/.test(title)) problems.push(finding('pr-title', 'title: a full stop at the end', 'remove the full stop', { why: 'a commit title has no full stop' }));
  if (/#\d/.test(title)) problems.push(finding('pr-title', 'title: an issue number', 'remove the issue number, and put `Closes #N` in the body', { why: 'the host links the issue from the body' }));
  return problems;
}

/** Problems with a pull request. An empty list means it meets the standard. */
export function checkPullRequest(pr: PullRequest, config: Pick<Config, 'tests'> & Partial<Pick<Config, 'areas'>>): Finding[] {
  const problems = [...checkPullRequestTitle(pr.title, config), ...checkPullRequestBody(pr, config)];
  if (!pr.milestone) problems.push(finding('pr-milestone', 'milestone: none set', 'set one'));
  problems.push(...checkLabels(pr.labels, bodyTier(pr.body ?? '')));
  return problems;
}

/**
 * Problems with a pull request's body against the files it changes: the tier line, the
 * sections, the linked issue, the change file and the kit line. `checkPullRequest` and
 * the bot use it (#406). With no files, only the body itself is checked.
 */
export function checkPullRequestBody(pr: Pick<PullRequest, 'body' | 'files' | 'deleted'>, config: Pick<Config, 'tests'>): Finding[] {
  const problems: Finding[] = [];
  const body = pr.body ?? '';
  const tier = bodyTier(body);
  if (!tier) {
    problems.push(finding('pr-tier', 'body: the first line is not a tier', 'make the first line `tier: A`, `tier: B` or `tier: C` (A: files CODEOWNERS owns, or a change that makes a rule looser; B: other code; C: docs and wording)'));
  }
  for (const name of SECTIONS) {
    const text = section(body, name);
    if (text === null) problems.push(finding('pr-section', `body: no \`## ${name}\` section`, `add a \`## ${name}\` section`));
    else if (!text || /^<[^>]*>$/.test(text)) problems.push(finding('pr-section', `body: the \`## ${name}\` section is empty`, 'fill it in'));
  }
  // Only Closes, Fixes and Resolves close the issue; Part of and Refs link it and leave it open.
  if (!readLinkedIssues(body).length) {
    problems.push(finding('pr-issue', 'body: no linked issue', 'link the issue with `Closes #N`, or `Part of #N` when it does not finish it'));
  }
  // Every pull request names each AI and model that made it (#570), on its last
  // line, so the credit reads the same each time.
  problems.push(...madeWithFindings(body));

  // `yokoten changelog` reads only the files right in changes/, and refuses a folder there,
  // so a new file deeper down would pass here and stop the release.
  for (const file of pr.files.filter((f) => f.startsWith(`${CHANGES_DIR}/`) && f.split('/').length > 2 && !pr.deleted?.includes(f))) {
    problems.push(finding('change-file', `a file in a folder inside ${CHANGES_DIR}/`, `change files go directly in ${CHANGES_DIR}/; move it up`, { file }));
  }

  // A change to what the project does needs a change file, or a line in CHANGELOG.md for a
  // project that has not moved to change files. Docs, tests and CI do not.
  const isTest = matcher(config.tests);
  const behaviour = pr.files.filter((f) => !/\.md$/i.test(f) && !isTest(f) && !f.startsWith('.github/') && !isChangeFile(f));
  // A deleted change file is not a new entry: the change it names was already collected.
  const hasEntry = pr.files.includes('CHANGELOG.md') || pr.files.some((file) => isChangeFile(file) && !pr.deleted?.includes(file));
  if (behaviour.length && !hasEntry && !/^No changelog: \S/m.test(body)) {
    problems.push(
      finding(
        'pr-changelog',
        `changelog: ${behaviour.length} changed file(s) change what the project does, and there is no new file in ${CHANGES_DIR}/`,
        `add \`${CHANGES_DIR}/<issue>-<slug>.md\` (${CHANGES_DIR}/README.md shows the form), or write \`No changelog: <reason>\` in the body`,
      ),
    );
  }
  if (pr.files.some((f) => f.startsWith('kit/')) && !/\bkit\b/i.test(body)) {
    problems.push(finding('pr-kit', 'body: this changes `kit/` and does not say so', 'say in the body that every project gets this change on its next init'));
  }
  return problems;
}

// Dependabot's pull requests (#299). Dependabot writes its own body, and sets no tier,
// milestone, label of ours or change file, so those rules are notes for it: the owner
// still sees each one, and the check stays green. The title rule stays a failure, since
// the title becomes the commit on main and the kit's dependabot.yml sets its prefix. The
// owned-tier rule is a note too: Dependabot can't write a tier line, and GitHub's
// required review from code owners, not this check, is the lock on owned files.

/** The login GitHub gives Dependabot's pull requests. */
export const DEPENDABOT = 'dependabot[bot]';
const DEPENDABOT_NOTES = new Set(['pr-tier', 'pr-section', 'pr-issue', 'pr-made-with', 'pr-changelog', 'pr-kit', 'pr-milestone', 'pr-labels', 'pr-owned']);

/**
 * The pull request findings, split into problems and notes. For a pull request Dependabot
 * opened, the rules it can't meet are notes; for anyone else, nothing moves.
 */
export function splitForDependabot(pr: Pick<PullRequest, 'author'>, found: Finding[]): { problems: Finding[]; notes: Finding[] } {
  if (pr.author !== DEPENDABOT) return { problems: found, notes: [] };
  const why = 'Dependabot opened this pull request, so it is a note';
  return {
    problems: found.filter((f) => !DEPENDABOT_NOTES.has(f.id)),
    notes: found.filter((f) => DEPENDABOT_NOTES.has(f.id)).map((f) => ({ ...f, why: `${f.why}; ${why}` })),
  };
}

/**
 * Sentences over `max` words in a Markdown text: a note for plain English (record 0005),
 * never a failure. Code blocks, tables, headings and comments are skipped. Returns the
 * line each long sentence starts on and its length.
 */
export function longSentences(text: string, max = 25): { line: number; words: number }[] {
  const found: { line: number; words: number }[] = [];
  let fenced = false;
  let sentence: string[] = [];
  let startLine = 0;
  const flush = () => {
    const words = sentence.join(' ').split(/\s+/).filter((w) => /\w/.test(w)).length;
    if (words > max) found.push({ line: startLine, words });
    sentence = [];
  };
  const lines = blankComments(text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced || !line || line.startsWith('|') || line.startsWith('#') || line.startsWith('>')) {
      flush();
      return;
    }
    // A list item starts a new sentence.
    if (/^([-*+]|\d+\.) /.test(line)) flush();
    // Links count as their text.
    const prose = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`[^`]*`/g, 'x');
    for (const part of prose.split(/(?<=[.!?:;])\s+/)) {
      if (!sentence.length) startLine = index + 1;
      sentence.push(part);
      if (/[.!?:;]$/.test(part)) flush();
    }
  });
  flush();
  return found;
}

// Lock files are written by a tool, not by a person, so a reviewer does not read them line by line.
const LOCK_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

/**
 * Lines a diff adds and deletes, from `git diff --numstat -z`. A binary file (`-`) counts
 * as 0, and lock files are not counted. A rename names its new path after the counts.
 */
export function changedLines(numstat: string): number {
  const parts = numstat.split('\0');
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (!path) {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    if (LOCK_FILES.has(path.split('/').pop() ?? '')) continue;
    total += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
  }
  return total;
}

// Git writes a path with unusual characters in quotes, with C escapes. With
// core.quotePath off, only control characters, quotes and backslashes are escaped.
const C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };
const unquotePath = (raw: string) =>
  raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, code: string) => (/^[0-7]{3}$/.test(code) ? String.fromCharCode(parseInt(code, 8)) : (C_ESCAPES[code] ?? code))) : raw;

/**
 * The line numbers each file gains, in its new version, from `git diff` with the
 * `a/` and `b/` prefixes. A renamed file counts only the lines it adds. A file the
 * diff deletes is left out. Inside a hunk, a line that starts with `+++` is an added
 * line; a file's header comes before its first hunk.
 */
export function addedLinesByFile(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  let added: Set<number> | null = null;
  let next = 0;
  let isInHunk = false;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (line.startsWith('diff ')) {
      added = null;
      isInHunk = false;
    } else if (!isInHunk && line.startsWith('+++ ')) {
      // Git ends the line with a tab when the path has a space.
      const file = unquotePath(line.slice(4).replace(/\t$/, ''));
      added = file.startsWith('b/') ? new Set<number>() : null;
      if (added) byFile.set(file.slice(2), added);
    } else if (hunk) {
      next = Number(hunk[1]);
      isInHunk = true;
    } else if (isInHunk && line.startsWith('+')) added?.add(next++);
    else if (isInHunk && line.startsWith(' ')) next++;
  }
  return byFile;
}

/**
 * A note when a pull request changes more than `max` lines (record 0004), else null. A
 * note, never a failure: Google's review guide finds about 100 lines fine, 1000 too large.
 */
export function largeDiff(lines: number, max = 400): Finding | null {
  if (lines <= max) return null;
  return finding('large-diff', `this pull request changes ${lines} lines, over ${max}`, 'split it if you can');
}

/** A long sentence (from `longSentences`) as a note on a file. */
export const longSentenceNote = (file: string, { line, words }: { line: number; words: number }): Finding =>
  finding('long-sentence', `a sentence of ${words} words`, 'split it into sentences of 25 words or fewer', { file, line });

// The issue rule. An issue title names its area and then the work: `doctor: add the
// review step` for a task, `check: misses a key in a JSON file` for an incident (the
// symptom, not the fix). The same areas as the pull request titles, so a list of issues
// reads like a list of commits to come. The title is user input and never printed back.

const AREA = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ISSUE_MAX = 60;

/**
 * Problems with an issue title. An empty list means it meets the standard. `labels` say
 * what kind of issue it is: an `incident` describes a symptom, anything else a task.
 */
export function checkIssueTitle(title: string, config: Partial<Pick<Config, 'areas'>>, labels: string[] = []): Finding[] {
  const problems: Finding[] = [];
  const text = title.trim();
  const incident = labels.some((l) => l.toLowerCase() === 'incident');
  const form = incident ? '`area: symptom`, for example `check: misses a key in a JSON file`' : '`area: verb phrase`, for example `doctor: add the review step`';
  const areas = config.areas ?? [];
  const m = /^([^\s:]+): +(\S.*)$/.exec(text);
  if (!m) {
    problems.push(finding('issue-area', 'title: it does not start with an area', `write it as ${form}`));
  } else if (!AREA.test(m[1])) {
    problems.push(finding('issue-area', 'title: the area is not one lowercase word', `use a lowercase word, or words joined by hyphens, as in ${form}`, { why: 'one form for every area keeps the list easy to scan and search' }));
  } else if (m[1] === 'area') {
    problems.push(finding('issue-area', 'title: it still starts with the placeholder `area`', `replace it with the part of the project, as in ${form}`, { why: 'the template puts it there for you to replace' }));
  } else if (areas.length && !areas.includes(m[1])) {
    problems.push(finding('issue-area', 'title: the area is not in yokoten.json "areas"', `use one of: ${areas.join(', ')}`, { why: 'issues and pull requests share one list of areas' }));
  }
  const textLength = visibleLength(text);
  if (textLength > ISSUE_MAX) problems.push(finding('issue-title', `title: ${textLength} characters, over ${ISSUE_MAX}`, 'shorten it, and put the details in the body'));
  if (/[.。]$/.test(text)) problems.push(finding('issue-title', 'title: a full stop at the end', 'remove the full stop', { why: 'a title is a name, not a sentence' }));
  if (/#\d/.test(text)) problems.push(finding('issue-title', 'title: an issue number', 'remove the number, and name the other issue in the body', { why: 'the host links issues from the body, not from the title' }));
  return problems;
}

/**
 * Problems with an issue's labels: one type label and one tier label, but only the
 * kinds the repo has. A repo without type or tier labels of its own gets no line, and
 * neither does an issue when the repo's labels can't be read (null).
 */
export function checkIssueLabels(issueLabels: string[], repoLabels: string[] | null): Finding[] {
  if (repoLabels === null) return [];
  const problems: Finding[] = [];
  if (repoLabels.some(isTypeLabel) && !issueLabels.some(isTypeLabel)) {
    problems.push(finding('issue-labels', 'labels: no type label', 'add one type label, such as feat, bug, docs'));
  }
  const isTierLabel = (label: string): boolean => readLabelTier(label) !== null;
  if (repoLabels.some(isTierLabel) && !issueLabels.some(isTierLabel)) {
    problems.push(finding('issue-labels', 'labels: no tier label', 'add one tier label: `tier A`, `tier B` or `tier C`'));
  }
  return problems;
}

// The owner rule. CODEOWNERS names the paths where a mistake is hard to undo, and the
// people who must review them. Record 0004's tiers say the same thing from the other
// side: tier A needs the owner. So a pull request that changes an owned file is tier A.
// The paths set the lowest tier; the author can raise a tier, never lower it.
//
// GitHub's syntax: one pattern and its owners per line, `#` starts a comment, and the
// last pattern that matches a path wins. A leading `/`, or a `/` inside the pattern,
// anchors it at the root; otherwise it matches in any folder. A trailing `/` matches a
// folder and everything in it. `*` stays inside one folder, `**` crosses folders. A
// pattern with no owners takes a path out of an earlier pattern.

/** One CODEOWNERS line: the pattern as a regular expression, and its owners. */
export interface OwnerRule {
  pattern: string;
  owners: string[];
  test: (path: string) => boolean;
}

/**
 * A section header, such as `[Docs]`, `^[Security]` or `[Docs] @docs-team`, names no path.
 * Owners after the brackets are the section's default owners; this reader still ignores
 * them, as it did before, but the line is not read as a `[class]` pattern either.
 */
export const isCodeOwnersHeader = (line: string): boolean => /^\^?(\[[^\]]*\]\s*)+(?:\s+\S.*)?$/.test(line);

/**
 * The words of one CODEOWNERS line, with any comment removed. A `\` keeps the next
 * character in its word, so `docs/my\ file.md` is one pattern; `#` after a space starts
 * a comment.
 */
export function codeOwnersWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index] as string;
    if (character === '\\' && index + 1 < line.length) {
      word += line[index + 1];
      index += 1;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else if (character === '#' && !started) {
      break;
    } else {
      word += character;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One `[...]` character class as regular expression text. A class that cannot compile,
 * such as `[z-a]`, becomes its own literal text instead: one malformed CODEOWNERS line
 * is then reported as a line that matches no file, and the rest of the check still runs.
 */
function compileCharacterClass(inside: string, negated: boolean): string {
  const text = `[${negated ? '^' : ''}${inside.replace(/\\/g, '\\\\').replace(/\]/g, '\\]').replace(/\^/g, '\\^')}]`;
  try {
    new RegExp(text);
    return text;
  } catch {
    return escapeRegExp(`[${negated ? '!' : ''}${inside}]`);
  }
}

/**
 * The regular expression for one CODEOWNERS pattern. `[...]` is a character class,
 * `\` makes the next character literal, `*` stays inside one folder and `**` crosses
 * folders. A leading `/`, or a `/` inside the pattern, anchors it at the root; a trailing
 * `/` names a folder, so it never matches a file of that name.
 */
export function compileCodeOwnersPattern(raw: string): RegExp {
  const folder = raw.endsWith('/');
  const body = raw.replace(/^\//, '').replace(/\/$/, '');
  const anchored = raw.startsWith('/') || body.includes('/');
  let re = '';
  for (let index = 0; index < body.length; index++) {
    const character = body[index] as string;
    if (character === '\\' && index + 1 < body.length) {
      re += escapeRegExp(body[index + 1] as string);
      index += 1;
    } else if (character === '[') {
      const close = body.indexOf(']', index + 1);
      if (close > index + 1) {
        let inside = body.slice(index + 1, close);
        const negated = inside.startsWith('!') || inside.startsWith('^');
        if (negated) inside = inside.slice(1);
        re += compileCharacterClass(inside, negated);
        index = close;
      } else {
        re += '\\[';
      }
    } else if (character === '*' && body[index + 1] === '*') {
      if (body[index + 2] === '/') {
        re += '(?:.*/)?';
        index += 2;
      } else {
        re += '.*';
        index += 1;
      }
    } else if (character === '*') re += '[^/]*';
    else if (character === '?') re += '[^/]';
    else re += escapeRegExp(character);
  }
  // `docs/*` matches the files in docs/ and not deeper (GitHub's documented case).
  const end = folder ? '/.*' : /(^|\/)\*$/.test(body) && body !== '*' ? '' : '(?:/.*)?';
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}${end}$`);
}

/** Whether one CODEOWNERS pattern matches a file path. */
export const codeOwnersPatternMatches = (pattern: string, path: string): boolean => compileCodeOwnersPattern(pattern).test(path);

/** The rules in a CODEOWNERS file, in order. */
export function parseCodeOwners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (isCodeOwnersHeader(raw.trim())) continue;
    const [pattern, ...owners] = codeOwnersWords(raw);
    if (!pattern) continue;
    const re = compileCodeOwnersPattern(pattern);
    rules.push({ pattern, owners, test: (p) => re.test(p) });
  }
  return rules;
}

/** The owners of a path: the last rule that matches wins. An empty list means nobody. */
export function ownersOf(rules: OwnerRule[], path: string): string[] {
  let owners: string[] = [];
  for (const rule of rules) if (rule.test(path)) owners = rule.owners;
  return owners;
}

/** Where a CODEOWNERS file was read from: the base branch in CI, the working tree on a local run. */
export interface CodeOwners {
  text: string;
  from: 'the base branch' | 'the working tree';
}

/**
 * A failure when a pull request changes a file that CODEOWNERS owns and its tier is B or
 * C, else null. No CODEOWNERS file, or no tier line (pr-tier reports that), passes.
 */
export function checkOwnedTier(pr: Pick<PullRequest, 'body' | 'files'>, codeOwners: CodeOwners | null): Finding | null {
  if (!codeOwners) return null;
  const tier = bodyTier(pr.body ?? '');
  if (!tier || tier === 'A') return null;
  const rules = parseCodeOwners(codeOwners.text);
  const owned = pr.files.filter((f) => ownersOf(rules, f).length);
  if (!owned.length) return null;
  const shown = owned.slice(0, 5).join(', ') + (owned.length > 5 ? `, and ${owned.length - 5} more` : '');
  return finding('pr-owned', `body: \`tier: ${tier}\`, and this changes ${owned.length} file(s) that CODEOWNERS owns (read from ${codeOwners.from}): ${shown}`, 'make the first line `tier: A`');
}

// ---- The commit the owner approved (#612) ----
//
// An approval is for one commit (core rule 9). A tier A pull request merges only on the
// commit the owner's latest Approve was given on. When newer commits only merge the base
// branch in, and the pull request's own diff is the same as at the Approve, the merge
// goes on. Anything else needs a new review.

/**
 * The tier of a pull request: A when the body's line or any tier label says A, since
 * either can change after creation (#612); otherwise the body's line, then the first
 * tier label. Fail closed both ways, so a mismatch never skips the tier A gate.
 */
export function prTier(body: string, labels: string[]): string | null {
  const fromBody = bodyTier(body);
  const fromLabels = labels.map(readLabelTier).filter((tier) => tier !== null);
  if (fromBody === 'A' || fromLabels.includes('A')) return 'A';
  return fromBody ?? fromLabels[0] ?? null;
}

/** What the Approve check knows: the tier, the head, and what came after the Approve. */
export interface ApprovalRead {
  /** The pull request's tier, or null when neither the body nor a label says it. */
  tier: string | null;
  /** The pull request's head commit. */
  head: string;
  /** The commit the owner's latest Approve was given on, or null with no owner Approve. */
  approved: string | null;
  /** Commits with changes after the Approve (never merges of the base branch). */
  after: number;
  /** Whether the pull request's own diff is the same as at the Approve. */
  sameDiff: boolean;
}

/**
 * The finding that stops a tier A pull request from merging, or null when it may
 * merge: not tier A, or the Approve is on the head, or only base merges came after it
 * with the same own diff. Anything unsure never reaches here: the caller refuses it.
 */
export function checkApprovalFreshness(read: ApprovalRead): Finding | null {
  if (read.tier !== 'A') return null;
  if (read.approved === null) return finding('pr-approve', 'no owner Approve on this pull request', 'ask the owner to approve it, then merge');
  if (read.approved.toLowerCase() === read.head.toLowerCase()) return null;
  const short = read.approved.slice(0, 7);
  const fix = 'ask the owner to approve the head commit, then merge';
  if (read.after > 0) {
    return finding('pr-approve', `the Approve is on ${short}; ${read.after} commit${read.after === 1 ? '' : 's'} with changes came after it; ask the owner to approve again`, fix);
  }
  if (!read.sameDiff) {
    return finding('pr-approve', `the Approve is on ${short}; the pull request's own diff is not the same as at the Approve; ask the owner to approve again`, fix);
  }
  return null;
}

// ---- The title a gh command sets (#117, #391) ----
//
// `yokoten bot` checks it before it sends anything, and the tool-call guard checks it on
// plain gh too, so a bad title is stopped before the issue or pull request exists.

/** The title a `gh issue` or `gh pr` command is about to set, and its labels. */
export interface CommandTitle {
  kind: 'issue' | 'pr';
  title: string;
  labels: string[];
}

/** A `gh issue` or `gh pr` create or edit with a run-together word the bot can't read (#290). */
export interface UnreadableTitle {
  kind: 'issue' | 'pr';
  /** The word, as in `-dz`. */
  unreadable: string;
  /** No title was read, so `found?.title` works on either kind. */
  title?: never;
}

// The gh options of `issue`/`pr` `create`/`edit` that take a value. Their value is
// skipped, so a body of `-t` is not read as the title option, and a repo is not read as
// the noun or the verb.
const VALUE_OPTIONS = new Set([
  '--body', '-b', '--body-file', '-F', '--assignee', '-a', '--milestone', '-m', '--project', '-p', '--repo', '-R', '--template', '-T',
  '--base', '-B', '--head', '-H', '--reviewer', '-r', '--recover', '--remove-label', '--add-assignee', '--remove-assignee',
  '--add-project', '--remove-project', '--add-reviewer', '--remove-reviewer', '--attach', '--type', '--parent',
  '--blocked-by', '--blocking', '--add-blocked-by', '--add-blocking', '--remove-blocked-by', '--remove-blocking',
  '--add-sub-issue', '--remove-sub-issue',
]);
const LABEL_OPTIONS = new Set(['--label', '-l', '--add-label']);
const TITLE_OPTIONS = new Set(['--title', '-t']);
/** The options of one gh command: those that take a value, and every short flag (true takes a value). */
interface Flags {
  values: Set<string>;
  short: Map<string, boolean>;
}

const shortFlags = (values: string, switches: string) => new Map<string, boolean>([
  ...[...values].map((letter): [string, boolean] => [letter, true]),
  ...[...switches].map((letter): [string, boolean] => [letter, false]),
]);

// Every short flag of gh `issue`/`pr` `create`/`edit` (gh 2.102 help, with the inherited
// `-R`), so a run-together word like `-dt` or `-dlbug` is read as gh reads it (#290).
const ISSUE_FLAGS: Flags = {
  values: new Set([...VALUE_OPTIONS, ...LABEL_OPTIONS, ...TITLE_OPTIONS]),
  short: shortFlags('abFlmpTtRBHr', 'dewf'),
};
// The options of gh's `api` command (gh 2.102 help) (#295).
const API_FLAGS: Flags = {
  values: new Set(['--method', '-X', '--raw-field', '-f', '--field', '-F', '--header', '-H', '--input', '--jq', '-q', '--template', '-t', '--hostname', '--cache', '--preview', '-p']),
  short: shortFlags('XfFHqtp', 'i'),
};
const FIELD_OPTIONS = new Set(['--raw-field', '-f', '--field', '-F']);
// A gh's `api` command path that creates or edits an issue or a pull request, with or without the
// leading slash. `{owner}` and `{repo}` count as names.
const TITLE_ENDPOINT = /^\/?repos\/[^/]+\/[^/]+\/(issues|pulls)(\/\d+)?(\?.*)?$/;
// gh's verbs that set a title, by every name gh accepts (`new` is its alias for `create`).
const TITLE_VERBS = new Set(['create', 'new', 'edit']);

/** The programs `yokoten bot` runs (#295). */
export type BotProgram = 'gh' | 'git';

/**
 * `gh` or `git` when the command's first word names one by its base name, so
 * `/usr/bin/gh` and `gh.exe` count; null for anything else, such as `env` or `sh` (#295).
 */
export function botProgram(file: string): BotProgram | null {
  const base = file.split(/[\\/]/).pop()?.replace(/\.exe$/i, '');
  return base === 'gh' || base === 'git' ? base : null;
}

/** The words and the option values of a command line, read with one gh command's flags. */
interface ReadArgs {
  /** The index of each word that is not an option or an option's value. */
  words: number[];
  options: [name: string, value: string][];
  /** The first run-together word with a short flag not in the flags (#290). */
  unreadable: string | null;
}

function readArgs(args: string[], flags: Flags): ReadArgs {
  const words: number[] = [];
  const options: [string, string][] = [];
  let unreadable: string | null = null;
  for (let index = 0; index < args.length; index++) {
    let word = args[index];
    if (word === '--') break;
    if (!word.startsWith('-') || word === '-') {
      words.push(index);
      continue;
    }
    if (!word.startsWith('--') && word.length > 2) {
      // `-abc`: each letter is a flag until one takes a value, which is the rest of the word.
      let at = 1;
      while (at < word.length && flags.short.get(word[at]) === false) at++;
      if (at === word.length) continue;
      if (!flags.short.has(word[at])) {
        unreadable ??= word;
        continue;
      }
      word = `-${word.slice(at)}`;
    }
    const equals = word.startsWith('--') ? word.indexOf('=') : -1;
    const name = equals > 0 ? word.slice(0, equals) : /^-[a-zA-Z]./.test(word) ? word.slice(0, 2) : word;
    let attached = equals > 0 ? word.slice(equals + 1) : name !== word ? word.slice(2) : null;
    // gh drops the `=` of an attached short value: `-t=x` is the title `x` (#295).
    if (equals < 0 && attached?.startsWith('=')) attached = attached.slice(1);
    if (!flags.values.has(name)) continue;
    const value = attached ?? args[++index];
    if (value === undefined) break;
    options.push([name, value]);
  }
  return { words, options, unreadable };
}

const kindOf = (endpoint: RegExpMatchArray): 'issue' | 'pr' => (endpoint[1] === 'issues' ? 'issue' : 'pr');

/**
 * The title that gh's `api` command sets with a `title=` field on an issue or pull request path
 * (#295): `-f title=X`, `-F title=X`, `--field title=X`, `--raw-field=title=X`. A title
 * gh reads from a file (`-F title=@f`) can't be checked, so it gives UnreadableTitle.
 */
function readApiTitle(args: string[]): CommandTitle | UnreadableTitle | null {
  const { words, options, unreadable } = readArgs(args, API_FLAGS);
  const paths = words.map((index) => args[index]);
  const endpoint = paths[0]?.match(TITLE_ENDPOINT);
  if (!endpoint) {
    // A word it can't read may hide where the path is: refuse when any word is such a path.
    const hidden = unreadable === null ? null : paths.map((path) => path.match(TITLE_ENDPOINT)).find(Boolean);
    return hidden && unreadable !== null ? { kind: kindOf(hidden), unreadable } : null;
  }
  const kind = kindOf(endpoint);
  if (unreadable !== null) return { kind, unreadable };
  let title: string | null = null;
  for (const [name, value] of options) {
    if (!FIELD_OPTIONS.has(name) || !value.startsWith('title=')) continue;
    title = value.slice('title='.length);
    if ((name === '-F' || name === '--field') && title.startsWith('@')) return { kind, unreadable: value };
  }
  return title === null ? null : { kind, title, labels: [] };
}

/**
 * The title that `gh issue create`, `gh issue edit`, `gh pr create` or `gh pr edit` sets
 * with `--title X`, `--title=X`, `-t X`, `-tX` or `-t=X` (#117, #295). gh also takes `new`
 * for `create`, and an option before the noun or the verb (`gh issue -R o/r create`), so
 * they count too (#279). Short flags run together as gh takes them (`-dt X`, `-dtX`); a
 * run-together word with a letter gh doesn't have there gives UnreadableTitle, so the
 * caller refuses it (#290). gh's `api` command on an issue or pull request path is read by
 * readApiTitle (#295). Null for any other command, or when no title is given (`--fill`):
 * CI checks that title. As in gh, the last one wins. A gh alias is not read.
 */
export function readCommandTitle(command: string[]): CommandTitle | UnreadableTitle | null {
  const [file, ...rest] = command;
  if (!file || botProgram(file) !== 'gh') return null;
  const { words, options, unreadable } = readArgs(rest, ISSUE_FLAGS);
  const [kind, verb] = words.map((index) => rest[index]);
  if (kind === 'api') return readApiTitle(rest.slice(words[0] + 1));
  if ((kind !== 'issue' && kind !== 'pr') || !TITLE_VERBS.has(verb)) return null;
  if (unreadable !== null) return { kind, unreadable };
  const { title, labels } = readTitleAndLabels(options);
  return title === null ? null : { kind, title, labels };
}

/** The title (the last one, as in gh) and every label that one gh command's options set. */
function readTitleAndLabels(options: ReadArgs['options']): { title: string | null; labels: string[] } {
  let title: string | null = null;
  const labels: string[] = [];
  for (const [name, value] of options) {
    if (TITLE_OPTIONS.has(name)) title = value;
    else if (LABEL_OPTIONS.has(name)) labels.push(...value.split(',').map((label) => label.trim()).filter(Boolean));
  }
  return { title, labels };
}

/**
 * Problems with the title a gh command is about to set, by the rules CI uses: `check
 * --issue` for an issue, the title part of `check --pr` for a pull request. No title in
 * the command, no problems. A run-together short flag it can't read is a problem (#290),
 * so the title is never sent unchecked. It reads no token and no network.
 */
export function checkCommandTitle(command: string[], config: Partial<Pick<Config, 'areas'>>): Finding[] {
  const found = readCommandTitle(command);
  if (!found) return [];
  if ('unreadable' in found) {
    const id = found.kind === 'issue' ? 'issue-title' : 'pr-title';
    // The word itself is never printed: it may hold the title, or a file's path.
    const where = found.unreadable.startsWith('title=') ? 'the title field reads a file' : 'a run-together short option hides it';
    return [finding(id, `title: can't read the title: ${where}`, 'write --title on its own', { why: 'yokoten checks the title before it sends anything' })];
  }
  return found.kind === 'issue' ? checkIssueTitle(found.title, config, found.labels) : checkPullRequestTitle(found.title, config);
}

// ---- The body a gh command sets (#406) ----
//
// `yokoten bot` checks the body of `gh pr create` and `gh pr edit` by the body rules of
// `check --pr`, before it sends anything, so a body CI would refuse is never sent.

/** The body a `gh pr create` or `gh pr edit` command is about to set, and where to diff. */
export interface CommandBody {
  /** The body text, or the file gh reads it from (`-` is standard input). */
  body: { text: string } | { file: string };
  /** The `--base` branch, or null for the default. */
  base: string | null;
  /** The `--repo` value, or null when the command names none. */
  repo: string | null;
  /** The `--head` branch of `gh pr create`, or the pull request `gh pr edit` names (a number, a URL or a branch); null for the current branch. */
  head: string | null;
}

const BODY_OPTIONS = new Set(['--body', '-b']);
const BODY_FILE_OPTIONS = new Set(['--body-file', '-F']);

/**
 * The body that `gh pr create` (or `new`) or `gh pr edit` sets with `--body`, `-b`,
 * `--body-file` or `-F`, in any spelling gh takes. As in gh, the last one wins. Null for
 * any other command, for one with no body (`--fill`, a label edit), or with a run-together
 * word the title check refuses (#290).
 */
export function readCommandBody(command: string[]): CommandBody | null {
  const [file, ...rest] = command;
  if (!file || botProgram(file) !== 'gh') return null;
  const { words, options, unreadable } = readArgs(rest, ISSUE_FLAGS);
  const [kind, verb, selector] = words.map((index) => rest[index]);
  if (kind !== 'pr' || !TITLE_VERBS.has(verb) || unreadable !== null) return null;
  let body: CommandBody['body'] | null = null;
  let base: string | null = null;
  let repo: string | null = null;
  let head: string | null = null;
  for (const [name, value] of options) {
    if (BODY_OPTIONS.has(name)) body = { text: value };
    else if (BODY_FILE_OPTIONS.has(name)) body = { file: value };
    else if (name === '--base' || name === '-B') base = value;
    else if (name === '--repo' || name === '-R') repo = value;
    else if (name === '--head' || name === '-H') head = value;
  }
  if (!body) return null;
  return { body, base, repo, head: verb === 'edit' ? (selector ?? null) : head };
}

// ---- The labels a gh command sets (#422) ----
//
// `yokoten bot` adds the type and tier labels `check --pr` asks for when `gh pr create`
// leaves them out, from the title's type and the body's `tier:` line.

/** The labels `gh pr create` leaves out that `check --pr` asks for, and the problems with those it gives. */
export interface CommandLabels {
  /** Each missing label, as the label names that would do, best first. */
  missing: string[][];
  /** Problems with the labels the command gives, in the words of `check --pr`. */
  problems: Finding[];
  /** The `--repo` value, or null when the command names none. */
  repo: string | null;
}

// Aliases that say more than the type, so the bot never picks them for a person.
const NARROW_TYPE_LABELS = new Set(['hotfix', 'incident', 'security']);

/** The label names that say a title's type, best first: the shown one (`bug` for fix), the type, then its aliases. */
function typeLabelNames(type: string): string[] {
  const aliases = TYPE_LABEL_ALIASES[type] ?? [];
  const shown = SHOWN_TYPE_LABELS.find((label) => label === type || aliases.includes(label)) ?? type;
  return [...new Set([shown, type, ...aliases])].filter((label) => !NARROW_TYPE_LABELS.has(label));
}

/**
 * The type and tier labels that `gh pr create` (or `new`) leaves out, from the title's
 * type and the body's tier line, and the problems with the tier labels it gives. A label
 * it gives is kept. Null for any other command, or a run-together word it can't read.
 */
export function readCommandLabels(command: string[], body: string | null): CommandLabels | null {
  const [file, ...rest] = command;
  if (!file || botProgram(file) !== 'gh') return null;
  const { words, options, unreadable } = readArgs(rest, ISSUE_FLAGS);
  const [kind, verb] = words.map((index) => rest[index]);
  if (kind !== 'pr' || (verb !== 'create' && verb !== 'new') || unreadable !== null) return null;
  const { title, labels } = readTitleAndLabels(options);
  const repo = options.filter(([name]) => name === '--repo' || name === '-R').at(-1)?.[1] ?? null;
  const missing: string[][] = [];
  const type = title === null ? undefined : TITLE.exec(title.trim())?.[1];
  if (type && !labels.some(isTypeLabel)) missing.push(typeLabelNames(type));
  const tier = bodyTier(body ?? '');
  const hasTier = labels.some((label) => readLabelTier(label) !== null);
  if (tier && !hasTier) missing.push([`tier ${tier}`, `tier: ${tier}`]);
  return { missing, problems: hasTier ? checkTierLabel(labels, tier) : [], repo };
}

/** The labels a `gh issue create` command gives, and its `--repo` value. */
export interface CommandIssueLabels {
  labels: string[];
  /** The `--repo` value, or null when the command names none. */
  repo: string | null;
}

/**
 * The labels that `gh issue create` (or `new`) gives with `--label`, `-l` or
 * `--add-label`. Null for any other command, or a run-together word it can't read.
 */
export function readCommandIssueLabels(command: string[]): CommandIssueLabels | null {
  const [file, ...rest] = command;
  if (!file || botProgram(file) !== 'gh') return null;
  const { words, options, unreadable } = readArgs(rest, ISSUE_FLAGS);
  const [kind, verb] = words.map((index) => rest[index]);
  if (kind !== 'issue' || (verb !== 'create' && verb !== 'new') || unreadable !== null) return null;
  const repo = options.filter(([name]) => name === '--repo' || name === '-R').at(-1)?.[1] ?? null;
  return { labels: readTitleAndLabels(options).labels, repo };
}

// ---- The milestone a gh command sets (#512) ----
//
// `yokoten bot` gives `gh pr create` its linked issue's milestone when the command names
// none, so `check --pr` never fails on "milestone: none set" after the post.

/** The issues a `gh pr create` body links, when the command gives no milestone. */
export interface CommandMilestone {
  /** The linked issue numbers, in the order the body names them, each once. */
  issues: number[];
  /** The `--repo` value, or null when the command names none. */
  repo: string | null;
}

// The words that link an issue. The body check and the milestone step both read them here.
const LINKED_ISSUE = /\b(?:closes|fixes|resolves|refs|part of) #(\d+)/gi;

/** The issue numbers a body links with `Closes #N`, `Part of #N` and the like, in order, each once. */
export function readLinkedIssues(body: string): number[] {
  return [...new Set([...body.matchAll(LINKED_ISSUE)].map((match) => Number(match[1])))];
}

/** One agent and the model it ran on, from `<agent> (<model>)`. */
export interface MadeWithAgent {
  /** The vendor or tool, for example `Claude Code`. */
  vendor: string;
  model: string;
}

/** The roles a `Made with` line names (#673). Two workers on different models are both kept. */
export interface MadeWithRoles {
  /** The agents after `worker`, in order. */
  writers: MadeWithAgent[];
  /** The agents after `reviewed by`, at most two in all. */
  reviewers: MadeWithAgent[];
  /** The agents after `lead`, in order. */
  leads: MadeWithAgent[];
  /** Every other `<agent> (<model>)` pair, in order (the old form without roles). */
  others: MadeWithAgent[];
}

const AGENT = /^([^()]+?) \(([^()]+)\)$/;
const REVIEWED_BY = /^reviewed by ([^(),]+? \([^()]+\))(?: and ([^(),]+? \([^()]+\)))?$/i;

function readAgent(text: string): MadeWithAgent | null {
  const match = AGENT.exec(text);
  return match ? { vendor: match[1], model: match[2] } : null;
}

/**
 * Reads the last non-blank line of a body as a `Made with` line (#570, #673) and
 * returns the roles it names. The line is `🤖 Made with <part>, <part>`, with or
 * without the robot emoji. A part is `<agent> (<model>)`, optionally led by
 * `worker` or `lead`, or `reviewed by <agent> (<model>)` with a second reviewer
 * joined by ` and `. Role words ignore case, and extra spaces count as one. At
 * most two reviewers are allowed in all. Returns null when there is no good
 * line, and `problem: 'reviewers'` when a `reviewed by` part is malformed, even
 * if another part is bad too. HTML comments are set aside first, so a commented
 * line counts neither for nor against, and neither does one inside a code block.
 */
export function parseMadeWith(body: string): { roles: MadeWithRoles | null; problem: 'reviewers' | null } | null {
  const lines = blankComments(body).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const head = /^(?:🤖 )?Made with (.+)$/.exec(lines.at(-1) ?? '');
  if (!head) return null;
  const roles: MadeWithRoles = { writers: [], reviewers: [], leads: [], others: [] };
  let problem: 'reviewers' | null = null;
  let bad = false;
  for (const raw of head[1].split(/(?<=\)),/)) {
    const part = raw.trim().replace(/\s+/g, ' ');
    // `reviewed by Y (b), and Z (c)`: the comma splits the pair, so `and` leads a part.
    if (/^reviewed by\b/i.test(part) || /^and\b/i.test(part)) {
      const match = REVIEWED_BY.exec(part);
      const names = match ? [match[1], match[2]].filter((name): name is string => Boolean(name)).map(readAgent) : [];
      if (!match || names.includes(null) || roles.reviewers.length + names.length > 2) problem = 'reviewers';
      else roles.reviewers.push(...(names as MadeWithAgent[]));
      continue;
    }
    // `worker (opus)` has no vendor: the whole part is the agent, not a role.
    const role = /^(worker|lead) (.+)$/i.exec(part);
    const named = role ? readAgent(role[2]) : null;
    const agent = named ?? readAgent(part);
    if (!agent) {
      bad = true;
      continue;
    }
    if (named && role?.[1].toLowerCase() === 'worker') roles.writers.push(agent);
    else if (named) roles.leads.push(agent);
    else roles.others.push(agent);
  }
  if (problem) return { roles: null, problem };
  return bad ? null : { roles, problem: null };
}

/**
 * Whether a body ends with `🤖 Made with <agent> (<model>)` (#570): one or more
 * comma-separated pairs name each AI and model that made it, and an optional
 * `reviewed by <agent> (<model>)` part, with a second reviewer after ` and `,
 * names who reviewed it (#673).
 */
export function hasMadeWith(body: string): boolean {
  return parseMadeWith(body)?.roles != null;
}

/**
 * The findings for a body whose last line is not a good `Made with` line: none when
 * it is good, a plain one for a missing line and another for a malformed
 * `reviewed by` part. Pull request bodies and bot notes share it.
 */
export function madeWithFindings(body: string): Finding[] {
  const parsed = parseMadeWith(body);
  if (parsed?.problem === 'reviewers') {
    return [finding('pr-made-with', 'body: the `reviewed by` part of the `Made with` line is not `reviewed by <agent> (<model>)`, or two joined by `and` (two in all)', 'write `reviewed by <agent> (<model>)` or `reviewed by <agent> (<model>) and <agent> (<model>)`, once, with at most two reviewers, after the worker and before the lead')];
  }
  if (parsed?.roles) return [];
  return [finding('pr-made-with', 'body: no `Made with` line at the end', 'end the body with `🤖 Made with <agent> (<model>)`, one or more comma-separated pairs, for example `🤖 Made with lead (opus), worker (sonnet)`; reviewers may follow the worker: `, reviewed by <agent> (<model>) and <agent> (<model>)`')];
}

/**
 * The issues whose milestone `gh pr create` (or `new`) should take: null for any other
 * command, one that gives `--milestone` or `-m`, a run-together word it can't read, or a
 * body that links no issue (the body check says so).
 */
export function readCommandMilestone(command: string[], body: string | null): CommandMilestone | null {
  const [file, ...rest] = command;
  if (!file || botProgram(file) !== 'gh' || body === null) return null;
  const { words, options, unreadable } = readArgs(rest, ISSUE_FLAGS);
  const [kind, verb] = words.map((index) => rest[index]);
  if (kind !== 'pr' || (verb !== 'create' && verb !== 'new') || unreadable !== null) return null;
  if (options.some(([name]) => name === '--milestone' || name === '-m')) return null;
  const issues = readLinkedIssues(body);
  if (!issues.length) return null;
  const repo = options.filter(([name]) => name === '--repo' || name === '-R').at(-1)?.[1] ?? null;
  return { issues, repo };
}

/** The problem when no linked issue has a milestone to copy (#512). */
export function noMilestoneFinding(issues: number[]): Finding {
  const named = issues.map((issue) => `#${issue}`).join(', ');
  const which = issues.length === 1 ? `the linked issue ${named} has none` : `none of the linked issues ${named} has one`;
  return finding('pr-milestone', `milestone: none given, and ${which}`, 'add `--milestone <name>`, or set a milestone on the issue');
}
