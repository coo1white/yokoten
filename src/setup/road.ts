// The road (record 0004): five stages, a few steps in each, and every step a check yokoten
// can run. A step with no check yet is not in the table; #10, #34, #35 and #7 add theirs.
//
// The stage is worked out from what the project has, never saved: it is the stage of the
// first step that is neither done nor "not now". The order is advice, not a gate: a later
// step done early counts as done.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { hasProjectHook } from '../agents/claude-code.ts';
import { runs } from '../run/cli.ts';
import { hasBot } from '../host/github.ts';
import { KIT, runtimeVersion, VERSION } from './files.ts';
import { isSelf } from './init.ts';
import { skillFiles, skillsDir } from './install.ts';

/** The stage names, in order. A step's `stage` is its number here, from 1. */
export const STAGES = ['safety net', 'issues and pull requests', 'release', 'a team of agents', 'going public'];

/** What a check found: done, not done, or null when yokoten can't check it here. */
export type Found = boolean | null;

export interface Step {
  stage: number;
  /** The step's name, and its key in yokoten.json "notNow". */
  key: string;
  check: (root: string, env: Env) => Found;
  /** What is missing, said when the step is not done. No full stop at the end. */
  what: (root: string, env: Env) => string;
  /** Why the step matters, in one plain sentence. No full stop at the end. */
  why: string;
  /** The outside standard the step meets, when there is one (#58). */
  standard?: string;
}

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

