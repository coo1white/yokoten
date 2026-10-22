// `yokoten init`: put the practices into a project. It only adds: a file that is already
// there is kept, and the report says so. Some files get lines added, never removed: a
// CLAUDE.md, and a project's own pre-commit and pre-merge-commit (#206, #239). An
// AGENTS.md without `## This project` gets the core rules on top, and its own text moves
// under that heading (#378). A kit workflow the project never changed is replaced by the
// kit's newest (#456). A hook the
// clone has in .git/hooks keeps running from .githooks (#256). Deciding
// what to do with a project's own rules (keep, merge, or say not now) is the yokoten
// skill's job, not this command's.
//
// `yokoten update` is the one command here that replaces text: the core rules in
// AGENTS.md, and only with --write. It is at the end of this file.

import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as antigravity from '../agents/runtimes/antigravity.ts';
import { addProjectHook, addProjectStopHook, checkProjectSettings, setProjectEnv } from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as copilot from '../agents/copilot.ts';
import * as dsh from '../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as grok from '../agents/runtimes/grok.ts';
import * as muse from '../agents/runtimes/muse.ts';
import { skippedBecause, UnreadableHooksFile } from '../agents/hooks-file.ts';
import { commitCheckLine, runs } from '../run/cli.ts';
import { configEntries, forgetGitReads, remembered, withGitReads } from '../run/check.ts';
import { DEFAULTS, type Env, loadConfig } from '../rules/config.ts';
import { WORKTREES_DIR } from '../rules/layout.ts';
import { type Finding, finding } from '../rules/message.ts';
import { systemHome } from '../rules/privacy.ts';
import { CODEOWNERS_PLACES, type Gh, ghIn, isOrganization, isPrivateRepo, repoOf } from '../host/github.ts';
import { readOriginUrl } from './plan.ts';
import { writeTestsJob } from './advice/tests-job.ts';
import type { Ask } from './install.ts';
import { copyRuntime, fileHash, HOME_DIR, KIT, lfText, normalizeText, readWorkflowHashes, render, textHash, VERSION, writeNew } from './files.ts';

/** yokoten's own repo runs its own bin; every other project runs a vendored copy. */
export const isSelf = (root: string): boolean => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'yokoten' && existsSync(join(root, 'bin', 'yokoten.ts'));
  } catch {
    return false;
  }
};

export const cliPath = (root: string): string => (isSelf(root) ? 'bin/yokoten.ts' : '.yokoten/bin/yokoten.ts');

/**
 * The entry the agent hooks run: bin/yokoten.mjs, next to `cliPath`. Plain JavaScript, so Node
 * starts it without its type stripper (#408). The git hook, CI and the docs keep `cliPath`.
 */
