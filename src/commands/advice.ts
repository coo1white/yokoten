// `yokoten doctor`, `explain` and `adopt`: they read a project and advise. None writes to
// the project; a Claude Code session start keeps what it said in ~/.config/yokoten/sessions/ (#405).

import { readSync } from 'node:fs';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import { ghIn } from '../host/github.ts';
import { DEFAULTS, loadConfig } from '../rules/config.ts';
import { formatFinding } from '../rules/message.ts';
import { hideHome } from '../rules/privacy.ts';
import { draft, facts, table } from '../setup/advice/adopt.ts';
import { explain, explainLines, ids } from '../setup/advice/explain.ts';
import { blocksToSay, doctor, OUTPUT_STOP, type SessionStart, UNFILTERED } from '../setup/doctor.ts';
import { READERS } from './hook.ts';
import { env, noRootFinding, parse, print, printJson, requireRoot, rootOf, say, usage } from './shared.ts';

export function runDoctor(): number {
  const options = parse('doctor');
  if (typeof options === 'string') return usage(options);
  const agent = options.values['--agent'] ?? 'claude-code';
  if (!Object.hasOwn(READERS, agent)) return usage(`unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  const session = options.flags.has('--session');
  const root = rootOf(process.cwd());
  const config = root ? loadConfig(root) : DEFAULTS;
  const { ok, lines: allLines, blocks, report } = doctor(root, { env, config, session, gh: root ? ghIn(root) : undefined, fillMarks: !session });
  // Full doctor outside a repo says so (#205). A session there stays quiet: no noise in a non-repo folder.
  if (!root && !session) {
    const missing = noRootFinding(process.cwd());
    if (options.flags.has('--json')) printJson({ ...report, ok: false, findings: [...report.findings, missing] });
    else print([...allLines, `yokoten doctor: ${formatFinding(missing)}`], process.stderr);
    return 1;
  }
  // A compaction start repeats only what changed (#405); any other start says all.
  const lines = root && session && blocks && !options.flags.has('--json') ? blocksToSay(env, agent === 'claude-code' ? readSessionStart() : null, blocks).flat() : allLines;
  // An agent that can't filter command output hears it at session start, with the opt-in (#390).
  if (root && session && agent !== 'claude-code' && config.privacy.output !== 'stop') lines.push(`yokoten: ${UNFILTERED}. ${OUTPUT_STOP[0].toUpperCase()}${OUTPUT_STOP.slice(1)}.`);
  if (options.flags.has('--json')) printJson(report);
  // Gemini CLI reads a SessionStart hook's context from JSON only (#211).
  else if (session && agent === 'gemini') {
    if (lines.length) say(`${gemini.formatSessionContext(hideHome(lines.join('\n'), env))}\n`, process.stdout);
  } else print(lines);
  // A session must start even when doctor found a problem.
  return session || ok ? 0 : 1;
}

/** How long a session start waits for the hook's event on stdin, at most. */
const STDIN_WAIT_MS = 300;
/** The most of stdin read: an event is a few hundred bytes. */
const STDIN_LIMIT = 1 << 20;

/**
 * The SessionStart event Claude Code writes to stdin, or null when it gives none. It never
 * waits on a terminal, and never longer than STDIN_WAIT_MS on a pipe that stays open.
 */
function readSessionStart(): SessionStart | null {
  // Reading process.stdin opens stdin as a stream first. For a pipe, libuv then puts the fd
  // in non-blocking mode, so readSync below throws EAGAIN in place of waiting for a writer
  // that never closes. A file, such as /dev/null, reads to its end at once.
  if (!claudeCode.hasSessionInput(env, process.stdin.isTTY === true)) return null;
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + STDIN_WAIT_MS;
  const parsed = () => {
    try {
      return claudeCode.readSessionStart(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      return null;
    }
  };
  for (let size = 0; size < STDIN_LIMIT; ) {
    let count = 0;
    try {
      count = readSync(0, buffer);
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

export function runExplain(): number {
  const options = parse('explain');
  if (typeof options === 'string') return usage(options);
  const [id] = options.positional;
  if (id === undefined) {
    if (options.flags.has('--json')) printJson({ ids: ids() });
    else print([`Ids: ${ids().join(', ')}`]);
    return 0;
  }
  const found = explain(id);
  if (options.flags.has('--json')) printJson(found ? { found: true, ...found } : { id, found: false, ids: ids() });
  else if (found) print(explainLines(found));
  else print([`yokoten explain: no rule or step is called ${id}.`, `Ids: ${ids().join(', ')}`], process.stderr);
  return found ? 0 : 1;
}

export function runAdopt(): number | Promise<number> {
  // Reads files and asks the model; never writes a file or changes config.
  const options = parse('adopt');
  if (typeof options === 'string') return usage(options);
  const root = requireRoot(process.cwd());
  if (!root) return 1;
  return draft(facts(root, env), { env }).then((drafted) => {
    if (options.flags.has('--json')) {
      printJson(drafted.rows.map(({ key, status, evidence, decision, reason }) => ({ key, status, evidence, decision, reason })));
      print([`yokoten adopt: drafted by ${drafted.by}${drafted.note ? `, because ${drafted.note}` : ''}. You decide every row.`], process.stderr);
    } else print(table(drafted));
    return 0;
  });
}
