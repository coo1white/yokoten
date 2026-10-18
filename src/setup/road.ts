// The road (record 0004): five stages, a few steps in each, and every step a check yokoten
// can run. A step with no check yet is not in the table; #10, #34 and #35 add theirs.
//
// The server steps (#7) judge what the host adapter read. Only full doctor reads the host;
// a session passes nothing, so those steps are "can't check" there and never hold the stage.
//
// The stage is worked out from what the project has, never saved: it is the stage of the
// first step that is neither done nor "not now". The order is advice, not a gate: a later
// step done early counts as done.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Env, loadConfig } from '../rules/config.ts';
import { matcher } from '../rules/config.ts';
import { type Finding, finding, type RuleId } from '../rules/message.ts';
import { CHANGES_DIR } from '../rules/pr.ts';
import { BUILD_DIRS, isBuildOutput } from '../rules/layout.ts';
import { hasPlugin, hasProjectHook } from '../agents/claude-code.ts';
import { runs } from '../run/cli.ts';
import { hasBot, type ServerSettings, type Unread } from '../host/github.ts';
import { KIT, runtimeVersion, VERSION } from './files.ts';
import { isSelf } from './init.ts';
import { skillFiles, skillsDir } from './install.ts';

/** The stage names, in order. A step's `stage` is its number here, from 1. */
export const STAGES = ['safety net', 'issues and pull requests', 'release', 'a team of agents', 'going public'];

/** What a check found: done, not done, or null when yokoten can't check it here. */
export type Found = boolean | null;

/**
 * What full doctor read from the code host, or why it could not. Undefined in a session,
 * which never calls the network.
 */
export type ServerRead = ServerSettings | Unread | undefined;

