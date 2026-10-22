// `yokoten doctor`, `explain` and `adopt`: they read and show; none writes to the project.
// A Claude Code session start keeps what it said in ~/.config/yokoten/sessions/ (#405).

import { readSync } from 'node:fs';
import * as claudeCode from '../../agents/runtimes/claude-code.ts';
import * as gemini from '../../agents/runtimes/gemini.ts';
import { ghIn } from '../../host/github/index.ts';
import { DEFAULTS, loadConfig } from '../../rules/config.ts';
import { workerRole } from '../../rules/guards.ts';
import { formatFinding } from '../../rules/message.ts';
import { hideHome } from '../../rules/privacy.ts';
import { draft, facts, table } from '../../setup/advice/adopt.ts';
import { explain, explainLines, ids } from '../../setup/advice/explain.ts';
import { blocksToSay, doctor, OUTPUT_STOP, SERVER_TIMEOUT_MS, type SessionStart, UNFILTERED } from '../../setup/doctor.ts';
import { READERS } from '../hook.ts';
import { type Invocation, noRootFinding, parse, print, printJson, requireRoot, rootOf, say, usage } from '../shared.ts';

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
  // A compaction start repeats only what changed (#405); any other start says all.
  const lines = root && session && blocks && !options.flags.has('--json') ? blocksToSay(env, agent === 'claude-code' ? readSessionStart(invocation) : null, blocks).flat() : allLines;
  // A worker, by YOKOTEN_ROLE or by the mark on its worktree (#555), hears that the guard sees
  // it as one (#402), on every start, a compaction too: its role is safety, never news to
  // drop. The lead hears nothing.
  const role = root && session && blocks && !options.flags.has('--json') ? workerRole(env, [cwd]) : null;
  if (role) lines.push(`yokoten: ${role === 'mark' ? WORKER_MARKED : WORKER_SESSION}.`);
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

const WORKER_SESSION = 'this session is a worker: lead-only files are guarded';
const WORKER_MARKED = 'this session is a worker, because its worktree carries the worker mark: lead-only files are guarded, and the lead pushes after review';

/** How long a session start waits for the hook's event on stdin, at most. */
const STDIN_WAIT_MS = 300;
/** The most of stdin read: an event is a few hundred bytes. */
const STDIN_LIMIT = 1 << 20;

/**
 * The SessionStart event Claude Code writes to stdin, or null when it gives none. It never
 * waits on a terminal, and never longer than STDIN_WAIT_MS on a pipe that stays open.
 */
function readSessionStart({ env, stdin }: Invocation): SessionStart | null {
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
