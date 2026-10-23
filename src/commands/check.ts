// `yokoten check`: the tree, --staged, --history, and in CI --pr and --issue. `--pr <number>`
// reads one pull request through gh, for a repo without CI (#377). And
// `yokoten redact`, the privacy check's filter for command output (#390). And `yokoten marks`,
// the private marks from the command line: `allow`, which lets one mark through in the
// repo you are in, kept on this machine, never in the repo (#447); `allow --remove` is its way
// back (record 0014). Alone it counts the marks by kind; `add` and `remove` take one value
// from the terminal with no echo, or from stdin, so it never lands in the shell history;
// `off <kind>` and `on <kind>` stop and start install adding a kind, kept in machine.json
// (#434). A mark is never printed, logged or repeated back. Marks the owner added are never
// touched by `off`, `on` or install.

import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readCurrentPullRequest, readsCurrentPullRequest } from '../host/current-pr.ts';
import { asText, borrowedHost, type Gh, ghIn, isObject, readCodeOwners, readIssue, readNumberedPullRequest, readPullRequest, readRepoLabelNames } from '../host/github/index.ts';
import { loadConfig } from '../rules/config.ts';
import { type Finding, formatFinding, isWarningFinding } from '../rules/message.ts';
import { addedLinesByFile, changedLines, checkIssueLabels, checkIssueTitle, checkOwnedTier, checkPullRequest, isChangeFile, largeDiff, longSentenceNote, longSentences, splitForDependabot } from '../rules/pr.ts';
import { parseChange } from '../run/changelog.ts';
import { check, checkHistory, borrowedFiles, type BorrowedChange, GitReadError, gitReadFinding, historyTimeZones, indexFiles, readGit, timeZoneNote, unstageHint, watchBorrowed } from '../run/check.ts';
import { isCodeFile, nameNotes } from '../run/names.ts';
import { addedIgnores, type AllowEntry, isLink, loadMarks, type Mark, marksFile, marksFiles, machineAllowed, machineAllowFile, makeRedactor, matchingEntries, NO_HOME, readMachineAllow, repoKey } from '../rules/privacy.ts';
import { addOwnMark, countMarkKinds, fillMarks, kindsTurnedOff, machineMarks, machineUserNames, paths, removeMarks, setKindOff, SWITCHED_KINDS } from '../setup/install.ts';
import { bullets, type Invocation, parse, print, printJson, readInput, requireRoot, say, showOnPullRequest, usage } from './shared.ts';

/** How long `check --pr <number>` waits for gh. */
const GH_TIMEOUT_MS = 15000;

