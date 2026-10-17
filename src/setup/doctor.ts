// `yokoten doctor`: is this project, and this machine, still running the practices?
//
// Copying a setup once is not enough; it drifts. So doctor runs at the start of every
// session (`--session`, via the hook install adds) and says what is missing, in a few
// lines the agent reads before anything else. A project that decided against a practice
// says so in yokoten.json "notNow", and doctor stops asking.
//
// Doctor first checks itself: it feeds each check a known-bad input and expects a catch.
// A check that passes everything looks the same as a healthy project, so this comes first.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCommand, checkEdit } from '../rules/guards.ts';
import { type Config, DEFAULTS, type Env } from '../rules/config.ts';
import { checkLayout } from '../rules/layout.ts';
import { loadMarks, notUtc, POSITIVE_CONTROL, scanText } from '../rules/privacy.ts';
import { SECRET_CONTROL } from '../rules/secrets.ts';
import { check } from '../run/check.ts';
import { hasProjectHook, hasSessionDoctor } from '../agents/claude-code.ts';
import { runs } from '../run/cli.ts';
import { KIT, runtimeVersion, VERSION } from './files.ts';
import { isSelf } from './init.ts';
import { paths, skillFiles, skillsDir } from './install.ts';

/** One practice: its name (the key for "notNow"), whether it is in place, and the fix. */
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
  return failed;
}

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const gitConfig = (root: string, key: string) => {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/** Each practice a project should run. */
export function projectChecks(root: string): Practice[] {
  const workflows = join(root, '.github', 'workflows');
  const ciText = existsSync(workflows) ? readdirSync(workflows).map((f) => read(join(workflows, f))).join('\n') : '';
  const vendored = runtimeVersion(join(root, '.yokoten'));
  return [
    { name: 'rules', ok: existsSync(join(root, 'AGENTS.md')), fix: 'no AGENTS.md: the agents have no written rules here' },
    {
      name: 'commit-check',
      ok: gitConfig(root, 'core.hooksPath') === '.githooks' && runs('check').test(read(join(root, '.githooks', 'pre-commit'))),
      fix: 'commits are not checked (core.hooksPath is not .githooks, or .githooks/pre-commit does not run yokoten)',
    },
    { name: 'tool-hook', ok: hasProjectHook(root), fix: 'no tool-call guard in .claude/settings.json' },
    { name: 'ci', ok: runs('check').test(ciText), fix: 'CI does not run `yokoten check`, so a commit made without the hook gets through' },
    {
      name: 'runtime',
      ok: isSelf(root) || vendored === VERSION,
      fix: vendored ? `.yokoten/ is ${vendored}, this yokoten is ${VERSION}: run \`yokoten init\` to update it` : 'no .yokoten/ runtime',
    },
    {
      name: 'issues',
      ok: !['TODO.md', 'TODO', 'todo.md', 'docs/todo'].some((p) => existsSync(join(root, p))),
      fix: 'a todo file or folder: move each item to an issue (an issue has an owner, a state and a history; a file has none)',
    },
  ];
}

/** Machine checks: the skills, the user-level hooks, the private marks. */
export function machineChecks(env: Env): Practice[] {
  const p = paths(env);
  const kitSkills = join(KIT, 'user', 'skills');
  // A vendored project copy has no kit; the machine copy and the source do.
  const skills = existsSync(kitSkills) ? readdirSync(kitSkills) : [];
  // Every skill in every folder; the fix names each folder and what it lacks.
  const lacking = new Map<string, string[]>();
  for (const name of skills) {
    for (const file of skillFiles(env, name)) if (!existsSync(file)) lacking.set(skillsDir(file), [...(lacking.get(skillsDir(file)) ?? []), name]);
  }
  const skillsFix = skills.length === 0 ? 'the yokoten skills are not installed' : `not in ${[...lacking].map(([dir, names]) => `${dir} (${names.join(', ')})`).join(' or ')}; run \`yokoten install\``;
  const runtime = runtimeVersion(p.runtime);
  return [
    { name: 'skills', ok: skills.length > 0 && lacking.size === 0, fix: skillsFix },
    { name: 'session-doctor', ok: hasSessionDoctor(env), fix: 'sessions do not start with doctor' },
    { name: 'runtime', ok: runtime === VERSION, fix: runtime ? `the installed runtime is ${runtime}, this yokoten is ${VERSION}` : 'no runtime installed' },
    { name: 'private-marks', ok: loadMarks(env).length > 0, fix: `${p.marks} is missing or empty, so the privacy check only knows emails and IPs` },
  ];
}

// What doctor cannot see yet and the owner sets once per repo, on the server. Kept to three
// (record 0001), so the security switches (#35) share the last step with the bot.
const OWNER_STEPS = [
  'main: a ruleset with pull request required, the CI check required, no force push, no deletion; squash merge only, delete branch on merge',
  'tags: a ruleset on v* so only you create, move or delete a release tag',
  'the bot and security: a collaborator (or GitHub App) with write access and no Workflows permission; CODEOWNERS with you, and code owner review required; in Settings, Advanced Security, turn on private vulnerability reporting, secret scanning with push protection, and Dependabot alerts',
];

/** The report, and whether everything is in place. */
export function doctor(root: string | null, { env, config, session = false }: { env: Env; config: Config; session?: boolean }): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const broken = selfTest();
  if (broken.length) lines.push(`yokoten is BROKEN: ${broken.join(', ')} let a known-bad input through. Do not trust any check until this is fixed.`);
  if (!root) return { ok: broken.length === 0, lines };

  const missing: string[] = [];
  const notNow: string[] = [];
  for (const c of projectChecks(root)) {
    if (c.ok) continue;
    if (config.notNow[c.name]) notNow.push(`${c.name}: ${config.notNow[c.name]}`);
    else missing.push(`${c.name}: ${c.fix}`);
  }
  const machine = machineChecks(env).filter((c) => !c.ok);

  if (session) {
    if (missing.length) {
      lines.push(`yokoten: this project is missing ${missing.length} practice(s):`, ...missing.map((m) => `- ${m}`));
      lines.push('Tell the user, and offer the yokoten skill to adopt them (each one: as-is, lighter, or not now with a reason).');
    }
    const marks = machine.find((c) => c.name === 'private-marks');
    if (marks) lines.push(`yokoten: ${marks.fix}.`);
    return { ok: !broken.length && !missing.length, lines };
  }

  lines.push(`yokoten ${VERSION}, self-test ${broken.length ? 'FAILED' : 'ok'}`);
  lines.push('project:');
  for (const c of projectChecks(root)) lines.push(`  ${c.ok ? 'ok     ' : config.notNow[c.name] ? 'not now' : 'MISSING'} ${c.name}${c.ok ? '' : `: ${config.notNow[c.name] ?? c.fix}`}`);
  const problems = check(root, { config, env });
  lines.push(`  ${problems.length ? 'MISSING' : 'ok     '} tree: ${problems.length ? `${problems.length} problem(s), run \`yokoten check\`` : 'layout and privacy clean'}`);
  lines.push('machine:');
  for (const c of machineChecks(env)) lines.push(`  ${c.ok ? 'ok     ' : 'MISSING'} ${c.name}${c.ok ? '' : `: ${c.fix}`}`);
  lines.push('server (not checked yet; set once per repo by the owner):', ...OWNER_STEPS.map((s, i) => `  ${i + 1}. ${s}`));
  return { ok: !broken.length && !missing.length && !problems.length && !machine.length, lines };
}
