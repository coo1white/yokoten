// The road (record 0004): five stages, a few steps in each, and every step a check yokoten
// can run. A step with no check yet is not in the table; #10, #34 and #35 add theirs.
//
// The server steps (#7) and the planning steps (#10) judge what the host adapter read. Only full doctor reads the host;
// a session passes nothing, so those steps are "can't check" there and never hold the stage.
//
// The stage is worked out from what the project has, never saved: it is the stage of the
// first step that is neither done nor "not now". The order is advice, not a gate: a later
// step done early counts as done.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { type Env, loadConfig } from '../rules/config.ts';
import { matcher } from '../rules/config.ts';
import { type Finding, finding, type RuleId } from '../rules/message.ts';
import { CHANGES_DIR, parseCodeOwners } from '../rules/pr.ts';
import { BUILD_DIRS, isBuildOutput } from '../rules/layout.ts';
import { hasPlugin, hasProjectHook } from '../agents/runtimes/claude-code.ts';
import { commitCheckLine, runs } from '../run/cli.ts';
import { CODEOWNERS_PLACES, hasBot, KEYS_FILE, missingBotSetup, type Planning, type ServerSettings, type Unread } from '../host/github.ts';
import { KIT, runtimeVersion, VERSION } from './files.ts';
import { claudeReadsRules, cliPath, COMMIT_HOOKS, deadHookNotes, findRulesGap, handOffBlocks, hasHandOff, hookFile, isCommitHook, isExecutable, isSelf, type OldHook, OWNER_PLACEHOLDER, readHookSetup, readOldHooks } from './init.ts';
import { FIRST_MILESTONE, lackingLabels, pickNewMilestone } from './plan.ts';
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
  /**
   * The files the step looks for, relative to the root. When one is missing here but is on
   * the default branch, doctor says so in place of the fix (#405). Any one of them is enough.
   */
  paths?: string[];
}

const WORKFLOWS = '.github/workflows';

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/** The CODEOWNERS file GitHub reads here, relative to the root, or null when there is none. */
const codeOwnersFile = (root: string): string | null => CODEOWNERS_PLACES.find((place) => existsSync(join(root, place))) ?? null;