export const hookCliPath = (root: string): string => cliPath(root).replace(/\.ts$/, '.mjs');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * One agent's hook lines, or one skip line when its file won't parse or has the wrong
 * shape (#248, #254), or is a Gemini CLI file with comments, which yokoten never rewrites
 * (#258; the line then holds the hooks to add by hand): the file stays as it was, init
 * goes on, and `ok` is false until the hooks are there.
 */
function agentHooks(name: string, file: string, add: () => string[]): { ok: boolean; lines: string[] } {
  try {
    return { ok: true, lines: add() };
  } catch (err) {
    if (!(err instanceof UnreadableHooksFile)) throw err;
    return { ok: false, lines: [`skipped ${name}: ${skippedBecause(file, err.problem, 'init')}`] };
  }
}

/** How long init waits for GitHub to say whether the remote owner is an organization. */
const ORG_LOOKUP_MS = 5000;

/**
 * One line per thing done, kept or skipped; `ok` is false when a hooks or settings file was
 * skipped (#248, #254). `gh` asks GitHub two things: whether the remote owner is an
 * organization, and whether the repo is private (#377). `noCi` keeps CI off: see `keepCiOff`.
 * `ask` is the terminal question for the tests job (#550); without one, init only says
 * what it would add. Each git answer is kept for the run, until init sets core.hooksPath (#453).
 */
export function init(root: string, env: Env, gh: Gh = ghIn(root, env, ORG_LOOKUP_MS), { noCi = false, ask }: { noCi?: boolean; ask?: Ask } = {}): { ok: boolean; lines: string[] } {
  return withGitReads(() => initRun(root, env, gh, noCi, ask));
}

function initRun(root: string, env: Env, gh: Gh, noCi: boolean, ask?: Ask): { ok: boolean; lines: string[] } {
  const report: string[] = [];
  const isOff = noCi || isCiOffIn(root);
  const cli = cliPath(root);
  const hookCli = hookCliPath(root);
  if (!isSelf(root) && root !== HOME_DIR) {
    const copied = copyRuntime(join(root, '.yokoten'));
    report.push(copied === 'kept' ? 'kept .yokoten/ (the copy running now)' : 'wrote .yokoten/ (the runtime the hooks run; commit it)');
  }
  const hooks = readHookSetup(root, env);
  const kit = join(KIT, 'project');
  for (const file of walk(kit)) {
    const rel = relative(kit, file).split('\\').join('/');
    // The hooks are written below. A project with its own hooks folder keeps it, so it gets no .githooks/.
    if (rel.startsWith('.githooks/')) continue;
    // With CI off (#377), the CI files are left out. One that is there already is kept,
    // and with --no-ci, `keepCiOff` says what happens to it.
    if (isOff && isCiFile(rel)) {
      if (!lexists(join(root, rel))) report.push(`skipped ${rel} (yokoten.json "notNow" names ci)`);
      else if (!noCi) report.push(`kept ${rel}`);
      continue;
    }
    const text = render(readFileSync(file, 'utf8'), { cli, version: VERSION });
    // An AGENTS.md without "## This project" gets the core rules on top of its own text (#378).
    if (rel === 'AGENTS.md' && existsSync(join(root, rel))) {
      report.push(...addCoreRules(root, text, env));
      continue;
    }
    if (rel === '.github/dependabot.yml') {
      report.push(writeDependabot(root, text));
      continue;
    }
    if (rel.startsWith(WORKFLOWS_DIR)) {
      report.push(writeWorkflow(root, rel, text, env));
      continue;
    }
    report.push(`${writeNew(join(root, rel), text)} ${rel}`);
  }
  // The tests job for the project's language (#550): asked first, never overwritten. With
  // CI off there are no workflows, so nothing to add it to.
  if (!isOff) report.push(...writeTestsJob(root, { ask }));
  // Read before .githooks/ is written: whether it can run the hooks this clone has in .git/hooks (#256).
  const blocks = hooks.kind === 'plain' ? handOffBlocks(root, env) : [];
  if (hooks.kind !== 'own') report.push(...writeGithooks(root, cli, kit, blocks.length === 0, env));
  if (noCi) report.push(...keepCiOff(root, cli, kit));
  else if (!isOff) report.push(...privateRepoNote(root, gh, env));
  report.push(writeCodeOwners(root, gh, env));
  const ignored = writeGitignore(root);
  if (ignored) report.push(ignored);
  const imported = importRules(root);
  if (imported) report.push(imported);
  // Claude Code's settings, the file people edit by hand most: skipped as one, never
  // rewritten, when it won't parse or has the wrong shape (#254).
  const claudeHooks = agentHooks('the Claude Code settings', '.claude/settings.json', () => {
    checkProjectSettings(root);
    return [
      `${addProjectHook(root, hookCli)} the tool-call hook in .claude/settings.json`,
      `${addProjectStopHook(root, hookCli)} the stop check in .claude/settings.json (changed files, before the agent ends its turn)`,
      `${setProjectEnv(root, 'TZ', 'UTC')} TZ=UTC for agent sessions in .claude/settings.json (commit times carry no time zone)`,
      // Checked with a real run (#30): Copilot CLI reads these hooks, in a folder it trusts.
      // It skips them without a word otherwise (#341), so the line says how to trust it.
      'GitHub Copilot CLI runs the hooks in .claude/settings.json only after you trust this folder',
      `to trust this folder in Copilot CLI: ${copilot.TRUST_STEP}`,
    ];
  });
  report.push(...claudeHooks.lines);
  // Codex, Gemini CLI, Antigravity CLI, Muse Code, DeepSeek Harness and Grok CLI get the same guard, whether or not they are
  // installed here: small files are easier to predict than a guess about which agents someone uses.
  // A file that won't parse, or has the wrong shape, is named and skipped, never rewritten (#248).
  const codexHooks = agentHooks('the Codex hooks', '.codex/hooks.json', () => {
    codex.checkProjectHooks(root);
    return [
      `${codex.addProjectHook(root, hookCli)} the Codex tool-call hook in .codex/hooks.json`,
      `${codex.addProjectStopHook(root, hookCli)} the Codex stop check in .codex/hooks.json`,
      'Codex runs the hooks in .codex/hooks.json only after you trust this folder and the hooks',
      `to trust them in Codex: ${codex.TRUST_STEP}`,
    ];
  });
  const geminiHooks = agentHooks('the Gemini CLI hooks', '.gemini/settings.json', () => {
    gemini.checkProjectHooks(root, hookCli);
    return [
      `${gemini.addProjectHook(root, hookCli)} the Gemini CLI tool-call hook in .gemini/settings.json`,
      `${gemini.addProjectStopHook(root, hookCli)} the Gemini CLI stop check in .gemini/settings.json (AfterAgent)`,
    ];
  });
  const antigravityHooks = agentHooks('the Antigravity CLI hook', '.agents/hooks.json', () => [
    `${antigravity.addProjectHook(root, hookCli)} the Antigravity CLI tool-call hook in .agents/hooks.json`,
  ]);
  const museHooks = agentHooks('the Muse Code hooks', '.muse/hooks.json', () => {
    const added = muse.addProjectHooks(root, hookCli);
    return [
      `${added.guard} the Muse Code tool-call hook in .muse/hooks.json`,
      `${added.stop} the Muse Code stop check in .muse/hooks.json`,
      `${added.doctor} the Muse Code session doctor in .muse/hooks.json`,
      `Muse Code runs the hooks in .muse/hooks.json only after you trust this folder: ${muse.TRUST_STEP}`,
    ];
  });
  // Grok CLI runs the project's hooks only in a folder the user trusts. yokoten never trusts
  // one for the user: the line says how (#407).
  const grokHooks = agentHooks('the Grok CLI hooks', grok.HOOKS_FILE, () => {
    const added = grok.addProjectHooks(root, hookCli);
    return [
      `${added.guard} the Grok CLI tool-call hook in ${grok.HOOKS_FILE}`,
      `${added.stop} the Grok CLI stop check in ${grok.HOOKS_FILE}`,
      `Grok CLI runs the hooks in ${grok.HOOKS_FILE} only after you trust this folder: ${grok.TRUST_STEP}`,
    ];
  });
  // DeepSeek Harness runs the hooks through a bridge each profile needs. init only prints
  // how to add it: it installs nothing and leaves ~/.dsh alone (#334).
  // On Windows the files are still written, ready for #332, but the lines say dsh is not checked.
  const dshHooks = agentHooks('the DeepSeek Harness hook', dsh.HOOKS_FILE, () => dsh.initLines(dsh.addProjectHooks(root, hookCli)));
  report.push(...codexHooks.lines, ...geminiHooks.lines, ...antigravityHooks.lines, ...museHooks.lines, ...dshHooks.lines, ...grokHooks.lines);
  report.push(...setCommitCheck(root, cli, hooks, blocks, env));
  return { ok: claudeHooks.ok && codexHooks.ok && geminiHooks.ok && antigravityHooks.ok && museHooks.ok && dshHooks.ok && grokHooks.ok, lines: report };
}

// ---- A project that keeps CI off (#377) ----
//
// A private repo on a free plan pays for its Actions minutes. Such a project can keep CI
// off: yokoten.json "notNow" then names `ci`, and the commit hook and `yokoten check` are
// the gate. init never makes that choice itself. On a private repo it says what the
// workflows cost and how to keep them out; `init --no-ci` makes the choice.

/** The reason `init --no-ci` writes into "notNow". */
export const NO_CI_REASON = 'CI is off to save Actions minutes; the commit hook and yokoten check are the gate. Look again when the repo goes public';

/** The kit files that only CI uses: the workflows, and Dependabot, which updates only the actions CI runs. */
const isCiFile = (rel: string): boolean => rel.startsWith('.github/workflows/') || rel === '.github/dependabot.yml';

/** True when yokoten.json "notNow" names `ci`; false when the file is missing or can't be read (`yokoten init` checks it first). */
function isCiOffIn(root: string): boolean {
  try {
    return Object.hasOwn(loadConfig(root).notNow, 'ci');
  } catch {
    return false;
  }
}

/** True when something is at `path`, a broken symlink too. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The first of the path's folders below the root, or the file itself, that is a symlink; null when none is. */
function symlinkOnPath(root: string, rel: string): string | null {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join('/');
    try {
      if (lstatSync(join(root, part)).isSymbolicLink()) return part;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The texts init writes for a kit file: the kit's copy, and for dependabot.yml also the
 * copy with the blocks for this repo's ecosystems (#379).
 */
const kitCopies = (root: string, rel: string, kitText: string): string[] =>
  [kitText, ...(rel === '.github/dependabot.yml' ? [dependabotText(root, kitText).text] : [])];

/** True when the file at `path` is a copy init wrote: the kit's newest, or (a workflow) an older one in the hash list. A folder or another odd file is not. */
function isKitCopy(root: string, rel: string, path: string, kitText: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    const text = lfText(readFileSync(path, 'utf8'));
    return kitCopies(root, rel, kitText).includes(text) || (readWorkflowHashes()[rel] ?? []).includes(fileHash(text));
  } catch {
    return false;
  }
}

/**
 * `init --no-ci`: write "notNow" `ci` into yokoten.json, and remove each CI file that is
 * still the kit's copy (line ends aside), so nobody deletes them by hand. A file the project
 * changed is kept, and so is one reached through a symlink: init never deletes through one.
 * Each kept file is named once. Returns the report lines.
 */
function keepCiOff(root: string, cli: string, kit: string): string[] {
  const lines = [recordNotNow(root, 'ci', NO_CI_REASON)];
  for (const file of walk(kit)) {
    const rel = relative(kit, file).split('\\').join('/');
    const path = join(root, rel);
    if (!isCiFile(rel) || !lexists(path)) continue;
    const link = symlinkOnPath(root, rel);
    if (link) lines.push(`kept ${rel}: ${link} is a symlink, and init never deletes through one; delete it yourself if CI stays off`);
    else if (isKitCopy(root, rel, path, render(readFileSync(file, 'utf8'), { cli, version: VERSION }))) {
      rmSync(path);
      lines.push(`removed ${rel} (the kit's copy; CI is off)`);
    } else lines.push(`kept ${rel}: it is not the kit's copy, so delete it yourself if CI stays off`);
  }
  return lines;
}

/**
 * Set one key of yokoten.json "notNow", unless it is there. Only the text of that key
 * changes: the rest of the file keeps its formatting. When the edit can't be placed
 * safely, the file stays as it is and the line says to add the key by hand.
 */
function recordNotNow(root: string, key: string, reason: string): string {
  const path = join(root, 'yokoten.json');
  const byHand = `skipped "notNow" ${key} in yokoten.json: add "${key}": ${JSON.stringify(reason)} to "notNow" yourself`;
  let text = '{}\n';
  let file: Record<string, unknown>;
  try {
    if (existsSync(path)) text = readFileSync(path, 'utf8');
    file = JSON.parse(text);
  } catch {
    return byHand;
  }
  const notNow = (file.notNow ?? {}) as Record<string, string>;
  if (Object.hasOwn(notNow, key)) return `kept "notNow" ${key} in yokoten.json`;
  const entry = `"${key}": ${JSON.stringify(reason)}`;
  // After the opening brace of "notNow", or of the file when it has no "notNow": the new
  // entry goes first, with the same space after it as the next entry has.
  const insert = (match: RegExpExecArray | null, add: string): string | null => {
    if (!match) return null;
    const at = match.index + match[0].length;
    const space = text.slice(at).match(/^\s*/)?.[0] ?? '';
    const rest = text.slice(at + space.length);
    // An empty object: `{ "key": "…" }` on one line, whatever space it had inside.
    if (rest.startsWith('}')) return `${text.slice(0, at)} ${add} ${rest}`;
    return `${text.slice(0, at)}${space || ' '}${add},${space || ' '}${rest}`;
  };
  const hasKey = Object.hasOwn(file, 'notNow') && file.notNow !== null;
  const edited = hasKey ? insert(/"notNow"\s*:\s*\{/.exec(text), entry) : insert(/^\s*\{/.exec(text), `"notNow": { ${entry} }`);
  // The edit counts only when the file reads back as before, plus the one key.
  try {
    const after = edited === null ? null : JSON.parse(edited);
    const expected = { ...file, notNow: { ...notNow, [key]: reason } };
    if (!after || JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(expected))) return byHand;
  } catch {
    return byHand;
  }
  writeFileSync(path, edited as string);
  return `wrote "notNow" ${key} in yokoten.json (to take CI up again, remove it and run \`yokoten init\`)`;
}

/** A copy with the keys of every object in order, so two readings compare by content. */
const sortKeys = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])) : value;

/**
 * On a private repo, a note that the workflows use Actions minutes, and how to keep them
 * out. Nothing when gh can't tell, or the repo is public. One gh call, only with a GitHub remote.
 */
function privateRepoNote(root: string, gh: Gh, env: Env): string[] {
  const repo = repoOf(readOriginUrl(root, env));
  if (!repo || isPrivateRepo(gh, repo) !== true) return [];
  return [
    'note: this repo is private, so the workflows in .github/workflows use Actions minutes from your plan',
    'to keep CI off, run `yokoten init --no-ci`: it removes the workflows init wrote, and records the choice in yokoten.json',
  ];
}

// ---- CODEOWNERS for the lead-only paths (#304) ----
//
// The guard and the commit check stop a worker on the machine; CODEOWNERS stops the same
// change on the server, where `check --pr` makes it tier A and the host asks the owner to
// review. Its paths come from DEFAULTS.leadOnly, so the two lists can't drift. init
// writes the file rather than copying it from the kit: both the paths and the owner vary.

/** The owner init writes when it can't tell who owns the repo. A GitHub handle has no underscore, so this is never a real account. */
export const OWNER_PLACEHOLDER = '@YOUR_GITHUB_HANDLE';

/** A lead-only glob as a CODEOWNERS path: `x/**` is the folder `/x/`, a file is `/file`. */
export const ownedPath = (glob: string): string => `/${glob.replace(/\/\*\*$/, '/')}`;

/**
 * The CODEOWNERS init writes: every default lead-only path, owned by `owner`, or by the
 * placeholder when null. `org` is the organization that owns the repo, named in the hint.
 */
export function codeOwnersText(owner: string | null, org?: string): string {
  const handle = owner ? `@${owner}` : OWNER_PLACEHOLDER;
  const lines = [
    '# Written by yokoten init. The owner reviews every change to these paths: the rules',
    "# the agents work under, their config, the hooks and CI (yokoten's lead-only defaults).",
    '# Turn on "Require review from Code Owners" in branch protection, or GitHub asks',
    '# nobody. `yokoten check --pr` makes a change here tier A either way.',
  ];
  if (!owner && org) lines.push(`# @${org} is an organization, and GitHub takes no organization here: put a person's handle or @${org}/<team> in place of ${OWNER_PLACEHOLDER} on each line below.`);
  else if (!owner) lines.push(`# Put your GitHub handle in place of ${OWNER_PLACEHOLDER} on each line below.`);
  const paths = DEFAULTS.leadOnly.map(ownedPath);
  const width = Math.max(...paths.map((path) => path.length));
  return [...lines, '', ...paths.map((path) => `${path.padEnd(width)} ${handle}`), ''].join('\n');
}

/** The GitHub account in the origin remote's URL, or null without a GitHub remote. */
const readRemoteOwner = (root: string, env: Env): string | null => repoOf(readOriginUrl(root, env))?.split('/')[0] ?? null;

/**
 * Write .github/CODEOWNERS unless the project has one in any place GitHub reads. Returns
 * the report line. An organization can't own a path in CODEOWNERS, so when gh says the
 * remote owner is one, the file gets the placeholder (#313). When gh can't tell, the
 * remote owner stays: most repos belong to a person.
 */
function writeCodeOwners(root: string, gh: Gh, env: Env): string {
  const found = CODEOWNERS_PLACES.find((place) => existsSync(join(root, place)));
  if (found) return `kept ${found}`;
  const remote = readRemoteOwner(root, env);
  const org = remote !== null && isOrganization(gh, remote) === true;
  const owner = org ? null : remote;
  writeNew(join(root, '.github', 'CODEOWNERS'), codeOwnersText(owner, org ? remote : undefined));
  if (org) return `wrote .github/CODEOWNERS (the lead-only paths; @${remote} is an organization, so put a person or @${remote}/<team> in place of ${OWNER_PLACEHOLDER})`;
  return owner
    ? `wrote .github/CODEOWNERS (the lead-only paths, owned by @${owner})`
    : `wrote .github/CODEOWNERS (the lead-only paths; put your GitHub handle in place of ${OWNER_PLACEHOLDER})`;
}

// ---- Dependabot for the project's own packages (#379) ----
//
// The kit's dependabot.yml updates the actions CI runs. init adds one block for each
// package manager it finds, from the manifest and lock files at the root and in the
// folders one level down. An ecosystem at the root gets `/` only: a workspace there (npm,
// Cargo, Go) covers its members, and a second block for a member would open a second pull
// request for the same lock file. An ecosystem only in subfolders gets each of them.
// Only init runs this; the hooks never do. A dependabot.yml that is already there is the
// project's: init keeps it and names the ecosystems it doesn't update.

/** The Dependabot ecosystems in the order init writes them, each with the files that show it. */
const ECOSYSTEMS: readonly (readonly [string, (name: string) => boolean])[] = [
  ['bun', (name) => name === 'bun.lock' || name === 'bun.lockb'],
  ['npm', (name) => name === 'package.json'],
  ['cargo', (name) => name === 'Cargo.toml'],
  ['uv', (name) => name === 'uv.lock'],
  ['pip', (name) => ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'].includes(name)],
  ['gomod', (name) => name === 'go.mod'],
  ['bundler', (name) => name === 'Gemfile'],
  ['nuget', (name) => /\.(?:cs|fs|vb)proj$|\.sln$|^packages\.config$|^Directory\.Packages\.props$/.test(name)],
  ['maven', (name) => name === 'pom.xml'],
  ['gradle', (name) => /^(?:build|settings)\.gradle(?:\.kts)?$/.test(name)],
  ['composer', (name) => name === 'composer.json'],
  ['mix', (name) => name === 'mix.exs'],
  ['pub', (name) => name === 'pubspec.yaml'],
  ['swift', (name) => name === 'Package.swift'],
];

/** Folders that hold built, fetched or tool files, not a project of their own. */
const NOT_PROJECTS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'coverage', 'venv', '__pycache__']);

