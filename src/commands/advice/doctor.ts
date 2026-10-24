// `yokoten doctor`, `explain`, `adopt` and `gc`. Doctor reads and shows. A session start also
// writes the agent's status file, git-ignored (#685). A lead writes its log path into
// the repo's git folder (#700). A Claude Code session start keeps what it said in
// ~/.config/yokoten/sessions/ (#405). `gc` sweeps the desks that finished (#708); doctor
// only lists what it would remove.

import { execFileSync } from 'node:child_process';
import { readSync } from 'node:fs';
import { identityLine } from '../../agents/desk/team/who.ts';
import * as claudeCode from '../../agents/runtimes/claude-code.ts';
import * as gemini from '../../agents/runtimes/gemini.ts';
import { type GcEntry, sweepFinishedDesks, sweepLines } from '../../agents/desk/gc.ts';
import { readOpenPullBranches } from '../../host/github/board-pulls.ts';
import { ghIn } from '../../host/github/index.ts';
import { hostOf } from '../../host/hosts.ts';
import { DEFAULTS, type Env, loadConfig } from '../../rules/config.ts';
import { workerRole } from '../../rules/guards.ts';
import { canKeepStatus, changeAgentStatus, findStatusCheckout, startFields } from '../../run/hook.ts';
import { formatFinding } from '../../rules/message.ts';
import { hideHome } from '../../rules/privacy.ts';
import { draft, facts, table } from '../../setup/advice/adopt.ts';
import { explain, explainLines, ids } from '../../setup/advice/explain.ts';
import { blocksToSay, doctor, OUTPUT_STOP, SERVER_TIMEOUT_MS, type SessionStart, UNFILTERED } from '../../setup/doctor/index.ts';
import { READERS } from '../hook.ts';
import { type Invocation, noRootFinding, parse, print, printJson, requireRoot, rootOf, say, usage } from '../shared.ts';
import { writeLeadSession } from './board/feed/read/logs.ts';

/** What full doctor says while the slow reads run: the server read and (in WSL) the drive read. */
const SLOW_READ_LINE = 'reading GitHub settings...';

