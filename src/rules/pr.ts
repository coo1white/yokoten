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
export function checkPullRequest(pr: PullRequest, config: Pick<Config, 'tests'> & Partial<Pick<Config, 'areas'>>): Finding[] {
  const problems: Finding[] = [];
  const title = pr.title.trim();
  if (!TITLE.test(title)) {
    problems.push(finding('pr-title', 'title: not in the commit form', `use \`type(area): summary\` or \`type: summary\`, with a type from ${TYPES.join(', ')}`));
  }
  const area = TITLE.exec(title)?.[2]?.slice(1, -1);
  if (area && config.areas?.length && !config.areas.includes(area)) {
    problems.push(finding('pr-title', `title: the area \`${area}\` is not in yokoten.json "areas"`, `use one of: ${config.areas.join(', ')}`, { why: 'issues and pull requests share one list of areas' }));
  }
  if (title.length > 72) problems.push(finding('pr-title', `title: ${title.length} characters, over 72`, 'shorten it; the details go in the body'));
  if (/\.$/.test(title)) problems.push(finding('pr-title', 'title: a full stop at the end', 'remove the full stop', { why: 'a commit title has no full stop' }));
  if (/#\d/.test(title)) problems.push(finding('pr-title', 'title: an issue number', 'remove the issue number, and put `Closes #N` in the body', { why: 'the host links the issue from the body' }));

  const body = pr.body ?? '';
  const first = body.split(/\r?\n/).find((l) => l.trim()) ?? '';
  if (!/^tier: [ABC]\s*$/.test(first.trim())) {
    problems.push(finding('pr-tier', 'body: the first line is not a tier', 'make the first line `tier: A`, `tier: B` or `tier: C` (A: secrets, data, install, releases, files CODEOWNERS owns; B: other code; C: docs and wording)'));
  }
  for (const name of SECTIONS) {
    const text = section(body, name);
    if (text === null) problems.push(finding('pr-section', `body: no \`## ${name}\` section`, `add a \`## ${name}\` section`));
    else if (!text || /^<[^>]*>$/.test(text)) problems.push(finding('pr-section', `body: the \`## ${name}\` section is empty`, 'fill it in'));
  }
  // Only Closes, Fixes and Resolves close the issue; Part of and Refs link it and leave it open.
  if (!/\b(closes|fixes|resolves|refs|part of) #\d+/i.test(body)) {
    problems.push(finding('pr-issue', 'body: no linked issue', 'link the issue with `Closes #N`, or `Part of #N` when it does not finish it'));
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
  const t = title.trim();
  const incident = labels.some((l) => l.toLowerCase() === 'incident');
  const form = incident ? '`area: symptom`, for example `check: misses a key in a JSON file`' : '`area: verb phrase`, for example `doctor: add the review step`';
  const areas = config.areas ?? [];
  const m = /^([^\s:]+): +(\S.*)$/.exec(t);
  if (!m) {
    problems.push(finding('issue-area', 'title: it does not start with an area', `write it as ${form}`));
  } else if (!AREA.test(m[1])) {
    problems.push(finding('issue-area', 'title: the area is not one lowercase word', `use a lowercase word, or words joined by hyphens, as in ${form}`, { why: 'one form for every area keeps the list easy to scan and search' }));
  } else if (m[1] === 'area') {
    problems.push(finding('issue-area', 'title: it still starts with the placeholder `area`', `replace it with the part of the project, as in ${form}`, { why: 'the template puts it there for you to replace' }));
  } else if (areas.length && !areas.includes(m[1])) {
    problems.push(finding('issue-area', 'title: the area is not in yokoten.json "areas"', `use one of: ${areas.join(', ')}`, { why: 'issues and pull requests share one list of areas' }));
  }
  if (t.length > ISSUE_MAX) problems.push(finding('issue-title', `title: ${t.length} characters, over ${ISSUE_MAX}`, 'shorten it, and put the details in the body'));
  if (/[.。]$/.test(t)) problems.push(finding('issue-title', 'title: a full stop at the end', 'remove the full stop', { why: 'a title is a name, not a sentence' }));
  if (/#\d/.test(t)) problems.push(finding('issue-title', 'title: an issue number', 'remove the number, and name the other issue in the body', { why: 'the host links issues from the body, not from the title' }));
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

/** The regular expression for one CODEOWNERS pattern. */
function ownerPattern(raw: string): RegExp {
  const folder = raw.endsWith('/');
  const body = raw.replace(/^\//, '').replace(/\/$/, '');
  const anchored = raw.startsWith('/') || body.includes('/');
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*' && body[i + 1] === '*') {
      if (body[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // `docs/*` matches the files in docs/ and not deeper (GitHub's documented case).
  const end = folder ? '/.*' : /(^|\/)\*$/.test(body) && body !== '*' ? '' : '(?:/.*)?';
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}${end}$`);
}

/** The rules in a CODEOWNERS file, in order. */
export function parseCodeOwners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    const re = ownerPattern(pattern);
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
  const tier = /^tier: ([ABC])\s*$/.exec((pr.body ?? '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '')?.[1];
  if (!tier || tier === 'A') return null;
  const rules = parseCodeOwners(codeOwners.text);
  const owned = pr.files.filter((f) => ownersOf(rules, f).length);
  if (!owned.length) return null;
  const shown = owned.slice(0, 5).join(', ') + (owned.length > 5 ? `, and ${owned.length - 5} more` : '');
  return finding('pr-owned', `body: \`tier: ${tier}\`, and this changes ${owned.length} file(s) that CODEOWNERS owns (read from ${codeOwners.from}): ${shown}`, 'make the first line `tier: A`');
}