/** The ecosystems that the file names in one folder show. A bun or uv lock file means that manager, not npm or pip. */
function readFolderEcosystems(names: string[]): Set<string> {
  const found = new Set(ECOSYSTEMS.filter(([, shows]) => names.some(shows)).map(([name]) => name));
  if (found.has('bun')) found.delete('npm');
  if (found.has('uv')) found.delete('pip');
  return found;
}

/** Each ecosystem the project uses, with the folders Dependabot reads it in (`/` or `/sub`), in a fixed order. */
export function findEcosystems(root: string): Map<string, string[]> {
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const fileNames = (dir: string) => list(dir).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const top = list(root);
  const atRoot = readFolderEcosystems(top.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const subfolders = top
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NOT_PROJECTS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const inSubfolders = subfolders.map((sub) => [sub, readFolderEcosystems(fileNames(join(root, sub)))] as const);
  const found = new Map<string, string[]>();
  for (const [name] of ECOSYSTEMS) {
    const dirs = atRoot.has(name) ? ['/'] : inSubfolders.filter(([, names]) => names.has(name)).map(([sub]) => `/${sub}`);
    if (dirs.length > 0) found.set(name, dirs);
  }
  return found;
}

// ---- A .gitignore for the worker worktrees and the dependency folders (#521, #571) ----
//
// Without one, `git add -A` stages node_modules. init always ignores the folder worker
// worktrees live in, and reads the same package managers as Dependabot to write the
// folders each one fills. It only adds lines that are missing.

/** The folders each package manager fills with fetched or built files. */
const IGNORED_FOLDERS: Record<string, string[]> = {
  bun: ['node_modules/'],
  npm: ['node_modules/'],
  cargo: ['target/'],
  uv: ['.venv/', '__pycache__/'],
  pip: ['.venv/', '__pycache__/'],
  bundler: ['vendor/bundle/'],
  composer: ['vendor/'],
  maven: ['target/'],
  gradle: ['.gradle/', 'build/'],
  nuget: ['bin/', 'obj/'],
  mix: ['_build/', 'deps/'],
  pub: ['.dart_tool/'],
  swift: ['.build/'],
};

/** A .gitignore line as a bare folder name, so `/node_modules` and `node_modules/` count as the same. */
const folderOf = (line: string): string => line.trim().replace(/^\//, '').replace(/\/$/, '');

/** Add the worker worktrees folder and the dependency folders of the project's package managers to .gitignore. */
function writeGitignore(root: string): string | null {
  const wanted = [`${WORKTREES_DIR}/`, ...new Set([...findEcosystems(root).keys()].flatMap((name) => IGNORED_FOLDERS[name] ?? []))];
  const path = join(root, '.gitignore');
  const old = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const have = new Set((old ?? '').split(/\r?\n/).map(folderOf));
  const missing = wanted.filter((line) => !have.has(folderOf(line)));
  if (old === null) {
    writeNew(path, `${missing.join('\n')}\n`);
    return `wrote .gitignore (${missing.join(', ')})`;
  }
  if (missing.length === 0) return 'kept .gitignore';
  const lead = old === '' || old.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${lead}${missing.join('\n')}\n`);
  return `added to .gitignore: ${missing.join(', ')}`;
}

/** One update block in the kit's shape: monthly, a week old, one grouped pull request, prefix chore. */
export function formatDependabotBlock(ecosystem: string, dirs: string[]): string {
  const where = dirs.length === 1 ? [`    directory: ${dirs[0]}`] : ['    directories:', ...dirs.map((dir) => `      - ${dir}`)];
  return [
    `  - package-ecosystem: ${ecosystem}`,
    ...where,
    '    schedule:',
    '      interval: monthly',
    '    cooldown:',
    '      default-days: 7',
    '    groups:',
    `      ${ecosystem}:`,
    "        patterns: ['*']",
    '    commit-message:',
    '      prefix: chore',
    '',
  ].join('\n');
}

/** The ecosystems a dependabot.yml names. */
export const readDependabotEcosystems = (text: string): Set<string> =>
  new Set([...text.matchAll(/^\s*-?\s*package-ecosystem:\s*["']?([\w-]+)/gm)].map((match) => match[1]));

/** The dependabot.yml init writes here: the kit's file and a block for each ecosystem found. */
function dependabotText(root: string, kitText: string): { text: string; found: Map<string, string[]> } {
  const found = findEcosystems(root);
  const blocks = [...found].map(([name, dirs]) => formatDependabotBlock(name, dirs)).join('');
  return { text: kitText.replace(/\n*$/, '\n') + blocks, found };
}

/**
 * Write .github/dependabot.yml: the kit's file and a block for each ecosystem found. A
 * dependabot.yml or .yaml that is there is kept, and the line names what it doesn't update.
 */
function writeDependabot(root: string, kitText: string): string {
  const { text, found } = dependabotText(root, kitText);
  const existing = ['.github/dependabot.yml', '.github/dependabot.yaml'].find((place) => existsSync(join(root, place)));
  if (existing) {
    const has = readDependabotEcosystems(readFileSync(join(root, existing), 'utf8'));
    const missing = [...found.keys()].filter((name) => !has.has(name));
    if (missing.length === 0) return `kept ${existing}`;
    return `kept ${existing}; it does not update ${missing.join(', ')}. Copy its github-actions block for each, with prefix chore`;
  }
  writeNew(join(root, '.github', 'dependabot.yml'), text);
  return found.size === 0
    ? 'wrote .github/dependabot.yml (the actions CI runs)'
    : `wrote .github/dependabot.yml (the actions CI runs, and ${[...found.keys()].join(', ')})`;
}

// ---- The kit's workflows: update a copy the project never changed (#456) ----
//
// A project set up by an older yokoten has that kit's workflows. When its copy is byte for
// byte one the kit wrote (kit/workflow-hashes.json lists each version), init replaces it
// with the newest: there is nothing of the project's to keep, and git has the old file,
// because init never commits (record 0014). A copy with the project's changes is kept, and
// init and full doctor say how to see the difference. A symlink is never written through.

const WORKFLOWS_DIR = '.github/workflows/';

/** How a project's copy of a kit workflow compares with the kit's newest one. */
export type WorkflowState = 'missing' | 'same' | 'older' | 'changed' | 'link';

/** The first part of `rel`, a folder or the file itself, that is a symlink in `root`; null when none is. */
function findLinkOnPath(root: string, rel: string): string | null {
  const parts = rel.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const part = parts.slice(0, depth).join('/');
    try {
      if (lstatSync(join(root, part)).isSymbolicLink()) return part;
    } catch {
      return null;
    }
  }
  return null;
}

/** A blank line or a comment: no job, and never a difference between two copies of one. */
const isFillerLine = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#');

/** The indent of `line`: the spaces and tabs before its first other character. */
const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

/**
 * A workflow's `jobs:` block: the lines before it (its opening line last), each job's lines
 * (its header line first) by name, and the lines after the next top-level key, if any.
 * Null when no top-level `jobs:` key opens one.
 */
function readJobs(text: string): { before: string; jobs: Map<string, string[]>; after: string } | null {
  const lines = lfText(text).split('\n');
  const open = lines.findIndex((line) => /^jobs\s*:(?:\s+#.*)?$/.test(line));
  if (open === -1) return null;
  const jobs = new Map<string, string[]>();
  let at: string | null = null;
  let indent = 0;
  const after = lines.slice(open + 1);
  for (let index = 0; index < after.length; index++) {
    const line = after[index];
    if (isFillerLine(line)) {
      if (at !== null) jobs.get(at)!.push(line);
      continue;
    }
    if (/^\S/.test(line)) return { before: lines.slice(0, open + 1).join('\n'), jobs, after: after.slice(index).join('\n') };
    if (at === null) {
      const head = /^(\s*)([A-Za-z0-9_.-]+):/.exec(line);
      if (!head) return null;
      indent = head[1].length;
      at = head[2];
      jobs.set(at, [line]);
      continue;
    }
    const head = /^(\s*)([A-Za-z0-9_.-]+):/.exec(line);
    if (head !== null && head[1].length === indent) {
      at = head[2];
      jobs.set(at, [line]);
    } else jobs.get(at)!.push(line);
  }
  return { before: lines.slice(0, open + 1).join('\n'), jobs, after: '' };
}

/** The job names a `needs:` value and its list lines hold: a flow list, a block list, or one name. */
function needNames(value: string, extra: string[]): string[] {
  const clean = (word: string): string => word.replace(/#.*$/, '').trim().replace(/^(['"`])(.*)\1$/, '$2').trim();
  const flow = /\[([^\]]*)\]/.exec(`${value} ${extra.join(' ')}`);
  if (flow !== null) return flow[1].split(',').map(clean).filter((word) => word !== '');
  const items = extra.map((line) => /^-\s+(.*)$/.exec(line.trim())).filter((found): found is RegExpExecArray => found !== null);
  if (items.length > 0) return items.map((found) => clean(found[1])).filter((word) => word !== '');
  const single = clean(value);
  return single === '' ? [] : [single];
}