/** True when a rule line of the CODEOWNERS file still has init's placeholder in place of an owner. Comments don't count, as in GitHub. */
const hasPlaceholder = (root: string, file: string): boolean =>
  read(join(root, file))
    .split(/\r?\n/)
    .some((line) => line.replace(/(^|\s)#.*$/, '').includes(OWNER_PLACEHOLDER));

/**
 * The organization named as the only owner in the CODEOWNERS file, or null. Only full
 * doctor knows the repo's owner is an organization, from the repo read it already makes;
 * a session never asks (#313). GitHub takes no bare `@org`, so such a file locks nothing.
 */
function orgOnlyOwner(root: string, file: string, server: ServerRead): string | null {
  const org = server && !('unread' in server) ? server.org : null;
  if (!org) return null;
  const owners = parseCodeOwners(read(join(root, file))).flatMap((rule) => rule.owners);
  return owners.length > 0 && owners.every((owner) => owner.toLowerCase() === `@${org.toLowerCase()}`) ? org : null;
}

export const gitConfig = (root: string, key: string) => {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const ciFiles = (root: string): string[] => {
  const dir = join(root, '.github', 'workflows');
  return existsSync(dir) ? readdirSync(dir).map((f) => read(join(dir, f))) : [];
};
const ciText = (root: string) => ciFiles(root).join('\n');

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
/**
 * The shell lines that the workflows run: each `run:` value, one line, or each line of a
 * `run: |` block. A job id, a matrix item or a comment is never a command. Each line is
 * matched on its own, so no pattern can run across a newline.
 */
const runLines = (ci: string): string[] => {
  const lines: string[] = [];
  const text = ci.split(/\r?\n/);
  for (let i = 0; i < text.length; i++) {
    const key = /^([ \t]*(?:-[ \t]+)?)run:(?:[ \t]+(.*))?$/.exec(text[i]);
    if (!key) continue;
    const value = (key[2] ?? '').trim();
    if (/^[|>][-+0-9]*(?:[ \t]+#.*)?$/.test(value)) {
      // A block: the lines indented more than the `run` key, with `\` continuations joined.
      let line = '';
      for (; i + 1 < text.length && (text[i + 1].trim() === '' || /^[ \t]*/.exec(text[i + 1])![0].length > key[1].length); i++) {
        const next = text[i + 1].trim();
        if (!next) continue;
        line = line ? `${line} ${next}` : next;
        if (!line.endsWith('\\')) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
    } else if (!value.startsWith('#')) lines.push(value.replace(/^(["'])(.*)\1$/, '$2'));
  }
  return lines;
};
/**
 * The simple commands in a shell line: split at ;, &, |, with an opening "(" and any
 * `VAR=value`, `env` or `time` before the command taken off. Comments go.
 */
const commands = (line: string): string[] =>
  line.split(/[;&|]+/).map((c) => c.trim().replace(/^(?:\(\s*|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+|env(?:\s+-\S+)*\s+|time\s+)*/, '')).filter((c) => c && !c.startsWith('#'));
/** A command that only asks a tool about itself. */
const ASKS = /\s--(?:version|help)(?=\s|$)/;
// The end of a command name: a space or the end, so "make test-deps" and "jest-preview" are not runs.
const END = String.raw`(?=\s|$)`;
// Flags with no value, as tools take them before the command: npx --yes, node --experimental-strip-types.
const FLAGS = String.raw`(?:\s+-\S+)*`;
// Flags that may take a value: npm -w app, pnpm --filter app.
const VALUED = String.raw`(?:\s+-\S+(?:\s+[^-\s]\S*)?)*`;
const anchored = (pattern: string) => new RegExp(`^${pattern}${END}`);
/** The package.json "test" script, run by its package manager. */
const RUNS_SCRIPT = anchored(String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)`);
// Tools that start a Node runner: npx, bunx, npm exec, pnpm (exec, dlx), yarn (run).
const NODE_EXEC = String.raw`(?:(?:npx|bunx)${FLAGS}\s+|npm\s+exec${FLAGS}\s+(?:--\s+)?|(?:pnpm|yarn)(?:\s+(?:exec|dlx|run))?\s+)?`;
// Tools that start a Python runner: uv run, uvx, pipx run, poetry run, pipenv run.
const PY_EXEC = String.raw`(?:(?:uvx|uv\s+run|pipx\s+run|poetry\s+run|pipenv\s+run)${FLAGS}\s+)?`;
// A Python module run as a program: python -m, coverage run -m.
const PY_M = String.raw`(?:python3?|coverage\s+run)\s+-m\s+`;
/** Test runners that need no package.json script, one entry per runner. Each is matched at the start of a command. */
const RUNNERS: RegExp[] = [
  anchored(String.raw`node${FLAGS}\s+--test`),
  anchored(String.raw`deno\s+test`),
  anchored(String.raw`go\s+test`),
  anchored(String.raw`cargo\s+test`),
  anchored(String.raw`(?:\./)?mvnw?${FLAGS}\s+test`),
  anchored(String.raw`(?:\./)?gradlew?${FLAGS}\s+test`),
  anchored(`${PY_EXEC}(?:${PY_M})?(?:pytest|tox|nox)`),
  anchored(`${PY_EXEC}${PY_M}unittest`),
  anchored(String.raw`make(?:\s+-C\s*\S+|\s+-\S+)*\s+tests?`),
  anchored(`${NODE_EXEC}(?:vitest|jest)`),
];
/** In a workspaces repo, commands that run each package's "test" script; the root may have none. */
const RUNS_WORKSPACES: RegExp[] = [
  // npm takes its flags anywhere: npm test --workspaces, npm -w app test, npm run test -ws.
  new RegExp(String.raw`^npm(?=.*\s(?:--workspaces?|-ws|-w)(?:[\s=]|$))${VALUED}\s+(?:run\s+)?(?:test|t)${END}`),
  anchored(String.raw`pnpm${VALUED}\s+(?:-r|--recursive|--filter(?:=|\s+)\S+|-F\s+\S+)${VALUED}\s+(?:run\s+)?test`),
  anchored(String.raw`yarn\s+workspaces\s+(?:foreach${VALUED}\s+)?run\s+test`),
];
const packageJson = (root: string): Record<string, unknown> | null => {
  try {
    const json = JSON.parse(read(join(root, 'package.json')) || 'null');
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
};
const isWorkspaces = (root: string) => Boolean(packageJson(root)?.workspaces) || existsSync(join(root, 'pnpm-workspace.yaml'));
/**
 * Whether the workflow text runs the tests: the package.json "test" script (`script`, or
 * empty), each package's script in a workspaces repo, or a test runner named outright.
 */
export const runsTests = (ci: string, script: string, workspaces: boolean) => {
  const lines = runLines(ci);
  const run = lines.flatMap(commands).filter((c) => !ASKS.test(c));
  if (run.some((c) => RUNNERS.some((r) => r.test(c)))) return true;
  if (script !== '' && (run.some((c) => RUNS_SCRIPT.test(c)) || lines.some((l) => l.includes(script)))) return true;
  return workspaces && run.some((c) => RUNS_WORKSPACES.some((r) => r.test(c)));
};
/**
 * Whether the workflows run a yokoten command: anywhere in the text by its path, or as a
 * command in a `run:` step, where `- run: npx yokoten check` starts after the key (#298).
 */
const ciRuns = (ci: string, command: RegExp) => command.test(ci) || runLines(ci).flatMap(commands).some((c) => command.test(c));
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
// A step that uses yokoten's own Action, at any ref (even the guide's "<full commit SHA>"), quoted or not, with a comment or not.
const USES_YOKOTEN = /^[ \t]*uses:[ \t]*(["']?)yokoten-labs\/yokoten@[^\s"'#]+(?:[ \t]+[^\s"'#]+)*\1[ \t]*(?:#.*)?$/;
const PR_CHECK_OFF = /^[ \t]*pr-check:[ \t]*(["']?)false\1[ \t]*(?:#.*)?$/;
/**
 * The steps in one workflow that use the yokoten Action, each with whether it runs
 * `check --pr`: it does unless its `with:` sets `pr-check: false`. Each list item is read
 * once and then skipped, so the read is linear in the text (#298).
 */
export const yokotenActions = (workflow: string): { prCheck: boolean }[] => {
  const found: { prCheck: boolean }[] = [];
  const text = workflow.split(/\r?\n/);
  for (let i = 0; i < text.length; i++) {
    const item = /^([ \t]*)-[ \t]+(.*)$/.exec(text[i]);
    if (!item) continue;
    // The item's keys sit two past the dash; its first key is on the dash line.
    const keyIndent = item[1].length + 2;
    const lines = [' '.repeat(keyIndent) + item[2]];
    for (; i + 1 < text.length && (text[i + 1].trim() === '' || indentOf(text[i + 1]) > item[1].length); i++) lines.push(text[i + 1]);
    const keys = lines.filter((l) => l.trim() !== '' && indentOf(l) === keyIndent);
    if (!keys.some((l) => USES_YOKOTEN.test(l))) continue;
    let inWith = false;
    let prCheck = true;
    for (const line of lines) {
      if (line.trim() === '') continue;
      if (indentOf(line) <= keyIndent) inWith = /^[ \t]*with:[ \t]*(?:#.*)?$/.test(line) && indentOf(line) === keyIndent;
      else if (inWith && PR_CHECK_OFF.test(line)) prCheck = false;
    }
    found.push({ prCheck });
  }
  return found;
};
/** Whether one workflow runs on pull requests: its top-level `on:` names pull_request or pull_request_target. */
export const onPullRequest = (workflow: string): boolean => {
  const text = workflow.split(/\r?\n/);
  for (let i = 0; i < text.length; i++) {
    const on = /^(?:on|"on"|'on'):(.*)$/.exec(text[i]);
    if (!on) continue;
    const block = [on[1]];
    for (; i + 1 < text.length && (text[i + 1].trim() === '' || /^[ \t#]/.test(text[i + 1])); i++) block.push(text[i + 1]);
    if (block.some((l) => /(?:^|[\s[,{])pull_request(?:_target)?(?=[\s:,\]}]|$)/.test(l.replace(/#.*/, '')))) return true;
  }
  return false;
};
const ciRunsTests = (root: string) => runsTests(ciText(root), testScript(root), isWorkspaces(root));
// What runs the tests in each kind of project, by a file at the root; the first three when none is found.
const PROJECT_RUNNERS: [string[], string][] = [
  [['go.mod'], 'go test'],
  [['pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'requirements.txt'], 'pytest'],
  [['Cargo.toml'], 'cargo test'],
  [['pom.xml'], 'mvn test'],
  [['build.gradle', 'build.gradle.kts'], 'gradle test'],
  [['deno.json', 'deno.jsonc'], 'deno test'],
];
const runnersFor = (root: string) => {
  const found = PROJECT_RUNNERS.filter(([files]) => files.some((f) => existsSync(join(root, f)))).map(([, runner]) => runner);
  const named = (found.length ? found : PROJECT_RUNNERS.slice(0, 3).map(([, runner]) => runner)).map((r) => `\`${r}\``);
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : named[0];
};
/** The command that runs each package's tests in this workspaces repo. */
const workspacesTest = (root: string) => (existsSync(join(root, 'pnpm-workspace.yaml')) ? '`pnpm -r test`' : '`npm test --workspaces`');
/** Why the tests step is not done, worded by what the project is: package.json only when there is one. */
const noTests = (root: string) => {
  if (testScript(root)) return 'CI does not run the tests';
  if (isWorkspaces(root)) return `no workflow runs each package's tests (e.g. ${workspacesTest(root)})`;
  if (packageJson(root)) return 'no test command: no "test" script in package.json, and no workflow runs a test runner';
  return `no workflow runs a test command such as ${runnersFor(root)}`;
};
const testsFix = (root: string) => {
  if (testScript(root)) return 'add a step that runs `npm test` (or your test command) to a workflow in .github/workflows';
  if (isWorkspaces(root)) return `add a step that runs ${workspacesTest(root)} to a workflow in .github/workflows`;
  return 'add tests and a CI step that runs them';
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

/** The one security file init does not write: the license is the owner's choice. */
const LICENSE_FILE = 'license file';
const SECURITY_FILES: [string, string[]][] = [
  ['security policy (SECURITY.md)', ['.github/SECURITY.md', 'SECURITY.md']],
  ['Dependabot config', ['.github/dependabot.yml', '.github/dependabot.yaml']],
  [LICENSE_FILE, ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']],
];
export const securityLacking = (root: string) => SECURITY_FILES.filter(([, paths]) => !paths.some((p) => existsSync(join(root, p)))).map(([name]) => name);

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
  const cant = (id: RuleId, u: Unread): ServerCheck => ({ id, mark: "can't check", finding: finding(id, u.unread, u.fix) });
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
  const texts = stepChecks(key, server).filter((c) => c.mark === mark).map((c) => c.finding[field]);
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

/** What the review step judges, as full doctor read it, or why there is nothing to judge. */
const reviewRead = (server: ServerRead): { approvals: number; actionsCanApprove: boolean | null } | Unread => {
  const settings = server ?? SESSION_UNREAD;
  if ('unread' in settings) return settings;
  const branch = settings.branch;
  if ('unread' in branch) {
    if (settings.isPrivate && /GitHub Pro/.test(branch.unread)) return { unread: `${branch.unread}, so no rule can ask for an approval yet; this step waits for stage 5, when the repo goes public`, fix: 'or upgrade to GitHub Pro (or Team for an organization) and run doctor again' };
    return branch;
  }
  if (branch.approvals === null) return { unread: 'no ruleset asks for an approval, and the old branch protection can be read only by an admin', fix: 'sign in to gh as a repo admin and run doctor again' };
  return { approvals: branch.approvals, actionsCanApprove: settings.actionsCanApprove };
};

/** True when approvals are required but a workflow may still approve a pull request. */
const workflowsApprove = (server: ServerRead) => {
  const read = reviewRead(server);
  return !('unread' in read) && read.approvals >= 1 && read.actionsCanApprove === true;
};

const ACTIONS_SETTING = '"Allow GitHub Actions to create and approve pull requests"';

const reviewStep: Step = {
  stage: 4,
  key: 'review',
  check: (...[, , server]) => {
    const read = reviewRead(server);
    if ('unread' in read) return null;
    if (read.approvals < 1 || read.actionsCanApprove === true) return false;
    return read.actionsCanApprove === false ? true : null;
  },
  what: (...[, , server]) => (workflowsApprove(server) ? `a workflow may approve a pull request (${ACTIONS_SETTING} is on), so the bot could approve its own` : 'a merge to the default branch needs no approving review'),
  fix: (...[, , server]) => (workflowsApprove(server)
    ? `in Settings, Actions, General, turn off ${ACTIONS_SETTING}, and keep it off`
    : `${RULESET}: in "Require a pull request", set "Required approvals" to 1. You can't approve your own pull request, so let the bot open them, and keep ${ACTIONS_SETTING} off in Settings, Actions, General`),
  unchecked: (server) => {
    const read = reviewRead(server);
    if ('unread' in read) return `${read.unread}; ${read.fix}`;
    return read.approvals >= 1 && read.actionsCanApprove === null ? `the Actions setting ${ACTIONS_SETTING} can be read only by an admin; sign in to gh as a repo admin and run doctor again` : '';
  },
  why: 'the bot opens the pull requests, so you approve work you did not write, and nothing merges unread',
  how: 'through the code host\'s API, in full doctor only: a ruleset (or the old branch protection) on the default branch asks for at least 1 approving review, and the Actions setting that lets a workflow approve a pull request is off; a private repo without rulesets waits for stage 5',
  standard: 'Scorecard: Code-Review',
};

// The planning steps (#10): the labels and an open milestone, as full doctor read them.

/** The labels and milestones full doctor read, or why there are none to judge. */
const planningOf = (server: ServerRead): Planning | Unread => {
  if (server === undefined) return SESSION_UNREAD;
  if ('unread' in server) return server;
  return server.planning ?? { unread: 'the labels and milestones were not read', fix: 'run `yokoten doctor`' };
};

/** A stage 2 step judged from the labels and milestones. `isDone` sees only what was read. */
const planningStep = (key: string, isDone: (planning: Planning) => boolean, fields: Omit<Step, 'stage' | 'key' | 'check' | 'unchecked'>): Step => ({
  stage: 2,
  key,
  check: (...[, , server]) => {
    const planning = planningOf(server);
    return 'unread' in planning ? null : isDone(planning);
  },
  unchecked: (server) => {
    const planning = planningOf(server);
    return 'unread' in planning ? `${planning.unread}; ${planning.fix}` : 'nothing was read; run `yokoten doctor`';
  },
  ...fields,
});

const lackingNames = (server: ServerRead) => {
  const planning = planningOf(server);
  return 'unread' in planning ? [] : lackingLabels(planning.labels.map((l) => l.name)).map((l) => l.name);
};

/** The title `init --github` would give a new milestone, by the same rule the step checks. */
const newMilestoneOf = (server: ServerRead) => {
  const planning = planningOf(server);
  return ('unread' in planning ? null : pickNewMilestone(planning.milestones)) ?? FIRST_MILESTONE;
};

/** The pre-commit git runs here, by core.hooksPath, relative to the root; null when that is unset or outside the repo. */
const commitHook = (root: string): string | null => {
  const hooksPath = gitConfig(root, 'core.hooksPath');
  return hooksPath ? hookFile(root, hooksPath) : null;
};

/** A commit hook that git would not run the check from, and why. */
interface UncheckedHook {
  file: string;
  /** missing: there is no file; no check: it does not run yokoten; not executable: git skips it. */
  problem: 'missing' | 'no check' | 'not executable';
  /** Whether the file needs `chmod +x`. Windows has no execute bit, and git there runs a hook without one. */
  needsChmod: boolean;
}

/** The commit hooks here (pre-commit and pre-merge-commit) that do not run the check (#239); null when git runs none from this repo. */
const uncheckedHooks = (root: string): UncheckedHook[] | null => {
  const hooksPath = gitConfig(root, 'core.hooksPath');
  if (!hooksPath || commitHook(root) === null) return null;
  // husky 9's folder (.husky/_) runs .husky/pre-commit with `sh`, so that file needs no execute bit (#256).
  const runsWithSh = relative(root, resolve(root, hooksPath)).split('\\').join('/').startsWith('.husky/');
  const unchecked: UncheckedHook[] = [];
  for (const hook of COMMIT_HOOKS) {
    const file = hookFile(root, hooksPath, hook) as string;
    const path = join(root, file);
    if (!existsSync(path)) {
      unchecked.push({ file, problem: 'missing', needsChmod: process.platform !== 'win32' && !runsWithSh });
      continue;
    }
    const needsChmod = !runsWithSh && !isExecutable(path);
    if (!runs('check').test(read(path))) unchecked.push({ file, problem: 'no check', needsChmod });
    else if (needsChmod) unchecked.push({ file, problem: 'not executable', needsChmod });
  }
  return unchecked;
};

const HOOK_PROBLEM: Record<UncheckedHook['problem'], (file: string) => string> = {
  missing: (file) => `there is no ${file}`,
  'no check': (file) => `${file} does not run yokoten`,
  'not executable': (file) => `${file} is not executable, so git skips it`,
};

/** What to do by hand for hooks in a project's own folder: a new file needs a `#!` line and `chmod +x`, or git skips it. */
const ownHookFix = (hooks: UncheckedHook[], cli: string): string => {
  const files = (problem: UncheckedHook['problem']) => hooks.filter((h) => h.problem === problem).map((h) => h.file);
  const chmod = hooks.filter((h) => h.needsChmod).map((h) => h.file);
  const steps: string[] = [];
  if (files('missing').length) steps.push(`make ${files('missing').join(' and ')} with \`#!/bin/sh\` as the first line and the line below after it`);
  if (files('no check').length) steps.push(`add the line below to ${files('no check').join(' and ')}, after its \`#!\` line`);
  if (chmod.length) steps.push(`run \`chmod +x ${chmod.join(' ')}\``);
  const all = hooks.map((h) => h.file).join(' and ');
  // init keeps the mode of a file under .husky/ (#256).
  if (hooks.every((h) => h.problem === 'not executable')) return hooks.some((h) => h.file.startsWith('.husky/')) ? steps.join('') : `${steps.join('')}, or \`yokoten init\``;
  return `\`yokoten init\` adds the check to ${all}, or do it yourself: ${steps.join('; ')}. The line: ${commitCheckLine(cli)}`;
};

/**
 * The hooks this clone has in .git/hooks that git no longer runs, because core.hooksPath is
 * .githooks and .githooks does not hand off to them (#256). Empty for any other hooks folder:
 * the project chose that one itself.
 */
const droppedHooks = (root: string): OldHook[] => {
  if (!gitConfig(root, 'core.hooksPath') || readHookSetup(root).kind !== 'plain') return [];
  return readOldHooks(root).filter((old) => old.handOff === 'yes' && !hasHandOff(read(join(root, '.githooks', old.hook)), old.hook));
};

/**
 * The fix for a workflow step: init adds the kit's workflow, but keeps one the project
 * already has, so then the fix is the step to add to it (#256).
 */
const keptWorkflow = (root: string, name: string, args: string, after: string): string => {
  const file = `.github/workflows/${name}`;
  if (!existsSync(join(root, file))) return `\`yokoten init\` adds ${file}`;
  return `add this step to ${file}, after ${after} (\`yokoten init\` keeps your file as it is): \`- run: node ${cliPath(root)} ${args}\``;
};

/** The road, in order. Step names never change: they are the keys for "not now". */
export const ROAD: Step[] = [
  {
    stage: 1,
    key: 'rules',
    paths: ['AGENTS.md'],
    check: (root) => existsSync(join(root, 'AGENTS.md')) && claudeReadsRules(root),
    what: (root) => {
      const gap = findRulesGap(root);
      return existsSync(join(root, 'AGENTS.md')) && gap ? `${gap.file} does not import AGENTS.md, so Claude Code does not read the rules` : 'no AGENTS.md, so the agents have no written rules here';
    },
    fix: (root) => {
      const gap = findRulesGap(root);
      return existsSync(join(root, 'AGENTS.md')) && gap ? `add a line \`${gap.line}\` at the end of ${gap.file}, or run \`yokoten init\`` : '`yokoten init` adds one';
    },
    why: 'an agent follows the rules it can read, and only those',
    how: 'AGENTS.md is at the repo root, and a CLAUDE.md (at the root or in .claude/), when there is one, imports it (`@AGENTS.md`, or `@../AGENTS.md` from .claude/; a Markdown link is not an import): with a CLAUDE.md, Claude Code reads AGENTS.md only through it',
    standard: 'OpenSSF: AI code assistant instructions',
  },
  {
    stage: 1,
    key: 'tool-hook',
    paths: ['.claude/settings.json'],
    check: (root) => hasProjectHook(root),
    what: () => 'no tool-call guard in .claude/settings.json',
    fix: () => '`yokoten init` adds it',
    why: 'the guard stops a risky command, like a force push, before the agent runs it',
    how: '.claude/settings.json has a PreToolUse hook that runs `yokoten hook`',
  },
  {
    stage: 1,
    key: 'commit-check',
    paths: ['.githooks/pre-commit', '.githooks/pre-merge-commit'],
    check: (root) => uncheckedHooks(root)?.length === 0 && droppedHooks(root).length === 0,
    what: (root) => {
      const hooks = uncheckedHooks(root);
      const dropped = droppedHooks(root).map((old) => `${old.file} no longer runs: .githooks/${old.hook} does not run it`);
      if (hooks?.length) {
        // Only pre-merge-commit: ordinary commits are still checked, merge commits are not.
        const which = hooks.every((h) => h.file.endsWith('pre-merge-commit')) ? 'merge commits' : 'commits';
        return `${which} are not checked: ${[...hooks.map((h) => HOOK_PROBLEM[h.problem](h.file)), ...dropped].join('; ')}`;
      }
      if (hooks) return `a hook this clone had is switched off: ${dropped.join('; ')}`;
      return gitConfig(root, 'core.hooksPath') ? 'commits are not checked: core.hooksPath is outside this repo' : 'commits are not checked: core.hooksPath is not set';
    },
    fix: (root) => {
      if (!gitConfig(root, 'core.hooksPath') && existsSync(join(root, '.husky'))) return 'run `npm install` so husky sets core.hooksPath, then `yokoten init`';
      // A hook in .git/hooks that .githooks can't run: init leaves it be, so the fix is by hand (#256).
      const blocks = readHookSetup(root).kind === 'plain' ? handOffBlocks(root) : [];
      if (blocks.length) return blocks.join('; ');
      const hooks = uncheckedHooks(root);
      const files = hooks?.map((h) => h.file) ?? [];
      const dropped = droppedHooks(root);
      if (hooks && !files.length && dropped.length) {
        return `\`yokoten init\` makes ${dropped.map((old) => `.githooks/${old.hook} run ${old.file}${isCommitHook(old.hook) ? ' after the check' : ''}`).join(' and ')}`;
      }
      if (!files.length || files.includes('.githooks/pre-commit')) {
        // A hook git skips today is not a reason to wait; init sets .githooks and says how to keep it (#256).
        const dead = readHookSetup(root).kind === 'plain' ? deadHookNotes(readOldHooks(root)) : [];
        return ['`yokoten init` sets it up', ...dead.map((line) => `note: ${line}`)].join('; ');
      }
      if (files.join() === '.githooks/pre-merge-commit') return '`yokoten init` sets up .githooks/pre-merge-commit';
      return ownHookFix(hooks as UncheckedHook[], cliPath(root));
    },
    why: 'a secret or a personal email is hard to take back once a commit is pushed',
    how: "the pre-commit and pre-merge-commit that git runs from core.hooksPath run `yokoten check`: in .githooks/, or in the project's own folder (husky: .husky/). With .githooks, each executable hook left in .git/hooks is run from .githooks (a commit hook after the check), so it is not switched off",
    standard: 'OSPS-BR-07.01',
  },
  {
    stage: 1,
    key: 'runtime',
    paths: ['.yokoten/VERSION'],
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
    paths: [WORKFLOWS],
    check: (root) => ciRunsTests(root),
    what: noTests,
    fix: testsFix,
    why: 'tests that run on every push catch a broken change before it reaches main',
    how: 'package.json has a real "test" script and a `run:` step in .github/workflows runs it, or a `run:` step starts a test runner such as `node --test`, `go test`, `pytest`, `tox`, `make test` or `npx vitest`; in a workspaces repo, `npm test --workspaces` or `pnpm -r test` counts too',
    standard: 'Best Practices: test',
  },
  {
    stage: 2,
    key: 'ci',
    paths: [WORKFLOWS],
    // `check --pr` is the titles step, and `check --issue` checks issues; this one wants the tree check itself.
    check: (root) => ciRuns(ciText(root), runs('check(?!\\s+--(?:pr|issue))')) || ciFiles(root).some((f) => yokotenActions(f).length > 0),
    what: () => 'CI does not run `yokoten check`',
    fix: (root) => keptWorkflow(root, 'yokoten.yml', 'check', 'actions/checkout and actions/setup-node'),
    why: 'a commit made with the hook off would reach main unchecked',
    how: 'a workflow in .github/workflows runs `yokoten check` (by its path, or with npx, bunx or pnpm dlx), or has a step that uses yokoten-labs/yokoten',
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
    paths: ['.github/ISSUE_TEMPLATE', '.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md'],
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
  planningStep('labels', (planning) => lackingLabels(planning.labels.map((l) => l.name)).length === 0, {
    what: (...[, , server]) => `the standard labels are not all on the server (no ${lackingNames(server).join(', ')})`,
    fix: () => '`yokoten init` shows what it would add, and `yokoten init --github --yes` adds them',
    why: 'a label says what kind of change a pull request is, and the pull request check asks for one',
    how: 'through the code host\'s API, in full doctor only: the repo has the labels bug, feat, docs, refactor, ci, owner, incident, good first issue, hotfix, tier A, tier B and tier C',
  }),
  planningStep('milestone', (planning) => pickNewMilestone(planning.milestones) === null, {
    what: () => 'no open milestone on the server',
    fix: (...[, , server]) => `\`yokoten init --github --yes\` makes one called "${newMilestoneOf(server)}"`,
    why: 'a milestone says when a change ships, and the pull request check asks for one',
    how: 'through the code host\'s API, in full doctor only: the repo has at least one open milestone',
  }),
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
    paths: ['CHANGELOG.md', CHANGES_DIR],
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
    paths: [WORKFLOWS],
    check: (root) => ciRuns(ciText(root), runs('check --pr')) || ciFiles(root).some((f) => onPullRequest(f) && yokotenActions(f).some((a) => a.prCheck)),
    what: () => 'CI does not check pull requests (`yokoten check --pr`)',
    fix: (root) => keptWorkflow(root, 'pr.yml', 'check --pr', 'actions/checkout with `fetch-depth: 0` and actions/setup-node, in a job that runs on pull_request'),
    why: 'a pull request title becomes the commit on main, so it must say what changed and why',
    how: 'a workflow in .github/workflows runs `yokoten check --pr`, or runs on pull requests with a step that uses yokoten-labs/yokoten and does not set `pr-check: false`',
    standard: 'Conventional Commits 1.0.0',
  },
  {
    stage: 4,
    key: 'codeowners',
    paths: CODEOWNERS_PLACES,
    check: (root, _, server) => {
      const file = codeOwnersFile(root);
      return file !== null && !hasPlaceholder(root, file) && !orgOnlyOwner(root, file, server);
    },
    what: (root, _, server) => {
      const file = codeOwnersFile(root);
      const org = file && orgOnlyOwner(root, file, server);
      if (org) return `${file} names only @${org}, an organization, and GitHub takes no organization as an owner`;
      return file ? `${file} names no owner yet (${OWNER_PLACEHOLDER})` : 'no CODEOWNERS file';
    },
    fix: (root, _, server) => {
      const file = codeOwnersFile(root);
      const org = file && orgOnlyOwner(root, file, server);
      if (org) return `put a person's handle or @${org}/<team> in ${file}`;
      return file ? `put your GitHub handle in ${file}` : '`yokoten init` writes .github/CODEOWNERS for the lead-only paths; or add one with a line `<path> @<your account>` for each path where a mistake is hard to undo: the rules, CI, agent config';
    },
    why: 'the host then asks you to review a pull request that changes those paths, and `check --pr` makes it tier A',
    how: `a CODEOWNERS file is in .github/, at the root or in docs/, and the first one GitHub reads names an owner, not init's placeholder ${OWNER_PLACEHOLDER}; full doctor also reads whether the repo belongs to an organization, and an organization alone (@org, not @org/team) is not an owner`,
    standard: 'Scorecard: Branch-Protection',
  },
  {
    stage: 4,
    key: 'bot',
    check: (_, env) => hasBot(env),
    // Names the piece that is missing (#364, #405), as `yokoten bot` finds it.
    what: (_, env) => `the bot is not set up on this machine: ${missingBotSetup(env) ?? 'nothing is missing'}`,
    fix: () => 'yokoten\'s docs/server.md shows how to set one up',
    why: 'when the bot opens pull requests, you review work you did not write, as a team does',
    how: `YOKOTEN_BOT_APP_ID is set, in the environment or in ${KEYS_FILE}, and the key file exists (YOKOTEN_BOT_KEY, or ~/.config/yokoten/bot.pem): the same lookup as \`yokoten bot\``,
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
    paths: SECURITY_FILES.flatMap(([, paths]) => paths),
    check: (root) => securityLacking(root).length === 0,
    what: (root) => `no ${securityLacking(root).join(', no ')}`,
    fix: (root) => {
      const lacking = securityLacking(root);
      const license = lacking.includes(LICENSE_FILE);
      const byInit = lacking.length > (license ? 1 : 0);
      return [byInit ? 'run `yokoten init` to add the security policy and Dependabot' : '', license ? 'choose a license and add it as LICENSE' : ''].filter(Boolean).join(', and ');
    },
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

// The default branch (#405). A checkout on an old branch lacks files that the default
// branch has. Then "run init" is wrong: the files are there, on another branch. The refs
// are read from files, and the tree with one `git ls-tree`, so a session stays fast.

/** Files missing here that the default branch has, and the names to say. */
export interface DefaultBranchFiles {
  /** The default branch as the report names it: origin/main, or main. */
  name: string;
  /** This checkout's branch, or "detached HEAD". */
  branch: string;
  paths: Set<string>;
}

/** The repo's own git folder and the folder its worktrees share. Files only; null when unreadable. */
function gitFolders(root: string): { gitDir: string; commonDir: string } | null {
  const dotGit = join(root, '.git');
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!pointer) return null;
    const gitDir = resolve(root, pointer[1].trim());
    const common = read(join(gitDir, 'commondir')).trim();
    return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
  } catch {
    return existsSync(dotGit) ? { gitDir: dotGit, commonDir: dotGit } : null;
  }
}

/** The paths of `steps` that are missing here, each once. */
export const missingPaths = (root: string, steps: Step[]): string[] =>
  [...new Set(steps.flatMap((step) => step.paths ?? []))].filter((path) => !existsSync(join(root, path)));

/**
 * Which of `paths` the default branch has. The default branch is origin/HEAD, else
 * init.defaultBranch, else main. Never the network. Null when there is nothing to ask,
 * this checkout is on the default branch, or git can't tell.
 */
export function readDefaultBranchFiles(root: string, paths: string[]): DefaultBranchFiles | null {
  if (!paths.length) return null;
  const folders = gitFolders(root);
  if (!folders) return null;
  const head = /^ref: refs\/heads\/(.+)$/m.exec(read(join(folders.gitDir, 'HEAD')));
  const branch = head ? head[1].trim() : 'detached HEAD';
  // origin/HEAD is a loose file even in a packed repo. Another ref store goes through git.
  const originHead = /^ref: refs\/remotes\/(.+)$/m.exec(read(join(folders.commonDir, 'refs', 'remotes', 'origin', 'HEAD')));
  let ref: string;
  let name: string;
  if (originHead) {
    name = originHead[1].trim();
    ref = `refs/remotes/${name}`;
  } else {
    name = gitConfig(root, 'init.defaultBranch') || 'main';
    if (name === branch) return null;
    ref = `refs/heads/${name}`;
  }
  try {
    const listed = execFileSync('git', ['--no-optional-locks', 'ls-tree', '--name-only', ref, '--', ...paths], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const found = new Set(listed.split('\n').filter((path) => paths.includes(path)));
    return found.size ? { name, branch, paths: found } : null;
  } catch {
    return null;
  }
}

/** A step not done, as a finding: the step's key is its id. `elsewhere` is what the default branch has. */
export function stepFinding(step: Step, root: string, env: Env, server?: ServerRead, elsewhere?: DefaultBranchFiles | null): Finding {
  const there = elsewhere ? (step.paths ?? []).filter((path) => elsewhere.paths.has(path) && !existsSync(join(root, path))) : [];
  if (elsewhere && there.length) {
    const files = there.length > 1 ? `${there.slice(0, -1).join(', ')} and ${there.at(-1)} are` : `${there[0]} is`;
    return { id: step.key, what: `${files} on ${elsewhere.name}, not on this branch (${elsewhere.branch})`, why: step.why, fix: `work on a branch made from ${elsewhere.name}, or merge ${elsewhere.name} into this one` };
  }
  return { id: step.key, what: step.what(root, env, server), why: step.why, fix: step.fix(root, env, server) };
}

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
