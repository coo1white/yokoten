// `yokoten hook`: the tool-call guard, and with --stop the end-of-turn check.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as antigravity from '../agents/runtimes/antigravity.ts';
import * as claudeCode from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as muse from '../agents/runtimes/muse.ts';
import { loadConfig } from '../rules/config.ts';
import { type Finding, formatFinding } from '../rules/message.ts';
import { checkChanged } from '../run/check.ts';
import { type Action, guardDeadline, judgeWithDeadline, loadHookConfig, type Repo } from '../run/hook.ts';
import { bullets, env, parse, print, printJson, rootOf, say, usage } from './shared.ts';

// Each runtime sends its tool call in its own shape; its adapter turns it into an Action.
export const READERS: Record<string, (input: unknown) => Action> = {
  'claude-code': claudeCode.readToolCall,
  codex: codex.readToolCall,
  gemini: gemini.readToolCall,
  antigravity: antigravity.readToolCall,
  muse: muse.readToolCall,
};

// What a runtime reads on stdout when a call is refused, and the exit code it wants. The
// others take the reason on stderr and exit 2, with nothing on stdout. Muse Code takes
// either; stderr and exit 2 is the simpler one, and the model sees the same reason.
const DENIALS: Record<string, (reason: string) => { stdout: string; exitCode: number }> = {
  'claude-code': claudeCode.formatDenial,
  antigravity: antigravity.formatDenial,
};

// Each runtime's event for the end of a turn: Claude Code's, Codex's and Muse Code's Stop, Gemini CLI's AfterAgent (#211).
const STOP_READERS: Record<string, typeof claudeCode.readStop> = {
  'claude-code': claudeCode.readStop,
  codex: codex.readStop,
  gemini: gemini.readStop,
  muse: muse.readStop,
};

/**
 * The yokoten repos (those with a `yokoten.json`) an edit's files are in, past the
 * session's own (#307). A worktree in another folder, or a session started above the repo,
 * loads no project hook, so the guard applies the file's own repo's rules. One `rootOf`
 * per folder and one config per repo. A command's paths count too: Codex runs apply_patch
 * through the shell (#221).
 */
function editRepos(action: Action, base: string, session: Repo | null, commandsOnly: boolean): Repo[] {
  const rootByFolder = new Map<string, string | null>([[base, session?.root ?? null]]);
  const repos = new Map<string, Repo | null>();
  // In the full hook, the session's root already has its rules.
  if (session) repos.set(session.root, commandsOnly && existsSync(join(session.root, 'yokoten.json')) ? session : null);
  for (const path of action.paths) {
    let folder = dirname(resolve(base, path));
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    if (!rootByFolder.has(folder)) rootByFolder.set(folder, rootOf(folder));
    const root = rootByFolder.get(folder);
    if (!root || repos.has(root)) continue;
    repos.set(root, existsSync(join(root, 'yokoten.json')) ? { root, config: loadHookConfig(root, (line) => say(`${line}\n`, process.stderr)) } : null);
  }
  return [...repos.values()].filter((repo) => repo !== null);
}

/**
 * The stop check (#92). The agent runs it when it is about to end its turn
 * (code.claude.com/docs/en/hooks#stop). Findings in the changed files send the agent back
 * once: exit 2, with the findings on stderr as the reason. `stop_hook_active` means it was
 * already sent back, so the turn ends whatever is found: never a loop. On any error the
 * turn ends too, with one line on stderr: a broken check must not trap a session.
 */
function stopHook(json: boolean, read: typeof claudeCode.readStop): number {
  let event: ReturnType<typeof claudeCode.readStop>;
  try {
    event = read(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    event = null;
  }
  if (!event) {
    if (json) printJson({ blocked: false, stop: false });
    return 0;
  }
  if (event.active) {
    if (json) printJson({ blocked: false, stop: true, skipped: 'the agent was already sent back once', findings: [] });
    return 0;
  }
  let findings: Finding[];
  try {
    const root = rootOf(event.cwd ?? process.cwd());
    findings = root ? checkChanged(root, { config: loadConfig(root), env }) : [];
  } catch (err) {
    say(`yokoten hook --stop: skipped, ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, process.stderr);
    if (json) printJson({ blocked: false, stop: true, skipped: 'the check failed', findings: [] });
    return 0;
  }
  if (json) printJson({ blocked: findings.length > 0, stop: true, findings });
  if (!findings.length) return 0;
  // Each runtime gives stderr to the agent as the reason to go on when this hook exits 2.
  print([`yokoten: ${findings.length} problem(s) in the changed files. Fix them before you end the turn:`, ...bullets(findings)], process.stderr);
  return 2;
}

export function runHook(): number | Promise<number> {
  const options = parse('hook');
  if (typeof options === 'string') return usage(options);
  const json = options.flags.has('--json');
  const agent = options.values['--agent'] ?? 'claude-code';
  if (options.flags.has('--stop')) {
    if (options.flags.has('--commands-only')) return usage("--stop and --commands-only can't be used together");
    if (!Object.hasOwn(STOP_READERS, agent)) return usage(`unknown --agent ${agent}; use one of: ${Object.keys(STOP_READERS).join(', ')}`);
    return stopHook(json, STOP_READERS[agent]);
  }
  const read = Object.hasOwn(READERS, agent) ? READERS[agent] : undefined;
  if (!read) return usage(`unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`);
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // Not a tool call; nothing to judge. A runtime never sends one, and blocking here
    // would stop every tool call the day a runtime changes its input.
    if (json) printJson({ blocked: false, toolCall: false });
    return 0;
  }
  const action = read(input);
  const root = rootOf(action.cwd ?? process.cwd());
  const config = loadHookConfig(root, (line) => say(`${line}\n`, process.stderr));
  const commandsOnly = options.flags.has('--commands-only');
  const repos = editRepos(action, action.cwd ?? root ?? process.cwd(), root ? { root, config } : null, commandsOnly);
  const judged = judgeWithDeadline(action, { root, config, env, commandsOnly, repos }, guardDeadline(env.YOKOTEN_GUARD_DEADLINE_MS));
  return judged.then((found) => {
    if (json) printJson(found ? { blocked: true, finding: found } : { blocked: false, toolCall: true });
    if (!found) return 0;
    // The runtimes read the reason from stderr when the hook exits 2; some read stdout (DENIALS).
    const reason = `yokoten: ${formatFinding(found)}`;
    say(`${reason}\n`, process.stderr);
    const denial = Object.hasOwn(DENIALS, agent) ? DENIALS[agent](reason) : { stdout: '', exitCode: 2 };
    if (!json && denial.stdout) say(denial.stdout, process.stdout);
    return json ? 2 : denial.exitCode;
  });
}