/**
 * A job's `needs` names, and its other lines without filler. The `needs` key sits with the
 * job's other keys; its list lines sit further in.
 */
function splitNeeds(body: string[]): { needs: string[]; rest: string[] } {
  const skip = new Set<number>();
  let needs: string[] = [];
  const keyIndent = indentOf(body[0]) + 2;
  const at = body.findIndex((line, index) => index > 0 && !isFillerLine(line) && indentOf(line) === keyIndent && /^\s*needs\s*:(.*)$/.test(line));
  if (at !== -1) {
    const value = /^\s*needs\s*:(.*)$/.exec(body[at])![1];
    skip.add(at);
    const extra: string[] = [];
    for (let i = at + 1; i < body.length && !isFillerLine(body[i]) && indentOf(body[i]) > indentOf(body[at]); i++) {
      skip.add(i);
      extra.push(body[i]);
    }
    needs = needNames(value, extra);
  }
  return { needs, rest: body.filter((line, index) => !skip.has(index) && !isFillerLine(line)) };
}

/**
 * Whether the project's copy keeps every job the kit's copy has (#552): the same block, but
 * a `needs` list may name more jobs, and the project may add its own. Only the kit's jobs
 * are read: a job the user added under `jobs:`, the way doctor's tests step says, never
 * makes the copy look out of date on its own. False when either copy has no `jobs:` block.
 */
export function hasIntactKitJobs(projectText: string, kitText: string): boolean {
  const project = readJobs(projectText);
  const kit = readJobs(kitText);
  if (project === null || kit === null) return false;
  if (project.before !== kit.before || project.after !== kit.after) return false;
  for (const [name, lines] of kit.jobs) {
    const mine = project.jobs.get(name);
    if (!mine) return false;
    const kept = splitNeeds(mine);
    const wanted = splitNeeds(lines);
    if (!wanted.needs.every((need) => kept.needs.includes(need))) return false;
    if (kept.rest.join('\n') !== wanted.rest.join('\n')) return false;
  }
  return true;
}

/** The state of the project's `rel` against `kitText`, the kit's file rendered for this project. */
export function compareWorkflow(root: string, rel: string, kitText: string, hashes: Record<string, string[]> = readWorkflowHashes()): WorkflowState {
  if (findLinkOnPath(root, rel)) return 'link';
  const path = join(root, rel);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 'missing';
  }
  // A folder or another odd thing at the path is not a copy of the kit's: keep it.
  if (!stat.isFile()) return 'changed';
  const text = lfText(readFileSync(path, 'utf8'));
  if (text === kitText) return 'same';
  if ((hashes[rel] ?? []).includes(fileHash(text))) return 'older';
  // The project's own jobs stay: only the kit's own jobs falling behind says so (#552).
  if (hasIntactKitJobs(text, kitText)) return 'same';
  return 'changed';
}

/** The command that shows how the project's `rel` differs from the kit's copy in its .yokoten/ (or in yokoten itself). */
export const workflowDiffCommand = (root: string, rel: string): string => `git diff --no-index ${rel} ${isSelf(root) ? '' : '.yokoten/'}kit/project/${rel}`;

/** Write one kit workflow: new, or in place of an old kit copy; a changed copy or a symlink is kept. */
function writeWorkflow(root: string, rel: string, kitText: string, env: Env): string {
  const state = compareWorkflow(root, rel, kitText);
  if (state === 'missing') return `${writeNew(join(root, rel), kitText)} ${rel}`;
  if (state === 'same') return `kept ${rel}`;
  if (state === 'link') return `kept ${rel}: it is a symlink, so yokoten did not write through it`;
  if (state === 'changed') return `kept ${rel}: it has your changes. To see how the kit's newest copy differs: \`${workflowDiffCommand(root, rel)}\``;
  const path = join(root, rel);
  // Replace the file only when git can give the old one back: tracked, and the same as HEAD
  // (record 0014: unsure means keep).
  const bytes = readFileSync(path);
  if (!isInHead(root, rel, bytes, env)) return `kept ${rel}: it is an older kit copy that is not committed, so commit it and run init again`;
  // A file with Windows line ends keeps them, so git shows only the lines that changed.
  const isCrlf = bytes.includes('\r\n');
  writeFileSync(path, isCrlf ? normalizeText(kitText).replace(/\n/g, '\r\n') : kitText);
  return `updated ${rel} to the kit's newest copy (you had not changed it; \`git restore --source=HEAD -- ${rel}\` brings the old one back)`;
}

/** The kit's workflows, by path in a project, rendered for `root`; empty when this copy of yokoten has none. */
function readKitWorkflows(root: string): Map<string, string> {
  const dir = join(KIT, 'project', WORKFLOWS_DIR);
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).sort().map((name) => [`${WORKFLOWS_DIR}${name}`, render(readFileSync(join(dir, name), 'utf8'), { cli: cliPath(root), version: VERSION })]));
}

/**
 * For full doctor: one note for each kit workflow that is an old copy, or has the project's
 * changes. A changed copy's note has a `seen` key, the file and the kit's version, so doctor
 * can say it once per kit version (#456); an old copy is noted each time, until init updates it.
 */
export function workflowNotes(root: string): { note: Finding; seen?: string }[] {
  const notes: { note: Finding; seen?: string }[] = [];
  // With CI off init keeps the workflows, so there is nothing to tell the user to run init for.
  if (isCiOffIn(root)) return notes;
  const hashes = readWorkflowHashes();
  for (const [rel, kitText] of readKitWorkflows(root)) {
    const state = compareWorkflow(root, rel, kitText, hashes);
    if (state === 'older') notes.push({ note: finding('kit-workflows', `${rel} is an older copy of the kit's, and you never changed it`, 'run `yokoten init` to update it') });
    if (state === 'changed') {
      const note = finding('kit-workflows', `${rel} has your changes, and the kit's newest copy differs`, `to see how: \`${workflowDiffCommand(root, rel)}\`; copy what you want by hand`);
      notes.push({ note, seen: `${rel} ${textHash(kitText)}` });
    }
  }
  return notes;
}

// ---- A project's own CLAUDE.md and commit hooks (#206) ----
//
// init adds; it never switches a project's setup off without saying so. Claude Code reads
// AGENTS.md only when there is no CLAUDE.md (at the root or in .claude/), so a CLAUDE.md
// gets one line that imports it.
// A project with its own hooks folder (husky, or another core.hooksPath) keeps it, and
// that folder's pre-commit and pre-merge-commit get the yokoten check: one hooks folder,
// so nothing is turned off.

/**
 * The project CLAUDE.md files Claude Code reads instead of AGENTS.md, root first, with
 * the import that reaches the root AGENTS.md from each. Claude Code resolves an `@`
 * import relative to the file that holds it, and the path ends at the first space.
 * Only an `@` import counts: Claude Code does not load a file a Markdown link points to,
 * and it skips code spans and fenced code blocks.
 */
const CLAUDE_FILES = [
  { file: 'CLAUDE.md', rules: 'AGENTS.md', imports: /(?:^|\s)@(?:\.\/)?AGENTS\.md(?=\s|$)/m },
  { file: '.claude/CLAUDE.md', rules: '../AGENTS.md', imports: /(?:^|\s)@\.\.\/AGENTS\.md(?=\s|$)/m },
];

