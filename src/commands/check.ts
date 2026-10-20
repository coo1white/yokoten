// `yokoten check`: the tree, --staged, --history, and in CI --pr and --issue. And
// `yokoten redact`, the privacy check's filter for command output (#390). And `yokoten marks`,
// the private marks from the command line: for now `allow`, which lets one mark through in the
// repo you are in, kept on this machine, never in the repo (#447); `allow --remove` is its way
// back (record 0014). Issue #434 adds more actions. A mark is never printed or repeated back.

import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ciRepo, readCodeOwners, readIssue, readPullRequest } from '../host/github.ts';
import { loadConfig } from '../rules/config.ts';
import { type Finding, formatFinding } from '../rules/message.ts';
import { addedLinesByFile, changedLines, checkIssueTitle, checkOwnedTier, checkPullRequest, isChangeFile, largeDiff, longSentenceNote, longSentences, splitForDependabot } from '../rules/pr.ts';
import { parseChange } from '../run/changelog.ts';
import { check, checkHistory, GitReadError, gitReadFinding, historyTimeZones, readGit, timeZoneNote } from '../run/check.ts';
import { isCodeFile, nameNotes } from '../run/names.ts';
import { type AllowEntry, isLink, loadMarks, machineAllowed, machineAllowFile, makeRedactor, matchingEntries, NO_HOME, readMachineAllow, repoKey } from '../rules/privacy.ts';
import { machineMarks, machineUserNames } from '../setup/install.ts';
import { args, bullets, env, parse, print, printJson, requireRoot, say, showOnPullRequest, usage } from './shared.ts';

export function runCheck(): number {
  const options = parse('check');
  if (typeof options === 'string') return usage(options);
  const modes = ['--staged', '--history', '--pr', '--issue'].filter((m) => options.flags.has(m));
  if (modes.length > 1) return usage(`${modes.join(' and ')} can't be used together`);
  const mode = modes[0]?.slice(2) ?? 'tree';
  const json = options.flags.has('--json');
  const root = requireRoot(process.cwd(), json ? (missing) => ({ check: mode, ok: false, findings: [missing], notes: [] }) : undefined);
  if (!root) return 1;
  const config = loadConfig(root);
  const name = `yokoten check${mode === 'pr' || mode === 'issue' ? ` --${mode}` : ''}`;
  const notes: Finding[] = [];
  let problems: Finding[];
  try {
    problems = runMode(mode, root, config, notes, { name, json });
  } catch (err) {
    // A git read the check depends on gave no answer (#403): one finding, and the check fails.
    if (!(err instanceof GitReadError)) throw err;
    problems = [gitReadFinding(err)];
  }
  if (problems === SKIPPED) return 0;
  if (json) printJson({ check: mode, ok: !problems.length, findings: problems, notes });
  else if (!problems.length) print([`${name}: ok${mode === 'history' ? ' (every commit on every branch)' : ''}`]);
  else print([`${name}: ${problems.length} problem(s)`, ...bullets(problems)], process.stderr);
  showOnPullRequest(`yokoten check${mode === 'tree' ? '' : ` --${mode}`}`, problems, notes, { json, isPlaceAFile: mode !== 'history' });
  return problems.length ? 1 : 0;
}

/** Returned by `runMode` when there is nothing to check; it has already said so. */
const SKIPPED: Finding[] = [];