export const gitConfig = (root: string, key: string) => {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const ciText = (root: string) => {
  const dir = join(root, '.github', 'workflows');
  return existsSync(dir) ? readdirSync(dir).map((f) => read(join(dir, f))).join('\n') : '';
};

const TODO_FILES = ['TODO.md', 'TODO', 'todo.md', 'docs/todo'];
// Names as the folder lists them: on a case-insensitive disk (macOS) TODO.md also "exists" as todo.md.
const listed = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
export const todoFiles = (root: string) => TODO_FILES.filter((p) => listed(join(root, dirname(p))).includes(basename(p)));

export const hasIssueTemplate = (root: string) => {
  const dir = join(root, '.github', 'ISSUE_TEMPLATE');
  return existsSync(dir) && readdirSync(dir).some((f) => /\.(ya?ml|md)$/i.test(f));
};
export const hasPrTemplate = (root: string) => ['pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md'].some((f) => existsSync(join(root, '.github', f)));

/**
 * The kit's skills not yet in every skills folder, as "folder (names)"; empty when all are
 * in. Null when this copy of yokoten has no kit to compare with: a vendored project copy
 * has none, the machine copy and the source do.
 */
export function skillsLacking(env: Env): string[] | null {
  const kitSkills = join(KIT, 'user', 'skills');
  if (!existsSync(kitSkills)) return null;
  const lacking = new Map<string, string[]>();
  for (const name of readdirSync(kitSkills)) {
    for (const file of skillFiles(env, name)) if (!existsSync(file)) lacking.set(skillsDir(file), [...(lacking.get(skillsDir(file)) ?? []), name]);
  }
  return [...lacking].map(([dir, names]) => `${dir} (${names.join(', ')})`);
}

const SECURITY_FILES: [string, string[]][] = [
  ['security policy (SECURITY.md)', ['.github/SECURITY.md', 'SECURITY.md']],
  ['Dependabot config', ['.github/dependabot.yml', '.github/dependabot.yaml']],
  ['license file', ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']],
];
export const securityLacking = (root: string) => SECURITY_FILES.filter(([, paths]) => !paths.some((p) => existsSync(join(root, p)))).map(([name]) => name);

/** The road, in order. Step names never change: they are the keys for "not now". */
export const ROAD: Step[] = [
  {
    stage: 1,
    key: 'rules',
    check: (root) => existsSync(join(root, 'AGENTS.md')),
    what: () => 'no AGENTS.md, so the agents have no written rules here; `yokoten init` adds one',
    why: 'an agent follows the rules it can read, and only those',
  },
  {
    stage: 1,
    key: 'tool-hook',
    check: (root) => hasProjectHook(root),
    what: () => 'no tool-call guard in .claude/settings.json; `yokoten init` adds it',
    why: 'the guard stops a risky command, like a force push, before the agent runs it',
  },
  {
    stage: 1,
    key: 'commit-check',
    check: (root) => gitConfig(root, 'core.hooksPath') === '.githooks' && runs('check').test(read(join(root, '.githooks', 'pre-commit'))),
    what: () => 'commits are not checked: core.hooksPath is not .githooks, or .githooks/pre-commit does not run yokoten; `yokoten init` sets both',
    why: 'a secret or a personal email is hard to take back once a commit is pushed',
  },
  {
    stage: 1,
    key: 'runtime',
    check: (root) => isSelf(root) || runtimeVersion(join(root, '.yokoten')) === VERSION,
    what: (root) => {
      const vendored = runtimeVersion(join(root, '.yokoten'));
      return vendored ? `.yokoten/ is ${vendored}, this yokoten is ${VERSION}; run \`yokoten init\` to update it` : 'no .yokoten/ runtime; `yokoten init` adds it';
    },
    why: 'the hooks and CI run this copy, so they work with no network and no global install',
  },
  {
    stage: 2,
    key: 'ci',
    // `check --pr` is the titles step; this one wants the tree check itself.
    check: (root) => runs('check(?!\\s+--pr)').test(ciText(root)),
    what: () => 'CI does not run `yokoten check`; `yokoten init` adds .github/workflows/yokoten.yml',
    why: 'a commit made with the hook off would reach main unchecked',
  },
  {
    stage: 2,
    key: 'issues',
    check: (root) => todoFiles(root).length === 0,
    what: (root) => `a todo file (${todoFiles(root).join(', ')}): move each item to an issue, then delete it`,
    why: 'an issue has an owner, a state and a history; a todo file has none',
  },
  {
    stage: 2,
    key: 'templates',
    check: (root) => hasIssueTemplate(root) && hasPrTemplate(root),
    what: (root) => {
      const lacking = [hasIssueTemplate(root) ? '' : 'issue templates', hasPrTemplate(root) ? '' : 'pull request template'].filter(Boolean);
      return `no ${lacking.join(' and no ')} in .github; \`yokoten init\` adds them`;
    },
    why: 'a template asks for what a reviewer needs, so nothing is forgotten',
  },
  {
    stage: 3,
    key: 'changelog',
    check: (root) => /^#+\s*\[?Unreleased\]?/im.test(read(join(root, 'CHANGELOG.md'))),
    what: () => 'no CHANGELOG.md with an "Unreleased" section; add one, with a line for each change that users notice',
    why: 'each pull request adds its line as it goes, so a release needs no digging',
  },
  {
    stage: 3,
    key: 'titles',
    check: (root) => runs('check --pr').test(ciText(root)),
    what: () => 'CI does not check pull requests (`yokoten check --pr`); `yokoten init` adds .github/workflows/pr.yml',
    why: 'a pull request title becomes the commit on main, so it must say what changed and why',
  },
  {
    stage: 4,
    key: 'codeowners',
    check: (root) => ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].some((p) => existsSync(join(root, p))),
    what: () => 'no CODEOWNERS file; add .github/CODEOWNERS with the line `* @<your account>`',
    why: 'the host then asks you to review every pull request an agent opens',
  },
  {
    stage: 4,
    key: 'bot',
    check: (_root, env) => hasBot(env),
    what: () => 'no bot on this machine (YOKOTEN_BOT_APP_ID and its key file); yokoten\'s docs/server.md shows how to set one up',
    why: 'when the bot opens pull requests, you review work you did not write, as a team does',
  },
  {
    stage: 4,
    key: 'skills',
    check: (_root, env) => {
      const lacking = skillsLacking(env);
      return lacking && lacking.length === 0;
    },
    what: (_root, env) => `the yokoten skills are not in ${(skillsLacking(env) ?? []).join(' or ')}; run \`yokoten install\``,
    why: 'the skills show an agent how to hand off work, review it and find the cause of a failure',
  },
  {
    stage: 5,
    key: 'security-files',
    check: (root) => securityLacking(root).length === 0,
    what: (root) => `no ${securityLacking(root).join(', no ')}; \`yokoten init\` adds the security policy and Dependabot, and you choose the license`,
    why: 'people can then report a hole in private, old dependencies get updates, and others know how they may use the code',
  },
];

/** How a step shows in the map. */
export type Mark = 'done' | 'next' | 'to do' | 'not now' | "can't check";

export interface Walked {
  step: Step;
  mark: Mark;
}

/**
 * Where a project is on the road. `next` is the first step that is neither done nor "not
 * now", and `stage` is its stage; both are null when nothing is left. A step yokoten
 * can't check here never holds the stage: a session can do nothing about it.
 */
export function walk(found: { step: Step; found: Found }[], notNow: Record<string, string>): { stage: number | null; next: Step | null; steps: Walked[] } {
  let next: Step | null = null;
  const steps = found.map(({ step, found: f }): Walked => {
    if (f === true) return { step, mark: 'done' };
    if (Object.hasOwn(notNow, step.key)) return { step, mark: 'not now' };
    if (f === null) return { step, mark: "can't check" };
    if (next) return { step, mark: 'to do' };
    next = step;
    return { step, mark: 'next' };
  });
  const first = next as Step | null;
  return { stage: first ? first.stage : null, next: first, steps };
}

/** Run every check on the road for this project. */
export function road(root: string, env: Env, steps: Step[] = ROAD): { step: Step; found: Found }[] {
  return steps.map((step) => ({ step, found: step.check(root, env) }));
}