/** The text without its fenced code blocks and code spans, where Claude Code reads no import. */
function removeCode(text: string): string {
  const kept: string[] = [];
  let fence: { mark: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const found = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (found && found[1][0] === fence.mark && found[1].length >= fence.length && found[2].trim() === '') fence = null;
      kept.push('');
    } else if (found && !(found[1][0] === '`' && found[2].includes('`'))) {
      fence = { mark: found[1][0], length: found[1].length };
      kept.push('');
    } else {
      kept.push(line);
    }
  }
  return kept.join('\n').replace(/(`+)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
}

/** The project CLAUDE.md files that are here, root first. */
const findClaudeFiles = (root: string) => CLAUDE_FILES.filter((entry) => existsSync(join(root, entry.file)));

/**
 * Where a CLAUDE.md really is, when it is a link or sits in a linked folder: `rules` when
 * it is the project's AGENTS.md, so Claude Code reads the rules through it (#428); the
 * other file in this repo, or `outside`; null when it is a plain file here.
 */
function followLink(root: string, file: string): { kind: 'rules' } | { kind: 'file'; path: string } | { kind: 'outside' } | null {
  const path = join(root, file);
  const real = realpathSync(path);
  const rules = join(root, 'AGENTS.md');
  if (existsSync(rules) && real === realpathSync(rules)) return { kind: 'rules' };
  const realRoot = realpathSync(root);
  const inside = relative(realRoot, real);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { kind: 'outside' };
  if (!lstatSync(path).isSymbolicLink() && real === join(realRoot, file)) return null;
  return { kind: 'file', path: inside.split(sep).join('/') };
}

/**
 * The CLAUDE.md file that should import AGENTS.md, with its import line, or null when
 * Claude Code reads AGENTS.md here: there is no CLAUDE.md, one of them imports it, or one
 * is a link to it (#428). A plain file gets the import, root first. When every CLAUDE.md
 * is a link to another file, `link` says where it points, and init writes nothing through it.
 */
export function findRulesGap(root: string): { file: string; line: string; link?: string } | null {
  const found = findClaudeFiles(root).map((entry) => ({ ...entry, link: followLink(root, entry.file) }));
  if (found.length === 0 || found.some((entry) => entry.link?.kind === 'rules')) return null;
  if (found.some((entry) => entry.imports.test(removeCode(readFileSync(join(root, entry.file), 'utf8'))))) return null;
  const target = found.find((entry) => entry.link === null) ?? found[0];
  const link = target.link === null ? undefined : target.link.kind === 'file' ? target.link.path : 'a file outside this repo';
  return { file: target.file, line: `@${target.rules}`, ...(link === undefined ? {} : { link }) };
}

/** True when Claude Code reads AGENTS.md here: there is no CLAUDE.md, or one imports AGENTS.md or is a link to it. */
export const claudeReadsRules = (root: string): boolean => findRulesGap(root) === null;

/** The line ending most lines of the text use: CRLF or LF, LF on a tie. */
function findMainNewline(text: string): string {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** Add the AGENTS.md import to the CLAUDE.md that lacks it. Returns the report line, or null when nothing changed. */
function importRules(root: string): string | null {
  const gap = findRulesGap(root);
  if (!gap) return null;
  // A link is the owner's to change: writing through it would change the file it points to (#428).
  if (gap.link) return `left ${gap.file} as it is: it is a link to ${gap.link}, so Claude Code does not read AGENTS.md; add a line \`${gap.line}\` to that file, or make ${gap.file} a plain file`;
  const path = join(root, gap.file);
  const text = readFileSync(path, 'utf8');
  const newline = findMainNewline(text);
  // The project's lines, then one blank line, whatever line endings the file ends with.
  const kept = text.replace(/[\r\n]+$/, '');
  const spacing = kept === '' ? '' : newline + newline;
  writeFileSync(path, `${kept}${spacing}<!-- Added by yokoten: Claude Code reads AGENTS.md only through this import. -->${newline}${gap.line}${newline}`);
  return `updated ${gap.file}: it now reads AGENTS.md (Claude Code reads AGENTS.md only when a CLAUDE.md imports it)`;
}

/** How git runs commit hooks here: yokoten's .githooks, the project's own folder, or no git repo. */
type HookSetup = { kind: 'plain' } | { kind: 'own'; hooksPath: string } | { kind: 'no repo' };

// Each git answer is kept for the run (`withGitReads`, src/run/check.ts): a doctor or an init.
export { withGitReads };

/**
 * The repo's own core.hooksPath (not the user's global one), '' when unset, or null outside
 * a git repo. Files included from .git/config count, as git itself reads them. In a run, from
 * the config list and the git folder, which other checks read too.
 */
const readLocalHooksPath = (root: string, env: Env): string | null => {
  const entries = configEntries(root, 'core.hooksPath', env);
  if (entries) return gitLine(root, ['rev-parse', '--git-common-dir'], env) === null ? null : (entries.filter((entry) => entry.scope === 'local').at(-1)?.value ?? '').trim();
  return remembered(`local-hooks-path\0${root}`, () => {
    try {
      return execFileSync('git', ['config', '--local', '--includes', '--get', 'core.hooksPath'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (error) {
      return (error as { status?: number }).status === 1 ? '' : null;
    }
  });
};

export function readHookSetup(root: string, env: Env): HookSetup {
  const hooksPath = readLocalHooksPath(root, env);
  if (hooksPath === null) return { kind: 'no repo' };
  const isHusky = existsSync(join(root, '.husky'));
  if (!isHusky && (hooksPath === '' || hookFile(root, hooksPath) === '.githooks/pre-commit')) return { kind: 'plain' };
  return { kind: 'own', hooksPath };
}

/**
 * The hooks git runs before it makes a commit: pre-commit, and pre-merge-commit for a
 * merge that git commits itself (`git merge --no-ff` without a conflict). Both run the
 * commit check (#239).
 */
export const COMMIT_HOOKS = ['pre-commit', 'pre-merge-commit'] as const;

export type CommitHook = (typeof COMMIT_HOOKS)[number];

/**
 * The hook file git runs for this core.hooksPath, relative to the root, or null when the
 * folder is outside the repo. husky's folder (`.husky/_`, or `.husky` before husky 9)
 * runs `.husky/pre-commit` and `.husky/pre-merge-commit`.
 */
export function hookFile(root: string, hooksPath: string, hook: CommitHook = 'pre-commit'): string | null {
  const folder = relative(root, resolve(root, hooksPath)).split('\\').join('/');
  if (folder === '..' || folder.startsWith('../') || isAbsolute(folder)) return null;
  if (folder === '.husky' || folder.startsWith('.husky/')) return `.husky/${hook}`;
  return folder ? `${folder}/${hook}` : hook;
}

/** The lines init adds to a project's own pre-commit and pre-merge-commit. `exit 1` because a hook may go on after them. */
export const checkLines = (cli: string): string[] => ['# yokoten: the commit check (lead-only files, test files in a fix task, layout and privacy)', commitCheckLine(cli)];

/**
 * Add the yokoten check to a commit hook, after its `#!` line, so a later `exec` can't skip it.
 * Its own lines stay. A hook git would skip, for lack of the execute bit, is made executable.
 * A file under .husky/ keeps its mode: husky 9 runs it with `sh`, so a chmod is only noise in the diff (#256).
 */
function addCheckLines(path: string, cli: string): 'added the check to' | 'wrote' | 'made executable' | 'same' {
  const keepMode = basename(dirname(path)) === '.husky';
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ['#!/bin/sh', ...checkLines(cli), ''].join('\n'), { mode: 0o755 });
    chmodSync(path, 0o755);
    return 'wrote';
  }
  const text = readFileSync(path, 'utf8');
  if (runs('check').test(text)) {
    if (keepMode || isExecutable(path)) return 'same';
    chmodSync(path, statSync(path).mode | 0o111);
    return 'made executable';
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, ...checkLines(cli));
  writeFileSync(path, lines.join(newline));
  if (!keepMode) chmodSync(path, statSync(path).mode | 0o111);
  return 'added the check to';
}

/** Whether git runs this hook file. Windows has no execute bit, and git there runs a hook without one. */
export const isExecutable = (path: string): boolean => process.platform === 'win32' || (statSync(path).mode & 0o111) !== 0;

// ---- The hooks a clone already has in .git/hooks (#256) ----
//
// With core.hooksPath unset, git runs the hooks in .git/hooks: lefthook's, the pre-commit
// framework's, or a hand-written one. Pointing git at .githooks would switch every one of
// them off without a word, not only the commit hooks. So .githooks/pre-commit and
// .githooks/pre-merge-commit run the check and then hand off to the old hook, and each
// other hook gets a .githooks file that only hands off, with the same arguments and stdin.
//
// The old hook stays where it is. Once core.hooksPath is .githooks, `git rev-parse
// --git-path hooks` names .githooks, so the hand-off finds the old hook by the common git
// dir, which never moves (a linked worktree shares it). Nothing is renamed, so a tool that
// finds its hook by name still finds it, and unsetting core.hooksPath gives back the setup
// the clone had. The hand-off skips a hook that is the running file itself (`-ef`, through
// a link), so a .git/hooks link to .githooks does not loop; no variable can switch it off.

/** The hooks git runs, by name (githooks(5)). Any other file in a hooks folder is never run. */
const GIT_HOOKS = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman',
  'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
]);

/** Hooks that read stdin: two of them in one file can't both read it, so yokoten won't join them. */
const STDIN_HOOKS = new Set(['pre-push', 'pre-receive', 'post-receive', 'post-rewrite', 'reference-transaction', 'proc-receive']);

export const isCommitHook = (hook: string): hook is CommitHook => (COMMIT_HOOKS as readonly string[]).includes(hook);

/** A hook that git runs now, from .git/hooks or a global core.hooksPath, and .githooks would switch off. */
export interface OldHook {
  hook: string;
  /** Where it is, for a message: relative to the root, or from ~. */
  file: string;
  /**
   * yes: .githooks can run it (after the check, for a commit hook). not executable: git
   * skips it today, so nothing is lost. global: a commit hook from a global core.hooksPath,
   * which .githooks can't run.
   */
  handOff: 'yes' | 'not executable' | 'global';
}

