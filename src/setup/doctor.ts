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
import { loadMarks, notUtc, POSITIVE_CONTROL, scanText } from '../rules/privacy.ts';
import { SECRET_CONTROL } from '../rules/secrets.ts';
import { check } from '../run/check.ts';
import { hasSessionDoctor } from '../agents/claude-code.ts';
import * as codex from '../agents/codex.ts';
import * as gemini from '../agents/gemini.ts';
import { runtimeVersion, VERSION } from './files.ts';
import { paths } from './install.ts';
import { road, STAGES, walk } from './road.ts';

/** One check outside the road: its name, whether it is in place, and the fix. */
interface Practice {
  name: string;
  ok: boolean;
  fix: string;
}

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
    { name: 'codex-hook', ok: codex.hasProjectHook(root), fix: 'no tool-call guard in .codex/hooks.json; `yokoten init` adds it' },
    { name: 'gemini-hook', ok: gemini.hasProjectHook(root), fix: 'no tool-call guard in .gemini/settings.json; `yokoten init` adds it' },
  ];
}

/** Machine checks: the user-level hooks, the runtime, the private marks. The skills are a step on the road. */
export function machineChecks(env: Env): Practice[] {
  const p = paths(env);
  const runtime = runtimeVersion(p.runtime);
  return [
    { name: 'session-doctor', ok: hasSessionDoctor(env), fix: 'sessions do not start with doctor' },
    { name: 'runtime', ok: runtime === VERSION, fix: runtime ? `the installed runtime is ${runtime}, this yokoten is ${VERSION}` : 'no runtime installed' },
    { name: 'private-marks', ok: loadMarks(env).length > 0, fix: `${p.marks} is missing or empty, so the privacy check only knows emails and IPs` },
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

/** The report, and whether everything is in place. */
export function doctor(root: string | null, { env, config, session = false }: { env: Env; config: Config; session?: boolean }): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const broken = selfTest();
  if (broken.length) lines.push(`yokoten is BROKEN: ${broken.join(', ')} let a known-bad input through. Do not trust any check until this is fixed.`);
  if (!root) return { ok: broken.length === 0, lines };

  const where = walk(road(root, env), config.notNow);
  const machine = machineChecks(env);

  // A session reads files only, never the network, so it starts fast and works offline.
  if (session) {
    const { stage, next } = where;
    if (stage && next) lines.push(`yokoten: stage ${stage} of ${STAGES.length}, ${STAGES[stage - 1]}. Next: ${next.what(root, env)}.`, `Why: ${next.why}.`, OFFER);
    else lines.push(ROAD_DONE);
    // Not a step on the road, but the privacy check is weaker until it is fixed.
    const marks = machine.find((c) => c.name === 'private-marks' && !c.ok);
    if (marks) lines.push(`yokoten: ${marks.fix}.`);
    return { ok: !broken.length && !where.next, lines };
  }

  lines.push(`yokoten ${VERSION}, self-test ${broken.length ? 'FAILED' : 'ok'}`);
  lines.push(where.stage ? `the road: stage ${where.stage} of ${STAGES.length}, ${STAGES[where.stage - 1]}` : `the road: ${ROAD_DONE.replace(/^yokoten: /, '')}`);
  STAGES.forEach((name, i) => {
    lines.push(`  ${i + 1}. ${name}`);
    for (const { step, mark } of where.steps.filter((w) => w.step.stage === i + 1)) {
      const note = mark === 'done' ? '' : mark === 'not now' ? config.notNow[step.key] : mark === "can't check" ? '' : step.what(root, env);
      lines.push(`    ${mark.padEnd(11)} ${step.key}${step.standard ? ` (${step.standard})` : ''}${note ? `: ${note}` : ''}`);
    }
  });
  lines.push('project:');
  for (const c of agentHooks(root)) lines.push(`  ${c.ok ? 'ok     ' : 'note   '} ${c.name}${c.ok ? '' : `: ${c.fix}`}`);
  const problems = check(root, { config, env });
  lines.push(`  ${problems.length ? 'MISSING' : 'ok     '} tree: ${problems.length ? `${problems.length} problem(s), run \`yokoten check\`` : 'layout and privacy clean'}`);
  lines.push('machine:');
  for (const c of machine) lines.push(`  ${c.ok ? 'ok     ' : 'MISSING'} ${c.name}${c.ok ? '' : `: ${c.fix}`}`);
  lines.push('server (not checked yet; set once per repo by the owner):', ...OWNER_STEPS.map((s, i) => `  ${i + 1}. ${s}`));
  return { ok: !broken.length && !where.next && !problems.length && machine.every((c) => c.ok), lines };
}
