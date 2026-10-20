// `yokoten init`: put the practices into a project. It only adds: a file that is already
// there is kept, and the report says so. Some files get lines added, never removed: a
// CLAUDE.md, and a project's own pre-commit and pre-merge-commit (#206, #239). A hook the
// clone has in .git/hooks keeps running from .githooks (#256). Deciding
// what to do with a project's own rules (keep, merge, or say not now) is the yokoten
// skill's job, not this command's.
//
// `yokoten update` is the one command here that replaces text: the core rules in
// AGENTS.md, and only with --write. It is at the end of this file.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as antigravity from '../agents/runtimes/antigravity.ts';
import { addProjectHook, addProjectStopHook, checkProjectSettings, setProjectEnv } from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as copilot from '../agents/runtimes/copilot.ts';
import * as dsh from '../agents/runtimes/deepseek-harness.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as muse from '../agents/runtimes/muse.ts';
import { skippedBecause, UnreadableHooksFile } from '../agents/hooks-file.ts';
import { commitCheckLine, runs } from '../run/cli.ts';
import { DEFAULTS, loadConfig } from '../rules/config.ts';
import { CODEOWNERS_PLACES, type Gh, ghIn, isOrganization, isPrivateRepo, repoOf } from '../host/github.ts';
import { readOriginUrl } from './plan.ts';
import { copyRuntime, HOME_DIR, KIT, render, VERSION, writeNew } from './files.ts';

/** yokoten's own repo runs its own bin; every other project runs a vendored copy. */
export const isSelf = (root: string): boolean => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'yokoten' && existsSync(join(root, 'bin', 'yokoten.ts'));
  } catch {
    return false;
  }
};

export const cliPath = (root: string): string => (isSelf(root) ? 'bin/yokoten.ts' : '.yokoten/bin/yokoten.ts');

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
 */