/** What git prints for `args` in `root`, trimmed, or null when it fails; kept for the run. */
const gitLine = (root: string, args: string[], env: Env): string | null =>
  remembered(`line\0${root}\0${args.join('\0')}`, () => {
    try {
      return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  });

/** A path for a message: relative to the root, or from ~, so no home folder is printed. */
const showPath = (root: string, path: string): string => {
  const rel = relative(root, path);
  if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join('/');
  // Display only: the system's home, as hideHome hides it; nothing is read there (#356).
  const home = systemHome();
  return (home && path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path).split(sep).join('/');
};

const sameFile = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/** Whether a core.hooksPath comes from the global or system config. */
const hasOtherHooksPath = (root: string, env: Env): boolean => {
  const entries = configEntries(root, 'core.hooksPath', env);
  if (entries) return entries.some((entry) => ['global', 'system', 'command'].includes(entry.scope));
  return (gitLine(root, ['config', '--show-scope', '--get-all', 'core.hooksPath'], env) ?? '').split('\n').some((line) => /^(?:global|system|command)\t/.test(line));
};

/**
 * The hooks this clone has outside .githooks that git runs (or, with core.hooksPath set,
 * ran before it). A hook that is .githooks's own file, through a link, is not one. When a
 * global core.hooksPath decides which hooks run, the files in .git/hooks are dead, so they
 * are not counted; that folder's own commit hooks are, as hooks .githooks can't run.
 */
export function readOldHooks(root: string, env: Env): OldHook[] {
  const hooksPath = readLocalHooksPath(root, env);
  const common = hooksPath === null ? null : gitLine(root, ['rev-parse', '--git-common-dir'], env);
  if (common === null) return [];
  const ownDir = resolve(root, common, 'hooks');
  if (hasOtherHooksPath(root, env)) {
    // With core.hooksPath set here too, the global one decided before it was set.
    if (hooksPath !== '') return [];
    const dir = gitLine(root, ['rev-parse', '--git-path', 'hooks'], env);
    if (dir !== null && !sameFile(resolve(root, dir), ownDir)) {
      return COMMIT_HOOKS.flatMap((hook): OldHook[] => {
        const path = resolve(root, dir, hook);
        if (!existsSync(path) || sameFile(path, join(root, '.githooks', hook))) return [];
        return [{ hook, file: showPath(root, path), handOff: 'global' }];
      });
    }
  }
  let names: string[];
  try {
    names = readdirSync(ownDir).filter((name) => GIT_HOOKS.has(name)).sort();
  } catch {
    return [];
  }
  const found: OldHook[] = [];
  for (const hook of names) {
    const path = join(ownDir, hook);
    if (!existsSync(path) || statSync(path).isDirectory() || sameFile(path, join(root, '.githooks', hook))) continue;
    const file = showPath(root, path);
    if (isExecutable(path)) found.push({ hook, file, handOff: 'yes' });
    // git skips it today; with core.hooksPath set, there is nothing to lose.
    else if (hooksPath === '') found.push({ hook, file, handOff: 'not executable' });
  }
  return found;
}

/**
 * The lines in .githooks/<hook> that run the old hook in .git/hooks: after the check, or,
 * for a hook with no check, on their own. They skip the old hook when it is this file.
 */
export const handOffLines = (hook: string): string[] => [
  `# yokoten: ${isCommitHook(hook) ? 'then ' : ''}the ${hook} this clone has in .git/hooks, as git ran it before core.hooksPath was set (#256)`,
  `yokoten_old="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/${hook}"; if [ -x "$yokoten_old" ] && ! [ "$yokoten_old" -ef "$0" ]; then "$yokoten_old" "$@" || exit $?; fi`,
];

/** Whether a hook's text already hands off to the old hook. */
export const hasHandOff = (text: string, hook: string): boolean => new RegExp(`--git-common-dir[^\\n]*\\)/hooks/${hook}"`).test(text);

/** The check as the kit's hook ends with it: `exec`, so nothing after it would run. */
const EXEC_CHECK = /^exec\s+(node\s+\S+\s+check\s+--staged)\s*$/;

/**
 * The hook's text with the hand-off in place, or null when yokoten can't tell where that
 * is. In a commit hook it goes after the check: a line at column 0 (not inside an `if` or
 * a function) that ends in `|| exit 1`, or the kit's `exec node ... check --staged` as the
 * last line, which then loses its `exec`. Another hook has no check, so it goes after the
 * `#!` line, unless the hook reads stdin, which only one of the two could read.
 */
export function placeHandOff(text: string, hook: string): string | null {
  if (hasHandOff(text, hook)) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (!isCommitHook(hook)) {
    if (STDIN_HOOKS.has(hook)) return null;
    lines.splice(lines[0]?.startsWith('#!') ? 1 : 0, 0, ...handOffLines(hook));
    return lines.join(newline);
  }
  const at = lines.findIndex((line) => /^\S/.test(line) && runs('check').test(line));
  if (at === -1) return null;
  const exec = lines[at].match(EXEC_CHECK);
  if (exec) {
    if (lines.slice(at + 1).some((line) => line.trim() !== '')) return null;
    lines[at] = `${exec[1]} || exit 1`;
  } else if (!/\|\|\s*exit(?:\s+(?:1|\$\?))?\s*$/.test(lines[at])) return null;
  lines.splice(at + 1, 0, ...handOffLines(hook));
  return lines.join(newline);
}

/**
 * Why .githooks can't take over from the old hooks here, one line each, with what to do;
 * empty when it can. Read before init writes .githooks, and by doctor.
 */
export function handOffBlocks(root: string, env: Env, olds: OldHook[] = readOldHooks(root, env)): string[] {
  const thenSet = readLocalHooksPath(root, env) === '' ? '; then run `git config core.hooksPath .githooks`' : '';
  return olds.flatMap((old): string[] => {
    const own = `.githooks/${old.hook}`;
    if (old.handOff === 'not executable') return [];
    if (old.handOff === 'global') {
      return [`git runs ${old.hook} from your global core.hooksPath (${old.file}), which ${own} can't run. To use the commit check in this repo instead, run \`git config core.hooksPath .githooks\``];
    }
    const path = join(root, own);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    if (isCommitHook(old.hook)) {
      // A hook without the check gets the check line, and the hand-off goes after it.
      if (!runs('check').test(text) || placeHandOff(text, old.hook) !== null) return [];
      return [`${own} is the project's own, and yokoten can't tell where its check ends. To keep ${old.file}, add this line after the check: ${handOffLines(old.hook)[1]}${thenSet}`];
    }
    if (placeHandOff(text, old.hook) !== null) return [];
    return [`${own} is the project's own and reads stdin, as ${old.file} does, so yokoten can't run both from one file. To keep ${old.file}, make ${own} save stdin to a file and give it to both: its own lines, and ${old.file} with the same arguments${thenSet}`];
  });
}

/** For each old hook git skips for lack of the execute bit: how to keep it running. */
export const deadHookNotes = (olds: OldHook[]): string[] =>
  olds.filter((old) => old.handOff === 'not executable').map((old) => `${old.file} is not executable, so git skips it today; \`chmod +x ${old.file}\` and run \`yokoten init\` again to keep it running`);

/** The config files of hook managers that install into .git/hooks. */
const HOOK_MANAGERS = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', '.pre-commit-config.yaml'];

/**
 * Write .githooks/pre-commit and .githooks/pre-merge-commit, and a .githooks file for each
 * other old hook. A new commit hook is the kit's hook, or, when this clone has an old hook,
 * the check and then the hand-off; a new other hook only hands off. One that is there is
 * kept, and gets the check when it is a commit hook that lacks it (#239, #256), and the hand-off.
 */
function writeGithooks(root: string, cli: string, kit: string, handOff: boolean, env: Env): string[] {
  const olds = handOff ? readOldHooks(root, env).filter((old) => old.handOff === 'yes') : [];
  const lines: string[] = [];
  const others = olds.map((old) => old.hook).filter((hook) => !isCommitHook(hook));
  for (const hook of [...COMMIT_HOOKS, ...others]) {
    const rel = `.githooks/${hook}`;
    const path = join(root, rel);
    const old = olds.find((o) => o.hook === hook);
    if (!existsSync(path)) {
      let text: string;
      if (!isCommitHook(hook)) text = ['#!/bin/sh', ...handOffLines(hook), ''].join('\n');
      else if (old) text = ['#!/bin/sh', ...checkLines(cli), ...handOffLines(hook), ''].join('\n');
      else text = render(readFileSync(join(kit, '.githooks', 'pre-commit'), 'utf8'), { cli, version: VERSION });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, { mode: 0o755 });
      chmodSync(path, 0o755);
      lines.push(`wrote ${rel}`);
    } else {
      const result = isCommitHook(hook) ? addCheckLines(path, cli) : 'same';
      const text = readFileSync(path, 'utf8');
      const placed = old && !hasHandOff(text, hook) ? placeHandOff(text, hook) : null;
      if (placed !== null) {
        writeFileSync(path, placed);
        chmodSync(path, statSync(path).mode | 0o111);
      }
      lines.push(`${placed !== null ? 'updated' : result === 'same' ? 'kept' : result} ${rel}`);
    }
    if (old) lines.push(`kept your ${old.file}: ${rel} runs it${isCommitHook(hook) ? ' after the check' : ''}`);
  }
  return lines;
}

/** Point git at the commit check: set .githooks, or add the check to the project's own pre-commit. */
function setCommitCheck(root: string, cli: string, hooks: HookSetup, blocks: string[], env: Env): string[] {
  if (hooks.kind === 'no repo') return ['not a git repo: run `git init`, then `git config core.hooksPath .githooks`'];
  if (hooks.kind === 'plain') {
    const unset = readLocalHooksPath(root, env) === '';
    const olds = readOldHooks(root, env);
    const dead = deadHookNotes(olds).map((line) => `note: ${line}`);
    const managers = HOOK_MANAGERS.filter((name) => existsSync(join(root, name))).join(' and ');
    if (blocks.length) {
      const note = olds.some((old) => old.handOff === 'yes') && managers ? [`note: ${managers} is here; its hooks in .git/hooks still run, because core.hooksPath stays unset`] : [];
      const head = unset ? 'left core.hooksPath unset, so the commit check is not on yet' : 'a hook this clone had is switched off';
      return [`${head}: ${blocks.join('; ')}`, ...note, ...dead];
    }
    const handed = olds.filter((old) => old.handOff === 'yes' && hasHandOff(readFileSync(join(root, '.githooks', old.hook), 'utf8'), old.hook));
    const list = handed.map((old) => `${old.file}${isCommitHook(old.hook) ? ' (after the check)' : ''}`).join(', ');
    const note = handed.length && managers ? [`note: ${managers} is here; .githooks runs these hooks in .git/hooks: ${list}. A hook it installs later does not run until \`yokoten init\` hands off to it, and \`yokoten doctor\` names it`] : [];
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, env, stdio: 'pipe' });
    // The answers kept so far name the old value.
    forgetGitReads();
    return ['set git core.hooksPath to .githooks (the commit check)', ...note, ...dead];
  }
  const { hooksPath } = hooks;
  const fileOf = (hook: CommitHook) => (hooksPath ? hookFile(root, hooksPath, hook) : `.husky/${hook}`);
  const owner = hooksPath ? `core.hooksPath (${fileOf('pre-commit') === '.husky/pre-commit' ? 'husky' : hooksPath})` : 'husky';
  if (fileOf('pre-commit') === null) {
    return [`kept core.hooksPath: it is outside this repo, so yokoten did not change it. Add this line to its pre-commit and pre-merge-commit: ${commitCheckLine(cli)}`];
  }
  const lines = COMMIT_HOOKS.map((hook) => {
    const file = fileOf(hook) as string;
    return `${addCheckLines(join(root, file), cli)} ${file}: the commit check (kept ${owner}, so the project's own hooks still run)`;
  });
  if (!hooksPath) lines.push('husky is not set up in this clone yet: run `npm install` (husky sets core.hooksPath), and the check runs from .husky/pre-commit and .husky/pre-merge-commit');
  return lines;
}

