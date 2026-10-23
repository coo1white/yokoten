// The road (record 0004): five stages, a few steps in each, and every step a check yokoten
// can run. A step with no check yet is not in the table; #10, #34 and #35 add theirs.
//
// The server steps (#7) and the planning steps (#10) judge what the host adapter read. Only full doctor reads the host;
// a session passes nothing, so those steps are "can't check" there and never hold the stage.
// On a host with no adapter (#504), every step with `byHand` is "can't check" too, and
// says what it asks in plain words: the step names the idea, the adapter knows the host.
//
// The stage is worked out from what the project has, never saved: it is the stage of the
// first step that is neither done nor "not now". The order is advice, not a gate: a later
// step done early counts as done.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { type Config, type Env, loadConfig } from '../rules/config.ts';
import { matcher } from '../rules/config.ts';
import { docsLink, type Finding, finding, type RuleId } from '../rules/message.ts';
import { CHANGES_DIR, parseCodeOwners } from '../rules/pr.ts';
import { BUILD_DIRS, isBuildOutput } from '../rules/layout.ts';
import { homeOf } from '../rules/privacy.ts';
import { hasPlugin, hasProjectHook, sandboxProblem as claudeSandboxProblem } from '../agents/runtimes/claude-code.ts';
import { sandboxProblem as codexSandboxProblem } from '../agents/runtimes/codex.ts';
import { sandboxProblem as geminiSandboxProblem } from '../agents/runtimes/gemini.ts';
import { sandboxProblem as grokSandboxProblem } from '../agents/runtimes/grok.ts';
import { isGuardOff, TRUST_FIX } from '../agents/runtimes/muse.ts';
import { type CommandTest, commitCheckLine, runs } from '../run/cli.ts';
import { isNoAdapter } from '../host/hosts.ts';
import { CODEOWNERS_PLACES, hasBot, KEYS_FILE, missingBotSetup, type Planning, type ServerSettings, type Unread } from '../host/github/index.ts';
import { KIT, runtimeVersion, VERSION } from './files.ts';
import { claudeReadsRules, cliPath, COMMIT_HOOKS, deadHookNotes, findRulesGap, handOffBlocks, hasHandOff, hookFile, isCommitHook, isExecutable, isSelf, type OldHook, OWNER_PLACEHOLDER, readHookSetup, readOldHooks } from './init/index.ts';
import { gitConfig } from '../run/check.ts';
import { indexFiles } from '../run/check.ts';
import { FIRST_MILESTONE, lackingLabels, pickNewMilestone } from './plan.ts';
import { commands, FALLBACK_RUNNERS, orList, runLines, runsTests, scriptedRuns, testLanguages } from './advice/test-commands.ts';
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
  /** `config` is yokoten.json when the caller has read it already; a step that needs it reads it otherwise. */
  check: (root: string, env: Env, server: ServerRead, config?: Config) => Found;
  /** What is missing, said when the step is not done. No full stop at the end. */
  what: (root: string, env: Env, server: ServerRead, config?: Config) => string;
  /** What to do about it: a command or an edit. No full stop at the end. */
  fix: (root: string, env: Env, server: ServerRead, config?: Config) => string;
  /**
   * What covers the step while yokoten.json "notNow" names `ci` (#377): the step needs CI,
   * so it waits with that choice and doctor says this in its place. No full stop at the end.
   */
  withoutCi?: string;
  /** Why yokoten can't check the step here, and what to do. Server steps and workflow steps have it. No full stop at the end. */
  unchecked?: (server: ServerRead) => string;
  /**
   * What the step asks of the code host, in plain words with no host's menus or commands
   * (#504). On a host yokoten has no adapter for, doctor can't check the step, and says
   * this so the user can do it by hand. Steps that only the host can judge have it. No full stop at the end.
   */
  byHand?: string;
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
   * Only for a step whose whole check is that files exist: groups of paths, relative to the
   * root, and any one path of a group is enough. When every group missing here is on the
   * default branch, doctor says so in place of the fix (#405).
   */
  paths?: string[][] | ((root: string, config?: Config) => string[][]);
}

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

