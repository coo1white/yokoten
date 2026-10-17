// The pull request rule: a pull request says what it is, why, how it was checked, how
// hard it is to take back, and which issue it closes. Its title becomes the one commit
// on main, so the title has the commit form. A reviewer, the owner or an agent, reads
// the same shape every time, and a beginner learns it from what CI says.
//
// Each problem says what is wrong and how to fix it. Text from the pull request is user
// input: it is read here as data, and never printed back in full.

import type { Config } from './config.ts';
import { matcher } from './glob.ts';

/** A pull request, as any code host can describe it. */
export interface PullRequest {
  title: string;
  body: string;
  /** Paths the pull request changes, relative to the repo root. */
  files: string[];
  labels: string[];
  milestone: string | null;
}

const TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'chore', 'ci', 'perf', 'build', 'style', 'revert'];
const TITLE = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9./-]*\\))?!?: \\S`);
const SECTIONS = ['Why', 'What changed', 'How tested'];

/** The text under a `## Name` heading, without HTML comments, up to the next heading. */
function section(body: string, name: string): string | null {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** Problems with a pull request. An empty list means it meets the standard. */
export function checkPullRequest(pr: PullRequest, config: Pick<Config, 'tests'> & Partial<Pick<Config, 'areas'>>): string[] {
  const problems: string[] = [];
  const title = pr.title.trim();
  if (!TITLE.test(title)) {
    problems.push(`title: use \`type(area): summary\` or \`type: summary\`, with a type from ${TYPES.join(', ')}. The title becomes the commit on main.`);
  }
  const area = TITLE.exec(title)?.[2]?.slice(1, -1);
  if (area && config.areas?.length && !config.areas.includes(area)) problems.push(`title: the area \`${area}\` is not in yokoten.json "areas". Use one of: ${config.areas.join(', ')}.`);
  if (title.length > 72) problems.push(`title: ${title.length} characters, over 72. Shorten it; the details go in the body.`);
  if (/\.$/.test(title)) problems.push('title: remove the full stop at the end.');
  if (/#\d/.test(title)) problems.push('title: remove the issue number; put `Closes #N` in the body.');

  const body = pr.body ?? '';
  const first = body.split(/\r?\n/).find((l) => l.trim()) ?? '';
  if (!/^tier: [ABC]\s*$/.test(first.trim())) {
    problems.push('body: the first line must be `tier: A`, `tier: B` or `tier: C`: how hard a mistake is to take back (A: secrets, data, install, releases; B: other code; C: docs and wording).');
  }
  for (const name of SECTIONS) {
    const text = section(body, name);
    if (text === null) problems.push(`body: add a \`## ${name}\` section.`);
    else if (!text || /^<[^>]*>$/.test(text)) problems.push(`body: the \`## ${name}\` section is empty. Fill it in.`);
  }
  if (!/\b(closes|fixes|resolves|refs) #\d+/i.test(body)) {
    problems.push('body: link the issue with `Closes #N` (or `Refs #N` when it does not finish it). Every change starts as an issue.');
  }

  // A change to what the project does needs a changelog line. Docs, tests and CI do not.
  const isTest = matcher(config.tests);
  const behaviour = pr.files.filter((f) => !/\.md$/i.test(f) && !isTest(f) && !f.startsWith('.github/'));
  if (behaviour.length && !pr.files.includes('CHANGELOG.md') && !/^No changelog: \S/m.test(body)) {
    problems.push(`changelog: ${behaviour.length} changed file(s) change what the project does, and CHANGELOG.md has no new line. Add one under [Unreleased], or write \`No changelog: <reason>\` in the body.`);
  }
  if (pr.files.some((f) => f.startsWith('kit/')) && !/\bkit\b/i.test(body)) {
    problems.push('body: this changes `kit/`, which every project gets on its next init. Say so in the body.');
  }

  if (!pr.milestone) problems.push('milestone: set one, so the board and the roadmap show this work.');
  if (!pr.labels.length) problems.push('labels: add a type label (feat, bug, docs, ...) and a tier label.');
  return problems;
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
  const lines = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')).split(/\r?\n/);
  lines.forEach((raw, i) => {
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
      if (!sentence.length) startLine = i + 1;
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

/**
 * A note when a pull request changes more than `max` lines (record 0004), else null. A
 * note, never a failure: Google's review guide finds about 100 lines fine, 1000 too large.
 */
export function largeDiff(lines: number, max = 400): string | null {
  if (lines <= max) return null;
  return `this pull request changes ${lines} lines, over ${max}. Smaller pull requests are easier to review; split it if you can.`;
}

// The issue rule. An issue title names its area and then the work: `doctor: add the
// review step` for a task, `check: misses a key in a JSON file` for an incident (the
// symptom, not the fix). The same areas as the pull request titles, so a list of issues
// reads like a list of commits to come.

/** One problem with a title: what is wrong, why it matters, and the fix. */
export interface TitleProblem {
  what: string;
  why: string;
  fix: string;
}

const AREA = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ISSUE_MAX = 60;

/**
 * Problems with an issue title. An empty list means it meets the standard. `labels` say
 * what kind of issue it is: an `incident` describes a symptom, anything else a task.
 */
export function checkIssueTitle(title: string, config: Partial<Pick<Config, 'areas'>>, labels: string[] = []): TitleProblem[] {
  const problems: TitleProblem[] = [];
  const t = title.trim();
  const incident = labels.some((l) => l.toLowerCase() === 'incident');
  const form = incident ? '`area: symptom`, for example `check: misses a key in a JSON file`' : '`area: verb phrase`, for example `doctor: add the review step`';
  const areas = config.areas ?? [];
  const m = /^([^\s:]+): +(\S.*)$/.exec(t);
  if (!m) {
    problems.push({ what: 'the title does not start with an area', why: 'the area tells a reader which part of the project the issue is about', fix: `write it as ${form}` });
  } else if (!AREA.test(m[1])) {
    problems.push({ what: 'the area is not one lowercase word', why: 'one form for every area keeps the list easy to scan and search', fix: `use a lowercase word, or words joined by hyphens, as in ${form}` });
  } else if (m[1] === "area") {
    problems.push({ what: 'the title still starts with the placeholder `area`', why: 'the template puts it there for you to replace', fix: `replace it with the part of the project, as in ${form}` });
  } else if (areas.length && !areas.includes(m[1])) {
    problems.push({ what: 'the area is not in yokoten.json "areas"', why: 'issues and pull requests share one list of areas', fix: `use one of: ${areas.join(', ')}` });
  }
  if (t.length > ISSUE_MAX) problems.push({ what: `the title has ${t.length} characters, over ${ISSUE_MAX}`, why: 'a long title is cut off in lists and boards', fix: 'shorten it; put the details in the body' });
  if (/[.。]$/.test(t)) problems.push({ what: 'the title ends with a full stop', why: 'a title is a name, not a sentence', fix: 'remove the full stop' });
  if (/#\d/.test(t)) problems.push({ what: 'the title holds an issue number', why: 'the host links issues from the body, not from the title', fix: 'remove the number; name the other issue in the body' });
  return problems;
}

/** The text form of a title problem: `what. Why. Fix.` */
export const formatTitleProblem = (p: TitleProblem): string => {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${p.what}. ${cap(p.why)}. ${cap(p.fix)}.`;
};
