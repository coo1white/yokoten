// `yokoten doctor`: a guide along the road (record 0004), and a check that this machine
// still runs the practices.
//
// Copying a setup once is not enough; it drifts. So doctor runs at the start of every
// session (`--session`, via the hook install adds). A beginner can't take in a list of
// everything missing, so a session hears three lines: the stage, the one next step, and
// why. Full `doctor` shows the whole map. A project that decided against a step says so
// in yokoten.json "notNow", and doctor stops asking.
//
// Doctor first checks itself: it feeds each check a known-bad input and expects a catch.
// A check that passes everything looks the same as a healthy project, so this comes first.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand, checkEdit } from '../rules/guards.ts';
import { type Config, DEFAULTS, type Env } from '../rules/config.ts';
import { checkBuildOutput, checkLayout } from '../rules/layout.ts';
import { type Finding, finding, formatFinding, type RuleId } from '../rules/message.ts';
import { loadMarks, notUtc, POSITIVE_CONTROL, scanText } from '../rules/privacy.ts';
import { SECRET_CONTROL } from '../rules/secrets.ts';
import { check } from '../run/check.ts';
import { hasSessionDoctor } from '../agents/claude-code.ts';
import * as codex from '../agents/codex.ts';
import * as gemini from '../agents/gemini.ts';
import { runtimeVersion, VERSION } from './files.ts';
import { paths } from './install.ts';
import { type Mark, road, STAGES, stepFinding, stepText, walk } from './road.ts';

/** One check outside the road: its name in the report, whether it is in place, and the finding when it is not. */
interface Practice {
  name: string;
  ok: boolean;
  finding: Finding;
}

const practice = (name: string, id: RuleId, ok: boolean, what: string, fix: string): Practice => ({ name, ok, finding: finding(id, what, fix) });