// ---- The core rules in AGENTS.md (#120) ----
//
// init writes AGENTS.md once, so a lesson added to the kit's core rules never reaches a
// project on its own. `doctor` compares the core part with the kit, and `yokoten update`
// replaces it, only when asked. The project's own part, from `## This project` down, is
// the project's file: it is kept byte for byte.

/** The heading where a project's own rules start. Everything above it is the kit's core rules. */
export const PROJECT_HEADING = '## This project';

/** Where the project's own part starts, or -1 when there is no `## This project` line. */
const findProjectStart = (text: string): number => text.search(/^## This project[ \t]*\r?$/m);

const splitLines = (text: string): string[] => text.split(/\r?\n/);

// ---- The core rules into an AGENTS.md the project already has (#378) ----
//
// Without `## This project`, yokoten can't tell the core rules from the project's own, so
// doctor can only ask the owner to merge the two by hand. init does the merge: the kit's
// core rules on top, then `## This project`, then the project's text. Its headings go one
// level down, so they sit under that heading; every other byte stays. A file that has the
// heading is left to `update`.

/** One heading the move took one level down, as it read before and reads after, ready to print. */
export interface MovedHeading {
  before: string;
  after: string;
}

/** The new AGENTS.md, and what the move changed in the project's text. */
export interface MovedRules {
  text: string;
  /** The project's lines that moved; 0 for an empty file. */
  lines: number;
  headings: MovedHeading[];
  /** `######` headings: Markdown has no seventh level, so they stay as they are. */
  deepest: string[];
  hadBom: boolean;
  /** Whether the file started with YAML front matter, which stays at the very top. */
  frontMatter: boolean;
}

/**
 * Split off YAML front matter: a first line `---` and a closing `---` or `...` line, with
 * their line ends. Without a closing line there is no front matter, and `front` is empty.
 */
export function splitFrontMatter(text: string): { front: string; rest: string } {
  const found = /^---[ \t]*\r?\n(?:[^\n]*\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return found ? { front: found[0], rest: text.slice(found[0].length) } : { front: '', rest: text };
}

const ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
const SETEXT_LINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** A line that can't be the text of a setext heading: a heading or a rule. */
const NOT_PARAGRAPH = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$)/;
/** A list item, a quote or HTML: the lines after it, up to a blank line, belong to it, never to a heading. */
const OTHER_BLOCK = /^ {0,3}(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|<)/;

/**
 * The project's text with each heading one level down: `#` to `##`, a `===` underline to
 * `---`, and a `---` underline to a `###` line (Markdown has no third underline). Headings
 * inside fenced code blocks stay. Line endings stay as each line has them.
 */
export function demoteHeadings(text: string): { text: string; headings: MovedHeading[]; deepest: string[] } {
  // Each line with its own ending, so CRLF and LF lines both stay as they are.
  const lines = (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((piece) => {
    const end = piece.match(/\r?\n$/)?.[0] ?? '';
    return { body: piece.slice(0, piece.length - end.length), end };
  });
  const headings: MovedHeading[] = [];
  const deepest: string[] = [];
  const out: { body: string; end: string }[] = [];
  let fence: { mark: string; length: number } | null = null;
  // Where the paragraph that ends at the current line starts in `out`, or -1.
  let paragraph = -1;
  // Inside a list item, a quote or HTML, where a line under the text is never a heading underline.
  let other = false;
  for (const line of lines) {
    const found = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.body);
    if (fence) {
      if (found && found[1][0] === fence.mark && found[1].length >= fence.length && found[2].trim() === '') fence = null;
      out.push(line);
      continue;
    }
    if (found && !(found[1][0] === '`' && found[2].includes('`'))) {
      fence = { mark: found[1][0], length: found[1].length };
      paragraph = -1;
      out.push(line);
      continue;
    }
    if (paragraph !== -1 && SETEXT_LINE.test(line.body)) {
      const words = out.slice(paragraph).map((part) => part.body.trim()).join(' ');
      const before = `\`${words}\` (underlined with ${line.body.trim()[0]})`;
      if (line.body.includes('=')) {
        out.push({ body: line.body.replaceAll('=', '-'), end: line.end });
        headings.push({ before, after: `\`${words}\` (underlined with -)` });
      } else {
        const heading = `### ${words}`;
        out.splice(paragraph, out.length - paragraph, { body: heading, end: line.end });
        headings.push({ before, after: `\`${heading}\`` });
      }
      paragraph = -1;
      continue;
    }
    const atx = ATX_HEADING.exec(line.body);
    if (atx) {
      if (atx[2].length === 6) deepest.push(`\`${line.body.trim()}\``);
      else {
        const body = `${atx[1]}#${line.body.slice(atx[1].length)}`;
        headings.push({ before: `\`${line.body.trim()}\``, after: `\`${body.trim()}\`` });
        line.body = body;
      }
      paragraph = -1;
      other = false;
    } else if (line.body.trim() === '') {
      paragraph = -1;
      other = false;
    } else if (NOT_PARAGRAPH.test(line.body) || OTHER_BLOCK.test(line.body)) {
      paragraph = -1;
      other = OTHER_BLOCK.test(line.body);
    } else if (paragraph === -1 && !other) {
      // Four spaces where no paragraph goes on start a code block, not a paragraph.
      if (!/^ {4}|^\t/.test(line.body)) paragraph = out.length;
    }
    out.push(line);
  }
  return { text: out.map((line) => line.body + line.end).join(''), headings, deepest };
}

/**
 * The kit's core rules, then `## This project`, then the project's own text with its
 * headings one level down. `kit` is the kit's AGENTS.md, rendered. The new lines take the
 * line ending most of the project's lines use. A byte order mark is dropped: the kit
 * version mark must start the file.
 */
export function moveUnderProjectHeading(project: string, kit: string): MovedRules {
  const hadBom = project.startsWith('\uFEFF');
  const { front, rest: own } = splitFrontMatter(hadBom ? project.slice(1) : project);
  const frontMatter = front !== '';
  const newline = findMainNewline(front + own);
  // Front matter stays on top, and ends in a newline so the kit's first line starts a line.
  const top = front === '' || /\n$/.test(front) ? front : front + newline;
  const kitStart = findProjectStart(kit);
  if (own.trim() === '') return { text: top + splitLines(kit).join(newline), lines: 0, headings: [], deepest: [], hadBom, frontMatter };
  const core = splitLines(kit.slice(0, kitStart)).join(newline);
  const demoted = demoteHeadings(own);
  return {
    frontMatter,
    text: `${top}${core}${PROJECT_HEADING}${newline}${newline}${demoted.text}`,
    lines: splitLines(own.replace(/\r?\n$/, '')).length,
    headings: demoted.headings,
    deepest: demoted.deepest,
    hadBom,
  };
}

/** The name of the copy init keeps of an AGENTS.md that git can't give back. */
export const AGENTS_BACKUP = 'AGENTS.md.before-yokoten';

/** Whether HEAD has this file with these exact bytes, so git can give it back. */
function isInHead(root: string, rel: string, bytes: Buffer, env: Env): boolean {
  try {
    const committed = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return committed.equals(bytes);
  } catch {
    return false;
  }
}

/**
 * Put the core rules into the project's AGENTS.md when it has no `## This project`
 * heading. Returns the report lines. The old file can always come back: from git when
 * HEAD has it as it is, or else from a copy next to it.
 */
function addCoreRules(root: string, kit: string, env: Env): string[] {
  const path = join(root, 'AGENTS.md');
  if (lstatSync(path).isSymbolicLink()) {
    return [`kept AGENTS.md: it is a link to ${readlinkSync(path)}, so yokoten did not write the core rules into it. Put them in by hand, above a \`${PROJECT_HEADING}\` heading`];
  }
  const bytes = readFileSync(path);
  const project = bytes.toString('utf8');
  if (findProjectStart(project) !== -1) return ['kept AGENTS.md (`yokoten update` brings its core rules up to date)'];
  if (findProjectStart(kit) === -1) return [`kept AGENTS.md: the kit's AGENTS.md has no \`${PROJECT_HEADING}\` heading; report it in an issue at yokoten`];
  let restore = 'to get the old file back: `git checkout HEAD -- AGENTS.md`';
  if (!isInHead(root, 'AGENTS.md', bytes, env)) {
    const backup = join(root, AGENTS_BACKUP);
    if (existsSync(backup) && !readFileSync(backup).equals(bytes)) {
      return [`kept AGENTS.md: it has no \`${PROJECT_HEADING}\` heading, and ${AGENTS_BACKUP} is there already, so yokoten kept both as they are. Move ${AGENTS_BACKUP} away, then run \`yokoten init\` again`];
    }
    writeFileSync(backup, bytes);
    restore = `kept the old file as ${AGENTS_BACKUP}; delete it once the new AGENTS.md reads right`;
  }
  const moved = moveUnderProjectHeading(project, kit);
  writeFileSync(path, moved.text);
  if (moved.lines === 0) return [`wrote AGENTS.md: it had no text${moved.frontMatter ? ' below its front matter' : ''}, so it now has the core rules and an empty \`${PROJECT_HEADING}\` section (${restore})`];
  const lines = [`updated AGENTS.md: the core rules are on top, and your ${moved.lines} line(s) moved under \`${PROJECT_HEADING}\`; only their heading levels changed (${restore})`];
  for (const heading of moved.headings) lines.push(`  heading one level down: ${heading.before} is now ${heading.after}`);
  if (moved.deepest.length) lines.push(`  kept at level 6 (Markdown has no level 7): ${moved.deepest.join(', ')}`);
  if (moved.frontMatter) lines.push('  kept the front matter at the very top, as it was');
  if (moved.hadBom) lines.push('  dropped the byte order mark at the start: the kit version line must come first');
  lines.push('  read the core rules, and remove any rule of yours under them that says the same thing');
  return lines;
}

// ---- The kit version in AGENTS.md (#141) ----
//
// The first line of the kit's AGENTS.md says which kit wrote the core rules, as an HTML
// comment, so GitHub shows nothing. With it, a project written by a newer yokoten is not
// "behind", and `update --write` never takes it back to an older kit. A file without the
// mark (every project before #141) has an unknown version and compares by content only.

/** The kit version mark, for example `<!-- yokoten kit 0.1.0 -->`. */
const KIT_MARK = /^<!-- yokoten kit (\S+) -->[ \t]*$/;

const isMarkLine = (line: string): boolean => KIT_MARK.test(line);

/** The kit version that a core part names, or null when it has no mark. */
export const readKitVersion = (core: string): string | null => {
  for (const line of splitLines(core)) {
    const found = line.match(KIT_MARK);
    if (found) return found[1];
  }
  return null;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver order of two pre-release tags, like `beta.2` and `beta.10`. */
function comparePrerelease(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    const [a, b] = [leftParts[index], rightParts[index]];
    if (a === b) continue;
    const [isNumberA, isNumberB] = [/^\d+$/.test(a), /^\d+$/.test(b)];
    if (isNumberA && isNumberB) return Math.sign(Number(a) - Number(b));
    if (isNumberA !== isNumberB) return isNumberA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return Math.sign(leftParts.length - rightParts.length);
}

/** -1, 0 or 1 as `left` is older than, the same as, or newer than `right`; null when either is not a semver version. */
export function compareVersions(left: string, right: string): number | null {
  const a = left.match(SEMVER);
  const b = right.match(SEMVER);
  if (!a || !b) return null;
  for (let part = 1; part <= 3; part++) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference) return Math.sign(difference);
  }
  if (a[4] === b[4]) return 0;
  if (a[4] === undefined) return 1;
  if (b[4] === undefined) return -1;
  return comparePrerelease(a[4], b[4]);
}