/** The problems of one mode of `check`; its notes go into `notes`, and some are printed as they are found. */
function runMode(mode: string, root: string, config: ReturnType<typeof loadConfig>, notes: Finding[], { name, json }: { name: string; json: boolean }): Finding[] {
  let problems: Finding[];
  if (mode === 'issue') {
    const issue = readIssue(env);
    if (!issue) {
      const skipped = 'no issue in this run (it reads the CI event); nothing to check';
      if (json) printJson({ check: mode, ok: true, skipped, findings: [], notes: [] });
      else print([`${name}: ${skipped}`]);
      return SKIPPED;
    }
    // An event that can't be read is one finding (#267), so --json and the summary still work.
    problems = 'problem' in issue ? [issue.problem] : checkIssueTitle(issue.title, config, issue.labels);
  } else if (mode === 'pr') {
    const pr = readPullRequest(root, env);
    if (!pr) {
      const skipped = 'no pull request in this run (it reads the CI event); nothing to check';
      if (json) printJson({ check: mode, ok: true, skipped, findings: [], notes: [] });
      else print([`${name}: ${skipped}`]);
      return SKIPPED;
    }
    // An event or commits that can't be read are one finding (#267), never git's raw error.
    if ('problem' in pr) {
      problems = [pr.problem];
    } else {
      // The file as the pull request leaves it, or null when the pull request deletes it.
      // Any other file git can't show stops the check (#403): never read as deleted.
      const deleted = new Set(pr.deleted);
      const readAtHead = (file: string): string | null => (deleted.has(file) ? null : readGit(root, ['show', `${pr.head}:${file}`]).toString('utf8'));
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
      const diffArgs = ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${pr.base}...${pr.head}`];
      const added = codeFiles.length ? addedLinesByFile(readGit(root, diffArgs).toString('utf8')) : new Map<string, Set<number>>();
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
    problems = mode === 'history' ? checkHistory(root, { config, env, hostRepo: ciRepo(env) }) : check(root, { config, env, staged: mode === 'staged', notes, hostRepo: ciRepo(env) });
    // A translation behind its English source (#87) is a note, for the whole tree only.
    if (!json) for (const note of notes) print([`${name}: note: ${formatFinding(note)}`]);
    const zones = mode === 'history' && config.privacy.utc ? historyTimeZones(root) : 0;
    if (zones) {
      notes.push(timeZoneNote(zones));
      if (!json) print([`${name}: note: ${formatFinding(timeZoneNote(zones))}`]);
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

// ---- `yokoten marks` (#447) ----

const MARK_ACTIONS = ['allow'];
const SHAPE = '`yokoten marks allow <mark> --here`, or `yokoten marks allow --remove <mark> --here`';

/** One line on stderr, and exit 1. */
function refuse(text: string): number {
  print([`yokoten marks: ${text}`], process.stderr);
  return 1;
}

export function runMarks(): number {
  // After `--`, every word is a word, so a mark may start with `-`.
  const end = args.indexOf('--');
  const options = parse('marks', end === -1 ? args : args.slice(0, end));
  // The parser repeats the word it can't read; here it may be a mark, so it is never shown.
  if (typeof options === 'string') {
    return usage(options.startsWith('unknown option') ? `an unknown option; to give a mark that starts with -, put it after --, as in yokoten marks allow --here -- <mark>` : `too many words; give one mark, as in ${SHAPE}`);
  }
  const words = [...options.positional, ...(end === -1 ? [] : args.slice(end + 1))];
  if (words.length > 2) return usage(`too many words; give one mark, as in ${SHAPE}`);
  const [action, mark] = words;
  if (action === undefined) return usage(`say what to do: ${SHAPE}`);
  if (!MARK_ACTIONS.includes(action)) return usage(`the action is \`allow\`: ${SHAPE}`);
  if (mark === undefined || !mark.trim()) return usage(`give the mark: ${SHAPE}`);
  if (!options.flags.has('--here')) return usage(`add --here: an allow is always for one repo, the one you are in`);
  return allowHere(mark.trim().toLowerCase(), { isRemoving: options.flags.has('--remove') });
}

/** Past this age, a lock file is from a run that died, and is taken over. */
const STALE_LOCK_MS = 30_000;

/** Add the mark to this repo's entry in the machine allow file, or with `isRemoving`, take it out. */
function allowHere(mark: string, { isRemoving }: { isRemoving: boolean }): number {
  const root = requireRoot(process.cwd());
  if (!root) return 1;
  let file: string;
  let marks: string[];
  try {
    file = machineAllowFile(env);
    marks = loadMarks(env);
  } catch (err) {
    if ((err as Error).message === NO_HOME) return refuse(`${NO_HOME}. Set HOME to your home folder`);
    return refuse("your private-marks file can't be read, so nothing was changed");
  }
  // Only a mark the file holds: anything else is not private to this machine, so nothing to allow.
  if (!isRemoving && !marks.includes(mark)) return refuse('that is not a line of your private-marks file, so there is nothing to allow. Check the spelling, or add it to the file first');
  const key = repoKey(root);
  if ('none' in key) return refuse(`nothing was changed, because ${key.none}. The allow from this machine is for a repo with one; use "privacy.allow" in yokoten.json instead`);
  if ('unsure' in key) return refuse(`nothing was changed, because ${key.unsure}`);
  // A link to the file is kept: the file it points to is the one changed. A link to nothing is refused.
  let target = file;
  if (isLink(file)) {
    try {
      target = realpathSync(file);
    } catch {
      return refuse("nothing was changed, because this machine's allow file is a link to a file that is not there. Fix the link or remove it");
    }
  }
  const lock = `${target}.lock`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    return refuse("nothing was changed, because the allow file's folder can't be written");
  }
  const locked = takeLock(lock);
  if (locked !== 'taken') {
    return refuse(locked === 'busy' ? 'nothing was changed, because another `yokoten marks` is changing the allow file. Run this again' : "nothing was changed, because the allow file's folder can't be written");
  }
  try {
    // Read inside the lock, so a change another run made is kept.
    const read = readMachineAllow(env);
    if ('unsure' in read) return refuse(`nothing was changed, because ${read.unsure}. Fix it or delete it, then run this again`);
    const found = matchingEntries(read.entries, key);
    if (found.length > 1) return refuse("nothing was changed, because two entries in this machine's allow file match this repo. Delete one, then run this again");
    const entry = found[0];
    const has = entry?.allow.some((allowed) => allowed.toLowerCase() === mark) ?? false;
    let entries: AllowEntry[];
    if (isRemoving) {
      if (!entry || !has) {
        print(['yokoten marks: that mark is not allowed here, so nothing changed']);
        return 0;
      }
      const left = entry.allow.filter((allowed) => allowed.toLowerCase() !== mark);
      entries = left.length ? read.entries.map((one) => (one === entry ? { ...one, allow: left } : one)) : read.entries.filter((one) => one !== entry);
    } else {
      if (has) {
        print(['yokoten marks: that mark is already allowed here, so nothing changed']);
        return 0;
      }
      entries = entry ? read.entries.map((one) => (one === entry ? { ...one, allow: [...one.allow, mark] } : one)) : [...read.entries, { remote: key.remote, allow: [mark] }];
    }
    try {
      save(target, entries);
    } catch {
      return refuse("the allow file can't be written, so nothing was changed");
    }
    // Say what the file now says, never what was meant to happen.
    const now = machineAllowed(env, root);
    const isAllowed = now.allow.includes(mark);
    if (now.unsure || isAllowed === isRemoving) return refuse(`the allow file does not say what was asked; run \`yokoten doctor\` to see why`);
    print(
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
function save(file: string, entries: AllowEntry[]): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ repos: entries }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