/** The checks that must catch a known-bad input. Returns the names of any that did not. */
export function selfTest(): string[] {
  const failed: string[] = [];
  if (!checkCommand('git push origin --tags', { env: {} })) failed.push('release guard');
  if (!checkCommand('git commit --no-verify -m x', { env: {} })) failed.push('skip-check guard');
  if (!checkEdit('test/a.test.ts', { config: DEFAULTS, env: { YOKOTEN_FIX_TASK: '1' } })) failed.push('test guard');
  if (!checkEdit('AGENTS.md', { config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' } })) failed.push('lead-only guard');
  if (scanText(POSITIVE_CONTROL, { file: 'control' }).length < 2) failed.push('privacy check');
  if (scanText(SECRET_CONTROL, { file: 'control' }).length < 2) failed.push('secret check');
  if (!notUtc('A <a@example.com> 1760745600 +0700') || notUtc('A <a@example.com> 1760745600 +0000')) failed.push('time zone check');
  if (checkLayout(Array.from({ length: 8 }, (_, i) => `d/${i}`), DEFAULTS).length !== 1) failed.push('layout check');
  if (checkBuildOutput([{ path: 'dist/a.js', binary: false }, { path: 'a.bin', binary: true }], DEFAULTS).length !== 2) failed.push('build output check');
  failed.push(...roadControl());
  return failed;
}

/**
 * The other agents' tool-call hooks. Reported, but not a missing practice yet: no real
 * Codex or Gemini CLI run has been seen to block through them (#30), and a project that
 * uses neither should not fail doctor over them.
 */
export function agentHooks(root: string): Practice[] {
  return [
    practice('codex-hook', 'codex-hook', codex.hasProjectHook(root), 'no tool-call guard in .codex/hooks.json', '`yokoten init` adds it'),
    practice('gemini-hook', 'gemini-hook', gemini.hasProjectHook(root), 'no tool-call guard in .gemini/settings.json', '`yokoten init` adds it'),
  ];
}

/** Machine checks: the user-level hooks, the runtime, the private marks. The skills are a step on the road. */
export function machineChecks(env: Env): Practice[] {
  const p = paths(env);
  const runtime = runtimeVersion(p.runtime);
  return [
    practice('session-doctor', 'session-doctor', hasSessionDoctor(env), 'sessions do not start with doctor', 'run `yokoten install`'),
    // 'runtime' in the text, as before; the id differs from the road's runtime step.
    practice('runtime', 'machine-runtime', runtime === VERSION, runtime ? `the installed runtime is ${runtime}, this yokoten is ${VERSION}` : 'no runtime installed', 'run `yokoten install` from this copy of yokoten'),
    practice('private-marks', 'private-marks', loadMarks(env).length > 0, `${p.marks} is missing or empty`, 'add your name, city, domain and server names to it, one per line'),
  ];
}

// What doctor cannot see yet and the owner sets once per repo, on the server. Kept to three
// (record 0001), so the security switches (#35) share the last step with the bot.
/** In a folder with nothing but a todo file, and a home with nothing in it, no step on the road may be done. */
function roadControl(): string[] {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'yokoten-control-'));
    writeFileSync(join(dir, 'TODO.md'), '- an item\n');
    return road(dir, { HOME: dir })
      .filter((r) => r.found === true)
      .map((r) => `the ${r.step.key} step`);
  } catch {
    return []; // no temp folder to test in; the other checks still run
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const OWNER_STEPS = [
  'main: a ruleset with pull request required, the CI check required, no force push, no deletion; squash merge only, delete branch on merge',
  'tags: a ruleset on v* so only you create, move or delete a release tag',
  'the bot and security: a collaborator (or GitHub App) with write access and no Workflows permission; CODEOWNERS with you, and code owner review required; in Settings, Advanced Security, turn on private vulnerability reporting, secret scanning with push protection, and Dependabot alerts',
];

/** What a session hears when the road is done, as far as yokoten can check. */
export const ROAD_DONE = 'yokoten: every step yokoten can check is done, or marked not now.';

/** The last of a session's three lines: what the agent does with the step. */
export const OFFER = 'Tell the user in plain words, one step at a time, and offer to do it (as-is, lighter, or not now with a reason).';

/** One step in the JSON map: its mark, its outside standard, and the reason for "not now". */
export interface StepState {
  id: string;
  stage: number;
  mark: Mark;
  standard?: string;
  reason?: string;
}

/**
 * What `doctor --json` prints. `findings` is everything to do, each with what, why and
 * fix; `notes` never fail doctor. A session (`--session`) gets the next step and the
 * private-marks finding only, as its three lines do.
 */
export interface DoctorReport {
  version: string;
  ok: boolean;
  selfTest: { ok: boolean; failed: string[] };
  /** False outside a git repo: then there is no road to walk. */
  repo: boolean;
  stage: number | null;
  stages: string[];
  next: Finding | null;
  findings: Finding[];
  steps?: StepState[];
  notes?: Finding[];
  server?: string[];
}

/** The report, as text lines and as data, and whether everything is in place. */
export function doctor(
  root: string | null,
  { env, config, session = false }: { env: Env; config: Config; session?: boolean },
): { ok: boolean; lines: string[]; report: DoctorReport } {
  const lines: string[] = [];
  const failed = selfTest();
  const findings: Finding[] = [];
  if (failed.length) {
    lines.push(`yokoten is BROKEN: ${failed.join(', ')} let a known-bad input through. Do not trust any check until this is fixed.`);
    findings.push(finding('self-test', `${failed.join(', ')} let a known-bad input through`, 'do not trust any check until this is fixed; run `yokoten install` again, or report it in an issue'));
  }
  const base = { version: VERSION, selfTest: { ok: !failed.length, failed }, stages: STAGES };
  if (!root) return { ok: !failed.length, lines, report: { ...base, ok: !failed.length, repo: false, stage: null, next: null, findings } };

  const where = walk(road(root, env), config.notNow);
  const machine = machineChecks(env);
  const next = where.next ? stepFinding(where.next, root, env) : null;

  // A session reads files only, never the network, so it starts fast and works offline.
  if (session) {
    const { stage } = where;
    if (stage && next) lines.push(`yokoten: stage ${stage} of ${STAGES.length}, ${STAGES[stage - 1]}. Next: ${stepText(next)}.`, `Why: ${next.why}.`, OFFER);
    else lines.push(ROAD_DONE);
    if (next) findings.push(next);
    // Not a step on the road, but the privacy check is weaker until it is fixed.
    const marks = machine.find((c) => c.name === 'private-marks' && !c.ok);
    if (marks) {
      lines.push(`yokoten: ${formatFinding(marks.finding)}`);
      findings.push(marks.finding);
    }
    const ok = !failed.length && !next;
    return { ok, lines, report: { ...base, ok, repo: true, stage, next, findings } };
  }

  lines.push(`yokoten ${VERSION}, self-test ${failed.length ? 'FAILED' : 'ok'}`);
  lines.push(where.stage ? `the road: stage ${where.stage} of ${STAGES.length}, ${STAGES[where.stage - 1]}` : `the road: ${ROAD_DONE.replace(/^yokoten: /, '')}`);
  const steps: StepState[] = [];
  STAGES.forEach((name, i) => {
    lines.push(`  ${i + 1}. ${name}`);
    for (const { step, mark } of where.steps.filter((w) => w.step.stage === i + 1)) {
      const state: StepState = { id: step.key, stage: step.stage, mark };
      if (step.standard) state.standard = step.standard;
      let note = '';
      if (mark === 'not now') note = state.reason = config.notNow[step.key];
      else if (mark === 'next' || mark === 'to do') {
        const f = stepFinding(step, root, env);
        findings.push(f);
        note = stepText(f);
      }
      steps.push(state);
      lines.push(`    ${mark.padEnd(11)} ${step.key}${step.standard ? ` (${step.standard})` : ''}${note ? `: ${note}` : ''}`);
    }
  });
  lines.push('project:');
  const notes: Finding[] = [];
  for (const c of agentHooks(root)) {
    lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? '' : `: ${stepText(c.finding)}`}`);
    if (!c.ok) notes.push(c.finding);
  }
  const problems = check(root, { config, env });
  findings.push(...problems);
  lines.push(`  ${problems.length ? 'MISSING' : 'ok     '} tree: ${problems.length ? `${problems.length} problem(s), run \`yokoten check\`` : 'layout and privacy clean'}`);
  lines.push('machine:');
  for (const c of machine) {
    lines.push(`  ${c.ok ? 'ok     ' : 'MISSING'} ${c.name}${c.ok ? '' : `: ${stepText(c.finding)}`}`);
    if (!c.ok) findings.push(c.finding);
  }
  lines.push('server (not checked yet; set once per repo by the owner):', ...OWNER_STEPS.map((s, i) => `  ${i + 1}. ${s}`));
  const ok = !failed.length && !where.next && !problems.length && machine.every((c) => c.ok);
  return { ok, lines, report: { ...base, ok, repo: true, stage: where.stage, next, findings, steps, notes, server: OWNER_STEPS } };
}