export function init(root: string, gh: Gh = ghIn(root, ORG_LOOKUP_MS), { noCi = false }: { noCi?: boolean } = {}): { ok: boolean; lines: string[] } {
  const report: string[] = [];
  const isOff = noCi || isCiOffIn(root);
  const cli = cliPath(root);
  if (!isSelf(root) && root !== HOME_DIR) {
    const copied = copyRuntime(join(root, '.yokoten'));
    report.push(copied === 'kept' ? 'kept .yokoten/ (the copy running now)' : 'wrote .yokoten/ (the runtime the hooks run; commit it)');
  }
  const hooks = readHookSetup(root);
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
    const result = writeNew(join(root, rel), render(readFileSync(file, 'utf8'), { cli, version: VERSION }));
    report.push(`${result} ${rel}`);
  }
  // Read before .githooks/ is written: whether it can run the hooks this clone has in .git/hooks (#256).
  const blocks = hooks.kind === 'plain' ? handOffBlocks(root) : [];
  if (hooks.kind !== 'own') report.push(...writeGithooks(root, cli, kit, blocks.length === 0));
  if (noCi) report.push(...keepCiOff(root, cli, kit));
  else if (!isOff) report.push(...privateRepoNote(root, gh));
  report.push(writeCodeOwners(root, gh));
  const imported = importRules(root);
  if (imported) report.push(imported);
  // Claude Code's settings, the file people edit by hand most: skipped as one, never
  // rewritten, when it won't parse or has the wrong shape (#254).
  const claudeHooks = agentHooks('the Claude Code settings', '.claude/settings.json', () => {
    checkProjectSettings(root);
    return [
      `${addProjectHook(root, cli)} the tool-call hook in .claude/settings.json`,
      `${addProjectStopHook(root, cli)} the stop check in .claude/settings.json (changed files, before the agent ends its turn)`,
      `${setProjectEnv(root, 'TZ', 'UTC')} TZ=UTC for agent sessions in .claude/settings.json (commit times carry no time zone)`,
      // Checked with a real run (#30): Copilot CLI reads these hooks, in a folder it trusts.
      // It skips them without a word otherwise (#341), so the line says how to trust it.
      'GitHub Copilot CLI runs the hooks in .claude/settings.json only after you trust this folder',
      `to trust this folder in Copilot CLI: ${copilot.TRUST_STEP}`,
    ];
  });
  report.push(...claudeHooks.lines);
  // Codex, Gemini CLI, Antigravity CLI, Muse Code and DeepSeek Harness get the same guard, whether or not they are
  // installed here: small files are easier to predict than a guess about which agents someone uses.
  // A file that won't parse, or has the wrong shape, is named and skipped, never rewritten (#248).
  const codexHooks = agentHooks('the Codex hooks', '.codex/hooks.json', () => {
    codex.checkProjectHooks(root);
    return [
      `${codex.addProjectHook(root, cli)} the Codex tool-call hook in .codex/hooks.json`,
      `${codex.addProjectStopHook(root, cli)} the Codex stop check in .codex/hooks.json`,
      'Codex runs the hooks in .codex/hooks.json only after you trust this folder and the hooks',
      `to trust them in Codex: ${codex.TRUST_STEP}`,
    ];
  });
  const geminiHooks = agentHooks('the Gemini CLI hooks', '.gemini/settings.json', () => {
    gemini.checkProjectHooks(root, cli);
    return [
      `${gemini.addProjectHook(root, cli)} the Gemini CLI tool-call hook in .gemini/settings.json`,
      `${gemini.addProjectStopHook(root, cli)} the Gemini CLI stop check in .gemini/settings.json (AfterAgent)`,
    ];
  });
  const antigravityHooks = agentHooks('the Antigravity CLI hook', '.agents/hooks.json', () => [
    `${antigravity.addProjectHook(root, cli)} the Antigravity CLI tool-call hook in .agents/hooks.json`,
  ]);
  const museHooks = agentHooks('the Muse Code hooks', '.muse/hooks.json', () => {
    const added = muse.addProjectHooks(root, cli);
    return [
      `${added.guard} the Muse Code tool-call hook in .muse/hooks.json`,
      `${added.stop} the Muse Code stop check in .muse/hooks.json`,
      `Muse Code runs the hooks in .muse/hooks.json only after you trust this folder: ${muse.TRUST_STEP}`,
    ];
  });
  // DeepSeek Harness runs the hooks through a bridge each profile needs. init only prints
  // how to add it: it installs nothing and leaves ~/.dsh alone (#334).
  // On Windows the files are still written, ready for #332, but the lines say dsh is not checked.
  const dshHooks = agentHooks('the DeepSeek Harness hook', dsh.HOOKS_FILE, () => dsh.initLines(dsh.addProjectHooks(root, cli)));
  report.push(...codexHooks.lines, ...geminiHooks.lines, ...antigravityHooks.lines, ...museHooks.lines, ...dshHooks.lines);
  report.push(...setCommitCheck(root, cli, hooks, blocks));
  return { ok: claudeHooks.ok && codexHooks.ok && geminiHooks.ok && antigravityHooks.ok && museHooks.ok && dshHooks.ok, lines: report };
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

