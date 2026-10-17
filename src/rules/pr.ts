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
export function checkPullRequest(pr: PullRequest, config: Pick<Config, 'tests'>): string[] {
  const problems: string[] = [];
  const title = pr.title.trim();
  if (!TITLE.test(title)) {
    problems.push(`title: use \`type(area): summary\` or \`type: summary\`, with a type from ${TYPES.join(', ')}. The title becomes the commit on main.`);
  }
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