export async function runCheck(invocation: Invocation): Promise<number> {
  const options = parse('check', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const modes = ['--staged', '--history', '--pr', '--issue'].filter((m) => options.flags.has(m));
  if (modes.length > 1) return usage(invocation, `${modes.join(' and ')} can't be used together`);
  const mode = modes[0]?.slice(2) ?? 'tree';
  // A number goes with --pr only (#377): that pull request, read through gh.
  const number = options.positional[0];
  if (number !== undefined && mode !== 'pr') return usage(invocation, `unexpected argument ${number}: a number goes with --pr`);
  const json = options.flags.has('--json');
  const root = requireRoot(invocation, invocation.cwd, json ? (missing) => ({ check: mode, ok: false, findings: [missing], notes: [] }) : undefined);
  if (!root) return 1;
  const config = loadConfig(root);
  const name = `yokoten check${mode === 'pr' || mode === 'issue' ? ` --${mode}` : ''}`;
  const notes: Finding[] = [];
  let problems: Finding[];
  try {
    problems = await runMode(invocation, mode, root, config, notes, { name, json, number });
  } catch (err) {
    // A git read the check depends on gave no answer (#403): one finding, and the check fails.
    if (!(err instanceof GitReadError)) throw err;
    problems = [gitReadFinding(err)];
  }
  if (problems === SKIPPED) return 0;
  if (json) printJson(invocation, { check: mode, ok: !problems.length, findings: problems, notes });
  else if (!problems.length) print(invocation, [`${name}: ok${mode === 'history' ? ' (every commit on every branch)' : ''}`]);
  else print(invocation, [`${name}: ${problems.length} problem(s)`, ...bullets(problems), ...unstageLines(root, invocation.env, mode, problems)], invocation.stderr);
  showOnPullRequest(invocation, `yokoten check${mode === 'tree' ? '' : ` --${mode}`}`, problems, notes, { json, isPlaceAFile: mode !== 'history' });
  return problems.length ? 1 : 0;
}

/** For a stopped commit, the line that says how to unstage the files it names (#503). Nothing for other modes. */
function unstageLines(root: string, env: Invocation['env'], mode: string, problems: Finding[]): string[] {
  if (mode !== 'staged') return [];
  try {
    const hint = unstageHint(root, env, problems);
    return hint ? [hint] : [];
  } catch {
    return []; // git can't answer now: the problems above already stand
  }
}

/** Returned by `runMode` when there is nothing to check; it has already said so. */
const SKIPPED: Finding[] = [];

/** The problems of one mode of `check`; its notes go into `notes`, and some are printed as they are found. */
async function runMode(invocation: Invocation, mode: string, root: string, config: ReturnType<typeof loadConfig>, notes: Finding[], { name, json, number }: { name: string; json: boolean; number?: string }): Promise<Finding[]> {
  const { env } = invocation;
  let problems: Finding[];
  if (mode === 'issue') {
    const issue = readIssue(env);
    if (!issue) {
      const skipped = 'no issue in this run (it reads the CI event); nothing to check';
      if (json) printJson(invocation, { check: mode, ok: true, skipped, findings: [], notes: [] });
      else print(invocation, [`${name}: ${skipped}`]);
      return SKIPPED;
    }
    // An event that can't be read is one finding (#267), so --json and the summary still work.
    // The labels need the kinds the repo has, read through gh; when gh can't list
    // them, only the title is checked (#544).
    problems =
      'problem' in issue ? [issue.problem] : [...checkIssueTitle(issue.title, config, issue.labels), ...checkIssueLabels(issue.labels, readRepoLabelNames(ghIn(root, env, GH_TIMEOUT_MS)))];
  } else if (mode === 'pr') {
    let pr = number === undefined ? readPullRequest(root, env) : readNumberedPullRequest(root, ghIn(root, env, GH_TIMEOUT_MS), number, env);
    // When the workflow asks for it (#645), the title, body, labels and milestone are the
    // ones the pull request has now, never the event file's. The commits stay the event's.
    if (pr && !('problem' in pr) && number === undefined && readsCurrentPullRequest(env)) {
      const now = await readCurrentPullRequest(env);
      pr = 'problem' in now ? now : { ...pr, ...now };
    }
    if (!pr) {
      const skipped = 'no pull request in this run (it reads the CI event); nothing to check';
      if (json) printJson(invocation, { check: mode, ok: true, skipped, findings: [], notes: [] });
      else print(invocation, [`${name}: ${skipped}`]);
      return SKIPPED;
    }
    // An event or commits that can't be read are one finding (#267), never git's raw error.
    if ('problem' in pr) {
      problems = [pr.problem];
    } else {
      // The file as the pull request leaves it, or null when the pull request deletes it.
      // Any other file git can't show stops the check (#403): never read as deleted.
      const deleted = new Set(pr.deleted);
      const readAtHead = (file: string): string | null => (deleted.has(file) ? null : readGit(root, ['show', `${pr.head}:${file}`], { env }).toString('utf8'));
      const printNotes = (found: Finding[], label: string) => {
        if (found.length && !json) print(invocation, [`${name}: note: ${found.length} ${label}`, ...bullets(found.slice(0, 10)), ...(found.length > 10 ? [`- and ${found.length - 10} more`] : [])]);
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
      const diffArgs = ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${pr.base}...${pr.head}`];
      const added = pr.files.length ? addedLinesByFile(readGit(root, diffArgs, { env }).toString('utf8')) : new Map<string, Set<number>>();
      for (const file of codeFiles) {
        const text = added.has(file) ? readAtHead(file) : null;
        if (text !== null) names.push(...nameNotes(file, text, added.get(file) ?? new Set()));
      }
      notes.push(...names);
      printNotes(names, 'hard-to-read name(s)');
      // Each ignore the pull request adds (#616) is a notice for the reviewer, never a failure.
      const ignores: Finding[] = [];
      for (const [file, lines] of added) {
        let text: string | null = null;
        try {
          text = lines.size ? readAtHead(file) : null;
        } catch {
          // A submodule's pointer is not a file: it holds no ignore.
        }
        if (text !== null && !text.includes('\0')) ignores.push(...addedIgnores(file, text, lines, env));
      }
      notes.push(...ignores);
      printNotes(ignores, 'ignore(s) added by this pull request');
      // A large pull request (record 0004) is a note too, never a failure.
      const large = largeDiff(changedLines(pr.numstat));
      if (large) {
        notes.push(large);
        if (!json) print(invocation, [`${name}: note: ${formatFinding(large)}`]);
      }
      problems = checkPullRequest(pr, config);
      // Each change file the pull request leaves (#132) must be one `yokoten changelog` can read.
      for (const file of pr.files.filter(isChangeFile)) {
        const text = readAtHead(file);
        if (text !== null) problems.push(...parseChange(file, text).problems);
      }
      // Owned paths set the lowest tier, from the base branch's CODEOWNERS.
      const owned = checkOwnedTier(pr, readCodeOwners(root, pr.base, env));
      if (owned) problems.push(owned);
      // Dependabot can't write our body (#299): those rules are notes for it, never a silent skip.
      const split = splitForDependabot(pr, problems);
      problems = split.problems;
      notes.push(...split.notes);
      printNotes(split.notes, 'pull request rule(s) Dependabot does not meet');
    }
  } else {
    problems = mode === 'history' ? checkHistory(root, { config, env, notes }) : check(root, { config, env, staged: mode === 'staged', notes });
    // A translation behind its English source (#87) is a note, for the whole tree only.
    if (!json) for (const note of notes) print(invocation, [`${name}: ${isWarningFinding(note) ? 'warning' : 'note'}: ${formatFinding(note)}`]);
    const zones = mode === 'history' && config.privacy.utc ? historyTimeZones(root, env) : 0;
    if (zones) {
      notes.push(timeZoneNote(zones));
      if (!json) print(invocation, [`${name}: note: ${formatFinding(timeZoneNote(zones))}`]);
    }
  }
  return problems;
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
export function runRedact(invocation: Invocation): number | Promise<number> {
  const { env, stdout } = invocation;
  const options = parse('redact', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  let isWarned = false;
  const warn = (err: unknown) => {
    if (!isWarned) say(invocation, `yokoten redact: output is not hidden, because ${String((err as Error)?.message ?? err).split('\n')[0]}\n`, invocation.stderr);
    isWarned = true;
  };
  let redact = (text: string) => text;
  try {
    const found = machineMarks(env, { cwd: invocation.cwd });
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
    stdout.write(out);
  };
  let pending = '';
  return new Promise((settle) => {
    stdout.on('error', () => settle(0));
    const { stream } = invocation.stdin;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      const cut = cutPoint(pending);
      if (cut === 0) return;
      write(pending.slice(0, cut));
      pending = pending.slice(cut);
    });
    stream.on('end', () => {
      write(pending);
      settle(0);
    });
    stream.on('error', () => settle(0));
  });
}

// ---- `yokoten marks` (#447) ----

const MARK_ACTIONS = ['allow', 'add', 'remove', 'off', 'on'];
const SHAPE = '`yokoten marks allow <mark> --here`, or `yokoten marks allow --remove <mark> --here`';

/** One line on stderr, and exit 1. */
function refuse(invocation: Invocation, text: string): number {
  print(invocation, [`yokoten marks: ${text}`], invocation.stderr);
  return 1;
}

export function runMarks(invocation: Invocation): number | Promise<number> {
  const { args } = invocation;
  // After `--`, every word is a word, so a mark may start with `-`.
  const end = args.indexOf('--');
  const options = parse('marks', end === -1 ? args : args.slice(0, end));
  // The parser repeats the word it can't read; here it may be a mark, so it is never shown.
  if (typeof options === 'string') {
    return usage(invocation, options.startsWith('unknown option') ? `an unknown option; to give a mark that starts with -, put it after --, as in yokoten marks allow --here -- <mark>` : `too many words; give one mark, as in ${SHAPE}`);
  }
  const words = [...options.positional, ...(end === -1 ? [] : args.slice(end + 1))];
  if (words.length > 2) return usage(invocation, `too many words; give one mark, as in ${SHAPE}`);
  const [action, mark] = words;
  // The other actions, and `yokoten marks` alone, which counts the marks (#434).
  if (action === undefined || (MARK_ACTIONS.includes(action) && action !== 'allow')) {
    if (options.flags.size) return usage(invocation, `--here and --remove go with allow only: ${SHAPE}`);
    return runMarkAction(invocation, action, mark);
  }
  if (!MARK_ACTIONS.includes(action)) return usage(invocation, `the action is add, remove, off, on or allow; run \`yokoten marks\` alone to count your marks`);
  if (mark === undefined || !mark.trim()) return usage(invocation, `give the mark: ${SHAPE}`);
  if (!options.flags.has('--here')) return usage(invocation, `add --here: an allow is always for one repo, the one you are in`);
  return allowHere(invocation, mark.trim().toLowerCase(), { isRemoving: options.flags.has('--remove') });
}

/** The kinds `yokoten marks` counts, in the order it shows them. */
const SHOWN_KINDS = ['git name', 'git email', 'forge login', 'private remote host', 'by hand'];
/** The word the command line uses for a kind: `git name` is `git-name`. */
const kindWord = (kind: string): string => kind.replace(/ /g, '-');
const KIND_WORDS = Object.keys(SWITCHED_KINDS).join(', ');
/** Where install reads each kind, for when this machine has none to add. */
const SOURCES: Record<string, string> = {
  'git name': 'git has no user.name here',
  'git email': 'git has no user.email here, or it is a noreply address, which is public',
  'forge login': 'gh is not signed in here',
};

/** Run `yokoten marks [add | remove | off <kind> | on <kind>]`. `word` is the second word, if any. */
export function runMarkAction(invocation: Invocation, action: string | undefined, word: string | undefined): number | Promise<number> {
  try {
    marksFile(invocation.env);
  } catch {
    return refuse(invocation, `${NO_HOME}. Set HOME to your home folder`);
  }
  if (action === undefined) return showCounts(invocation);
  if (action === 'add' || action === 'remove') {
    // A mark on the command line would land in the shell history, so it is refused, and never repeated.
    if (word !== undefined) return usage(invocation, `the mark is never a word on the command line, where your shell history keeps it. Run \`yokoten marks ${action}\` and type it, or pipe it in`);
    return readHidden(invocation).then((value) => changeOne(invocation, action, value));
  }
  const kind = word === undefined ? undefined : SWITCHED_KINDS[word];
  if (!kind) return usage(invocation, `name the kind: ${KIND_WORDS}, as in \`yokoten marks ${action} git-name\``);
  return action === 'off' ? turnOff(invocation, kind) : turnOn(invocation, kind);
}

/** `yokoten marks`: how many marks of each kind, and which kinds are off. Never a value. */
function showCounts(invocation: Invocation): number {
  let counts: Map<string, number>;
  try {
    counts = countMarkKinds(invocation.env);
  } catch {
    return refuse(invocation, "your private-marks file can't be read");
  }
  const off = new Set(kindsTurnedOff(invocation.env));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const kinds = [...SHOWN_KINDS, ...[...counts.keys()].filter((kind) => !SHOWN_KINDS.includes(kind))];
  const width = Math.max(...kinds.map((kind) => kind.length)) + 1;
  // The count is of every file the check reads (#656): the setting's file adds to the default.
  const where = marksFiles(invocation.env).length > 1 ? `${paths(invocation.env).marks} and the file YOKOTEN_PRIVATE_MARKS names` : paths(invocation.env).marks;
  const lines = [`yokoten marks: ${total} in ${where} (the values are never shown)`];
  for (const kind of kinds) {
    const note = off.has(kind) ? `  off: install does not add it; \`yokoten marks on ${kindWord(kind)}\` adds it again` : '';
    lines.push(`  ${`${kind}:`.padEnd(width + 1)} ${counts.get(kind) ?? 0}${note}`);
  }
  lines.push('To add one: yokoten marks add. To stop install adding a kind: yokoten marks off <kind>.');
  print(invocation, lines);
  return 0;
}

/**
 * The one value the user gives: typed in a terminal with no echo, or all of stdin when it is
 * not a terminal. Null when the user stops it (Ctrl-C). The terminal part is kept thin: it
 * can only be tried by hand.
 */
function readHidden(invocation: Invocation): Promise<string | null> {
  const stream = invocation.stdin.stream as NodeJS.ReadStream;
  if (!stream.isTTY || typeof stream.setRawMode !== 'function') return Promise.resolve(readInput(invocation.stdin));
  say(invocation, 'Type the mark, then press Enter (it is not shown): ', invocation.stderr);
  return new Promise((settle) => {
    let value = '';
    const finish = (result: string | null) => {
      stream.off('data', onData);
      stream.setRawMode(false);
      stream.pause();
      say(invocation, '\n', invocation.stderr);
      settle(result);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish(value);
        if (char === '\u0003') return finish(null);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stream.setEncoding('utf8');
    stream.setRawMode(true);
    stream.on('data', onData);
    stream.resume();
  });
}

/** `marks add` or `marks remove` with the value read. */
function changeOne(invocation: Invocation, action: 'add' | 'remove', value: string | null): number {
  if (value === null) return refuse(invocation, 'stopped, so nothing changed');
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return refuse(invocation, `no mark was given, so nothing changed. Run \`yokoten marks ${action}\` and type it, or pipe it in`);
  if (lines.length > 1) return refuse(invocation, 'give one mark at a time, so nothing changed');
  const [mark] = lines;
  if (mark.startsWith('#')) return refuse(invocation, "a mark can't start with #: the file reads that line as a comment. Nothing changed");
  const { env } = invocation;
  if (action === 'add') {
    let isAdded: boolean;
    try {
      isAdded = addOwnMark(env, mark);
    } catch {
      return refuse(invocation, "your private-marks file can't be written, so nothing changed");
    }
    print(invocation, [isAdded ? 'yokoten marks: added the mark to your private marks (not shown)' : 'yokoten marks: that mark is already in your private marks, so nothing changed']);
    return 0;
  }
  let removed: Mark[];
  try {
    removed = removeMarks(env, (one) => one.value === mark.toLowerCase());
  } catch {
    return refuse(invocation, "your private-marks file can't be changed, so nothing changed");
  }
  if (!removed.length) {
    print(invocation, ['yokoten marks: that mark is not in your private marks, so nothing changed']);
    return 0;
  }
  const said = ['yokoten marks: removed the mark from your private marks'];
  const off = new Set(kindsTurnedOff(env));
  const from = removed.map((one) => one.kind).find((kind): kind is string => kind !== null && !off.has(kind));
  if (from && (Object.values(SWITCHED_KINDS) as string[]).includes(from)) said.push(`It came from this machine (your ${from}), so install adds it again. To stop that: yokoten marks off ${kindWord(from)}`);
  else if (from) said.push(`It came from this machine (a ${from}), so install adds it again while this machine has it.`);
  print(invocation, said);
  return 0;
}

/** `marks off <kind>`: kept in machine.json, and the marks install added of that kind taken out. */
function turnOff(invocation: Invocation, kind: string): number {
  const { env } = invocation;
  let removed: Mark[];
  try {
    setKindOff(env, kind, true);
    removed = removeMarks(env, (mark) => mark.kind === kind);
  } catch {
    return refuse(invocation, "the machine state or your private-marks file can't be written, so the kind may still be on. Run this again");
  }
  print(invocation, [
    `yokoten marks: install no longer adds your ${kind}, and removed the ${removed.length} mark(s) it had added for it. Marks you added yourself are kept.`,
    `To go back to the default: yokoten marks on ${kindWord(kind)}`,
  ]);
  return 0;
}

/** `marks on <kind>`: the default again, and the kind filled from this machine now. */
function turnOn(invocation: Invocation, kind: string): number {
  const { env, cwd } = invocation;
  let added: string[];
  let found: number;
  try {
    setKindOff(env, kind, false);
    // gh may reach the network for the login: three seconds at most, and only for that kind.
    const marks = machineMarks(env, { cwd, gh: kind === 'forge login' ? ghIn(cwd, env, 3000) : undefined }).filter((mark) => mark.kind === kind);
    found = marks.length;
    added = fillMarks(env, marks);
  } catch {
    return refuse(invocation, "the machine state or your private-marks file can't be written. Run this again");
  }
  const back = `yokoten marks: install adds your ${kind} again`;
  if (added.length) print(invocation, [`${back}, and it is in your private marks now (not shown)`]);
  else print(invocation, [found ? `${back}; there is nothing new to add now` : `${back}, but there is none to add now: ${SOURCES[kind]}`]);
  return 0;
}

/** Past this age, a lock file is from a run that died, and is taken over. */
const STALE_LOCK_MS = 30_000;

/** Add the mark to this repo's entry in the machine allow file, or with `isRemoving`, take it out. */
function allowHere(invocation: Invocation, mark: string, { isRemoving }: { isRemoving: boolean }): number {
  const { env } = invocation;
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  let file: string;
  let marks: string[];
  try {
    file = machineAllowFile(env);
    marks = loadMarks(env);
  } catch (err) {
    if ((err as Error).message === NO_HOME) return refuse(invocation, `${NO_HOME}. Set HOME to your home folder`);
    return refuse(invocation, "your private-marks file can't be read, so nothing was changed");
  }
  // Only a mark the file holds: anything else is not private to this machine, so nothing to allow.
  if (!isRemoving && !marks.includes(mark)) return refuse(invocation, 'that is not a line of your private-marks file, so there is nothing to allow. Check the spelling, or add it to the file first');
  const key = repoKey(root, env);
  if ('none' in key) return refuse(invocation, `nothing was changed, because ${key.none}. The allow from this machine is for a repo with one; use "privacy.allow" in yokoten.json instead`);
  if ('unsure' in key) return refuse(invocation, `nothing was changed, because ${key.unsure}`);
  // A link to the file is kept: the file it points to is the one changed. A link to nothing is refused.
  let target = file;
  if (isLink(file)) {
    try {
      target = realpathSync(file);
    } catch {
      return refuse(invocation, "nothing was changed, because this machine's allow file is a link to a file that is not there. Fix the link or remove it");
    }
  }
  const lock = `${target}.lock`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    return refuse(invocation, "nothing was changed, because the allow file's folder can't be written");
  }
  const locked = takeLock(lock);
  if (locked !== 'taken') {
    return refuse(invocation, locked === 'busy' ? 'nothing was changed, because another `yokoten marks` is changing the allow file. Run this again' : "nothing was changed, because the allow file's folder can't be written");
  }
  try {
    // Read inside the lock, so a change another run made is kept.
    const read = readMachineAllow(env);
    if ('unsure' in read) return refuse(invocation, `nothing was changed, because ${read.unsure}. Fix it or delete it, then run this again`);
    const found = matchingEntries(read.entries, key);
    if (found.length > 1) return refuse(invocation, "nothing was changed, because two entries in this machine's allow file match this repo. Delete one, then run this again");
    const entry = found[0];
    const has = entry?.allow.some((allowed) => allowed.toLowerCase() === mark) ?? false;
    let entries: AllowEntry[];
    if (isRemoving) {
      if (!entry || !has) {
        print(invocation, ['yokoten marks: that mark is not allowed here, so nothing changed']);
        return 0;
      }
      const left = entry.allow.filter((allowed) => allowed.toLowerCase() !== mark);
      entries = left.length ? read.entries.map((one) => (one === entry ? { ...one, allow: left } : one)) : read.entries.filter((one) => one !== entry);
    } else {
      if (has) {
        print(invocation, ['yokoten marks: that mark is already allowed here, so nothing changed']);
        return 0;
      }
      entries = entry ? read.entries.map((one) => (one === entry ? { ...one, allow: [...one.allow, mark] } : one)) : [...read.entries, { remote: key.remote, allow: [mark] }];
    }
    try {
      save(target, entries, read.skipOwnName);
    } catch {
      return refuse(invocation, "the allow file can't be written, so nothing was changed");
    }
    // Say what the file now says, never what was meant to happen.
    const now = machineAllowed(env, root);
    const isAllowed = now.allow.includes(mark);
    if (now.unsure || isAllowed === isRemoving) return refuse(invocation, `the allow file does not say what was asked; run \`yokoten doctor\` to see why`);
    print(
      invocation,
      isRemoving
        ? ['yokoten marks: the allow is taken back; the checks stop that mark in this repo again']
        : [
            'yokoten marks: that mark is allowed in this repo only. The allow is kept on this machine, not in the repo.',
            'To take it back: yokoten marks allow --remove <mark> --here',
          ],
    );
    return 0;
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Make the lock file: 'taken', 'busy' when another run holds it, or 'unwritable'. A lock left
 * by a run that died is taken over atomically: it is renamed away under a name of this run's
 * own, then made again with `wx`, so of two runs that try at once, the one whose `wx` loses is
 * busy. A lock renamed away that turns out fresh (another run had just taken it over) is put
 * back with a hard link, which never replaces one made since.
 */
function takeLock(lock: string): 'taken' | 'busy' | 'unwritable' {
  const make = (): 'taken' | 'busy' | 'unwritable' => {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      return 'taken';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'unwritable';
    }
  };
  const first = make();
  if (first !== 'busy') return first;
  const isStale = (path: string) => Date.now() - statSync(path).mtimeMs >= STALE_LOCK_MS;
  const away = `${lock}.${process.pid}.${randomUUID()}.stale`;
  try {
    if (!isStale(lock)) return 'busy';
    renameSync(lock, away);
  } catch {
    return make(); // released or taken over meanwhile: one more try decides
  }
  let isFresh: boolean;
  try {
    isFresh = !isStale(away);
  } catch {
    return 'busy';
  }
  if (isFresh) {
    // Another run's live lock: put it back. If that fails, it is left where it is, never deleted.
    try {
      linkSync(away, lock);
      rmSync(away, { force: true });
    } catch {
      // busy either way
    }
    return 'busy';
  }
  rmSync(away, { force: true });
  return make();
}

/** Write the file whole, readable by its owner only, through a temporary file so a crash never leaves half of it. */
function save(file: string, entries: AllowEntry[], skipOwnName?: false): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(skipOwnName === false ? { skipOwnName, repos: entries } : { repos: entries }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// ---- Borrowed code (record 0024) ----

/** The issue for one changed source. The title meets the issue-title rule of this repo. */
export function borrowedIssue(change: BorrowedChange): { title: string; body: string; labels: string[] } {
  const title = change.isSecurity ? 'check: take a borrowed security fix' : 'check: review borrowed code upstream';
  const labels = change.isSecurity ? ['bug', 'hotfix', 'tier B'] : ['bug', 'tier B'];
  const where = change.files.map((path) => `- \`${path}\``).join('\n');
  const newest = change.latestCommit === null ? 'the file is gone from the default branch' : `\`${change.latestCommit}\``;
  const commits = change.commits.length
    ? change.commits.map((commit) => `- \`${commit.sha}\` ${commit.message.split('\n')[0]}`).join('\n')
    : '- none the host could list';
  const security = change.isSecurity ? '\n**Upstream names a security fix. Take it first.**\n' : '';
  const note = change.note ? `\n${change.note}.\n` : '';
  const body = [
    `Upstream changed \`${change.source}\` after the commit we borrowed.`,
    security + note,
    `Borrowed files:\n${where}`,
    `Borrowed commit: \`${change.borrowedCommit}\``,
    `Newest commit on the default branch: ${newest}`,
    `Commits after the borrowed one:\n${commits}`,
    'Record 0024: re-take the part we need, or say in this issue why the change does not touch it.',
  ].join('\n\n');
  return { title, body: `${body}\n`, labels };
}

/** Whether an open issue already names this source, so a later run opens no second one. */
export function hasOpenIssue(gh: Gh, source: string): boolean {
  const text = gh(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body']);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  if (!Array.isArray(json)) return false;
  return json.some((issue) => isObject(issue) && asText(issue.body).includes(source));
}

/**
 * `yokoten borrowed`: compare each wheel with upstream's default branch, and open one
 * issue per source that moved (record 0024). A security fix is called out. With
 * `--dry-run` it writes nothing; with `--json` it prints the report and writes nothing.
 */
export async function runBorrowed(invocation: Invocation): Promise<number> {
  const options = parse('borrowed', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const isDryRun = options.flags.has('--dry-run');
  const json = options.flags.has('--json');
  const root = requireRoot(invocation, invocation.cwd, json ? (missing) => ({ borrowed: { changed: [], unreadable: [] }, ok: false, findings: [missing] }) : undefined);
  if (!root) return 1;
  const { env } = invocation;
  const files = borrowedFiles(indexFiles(root, env), (path) => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return null;
    }
  });
  const gh = ghIn(root, env, GH_TIMEOUT_MS);
  const watch = watchBorrowed(files, borrowedHost(gh));
  for (const gap of watch.unreadable) print(invocation, [`borrowed: can't read upstream ${gap.source} (${gap.files.join(', ')}): ${gap.reason}`], invocation.stderr);
  const issues = watch.changed.map((change) => ({ change, issue: borrowedIssue(change) }));
  if (json) printJson(invocation, { borrowed: watch, issues: issues.map(({ change, issue }) => ({ source: change.source, ...issue })) });
  else if (isDryRun) {
    for (const { change, issue } of issues) print(invocation, [`would open: ${issue.title} for ${change.source}`, ...issue.body.trimEnd().split('\n')]);
    print(invocation, [`borrowed: ${files.length} file(s), ${watch.changed.length} source(s) changed, ${watch.unreadable.length} unreadable`]);
  }
  if (isDryRun || json) return watch.unreadable.length ? 1 : 0;
  let failed = watch.unreadable.length > 0;
  for (const { change, issue } of issues) {
    try {
      if (hasOpenIssue(gh, change.source)) {
        print(invocation, [`open already: ${change.source}`]);
        continue;
      }
      gh(['issue', 'create', ...issue.labels.flatMap((label) => ['--label', label]), '--title', issue.title, '--body', issue.body]);
      print(invocation, [`opened: ${issue.title} for ${change.source}`]);
    } catch {
      print(invocation, [`borrowed: couldn't open an issue for ${change.source}`], invocation.stderr);
      failed = true;
    }
  }
  print(invocation, [`borrowed: ${files.length} file(s), ${watch.changed.length} source(s) changed, ${watch.unreadable.length} unreadable`]);
  return failed ? 1 : 0;
}