/** The text with LF line ends and one newline at the end, so a Windows checkout compares equal. */
const normalizeText = (text: string): string => `${text.replace(/\r\n/g, '\n').replace(/\n*$/, '')}\n`;

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
    else if (normalizeText(readFileSync(path, 'utf8')) === normalizeText(render(readFileSync(file, 'utf8'), { cli, version: VERSION }))) {
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
function privateRepoNote(root: string, gh: Gh): string[] {
  const repo = repoOf(readOriginUrl(root));
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
const readRemoteOwner = (root: string): string | null => repoOf(readOriginUrl(root))?.split('/')[0] ?? null;

/**
 * Write .github/CODEOWNERS unless the project has one in any place GitHub reads. Returns
 * the report line. An organization can't own a path in CODEOWNERS, so when gh says the
 * remote owner is one, the file gets the placeholder (#313). When gh can't tell, the
 * remote owner stays: most repos belong to a person.
 */
function writeCodeOwners(root: string, gh: Gh): string {
  const found = CODEOWNERS_PLACES.find((place) => existsSync(join(root, place)));
  if (found) return `kept ${found}`;
  const remote = readRemoteOwner(root);
  const org = remote !== null && isOrganization(gh, remote) === true;
  const owner = org ? null : remote;
  writeNew(join(root, '.github', 'CODEOWNERS'), codeOwnersText(owner, org ? remote : undefined));
  if (org) return `wrote .github/CODEOWNERS (the lead-only paths; @${remote} is an organization, so put a person or @${remote}/<team> in place of ${OWNER_PLACEHOLDER})`;
  return owner
    ? `wrote .github/CODEOWNERS (the lead-only paths, owned by @${owner})`
    : `wrote .github/CODEOWNERS (the lead-only paths; put your GitHub handle in place of ${OWNER_PLACEHOLDER})`;
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
 * The CLAUDE.md file that should import AGENTS.md, with its import line, or null when
 * Claude Code reads AGENTS.md here: there is no CLAUDE.md, or one of them imports it.
 */
export function findRulesGap(root: string): { file: string; line: string } | null {
  const found = findClaudeFiles(root);
  if (found.length === 0 || found.some((entry) => entry.imports.test(removeCode(readFileSync(join(root, entry.file), 'utf8'))))) return null;
  return { file: found[0].file, line: `@${found[0].rules}` };
}

/** True when Claude Code reads AGENTS.md here: there is no CLAUDE.md, or one imports AGENTS.md. */
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

/** The repo's own core.hooksPath (not the user's global one), '' when unset, or null outside a git repo. */
function readLocalHooksPath(root: string): string | null {
  try {
    return execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    return (error as { status?: number }).status === 1 ? '' : null;
  }
}

export function readHookSetup(root: string): HookSetup {
  const hooksPath = readLocalHooksPath(root);
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

const gitLine = (root: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

/** A path for a message: relative to the root, or from ~, so no home folder is printed. */
const showPath = (root: string, path: string): string => {
  const rel = relative(root, path);
  if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join('/');
  const home = homedir();
  return (path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path).split(sep).join('/');
};

const sameFile = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/** Whether a core.hooksPath comes from the global or system config. */
const hasOtherHooksPath = (root: string): boolean =>
  (gitLine(root, ['config', '--show-scope', '--get-all', 'core.hooksPath']) ?? '').split('\n').some((line) => /^(?:global|system|command)\t/.test(line));

/**
 * The hooks this clone has outside .githooks that git runs (or, with core.hooksPath set,
 * ran before it). A hook that is .githooks's own file, through a link, is not one. When a
 * global core.hooksPath decides which hooks run, the files in .git/hooks are dead, so they
 * are not counted; that folder's own commit hooks are, as hooks .githooks can't run.
 */
export function readOldHooks(root: string): OldHook[] {
  const hooksPath = readLocalHooksPath(root);
  const common = hooksPath === null ? null : gitLine(root, ['rev-parse', '--git-common-dir']);
  if (common === null) return [];
  const ownDir = resolve(root, common, 'hooks');
  if (hasOtherHooksPath(root)) {
    // With core.hooksPath set here too, the global one decided before it was set.
    if (hooksPath !== '') return [];
    const dir = gitLine(root, ['rev-parse', '--git-path', 'hooks']);
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
export function handOffBlocks(root: string, olds: OldHook[] = readOldHooks(root)): string[] {
  const thenSet = readLocalHooksPath(root) === '' ? '; then run `git config core.hooksPath .githooks`' : '';
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
function writeGithooks(root: string, cli: string, kit: string, handOff: boolean): string[] {
  const olds = handOff ? readOldHooks(root).filter((old) => old.handOff === 'yes') : [];
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
function setCommitCheck(root: string, cli: string, hooks: HookSetup, blocks: string[]): string[] {
  if (hooks.kind === 'no repo') return ['not a git repo: run `git init`, then `git config core.hooksPath .githooks`'];
  if (hooks.kind === 'plain') {
    const unset = readLocalHooksPath(root) === '';
    const olds = readOldHooks(root);
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
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
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
export function compareCoreRules(project: string, kit: string): CoreRules {
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
  return { state: 'behind', changes: diffLines(before, after), sections: compareSections(before, after), updated: core + project.slice(start) };
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
