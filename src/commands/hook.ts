// `yokoten hook`: the tool-call guard, and with --stop the end-of-turn check.

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import type { DropReason, SortedEnv } from '../agents/desk/agent-env.ts';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import { ADAPTERS, adapterFor, askOf, contextOf, releaseFixOf, rewriteOf, stopReaderOf } from '../agents/runtimes/runtime.ts';
import { type Env, loadConfig } from '../rules/config.ts';
import { addWorkerPath, findHeavyJob, gitLinkAbove, hardenRead, markNote, printsAccount, privateOutput, realPath, removeWorkerPath, stopsFile, stopsOffFile, withWorkerMark, WORKER_MARK, workerMarkAt, workerRole, wrapForRedact } from '../rules/guards.ts';
import { type Finding, finding, formatFinding, formatRefusal, notRepoFinding } from '../rules/message.ts';
import { hideHome } from '../rules/privacy.ts';
import { checkChanged, readGit } from '../run/check.ts';
import { formatSpace, HOST_DISK_FIX, HOST_DRIVE, isLowOnSpace, readKeptHostDisk } from '../setup/doctor/host-disk.ts';
import {
  type Action,
  type Anchor,
  type AnchorOutcome,
  bumpDoneTries,
  bumpRepeat,
  canKeepStatus,
  changeAgentStatus,
  clearDoneTries,
  clearRefusedMarker,
  clearRepeats,
  commandShape,
  describeAction,
  DONE_TRY_LIMIT,
  doneTryKey,
  findStatusCheckout,
  listAnchors,
  recordAnchor,
  registerDesk,
  type Guard,
  guardDeadline,
  judgeWithDeadline,
  loadHookConfig,
  logStop,
  noteRefused,
  readDoneWhen,
  type Repo,
  repeatKeyOf,
  repeatStopFinding,
  REPEAT_STOP_LIMIT,
  runDoneWhen,
  sessionIdOf,
  startFields,
  STATUS_EVERY_MS,
  stopsState,
  type StopAnswer,
  type StopEvent,
  wasRefusedRecently,
  writeAgentChecks,
} from '../run/hook.ts';
import { bullets, type Invocation, type Output, parse, print, printJson, readInput, rootOf, say, usage } from './shared.ts';

// Each runtime sends its tool call in its own shape; its adapter turns it into an Action.
// The table below asks the adapters' contract (#395), never a runtime's name.
export const READERS: Record<string, (input: unknown) => Action> = Object.fromEntries(
  Object.values(ADAPTERS).map((adapter) => [adapter.name, adapter.readToolCall]),
);

/** The unread team messages for the agent in `folder`, wrapped as data; '' when none (#674). */
const teamMessages = async (folder: string, env: Env, root: string | null): Promise<string> => {
  const { deliveryFor } = await import('../agents/desk/team/deliver.ts');
  return deliveryFor(folder, env, root);
};

// A runtime whose hook can change a command before it runs (#390) says so in its adapter.
// The others run the command as it is, unless yokoten.json "privacy.output" is "stop":
// then the core refuses it, with the wrapped command as the fix.

/**
 * How the wrapped command runs `yokoten redact`: the node that runs this hook and this
 * same copy of yokoten, each by its path, quoted for bash. Neither depends on the PATH.
 * The home folder is written `$HOME`, so the command names no user.
 */
