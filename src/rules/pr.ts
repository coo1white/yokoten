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
export function checkPullRequest(pr: PullRequest, config: Pick<Config, 'tests'>): Finding[] {
  const problems: Finding[] = [];
  const title = pr.title.trim();
  if (!TITLE.test(title)) {
    problems.push(finding('pr-title', 'title: not in the commit form', `use \`type(area): summary\` or \`type: summary\`, with a type from ${TYPES.join(', ')}`));
  }
  if (title.length > 72) problems.push(finding('pr-title', `title: ${title.length} characters, over 72`, 'shorten it; the details go in the body'));
  if (/\.$/.test(title)) problems.push(finding('pr-title', 'title: a full stop at the end', 'remove the full stop', { why: 'a commit title has no full stop' }));
  if (/#\d/.test(title)) problems.push(finding('pr-title', 'title: an issue number', 'remove the issue number, and put `Closes #N` in the body', { why: 'the host links the issue from the body' }));

  const body = pr.body ?? '';
  const first = body.split(/\r?\n/).find((l) => l.trim()) ?? '';
  if (!/^tier: [ABC]\s*$/.test(first.trim())) {
    problems.push(finding('pr-tier', 'body: the first line is not a tier', 'make the first line `tier: A`, `tier: B` or `tier: C` (A: secrets, data, install, releases; B: other code; C: docs and wording)'));
  }
  for (const name of SECTIONS) {
    const text = section(body, name);
    if (text === null) problems.push(finding('pr-section', `body: no \`## ${name}\` section`, `add a \`## ${name}\` section`));
    else if (!text || /^<[^>]*>$/.test(text)) problems.push(finding('pr-section', `body: the \`## ${name}\` section is empty`, 'fill it in'));
  }
  if (!/\b(closes|fixes|resolves|refs) #\d+/i.test(body)) {
    problems.push(finding('pr-issue', 'body: no linked issue', 'link the issue with `Closes #N`, or `Refs #N` when it does not finish it'));
  }

  // A change to what the project does needs a changelog line. Docs, tests and CI do not.
  const isTest = matcher(config.tests);
  const behaviour = pr.files.filter((f) => !/\.md$/i.test(f) && !isTest(f) && !f.startsWith('.github/'));
  if (behaviour.length && !pr.files.includes('CHANGELOG.md') && !/^No changelog: \S/m.test(body)) {
    problems.push(
      finding('pr-changelog', `changelog: ${behaviour.length} changed file(s) change what the project does, and CHANGELOG.md has no new line`, 'add one under [Unreleased], or write `No changelog: <reason>` in the body'),
    );
  }
  if (pr.files.some((f) => f.startsWith('kit/')) && !/\bkit\b/i.test(body)) {
    problems.push(finding('pr-kit', 'body: this changes `kit/` and does not say so', 'say in the body that every project gets this change on its next init'));
  }

  if (!pr.milestone) problems.push(finding('pr-milestone', 'milestone: none set', 'set one'));
  if (!pr.labels.length) problems.push(finding('pr-labels', 'labels: none', 'add a type label (feat, bug, docs, ...) and a tier label'));
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
export function largeDiff(lines: number, max = 400): Finding | null {
  if (lines <= max) return null;
  return finding('large-diff', `this pull request changes ${lines} lines, over ${max}`, 'split it if you can');
}

/** A long sentence (from `longSentences`) as a note on a file. */
export const longSentenceNote = (file: string, { line, words }: { line: number; words: number }): Finding =>
  finding('long-sentence', `a sentence of ${words} words`, 'split it into sentences of 25 words or fewer', { file, line });