export interface Step {
  stage: number;
  /** The step's name, and its key in yokoten.json "notNow". */
  key: string;
  check: (root: string, env: Env, server: ServerRead) => Found;
  /** What is missing, said when the step is not done. No full stop at the end. */
  what: (root: string, env: Env, server: ServerRead) => string;
  /** What to do about it: a command or an edit. No full stop at the end. */
  fix: (root: string, env: Env, server: ServerRead) => string;
  /** Why yokoten can't check the step here, and what to do. Only server steps have it. No full stop at the end. */
  unchecked?: (server: ServerRead) => string;
  /** Why the step matters, in one plain sentence. No full stop at the end. */
  why: string;
  /** How yokoten checks it, for `yokoten explain`. No full stop at the end. */
  how: string;
  /**
   * The outside standard the step meets, when there is one (#58): "<standard>: <item>",
   * or an item id alone (OSPS-BR-07.01). Several are joined by " · ". Only a standard we
   * have read is named.
   */
  standard?: string;
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
const todoFiles = (root: string) => TODO_FILES.filter((p) => listed(join(root, dirname(p))).includes(basename(p)));

const hasIssueTemplate = (root: string) => {
  const dir = join(root, '.github', 'ISSUE_TEMPLATE');
  return existsSync(dir) && readdirSync(dir).some((f) => /\.(ya?ml|md)$/i.test(f));
};
const hasPrTemplate = (root: string) => ['pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md'].some((f) => existsSync(join(root, '.github', f)));

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

// The test command, from package.json. npm's placeholder script, which only fails, is no command.
const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
const testScript = (root: string): string => {
  try {
    const script = JSON.parse(read(join(root, 'package.json')) || '{}')?.scripts?.test;
    return typeof script === 'string' && script.trim() && script.trim() !== NPM_PLACEHOLDER ? script.trim() : '';
  } catch {
    return '';
  }
};
// A command that runs the package.json script, and runners that need no script.
const RUNS_SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b/;
const RUNNERS = /\b(?:node\s+--test|deno\s+test|go\s+test|cargo\s+test|pytest|mvn\s+test|gradle\s+test)\b/;
/** Whether CI runs the tests: the package.json script, or a test runner named outright. */
const ciRunsTests = (root: string) => {
  const ci = ciText(root);
  const script = testScript(root);
  return RUNNERS.test(ci) || (script !== '' && (RUNS_SCRIPT.test(ci) || ci.includes(script)));
};

/** Tracked build output, as yokoten.json lets it through; null outside a git repo. */
const builtFiles = (root: string): string[] | null => {
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
  let allow: (path: string) => boolean = () => false;
  try {
    allow = matcher(loadConfig(root).allowBuild);
  } catch {
    // a broken yokoten.json: the commit check names it; here, nothing is allowed
  }
  return files.filter((f) => isBuildOutput(f, allow));
};

const SECURITY_FILES: [string, string[]][] = [
  ['security policy (SECURITY.md)', ['.github/SECURITY.md', 'SECURITY.md']],
  ['Dependabot config', ['.github/dependabot.yml', '.github/dependabot.yaml']],
  ['license file', ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']],
];
const securityLacking = (root: string) => SECURITY_FILES.filter(([, paths]) => !paths.some((p) => existsSync(join(root, p)))).map(([name]) => name);

// The server settings (#7), judged. Each setting is one check with its own rule id, so
// `yokoten explain main-rules` works. The road groups them into three steps.

/** One server setting as doctor reports it. A "can't check" or a note never fails doctor. */
export interface ServerCheck {
  id: RuleId;
  mark: 'ok' | 'MISSING' | "can't check" | 'note';
  finding: Finding;
}

const RULESET = 'in Settings, Rules, Rulesets, edit the ruleset on the default branch';

/** Each server setting, judged. `settings` is what the host adapter read, or why it could not. */
export function serverChecks(settings: ServerSettings | Unread): ServerCheck[] {
  const cant = (id: RuleId, u: Unread): ServerCheck => ({ id, mark: "can't check", finding: finding(id, `can't check: ${u.unread}`, u.fix) });
  if ('unread' in settings) return [cant('server-settings', settings)];
  const judge = (id: RuleId, found: boolean | Unread | null, what: string, fix: string): ServerCheck => {
    if (found === null) return cant(id, { unread: 'only a repo admin can see this setting', fix: 'run doctor signed in to gh as a repo admin' });
    if (typeof found !== 'boolean') return cant(id, found);
    return { id, mark: found ? 'ok' : 'MISSING', finding: finding(id, what, fix) };
  };
  const { branch, security: sec } = settings;
  const rules = 'unread' in branch ? null : branch;
  const lacking = rules ? [rules.pullRequest ? '' : 'a pull request', rules.noForcePush ? '' : 'no force push', rules.noDeletion ? '' : 'no deletion'].filter(Boolean) : [];
  const squash = rules?.mergeMethods.length ? rules.mergeMethods.join() === 'squash' : settings.mergeMethods && settings.mergeMethods.join() === 'squash';
  const off = ([['secret scanning', sec.secretScanning], ['push protection', sec.pushProtection], ['private vulnerability reporting', sec.privateReporting], ['Dependabot alerts', sec.dependabotAlerts]] as const)
    .filter(([, on]) => on === false).map(([name]) => name);
  const unknown = Object.values(sec).some((on) => on === null);
  const checks = [
    judge('main-rules', rules ? !lacking.length : branch as Unread, `the default branch (${settings.defaultBranch}) has no rule for ${lacking.join(', ')}`, `${RULESET}, or add one, and turn those rules on`),
    judge('required-checks', rules ? rules.requiredChecks.length > 0 : branch as Unread, 'no CI check must pass before a merge', `${RULESET}: require status checks, and add the CI check by name (yokoten's kit names it \`ci\`)`),
    judge('code-owner-review', rules ? rules.codeOwnerReview : branch as Unread, 'code owner review is not required', `${RULESET}: in "Require a pull request", turn on "Require review from Code Owners"`),
    judge('squash-only', squash, 'pull requests can merge by merge commit or rebase, not only by squash', 'in Settings, General, Pull Requests, allow squash merging only'),
    judge('delete-branch', settings.deleteBranchOnMerge, 'merged branches are not deleted', 'in Settings, General, Pull Requests, turn on "Automatically delete head branches"'),
    judge('tag-rules', settings.tags, 'no active tag ruleset on v* that restricts creation, update and deletion', 'in Settings, Rules, Rulesets, add a tag ruleset on v* with those three rules, and you on the bypass list'),
    judge('security-switches', off.length ? false : unknown ? null : true, `${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} off`, 'in Settings, Advanced Security, turn them on'),
  ];
  const { forgotten } = settings;
  if ('unread' in forgotten) checks.push(cant('forgotten-branches', forgotten));
  else if (forgotten.length) {
    const named = `${forgotten.slice(0, 3).join(', ')}${forgotten.length > 3 ? `, and ${forgotten.length - 3} more` : ''}`;
    checks.push({ id: 'forgotten-branches', mark: 'note', finding: finding('forgotten-branches', `${forgotten.length} branch(es) with no open pull request (${named})`, 'open a pull request for each, or delete the ones you no longer need; doctor never deletes a branch') });
  }
  return checks;
}

/** The server checks behind each road step. `server-settings` and `forgotten-branches` stay outside the road. */
const SERVER_STEPS: Record<string, RuleId[]> = {
  protection: ['main-rules', 'required-checks', 'code-owner-review', 'tag-rules'],
  'merge-settings': ['squash-only', 'delete-branch'],
  'security-settings': ['security-switches'],
};

/** Every server check that a road step reports. */
export const ROAD_SERVER_IDS: RuleId[] = Object.values(SERVER_STEPS).flat();

const SESSION_UNREAD: Unread = { unread: 'a session never calls the network', fix: 'run `yokoten doctor`' };

/** The checks behind one step, and `server-settings` when nothing could be read. */
const stepChecks = (key: string, server: ServerRead) =>
  serverChecks(server ?? SESSION_UNREAD).filter((c) => c.id === 'server-settings' || SERVER_STEPS[key].includes(c.id));

/** Not done when a check is MISSING; can't check when a check is unread; done when all are ok. */
const judgeServer = (key: string, server: ServerRead): Found => {
  const checks = stepChecks(key, server);
  if (checks.some((c) => c.mark === 'MISSING')) return false;
  return checks.some((c) => c.mark === "can't check") ? null : true;
};

/** One field of each check with this mark, joined by "; ", or `fallback` when no check has the mark. */
const joinChecks = (key: string, server: ServerRead, mark: ServerCheck['mark'], field: 'what' | 'fix', fallback: string) => {
  const texts = stepChecks(key, server).filter((c) => c.mark === mark).map((c) => c.finding[field].replace(/^can't check: /, ''));
  return texts.length ? [...new Set(texts)].join('; ') : fallback;
};

/** A stage 5 step made from server checks. `lacking` and `fix` are said when no check has its own words. */
const serverStep = (key: string, fields: { lacking: string; fix: string; why: string; how: string; standard?: string }): Step => ({
  stage: 5,
  key,
  check: (...[, , server]) => judgeServer(key, server),
  what: (...[, , server]) => joinChecks(key, server, 'MISSING', 'what', fields.lacking),
  fix: (...[, , server]) => joinChecks(key, server, 'MISSING', 'fix', fields.fix),
  unchecked: (server) => `${joinChecks(key, server, "can't check", 'what', 'nothing was read')}; ${joinChecks(key, server, "can't check", 'fix', 'run `yokoten doctor`')}`,
  why: fields.why,
  how: fields.how,
  ...(fields.standard ? { standard: fields.standard } : {}),
});

// The review step (#59): a merge to the default branch needs one approval. The bot opens
// the pull requests, so the owner is not their author and can approve them. A private
// repo on a free plan has no rulesets: the step waits for stage 5, when the repo goes
// public. That shows as "can't check", which never holds the stage. It is not "not now":
// that mark is the owner's own decision in yokoten.json, and doctor never makes it for them.

/** The branch rules full doctor read, or why there are none to judge. */
const reviewRules = (server: ServerRead) => {
  const settings = server ?? SESSION_UNREAD;
  if ('unread' in settings) return settings;
  if (!('unread' in settings.branch)) return settings.branch;
  if (settings.isPrivate && /GitHub Pro/.test(settings.branch.unread)) return { unread: `${settings.branch.unread}, so no rule can ask for an approval yet; this step waits for stage 5, when the repo goes public`, fix: 'or upgrade to GitHub Pro and run doctor again' };
  return settings.branch;
};

const reviewStep: Step = {
  stage: 4,
  key: 'review',
  check: (...[, , server]) => {
    const rules = reviewRules(server);
    return 'unread' in rules ? null : rules.approvals >= 1;
  },
  what: () => 'a merge to the default branch needs no approving review',
  fix: () => `${RULESET}: in "Require a pull request", set "Required approvals" to 1. You can't approve your own pull request, so let the bot open them`,
  unchecked: (server) => {
    const rules = reviewRules(server);
    return 'unread' in rules ? `${rules.unread}; ${rules.fix}` : '';
  },
  why: 'the bot opens the pull requests, so you approve work you did not write, and nothing merges unread',
  how: 'through the code host\'s API, in full doctor only: a ruleset (or the old branch protection) on the default branch asks for at least 1 approving review; a private repo without rulesets waits for stage 5',
  standard: 'Scorecard: Code-Review',
};

/** The road, in order. Step names never change: they are the keys for "not now". */
export const ROAD: Step[] = [
  {
    stage: 1,
    key: 'rules',
    check: (root) => existsSync(join(root, 'AGENTS.md')),
    what: () => 'no AGENTS.md, so the agents have no written rules here',
    fix: () => '`yokoten init` adds one',
    why: 'an agent follows the rules it can read, and only those',
    how: 'AGENTS.md is at the repo root',
    standard: 'OpenSSF: AI code assistant instructions',
  },
  {
    stage: 1,
    key: 'tool-hook',
    check: (root) => hasProjectHook(root),
    what: () => 'no tool-call guard in .claude/settings.json',
    fix: () => '`yokoten init` adds it',
    why: 'the guard stops a risky command, like a force push, before the agent runs it',
    how: '.claude/settings.json has a PreToolUse hook that runs `yokoten hook`',
  },
  {
    stage: 1,
    key: 'commit-check',
    check: (root) => gitConfig(root, 'core.hooksPath') === '.githooks' && runs('check').test(read(join(root, '.githooks', 'pre-commit'))),
    what: () => 'commits are not checked: core.hooksPath is not .githooks, or .githooks/pre-commit does not run yokoten',
    fix: () => '`yokoten init` sets both',
    why: 'a secret or a personal email is hard to take back once a commit is pushed',
    how: 'git config core.hooksPath is .githooks, and .githooks/pre-commit runs `yokoten check`',
    standard: 'OSPS-BR-07.01',
  },
  {
    stage: 1,
    key: 'runtime',
    check: (root) => isSelf(root) || runtimeVersion(join(root, '.yokoten')) === VERSION,
    what: (root) => {
      const vendored = runtimeVersion(join(root, '.yokoten'));
      return vendored ? `.yokoten/ is ${vendored}, this yokoten is ${VERSION}` : 'no .yokoten/ runtime';
    },
    fix: (root) => (runtimeVersion(join(root, '.yokoten')) ? 'run `yokoten init` to update it' : '`yokoten init` adds it'),
    why: 'the hooks and CI run this copy, so they work with no network and no global install',
    how: '.yokoten/VERSION is the version of the yokoten that runs doctor; yokoten\'s own repo needs no copy',
  },
  {
    stage: 1,
    key: 'tests',
    check: (root) => ciRunsTests(root),
    what: (root) => (testScript(root) ? 'CI does not run the tests' : 'no test command: no "test" script in package.json, and no workflow runs a test runner'),
    fix: (root) => (testScript(root) ? 'add a step that runs `npm test` (or your test command) to a workflow in .github/workflows' : 'add tests and a CI step that runs them'),
    why: 'tests that run on every push catch a broken change before it reaches main',
    how: 'package.json has a real "test" script and a workflow in .github/workflows runs it, or a workflow runs a test runner such as `node --test` or `go test`',
    standard: 'Best Practices: test',
  },
  {
    stage: 2,
    key: 'ci',
    // `check --pr` is the titles step, and `check --issue` checks issues; this one wants the tree check itself.
    check: (root) => runs('check(?!\\s+--(?:pr|issue))').test(ciText(root)),
    what: () => 'CI does not run `yokoten check`',
    fix: () => '`yokoten init` adds .github/workflows/yokoten.yml',
    why: 'a commit made with the hook off would reach main unchecked',
    how: 'a workflow in .github/workflows runs `yokoten check`',
    standard: 'Scorecard: CI-Tests',
  },
  {
    stage: 2,
    key: 'issues',
    check: (root) => todoFiles(root).length === 0,
    what: (root) => `a todo file (${todoFiles(root).join(', ')})`,
    fix: () => 'move each item to an issue, then delete the file',
    why: 'an issue has an owner, a state and a history; a todo file has none',
    how: 'there is no TODO.md, TODO, todo.md or docs/todo',
    standard: 'OSPS-GV-02.01',
  },
  {
    stage: 2,
    key: 'templates',
    check: (root) => hasIssueTemplate(root) && hasPrTemplate(root),
    what: (root) => {
      const lacking = [hasIssueTemplate(root) ? '' : 'issue templates', hasPrTemplate(root) ? '' : 'pull request template'].filter(Boolean);
      return `no ${lacking.join(' and no ')} in .github`;
    },
    fix: () => '`yokoten init` adds them',
    why: 'a template asks for what a reviewer needs, so nothing is forgotten',
    how: '.github/ISSUE_TEMPLATE holds a template, and .github holds a pull request template',
    standard: 'GitHub community profile',
  },
  {
    stage: 2,
    key: 'no-build-output',
    check: (root) => {
      const built = builtFiles(root);
      return built && built.length === 0;
    },
    what: (root) => {
      const built = builtFiles(root) ?? [];
      return `build output in the repo (${built.slice(0, 3).join(', ')}${built.length > 3 ? `, and ${built.length - 3} more` : ''})`;
    },
    fix: () => `remove it with \`git rm --cached\` and add ${BUILD_DIRS.map((d) => `${d}/`).join(', ')} to .gitignore`,
    why: 'a build makes these files again from the source, and a reviewer can\'t read a binary',
    how: 'no tracked file is in a dist/, build/ or out/ folder or is a built file by its name, apart from yokoten.json "allowBuild"',
    standard: 'Scorecard: Binary-Artifacts',
  },
  {
    stage: 3,
    key: 'changelog',
    // A changes/ folder (#132) counts too: its files become the Unreleased lines at a release.
    check: (root) => /^#+\s*\[?Unreleased\]?/im.test(read(join(root, 'CHANGELOG.md'))) || existsSync(join(root, CHANGES_DIR)),
    what: () => `no CHANGELOG.md with an "Unreleased" section, and no ${CHANGES_DIR}/ folder`,
    fix: () => `\`yokoten init\` adds both; then each pull request adds a file in ${CHANGES_DIR}/ for each change that users notice`,
    why: 'each pull request adds its entry as it goes, so a release needs no digging',
    how: `CHANGELOG.md has an Unreleased heading, or the repo has a ${CHANGES_DIR}/ folder`,
    standard: 'Best Practices: release_notes',
  },
  {
    stage: 3,
    key: 'titles',
    check: (root) => runs('check --pr').test(ciText(root)),
    what: () => 'CI does not check pull requests (`yokoten check --pr`)',
    fix: () => '`yokoten init` adds .github/workflows/pr.yml',
    why: 'a pull request title becomes the commit on main, so it must say what changed and why',
    how: 'a workflow in .github/workflows runs `yokoten check --pr`',
    standard: 'Conventional Commits 1.0.0',
  },
  {
    stage: 4,
    key: 'codeowners',
    check: (root) => ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].some((p) => existsSync(join(root, p))),
    what: () => 'no CODEOWNERS file',
    fix: () => 'add .github/CODEOWNERS with a line `<path> @<your account>` for each path where a mistake is hard to undo: the rules, CI, agent config',
    why: 'the host then asks you to review a pull request that changes those paths, and `check --pr` makes it tier A',
    how: 'a CODEOWNERS file is in .github/, at the root or in docs/',
    standard: 'Scorecard: Branch-Protection',
  },
  {
    stage: 4,
    key: 'bot',
    check: (_, env) => hasBot(env),
    what: () => 'no bot on this machine (YOKOTEN_BOT_APP_ID and its key file)',
    fix: () => 'yokoten\'s docs/server.md shows how to set one up',
    why: 'when the bot opens pull requests, you review work you did not write, as a team does',
    how: 'YOKOTEN_BOT_APP_ID is set on this machine, and the key file it names exists',
  },
  {
    stage: 4,
    key: 'skills',
    check: (_, env) => {
      if (hasPlugin(env)) return true; // the Claude Code plugin brings the skills
      const lacking = skillsLacking(env);
      return lacking && lacking.length === 0;
    },
    what: (_, env) => `the yokoten skills are not in ${(skillsLacking(env) ?? []).join(' or ')}`,
    fix: () => 'run `yokoten install`, or install the Claude Code plugin',
    why: 'the skills show an agent how to hand off work, review it and find the cause of a failure',
    how: 'every skill in the kit is in ~/.claude/skills and in ~/.agents/skills, or the Claude Code plugin is on; a project copy of yokoten has no kit, so it can\'t check',
  },
  reviewStep,
  {
    stage: 5,
    key: 'security-files',
    check: (root) => securityLacking(root).length === 0,
    what: (root) => `no ${securityLacking(root).join(', no ')}`,
    fix: () => '`yokoten init` adds the security policy and Dependabot, and you choose the license',
    how: 'a SECURITY.md, a Dependabot config and a license file are in the repo',
    why: 'people can then report a hole in private, old dependencies get updates, and others know how they may use the code',
    standard: 'Scorecard: Security-Policy · OSPS-VM-02.01',
  },
  serverStep('protection', {
    lacking: 'the default branch and the v* tags are not locked on the server',
    fix: 'in Settings, Rules, Rulesets, add a ruleset on the default branch and one on v* tags',
    why: 'the guards catch an agent\'s mistakes, but only the server stops a push that gets past them',
    how: 'through the code host\'s API, in full doctor only: the default branch needs a pull request, a named CI check, code owner review, no force push and no deletion; an active ruleset on v* tags restricts creation, update and deletion',
    standard: 'Scorecard: Branch-Protection',
  }),
  serverStep('merge-settings', {
    lacking: 'pull requests can merge in more than one way, or merged branches stay',
    fix: 'in Settings, General, Pull Requests, allow squash merging only and turn on "Automatically delete head branches"',
    why: 'one pull request becomes one commit on main, and no merged branch is left behind',
    how: 'through the code host\'s API, in full doctor only: the repo (or its ruleset) allows squash merges only, and deletes a branch when its pull request merges',
  }),
  serverStep('security-settings', {
    lacking: 'some security switches are off on the server',
    fix: 'in Settings, Advanced Security, turn on secret scanning, push protection, private vulnerability reporting and Dependabot alerts',
    why: 'the host then stops a pushed secret, and people can report a hole in private',
    how: 'through the code host\'s API, in full doctor only: secret scanning, push protection, private vulnerability reporting and Dependabot alerts are on; some are visible only to a repo admin',
  }),
];

/** A step not done, as a finding: the step's key is its id. */
export const stepFinding = (step: Step, root: string, env: Env, server?: ServerRead): Finding => ({ id: step.key, what: step.what(root, env, server), why: step.why, fix: step.fix(root, env, server) });

/** A step not done, as the map and the session say it: what is missing, then the fix. */
export const stepText = (f: Finding): string => `${f.what}; ${f.fix}`;

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

/** Run every check on the road for this project. `server` is what full doctor read from the code host. */
export function road(root: string, env: Env, steps: Step[] = ROAD, server?: ServerRead): { step: Step; found: Found }[] {
  return steps.map((step) => ({ step, found: step.check(root, env, server) }));
}