export function runDoctor(invocation: Invocation): number {
  const { env, cwd } = invocation;
  const options = parse('doctor', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const agent = options.values['--agent'] ?? 'claude-code';
  if (!Object.hasOwn(READERS, agent)) return usage(invocation, `unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  const session = options.flags.has('--session');
  const root = rootOf(cwd, invocation.env);
  const config = root ? loadConfig(root) : DEFAULTS;
  // One line while the slow reads run. A session never reads the server, and --json
  // keeps stdout to the report, so the line shows on a terminal only, in full doctor.
  if (root && !session && !options.flags.has('--json') && invocation.stdout.isTTY === true) say(invocation, `${SLOW_READ_LINE}\n`, invocation.stdout);
  const { ok, lines: allLines, blocks, report } = doctor(root, { env, config, session, gh: root ? ghIn(root, env, SERVER_TIMEOUT_MS) : undefined, fillMarks: !session });
  // Full doctor outside a repo says so (#205). A session there stays quiet: no noise in a non-repo folder.
  if (!root && !session) {
    const missing = noRootFinding(cwd, invocation.env);
    if (options.flags.has('--json')) printJson(invocation, { ...report, ok: false, findings: [...report.findings, missing] });
    else print(invocation, [...allLines, `yokoten doctor: ${formatFinding(missing)}`], invocation.stderr);
    return 1;
  }
  const start = root && session && agent === 'claude-code' ? readSessionStart(invocation) : null;
  if (root && session) noteSessionStart(cwd, env, agent, start?.model ?? '', start?.transcriptPath ?? '');
  // A compaction start repeats only what changed (#405); any other start says all.
  const lines = root && session && blocks && !options.flags.has('--json') ? blocksToSay(env, start, blocks).flat() : allLines;
  // A desk that named a vendor other than the harness's (#748) speaks first: the agent
  // learns who it is before the harness's prompt tells it about its own maker.
  const identity = root && session && !options.flags.has('--json') ? identityLine(agent, env) : '';
  if (identity) lines.unshift(identity);
  // A worker, by YOKOTEN_ROLE or by the mark on its worktree (#555), hears that the guard sees
  // it as one (#402), on every start, a compaction too: its role is safety, never news to
  // drop. The lead hears nothing.
  const role = root && session && blocks && !options.flags.has('--json') ? workerRole(env, [cwd]) : null;
  if (role) lines.push(`yokoten: ${role === 'mark' ? WORKER_MARKED : WORKER_SESSION}.`);
  // Doctor reads (#708): it says what `yokoten gc` would remove, and removes nothing. A
  // session start never waits for a fetch, so only a full run asks.
  if (root && !session) {
    const desks = planFinishedDesks(invocation, root);
    report.desks = desks;
    if (!options.flags.has('--json')) lines.push(...finishedDeskLines(desks, env));
  }
  // An agent that can't filter command output hears it at session start, with the opt-in (#390).
  if (root && session && agent !== 'claude-code' && config.privacy.output !== 'stop') lines.push(`yokoten: ${UNFILTERED}. ${OUTPUT_STOP[0].toUpperCase()}${OUTPUT_STOP.slice(1)}.`);
  if (options.flags.has('--json')) printJson(invocation, report);
  // Gemini CLI reads a SessionStart hook's context from JSON only (#211).
  else if (session && agent === 'gemini') {
    if (lines.length) say(invocation, `${gemini.formatSessionContext(hideHome(lines.join('\n'), env))}\n`, invocation.stdout);
  } else print(invocation, lines);
  // A session must start even when doctor found a problem.
  return session || ok ? 0 : 1;
}

/**
 * The session's status file at its start (#685): who runs (vendor, model), in which role
 * (by the guard's own rule), where, and that it works. The board reads it. The model
 * comes from the runtime, or else YOKOTEN_MODEL, which the board sets when it starts one.
 * A lead also records `transcriptPath` for the board (#700). A worker never does.
 */
function noteSessionStart(cwd: string, env: Invocation['env'], agent: string, model: string, transcriptPath: string): void {
  const isWorker = workerRole(env, [cwd]) !== null;
  if (!isWorker && transcriptPath) writeLeadSession(cwd, transcriptPath);
  const checkout = findStatusCheckout(cwd);
  if (!checkout || !canKeepStatus(checkout, isWorker)) return;
  const fields = startFields(agent, isWorker, checkout, model || (env.YOKOTEN_MODEL ?? '').trim().slice(0, 64));
  changeAgentStatus(checkout, { ...fields, set: { ...fields.set, doing: 'started', blocked: null } });
}

const WORKER_SESSION = 'this session is a worker: lead-only files are guarded';
const WORKER_MARKED = 'this session is a worker, because its worktree or clone carries the worker mark: lead-only files are guarded, and the lead pushes after review';

/** How long a session start waits for the hook's event on stdin, at most. */
const STDIN_WAIT_MS = 300;
/** The most of stdin read: an event is a few hundred bytes. */
const STDIN_LIMIT = 1 << 20;

/**
 * The SessionStart event Claude Code writes to stdin, or null when it gives none. It never
 * waits on a terminal, and never longer than STDIN_WAIT_MS on a pipe that stays open.
 */
function readSessionStart({ env, stdin }: Invocation): (SessionStart & { transcriptPath?: string }) | null {
  // Reading the process's stdin stream opens it first. For a pipe, libuv then puts the fd
  // in non-blocking mode, so readSync below throws EAGAIN in place of waiting for a writer
  // that never closes. A file, such as /dev/null, reads to its end at once.
  if (!claudeCode.hasSessionInput(env, stdin.stream.isTTY === true)) return null;
  const { fd } = stdin;
  const toEvent = (text: string) => {
    try {
      return claudeCode.readSessionStart(JSON.parse(text));
    } catch {
      return null;
    }
  };
  // A test's stdin is its text, all there at once.
  if (fd === null) return toEvent(stdin.text ?? '');
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + STDIN_WAIT_MS;
  const parsed = () => toEvent(Buffer.concat(chunks).toString('utf8'));
  for (let size = 0; size < STDIN_LIMIT; ) {
    let count = 0;
    try {
      count = readSync(fd, buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') break;
      // Nothing to read yet: a whole event read so far is enough; else wait a little.
      if (parsed() || Date.now() > deadline) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
    size += count;
  }
  return parsed();
}

export function runExplain(invocation: Invocation): number {
  const options = parse('explain', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [id] = options.positional;
  if (id === undefined) {
    if (options.flags.has('--json')) printJson(invocation, { ids: ids() });
    else print(invocation, [`Ids: ${ids().join(', ')}`]);
    return 0;
  }
  const found = explain(id);
  if (options.flags.has('--json')) printJson(invocation, found ? { found: true, ...found } : { id, found: false, ids: ids() });
  else if (found) print(invocation, explainLines(found));
  else print(invocation, [`yokoten explain: no rule or step is called ${id}.`, `Ids: ${ids().join(', ')}`], invocation.stderr);
  return found ? 0 : 1;
}

export function runAdopt(invocation: Invocation): number | Promise<number> {
  const { env } = invocation;
  // Reads files and asks the model; never writes a file or changes config.
  const options = parse('adopt', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  return draft(facts(root, env), { env }).then((drafted) => {
    if (options.flags.has('--json')) {
      printJson(invocation, drafted.rows.map(({ key, status, evidence, decision, reason }) => ({ key, status, evidence, decision, reason })));
      print(invocation, [`yokoten adopt: drafted by ${drafted.by}${drafted.note ? `, because ${drafted.note}` : ''}. You decide every row.`], invocation.stderr);
    } else print(invocation, table(drafted));
    return 0;
  });
}

/** The origin remote's URL, or '' when there is none. */
function originUrl(root: string, env: Env): string {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

/**
 * The branches of the open pull requests that keep a desk (#708), or null when they can't
 * be read. A checkout with no GitHub origin has none: no pull request can name its branch.
 */
export function openPullBranchesFor(root: string, env: Env): string[] | null {
  const host = hostOf(originUrl(root, env));
  if (host.kind !== 'github') return [];
  const answer = readOpenPullBranches(ghIn(root, env, SERVER_TIMEOUT_MS), host.repo);
  return typeof answer === 'string' ? null : answer;
}

/** `yokoten gc [--dry-run]`. Exit 1 when a desk that should have gone could not. */
export function runGc(invocation: Invocation): number {
  const options = parse('gc', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = rootOf(invocation.cwd, invocation.env);
  if (root === null) return usage(invocation, 'run it inside the repo whose desks you want to sweep');
  if (workerRole(invocation.env, [invocation.cwd]) !== null) return usage(invocation, 'only the lead sweeps desks: this session is a worker');
  const isDryRun = options.flags.has('--dry-run');
  const result = sweepFinishedDesks(root, { env: invocation.env, keep: root, isDryRun, openPullBranches: openPullBranchesFor(root, invocation.env) });
  print(invocation, sweepLines(result, invocation.env));
  return result.failed.length ? 1 : 0;
}

/**
 * What a sweep would do, for doctor: read only, and no fetch. Empty for a worker or a repo
 * the sweep can't read. The desks a root holds are in the list too, marked `keep`.
 */
export function planFinishedDesks(invocation: Invocation, root: string): GcEntry[] {
  if (workerRole(invocation.env, [invocation.cwd]) !== null) return [];
  try {
    return sweepFinishedDesks(root, { env: invocation.env, keep: root, isDryRun: true, openPullBranches: openPullBranchesFor(root, invocation.env) }).entries;
  } catch {
    // Doctor must never fail on the sweep.
    return [];
  }
}

/** Doctor's lines about desks: what `yokoten gc` would remove, and what it can't decide. */
export function finishedDeskLines(entries: GcEntry[], env: Invocation['env']): string[] {
  const removable = entries.filter((entry) => entry.decision === 'remove');
  const toCheck = entries.filter((entry) => entry.decision === 'list');
  if (!removable.length && !toCheck.length) return [];
  const desks = (count: number) => `${count} desk${count === 1 ? '' : 's'}`;
  const need = (count: number) => (count === 1 ? 'needs' : 'need');
  const lines = [`yokoten doctor: \`yokoten gc\` would remove ${desks(removable.length)}; ${desks(toCheck.length)} ${need(toCheck.length)} a look by hand.`];
  for (const entry of removable) lines.push(`  would remove ${entry.path}: ${entry.reason}`);
  for (const entry of toCheck) lines.push(`  check ${entry.path}: ${entry.reason}`);
  return hideHome(lines.join('\n'), env).split('\n');
}

/**
 * The sweep at the end of a desk: no line when nothing went and nothing needs a look. A
 * worker never sweeps another session's desk.
 */
export function sweepQuietly(invocation: Invocation, root: string): string[] {
  if (workerRole(invocation.env, [invocation.cwd]) !== null) return [];
  try {
    const result = sweepFinishedDesks(root, { env: invocation.env, keep: root, openPullBranches: openPullBranchesFor(root, invocation.env) });
    if (!result.removed.length && !result.entries.some((entry) => entry.decision === 'list')) return [];
    return sweepLines(result, invocation.env);
  } catch {
    // The sweep is a convenience: the end of a desk must never fail on it.
    return [];
  }
}
