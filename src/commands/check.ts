// `yokoten check`: the tree, --staged, --history, and in CI --pr and --issue. `--pr <number>`
// reads one pull request through gh, for a repo without CI (#377). And
// `yokoten redact`, the privacy check's filter for command output (#390). And `yokoten marks`,
// the private marks from the command line: `allow`, which lets one mark through in the
// repo you are in, kept on this machine, never in the repo (#447); `allow --remove` is its way
// back (record 0014). Alone it counts the marks by kind; `add` and `remove` take one value
// from the terminal with no echo, or from stdin, so it never lands in the shell history;
// `off <kind>` and `on <kind>` stop and start install adding a kind, kept in machine.json
// (#434). A mark is never printed, logged or repeated back. Marks the owner added are never
// touched by `off`, `on` or install. And `yokoten test`, the tests run light on a shared
// machine (#461).

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { checkAnchors } from '../host/sigstore/anchor.ts';
import { findAnchor, workflowIdentity } from '../host/sigstore/rekor.ts';
import { readEventLog } from '../host/sigstore/record.ts';
import { cores, freeMemory, isLight, NICE_LEVEL, OFF_SWITCH, onPath, testCommand, testJobs } from '../host/light.ts';
import { readCurrentPullRequest, readsCurrentPullRequest } from '../host/current-pr.ts';
import { asText, botConfig, botEnv, borrowedHost, type Gh, ghIn, installationToken, isObject, OPEN_PULL_LIMIT, readApproverLogin, readCodeOwners, readIssue, readNumberedPullRequest, readOpenPulls, readPullRequest, readRepoLabelNames, repoOf } from '../host/github/index.ts';
import { type Env, loadConfig } from '../rules/config.ts';
import { finding, type Finding, formatFinding, isWarningFinding } from '../rules/message.ts';
import { addedLinesByFile, changedLines, checkIssueLabels, checkIssueTitle, checkOwnedTier, checkPullRequest, isChangeFile, largeDiff, longSentenceNote, longSentences, madeWithModelNote, parseMadeWith, parseProvenance, provenanceFindings, splitForDependabot } from '../rules/pr.ts';
import { BOARD_AGENT_FILE, parseBoardAgent, readBoardWorktrees } from './advice/board/agents.ts';
import { parseChange } from '../run/changelog.ts';
import { check, checkHistory, borrowedFiles, type BorrowedChange, GitReadError, gitReadFinding, type GitRun, historyTimeZones, indexFiles, readGit, syncPull, timeZoneNote, unstageHint, verifyMerge, watchBorrowed } from '../run/check/inspect.ts';
import { ruleChange, ruleChangeFindings } from '../run/check/loosen.ts';
import { readBranchDesks } from '../run/hook.ts';
import { isCodeFile, nameNotes } from '../run/notes/names.ts';
import { addedIgnores, type AllowEntry, hideHome, isLink, loadMarks, type Mark, marksFile, marksFiles, machineAllowed, machineAllowFile, makeRedactor, matchingEntries, NO_HOME, readMachineAllow, repoKey } from '../rules/privacy.ts';
import { addOwnMark, countMarkKinds, fillMarks, kindsTurnedOff, machineMarks, machineUserNames, paths, removeMarks, setKindOff, SWITCHED_KINDS } from '../setup/install.ts';
import { readOriginUrl } from '../setup/plan.ts';
import { bullets, type Invocation, parse, print, printJson, readInput, requireRoot, say, showOnPullRequest, usage } from './shared.ts';

/** How long `check --pr <number>` waits for gh. */
const GH_TIMEOUT_MS = 15000;