export function redactCommand(node: string, cli: string, home: string | undefined): string {
  const homePath = home?.replaceAll('\\', '/').replace(/\/+$/, '');
  let realHome = homePath;
  try {
    if (home) realHome = realpathSync(home).replaceAll('\\', '/');
  } catch {}
  const quoted = (file: string) => {
    let path = file.replaceAll('\\', '/');
    try {
      path = realpathSync(file).replaceAll('\\', '/');
    } catch {}
    const escape = (text: string) => text.replace(/["$`\\]/g, (mark) => `\\${mark}`);
    for (const prefix of [homePath, realHome]) {
      if (prefix && path.startsWith(`${prefix}/`)) return `"$HOME/${escape(path.slice(prefix.length + 1))}"`;
    }
    return `"${escape(path)}"`;
  };
  return `${quoted(node)} ${quoted(cli)} redact`;
}

// Each runtime's event for the end of a turn is in its adapter (#211, #614).

/**
 * The yokoten repos (those with a `yokoten.json`) an edit's files are in, past the
 * session's own (#307). A worktree in another folder, or a session started above the repo,
 * loads no project hook, so the guard applies the file's own repo's rules. One `rootOf`
 * per folder and one config per repo. A command's paths count too: Codex runs apply_patch
 * through the shell (#221).
 */
function editRepos(invocation: Invocation, action: Action, base: string, session: Repo | null, commandsOnly: boolean): Repo[] {
  const rootByFolder = new Map<string, string | null>([[base, session?.root ?? null]]);
  const repos = new Map<string, Repo | null>();
  // In the full hook, the session's root already has its rules.
  if (session) repos.set(session.root, commandsOnly && existsSync(join(session.root, 'yokoten.json')) ? session : null);
  for (const path of action.paths) {
    let folder = dirname(resolve(base, path));
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    if (!rootByFolder.has(folder)) rootByFolder.set(folder, rootOf(folder, invocation.env));
    const root = rootByFolder.get(folder);
    if (!root || repos.has(root)) continue;
    repos.set(root, existsSync(join(root, 'yokoten.json')) ? { root, config: loadHookConfig(root, (line) => say(invocation, `${line}\n`, invocation.stderr)) } : null);
  }
  return [...repos.values()].filter((repo) => repo !== null);
}

/**
 * The stop check (#92, #614). The agent runs it when it is about to end its turn
 * (code.claude.com/docs/en/hooks#stop). Findings in the changed files send a lead back
 * once: exit 2, with the findings on stderr as the reason. `stop_hook_active` means it was
 * already sent back, so a lead's turn ends whatever is found: never a loop.
 *
 * A worker also runs the task's done-when command (or the changed-file check when the
 * brief has none). A failing check sends the worker back, with the output in short. After
 * DONE_TRY_LIMIT refusals the next stop is let through. The worker's message to the lead
 * must start with "NOT DONE: checks failing". A linked worktree's `.yokoten-agent.json`
 * gets `checks` set to `failing`, so the lead can see it. The board will show it later
 * (#603). The main checkout is not written. A pass sets `checks` to `passing`.
 * A subagent is a worker only by its own type. On any error the turn ends too, with one
 * line on stderr: a broken check must not trap a session.
 */
async function stopHook(invocation: Invocation, json: boolean, read: (input: unknown) => StopEvent | null, agent: string): Promise<number> {
  const { env } = invocation;
  let event: StopEvent | null;
  try {
    event = read(JSON.parse(readInput(invocation.stdin)));
  } catch {
    event = null;
  }
  if (!event) {
    if (json) printJson(invocation, { blocked: false, stop: false });
    return 0;
  }
  const folder = event.cwd ?? invocation.cwd;
  const folders = [folder, invocation.cwd];
  const key = doneTryKey(event.sessionId, folder);
  // Team messages (#674) come after the checks, never in their place. A turn sent back only
  // to read messages does not count as sent back: the next stop is checked in full.
  const messagesKey = `${key}-messages`;
  // Messages send a turn on at most once in a row, so a chatty sender can't keep an agent from stopping.
  const afterMessages = event.active && wasRefusedRecently(folder, messagesKey);
  if (afterMessages) event = { ...event, active: false };
  clearRefusedMarker(folder, messagesKey);
  const takeMessages = async (): Promise<string> => (event?.subagent ? '' : teamMessages(invocation.cwd, env, rootOf(invocation.cwd, env)));
  // SubagentStop fires for every subagent. Its own type decides. The parent session's
  // role does not: a reviewer started by a worker is not checked (#614).
  const isWorker = event.subagent ? event.worker : event.worker || workerRole(env, folders) !== null;
  if (event.subagent && !event.worker) {
    if (json) printJson(invocation, { blocked: false, stop: true, findings: [] });
    return 0;
  }
  if (event.active && !isWorker) {
    noteLeadStop(folder, agent);
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the agent was already sent back once', findings: [] });
    return 0;
  }
  let findings: Finding[];
  const notes: Finding[] = [];
  let root: string | null;
  try {
    root = rootOf(folder, env);
    // A worker by YOKOTEN_ROLE, by the mark on its worktree, or by the event (#555, #614).
    const marked = withWorkerMark(env, folders);
    const workerEnv = isWorker ? { ...marked, YOKOTEN_ROLE: 'worker' } : marked;
    findings = root ? checkChanged(root, { config: loadConfig(root), env: workerEnv, notes }) : [];
  } catch (err) {
    say(invocation, `yokoten hook --stop: skipped, ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
    if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the check failed', findings: [] });
    return 0;
  }
  let doneWhen: { command: string; ok: boolean; output: string } | undefined;
  // A subagent runs in the worker's worktree only when the event's folder is that
  // worktree. Otherwise it shares the lead's folder (#614).
  // A broken `.git` still reads its own done-when, so run it in the desk it belongs to (#746).
  const link = isWorker ? gitLinkAbove(folder) : null;
  const ranIn = isWorker && root ? (event.subagent ? subagentDir(folder) : link?.top ?? root) : folder;
  if (isWorker && root) {
    const command = readDoneWhen(env, event.subagent ? ranIn : folder);
    if (command) {
      try {
        const ran = await runDoneWhen(command, ranIn, { ...env, YOKOTEN_ROLE: 'worker' });
        doneWhen = { command, ...ran };
      } catch (err) {
        say(invocation, `yokoten hook --stop: skipped, ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
        if (json) printJson(invocation, { blocked: false, stop: true, skipped: 'the check failed', findings });
        return 0;
      }
    }
  }
  const failed = findings.length > 0 || doneWhen?.ok === false;
  if (!failed) {
    let anchor: Anchor | null = null;
    if (isWorker) {
      forgetDoneTries(env, key);
      clearRefusedMarker(folder, key);
      recordChecks(invocation, folder, 'passing', agent);
      // The tests pass: a clean tree becomes an anchor. Only a dirty tree asks for a
      // checkpoint commit; an anchored HEAD and a folder without git each get their own line.
      const passing = doneWhen?.ok === true ? doneWhen.command : 'the changed-file check';
      const outcome = root ? recordAnchor(ranIn, { ...env, YOKOTEN_ROLE: 'worker' }, passing) : null;
      anchor = outcome && (outcome.kind === 'recorded' || outcome.kind === 'already') ? outcome.anchor : null;
      if (!json) print(invocation, [anchorMessage(outcome)], invocation.stderr);
    } else noteLeadStop(folder, agent);
    if (!json && notes.length) print(invocation, [`yokoten: ${notes.length} warning(s) in the changed files:`, ...bullets(notes)], invocation.stderr);
    // The checks pass: unread messages send the turn on once, and the next stop is checked again.
    const messages = event.active || afterMessages ? '' : await takeMessages();
    if (messages) {
      noteRefused(folder, messagesKey);
      if (json) printJson(invocation, { blocked: true, stop: false, findings, messages: true, ...(anchor ? { anchor } : {}) });
      print(invocation, [messages], invocation.stderr);
      return 2;
    }
    if (json) printJson(invocation, { blocked: false, stop: true, findings, ...(notes.length ? { notes } : {}), ...(anchor ? { anchor } : {}) });
    return 0;
  }
  if (!isWorker) {
    logTurnStop(invocation, agent, false, findings, doneWhen, 'refused');
    if (json) printJson(invocation, { blocked: true, stop: true, findings, ...(notes.length ? { notes } : {}) });
    print(invocation, [...refusalLines(findings), ...(notes.length ? [`yokoten: ${notes.length} warning(s) in the changed files:`, ...bullets(notes)] : [])], invocation.stderr);
    return withMessages(invocation, 2, await takeMessages());
  }
  const bumped = bumpDoneTries(env, key);
  // No saved count: stop_hook_active, or a refusal of this worker in the last 5 minutes,
  // lets the stop through. A runtime that never sets stop_hook_active cannot trap it.
  if (bumped === null) {
    if (event.active || wasRefusedRecently(folder, key)) {
      logTurnStop(invocation, agent, true, findings, doneWhen, 'allowed once');
      return allowFailingStop(invocation, json, findings, notes, doneWhen, DONE_TRY_LIMIT, env, key, folder, agent);
    }
    noteRefused(folder, key);
    logTurnStop(invocation, agent, true, findings, doneWhen, 'refused');
    return withMessages(invocation, refuseFailingStop(invocation, json, findings, notes, doneWhen, 1, false), await takeMessages());
  }
  if (bumped > DONE_TRY_LIMIT) {
    logTurnStop(invocation, agent, true, findings, doneWhen, 'allowed once');
    return allowFailingStop(invocation, json, findings, notes, doneWhen, bumped, env, key, folder, agent);
  }
  logTurnStop(invocation, agent, true, findings, doneWhen, 'refused');
  return withMessages(invocation, refuseFailingStop(invocation, json, findings, notes, doneWhen, bumped, true), await takeMessages());
}

/** What a passing worker hears about its anchor. Only a dirty tree asks for a commit (#792). */
function anchorMessage(outcome: AnchorOutcome | null): string {
  if (outcome === null) return 'yokoten: tests pass. No anchor: there is no project root here.';
  if (outcome.kind === 'dirty') {
    return 'yokoten: tests pass. Make a checkpoint commit now; that commit is your anchor. If you get lost, go back with: git switch -c try-2 <anchor>';
  }
  if (outcome.kind === 'no-checkout') return 'yokoten: tests pass. No anchor: this folder is not a git checkout.';
  if (outcome.kind === 'no-commit') return 'yokoten: tests pass. No anchor: this checkout has no commit yet.';
  if (outcome.kind === 'write-failed') {
    return 'yokoten: tests pass. No anchor: the anchor file could not be written. A checkpoint commit still holds your work.';
  }
  const { commit } = outcome.anchor;
  if (outcome.kind === 'already') {
    return `yokoten: tests pass. HEAD ${commit.slice(0, 12)} is already your anchor; go back with: git switch -c try-2 ${commit}`;
  }
  return `yokoten: tests pass. Anchor ${commit.slice(0, 12)} saved; go back with: git switch -c try-2 ${commit}`;
}

/** A refusal at the end of a turn, with the unread team messages after it (#674). */
function withMessages(invocation: Invocation, code: number, messages: string): number {
  if (messages) print(invocation, [messages], invocation.stderr);
  return code;
}

/**
 * The linked worktree's real root, or null for the main checkout and outside a repo.
 * `realpath` runs first. If it fails, nothing is written. A link into another worktree
 * is not this folder's worktree, so that worktree's status file stays as it is.
 */
function linkedWorktree(folder: string): string | null {
  let realFolder: string;
  try {
    realFolder = realpathSync(folder);
  } catch {
    return null;
  }
  const link = gitLinkAbove(realFolder);
  if (link?.kind !== 'file') return null;
  let top: string;
  try {
    top = realpathSync(link.top);
  } catch {
    return null;
  }
  return staysInsideWorktree(folder, top) ? top : null;
}

/** Whether `folder` is `top` or inside it, without following a symlink out. */
function staysInsideWorktree(folder: string, top: string): boolean {
  let dir = resolve(folder);
  for (;;) {
    try {
      if (!lstatSync(dir).isSymbolicLink() && realpathSync(dir) === top) return true;
    } catch {
      return false;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Write `checks` at a worker's checkout, and that it is done (#685): its worktree or desk,
 * when the repo uses yokoten. Else at a linked worktree's root, `checks` only. The main
 * checkout is the lead's, so a worker leaves it unchanged.
 */
function recordChecks(invocation: Invocation, folder: string, checks: 'failing' | 'passing', agent: string): void {
  const checkout = findStatusCheckout(folder);
  if (checkout?.isMain && !checkout.isDesk) return;
  if (checkout) {
    const start = startFields(agent, true, checkout, '');
    changeAgentStatus(checkout, { fill: { ...start.fill, vendor: agent }, set: { checks, state: 'done', doing: checks === 'passing' ? 'finished, checks pass' : 'stopped, checks fail', blocked: null } });
    return;
  }
  const root = linkedWorktree(folder);
  if (!root) return;
  writeAgentChecks(root, checks, new Date(), (line) => say(invocation, line, invocation.stderr));
}

/** The lead's turn ended: it waits for the owner (#685). Only in a repo that uses yokoten. */
function noteLeadStop(folder: string, agent: string): void {
  const checkout = findStatusCheckout(folder);
  if (!checkout || !canKeepStatus(checkout, false)) return;
  const start = startFields(agent, false, checkout, '');
  changeAgentStatus(checkout, { fill: { ...start.fill, vendor: agent }, set: { state: 'waiting', doing: 'its turn ended: waiting for your answer' } });
}

/**
 * Keep the session's status file for one tool call (#685). An allowed call says what it
 * does, at most once every STATUS_EVERY_MS; a refused call always sets `blocked`. A file
 * that does not exist yet gets the start fields, for runtimes with no session-start hook.
 */
function noteToolCall(folder: string, agent: string, action: Action, isWorker: boolean, found: Finding | null): void {
  const checkout = findStatusCheckout(folder);
  if (!checkout || !canKeepStatus(checkout, isWorker)) return;
  const start = startFields(agent, isWorker, checkout, '');
  const fill = { ...start.fill, vendor: agent };
  if (found) {
    changeAgentStatus(checkout, { fill, set: { state: 'working', blocked: `the guard stopped this: ${found.what}`.split('\n')[0].slice(0, 140) } });
    return;
  }
  const doing = describeAction(action);
  changeAgentStatus(checkout, { fill, set: { state: 'working', blocked: null, ...(doing ? { doing } : {}) }, throttleMs: STATUS_EVERY_MS });
}

/** The folder a subagent's command runs in: the linked worktree the event names, or the event's own folder. */
function subagentDir(folder: string): string {
  const link = gitLinkAbove(folder);
  return link?.kind === 'file' ? link.top : folder;
}

/** Drop the try count. `clearDoneTries` already ignores an `rmSync` error; this is the second wall. */
function forgetDoneTries(env: Invocation['env'], key: string): void {
  try {
    clearDoneTries(env, key);
  } catch {
    // A count file that cannot be removed must not crash the hook.
  }
}

/**
 * Each finding as the refusal a tool denial prints (#707): title, why, do instead, more.
 * The board splits the same four parts from an end-of-turn refusal as from a denial.
 */
const refusalLines = (findings: Finding[]): string[] => findings.map((found) => formatRefusal(found));

/** The rule a failing stop names first, for the log: a finding's id, or the task's done-when check. */
function stopRule(findings: Finding[], doneWhen: { ok: boolean } | undefined): string {
  return findings[0]?.id ?? (doneWhen?.ok === false ? 'done-when' : 'unknown');
}

/** Write one end-of-turn stop to the log (#621). The command is not logged: a turn names files, not a command. */
function logTurnStop(invocation: Invocation, agent: string, isWorker: boolean, findings: Finding[], doneWhen: { ok: boolean } | undefined, answer: StopAnswer): void {
  logStop(invocation.env, { vendor: agent, role: isWorker ? 'worker' : 'lead', rule: stopRule(findings, doneWhen), answer });
}

/** The lines that send a worker back, and, on the last refusal, what to tell the lead. */
function refuseFailingStop(
  invocation: Invocation,
  json: boolean,
  findings: Finding[],
  notes: Finding[],
  doneWhen: { ok: boolean; output: string } | undefined,
  tries: number,
  saved: boolean,
): number {
  const lines: string[] = [];
  if (findings.length) lines.push(...refusalLines(findings));
  if (notes.length) lines.push(`yokoten: ${notes.length} warning(s) in the changed files:`, ...bullets(notes));
  if (doneWhen?.ok === false) {
    lines.push('yokoten: the done-when check failed. Fix what it reports, then end the task again:');
    if (doneWhen.output) lines.push(doneWhen.output);
  }
  // The last refusal is the one the worker can still read. The allowed stop's stderr reaches nobody.
  if (!saved || tries >= DONE_TRY_LIMIT) {
    lines.push(`This was try ${tries} of ${DONE_TRY_LIMIT}. The next stop is let through.`);
    lines.push('Your final message to the lead must start with "NOT DONE: checks failing" and quote the failing output.');
  } else lines.push(`This was try ${tries} of ${DONE_TRY_LIMIT}.`);
  if (json) printJson(invocation, { blocked: true, stop: true, findings, ...(notes.length ? { notes } : {}), ...(doneWhen ? { doneWhen: { ok: false, output: doneWhen.output, tries, limit: DONE_TRY_LIMIT } } : {}) });
  print(invocation, lines, invocation.stderr);
  return 2;
}

/** Let the worker stop, and leave a record the lead can read. The try count starts again. */
function allowFailingStop(
  invocation: Invocation,
  json: boolean,
  findings: Finding[],
  notes: Finding[],
  doneWhen: { ok: boolean; output: string } | undefined,
  tries: number,
  env: Invocation['env'],
  key: string,
  folder: string,
  agent: string,
): number {
  recordChecks(invocation, folder, 'failing', agent);
  forgetDoneTries(env, key);
  const payload = { blocked: false, stop: true, findings, ...(notes.length ? { notes } : {}), skipped: 'stopped with failing checks', ...(doneWhen ? { doneWhen: { ok: false, output: doneWhen.output, tries, limit: DONE_TRY_LIMIT } } : {}) };
  if (json) printJson(invocation, payload);
  print(invocation, ['yokoten: stopped with failing checks. The done-when check still fails. Tell the lead this task is not done.'], invocation.stderr);
  return 0;
}

/**
 * The answer a refusal gets (#707). Only a hook installed for Claude Code (`--agent
 * claude-code`) answers with a deny in `hookSpecificOutput` on exit 0: an unnamed hook is
 * read by Copilot CLI too, so it keeps the exit-2 answer. Copilot's own user hook names
 * `claude-code` for the input shape, so install also passes `--denial exit2` to keep the
 * answer its reader expects. A structured answer is safe only as the whole of stdout: on
 * exit 0 Claude Code reads any surrounding text as plain output, which lets the call run.
 * So a refusal beside other text falls back to exit 2.
 */
export function chooseDenial(
  agent: string,
  reason: string,
  env: Env,
  { isNamed, isStdoutEmpty, isExit2 = false }: { isNamed: boolean; isStdoutEmpty: boolean; isExit2?: boolean },
): { stdout: string; exitCode: number } {
  if (isExit2) return claudeCode.fallbackDenial(reason);
  const formatDenial = adapterFor(agent)?.formatDenial;
  const denial = isNamed && formatDenial !== undefined
    ? formatDenial(reason, env)
    : agent === 'claude-code' ? claudeCode.fallbackDenial(reason) : { stdout: '', exitCode: 2 };
  return denial.exitCode === 0 && !isStdoutEmpty ? claudeCode.fallbackDenial(reason) : denial;
}

/**
 * The one answer a tool call gets on stdout (#707): a rewrite, a context note or a refusal.
 * Keep it in hand until the branch knows which, so a refusal can check that its JSON would
 * be alone there (see `chooseDenial`).
 */
function answerBuffer(): { stream: Output; text: () => string } {
  let text = '';
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, _, done) {
      text += String(chunk);
      done();
    },
  }) as Output;
  return { stream, text: () => text };
}

/**
 * The question before a heavy job when the kept host reading is low (#401): what runs,
 * why a full drive can corrupt the repo, and the fix. Null when no fresh reading is kept,
 * the drive has room, or the command is light. It reads one small file, never the drive.
 */
export function askForHeavyJob(command: string, env: Env): Finding | null {
  const disk = readKeptHostDisk(env);
  if (!disk || !isLowOnSpace(disk, env)) return null;
  const job = findHeavyJob(command);
  if (job === null) return null;
  const when = new Date(disk.readAt).toISOString().slice(0, 16).replace('T', ' ');
  return {
    ...finding('disk-space', `\`${job}\` is a heavy job, and ${HOST_DRIVE} has ${formatSpace(disk)} (read ${when} UTC)`, `before this job, ${HOST_DISK_FIX}. Then run \`yokoten doctor\` to read the drive again`, {
      why: 'a full drive can corrupt the repo: git can write empty objects, and a branch head can be lost',
    }),
    ask: true,
  };
}

/** `guard`: the guard's worker, when bin/main.ts started it early (#408). */
export function runHook(invocation: Invocation, guard?: Guard): number | Promise<number> {
  const { cwd } = invocation;
  const options = parse('hook', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const json = options.flags.has('--json');
  const namedAgent = options.values['--agent'];
  const agent = namedAgent ?? 'claude-code';
  const denialMode = options.values['--denial'];
  if (denialMode !== undefined && denialMode !== 'exit2') return usage(invocation, `unknown --denial ${denialMode}; use exit2`);
  if (options.flags.has('--stop')) {
    if (options.flags.has('--commands-only')) return usage(invocation, "--stop and --commands-only can't be used together");
    const readStop = stopReaderOf(agent);
    if (!readStop) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.values(ADAPTERS).filter((adapter) => adapter.readStop !== undefined).map((adapter) => adapter.name).join(', ')}`);
    return stopHook(invocation, json, readStop, agent);
  }
  const read = Object.hasOwn(READERS, agent) ? READERS[agent] : undefined;
  if (!read) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  let input: unknown;
  try {
    input = JSON.parse(readInput(invocation.stdin));
  } catch {
    // Not a tool call; nothing to judge. A runtime never sends one, and blocking here
    // would stop every tool call the day a runtime changes its input.
    if (json) printJson(invocation, { blocked: false, toolCall: false });
    return 0;
  }
  const action = read(input);
  const root = rootOf(action.cwd ?? cwd, invocation.env);
  // A worktree the lead marked makes every agent in it a worker, whatever env it passes (#555).
  // Both folders count: a call may name another folder (Muse's `workdir`) than the hook's own.
  const folders = [resolve(cwd, action.cwd ?? '.'), cwd];
  const role = workerRole(invocation.env, folders);
  const env = role === 'mark' ? { ...invocation.env, YOKOTEN_ROLE: 'worker' } : invocation.env;
  const config = loadHookConfig(root, (line) => say(invocation, `${line}\n`, invocation.stderr));
  const commandsOnly = options.flags.has('--commands-only');
  const repos = editRepos(invocation, action, action.cwd ?? root ?? cwd, root ? { root, config } : null, commandsOnly);
  const judged = judgeWithDeadline(action, { root, config, env, cwd, commandsOnly, repos }, guardDeadline(env.YOKOTEN_GUARD_DEADLINE_MS), guard);
  const answer = answerBuffer();
  const answerInvocation: Invocation = { ...invocation, stdout: answer.stream };
  /** Writes the branch's one answer to stdout, then returns `code`. */
  const finish = (code: number): number => {
    invocation.stdout.write(answer.text());
    return code;
  };
  // The circuit breaker (#711): one count for the session, one shape for this step. A call
  // with no session id gets no count: the count would belong to the folder, not a session (#792).
  const sessionKey = repeatKeyOf(sessionIdOf(input));
  const shape = commandShape(action.command, action.paths);
  return judged.then((judgedFinding) => {
    // The guard names no agent; the hook knows which one it runs for.
    const fix = releaseFixOf(agent);
    let found = judgedFinding?.id === 'release' && fix !== undefined ? { ...judgedFinding, fix } : judgedFinding;
    // A command that may print the owner's details runs through `yokoten redact` (#390).
    const printed = !found && action.command !== undefined ? printsAccount(action.command) : null;
    if (printed && action.command !== undefined) {
      const wrapped = wrapForRedact(hardenRead(action.command), redactCommand(process.execPath, invocation.script, env.HOME));
      const rewritten = rewriteOf(agent, input, wrapped, `yokoten: ${printed}, so its output goes through yokoten redact`);
      if (rewritten !== null) {
        if (json) printJson(answerInvocation, { blocked: false, toolCall: true, rewritten: wrapped });
        // Written as it is: hiding the home folder would change the command.
        else answerInvocation.stdout.write(rewritten);
        noteToolCall(cwd, agent, action, role !== null || action.worker, null);
        if (sessionKey !== null) clearRepeats(env, sessionKey);
        return finish(0);
      }
      if (config.privacy.output === 'stop') found = privateOutput(printed, wrapped);
    }
    // A worker by the mark hears why, and where the lead works (#555).
    if (found && role === 'mark' && WORKER_RULES.has(found.id)) found = { ...found, fix: `${found.fix}. ${capital(markNote(folders, invocation.env))}` };
    // The third same refusal becomes a stop message; any success starts the count again (#711).
    if (found) {
      const repeats = sessionKey === null ? null : bumpRepeat(env, sessionKey, found.id, shape);
      if (repeats !== null && repeats >= REPEAT_STOP_LIMIT) found = repeatStopFinding();
      // One line per stop, on this computer only (#621).
      logStop(env, {
        vendor: agent,
        role: role !== null || action.worker ? 'worker' : 'lead',
        rule: found.id,
        // A guard that could not read the call has no rule answer; it still refuses the call.
        answer: found.id === 'unreadable-command' ? 'no answer' : 'refused',
        command: action.command ?? action.commands?.[0],
      });
    } else if (sessionKey !== null) {
      clearRepeats(env, sessionKey);
    }
    // A heavy job on a nearly full host drive asks first, and never refuses (#401).
    const ask = !found && action.command !== undefined ? askForHeavyJob(action.command, env) : null;
    noteToolCall(cwd, agent, action, role !== null || action.worker, found);
    if (json) printJson(answerInvocation, found ? { blocked: true, finding: found } : ask ? { blocked: false, toolCall: true, ask } : { blocked: false, toolCall: true });
    if (!found && ask) {
      const question = `yokoten: ${formatFinding(ask)}`;
      const asked = askOf(agent);
      if (!json && asked !== null) say(answerInvocation, asked(question), answerInvocation.stdout);
      else if (!json) say(answerInvocation, `${question}\n`, invocation.stderr);
      return finish(0);
    }
    if (!found && !json && adapterFor(agent)?.formatContext !== undefined) {
      // The session's own folder, never the call's: a folder a desk agent wrote can't name the lead's team.
      // When the call names no other folder, the root above is this folder's: one git call, not two (#821).
      const sessionRoot = resolve(cwd, action.cwd ?? '.') === resolve(cwd) ? root : rootOf(cwd, env);
      return teamMessages(cwd, env, sessionRoot).then((messages) => {
        const text = messages ? contextOf(agent, messages) : null;
        if (text) say(answerInvocation, text, answerInvocation.stdout);
        return finish(0);
      });
    }
    if (!found) return finish(0);
    // The runtimes read the reason from stderr when the hook exits 2; some read stdout.
    // Every rule gives the same four parts (#707): title, why, do instead, more.
    const reason = formatRefusal(found);
    say(invocation, `${reason}\n`, invocation.stderr);
    // The --agent the hook was installed with decides the answer, never an environment
    // variable another host could inherit (#707). An unnamed hook may be read by another
    // host through the shared .claude/settings.json, so it keeps exit 2.
    const denial = chooseDenial(agent, reason, invocation.env, { isNamed: namedAgent !== undefined, isStdoutEmpty: answer.text() === '', isExit2: denialMode === 'exit2' });
    if (!json && denial.stdout) say(answerInvocation, denial.stdout, answerInvocation.stdout);
    return finish(json ? 2 : denial.exitCode);
  });
}

// The rules that apply to a worker only: a refusal by one of them names the mark, when the role came from it.
const WORKER_RULES = new Set(['lead-only', 'worker-push', 'worker-mark']);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * `yokoten stops`: the stop log's state, and the way back. `off` stops the writing and
 * deletes the log; `on` starts it again. The log stays in the user's config folder, never
 * in the project (#621).
 */
export function runStops(invocation: Invocation): number {
  const options = parse('stops', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action] = options.positional;
  const { env } = invocation;
  const file = stopsFile(env);
  const offFile = stopsOffFile(env);
  if (!file || !offFile) {
    say(invocation, "yokoten stops: no home folder, so there is no stop log to manage. Set HOME to your home folder's full path.\n", invocation.stderr);
    return 1;
  }
  if (action === undefined) {
    const state = stopsState(env);
    print(invocation, [
      `the stop log is ${state.isOff ? 'off' : 'on'}: ${hideHome(state.file ?? file, env)}`,
      state.isOff ? 'yokoten writes no line while it is off.' : `${state.count} stop(s), ${state.bytes} byte(s)`,
      'It stays on this computer. Nothing is sent anywhere.',
      '`yokoten stops off` stops the writing and deletes the log.',
    ]);
    return 0;
  }
  if (action === 'off') {
    try {
      mkdirSync(dirname(offFile), { recursive: true });
      writeFileSync(offFile, 'off\n');
      rmSync(file, { force: true });
    } catch (err) {
      say(invocation, `yokoten stops: the log cannot be turned off: ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
      return 1;
    }
    print(invocation, ['the stop log is off, and its file is deleted. `yokoten stops on` starts it again.']);
    return 0;
  }
  if (action === 'on') {
    try {
      rmSync(offFile, { force: true });
    } catch (err) {
      say(invocation, `yokoten stops: the log cannot be turned on: ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
      return 1;
    }
    print(invocation, [`the stop log is on: ${hideHome(file, env)}`]);
    return 0;
  }
  return usage(invocation, `unknown action "${action}"; use off or on`);
}

/**
 * `worker mark <dir>`: mark the worktree at <dir> as a worker's (#555). The guard then
 * treats every agent there as a worker, whatever env its runtime passes to the hook. The
 * mark is a file in the worktree's own git folder, and its path on the worker list (#566),
 * outside the worktree, so moving `.git` away keeps the role. `git worktree remove`
 * removes the file with the worktree, and the guard skips the list entry whose folder is
 * gone; `worker unmark` clears an entry outright, and only the lead runs it. The main
 * checkout is the lead's, so it is never marked.
 */

/**
 * Mark the worktree at `dir` (from `cwd`) as a worker's, exactly as `yokoten worker
 * mark` does: the mark file in its own git folder, and its path on the worker list.
 * The board calls this for the worktree it makes or reuses, so runtimes that drop
 * YOKOTEN_ROLE still run as workers. Returns the worktree root, or the plain reason.
 */
export function markWorktree(cwd: string, dir: string, callerEnv: Env): { top: string; kind: 'worktree' | 'clone' } | { fail: string } {
  const folder = resolve(cwd, dir);
  // Git reads the folder from the caller's GIT_DIR before the path: dropped, so the mark goes where `dir` is (#672).
  const env = withoutGitPlace(callerEnv);
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch {}
  if (!isFolder) return { fail: `${dir} is not a folder. Make the worktree first: \`git worktree add ${dir} -b <branch>\`, then \`yokoten worker mark ${dir}\`.` };
  let answer: string[];
  try {
    // --show-superproject-working-tree prints nothing outside a submodule, so it comes last.
    answer = readGit(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-superproject-working-tree'], { env }).toString('utf8').trim().split('\n');
  } catch {
    return { fail: formatFinding(notRepoFinding(folder)) };
  }
  const [top, gitDir, common, superproject] = answer;
  const kind = realPath(gitDir) === realPath(resolve(folder, common ?? '')) ? 'clone' : 'worktree';
  if (kind === 'clone') {
    if (superproject) return { fail: `${top} is a submodule's checkout, not a worktree. Mark a worktree: \`git worktree add <dir> -b <branch>\`, then \`yokoten worker mark <dir>\`.` };
    // A plain clone is a worker's desk (#672), unless the lead works in it: the session runs
    // there, or worktrees hang off it. Those are the main checkout, never marked.
    const here = realPath(cwd);
    const base = realPath(top);
    const isLeadHere = here === base || here.startsWith(base + sep);
    if (isLeadHere || hasLinkedWorktrees(folder, env)) return { fail: `${top} is the main checkout, the lead's. Mark a worktree (\`git worktree add <dir> -b <branch>\`) or a clone of its own (\`git clone <repo> <dir>\`), then \`yokoten worker mark <dir>\`.` };
    // The lead marks a clone from its own checkout, so that checkout is never the one marked.
    if (leadCheckout(cwd, env) === null) return { fail: `run \`yokoten worker mark ${dir}\` from your own checkout, the lead's: yokoten then knows that ${top} is not it.` };
  }
  // Git and the guard must name the same git folder, or the mark lands where the guard never looks.
  const link = gitLinkAbove(folder);
  if (link === null || link.kind === 'broken' || realPath(link.gitDir) !== realPath(gitDir)) return { fail: `git names ${gitDir} as the git folder of ${top}, but its .git does not. Nothing is marked.` };
  try {
    const note = kind === 'clone' ? "A worker's clone: yokoten's guard treats every agent here as a worker. Removing the clone removes this mark.\n" : "A worker's worktree: yokoten's guard treats every agent here as a worker. `git worktree remove` removes this mark.\n";
    writeFileSync(join(gitDir, WORKER_MARK), note);
  } catch (error) {
    return { fail: `can't write the mark in ${gitDir} (${(error as NodeJS.ErrnoException).code ?? 'error'}). Check that the lead can write there, then run it again.` };
  }
  try {
    addWorkerPath(env, top);
  } catch (error) {
    return { fail: `the mark is written in ${gitDir}, but the worker list can't be written (${(error as Error).message.split('\n')[0]}). Clear it with \`yokoten worker unmark ${top}\` once the list is writable, then mark again.` };
  }
  // The guard finds the mark without git; check that it finds the file itself, not the list.
  if (!existsSync(join(link.gitDir, WORKER_MARK)) || workerMarkAt(folder, env) !== 'mark') return { fail: `the mark is written in ${gitDir}, but the guard can't find it from ${top}.` };
  return { top, kind };
}

// The names that point git at another git folder or work tree than the folder it runs in.
const GIT_PLACE = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
const withoutGitPlace = (env: Env): Env => Object.fromEntries(Object.entries(env).filter(([name]) => !GIT_PLACE.includes(name)));

// The top of the checkout the lead runs in, or null outside one.
function leadCheckout(cwd: string, env: Env): string | null {
  try {
    return readGit(cwd, ['rev-parse', '--show-toplevel'], { env }).toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

// Whether other worktrees hang off the checkout at `folder`: then it is a main checkout.
function hasLinkedWorktrees(folder: string, env: Env): boolean {
  try {
    const list = readGit(folder, ['worktree', 'list', '--porcelain'], { env }).toString('utf8');
    return list.split('\n').filter((line) => line.startsWith('worktree ')).length > 1;
  } catch {
    // Git can't list them: the guard can't tell, so the checkout stays the lead's.
    return true;
  }
}

/**
 * `anchor`: list the checkpoints a worker's passing checks recorded (#711). An anchor is
 * a commit, so going back is `git switch -c <new> <anchor>`: nothing is reset or deleted.
 */
export function runAnchor(invocation: Invocation): number {
  const options = parse('anchor', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  if (options.positional.length) return usage(invocation, 'anchor takes no arguments');
  const root = rootOf(invocation.cwd, invocation.env);
  if (!root) {
    print(invocation, [formatFinding(notRepoFinding(invocation.cwd))], invocation.stderr);
    return 1;
  }
  const anchors = listAnchors(invocation.cwd);
  if (options.flags.has('--json')) {
    printJson(invocation, { anchors });
    return 0;
  }
  if (!anchors.length) {
    print(invocation, ['yokoten anchor: no anchors yet. A worker records one when its checks pass and its tree is clean.']);
    return 0;
  }
  const lines = [`yokoten anchor: ${anchors.length} checkpoint${anchors.length === 1 ? '' : 's'}, newest first.`];
  for (const anchor of anchors) {
    lines.push(`  ${anchor.commit.slice(0, 12)} ${anchor.at} ${anchor.check}`);
  }
  lines.push(`Go back without losing anything: git switch -c try-2 <commit>`);
  print(invocation, lines);
  return 0;
}

export function runWorker(invocation: Invocation): number | Promise<number> {
  const options = parse('worker', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action, dir] = options.positional;
  if (action === 'env') return runEnv(invocation, dir);
  if ((action !== 'mark' && action !== 'unmark') || dir === undefined) return usage(invocation, `say what to do and where: yokoten worker ${action === 'unmark' ? 'unmark' : 'mark'} <dir>, or yokoten worker env [runtime]`);
  const fail = (line: string) => {
    print(invocation, [`yokoten worker: ${line}`], invocation.stderr);
    return 1;
  };
  if (action === 'unmark') return runUnmark(invocation, dir, fail);
  if (workerRole(invocation.env, [invocation.cwd]) !== null) {
    return fail(`only the lead marks a worktree or a clone: this session is a worker. ${LEAD_OUTSIDE}`);
  }
  const marked = markWorktree(invocation.cwd, dir, invocation.env);
  if ('fail' in marked) return fail(marked.fail);
  const removes = marked.kind === 'clone' ? 'Removing the clone removes the mark.' : `\`git worktree remove ${marked.top}\` removes the mark.`;
  print(invocation, [`yokoten worker: marked the ${marked.kind} at ${marked.top}. The guard now treats every agent there as a worker. ${removes} \`yokoten worker unmark ${marked.top}\` clears it sooner.`]);
  return 0;
}

/**
 * `worker env [runtime]`: the names an agent that yokoten starts would get from this
 * shell (#613), and how many are dropped and why. Names only: a value is never printed.
 * With a runtime, its own login and config names count too. The module loads only here,
 * so the guard's path never loads it.
 */
async function runEnv(invocation: Invocation, runtime: string | undefined): Promise<number> {
  const { sortAgentEnv } = await import('../agents/desk/agent-env.ts');
  let sorted: SortedEnv;
  try {
    sorted = sortAgentEnv(invocation.env, runtime);
  } catch (error) {
    return usage(invocation, `${(error as Error).message}. Example: yokoten worker env claude-code`);
  }
  const count = (reason: DropReason) => sorted.dropped.filter((drop) => drop.reason === reason).length;
  const who = runtime === undefined ? 'An agent that yokoten starts' : `A ${runtime} agent that yokoten starts`;
  print(invocation, [
    `yokoten worker: ${who} would get ${sorted.kept.length} names from this shell. Values are never shown. \`yokoten desk\` starts an agent with these.`,
    ...(sorted.kept.length ? [`  ${sorted.kept.join(', ')}`] : []),
    `Dropped: ${count('secret name')} with a secret-looking name, ${count('secret value')} with a value shaped like a key or token, ${count('too long')} too long to check, ${count('not on the list')} not on the list.`,
    ...(runtime === undefined ? ['Add a runtime, such as `yokoten worker env claude-code`, to count its own login names too.'] : []),
  ]);
  return 0;
}

/**
 * `worker unmark <dir>`: forget the marked worktree at <dir> (#566). Only the lead runs
 * it: a worker's session, by YOKOTEN_ROLE or by the mark on its own worktree, is refused.
 * It drops the worktree's path from the worker list, and the mark file when `.git` still
 * names it. Given a folder with no `.git` (moved away), it still clears by path.
 */
// Where the lead runs `worker mark` and `worker unmark`: inside a marked checkout, every session is a worker.
const LEAD_OUTSIDE = "A worker commits in its own checkout and reports. The lead runs this from its own checkout, outside the marked one.";

function runUnmark(invocation: Invocation, dir: string, fail: (line: string) => number): number {
  if (workerRole(invocation.env, [invocation.cwd]) !== null) {
    return fail(`only the lead unmarks a worktree: this session is a worker. ${LEAD_OUTSIDE}`);
  }
  const folder = resolve(invocation.cwd, dir);
  let top = folder;
  let gitDir: string | undefined;
  try {
    const answer = readGit(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { env: withoutGitPlace(invocation.env) }).toString('utf8').trim().split('\n');
    if (answer[0]) top = answer[0];
    gitDir = answer[1];
  } catch {
    // No `.git` to read (moved away): the list entry is still cleared by path below.
  }
  if (gitDir) rmSync(join(gitDir, WORKER_MARK), { force: true });
  try {
    removeWorkerPath(invocation.env, top);
  } catch (error) {
    return fail(`can't clear the worker list (${(error as Error).message.split('\n')[0]}). Check HOME, then run it again.`);
  }
  print(invocation, [`yokoten worker: unmarked ${top}. The guard no longer treats agents there as workers.`]);
  return 0;
}

/**
 * `desk <agent> <folder> -- <command>`: start a worker's agent in its own fenced desk
 * (#637). Only the lead runs it. The modules load only here, so the guard never loads them.
 */
export async function runDesk(invocation: Invocation): Promise<number> {
  // Inside a Linux desk, its first program: the bridge to the proxy, then the agent.
  if (invocation.args[0] === '--bridge') return (await import('../agents/desk/network/bridge.ts')).runBridge(invocation.args.slice(1), invocation.stderr);
  const end = invocation.args.indexOf('--');
  const options = parse('desk', end === -1 ? invocation.args : invocation.args.slice(0, end));
  if (typeof options === 'string') return usage(invocation, options);
  const [runtime, folder] = options.positional;
  const command = end === -1 ? [] : invocation.args.slice(end + 1);
  if (runtime === undefined || folder === undefined || !command.length) return usage(invocation, 'name the agent, the folder and the command: yokoten desk <agent> <folder> -- <command>');
  const fail = (line: string) => {
    print(invocation, [`yokoten desk: ${line}`], invocation.stderr);
    return 1;
  };
  if (workerRole(invocation.env, [invocation.cwd]) !== null) return fail('only the lead starts a desk: this session is a worker.');
  const [{ planDesk }, { chooseBackend, deskProblem, startDesk }, { paths }, team, { teamFolderFor, teamName }] = await Promise.all([import('../agents/desk/desk.ts'), import('../agents/desk/start.ts'), import('../setup/install.ts'), import('../agents/desk/team/who.ts'), import('../agents/desk/team/team.ts')]);
  const backend = chooseBackend(process.platform, invocation.env);
  if (typeof backend === 'string') return fail(backend);
  const list = (name: string) => (options.values[name] ?? '').split(',').map((word) => word.trim()).filter(Boolean);
  const installed = paths(invocation.env);
  // The team of the lead's project (#674): next to its main checkout. The agent's name is
  // --name, or the desk folder's made into a name; a folder name that can't be one joins no team.
  const main = team.leadCheckout(invocation.cwd, invocation.env);
  const asked = options.values['--name'];
  const name = asked ?? teamName(basename(resolve(invocation.cwd, folder)));
  if (typeof main === 'string' && name === null) print(invocation, ['yokoten desk: the folder\'s name can\'t be a name on the team, so this desk joins none. Name it with --name to join.'], invocation.stderr);
  let plan: ReturnType<typeof planDesk>;
  try {
    plan = planDesk({
      runtime,
      desk: resolve(invocation.cwd, folder),
      command,
      env: invocation.env,
      extraReadable: list('--read').map((path) => resolve(invocation.cwd, path)),
      extraHosts: list('--host'),
      allowLoopback: options.flags.has('--allow-loopback'),
      runtimes: [installed.runtime],
      marks: options.flags.has('--marks') ? installed.marks : undefined,
      team: typeof main === 'string' && name !== null ? { folder: teamFolderFor(main), name } : undefined,
      markDesk: (desk) => markWorktree(invocation.cwd, desk, invocation.env),
    });
  } catch (error) {
    return fail((error as Error).message);
  }
  const problem = deskProblem(plan, backend);
  if (problem) return fail(problem);
  print(invocation, [`yokoten desk: ${runtime} in ${plan.desk} (${backend.name}); the agent may reach ${plan.hosts.join(', ')}${plan.allowLoopback ? ', and every loopback port: you allowed that with --allow-loopback' : ''}.`], invocation.stderr);
  // The board shows the desk's agent (#685). A desk that can't be noted still starts.
  const unlisted = registerDesk(invocation.cwd, plan.desk);
  if (unlisted) print(invocation, [`yokoten desk: the board won't show this desk: ${unlisted}.`], invocation.stderr);
  const refused = new Set<string>();
  const result = await startDesk(plan, backend, {
    stdio: 'inherit',
    onEvent: (event) => {
      if (!event.isAllowed) refused.add(event.target);
    },
  });
  if (result.stderr) invocation.stderr.write(result.stderr);
  if (refused.size) print(invocation, [`yokoten desk: the proxy refused ${[...refused].join(', ')}. Add an API host with --host if the agent needs it.`], invocation.stderr);
  return result.code;
}