/** One line the update adds or removes. */
export interface LineChange {
  kind: 'added' | 'removed';
  line: string;
}

/** The `##` sections of the core part that the update adds, removes or changes. The text above the first is "the opening". */
export interface SectionChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/** How a project's core rules compare with the kit's. */
export type CoreRules =
  | { state: 'same' }
  | { state: "can't compare"; why: string; fix: string }
  | { state: 'behind'; changes: LineChange[]; sections: SectionChanges; updated: string }
  | { state: 'newer'; version: string; kitVersion: string };

/** The lines to remove and add to turn `before` into `after`, from their longest common run. */
function diffLines(before: string[], after: string[]): LineChange[] {
  // common[row][column]: the longest common run of before[row..] and after[column..].
  const common = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));
  for (let row = before.length - 1; row >= 0; row--) {
    for (let column = after.length - 1; column >= 0; column--) {
      common[row][column] = before[row] === after[column] ? common[row + 1][column + 1] + 1 : Math.max(common[row + 1][column], common[row][column + 1]);
    }
  }
  const changes: LineChange[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length || column < after.length) {
    if (row < before.length && column < after.length && before[row] === after[column]) {
      row++;
      column++;
    } else if (column === after.length || (row < before.length && common[row + 1][column] >= common[row][column + 1])) {
      changes.push({ kind: 'removed', line: before[row++] });
    } else {
      changes.push({ kind: 'added', line: after[column++] });
    }
  }
  return changes;
}

/** Each `##` section of a core part, by name, with its text. */
function readSections(lines: string[]): Map<string, string> {
  const sections = new Map<string, string>();
  let name = 'the opening';
  let body: string[] = [];
  for (const line of [...lines, '## ']) {
    if (!line.startsWith('## ')) {
      body.push(line);
      continue;
    }
    sections.set(name, body.join('\n'));
    name = line.slice(3).trim();
    body = [];
  }
  return sections;
}

function compareSections(before: string[], after: string[]): SectionChanges {
  const old = readSections(before);
  const next = readSections(after);
  return {
    added: [...next.keys()].filter((name) => !old.has(name)),
    removed: [...old.keys()].filter((name) => !next.has(name)),
    changed: [...next.keys()].filter((name) => old.has(name) && old.get(name) !== next.get(name)),
  };
}

/**
 * Compare a project's AGENTS.md with the kit's, rendered. Line ends and the kit version
 * mark do not count, so a checkout with CRLF is not behind. When the text differs and the
 * project's mark is newer than the kit's, it is `newer`, never `behind` (#141). `updated` is the file with the kit's core part and
 * the project's own part as it is.
 */
export function compareCoreRules(file: string, kit: string): CoreRules {
  // Front matter above the core rules is the project's: not compared, and kept by an update (#378).
  const { front, rest: project } = splitFrontMatter(file);
  const kitStart = findProjectStart(kit);
  if (kitStart === -1) return { state: "can't compare", why: `the kit's AGENTS.md has no \`${PROJECT_HEADING}\` heading`, fix: 'report it in an issue at yokoten' };
  const start = findProjectStart(project);
  if (start === -1) {
    return {
      state: "can't compare",
      why: `AGENTS.md has no \`${PROJECT_HEADING}\` heading, so yokoten can't tell the core rules from the project's own`,
      fix: `put the project's own rules under a \`${PROJECT_HEADING}\` heading at the end of AGENTS.md, below the core rules`,
    };
  }
  const before = splitLines(project.slice(0, start)).filter((line) => !isMarkLine(line));
  const after = splitLines(kit.slice(0, kitStart)).filter((line) => !isMarkLine(line));
  if (before.join('\n') === after.join('\n')) return { state: 'same' };
  const version = readKitVersion(project.slice(0, start));
  const kitVersion = readKitVersion(kit.slice(0, kitStart));
  if (version !== null && kitVersion !== null && compareVersions(version, kitVersion) === 1) return { state: 'newer', version, kitVersion };
  const kitCore = splitLines(kit.slice(0, kitStart));
  const core = project.slice(0, start).includes('\r\n') ? kitCore.join('\r\n') : kitCore.join('\n');
  return { state: 'behind', changes: diffLines(before, after), sections: compareSections(before, after), updated: front + core + project.slice(start) };
}

/** The kit's AGENTS.md, rendered for this project, or null when this copy of yokoten has no kit. A project's .yokoten/ has this kit file (#145) and the kit's lessons (#77). */
function readKitRules(root: string): string | null {
  const path = join(KIT, 'project', 'AGENTS.md');
  return existsSync(path) ? render(readFileSync(path, 'utf8'), { cli: cliPath(root), version: VERSION }) : null;
}

/** The project's core rules against the kit's, or null when the project has no AGENTS.md. */
export function readCoreRules(root: string): CoreRules | null {
  const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) return null;
  const kit = readKitRules(root);
  if (kit === null) {
    return { state: "can't compare", why: 'this copy of yokoten has no kit (a .yokoten/ copy made before #145 has none)', fix: 'run `yokoten init` again to refresh .yokoten/, or run the command from an installed yokoten, the Claude Code plugin (/yokoten:update), or a clone' };
  }
  return compareCoreRules(readFileSync(path, 'utf8'), kit);
}

/** A short summary of an update: line counts, then the sections it touches. */
export function summarizeUpdate(rules: { changes: LineChange[]; sections: SectionChanges }): string {
  const count = (kind: LineChange['kind']) => rules.changes.filter((change) => change.kind === kind).length;
  const parts = [`${count('added')} line(s) added, ${count('removed')} removed`];
  for (const kind of ['changed', 'added', 'removed'] as const) {
    if (rules.sections[kind].length) parts.push(`sections ${kind}: ${rules.sections[kind].join(', ')}`);
  }
  return parts.join('; ');
}

/**
 * `yokoten update`: replace the core part of AGENTS.md with the kit's. Without `write`
 * it only shows the change. `ok` is false when there is nothing it can compare.
 */
export function updateCoreRules(root: string, { write }: { write: boolean }): { ok: boolean; lines: string[] } {
  const rules = readCoreRules(root);
  if (rules === null) return { ok: false, lines: ['no AGENTS.md here; nothing was written. Run `yokoten init` to add one'] };
  if (rules.state === "can't compare") return { ok: false, lines: [`can't compare AGENTS.md with the kit: ${rules.why}. Nothing was written. To fix it, ${rules.fix}`] };
  if (rules.state === 'same') return { ok: true, lines: [`the core rules in AGENTS.md are up to date with yokoten ${VERSION}; nothing to change`] };
  if (rules.state === 'newer') {
    return { ok: false, lines: [`AGENTS.md was written by yokoten ${rules.version}, newer than this yokoten ${VERSION}. Nothing was written: an update would take the core rules back to an older kit. Update yokoten itself instead, then run \`yokoten update\` again`] };
  }
  const summary = summarizeUpdate(rules);
  if (write) {
    writeFileSync(join(root, 'AGENTS.md'), rules.updated);
    return { ok: true, lines: [`replaced the core rules in AGENTS.md with yokoten ${VERSION}'s: ${summary}. "${PROJECT_HEADING}" and below are unchanged`] };
  }
  return {
    ok: true,
    lines: [
      `the core rules in AGENTS.md differ from yokoten ${VERSION}'s: ${summary}`,
      '',
      ...rules.changes.map((change) => `${change.kind === 'added' ? '+' : '-'} ${change.line.trim() ? change.line : '(a blank line)'}`),
      '',
      'A line marked - is replaced. An older kit wrote it, or someone edited it by hand.',
      `Move any rule of your own under "${PROJECT_HEADING}" first. That part stays as it is.`,
      'Nothing was written. Run `yokoten update --write` to write it.',
    ],
  };
}