export async function runCheck(invocation: Invocation): Promise<number> {
  const options = parse('check', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const modes = ['--staged', '--history', '--pr', '--issue', '--anchor'].filter((m) => options.flags.has(m));
  if (modes.length > 1) return usage(invocation, `${modes.join(' and ')} can't be used together`);
  const mode = modes[0]?.slice(2) ?? 'tree';
  // A number goes with --pr only (#377): that pull request, read through gh.
  const number = options.positional[0];
  if (number !== undefined && mode !== 'pr') return usage(invocation, `unexpected argument ${number}: a number goes with --pr`);
  const json = options.flags.has('--json');
  const root = requireRoot(invocation, invocation.cwd, json ? (missing) => ({ check: mode, ok: false, findings: [missing], notes: [] }) : undefined);
  if (!root) return 1;
  const config = loadConfig(root);
  const name = `yokoten check${['pr', 'issue', 'anchor'].includes(mode) ? ` --${mode}` : ''}`;
  const notes: Finding[] = [];
  let problems: Finding[];
  try {
    problems = await runMode(invocation, mode, root, config, notes, { name, json, number, values: options.values });
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

/** The repo whose anchor workflow signed the entries: --repo, GITHUB_REPOSITORY, or origin. */
function anchorRepo(root: string, env: Invocation['env'], given?: string): string | undefined {
  const named = given ?? env.GITHUB_REPOSITORY;
  if (named) return /^[\w.-]+\/[\w.-]+$/.test(named) ? named : undefined;
  try {
    const url = readGit(root, ['config', '--get', 'remote.origin.url'], { env }).toString('utf8').trim().replace(/\.git$/, '');
    const found = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+)$/);
    return found ? `${found[1]}/${found[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/** The event log: `.git/yokoten/events.jsonl` under the repo's common git folder. */
function eventLogPath(root: string, env: Invocation['env']): string {
  const common = readGit(root, ['rev-parse', '--git-common-dir'], { env }).toString('utf8').trim();
  return resolve(root, common, 'yokoten', 'events.jsonl');
}

/**
 * `check --anchor`: each past UTC day of the event log against its Rekor entry. Only the
 * day's 64 hex characters go out; no line, path or name leaves the machine (#768).
 */
async function runAnchor(invocation: Invocation, root: string, notes: Finding[], values: Record<string, string>): Promise<Finding[]> {
  const { env } = invocation;
  let logPath: string;
  try {
    logPath = eventLogPath(root, env);
  } catch {
    return [finding('anchor', 'git cannot name the event log for this repo', 'run the check inside the repo')];
  }
  let text: string;
  try {
    // Read once, with no check first: another process may remove the log between the two.
    text = readFileSync(logPath, 'utf8');
  } catch (err) {
    // A log that is there but unreadable is not a missing log; let the caller see the error.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [finding('anchor', `there is no event log to check (${hideHome(logPath, env)} is not there)`, 'the hooks and runners write it; there is nothing to anchor before the first event')];
  }
  const repo = anchorRepo(root, env, values['--repo']);
  if (!repo) return [finding('anchor', 'the repo whose workflow signed the anchors is not known', 'pass --repo owner/name, or set GITHUB_REPOSITORY')];
  const log = readEventLog(text);
  const report = await checkAnchors(log, {
    today: new Date().toISOString().slice(0, 10),
    lookup: (hash) => findAnchor(hash, { identity: workflowIdentity(repo) }),
  });
  notes.push(...report.notes);
  return report.problems;
}

/** Returned by `runMode` when there is nothing to check; it has already said so. */
const SKIPPED: Finding[] = [];

/**
 * The agent that filed a status file in the checkout on `branch`, or null (#748). A desk
 * is a plain clone, so the list `yokoten desk` keeps supplies it too. No status file, or a
 * status file with no model, gives null: there is nothing to compare.
 */
function branchWorker(root: string, env: Invocation['env'], branch: string): { name: string; model: string } | null {
  const trees = readBoardWorktrees(root, env);
  if (typeof trees === 'string') return null;
  const tree = trees.find((one) => one.branch === branch);
  if (!tree) return null;
  try {
    const agent = parseBoardAgent(readFileSync(join(tree.path, BOARD_AGENT_FILE), 'utf8'), tree.path);
    return agent?.model ? { name: agent.name, model: agent.model } : null;
  } catch {
    return null;
  }
}

/** The problems of one mode of `check`; its notes go into `notes`, and some are printed as they are found. */
async function runMode(invocation: Invocation, mode: string, root: string, config: ReturnType<typeof loadConfig>, notes: Finding[], { name, json, number, values }: { name: string; json: boolean; number?: string; values: Record<string, string> }): Promise<Finding[]> {
  const { env } = invocation;
  let problems: Finding[];
  if (mode === 'anchor') {
    return runAnchor(invocation, root, notes, values);
  }
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
      // One diff with renames found, so a moved file is not noted as all new. Fixed
      // prefixes and plain paths, whatever the user's git settings say.
      const diffArgs = ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${pr.base}...${pr.head}`];
      const added = pr.files.length ? addedLinesByFile(readGit(root, diffArgs, { env }).toString('utf8')) : new Map<string, Set<number>>();
      // Plain English (record 0005): a long sentence on a line the pull request adds is a
      // note, never a failure. Old lines are left alone, as with names: a small change in a
      // long page must not bury the check's problems under notes about text it did not write.
      const long: Finding[] = [];
      for (const file of pr.files.filter((p) => /\.md$/i.test(p))) {
        const text = readAtHead(file);
        const lines = added.get(file) ?? new Set<number>();
        if (text !== null) for (const s of longSentences(text)) if (lines.has(s.line)) long.push(longSentenceNote(file, s));
      }
      notes.push(...long);
      printNotes(long, 'long sentence(s)');
      // Names (record 0006): hard-to-read names on the lines a pull request adds to code
      // are notes too. Old lines are left alone, so a project is not noted all at once.
      const names: Finding[] = [];
      const codeFiles = pr.files.filter(isCodeFile);
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
      // The `Made with` line names the model the worker ran (#748). The worker's own
      // checkout filed that model in its status file; when the two disagree, the line
      // names the wrong vendor's model, and the note says so. Never a failure.
      const worker = pr.branch ? branchWorker(root, env, pr.branch) : null;
      const modelNote = worker ? madeWithModelNote(pr.body, worker.model, pr.branch) : null;
      if (modelNote) {
        notes.push(modelNote);
        if (!json) print(invocation, [`${name}: note: ${formatFinding(modelNote)}`]);
      }
      problems = checkPullRequest(pr, config);
      // Provenance (#756): the line names each desk that worked on the branch, and a
      // reviewer comes from another vendor. Only status files here can say what ran.
      problems.push(...provenanceFindings(parseMadeWith(pr.body)?.roles ?? null, readBranchDesks(root, env, pr.branch)));
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
      // Record 0026: the machine says whether the rules got looser. A looser change or a
      // hard line fails, for Dependabot too. A stricter change is a note.
      const rules = ruleChange(root, pr.base, pr.head, env);
      const found = ruleChangeFindings(rules);
      if (rules.verdict === 'stricter-or-neutral') {
        notes.push(...found);
        printNotes(found, 'stricter rule(s)');
      } else problems.push(...found);
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

/** One commit's message, as `git log` gives it: the id and the whole body (#756). */
interface CommitMessage {
  commit: string;
  message: string;
}

/** The commits `ref` names, oldest first, with their messages. A range names its own commits. */
function readCommitMessages(root: string, env: Invocation['env'], ref: string): CommitMessage[] {
  // A range names its own commits. Any other ref is one commit, not all of its history.
  const range = ref.includes('..');
  const text = readGit(root, ['log', ...(range ? [] : ['-1']), '--no-color', '--format=%H%x00%B%x00%x00', '--end-of-options', ref, '--'], { env }).toString('utf8');
  return text
    .split('\0\0')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const clean = chunk.replace(/^\n+/, '');
      const split = clean.indexOf('\0');
      return split === -1 ? { commit: clean.trim(), message: '' } : { commit: clean.slice(0, split).trim(), message: clean.slice(split + 1) };
    })
    .filter((commit) => commit.commit !== '');
}

