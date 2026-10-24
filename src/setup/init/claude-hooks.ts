
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { systemHome } from '../../rules/privacy.ts';
import { commitCheckLine, runs } from '../../run/cli.ts';
import { configEntries, forgetGitReads, remembered, withGitReads } from '../../run/check.ts';
import { render, VERSION } from '../files.ts';

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
export function findMainNewline(text: string): string {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** Add the AGENTS.md import to the CLAUDE.md that lacks it. Returns the report line, or null when nothing changed. */
export function importRules(root: string): string | null {
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
export type HookSetup = { kind: 'plain' } | { kind: 'own'; hooksPath: string } | { kind: 'no repo' };

// Each git answer is kept for the run (`withGitReads`, src/run/check.ts): a doctor or an init.
export { withGitReads };

/**
 * The repo's own core.hooksPath (not the user's global one), '' when unset, or null outside
 * a git repo. Files included from .git/config count, as git itself reads them. In a run, from
 * the config list and the git folder, which other checks read too.
 */
export const readLocalHooksPath = (root: string, env: Env): string | null => {
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

/** What `addCheckLines` did, in the report's words: a hook that already ran the check is "kept". */
function checkWords(result: ReturnType<typeof addCheckLines>): string {
  return result === 'same' ? 'kept' : result;
}

/**
 * Add the yokoten check to a commit hook, after its `#!` line, so a later `exec` can't skip it.
 * Its own lines stay. A hook git would skip, for lack of the execute bit, is made executable.
 * A file under .husky/ keeps its mode: husky 9 runs it with `sh`, so a chmod is only noise in the diff (#256).
 */
export function addCheckLines(path: string, cli: string): 'added the check to' | 'wrote' | 'made executable' | 'same' {
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


/** What git prints for `args` in `root`, trimmed, or null when it fails; kept for the run. */
export const gitLine = (root: string, args: string[], env: Env): string | null =>
  remembered(`line\0${root}\0${args.join('\0')}`, () => {
    try {
      return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  });

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
export function writeGithooks(root: string, cli: string, kit: string, handOff: boolean, env: Env): string[] {
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
      lines.push(`${placed !== null ? 'updated' : checkWords(result)} ${rel}`);
    }
    if (old) lines.push(`kept your ${old.file}: ${rel} runs it${isCommitHook(hook) ? ' after the check' : ''}`);
  }
  return lines;
}
/** Point git at the commit check: set .githooks, or add the check to the project's own pre-commit. */
export function setCommitCheck(root: string, cli: string, hooks: HookSetup, blocks: string[], env: Env): string[] {
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
    // init moves this line to the start of the report (#654).
    return ['git hook: on (the commit check runs from .githooks)', ...note, ...dead];
  }
  const { hooksPath } = hooks;
  const fileOf = (hook: CommitHook) => (hooksPath ? hookFile(root, hooksPath, hook) : `.husky/${hook}`);
  const owner = hooksPath ? `core.hooksPath (${fileOf('pre-commit') === '.husky/pre-commit' ? 'husky' : hooksPath})` : 'husky';
  if (fileOf('pre-commit') === null) {
    return [`kept core.hooksPath: it is outside this repo, so yokoten did not change it. Add this line to its pre-commit and pre-merge-commit: ${commitCheckLine(cli)}`];
  }
  const lines = COMMIT_HOOKS.map((hook) => {
    const file = fileOf(hook) as string;
    return `${checkWords(addCheckLines(join(root, file), cli))} ${file}: the commit check (kept ${owner}, so the project's own hooks still run)`;
  });
  if (!hooksPath) lines.push('husky is not set up in this clone yet: run `npm install` (husky sets core.hooksPath), and the check runs from .husky/pre-commit and .husky/pre-merge-commit');
  return lines;
}
