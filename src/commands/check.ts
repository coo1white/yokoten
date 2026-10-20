// `yokoten check`: the tree, --staged, --history, and in CI --pr and --issue. `--pr <number>`
// reads one pull request through gh, for a repo without CI (#377). And
// `yokoten redact`, the privacy check's filter for command output (#390).

import { execFileSync } from 'node:child_process';
import { ghIn, readCodeOwners, readIssue, readNumberedPullRequest, readPullRequest } from '../host/github.ts';
import { loadConfig } from '../rules/config.ts';
import { type Finding, formatFinding } from '../rules/message.ts';
import { addedLinesByFile, changedLines, checkIssueTitle, checkOwnedTier, checkPullRequest, isChangeFile, largeDiff, longSentenceNote, longSentences, splitForDependabot } from '../rules/pr.ts';
import { parseChange } from '../run/changelog.ts';
import { check, checkHistory, historyTimeZones, timeZoneNote } from '../run/check.ts';
import { isCodeFile, nameNotes } from '../run/names.ts';
import { loadMarks, makeRedactor } from '../rules/privacy.ts';
import { machineMarks, machineUserNames } from '../setup/install.ts';
import { bullets, env, parse, print, printJson, requireRoot, say, showOnPullRequest, usage } from './shared.ts';

export function runCheck(): number {
  const options = parse('check');
  if (typeof options === 'string') return usage(options);
  const modes = ['--staged', '--history', '--pr', '--issue'].filter((m) => options.flags.has(m));
  if (modes.length > 1) return usage(`${modes.join(' and ')} can't be used together`);
  const mode = modes[0]?.slice(2) ?? 'tree';
  // A number goes with --pr only (#377): that pull request, read through gh.
  const number = options.positional[0];
  if (number !== undefined && mode !== 'pr') return usage(`unexpected argument ${number}: a number goes with --pr`);
  const json = options.flags.has('--json');
  const root = requireRoot(process.cwd(), json ? (missing) => ({ check: mode, ok: false, findings: [missing], notes: [] }) : undefined);
  if (!root) return 1;
  const config = loadConfig(root);
  const name = `yokoten check${mode === 'pr' || mode === 'issue' ? ` --${mode}` : ''}`;
  const notes: Finding[] = [];
  let problems: Finding[];
  if (mode === 'issue') {
    const issue = readIssue(env);
    if (!issue) {
      const skipped = 'no issue in this run (it reads the CI event); nothing to check';
      if (json) printJson({ check: mode, ok: true, skipped, findings: [], notes: [] });
      else print([`${name}: ${skipped}`]);
      return 0;
    }
    // An event that can't be read is one finding (#267), so --json and the summary still work.
    problems = 'problem' in issue ? [issue.problem] : checkIssueTitle(issue.title, config, issue.labels);
  } else if (mode === 'pr') {
    const pr = number === undefined ? readPullRequest(root, env) : readNumberedPullRequest(root, ghIn(root), number);
    if (!pr) {
      const skipped = 'no pull request in this run (it reads the CI event); nothing to check';
      if (json) printJson({ check: mode, ok: true, skipped, findings: [], notes: [] });
      else print([`${name}: ${skipped}`]);
      return 0;
    }
    // An event or commits that can't be read are one finding (#267), never git's raw error.
    if ('problem' in pr) {
      problems = [pr.problem];
    } else {
      // The file as the pull request leaves it, or null when the pull request deletes it.
      const readAtHead = (file: string): string | null => {
        try {
          return execFileSync('git', ['--no-replace-objects', 'show', `${pr.head}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
          return null;
        }
      };
      const printNotes = (found: Finding[], label: string) => {
        if (found.length && !json) print([`${name}: note: ${found.length} ${label}`, ...bullets(found.slice(0, 10)), ...(found.length > 10 ? [`- and ${found.length - 10} more`] : [])]);
      };
      // Plain English (record 0005): long sentences in changed Markdown are notes, never failures.
      const long: Finding[] = [];
      for (const file of pr.files.filter((p) => /\.md$/i.test(p))) {
        const text = readAtHead(file);
        if (text !== null) for (const s of longSentences(text)) long.push(longSentenceNote(file, s));
      }
      notes.push(...long);
      printNotes(long, 'long sentence(s)');
      // Names (record 0006): hard-to-read names on the lines a pull request adds to code
      // are notes too. Old lines are left alone, so a project is not noted all at once.
      const names: Finding[] = [];
      const codeFiles = pr.files.filter(isCodeFile);
      // One diff with renames found, so a moved file is not noted as all new. Fixed
      // prefixes and plain paths, whatever the user's git settings say.
      const diffArgs = ['--no-replace-objects', '-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${pr.base}...${pr.head}`];
      const added = codeFiles.length ? addedLinesByFile(execFileSync('git', diffArgs, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) : new Map<string, Set<number>>();
      for (const file of codeFiles) {
        const text = added.has(file) ? readAtHead(file) : null;
        if (text !== null) names.push(...nameNotes(file, text, added.get(file) ?? new Set()));
      }
      notes.push(...names);
      printNotes(names, 'hard-to-read name(s)');
      // A large pull request (record 0004) is a note too, never a failure.
      const large = largeDiff(changedLines(pr.numstat));
      if (large) {
        notes.push(large);
        if (!json) print([`${name}: note: ${formatFinding(large)}`]);
      }
      problems = checkPullRequest(pr, config);
      // Each change file the pull request leaves (#132) must be one `yokoten changelog` can read.
      for (const file of pr.files.filter(isChangeFile)) {
        const text = readAtHead(file);
        if (text !== null) problems.push(...parseChange(file, text).problems);
      }
      // Owned paths set the lowest tier, from the base branch's CODEOWNERS.
      const owned = checkOwnedTier(pr, readCodeOwners(root, pr.base));
      if (owned) problems.push(owned);
      // Dependabot can't write our body (#299): those rules are notes for it, never a silent skip.
      const split = splitForDependabot(pr, problems);
      problems = split.problems;
      notes.push(...split.notes);
      printNotes(split.notes, 'pull request rule(s) Dependabot does not meet');
    }
  } else {
    problems = mode === 'history' ? checkHistory(root, { config, env }) : check(root, { config, env, staged: mode === 'staged', notes });
    // A translation behind its English source (#87) is a note, for the whole tree only.
    if (!json) for (const note of notes) print([`${name}: note: ${formatFinding(note)}`]);
    const zones = mode === 'history' && config.privacy.utc ? historyTimeZones(root) : 0;
    if (zones) {
      notes.push(timeZoneNote(zones));
      if (!json) print([`${name}: note: ${formatFinding(timeZoneNote(zones))}`]);
    }
  }
  if (json) printJson({ check: mode, ok: !problems.length, findings: problems, notes });
  else if (!problems.length) print([`${name}: ok${mode === 'history' ? ' (every commit on every branch)' : ''}`]);
  else print([`${name}: ${problems.length} problem(s)`, ...bullets(problems)], process.stderr);
  showOnPullRequest(`yokoten check${mode === 'tree' ? '' : ` --${mode}`}`, problems, notes, { json, isPlaceAFile: mode !== 'history' });
  return problems.length ? 1 : 0;
}

/** Past this many characters with no line end, the text goes out at its last space or tab, so memory stays small. */
const MAX_PENDING = 1 << 20;

/** Where to cut text that has no line end yet: after its last space or tab, or the whole of it. Never inside a word. */
export function cutPoint(pending: string, max: number = MAX_PENDING): number {
  const line = pending.lastIndexOf('\n') + 1;
  if (line > 0 || pending.length <= max) return line;
  const space = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\t'));
  return space === -1 ? pending.length : space + 1;
}

/**
 * `yokoten redact`: stdin to stdout, with the owner hidden. It works line by line, so a
 * long output streams through. It reads only this machine (no network) and always exits 0:
 * the command it wraps gives the exit code, through pipefail. It fails open: when it can't
 * read the marks, or a piece fails, it says so in one line on stderr and passes the rest
 * through as it is. Hiding output must never stop the command it wraps.
 */
export function runRedact(): number | Promise<number> {
  const options = parse('redact');
  if (typeof options === 'string') return usage(options);
  let isWarned = false;
  const warn = (err: unknown) => {
    if (!isWarned) say(`yokoten redact: output is not hidden, because ${String((err as Error)?.message ?? err).split('\n')[0]}\n`, process.stderr);
    isWarned = true;
  };
  let redact = (text: string) => text;
  try {
    const found = machineMarks(env, { cwd: process.cwd() });
    redact = makeRedactor(
      {
        marks: loadMarks(env),
        owners: [...found.filter((mark) => mark.kind === 'git name' || mark.kind === 'git email').map((mark) => mark.value), ...machineUserNames(env)],
        hosts: found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value),
      },
      env,
    );
  } catch (err) {
    warn(err);
  }
  // The output is the command's, already redacted (home folder included), so it is written as it is.
  const write = (text: string) => {
    if (!text) return;
    let out = text;
    try {
      out = redact(text);
    } catch (err) {
      warn(err);
      redact = (rest) => rest;
    }
    process.stdout.write(out);
  };
  let pending = '';
  return new Promise((settle) => {
    process.stdout.on('error', () => settle(0));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      pending += chunk;
      const cut = cutPoint(pending);
      if (cut === 0) return;
      write(pending.slice(0, cut));
      pending = pending.slice(cut);
    });
    process.stdin.on('end', () => {
      write(pending);
      settle(0);
    });
    process.stdin.on('error', () => settle(0));
  });
}