/** The agents a provenance line names, as `vendor (model)`, or `none`. */
const agentsText = (agents: { vendor: string; model: string }[]): string => (agents.length ? agents.map((agent) => `${agent.vendor} (${agent.model})`).join(', ') : 'none');

/**
 * `yokoten provenance <ref>` (#756): for a commit or a range, the writer, reviewers,
 * approver, tier and issue that the squashed message and the host's reviews record.
 * The approver is the latest Approve on the pull request the subject names; gh that
 * can't answer leaves it unknown, never an error.
 */
export async function runProvenance(invocation: Invocation): Promise<number> {
  const options = parse('provenance', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const ref = options.positional[0];
  if (!ref) return usage(invocation, 'give a commit or a range, such as `HEAD` or `main~3..main`');
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const json = options.flags.has('--json');
  let records: ReturnType<typeof parseProvenance>[];
  try {
    records = readCommitMessages(root, invocation.env, ref).map(({ commit, message }) => parseProvenance(commit, message));
  } catch (err) {
    if (!(err instanceof GitReadError)) throw err;
    const problem = gitReadFinding(err);
    if (json) printJson(invocation, { command: 'provenance', ok: false, findings: [problem] });
    else print(invocation, [`yokoten provenance: ${formatFinding(problem)}`], invocation.stderr);
    return 1;
  }
  if (!records.length) {
    if (json) printJson(invocation, []);
    else print(invocation, [`yokoten provenance: no commit in ${ref}`]);
    return 0;
  }
  const gh = ghIn(root, invocation.env, GH_TIMEOUT_MS);
  const approvers = new Map<string, string>();
  const approverOf = (subject: string): string => {
    const number = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
    if (!number) return '';
    if (!approvers.has(number)) approvers.set(number, readApproverLogin(gh, Number(number)));
    return approvers.get(number) ?? '';
  };
  const rows = records.map((record) => ({ ...record, approver: approverOf(record.subject) }));
  if (json) {
    printJson(invocation, rows.map((row) => ({ commit: row.commit, subject: row.subject, writers: row.writers, reviewers: row.reviewers, approver: row.approver || null, tier: row.tier, issues: row.issues })));
    return 0;
  }
  const lines: string[] = [];
  for (const row of rows) {
    if (lines.length) lines.push('');
    lines.push(`${row.commit.slice(0, 7)} ${row.subject}`);
    lines.push(`  writer: ${agentsText(row.writers)}`);
    lines.push(`  reviewers: ${agentsText(row.reviewers)}`);
    lines.push(`  approver: ${row.approver || 'unknown'}`);
    lines.push(`  tier: ${row.tier ?? 'none'}`);
    lines.push(`  issue: ${row.issues.length ? row.issues.map((issue) => `#${issue}`).join(', ') : 'none'}`);
  }
  print(invocation, lines);
  return 0;
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

// ---- `yokoten test` (#461) ----

/**
 * `yokoten test`: Node's test runner, light on a shared machine. Words after `--` go to the
 * runner as they are. `YOKOTEN_LIGHT_TESTS=0` or `--heavy` turns the light run off.
 */
export function runTest(invocation: Invocation): number {
  const { args, env } = invocation;
  // Everything after `--` is for the test runner, unchanged.
  const end = args.indexOf('--');
  const options = parse('test', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(invocation, options);
  const light = isLight(env) && !options.flags.has('--heavy');
  const free = freeMemory();
  const jobs = testJobs(cores(), free);
  const hasNice = process.platform !== 'win32' && onPath('nice', env);
  const command = testCommand(end === -1 ? [] : args.slice(end + 1), { light, jobs, hasNice });
  if (options.flags.has('--print')) {
    const shown = [command.file, ...command.args].map((word) => (word === process.execPath ? 'node' : word)).join(' ');
    const why = light ? `light: ${jobs} at once (${cores()} cores, ${(free / 1024 ** 3).toFixed(1)} GB free)${hasNice ? `, nice ${NICE_LEVEL}` : ', no nice here'}; ${OFF_SWITCH}=0 or --heavy turns it off` : 'the light run is off';
    print(invocation, [shown, why]);
    return 0;
  }
  const result = spawnSync(command.file, command.args, { stdio: 'inherit', windowsHide: true });
  if (result.error) {
    print(invocation, [`yokoten test: can't run the tests: ${result.error.message}`], invocation.stderr);
    return 1;
  }
  return result.status ?? 1;
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

// ---- Actions health (#647) ----
//
// `yokoten ci-health` reads the last 200 Actions runs and the checks of the open pull
// requests through gh, then writes one Markdown report to one issue, `CI health`, which
// it creates and pins on the first run. A scheduled workflow updates it in place. The
// report says what is red and why: a failed run on main, a failed or cancelled check on
// an open pull request, a slow workflow, a long wait, or a workflow and branch that both
// passed and failed in the window. The branch a merge lands on is the repo's default.

/** How long one gh read may take before the command stops waiting. */
const CI_HEALTH_TIMEOUT = 30000;
/** The title of the one issue the report lives in. The report body starts with its marker. */
const CI_HEALTH_ISSUE = 'CI health';
/** How many runs one report reads: two pages of 100. */
const CI_HEALTH_RUNS = 200;

/** The conclusions that mean a run failed. A cancelled run is counted apart: it is not a failure. */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
/** The conclusions that keep a check green. A cancelled check is not here: it shows as a red x. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
/** The conclusions of a completed run. */
const COMPLETED_STATUS = 'completed';

/** One Actions run, as the report needs it. Times are GitHub's own ISO stamps. */
export interface HealthRun {
  id: number;
  workflow: string;
  event: string;
  branch: string;
  status: string;
  conclusion: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  url: string;
}

/** One workflow over the window: how often it ran, failed, was cancelled, and how long it took and waited. */
export interface WorkflowHealth {
  workflow: string;
  runs: number;
  failed: number;
  cancelled: number;
  /** Middle run time in milliseconds, or null when no run gave both stamps. */
  medianRunTime: number | null;
  /** Middle wait before the run started, in milliseconds, or null. */
  medianWaitTime: number | null;
}

/** One failed or cancelled check on an open pull request. */
export interface PullCheckProblem {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  check: string;
  conclusion: string;
}

/** A workflow and branch that both passed and failed in the window: a sign of flakiness or of work in progress. */
export interface UnstableWorkflow {
  workflow: string;
  branch: string;
  passes: number;
  failures: number;
}

/** Everything the report shows. */
export interface ActionsHealth {
  /** The branch a merge lands on: `main` unless the repo says otherwise. */
  defaultBranch: string;
  runs: HealthRun[];
  workflows: WorkflowHealth[];
  mainFailures: HealthRun[];
  mainCancelled: HealthRun[];
  pullProblems: PullCheckProblem[];
  slowest: HealthRun[];
  unstable: UnstableWorkflow[];
}

/** The repo's default branch, or `main` when gh can't say. */
export function readDefaultBranch(gh: Gh, repo: string): string {
  try {
    return gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim() || 'main';
  } catch {
    return 'main';
  }
}

/** One row of the Actions run list as a run, or null when it has no usable id. */
function parseHealthRun(value: unknown): HealthRun | null {
  if (!isObject(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) return null;
  return {
    id: value.id,
    workflow: asText(value.name),
    event: asText(value.event),
    branch: asText(value.head_branch),
    status: asText(value.status),
    conclusion: asText(value.conclusion),
    createdAt: asText(value.created_at),
    startedAt: asText(value.run_started_at),
    updatedAt: asText(value.updated_at),
    url: asText(value.html_url),
  };
}

/** Why a gh read failed, in words a beginner can act on. */
function healthReadFailed(err: unknown, what: string): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
  const said = String((err as { stderr?: string }).stderr || '')
    .split('\n')[0]
    .trim();
  return `gh can't read the ${what}${said ? ` (${said})` : ''}: run \`gh auth login\`, and check the repo`;
}

/** The last `max` Actions runs of `repo`, newest first, or why gh can't read them. */
export function readActionsRuns(gh: Gh, repo: string, max: number = CI_HEALTH_RUNS): HealthRun[] | string {
  const pages = Math.ceil(max / 100);
  const runs: HealthRun[] = [];
  try {
    for (let page = 1; page <= pages; page++) {
      const raw: unknown = JSON.parse(gh(['api', `repos/${repo}/actions/runs?per_page=100&page=${page}`]));
      if (!isObject(raw) || !Array.isArray(raw.workflow_runs)) return 'gh gave no Actions run list: run it again';
      for (const row of raw.workflow_runs) {
        const run = parseHealthRun(row);
        if (run) runs.push(run);
      }
      if (raw.workflow_runs.length < 100) break;
    }
  } catch (err) {
    return healthReadFailed(err, 'Actions runs');
  }
  runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return runs.slice(0, max);
}

/** One check's time: completedAt, startedAt, or createdAt when it has neither. NaN when no stamp parses. */
function checkTime(entry: Record<string, unknown>): number {
  for (const key of ['completedAt', 'startedAt', 'createdAt']) {
    const time = Date.parse(asText(entry[key]));
    if (!Number.isNaN(time)) return time;
  }
  return NaN;
}

/**
 * The latest run of each check on one pull request. A later green run clears an old red
 * one. A check with no name stands alone. A dateless run never beats a dated one.
 */
function latestChecks(entries: unknown[]): Record<string, unknown>[] {
  const byName = new Map<string, Record<string, unknown>>();
  const nameless: Record<string, unknown>[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const name = asText(entry.name) || asText(entry.context);
    if (!name) {
      nameless.push(entry);
      continue;
    }
    const seen = byName.get(name);
    if (seen === undefined) {
      byName.set(name, entry);
      continue;
    }
    const seenTime = checkTime(seen);
    const entryTime = checkTime(entry);
    if (Number.isNaN(entryTime)) continue;
    if (Number.isNaN(seenTime) || entryTime > seenTime) byName.set(name, entry);
  }
  return [...byName.values(), ...nameless];
}

/** A check's conclusion: a check run's conclusion, or a commit status's state. Lower case, or ''. */
const checkConclusion = (entry: Record<string, unknown>): string => (asText(entry.conclusion) || asText(entry.state)).toLowerCase();

/** True when a check is done. A commit status says PENDING until it is not. */
const checkIsDone = (entry: Record<string, unknown>): boolean => asText(entry.status) === 'COMPLETED' || (asText(entry.state) !== '' && asText(entry.state) !== 'PENDING');

/** The failed or cancelled checks of the open pull requests, or why gh can't read them. */
export function readHealthPullChecks(gh: Gh, repo: string): PullCheckProblem[] | string {
  const query = ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url,isDraft,statusCheckRollup'];
  let rows: unknown;
  try {
    rows = JSON.parse(gh(query));
  } catch (err) {
    return healthReadFailed(err, 'open pull requests');
  }
  if (!Array.isArray(rows)) return 'gh gave no pull request list: run it again';
  const problems: PullCheckProblem[] = [];
  for (const row of rows) {
    if (!isObject(row) || typeof row.number !== 'number' || !Number.isSafeInteger(row.number)) continue;
    const rollup = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : [];
    for (const entry of latestChecks(rollup)) {
      if (!checkIsDone(entry)) continue;
      const conclusion = checkConclusion(entry);
      if (PASSING_CONCLUSIONS.has(conclusion)) continue;
      const check = asText(entry.name) || asText(entry.context) || 'check';
      problems.push({
        number: row.number,
        title: asText(row.title),
        url: asText(row.url),
        isDraft: row.isDraft === true,
        check,
        conclusion: conclusion || 'no conclusion',
      });
    }
  }
  return problems;
}

/** The time between two stamps in milliseconds, or NaN when one does not parse. */
function timeBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isNaN(start) || Number.isNaN(end) ? NaN : end - start;
}

/** The middle of a list of numbers, rounded, or null when it is empty. */
function medianNumber(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** The workflows over the window, the ones with the most failed or cancelled runs first. */
function summarizeWorkflows(runs: HealthRun[]): WorkflowHealth[] {
  const groups = new Map<string, HealthRun[]>();
  for (const run of runs) {
    if (!run.workflow) continue;
    const group = groups.get(run.workflow);
    if (group) group.push(run);
    else groups.set(run.workflow, [run]);
  }
  const health = [...groups].map(([workflow, rows]) => {
    const completed = rows.filter((run) => run.status === COMPLETED_STATUS);
    return {
      workflow,
      runs: rows.length,
      failed: rows.filter((run) => FAILED_CONCLUSIONS.has(run.conclusion)).length,
      cancelled: rows.filter((run) => run.conclusion === 'cancelled').length,
      medianRunTime: medianNumber(completed.map((run) => timeBetween(run.startedAt, run.updatedAt)).filter(Number.isFinite)),
      medianWaitTime: medianNumber(completed.map((run) => timeBetween(run.createdAt, run.startedAt)).filter(Number.isFinite)),
    };
  });
  return health.sort((a, b) => b.failed + b.cancelled - (a.failed + a.cancelled) || b.runs - a.runs || a.workflow.localeCompare(b.workflow));
}

/** The workflow and branch pairs that both passed and failed in the window, the most failures first. */
function findUnstable(runs: HealthRun[]): UnstableWorkflow[] {
  const groups = new Map<string, UnstableWorkflow>();
  for (const run of runs) {
    if (run.status !== COMPLETED_STATUS || !run.branch) continue;
    const passed = run.conclusion === 'success';
    const failed = FAILED_CONCLUSIONS.has(run.conclusion);
    if (!passed && !failed) continue;
    const key = `${run.workflow}\n${run.branch}`;
    const seen = groups.get(key);
    if (seen) {
      if (passed) seen.passes++;
      else seen.failures++;
    } else groups.set(key, { workflow: run.workflow, branch: run.branch, passes: passed ? 1 : 0, failures: failed ? 1 : 0 });
  }
  return [...groups.values()]
    .filter((group) => group.passes > 0 && group.failures > 0)
    .sort((a, b) => b.failures - a.failures || b.passes - a.passes)
    .slice(0, 5);
}

/** What the runs and pull request checks add up to. */
export function summarizeActionsHealth(runs: HealthRun[], pullProblems: PullCheckProblem[], defaultBranch = 'main'): ActionsHealth {
  const completed = runs.filter((run) => run.status === COMPLETED_STATUS && Number.isFinite(timeBetween(run.startedAt, run.updatedAt)));
  return {
    defaultBranch,
    runs,
    workflows: summarizeWorkflows(runs),
    mainFailures: runs.filter((run) => run.branch === defaultBranch && FAILED_CONCLUSIONS.has(run.conclusion)),
    mainCancelled: runs.filter((run) => run.branch === defaultBranch && run.conclusion === 'cancelled'),
    pullProblems,
    slowest: [...completed].sort((a, b) => timeBetween(b.startedAt, b.updatedAt) - timeBetween(a.startedAt, a.updatedAt)).slice(0, 5),
    unstable: findUnstable(runs),
  };
}

/** A time in minutes, or seconds below one minute. */
function minutesText(milliseconds: number | null): string {
  if (milliseconds === null) return '—';
  return milliseconds < 60000 ? `${Math.round(milliseconds / 1000)} s` : `${(milliseconds / 60000).toFixed(1)} min`;
}

/** An ISO stamp as `YYYY-MM-DD HH:MM UTC`. A stamp that does not parse comes through as it is. */
function utcText(stamp: string): string {
  const time = Date.parse(stamp);
  return Number.isNaN(time) ? stamp : `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A table cell: no pipe, one line. The text comes from GitHub, so the work stays linear:
 * each line is trimmed and joined, and no pattern scans a whitespace run twice.
 * A backslash is escaped first, or `a\|b` would close the cell.
 */
const cellText = (text: string): string =>
  text
    .replace(/[\\|]/g, '\\$&')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

/** The run as one line: workflow, event, branch, conclusion, time, link. */
function runLine(run: HealthRun): string {
  const where = run.branch ? ` on \`${run.branch}\`` : '';
  const link = run.url ? ` — <${run.url}>` : '';
  return `- \`${run.workflow}\` (${run.event})${where}: **${run.conclusion}** at ${utcText(run.updatedAt)}${link}`;
}

/** The Markdown body of the `CI health` issue. */
export function renderActionsHealth(health: ActionsHealth, { repo, now }: { repo: string; now: Date }): string {
  const { runs, mainFailures, mainCancelled, pullProblems } = health;
  const main = health.defaultBranch;
  const problems = mainFailures.length + mainCancelled.length + pullProblems.length;
  const lines = [
    '<!-- yokoten:ci-health -->',
    '',
    '# CI health',
    '',
    `_Updated ${utcText(now.toISOString())}. Reads the last ${runs.length} Actions runs of \`${repo}\` and the checks of its open pull requests. This issue is updated in place; pin it to keep it in view._`,
    '',
  ];
  if (!runs.length) {
    lines.push('No Actions runs in this window. Check that CI is on for this repo.');
    return `${lines.join('\n')}\n`;
  }
  const oldest = runs.reduce((earliest, run) => (Date.parse(run.createdAt) < Date.parse(earliest.createdAt) ? run : earliest), runs[0]);
  lines.push(`Window: ${utcText(oldest.createdAt)} to ${utcText(now.toISOString())}. Newest run first.`, '');
  lines.push(
    problems
      ? `**${problems} problem${problems === 1 ? ' needs' : 's need'} a look:** ${mainFailures.length} failed on \`${main}\`, ${mainCancelled.length} cancelled on \`${main}\`, ${pullProblems.length} failed or cancelled on open pull requests.`
      : `**No failed or cancelled run on \`${main}\`, and no failed or cancelled check on an open pull request.**`,
    '',
  );

  lines.push('## Main', '');
  if (!mainFailures.length && !mainCancelled.length) lines.push(`No failed or cancelled run on \`${main}\` in this window.`);
  else for (const run of [...mainFailures, ...mainCancelled]) lines.push(runLine(run));
  lines.push('');

  lines.push('## Open pull requests', '');
  if (!pullProblems.length) lines.push('Every check on every open pull request passed, or is still running.');
  else {
    lines.push('| Pull request | Check | Result |', '| --- | --- | --- |');
    for (const problem of pullProblems) {
      const pr = `[#${problem.number} ${cellText(problem.title)}](${problem.url || '#'})${problem.isDraft ? ' (draft)' : ''}`;
      lines.push(`| ${pr} | ${cellText(problem.check)} | ${cellText(problem.conclusion)} |`);
    }
  }
  lines.push('');

  lines.push('## Workflows', '');
  const shown = health.workflows.slice(0, 12);
  if (!shown.length) lines.push('No workflow gave its name in the window.');
  else {
    lines.push('| Workflow | Runs | Failed | Cancelled | Median run | Median wait |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const workflow of shown) {
      lines.push(
        `| ${cellText(workflow.workflow)} | ${workflow.runs} | ${workflow.failed} | ${workflow.cancelled} | ${minutesText(workflow.medianRunTime)} | ${minutesText(workflow.medianWaitTime)} |`,
      );
    }
    if (health.workflows.length > shown.length) lines.push('', `${health.workflows.length - shown.length} more workflow(s) ran in this window.`);
  }
  lines.push('', '_Wait is the time a run spent queued before it started._', '');

  lines.push('## Slowest runs', '');
  if (!health.slowest.length) lines.push('No completed run gave a time.');
  else for (const run of health.slowest) lines.push(`- ${minutesText(timeBetween(run.startedAt, run.updatedAt))}: \`${run.workflow}\`${run.branch ? ` on \`${run.branch}\`` : ''}${run.url ? ` — <${run.url}>` : ''}`);
  lines.push('');

  lines.push('## What passed and failed on one branch', '');
  if (!health.unstable.length) lines.push('None: every workflow and branch either always passed or never did in this window.');
  else for (const group of health.unstable) lines.push(`- \`${group.workflow}\` on \`${group.branch}\`: ${group.passes} passed, ${group.failures} failed`);
  lines.push('');

  lines.push('## What this counts', '');
  lines.push(
    '- A run that is still queued or running is not a problem yet; only its latest check counts.',
    '- A cancelled run is listed apart from a failure. It still shows as a red x, so it is worth removing at its cause.',
    '- A rerun that passes clears an old failure on the same check name.',
    '- The window is the last 200 runs GitHub returned, newest first, not a fixed clock.',
  );
  return `${lines.join('\n')}\n`;
}

/** One posted report: the issue, whether this run made it, and whether it could be pinned. */
export interface PostedHealth {
  number: number;
  created: boolean;
  pinned: boolean;
}

/** The number of the open `CI health` issue, 0 when there is none, or why gh can't read the list. */
function findHealthIssue(gh: Gh, repo: string): number | string {
  try {
    const rows: unknown = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--search', `"${CI_HEALTH_ISSUE}" in:title`, '--json', 'number,title']));
    if (!Array.isArray(rows)) return 'gh gave no issue list: run it again';
    for (const row of rows) if (isObject(row) && asText(row.title) === CI_HEALTH_ISSUE && typeof row.number === 'number') return row.number;
    return 0;
  } catch (err) {
    return healthReadFailed(err, 'issue list');
  }
}

/** Create or update the one report issue, through a temporary body file, then pin it. */
export function postHealthIssue(gh: Gh, repo: string, body: string): PostedHealth | string {
  const found = findHealthIssue(gh, repo);
  if (typeof found === 'string') return found;
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-ci-health-'));
  const file = join(dir, 'body.md');
  try {
    writeFileSync(file, body, { mode: 0o600 });
    let number = found;
    let created = false;
    if (number) gh(['issue', 'edit', String(number), '--repo', repo, '--body-file', file]);
    else {
      const url = gh(['issue', 'create', '--repo', repo, '--title', CI_HEALTH_ISSUE, '--body-file', file]).trim();
      const match = url.match(/\/(\d+)\/?$/);
      if (!match) return `gh made an issue but gave no number (${url}): run the command again`;
      number = Number(match[1]);
      created = true;
    }
    let pinned = false;
    try {
      gh(['issue', 'pin', String(number), '--repo', repo]);
      pinned = true;
    } catch {
      // An older gh has no `issue pin`, or the token may not pin: the report still stands.
    }
    return { number, created, pinned };
  } catch (err) {
    return healthReadFailed(err, 'report issue');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `yokoten ci-health`: read Actions health, and post it to one pinned issue or print it. */
export function runCiHealth(invocation: Invocation): number {
  const options = parse('ci-health', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const { env } = invocation;
  const stated = options.values['--repo'] || env.GITHUB_REPOSITORY || '';
  const repo = stated || repoOf(readOriginUrl(root, env)) || '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    print(invocation, ['yokoten ci-health: no GitHub repo. Pass --repo owner/name, set GITHUB_REPOSITORY, or add an origin remote.'], invocation.stderr);
    return 1;
  }
  const gh = ghIn(root, env, CI_HEALTH_TIMEOUT);
  const defaultBranch = readDefaultBranch(gh, repo);
  const runs = readActionsRuns(gh, repo);
  if (typeof runs === 'string') {
    print(invocation, [`yokoten ci-health: ${runs}`], invocation.stderr);
    return 1;
  }
  const pulls = readHealthPullChecks(gh, repo);
  const health = summarizeActionsHealth(runs, typeof pulls === 'string' ? [] : pulls, defaultBranch);
  let body = renderActionsHealth(health, { repo, now: new Date() });
  if (typeof pulls === 'string') body += `\n> The open pull request checks were not read: ${pulls}\n`;
  const problems = health.mainFailures.length + health.mainCancelled.length + health.pullProblems.length;
  if (options.flags.has('--dry-run')) {
    print(invocation, body.split('\n'));
    return 0;
  }
  const posted = postHealthIssue(gh, repo, body);
  if (typeof posted === 'string') {
    print(invocation, [`yokoten ci-health: ${posted}`], invocation.stderr);
    return 1;
  }
  print(invocation, [
    `yokoten ci-health: ${posted.created ? 'opened' : 'updated'} issue #${posted.number} in ${repo}${posted.pinned ? '' : ' (not pinned: pin it once by hand)'}`,
    `${problems} problem(s) in the last ${runs.length} runs.`,
  ]);
  return 0;
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

/**
 * Whether an open issue already names this source, so a later run opens no second one.
 * An answer that is not a list throws: it is a gap, not "none open", so the run stops
 * instead of opening a duplicate.
 */
export function hasOpenIssue(gh: Gh, source: string): boolean {
  const text = gh(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body']);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('gh did not give an issue list');
  }
  if (!Array.isArray(json)) throw new Error('gh did not give an issue list');
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      print(invocation, [`borrowed: couldn't open an issue for ${change.source}: ${reason}`], invocation.stderr);
      failed = true;
    }
  }
  print(invocation, [`borrowed: ${files.length} file(s), ${watch.changed.length} source(s) changed, ${watch.unreadable.length} unreadable`]);
  return failed ? 1 : 0;
}
// ---- `yokoten pr sync` (#432) ----
//
// The lead runs this after every merge. Each open pull request whose branch is behind its
// base gets the base merged in, the two mechanical conflicts resolved, typecheck and the
// touched tests run, and the branch pushed as the bot. Anything else stops with the files,
// the hunks and a dispatch brief. It never force-pushes, rebases or edits on GitHub.

/** How long one git or gh call in the sync may take. */
const PR_SYNC_TIMEOUT_MS = 120_000;

/** The environment for every git call of the sync: no prompt, and UTC commit times (#809). */
export function prSyncEnv(env: Env): Env {
  return { ...env, GIT_TERMINAL_PROMPT: '0', TZ: 'UTC' };
}

/** One open pull request's branches, as `gh pr list` gives them. */
export async function runPr(invocation: Invocation): Promise<number> {
  const options = parse('pr', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const action = options.positional[0];
  if (action !== 'sync') {
    return usage(invocation, action === undefined ? 'give the action: `yokoten pr sync`' : `"${action}" is not an action of pr; the one action is sync`);
  }
  const { env, cwd } = invocation;
  const root = requireRoot(invocation, cwd);
  if (!root) return 1;

  let remote = '';
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env: prSyncEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Reported below, with the same words whatever git said.
  }
  const repo = repoOf(remote);
  if (!repo) {
    print(invocation, ['yokoten pr sync: the origin remote is not a GitHub repo, so there is nothing to list'], invocation.stderr);
    return 1;
  }

  let open: ReturnType<typeof readOpenPulls>;
  try {
    open = readOpenPulls(ghIn(root, env, GH_TIMEOUT_MS), repo);
  } catch (err) {
    print(invocation, [`yokoten pr sync: gh could not list the open pull requests: ${(err as Error).message.split('\n')[0]}`], invocation.stderr);
    return 1;
  }
  if (typeof open === 'string') {
    print(invocation, [`yokoten pr sync: ${open}`], invocation.stderr);
    return 1;
  }
  if (open.isCut) {
    print(invocation, [`yokoten pr sync: the open pull request list stops at ${OPEN_PULL_LIMIT}, so some pull requests are not synced`]);
  }
  if (!open.pulls.length) {
    print(invocation, ['yokoten pr sync: no open pull requests']);
    return 0;
  }

  // The branches and base branches must be here before any merge. One fetch is enough.
  const fetched = spawnSync('git', ['fetch', '--prune', 'origin'], { cwd: root, env: prSyncEnv(env), encoding: 'utf8', timeout: PR_SYNC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (fetched.status !== 0) {
    print(invocation, [`yokoten pr sync: git fetch origin failed: ${String(fetched.stderr || fetched.stdout).trim().split('\n')[0]}`], invocation.stderr);
    return 1;
  }

  const git = (args: string[], worktree: string): GitRun => {
    const result = spawnSync('git', ['--no-replace-objects', ...args], {
      cwd: worktree,
      env: prSyncEnv(env),
      encoding: 'utf8',
      timeout: PR_SYNC_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  // The token is asked for once, and only when a branch is ready to push.
  let token: Promise<string> | null = null;
  const push = async (worktree: string, branch: string): Promise<{ ok: boolean; said: string }> => {
    try {
      token ??= (async () => {
        const config = botConfig(env);
        if (typeof config === 'string') throw new Error(config);
        return installationToken(config, repo);
      })();
      const value = await token;
      const pushed = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], {
        cwd: worktree,
        env: botEnv(env, value),
        encoding: 'utf8',
        timeout: PR_SYNC_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (pushed.error) return { ok: false, said: pushed.error.message.split('\n')[0] };
      return { ok: pushed.status === 0, said: String(pushed.stderr || pushed.stdout).trim().split('\n').slice(-1)[0] ?? '' };
    } catch (err) {
      return { ok: false, said: (err as Error).message.split('\n')[0] };
    }
  };

  let needsAgent = false;
  for (const pull of open.pulls) {
    if (pull.isFork) {
      print(invocation, [`#${pull.number} ${pull.branch}: needs an agent (the branch is in a fork, which yokoten does not push)`]);
      needsAgent = true;
      continue;
    }
    const outcome = await syncPull({
      root,
      number: pull.number,
      branch: pull.branch,
      base: pull.base,
      git,
      push,
      verify: (worktree, files) => verifyMerge(worktree, files, env),
      tempRoot: join(root, '.tmp', 'yokoten-pr-sync'),
    });
    print(invocation, [pullLine({ ...outcome, base: pull.base })]);
    if (outcome.files?.length) print(invocation, ['', 'Files:', ...outcome.files.map((file) => `- ${file}`)]);
    if (outcome.hunksText?.length) print(invocation, ['', 'Conflict hunks:', ...outcome.hunksText.flatMap((hunk) => hunk.split('\n'))]);
    if (outcome.brief) print(invocation, ['', 'Dispatch brief:', ...outcome.brief.split('\n')]);
    if (outcome.state === 'needs-agent') needsAgent = true;
  }
  return needsAgent ? 1 : 0;
}

/** The one line a pull request gets in the sync's report, naming the base it merged. */
export function pullLine(outcome: { number: number; branch: string; base: string; state: string; hunks?: number }): string {
  const head = `#${outcome.number} ${outcome.branch}: `;
  if (outcome.state === 'up-to-date') return `${head}up to date with ${outcome.base}`;
  if (outcome.state === 'merged') return `${head}merged ${outcome.base}`;
  if (outcome.state === 'resolved') return `${head}resolved ${outcome.hunks ?? 0} hunk${outcome.hunks === 1 ? '' : 's'} then merged ${outcome.base}`;
  return `${head}needs an agent`;
}
