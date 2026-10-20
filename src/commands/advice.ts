// `yokoten doctor`, `explain` and `adopt`: they read a project and advise; none writes a file.

import { fstatSync, readFileSync } from 'node:fs';
import * as gemini from '../agents/runtimes/gemini.ts';
import { ghIn } from '../host/github.ts';
import { DEFAULTS, loadConfig } from '../rules/config.ts';
import { formatFinding } from '../rules/message.ts';
import { hideHome } from '../rules/privacy.ts';
import { draft, facts, table } from '../setup/advice/adopt.ts';
import { explain, explainLines, ids } from '../setup/advice/explain.ts';
import { doctor, OUTPUT_STOP, UNFILTERED } from '../setup/doctor.ts';
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
  const { ok, lines, report } = doctor(root, { env, config, session, gh: root ? ghIn(root) : undefined, fillMarks: !session });
  // Full doctor outside a repo says so (#205). A session there stays quiet: no noise in a non-repo folder.
  if (!root && !session) {
    const missing = noRootFinding(process.cwd());
    if (options.flags.has('--json')) printJson({ ...report, ok: false, findings: [...report.findings, missing] });
    else print([...lines, `yokoten doctor: ${formatFinding(missing)}`], process.stderr);
    return 1;
  }
  // An agent that can't filter command output hears it at session start, with the opt-in (#390).
  // A worker hears that the guard sees it as one, so a missing role shows up (#402). The lead hears nothing.
  if (root && session && isWorkerSession(agent)) lines.push(`yokoten: ${WORKER_SESSION}.`);
  if (root && session && agent !== 'claude-code' && config.privacy.output !== 'stop') lines.push(`yokoten: ${UNFILTERED}. ${OUTPUT_STOP[0].toUpperCase()}${OUTPUT_STOP.slice(1)}.`);
  if (options.flags.has('--json')) printJson(report);
  // Gemini CLI reads a SessionStart hook's context from JSON only (#211).
  else if (session && agent === 'gemini') {
    if (lines.length) say(`${gemini.formatSessionContext(hideHome(lines.join('\n'), env))}\n`, process.stdout);
  } else print(lines);
  // A session must start even when doctor found a problem.
  return session || ok ? 0 : 1;
}

const WORKER_SESSION = 'this session is a worker: lead-only files are guarded';

/**
 * Whether the session is a worker: YOKOTEN_ROLE=worker, or a hook call whose agent type
 * names a worker, read by the agent's own tool-call reader. The hook's input is read from
 * stdin only when it is a pipe, a socket or a file, never a terminal, which would wait for
 * typing.
 */
function isWorkerSession(agent: string): boolean {
  if (env.YOKOTEN_ROLE === 'worker') return true;
  try {
    const stdin = fstatSync(0);
    if (!stdin.isFIFO() && !stdin.isFile() && !stdin.isSocket()) return false;
    return READERS[agent](JSON.parse(readFileSync(0, 'utf8'))).worker;
  } catch {
    return false;
  }
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