export { gitConfig };
// `runsTests` lives in test-commands.ts with the table it reads; road keeps its name (#550).
export { runsTests };


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
  // No home folder (#356): no skills folder to look in, so none is there.
  if (!homeOf(env)) return ['your home folder (HOME is not set)'];
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
 * Whether the workflows run a yokoten command: anywhere in the text by its path, or as a
 * command in a `run:` step, where `- run: npx yokoten check` starts after the key (#298).
 */
const ciRuns = (ci: string, command: CommandTest) => command.test(ci) || runLines(ci).flatMap(commands).some((c) => command.test(c));
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].length;
// A step that uses yokoten's own Action, at any ref (even the guide's "<full commit SHA>"), quoted or not, with a comment or not.
// The ref is read one word at a time, so a long line takes linear time and no RangeError (#322).
const USES_HEAD = /^[ \t]*uses:[ \t]*(["']?)yokoten-labs\/yokoten@/;
const REF_WORD = /[^\s"'#]+/y;
const REF_GAP = /[ \t]+(?=[^\s"'#])/y;
const LINE_END = /[ \t]*(?:#.*)?$/y;
const usesYokoten = (line: string) => {
  const head = USES_HEAD.exec(line);
  if (!head) return false;
  REF_WORD.lastIndex = head[0].length;
  if (!REF_WORD.exec(line)) return false;
  let at = REF_WORD.lastIndex;
  for (REF_GAP.lastIndex = at; REF_GAP.exec(line); REF_GAP.lastIndex = at) {
    REF_WORD.lastIndex = REF_GAP.lastIndex;
    REF_WORD.exec(line);
    at = REF_WORD.lastIndex;
  }
  const quote = head[1];
  LINE_END.lastIndex = at + quote.length;
  return line.startsWith(quote, at) && LINE_END.test(line);
};
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
    if (!keys.some(usesYokoten)) continue;
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
/**
 * A check that reads the workflows. A line too big for a regex makes V8 throw a RangeError;
 * the step is then "can't check", and doctor goes on (#322).
 */
export const catchLongLines =
  (check: (root: string) => boolean) =>
  (root: string): Found => {
    try {
      return check(root);
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  };
const WORKFLOW_TOO_LONG = 'a line in .github/workflows is too long to read; make it shorter and run doctor again';
const ciRunsTests = (root: string) => runsTests(ciText(root), testScript(root), isWorkspaces(root), scriptedRuns(root));
/**
 * Why no workflow runs the tests, naming the language found by the files at the root
 * (test-commands.ts), so the reader sees doctor knows the project; the usual three when none is.
 */
const describeNoTestRun = (root: string) => {
  const found = testLanguages(root);
  if (!found.length) return `no workflow runs a test command such as ${orList(FALLBACK_RUNNERS)}`;
  const languages = found.map((l) => l.language);
  const named = languages.length > 1 ? `${languages.slice(0, -1).join(', ')} and ${languages.at(-1)}` : languages[0];
  return `this looks like a ${named} project, and no workflow runs its tests with ${orList(found.map((l) => l.runner))}`;
};
/** The command that runs each package's tests in this workspaces repo. */
const workspacesTest = (root: string) => (existsSync(join(root, 'pnpm-workspace.yaml')) ? '`pnpm -r test`' : '`npm test --workspaces`');
/** Why the tests step is not done, worded by what the project is: package.json only when there is one. */
const noTests = (root: string) => {
  if (testScript(root)) return 'CI does not run the tests';
  if (isWorkspaces(root)) return `no workflow runs each package's tests (e.g. ${workspacesTest(root)})`;
  if (packageJson(root)) return 'no test command: no "test" script in package.json, and no workflow runs a test runner';
  return describeNoTestRun(root);
};
/**
 * The fix for the tests step (#501): the file, the job to add, and the `needs` list of `ci`.
 * The job is one line of YAML, so the session start can show it. The command is `npm test`
 * when package.json has a test script, the workspaces command in a workspaces repo, else a
 * placeholder for the user's own.
 */
const testsFix = (root: string) => {
  const file = '.github/workflows/yokoten.yml';
  const isNode = testScript(root) !== '' || isWorkspaces(root);
  const command = isWorkspaces(root) ? workspacesTest(root).replaceAll('`', '') : testScript(root) ? 'npm test' : '<your test command>';
  const install = isNode && existsSync(join(root, 'package-lock.json')) ? ', {run: npm ci}' : '';
  const uses = isNode ? 'the checkout and setup-node steps of the other jobs' : 'the checkout step of the other jobs';
  const steps = `[<${uses}>${install}, {run: ${command}}]`;
  const start = existsSync(join(root, file)) ? `in ${file}` : `run \`yokoten init\` to add ${file}, then in it`;
  return `${start}, add this job under \`jobs:\`. Copy the \`uses:\` lines from the other jobs, because they are pinned: \`tests: {runs-on: ubuntu-latest, steps: ${steps}}\`. Then add \`tests\` to the \`needs\` list of the \`ci\` job, so a failing test blocks the merge`;
};

/** Tracked build output, as yokoten.json lets it through; null outside a git repo. */
const builtFiles = (root: string, env: Env): string[] | null => {
  let files: string[];
  try {
    files = indexFiles(root, env);
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
/**
 * A license file name, as GitHub's licensee finds one (#376): LICENSE, LICENCE, UNLICENSE or COPYING in
 * any case, alone or followed by an extension or a suffix such as an SPDX id. So LICENSE.md,
 * licence.txt, COPYING.LESSER and the Rust dual layout LICENSE-MIT plus LICENSE-APACHE all count.
 * LICENSES.md and LICENSING.md do not: they explain which license applies where, and are no license.
 */
export const isLicenseName = (name: string) => /^((un)?licen[cs]e|copying)([-._].*)?$/i.test(name);
/** Whether the root has a license file: one readdir, names as the folder lists them. */
const hasLicense = (root: string) => {
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => !entry.isDirectory() && isLicenseName(entry.name));
  } catch {
    return false;
  }
};
const DEPENDABOT_FILE = 'Dependabot config';
/**
 * Each security file: its name, the paths the default-branch lookup asks for (#405), and how
 * to tell the root has it when any of those paths is not enough. A license has many names
 * (#376); the lookup asks for the common ones.
 */
const SECURITY_FILES: [string, string[], ((root: string) => boolean)?][] = [
  ['security policy (SECURITY.md)', ['.github/SECURITY.md', 'SECURITY.md']],
  [DEPENDABOT_FILE, ['.github/dependabot.yml', '.github/dependabot.yaml']],
  [LICENSE_FILE, ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'], hasLicense],
];
/** The security files asked for. With "notNow" `ci` (#377), not the kit's Dependabot config: it updates only the actions that CI runs. */
const securityFiles = (isOff: boolean) => SECURITY_FILES.filter(([name]) => !(isOff && name === DEPENDABOT_FILE));
/** The security files the repo lacks. */
export const securityLacking = (root: string, isOff: boolean = isCiOff(root)): string[] =>
  securityFiles(isOff).filter(([, paths, has]) => !(has ? has(root) : paths.some((p) => existsSync(join(root, p))))).map(([name]) => name);

/**
 * True when yokoten.json "notNow" names `ci` (#377): the project keeps CI off, and the
 * commit hook and `yokoten check` are its gate. A broken yokoten.json reads as false.
 * Pass `config` when it is read already (doctor), so the session start reads the file once.
 */
export function isCiOff(root: string, config?: Config): boolean {
  if (config) return Object.hasOwn(config.notNow, 'ci');
  try {
    return Object.hasOwn(loadConfig(root).notNow, 'ci');
  } catch {
    return false; // the commit check names a broken yokoten.json
  }
}

// The server settings (#7), judged. Each setting is one check with its own rule id, so
// `yokoten explain main-rules` works. The road groups them into three steps.

/** One server setting as doctor reports it. A "can't check" or a note never fails doctor. */
export interface ServerCheck {
  id: RuleId;
  mark: 'ok' | 'MISSING' | "can't check" | 'note';
  finding: Finding;
}

const RULESET = 'in Settings, Rules, Rulesets, edit the ruleset on the default branch';

/**
 * Each server setting, judged. `settings` is what the host adapter read, or why it could not.
 * With `isCiOff` (yokoten.json "notNow" names `ci`, #377), no CI check can be required, so
 * required-checks is left out.
 */
export function serverChecks(settings: ServerSettings | Unread, { isCiOff: isOff = false }: { isCiOff?: boolean } = {}): ServerCheck[] {
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
    ...(isOff ? [] : [judge('required-checks', rules ? rules.requiredChecks.length > 0 : branch as Unread, 'no CI check must pass before a merge', `${RULESET}: require status checks, and add the CI check by name (yokoten's kit names it \`ci\`)`)]),
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

/**
 * The checks behind one step, and `server-settings` when nothing could be read. `root` is
 * null for the "can't check" texts: a check that was not read has nothing to leave out.
 */
const stepChecks = (key: string, root: string | null, server: ServerRead, config?: Config) =>
  serverChecks(server ?? SESSION_UNREAD, { isCiOff: root !== null && server !== undefined && isCiOff(root, config) }).filter((c) => c.id === 'server-settings' || SERVER_STEPS[key].includes(c.id));

/** Not done when a check is MISSING; can't check when a check is unread; done when all are ok. */
const judgeServer = (key: string, root: string, server: ServerRead, config?: Config): Found => {
  const checks = stepChecks(key, root, server, config);
  if (checks.some((c) => c.mark === 'MISSING')) return false;
  return checks.some((c) => c.mark === "can't check") ? null : true;
};

/** One field of each check with this mark, joined by "; ", or `fallback` when no check has the mark. */
const joinChecks = (key: string, root: string | null, server: ServerRead, mark: ServerCheck['mark'], field: 'what' | 'fix', fallback: string, config?: Config) => {
  const texts = stepChecks(key, root, server, config).filter((c) => c.mark === mark).map((c) => c.finding[field]);
  return texts.length ? [...new Set(texts)].join('; ') : fallback;
};

/** A stage 5 step made from server checks. `lacking` and `fix` are said when no check has its own words. */
const serverStep = (key: string, fields: { lacking: string; fix: string; byHand: string; why: string; how: string; standard?: string }): Step => ({
  stage: 5,
  key,
  check: (root, _, server, config) => judgeServer(key, root, server, config),
  what: (root, _, server, config) => joinChecks(key, root, server, 'MISSING', 'what', fields.lacking, config),
  fix: (root, _, server, config) => joinChecks(key, root, server, 'MISSING', 'fix', fields.fix, config),
  unchecked: (server) => `${joinChecks(key, null, server, "can't check", 'what', 'nothing was read')}; ${joinChecks(key, null, server, "can't check", 'fix', 'run `yokoten doctor`')}`,
  byHand: fields.byHand,
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

/** The first sandbox problem, in the order init writes them. Null when all four are in place. */
function firstSandboxProblem(root: string, env: Env): { what: string; fix: string } | null {
  return claudeSandboxProblem(root) ?? codexSandboxProblem(root, env) ?? geminiSandboxProblem(root) ?? grokSandboxProblem(root, env);
}

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
  byHand: 'a merge to the default branch needs one approving review; let the bot open the pull requests, so you can approve them, and let no CI job approve one',
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
const commitHook = (root: string, env: Env): string | null => {
  const hooksPath = gitConfig(root, 'core.hooksPath', env);
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
const uncheckedHooks = (root: string, env: Env): UncheckedHook[] | null => {
  const hooksPath = gitConfig(root, 'core.hooksPath', env);
  if (!hooksPath || commitHook(root, env) === null) return null;
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
const droppedHooks = (root: string, env: Env): OldHook[] => {
  if (!gitConfig(root, 'core.hooksPath', env) || readHookSetup(root, env).kind !== 'plain') return [];
  return readOldHooks(root, env).filter((old) => old.handOff === 'yes' && !hasHandOff(read(join(root, '.githooks', old.hook)), old.hook));
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
    paths: [['AGENTS.md']],
    check: (root) => existsSync(join(root, 'AGENTS.md')) && claudeReadsRules(root),
    what: (root) => {
      const gap = findRulesGap(root);
      return existsSync(join(root, 'AGENTS.md')) && gap ? `${gap.file} does not import AGENTS.md, so Claude Code does not read the rules` : 'no AGENTS.md, so the agents have no written rules here';
    },
    fix: (root) => {
      const gap = findRulesGap(root);
      if (!existsSync(join(root, 'AGENTS.md')) || !gap) return '`yokoten init` adds one';
      // init writes nothing through a link (#428).
      return gap.link
        ? `${gap.file} is a link to ${gap.link}: add a line \`${gap.line}\` to that file, or make ${gap.file} a plain file`
        : `add a line \`${gap.line}\` at the end of ${gap.file}, or run \`yokoten init\``;
    },
    why: 'an agent follows the rules it can read, and only those',
    how: 'AGENTS.md is at the repo root, and a CLAUDE.md (at the root or in .claude/), when there is one, imports it (`@AGENTS.md`, or `@../AGENTS.md` from .claude/; a Markdown link is not an import): with a CLAUDE.md, Claude Code reads AGENTS.md only through it',
    standard: 'OpenSSF: AI code assistant instructions',
  },
  {
    stage: 1,
    key: 'tool-hook',
    check: (root, env) => hasProjectHook(root) && !isGuardOff(root, env),
    what: (root, env) => (hasProjectHook(root) && isGuardOff(root, env) ? 'the guard is off in Muse Code until you trust this folder' : 'no tool-call guard in .claude/settings.json'),
    fix: (root, env) => (hasProjectHook(root) && isGuardOff(root, env) ? TRUST_FIX : '`yokoten init` adds it'),
    why: 'the guard stops a risky command, like a force push, before the agent runs it',
    how: '.claude/settings.json has a PreToolUse hook that runs `yokoten hook`. With a .muse/hooks.json, Muse Code must also trust the folder: doctor reads its trust.json, read-only',
  },
  {
    stage: 1,
    key: 'commit-check',
    check: (root, env) => uncheckedHooks(root, env)?.length === 0 && droppedHooks(root, env).length === 0,
    what: (root, env) => {
      const hooks = uncheckedHooks(root, env);
      const dropped = droppedHooks(root, env).map((old) => `${old.file} no longer runs: .githooks/${old.hook} does not run it`);
      if (hooks?.length) {
        // Only pre-merge-commit: ordinary commits are still checked, merge commits are not.
        const which = hooks.every((h) => h.file.endsWith('pre-merge-commit')) ? 'merge commits' : 'commits';
        return `${which} are not checked: ${[...hooks.map((h) => HOOK_PROBLEM[h.problem](h.file)), ...dropped].join('; ')}`;
      }
      if (hooks) return `a hook this clone had is switched off: ${dropped.join('; ')}`;
      return gitConfig(root, 'core.hooksPath', env) ? 'commits are not checked: core.hooksPath is outside this repo' : 'commits are not checked: core.hooksPath is not set';
    },
    fix: (root, env) => {
      if (!gitConfig(root, 'core.hooksPath', env) && existsSync(join(root, '.husky'))) return 'run `npm install` so husky sets core.hooksPath, then `yokoten init`';
      // A hook in .git/hooks that .githooks can't run: init leaves it be, so the fix is by hand (#256).
      const blocks = readHookSetup(root, env).kind === 'plain' ? handOffBlocks(root, env) : [];
      if (blocks.length) return blocks.join('; ');
      const hooks = uncheckedHooks(root, env);
      const files = hooks?.map((h) => h.file) ?? [];
      const dropped = droppedHooks(root, env);
      if (hooks && !files.length && dropped.length) {
        return `\`yokoten init\` makes ${dropped.map((old) => `.githooks/${old.hook} run ${old.file}${isCommitHook(old.hook) ? ' after the check' : ''}`).join(' and ')}`;
      }
      if (!files.length || files.includes('.githooks/pre-commit')) {
        // A hook git skips today is not a reason to wait; init sets .githooks and says how to keep it (#256).
        const dead = readHookSetup(root, env).kind === 'plain' ? deadHookNotes(readOldHooks(root, env)) : [];
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
    check: catchLongLines(ciRunsTests),
    unchecked: () => WORKFLOW_TOO_LONG,
    what: noTests,
    fix: testsFix,
    byHand: 'your host\'s CI runs the tests on every push and on every pull request',
    why: 'tests that run on every push catch a broken change before it reaches main',
    how: 'package.json has a real "test" script and a `run:` step in .github/workflows runs it, or a `run:` step starts a test runner such as `node --test`, `go test`, `pytest`, `tox`, `make test` or `npx vitest`; in a workspaces repo, `npm test --workspaces` or `pnpm -r test` counts too',
    standard: 'Best Practices: test',
    withoutCi: 'run the tests yourself before each merge',
  },
  {
    stage: 2,
    key: 'ci',
    // `check --pr` is the titles step, and `check --issue` checks issues; this one wants the tree check itself.
    check: catchLongLines((root) => ciRuns(ciText(root), runs('check(?!\\s+--(?:pr|issue))')) || ciFiles(root).some((f) => yokotenActions(f).length > 0)),
    unchecked: () => WORKFLOW_TOO_LONG,
    what: () => 'CI does not run `yokoten check`',
    fix: (root) => keptWorkflow(root, 'yokoten.yml', 'check', 'actions/checkout and actions/setup-node'),
    byHand: 'your host\'s CI runs `yokoten check` on every push and on every pull request',
    why: 'a commit made with the hook off would reach main unchecked',
    how: 'a workflow in .github/workflows runs `yokoten check` (by its path, or with npx, bunx or pnpm dlx), or has a step that uses yokoten-labs/yokoten',
    standard: 'Scorecard: CI-Tests',
    withoutCi: 'the commit hook runs `yokoten check` on each commit',
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
    paths: [['.github/ISSUE_TEMPLATE'], ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']],
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
    byHand: `the repo has the labels ${lackingLabels([]).map((l) => l.name).join(', ')}`,
    why: 'a label says what kind of change a pull request is, and the pull request check asks for one',
    how: 'through the code host\'s API, in full doctor only: the repo has the labels bug, feat, docs, refactor, ci, owner, incident, good first issue, hotfix, tier A, tier B and tier C',
  }),
  planningStep('milestone', (planning) => pickNewMilestone(planning.milestones) === null, {
    what: () => 'no open milestone on the server',
    fix: (...[, , server]) => `\`yokoten init --github --yes\` makes one called "${newMilestoneOf(server)}"`,
    byHand: 'the repo has an open milestone for the next release',
    why: 'a milestone says when a change ships, and the pull request check asks for one',
    how: 'through the code host\'s API, in full doctor only: the repo has at least one open milestone',
  }),
  {
    stage: 2,
    key: 'no-build-output',
    check: (root, env) => {
      const built = builtFiles(root, env);
      return built && built.length === 0;
    },
    what: (root, env) => {
      const built = builtFiles(root, env) ?? [];
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
    // changes/ alone passes; a CHANGELOG.md must also have an Unreleased section.
    paths: [[CHANGES_DIR]],
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
    check: catchLongLines((root) => ciRuns(ciText(root), runs('check --pr')) || ciFiles(root).some((f) => onPullRequest(f) && yokotenActions(f).some((a) => a.prCheck))),
    unchecked: () => WORKFLOW_TOO_LONG,
    what: () => 'CI does not check pull requests (`yokoten check --pr`)',
    fix: (root) => keptWorkflow(root, 'pr.yml', 'check --pr', 'actions/checkout with `fetch-depth: 0` and actions/setup-node, in a job that runs on pull_request'),
    byHand: 'before a pull request merges, its title has the commit form (`feat: ...`, `fix: ...`) and says what changed',
    why: 'a pull request title becomes the commit on main, so it must say what changed and why',
    how: 'a workflow in .github/workflows runs `yokoten check --pr`, or runs on pull requests with a step that uses yokoten-labs/yokoten and does not set `pr-check: false`',
    standard: 'Conventional Commits 1.0.0',
    withoutCi: 'run `yokoten check --pr <number>` before each merge',
  },
  {
    stage: 4,
    key: 'codeowners',
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
    byHand: 'a CODEOWNERS file, where your host reads one, names you for the rules, CI and agent config, and a pull request that changes them needs your review',
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
    fix: () => `the server guide shows how to set one up: ${docsLink('server.md')}`,
    byHand: 'a bot account with its own token and write access opens the pull requests; it can\'t change CI, create tags or approve',
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
  {
    stage: 4,
    key: 'sandbox',
    paths: [['.claude/settings.json'], ['.codex/config.toml'], ['.gemini/settings.json'], ['.grok/sandbox.toml']],
    check: (root, env) => firstSandboxProblem(root, env) === null,
    // The fallback never shows: what and fix run only when the step is not done.
    what: (root, env) => firstSandboxProblem(root, env)?.what ?? 'the agent sandboxes are in place',
    fix: (root, env) => firstSandboxProblem(root, env)?.fix ?? 'nothing to do',
    why: 'a worker writes only where the sandbox allows, so it must cover the worktree',
    how: '.claude/settings.json turns the sandbox on with no * host; .codex/config.toml pins workspace-write, on-request and no network; .gemini/settings.json blocks YOLO mode; .grok/sandbox.toml holds a workspace profile; writable paths stay in the project',
  },
  reviewStep,
  {
    stage: 5,
    key: 'security-files',
    paths: (root, config) => securityFiles(isCiOff(root, config)).map(([, paths]) => paths),
    check: (...[root, , , config]) => securityLacking(root, isCiOff(root, config)).length === 0,
    what: (...[root, , , config]) => `no ${securityLacking(root, isCiOff(root, config)).join(', no ')}`,
    fix: (...[root, , , config]) => {
      const lacking = securityLacking(root, isCiOff(root, config));
      const license = lacking.includes(LICENSE_FILE);
      const byInit = lacking.length > (license ? 1 : 0);
      // With CI off (#377), init writes no Dependabot config.
      return [byInit ? `run \`yokoten init\` to add the security policy${isCiOff(root, config) ? '' : ' and Dependabot'}` : '', license ? 'choose a license and add it as LICENSE' : ''].filter(Boolean).join(', and ');
    },
    how: 'a SECURITY.md, a Dependabot config and a license file are in the repo',
    why: 'people can then report a hole in private, old dependencies get updates, and others know how they may use the code',
    standard: 'Scorecard: Security-Policy · OSPS-VM-02.01',
  },
  serverStep('protection', {
    lacking: 'the default branch and the v* tags are not locked on the server',
    fix: 'in Settings, Rules, Rulesets, add a ruleset on the default branch and one on v* tags',
    byHand: 'the default branch takes changes only through a pull request with CI passed and code owner review, and no force push or deletion; only you can create, move or delete a v* release tag',
    why: 'the guards catch an agent\'s mistakes, but only the server stops a push that gets past them',
    how: 'through the code host\'s API, in full doctor only: the default branch needs a pull request, a named CI check, code owner review, no force push and no deletion; an active ruleset on v* tags restricts creation, update and deletion',
    standard: 'Scorecard: Branch-Protection',
  }),
  serverStep('merge-settings', {
    lacking: 'pull requests can merge in more than one way, or merged branches stay',
    fix: 'in Settings, General, Pull Requests, allow squash merging only and turn on "Automatically delete head branches"',
    byHand: 'a pull request merges by squash only, and its branch is deleted when it merges',
    why: 'one pull request becomes one commit on main, and no merged branch is left behind',
    how: 'through the code host\'s API, in full doctor only: the repo (or its ruleset) allows squash merges only, and deletes a branch when its pull request merges',
  }),
  serverStep('security-settings', {
    lacking: 'some security switches are off on the server',
    fix: 'in Settings, Advanced Security, turn on secret scanning, push protection, private vulnerability reporting and Dependabot alerts',
    byHand: 'the host stops a pushed secret, people can report a security hole in private, and you hear of a dependency with a known hole, as far as your host can do these',
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

/** The path groups of a step with no path here. */
const groupsLacking = (root: string, step: Step, config?: Config): string[][] => (typeof step.paths === 'function' ? step.paths(root, config) : (step.paths ?? [])).filter((group) => !group.some((path) => existsSync(join(root, path))));

/** The paths of `steps` whose group has no path here, each once. */
export const missingPaths = (root: string, steps: Step[], config?: Config): string[] => [...new Set(steps.flatMap((step) => groupsLacking(root, step, config).flat()))];

/** A ref's commit, from its loose file or packed-refs. Files only; null when not found. */
function readCommit(commonDir: string, ref: string): string | null {
  const loose = read(join(commonDir, ref)).trim();
  if (/^[0-9a-f]{40,64}$/.test(loose)) return loose;
  for (const line of read(join(commonDir, 'packed-refs')).split('\n')) {
    const [commit, name] = line.trim().split(' ');
    if (name === ref && /^[0-9a-f]{40,64}$/.test(commit)) return commit;
  }
  return null;
}

/**
 * Which of `paths` the default branch has. The default branch is origin/HEAD, else
 * init.defaultBranch, else main. Never the network. Null when there is nothing to ask,
 * this checkout is the default branch (by name or by commit), or git can't tell.
 */
export function readDefaultBranchFiles(root: string, paths: string[], env: Env): DefaultBranchFiles | null {
  if (!paths.length) return null;
  const folders = gitFolders(root);
  // The reftable store keeps no ref in a file; then say nothing rather than guess.
  if (!folders || existsSync(join(folders.commonDir, 'reftable'))) return null;
  const headFile = read(join(folders.gitDir, 'HEAD')).trim();
  const head = /^ref: refs\/heads\/(.+)$/.exec(headFile);
  const branch = head ? head[1] : 'detached HEAD';
  const headCommit = head ? readCommit(folders.commonDir, `refs/heads/${head[1]}`) : /^[0-9a-f]{40,64}$/.test(headFile) ? headFile : null;
  // origin/HEAD is always a loose file in the files store, even after `git pack-refs`.
  const originHead = /^ref: refs\/remotes\/(.+)$/m.exec(read(join(folders.commonDir, 'refs', 'remotes', 'origin', 'HEAD')));
  const name = originHead ? originHead[1].trim() : gitConfig(root, 'init.defaultBranch', env) || 'main';
  const ref = originHead ? `refs/remotes/${name}` : `refs/heads/${name}`;
  // On the default branch, or at its commit, merging it changes nothing: the file was removed here.
  if (branch === name.replace(/^origin\//, '')) return null;
  const defaultCommit = readCommit(folders.commonDir, ref);
  if (headCommit && headCommit === defaultCommit) return null;
  try {
    const listed = execFileSync('git', ['--no-optional-locks', 'ls-tree', '--name-only', ref, '--', ...paths], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const found = new Set(listed.split('\n').filter((path) => paths.includes(path)));
    return found.size ? { name, branch, paths: found } : null;
  } catch {
    return null;
  }
}

/**
 * What a step's finding may use beyond the step: what the code host said (`server`, full
 * doctor only), yokoten.json when it is read already (`config`, #377), and what the default
 * branch has (`elsewhere`, #405).
 */
export interface FindingContext {
  server?: ServerRead;
  config?: Config;
  elsewhere?: DefaultBranchFiles | null;
}

/**
 * A step not done, as a finding: the step's key is its id. When the default branch has a
 * path of every group missing here, the finding names that branch.
 */
export function stepFinding(step: Step, root: string, env: Env, { server, config, elsewhere }: FindingContext = {}): Finding {
  const lacking = elsewhere ? groupsLacking(root, step, config) : [];
  const there = lacking.map((group) => group.find((path) => elsewhere?.paths.has(path)));
  if (elsewhere && lacking.length && there.every((path) => path !== undefined)) {
    const files = there.length > 1 ? `${there.slice(0, -1).join(', ')} and ${there.at(-1)} are` : `${there[0]} is`;
    return { id: step.key, what: `${files} on ${elsewhere.name}, not on this branch (${elsewhere.branch})`, why: step.why, fix: `work on a branch made from ${elsewhere.name}, or merge ${elsewhere.name} into this one` };
  }
  return { id: step.key, what: step.what(root, env, server, config), why: step.why, fix: step.fix(root, env, server, config) };
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
 * now", and `stage` is its stage; both are null when nothing is left. A step that needs CI
 * (`withoutCi`) is "not now" too when "notNow" names `ci` (#377). A step yokoten
 * can't check here never holds the stage: a session can do nothing about it.
 */
export function walk(found: { step: Step; found: Found }[], notNow: Record<string, string>): { stage: number | null; next: Step | null; steps: Walked[] } {
  let next: Step | null = null;
  const steps = found.map(({ step, found: f }): Walked => {
    if (f === true) return { step, mark: 'done' };
    if (Object.hasOwn(notNow, step.key) || (step.withoutCi && Object.hasOwn(notNow, 'ci'))) return { step, mark: 'not now' };
    if (f === null) return { step, mark: "can't check" };
    if (next) return { step, mark: 'to do' };
    next = step;
    return { step, mark: 'next' };
  });
  const first = next as Step | null;
  return { stage: first ? first.stage : null, next: first, steps };
}

/**
 * Run every check on the road for this project. `server` is what full doctor read from the
 * code host. On a host with no adapter (#504), a step that only the host can judge is
 * "can't check": it never holds the stage, and doctor says what it asks.
 */
export function road(root: string, env: Env, steps: Step[] = ROAD, server?: ServerRead, config?: Config): { step: Step; found: Found }[] {
  const isOtherHost = isNoAdapter(server);
  return steps.map((step) => ({ step, found: isOtherHost && step.byHand ? null : step.check(root, env, server, config) }));
}

/** What the map says after a "can't check" step: why, and what to do; empty when the step has no words for it. */
export function uncheckedText(step: Step, server: ServerRead): string {
  if (isNoAdapter(server) && step.byHand) return `yokoten can't check this on ${server.otherHost} yet; do it by hand: ${step.byHand}`;
  return step.unchecked?.(server) ?? '';
}
