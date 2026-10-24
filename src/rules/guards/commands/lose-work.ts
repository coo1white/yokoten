import { isAbsolute, relative, resolve, sep } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { type Env } from '../../config.ts';
import { homeOf } from '../../privacy.ts';
import { mayBeDotGit, PATH_BREAKS, MARK_WRITERS, RUNS_CODE, FIND_LEAD_OPTIONS, FIND_NAME_TESTS, WORKER_MARK, gitLinkAbove } from '../worker/mark.ts';
import { withHomeRead } from '../worker/config.ts';
import { withoutShellRedirects, isGit, GIT_VALUE_OPTIONS, HEADS, LAUNCHERS, redirectLength, skipPrefix, programName, findPrograms, findProgramPlaces, FIND_ACTIONS, globMatches } from '../bash/read/words.ts';
import { readGit } from '../hooks/read.ts';
import { plainArgs, WRITERS } from '../lead-only/targets.ts';
import { spend, isShell, RUNNERS, runString } from '../bash/read/run.ts';
import { commandWords } from '../bash/read/read.ts';
import { skipContinuation } from '../bash/read/bodies.ts';

// ---- Commands that lose work (#560) ----
//
// An alias runs another command under a new name, removing .git throws away every
// commit, deleting the default branch throws away the line every branch builds on,
// and a download piped into a shell runs code nobody read. Each refusal names the
// safe way instead. For a worker the worker rules above still answer first.

const ALIAS_FIX = 'run the full command instead of making an alias, so the guard can check it';
export const aliasFinding = (what: string) => finding('alias', what, ALIAS_FIX);

/** The `alias` program defines a shortcut, so a later command runs what the guard cannot see. For a worker the worker rule answers first, with its own id. */
export function checkShellAlias(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_ROLE === 'worker') return null;
  const runs = findPrograms(words).some((program) => programName(program) === 'alias');
  return runs ? aliasFinding('`alias` defines a shortcut, so a later command runs what the guard cannot see') : null;
}

const REMOVE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink', 'shred']);
const REMOVE_GIT_FIX = 'delete only the files you mean (a tracked file with `git rm <path>`); to start over, clone the repo again';

/** `rm` and friends on a path that can be `.git`, and a `find` that deletes with nothing keeping it out (#573, #744). For a worker the mark rule answers first. */
export function checkRemoveGit(words: string[], cwd: string | null, env: Env): Finding | null {
  const home = homeOf(env);
  let from = 0;
  // A find's arguments run to the end of this command. The parse reads every find
  // nested in them. Parsing those again would re-read the tail once per find (#744).
  let coveredUntil = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (at < coveredUntil) continue;
    const name = programName(program);
    const args = withoutShellRedirects(words, at + 1);
    if (REMOVE_PROGRAMS.has(name)) {
      const targets = plainArgs(args);
      const target = targets.find((word) => word.split(PATH_BREAKS).filter(Boolean).some(mayBeDotGit));
      if (target !== undefined) {
        return finding('remove-git', `\`${name}\` would delete \`${target}\``, REMOVE_GIT_FIX);
      }
      // `.` is the checkout and `..` holds it: one word removes every file and every commit (#828).
      const whole = targets.find((word) => isCheckoutPath(word, cwd));
      if (whole !== undefined) {
        return finding('delete-checkout', `\`${name}\` on \`${whole}\` would delete the whole checkout, including every file and every commit`, DELETE_CHECKOUT_FIX);
      }
    }
    if (name === 'find') {
      if (findRemovesGit(args, cwd, home)) {
        return finding('remove-git', '`find` would delete files, and nothing keeps it out of `.git`', REMOVE_GIT_FIX);
      }
      coveredUntil = words.length;
    }
  }
  return null;
}

const DELETE_BRANCH_FIX = 'delete only the branch you mean (`git branch -d <branch>`), and leave the default branch alone';
export const deleteBranchFinding = (what: string) => finding('delete-default-branch', what, DELETE_BRANCH_FIX);

// ---- Git calls that throw work or history away (#828) ----
//
// Each call below loses work that has one copy only: the checkout or the folder that
// holds it, untracked files, uncommitted edits, a saved stash, the reflog that makes
// undo possible, or the commits of the default branch. Git reads any unique prefix of a
// long option (`--har` is `--hard`, `--del` is `--delete`), so the guard reads options
// the same way and refuses a form it cannot tell apart. These answer after the worker's
// own rules, so a worker that names its mark or the config folder hears that rule first.

const DELETE_CHECKOUT_FIX = 'delete only the files you mean, by name';
const DISCARD_WORK_FIX = 'keep the work first (`git stash` saves it), or commit it; do not throw it away';
const ERASE_HISTORY_FIX = 'leave the history as it is; if you need to roll back, ask the owner first';
const MOVE_BRANCH_FIX = 'leave the default branch where it is, and put the change on a new branch (`git switch -c <name>`)';
// The short options of checkout and switch that take a value, so `-bfoo` names a branch
// and holds no `-f` (#847).
const CHECKOUT_VALUE_SHORT = new Set(['b', 'B', 'c', 'C']);

/** Whether `word` is the long option `name` as git reads it: a unique prefix counts (`--har`, `--del`). */
export function isGitLongOption(word: string, name: string): boolean {
  const given = word.split('=', 1)[0];
  return given.startsWith('--') && given.length > 2 && name.startsWith(given);
}

/**
 * The first short-option word in `args` that holds `flag`, or undefined. A combined word
 * keeps its letters, so `-qf` holds `-f` (#847). A letter in `valued` takes the rest of the
 * word as its value, so `-bfoo` names a branch and holds no `f`.
 */
function findShortFlag(args: string[], flag: string, valued: Set<string>): string | undefined {
  for (const word of args) {
    if (word === '--') break;
    if (word.startsWith('--') || !word.startsWith('-') || word === '-') continue;
    for (const letter of word.slice(1)) {
      if (letter === flag) return word;
      if (valued.has(letter)) break;
    }
  }
  return undefined;
}

/**
 * Whether git's long option `name` is set to `value`, written `--name=value`, `--name value`,
 * or shortened. Git keeps the last value when an option is given twice, so the last one counts.
 */
function gitOptionIs(args: string[], name: string, value: string): boolean {
  let last: string | undefined;
  for (const [at, word] of args.entries()) {
    if (!isGitLongOption(word, name)) continue;
    last = word.includes('=') ? word.slice(word.indexOf('=') + 1) : args[at + 1];
  }
  return last === value;
}

/**
 * Whether `git clean` would only list what it means to remove. Git reads the words in order:
 * `-e <pattern>` (or `-e<pattern>`, also at the end of a cluster such as `-fde`) takes the
 * next word as a pattern, and the last of `--dry-run` and `--no-dry-run` decides. A value is
 * never a flag, so `git clean -fd -e --dry-run` deletes (#847).
 */
function isCleanDryRun(args: string[]): boolean {
  let isDryRun = false;
  for (let at = 0; at < args.length; at++) {
    const word = args[at];
    if (word === '--') break;
    if (word.startsWith('--')) {
      if (isGitLongOption(word, '--no-dry-run')) isDryRun = false;
      else if (isGitLongOption(word, '--dry-run')) isDryRun = true;
      // `--exclude=<pattern>` carries its value; a bare `--exclude` takes the next word.
      else if (isGitLongOption(word, '--exclude') && !word.includes('=')) at++;
      continue;
    }
    if (!word.startsWith('-') || word === '-') continue;
    const letters = word.slice(1);
    for (const [index, flag] of [...letters].entries()) {
      if (flag === 'e') {
        // `-e<pattern>` carries its value; a bare `-e` ends the word and takes the next one.
        if (index === letters.length - 1) at++;
        break;
      }
      if (flag === 'n') isDryRun = true;
    }
  }
  return isDryRun;
}

/**
 * Whether `path` is the folder the command runs in, or one that holds it: removing it removes
 * the checkout. `.` and `..` are read as the shell reads them, so `src/a/..` is `src`.
 */
function isCheckoutPath(path: string, cwd: string | null): boolean {
  if (cwd !== null) {
    const target = resolve(cwd, path);
    return target === cwd || cwd.startsWith(target.endsWith(sep) ? target : `${target}${sep}`);
  }
  // Without the folder, a path that still ends in `..` after its own parts cancel is as close
  // to the checkout as the guard can tell, so it answers the safe way.
  const parts = path.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  return parts.length === 0 || parts[parts.length - 1] === '..';
}

/** The git call's subcommand and arguments, and the folder it works in (null when unknown). */
function readGitCall(words: string[], cwd: string | null): { sub: string; args: string[]; directory: string | null } | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  let directory = cwd;
  let at = start + 1;
  while (at < words.length && words[at].startsWith('-')) {
    if (words[at] === '-C' && directory !== null) directory = resolve(directory, words[at + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(words[at])) directory = null;
    at += GIT_VALUE_OPTIONS.has(words[at]) ? 2 : 1;
  }
  const sub = words[at];
  return sub === undefined ? null : { sub, args: withoutShellRedirects(words, at + 1), directory };
}

/** The ways a git call throws away work or history that exists in one place only (#828). */
export function checkGitLoseWork(words: string[], cwd: string | null, env: Env): Finding | null {
  const call = readGitCall(words, cwd);
  if (call === null) return null;
  const { sub, args, directory } = call;
  // A plain word, in order, after the options. A path is not an option.
  const plain = plainArgs(args);

  // Untracked files have no other copy. A dry run removes nothing, so it passes.
  if (sub === 'clean' && !isCleanDryRun(args)) {
    return finding('discard-work', '`git clean` deletes every file you have not committed, and no other copy of them exists', DISCARD_WORK_FIX);
  }

  // A whole-tree checkout or restore throws away every uncommitted edit. `restore --staged`
  // alone only unstages, which is the way back from `git add`, so it passes.
  if (sub === 'checkout' || sub === 'switch' || sub === 'restore') {
    const stagedOnly = sub === 'restore'
      && args.some((arg) => isGitLongOption(arg, '--staged') || /^-[A-Za-z]*S[A-Za-z]*$/.test(arg))
      && !args.some((arg) => isGitLongOption(arg, '--worktree') || /^-[A-Za-z]*W[A-Za-z]*$/.test(arg));
    // A forced checkout or switch writes over uncommitted edits, whichever revision it names.
    // With a path after `--`, it writes over that path alone (#847).
    const forceFlag = (sub === 'checkout' || sub === 'switch')
      ? findShortFlag(args, 'f', CHECKOUT_VALUE_SHORT)
        ?? args.find((arg) => isGitLongOption(arg, '--force') || isGitLongOption(arg, '--discard-changes'))
      : undefined;
    if (forceFlag !== undefined) {
      const separator = args.indexOf('--');
      const paths = separator < 0 ? [] : args.slice(separator + 1).filter((word) => word !== '');
      if (paths.length > 0) {
        return finding('discard-work', `\`git ${sub} ${forceFlag} -- ${paths.join(' ')}\` writes over the uncommitted edits in ${paths.map((path) => `\`${path}\``).join(', ')}`, DISCARD_WORK_FIX);
      }
      return finding('discard-work', `\`git ${sub} ${forceFlag}\` writes over every uncommitted edit in the checkout`, DISCARD_WORK_FIX);
    }
    const whole = plain.find((word) => word === ':/' || isCheckoutPath(word, directory));
    if (whole !== undefined && !stagedOnly) {
      return finding('discard-work', `\`git ${sub} ${whole}\` throws away every uncommitted edit in the checkout`, DISCARD_WORK_FIX);
    }
  }

  // A saved stash is the guard's own way back before a reset. Clearing or dropping it removes that.
  if (sub === 'stash' && (plain[0] === 'clear' || plain[0] === 'drop')) {
    return finding('discard-work', `\`git stash ${plain[0]}\` destroys saved work that has no other copy`, DISCARD_WORK_FIX);
  }

  // Erasing unreachable commits and the reflog takes away the usual way back. Git reads
  // `--prune=all` and `--expire=all` as "now" too, and keeps the last of two values.
  const erases = (sub === 'gc' && (gitOptionIs(args, '--prune', 'now') || gitOptionIs(args, '--prune', 'all')))
    || (sub === 'prune' && (gitOptionIs(args, '--expire', 'now') || gitOptionIs(args, '--expire', 'all')))
    || (sub === 'reflog' && (plain[0] === 'expire' || plain[0] === 'delete'))
    || sub === 'filter-branch'
    || sub === 'filter-repo';
  if (erases) {
    return finding('erase-history', `\`git ${sub}\` erases the history at once, and the old commits are the usual way back`, ERASE_HISTORY_FIX);
  }

  // Moving the default branch back drops the commits every other branch builds on.
  if (sub === 'update-ref') {
    const reads = args.some((arg) => arg === '-l' || isGitLongOption(arg, '--verify') || isGitLongOption(arg, '--list'));
    const stdin = args.some((arg) => isGitLongOption(arg, '--stdin'));
    const ref = reads ? undefined : stdin ? '--stdin' : plain[0];
    if (ref !== undefined && (ref === '--stdin' || isDefaultBranch(ref, directory, env))) {
      return finding('move-default-branch', stdin ? '`git update-ref --stdin` writes refs the guard cannot read, and can move the default branch' : `\`git update-ref ${ref}\` moves the default branch`, MOVE_BRANCH_FIX);
    }
  }
  if (sub === 'branch' && args.some((arg) => /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || isGitLongOption(arg, '--force'))) {
    const name = plain[0];
    if (name !== undefined && isDefaultBranch(name, directory, env)) {
      return finding('move-default-branch', `\`git branch -f ${name}\` moves the default branch`, MOVE_BRANCH_FIX);
    }
  }
  if (sub === 'checkout' || sub === 'switch') {
    const forced = sub === 'checkout'
      ? args.some((arg) => /^-[A-Za-z]*B[A-Za-z]*$/.test(arg))
      : args.some((arg) => /^-[A-Za-z]*C[A-Za-z]*$/.test(arg) || isGitLongOption(arg, '--force-create'));
    const name = plain[0];
    if (forced && name !== undefined && isDefaultBranch(name, directory, env)) {
      return finding('move-default-branch', `\`git ${sub}\` moves the default branch \`${name}\``, MOVE_BRANCH_FIX);
    }
  }
  return null;
}

/** The branches a `git branch -d`, `-D` or `--delete` (or a shortened `--del`) removes, or null when it removes none. */
export function findDeletedBranches(args: string[]): string[] | null {
  const deletes = args.some((arg) => isGitLongOption(arg, '--delete') || (/^-[A-Za-z]+$/.test(arg) && /[dD]/.test(arg)));
  return deletes ? plainArgs(args) : null;
}

/** The branches a `git push --delete` (or `-d`, or a shortened `--del`) or `git push <remote> :<branch>` deletes, or null. */
export function findPushedDeletes(args: string[]): string[] | null {
  if (args.includes('-d') || args.some((arg) => isGitLongOption(arg, '--delete'))) return plainArgs(args).map((name) => name.replace(/^:/, ''));
  const colon = plainArgs(args).filter((name) => name.startsWith(':')).map((name) => name.slice(1));
  return colon.length > 0 ? colon : null;
}

/** The ref a `git update-ref -d <ref>` deletes, or null. */
export function findDeletedRef(args: string[]): string | null {
  if (!args.includes('-d')) return null;
  const refs = plainArgs(args, ['-m', '--message']);
  return refs.length > 0 ? refs[0] : null;
}

/**
 * The default branch: what refs/remotes/origin/HEAD names, else main and master.
 */
function readDefaultBranches(dir: string | null, env: Env): Set<string> {
  if (dir !== null) {
    const head = readGit(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD'], env);
    const branch = head === null ? undefined : /^refs\/remotes\/[^/]+\/(.+)$/.exec(head)?.[1];
    if (branch) return new Set([branch]);
  }
  return new Set(['main', 'master']);
}

/** Whether `name` is the default branch, as a bare name or under refs/heads/. */
export function isDefaultBranch(name: string, dir: string | null, env: Env): boolean {
  const branches = readDefaultBranches(dir, env);
  const short = name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name;
  return branches.has(name) || branches.has(short);
}

// ---- A find that deletes, and .git (#744) ----
//
// `find . -delete` and `find . -exec rm` walk into `.git` and remove the history.
// The guard refuses that unless something keeps the walk out: a prune of `.git`,
// an exclusion such as `-not -path '*/.git/*'`, or a start folder that cannot hold
// this repo's `.git` (`find dist -delete`). No test, or only tests that can match
// `.git`, is refused. A name or path whose characters name git storage (`objects`,
// `refs`, `*.idx`) but match no sample is refused too: the guard reads those
// characters, not the glob grammar. When the guard cannot tell, it refuses.
//
// `-delete` turns depth on, and GNU find then refuses to run a prune at all, so the
// prune form deletes nothing. An explicit `-depth` or `-d` is different: prune stops
// working and the other branch can wipe `.git`. The guard treats only that explicit
// depth as turning prune off.

/** One node of a find expression. */
type FindNode =
  | { kind: 'or' | 'and' | 'comma'; left: FindNode; right: FindNode }
  | { kind: 'not'; inner: FindNode }
  | { kind: 'name' | 'path'; pattern: string }
  | { kind: 'regex' }
  | { kind: 'type'; letters: string }
  | { kind: 'unknown' }
  | { kind: 'prune' }
  | { kind: 'harm'; recursive: boolean }
  | { kind: 'pass' }
  | { kind: 'fail' }
  | { kind: 'exec'; harms: boolean; recursive: boolean };

/** What a node does to one file find would visit. `isTrue` is null when the guard cannot tell. */
interface FindEffect {
  isTrue: boolean | null;
  harms: boolean;
  recursive: boolean;
  prunes: boolean;
  selects: boolean;
}

/** A parsed find: its starts, its expression, and whether the actions can delete. */
interface FindParsed {
  ok: boolean;
  starts: string[];
  node: FindNode;
  forcesDepth: boolean;
  harms: boolean;
  unsure: boolean;
  targetsGit: boolean;
  maxDepth: number | null;
  minDepth: number | null;
  pathPatterns: string[];
  /** Finds run by `-exec` and its kin. Each is parsed once, inside this walk (#744). */
  innerFinds: FindParsed[];
}

/** One sample under `.git`, as find would print it. */
interface GitProbe {
  path: string;
  base: string;
  depth: number;
  isDir: boolean;
  isGitDir: boolean;
}

/** Where a start sits relative to this repo's `.git`. */
type GitHold = 'no' | 'unsure' | { root: string };

const FIND_GLOBAL_VALUES = new Set(['-maxdepth', '-mindepth', '-regextype']);
const FIND_DEPTH_OPTIONS = new Set(['-depth', '-d']);
const FIND_PRINTS = new Set(['-print', '-print0', '-ls', '-quit']);
const FIND_FILE_ACTIONS = new Set(['-fprint', '-fprint0', '-fls']);
const FIND_OR = new Set(['-o', '-or']);
const FIND_AND = new Set(['-a', '-and']);
// Files and folders a real checkout keeps. A test that matches one can reach the history.
// The loose object (empty blob, two hex characters then the rest), the pack index and
// the other refs are samples too: a pattern can name them without writing `.git`.
const GIT_FILE_TAILS = [
  'HEAD', 'config', 'index', 'packed-refs', 'COMMIT_EDITMSG', 'description',
  'objects/pack/pack-1.pack', 'objects/pack/pack-1.idx', 'objects/e6/9de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  'refs/heads/main', 'refs/heads/master', 'refs/tags/sample-tag', 'refs/remotes/origin/HEAD',
  'hooks/pre-commit', 'logs/HEAD', 'info/exclude', 'worktrees/wt/HEAD',
];
const GIT_DIR_TAILS = [
  '', 'objects', 'objects/pack', 'objects/e6', 'refs', 'refs/heads', 'refs/tags',
  'refs/remotes', 'refs/remotes/origin', 'hooks', 'logs', 'info', 'worktrees', 'worktrees/wt',
];
// Words under `.git` that a pattern can name without matching a sample (`refs/heads/develop`).
// Exact file names the samples already cover (`config`, `index`) stay off this list.
const GIT_STORAGE_PARTS = new Set(['objects', 'refs', 'hooks', 'logs', 'pack', 'worktrees', 'heads', 'tags', 'remotes', 'origin']);
// Pack side files. `.idx` is the index; the rest sit beside the pack.
const GIT_STORAGE_SUFFIXES = ['.idx', '.pack', '.rev', '.bitmap', '.keep', '.mtimes', '.promisor'];

/** Whether a find that deletes can remove this repo's history. A parse the guard cannot finish refuses only when the line looks like a delete. */
function findRemovesGit(args: string[], cwd: string | null, home: string | null): boolean {
  let parsed: FindParsed;
  try {
    parsed = parseFindArgs(args, 'history');
  } catch {
    return looksLikeGitDelete(args);
  }
  return findParsedRemoves(parsed, args, cwd, home);
}

/** Whether this parsed find, or a find it runs, can remove the history. */
function findParsedRemoves(parsed: FindParsed, args: string[], cwd: string | null, home: string | null): boolean {
  if (!parsed.ok) return looksLikeGitDelete(args);
  if (parsed.targetsGit) return true;
  for (const inner of parsed.innerFinds) {
    if (findParsedRemoves(inner, args, cwd, home)) return true;
  }
  if (parsed.unsure) return startMayHold(parsed.starts, cwd, home);
  if (!parsed.harms) return false;
  return expressionSpares(parsed, cwd, home, 'history') !== true;
}

/**
 * Whether a find that writes keeps every git file, and the worker mark, out of its
 * actions. True only when the guard is sure. Callers use it to stand down, never to
 * add a refusal (`find . -fprint out` stays refused).
 */
export function findSparesGitTree(args: string[], cwd: string, home: string | null): boolean {
  try {
    const parsed = parseFindArgs(args, 'tree');
    if (!parsed.ok || parsed.targetsGit || parsed.unsure || !parsed.harms) return false;
    return expressionSpares(parsed, cwd, home, 'tree') === true;
  } catch {
    return false;
  }
}

/** Whether any start may contain this repo's `.git`. An unreadable start counts. */
function startMayHold(starts: string[], cwd: string | null, home: string | null): boolean {
  for (const start of starts) {
    if (gitHold(start, cwd, home) !== 'no') return true;
  }
  return false;
}

/** Whether the expression leaves every sample under `.git` unharmed. Null when it cannot tell. */
function expressionSpares(parsed: FindParsed, cwd: string | null, home: string | null, mode: 'history' | 'tree'): boolean | null {
  for (const start of parsed.starts) {
    const hold = gitHold(start, cwd, home);
    if (hold === 'unsure') return null;
    if (hold === 'no') continue;
    const probes = gitProbes(hold.root, start, mode);
    if (hasUnsampledGitPath(parsed, probes)) return null;
    if (probesHarmed(parsed, probes)) return false;
  }
  return true;
}

/** The `.git` of the checkout that holds `cwd`, or null when there is none. A broken one is unsure. */
function repoGitDir(cwd: string): string | 'unsure' | null {
  const link = gitLinkAbove(cwd);
  if (link === null) return null;
  if (link.kind === 'broken') return 'unsure';
  return link.gitDir;
}

/**
 * The printed path of this repo's `.git` when `start`'s walk includes it, `no` when
 * the walk cannot reach it (`dist`, `src`), and `unsure` when the path cannot be read.
 * A start that names `.git` itself (`find .git`, `find src/.git`) always holds that folder.
 */
function gitHold(start: string, cwd: string | null, home: string | null): GitHold {
  const expanded = withHomeRead(start, home, cwd);
  if (/[$`~]/.test(expanded)) return 'unsure';
  // A glob the shell expands (`l*`, `*`) names children, and a child is not this repo's
  // `.git`. A component that can be `.git`, or a glob the guard cannot place, stays unsure.
  if (/[*?[{]/.test(expanded)) {
    const globParts = expanded.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
    if (isAbsolute(expanded) || globParts.includes('..') || globParts.some((part) => mayBeDotGit(part))) return 'unsure';
    return globParts.length > 0 ? 'no' : 'unsure';
  }
  const parts = expanded.split(/[\\/]+/);
  const gitAt = parts.findIndex((part) => part === '.git');
  if (gitAt !== -1) {
    const root = parts.slice(0, gitAt + 1).join('/');
    return { root: root || '.git' };
  }
  const meaningful = parts.filter((part) => part !== '' && part !== '.');
  const isHere = meaningful.length === 0;
  if (!isHere && !isAbsolute(expanded) && !meaningful.includes('..')) return 'no';
  if (cwd === null) return 'unsure';
  const gitDir = repoGitDir(cwd);
  if (gitDir === null) return 'no';
  if (gitDir === 'unsure') return 'unsure';
  const startAbs = resolve(cwd, expanded);
  const reaches = startAbs === gitDir || isInsidePath(gitDir, startAbs) || isInsidePath(startAbs, gitDir);
  if (!reaches) return 'no';
  return { root: printedGit(expanded, startAbs, gitDir) };
}

/** Whether `inner` is strictly inside `outer`. The filesystem root holds every path. */
function isInsidePath(inner: string, outer: string): boolean {
  if (outer === sep) return inner.startsWith(sep) && inner.length > sep.length;
  const prefix = outer.endsWith(sep) ? outer : outer + sep;
  return inner.startsWith(prefix);
}

/** The path find prints for the git folder, from the start text the user wrote. */
function printedGit(start: string, startAbs: string, gitDir: string): string {
  const prefix = start.replace(/\/+$/, '') || '.';
  if (startAbs === gitDir || isInsidePath(startAbs, gitDir)) {
    const inside = relative(gitDir, startAbs).split(sep).join('/');
    if (inside === '') return prefix;
    const suffix = `/${inside}`;
    return prefix.endsWith(suffix) ? prefix.slice(0, -suffix.length) : prefix;
  }
  const relativeGit = relative(startAbs, gitDir).split(sep).join('/');
  if (prefix === '.') return relativeGit === '.git' ? './.git' : `./${relativeGit}`;
  return `${prefix}/${relativeGit}`;
}

/** Samples of the git folder find would visit from `start`, plus the worker mark in tree mode. */
function gitProbes(root: string, start: string, mode: 'history' | 'tree'): GitProbe[] {
  const tails = [
    ...GIT_DIR_TAILS.map((tail) => ({ tail, isDir: true, isGitDir: tail === '' })),
    ...GIT_FILE_TAILS.map((tail) => ({ tail, isDir: false, isGitDir: false })),
    ...(mode === 'tree' ? [WORKER_MARK, `worktrees/wt/${WORKER_MARK}`].map((tail) => ({ tail, isDir: false, isGitDir: false })) : []),
  ];
  return tails.map(({ tail, isDir, isGitDir }) => {
    const path = tail === '' ? root : `${root}/${tail}`;
    const slash = tail.lastIndexOf('/');
    const base = tail === '' ? '.git' : tail.slice(slash + 1);
    return { path, base, depth: depthBelow(start, path), isDir, isGitDir };
  });
}

/** How many steps `printed` sits below the starting point find was given. */
function depthBelow(start: string, printed: string): number {
  const prefix = start.replace(/\/+$/, '') || '.';
  if (prefix === '.') {
    const body = printed.startsWith('./') ? printed.slice(2) : printed;
    if (body === '' || body === '.') return 0;
    return body.split('/').filter(Boolean).length;
  }
  if (printed === prefix) return 0;
  const lead = `${prefix}/`;
  if (printed.startsWith(lead)) return printed.slice(lead.length).split('/').filter(Boolean).length;
  return printed.split('/').filter(Boolean).length;
}

/** A `-name` or `-path` test that selects a delete. */
interface HarmPattern {
  kind: 'name' | 'path';
  pattern: string;
}

/**
 * Whether a pattern can reach git storage the samples do not cover, so the guard cannot tell.
 * A `-path` that names `.git` and matches nothing is refused, prune or not.
 * A delete whose characters name storage (`objects`, `*.idx`) but match no sample is refused
 * too, unless a prune keeps the walk out or no interior sample is visited.
 */
function hasUnsampledGitPath(parsed: FindParsed, probes: GitProbe[]): boolean {
  for (const pattern of parsed.pathPatterns) {
    const namesDotGit = /[$`]/.test(pattern) || pattern.split(/[\\/]+/).some((part) => mayBeDotGit(part));
    if (!namesDotGit) continue;
    if (!probes.some((probe) => findGlobMatches(pattern, probe.path))) return true;
  }
  if (gitDirPruned(parsed, probes) || !interiorVisited(parsed, probes)) return false;
  for (const item of harmPatterns(parsed.node)) {
    if (!namesGitStorage(item.pattern)) continue;
    const read = (probe: GitProbe) => (item.kind === 'name' ? probe.base : probe.path);
    if (!probes.some((probe) => findGlobMatches(item.pattern, read(probe)))) return true;
  }
  return false;
}

/** Whether the git folder itself is pruned, so the walk never enters it. An explicit depth turns prune off. */
function gitDirPruned(parsed: FindParsed, probes: GitProbe[]): boolean {
  const gitDir = probes.find((probe) => probe.isGitDir);
  if (!gitDir || parsed.forcesDepth || !probeIsVisited(gitDir, parsed)) return false;
  return evalFind(parsed.node, gitDir).prunes;
}

/** Whether any sample inside the git folder is visited. A shallow `-maxdepth` visits none. */
function interiorVisited(parsed: FindParsed, probes: GitProbe[]): boolean {
  return probes.some((probe) => !probe.isGitDir && probeIsVisited(probe, parsed));
}

/** Whether `pattern`'s own characters name git storage. A safe suffix (`.log`, `.ts`) does not. */
function namesGitStorage(pattern: string): boolean {
  if (/[$`]/.test(pattern)) return true;
  return pattern.split(/[\\/]+/).filter(Boolean).some((part) => partNamesGitStorage(part));
}

/**
 * One path component. A dotted tail that is not a git ending allows the name.
 * `?`, a class, a brace, or a star inside the word is grammar, so the guard cannot tell.
 */
function partNamesGitStorage(part: string): boolean {
  const lower = part.toLowerCase();
  const tail = /[^*?[\]{}\\]+$/.exec(lower)?.[0] ?? '';
  if (tail.includes('.') && !GIT_STORAGE_SUFFIXES.some((suffix) => tail.endsWith(suffix))) return false;
  if (/[?[{}]/.test(lower)) return true;
  const core = lower.replace(/^\*+/, '').replace(/\*+$/, '');
  if (core.includes('*')) return true;
  if (core === '') return false;
  if (GIT_STORAGE_PARTS.has(core)) return true;
  return GIT_STORAGE_SUFFIXES.some((suffix) => core.endsWith(suffix));
}

/** Name and path tests that sit on a delete, so they choose what is removed. A negated test excludes. */
function harmPatterns(node: FindNode): HarmPattern[] {
  switch (node.kind) {
    case 'and': {
      const found = [...harmPatterns(node.left), ...harmPatterns(node.right)];
      if (nodeHarms(node.right)) found.push(...testPatterns(node.left, false));
      if (nodeHarms(node.left)) found.push(...testPatterns(node.right, false));
      return found;
    }
    case 'or':
    case 'comma':
      return [...harmPatterns(node.left), ...harmPatterns(node.right)];
    case 'not':
      return harmPatterns(node.inner);
    default:
      return [];
  }
}

/** Name and path tests in `node`. `isNegated` drops a test that only excludes. */
function testPatterns(node: FindNode, isNegated: boolean): HarmPattern[] {
  switch (node.kind) {
    case 'name':
    case 'path':
      return isNegated ? [] : [{ kind: node.kind, pattern: node.pattern }];
    case 'and':
    case 'or':
    case 'comma':
      return [...testPatterns(node.left, isNegated), ...testPatterns(node.right, isNegated)];
    case 'not':
      return testPatterns(node.inner, !isNegated);
    default:
      return [];
  }
}

/** Whether `node` deletes a file it selects. */
function nodeHarms(node: FindNode): boolean {
  switch (node.kind) {
    case 'harm':
      return true;
    case 'exec':
      return node.harms;
    case 'and':
    case 'or':
    case 'comma':
      return nodeHarms(node.left) || nodeHarms(node.right);
    case 'not':
      return nodeHarms(node.inner);
    default:
      return false;
  }
}

/** find's `*` matches a leading dot and a slash. A pattern the guard cannot read counts as a match. */
function findGlobMatches(pattern: string, text: string): boolean {
  if (/[$`]/.test(pattern)) return true;
  // globMatches compares a lower-case name, so `HEAD` matches `HEAD`.
  return globMatches(`_${pattern}`, `_${text.toLowerCase()}`);
}

/** Whether any sample is deleted, or the git folder itself is selected or removed recursively. */
function probesHarmed(parsed: FindParsed, probes: GitProbe[]): boolean {
  const gitDir = probes.find((probe) => probe.isGitDir);
  let skipInterior = false;
  if (gitDir && probeIsVisited(gitDir, parsed) && evalFind(parsed.node, gitDir).prunes && !parsed.forcesDepth) skipInterior = true;
  if (!skipInterior) {
    for (const probe of probes) {
      if (probe.isGitDir || !probeIsVisited(probe, parsed)) continue;
      if (evalFind(parsed.node, probe).harms) return true;
    }
  }
  if (!gitDir || !probeIsVisited(gitDir, parsed)) return false;
  const effect = evalFind(parsed.node, gitDir);
  // A plain `-delete` of the folder, with its contents spared, cannot remove a non-empty `.git`.
  return effect.harms && (effect.recursive || effect.selects);
}

/** Whether find visits `probe` under `-maxdepth` and `-mindepth`. */
function probeIsVisited(probe: GitProbe, parsed: FindParsed): boolean {
  if (parsed.minDepth !== null && probe.depth < parsed.minDepth) return false;
  if (parsed.maxDepth !== null && probe.depth > parsed.maxDepth) return false;
  return true;
}

/** What `node` does to `probe`. AND and OR follow find's short-circuit; an unknown side still runs the other. */
function evalFind(node: FindNode, probe: GitProbe): FindEffect {
  switch (node.kind) {
    case 'pass':
      return { isTrue: true, harms: false, recursive: false, prunes: false, selects: false };
    case 'fail':
      return { isTrue: false, harms: false, recursive: false, prunes: false, selects: false };
    case 'prune':
      return { isTrue: true, harms: false, recursive: false, prunes: true, selects: false };
    case 'harm':
      return { isTrue: null, harms: true, recursive: node.recursive, prunes: false, selects: false };
    case 'exec':
      return { isTrue: null, harms: node.harms, recursive: node.recursive, prunes: false, selects: false };
    case 'unknown':
      return { isTrue: null, harms: false, recursive: false, prunes: false, selects: false };
    case 'regex':
      return { isTrue: null, harms: false, recursive: false, prunes: false, selects: true };
    case 'name':
    case 'path': {
      const matched = findGlobMatches(node.pattern, node.kind === 'name' ? probe.base : probe.path);
      return { isTrue: matched, harms: false, recursive: false, prunes: false, selects: matched };
    }
    case 'type': {
      const letter = probe.isDir ? 'd' : 'f';
      const known = node.letters.length > 0 && [...node.letters].every((item) => 'bcdpfls'.includes(item));
      if (!known) return { isTrue: null, harms: false, recursive: false, prunes: false, selects: false };
      const matched = node.letters.includes(letter);
      return { isTrue: matched, harms: false, recursive: false, prunes: false, selects: matched };
    }
    case 'not': {
      const inner = evalFind(node.inner, probe);
      return { ...inner, isTrue: inner.isTrue === null ? null : !inner.isTrue };
    }
    case 'and':
      return evalJoin(node, probe, false);
    case 'or':
      return evalJoin(node, probe, true);
    case 'comma': {
      const left = evalFind(node.left, probe);
      const right = evalFind(node.right, probe);
      return combineEffects(left, right, right.isTrue);
    }
  }
}

/** AND (`keep`) or OR. A side known to decide the result is not run; an unknown side is. */
function evalJoin(node: { left: FindNode; right: FindNode }, probe: GitProbe, isOr: boolean): FindEffect {
  const left = evalFind(node.left, probe);
  if (left.isTrue === isOr) return left;
  const right = evalFind(node.right, probe);
  if (left.isTrue === !isOr) return combineEffects(left, right, right.isTrue);
  const isTrue = right.isTrue === isOr ? isOr : null;
  return combineEffects(left, right, isTrue);
}

/** The two sides of one operator, as one effect. `isTrue` is the value find keeps. */
function combineEffects(left: FindEffect, right: FindEffect, isTrue: boolean | null): FindEffect {
  return {
    isTrue,
    harms: left.harms || right.harms,
    recursive: (left.harms && left.recursive) || (right.harms && right.recursive),
    prunes: left.prunes || right.prunes,
    selects: left.selects || right.selects,
  };
}

interface FindCursor { at: number }

/** One empty parse, before any word is read. */
function blankFindParsed(): FindParsed {
  return {
    ok: true, starts: [], node: { kind: 'pass' }, forcesDepth: false, harms: false, unsure: false, targetsGit: false, maxDepth: null, minDepth: null, pathPatterns: [], innerFinds: [],
  };
}

/** The find expression in `args`, or `ok: false` when a word does not fit. */
function parseFindArgs(args: string[], mode: 'history' | 'tree'): FindParsed {
  const parsed = blankFindParsed();
  const cursor: FindCursor = { at: 0 };
  const node = readFind(args, cursor, parsed, mode);
  if (!parsed.ok || node === null || cursor.at !== args.length) parsed.ok = false;
  else parsed.node = node;
  return parsed;
}

/**
 * The find at `cursor`, through its expression. A nested find stops before the
 * `-exec` terminator that belongs to the find which runs it.
 */
function readFind(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  while (cursor.at < args.length && parsed.ok) {
    const word = args[cursor.at];
    if (FIND_LEAD_OPTIONS.test(word)) cursor.at++;
    else if (word === '-D') cursor.at += 2;
    else if (FIND_GLOBAL_VALUES.has(word)) takeGlobal(args, cursor, parsed);
    else if (FIND_DEPTH_OPTIONS.has(word)) {
      parsed.forcesDepth = true;
      cursor.at++;
    } else break;
  }
  while (cursor.at < args.length && !isExprWord(args[cursor.at]) && !isActionTerminator(args, cursor.at)) parsed.starts.push(args[cursor.at++]);
  if (parsed.starts.length === 0) parsed.starts.push('.');
  if (!parsed.ok) return null;
  if (cursor.at >= args.length || isActionTerminator(args, cursor.at)) return parsed.node;
  const node = parseComma(args, cursor, parsed, mode);
  if (!parsed.ok || node === null) return null;
  parsed.node = node;
  return node;
}

/** A find run by `-exec`, parsed in place. `ok` is false when its words do not end on the terminator. */
function parseNestedFind(args: string[], cursor: FindCursor, mode: 'history' | 'tree'): FindParsed {
  const inner = blankFindParsed();
  const node = readFind(args, cursor, inner, mode);
  if (!inner.ok || node === null) {
    inner.ok = false;
    return inner;
  }
  inner.node = node;
  if (!isAtActionEnd(args, cursor.at)) inner.ok = false;
  return inner;
}

/** Whether `word` begins a test or an action, not a start folder. */
function isExprWord(word: string): boolean {
  return word.startsWith('-') || word === '(' || word === ')' || word === '!' || word === ',';
}

/** `-maxdepth`, `-mindepth` and `-regextype`, before the paths or inside the expression. */
function takeGlobal(args: string[], cursor: FindCursor, parsed: FindParsed): void {
  const option = args[cursor.at];
  const value = args[cursor.at + 1];
  if (value === undefined) {
    parsed.ok = false;
    return;
  }
  cursor.at += 2;
  if (option === '-regextype') return;
  if (!/^\d+$/.test(value)) {
    parsed.ok = false;
    return;
  }
  const depth = Number(value);
  // Two limits: assume the one that visits more, so a delete is not let through.
  if (option === '-maxdepth') parsed.maxDepth = parsed.maxDepth === null ? depth : Math.max(parsed.maxDepth, depth);
  else parsed.minDepth = parsed.minDepth === null ? depth : Math.min(parsed.minDepth, depth);
}

/** Comma, the weakest join: both sides run, and the right side's truth is kept. */
function parseComma(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  return parseJoined(args, cursor, parsed, mode, parseOr, (word) => word === ',');
}

/** OR. `-o` and `-or` bind less tightly than AND. */
function parseOr(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  return parseJoined(args, cursor, parsed, mode, parseAnd, (word) => FIND_OR.has(word));
}

/** AND, written or implicit between two tests. */
function parseAnd(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  let left = parseNot(args, cursor, parsed, mode);
  while (parsed.ok && left !== null && cursor.at < args.length) {
    const word = args[cursor.at];
    if (FIND_AND.has(word)) cursor.at++;
    else if (!startsPrimary(word)) break;
    const before = cursor.at;
    const right = parseNot(args, cursor, parsed, mode);
    if (!parsed.ok || right === null) return null;
    if (cursor.at === before) {
      parsed.ok = false;
      return null;
    }
    left = { kind: 'and', left, right };
  }
  return left;
}

/**
 * A chain of one join. `lower` parses the tighter level, `isJoin` the operator.
 * The kind is comma, or, or whatever `lower` already built for AND.
 */
function parseJoined(
  args: string[],
  cursor: FindCursor,
  parsed: FindParsed,
  mode: 'history' | 'tree',
  lower: (args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree') => FindNode | null,
  isJoin: (word: string) => boolean,
): FindNode | null {
  let left = lower(args, cursor, parsed, mode);
  while (parsed.ok && left !== null && cursor.at < args.length && isJoin(args[cursor.at])) {
    const kind = args[cursor.at] === ',' ? 'comma' : 'or';
    cursor.at++;
    const right = lower(args, cursor, parsed, mode);
    if (right === null) return null;
    left = { kind, left, right };
  }
  return left;
}

/** `!` and `-not`, tighter than AND. */
function parseNot(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  if (!parsed.ok || cursor.at >= args.length) return null;
  const word = args[cursor.at];
  if (word !== '!' && word !== '-not') return parsePrimary(args, cursor, parsed, mode);
  cursor.at++;
  const inner = parseNot(args, cursor, parsed, mode);
  return inner === null ? null : { kind: 'not', inner };
}

/** Whether the next word can start a test, so AND is implicit. */
function startsPrimary(word: string | undefined): boolean {
  if (word === undefined || word === ')' || word === ',' || FIND_OR.has(word) || FIND_AND.has(word)) return false;
  return word === '(' || word === '!' || word === '-not' || word.startsWith('-');
}

/** One test, action, or parenthesised group. */
function parsePrimary(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  if (!parsed.ok || cursor.at >= args.length) return null;
  const word = args[cursor.at];
  if (word === '(') {
    cursor.at++;
    const inner = parseComma(args, cursor, parsed, mode);
    if (inner === null || args[cursor.at] !== ')') {
      parsed.ok = false;
      return null;
    }
    cursor.at++;
    return inner;
  }
  if (FIND_ACTIONS.has(word)) return parseExec(args, cursor, parsed, mode);
  if (word === '-delete') {
    cursor.at++;
    parsed.harms = true;
    return { kind: 'harm', recursive: false };
  }
  if (word === '-prune') {
    cursor.at++;
    return { kind: 'prune' };
  }
  if (FIND_DEPTH_OPTIONS.has(word)) {
    cursor.at++;
    parsed.forcesDepth = true;
    return { kind: 'pass' };
  }
  if (FIND_GLOBAL_VALUES.has(word)) {
    takeGlobal(args, cursor, parsed);
    return parsed.ok ? { kind: 'pass' } : null;
  }
  if (FIND_PRINTS.has(word) || word === '-true') {
    cursor.at++;
    return { kind: 'pass' };
  }
  if (word === '-false') {
    cursor.at++;
    return { kind: 'fail' };
  }
  if (FIND_NAME_TESTS.has(word) || word === '-lname' || word === '-ilname') return parsePattern(args, cursor, parsed, 'name', word === '-lname' || word === '-ilname');
  if (word === '-path' || word === '-ipath' || word === '-wholename' || word === '-iwholename') return parsePattern(args, cursor, parsed, 'path', false);
  if (word === '-regex' || word === '-iregex') return parsePattern(args, cursor, parsed, 'regex', false);
  if (word === '-type' || word === '-xtype') return parseType(args, cursor, parsed, word === '-xtype');
  if (FIND_FILE_ACTIONS.has(word) || word === '-fprintf') return parseFileAction(args, cursor, parsed, mode, word === '-fprintf' ? 2 : 1);
  if (!word.startsWith('-')) {
    parsed.ok = false;
    return null;
  }
  // A test the guard does not know. Take a following value so the next test still lines up.
  cursor.at++;
  const next = args[cursor.at];
  if (next !== undefined && !next.startsWith('-') && next !== '(' && next !== ')' && next !== ',' && next !== '!') cursor.at++;
  return { kind: 'unknown' };
}

/** `-name` or `-path` and its pattern. A symlink-target test (`-lname`) stays unknown. */
function parsePattern(args: string[], cursor: FindCursor, parsed: FindParsed, kind: 'name' | 'path' | 'regex', isUnknown: boolean): FindNode | null {
  const pattern = args[cursor.at + 1];
  if (pattern === undefined) {
    parsed.ok = false;
    return null;
  }
  cursor.at += 2;
  if (kind === 'regex') return { kind: 'regex' };
  if (kind === 'path') parsed.pathPatterns.push(pattern);
  if (isUnknown) return { kind: 'unknown' };
  return { kind, pattern };
}

/** `-type` and its letter. `-xtype` follows symlinks, which the guard does not. */
function parseType(args: string[], cursor: FindCursor, parsed: FindParsed, isUnknown: boolean): FindNode | null {
  const letters = args[cursor.at + 1];
  if (letters === undefined) {
    parsed.ok = false;
    return null;
  }
  cursor.at += 2;
  return isUnknown ? { kind: 'unknown' } : { kind: 'type', letters };
}

/** `-fprint` and its kin. In tree mode they count as a write, so the mark rule does not stand down. */
function parseFileAction(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree', values: number): FindNode | null {
  if (cursor.at + values >= args.length) {
    parsed.ok = false;
    return null;
  }
  cursor.at += 1 + values;
  if (mode === 'history') return { kind: 'pass' };
  parsed.harms = true;
  return { kind: 'harm', recursive: false };
}

/** The command after `-exec` and its kin, up to `;` or `{} +`, with nested finds kept whole. */
function parseExec(args: string[], cursor: FindCursor, parsed: FindParsed, mode: 'history' | 'tree'): FindNode | null {
  cursor.at++;
  const findAt = indexOfLaunchedFind(args, cursor.at);
  if (findAt !== -1) {
    // The program is find. Parse it in this walk. A chain of `find -exec find`
    // is then one read, not a fresh read of the tail for every find (#744).
    cursor.at = findAt + 1;
    const inner = parseNestedFind(args, cursor, mode);
    if (!inner.ok) {
      parsed.ok = false;
      return null;
    }
    parsed.innerFinds.push(inner);
    if (cursor.at < args.length) cursor.at++;
    return { kind: 'exec', harms: false, recursive: false };
  }
  const command = readAction(args, cursor);
  if (command === null) {
    parsed.ok = false;
    return null;
  }
  const removal = execEffect(command, mode);
  if (removal.unsure) parsed.unsure = true;
  if (removal.targetsGit) parsed.targetsGit = true;
  if (removal.harmsMatch) parsed.harms = true;
  return { kind: 'exec', harms: removal.harmsMatch, recursive: removal.recursive };
}

/** Whether `words[index]` ends an `-exec` action: `;`, or `+` right after `{}`. */
function isActionTerminator(words: string[], index: number): boolean {
  const word = words[index];
  return word === ';' || (word === '+' && words[index - 1] === '{}');
}

/** Whether the action's command is over: no words left, or the terminator is next. */
function isAtActionEnd(words: string[], index: number): boolean {
  return index >= words.length || isActionTerminator(words, index);
}

/**
 * The index of `find` when the action at `start` is launchers and then `find`.
 * `-1` when the program is anything else, so the ordinary action reader runs.
 */
function indexOfLaunchedFind(args: string[], start: number): number {
  let index = start;
  while (index < args.length && !isActionTerminator(args, index)) {
    const name = programName(args[index]);
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(args[index + 1] ?? '')) return -1;
    if (!Object.hasOwn(LAUNCHERS, name)) return name === 'find' ? index : -1;
    const launcher = LAUNCHERS[name];
    index++;
    while (index < args.length && !isActionTerminator(args, index) && args[index].startsWith('-')) {
      index += launcher.options.includes(args[index]) ? 2 : 1;
    }
    const operands = launcher.operands ?? 0;
    for (let count = 0; count < operands && index < args.length && !isActionTerminator(args, index); count++) index++;
  }
  return -1;
}

/** The words of one find action. Null when the terminator is missing. Inner actions keep theirs. */
function readAction(words: string[], cursor: FindCursor): string[] | null {
  const command: string[] = [];
  let nested = 0;
  while (cursor.at < words.length) {
    const word = words[cursor.at];
    if (FIND_ACTIONS.has(word)) {
      nested++;
      command.push(word);
      cursor.at++;
      continue;
    }
    const closes = isActionTerminator(words, cursor.at);
    if (closes && nested > 0) {
      nested--;
      command.push(word);
      cursor.at++;
      continue;
    }
    if (closes) {
      cursor.at++;
      return command;
    }
    command.push(word);
    cursor.at++;
  }
  // The shell's own `;` already ended the command, so the action runs to here.
  return nested === 0 ? command : null;
}

/** What an `-exec` command removes. A writer or a shell harms the tree even when it is not `rm`. */
interface Removal {
  harmsMatch: boolean;
  recursive: boolean;
  unsure: boolean;
  targetsGit: boolean;
}

/** An empty removal: the command deletes nothing the guard can see. */
function blankRemoval(): Removal {
  return { harmsMatch: false, recursive: false, unsure: false, targetsGit: false };
}

/** Fold `extra` into `result`. */
function mergeRemoval(result: Removal, extra: Removal): void {
  result.harmsMatch ||= extra.harmsMatch;
  result.recursive ||= extra.recursive;
  result.unsure ||= extra.unsure;
  result.targetsGit ||= extra.targetsGit;
}

/** `command`'s removal, plus, in tree mode, any writer or shell it runs. */
function execEffect(command: string[], mode: 'history' | 'tree'): Removal {
  const removal = commandRemoval(command, 0);
  if (mode !== 'tree' || removal.harmsMatch) return removal;
  const writes = findProgramPlaces(command).some((place) => {
    const name = programName(place.word);
    return Object.hasOwn(WRITERS, name) || MARK_WRITERS.has(name) || RUNS_CODE.test(name);
  });
  if (writes) removal.harmsMatch = true;
  return removal;
}

/** Whether `words` runs `rm` on the file find is visiting, or on a path that can be `.git`. */
function commandRemoval(words: string[], depth: number): Removal {
  const result = blankRemoval();
  if (depth > 4) {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
    return result;
  }
  const places = findProgramPlaces(words);
  if (places.length === 0 && words.some((word) => /[$`]/.test(word))) {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
    return result;
  }
  for (const place of places) {
    const name = programName(place.word);
    if (/[$`]/.test(name)) {
      result.unsure = true;
      result.harmsMatch = true;
      result.recursive = true;
      continue;
    }
    if (REMOVE_PROGRAMS.has(name)) mergeRemoval(result, rmRemoval(words, place.index));
    else if (isShell(place.word) || Object.hasOwn(RUNNERS, name)) mergeRemoval(result, shellRemoval(words, place.index, depth));
  }
  return result;
}

/** `rm` at `index`: a match operand deletes the file find visits; a `.git` operand is named outright. */
function rmRemoval(words: string[], index: number): Removal {
  const result = blankRemoval();
  const name = programName(words[index] ?? '');
  const args = words.slice(index + 1);
  const recursive = name === 'rm' && rmIsRecursive(args);
  const valued = name === 'shred' ? ['-n', '--iterations', '-s', '--size'] : [];
  for (const operand of plainArgs(args, valued)) {
    if (operand.split(PATH_BREAKS).filter(Boolean).some(mayBeDotGit)) result.targetsGit = true;
    if (operand.includes('{}') || /[$`*?[{]/.test(operand)) {
      result.harmsMatch = true;
      if (recursive) result.recursive = true;
    }
  }
  return result;
}

/** Whether `rm`'s options descend into folders (`-r`, `-R`, `--recursive`). */
function rmIsRecursive(args: string[]): boolean {
  for (const word of args) {
    if (word === '--') break;
    if (word === '--recursive') return true;
    if (word.startsWith('--')) continue;
    if (/^-[^-]*[rR]/.test(word)) return true;
  }
  return false;
}

/** A shell or a runner at `index`. A script the guard can read is checked; anything else may run `rm`. */
function shellRemoval(words: string[], index: number, depth: number): Removal {
  const result = blankRemoval();
  const script = isShell(words[index] ?? '') ? shellScript(words, index) : runString(words, index);
  if (script === null || script === '') {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
    return result;
  }
  // A script with no removal and no substitution cannot touch `.git`.
  if (!/[$`]/.test(script) && !/(?:^|[^A-Za-z0-9_])(rm|rmdir|unlink|shred)(?:$|[^A-Za-z0-9_])/.test(script)) return result;
  try {
    for (const command of commandWords(script)) mergeRemoval(result, commandRemoval(command, depth + 1));
  } catch {
    result.unsure = true;
    result.harmsMatch = true;
    result.recursive = true;
  }
  return result;
}

/** The script after a shell's `-c`, or null when the shell reads a file or its input instead. */
function shellScript(words: string[], index: number): string | null {
  let at = index + 1;
  while (at < words.length && words[at].startsWith('-') && !/^-[a-zA-Z]*c/.test(words[at])) {
    if (words[at] === '--') return null;
    at++;
  }
  const flag = words[at];
  if (flag === undefined) return null;
  const cluster = /^-[a-zA-Z]*c(.*)$/s.exec(flag);
  if (!cluster) return null;
  return cluster[1] || (words[at + 1] ?? '');
}

/** Whether a find the parser could not read still looks like a delete, so the guard refuses it. */
function looksLikeGitDelete(args: string[]): boolean {
  if (args.includes('-delete')) return true;
  for (let index = 0; index < args.length; index++) {
    if (!FIND_ACTIONS.has(args[index])) continue;
    const cursor: FindCursor = { at: index + 1 };
    const command = readAction(args, cursor);
    const removal = commandRemoval(command ?? args.slice(index + 1), 0);
    if (removal.harmsMatch || removal.targetsGit || removal.unsure) return true;
    // No terminator, and nothing here removes: not this rule (`find . -exec env` repeated).
    if (command === null) return false;
    index = cursor.at - 1;
  }
  return false;
}

const PIPE_SHELL_FIX = 'save it first (`curl -fsSL <url> -o <file>`), read it, then run it (`sh <file>`)';
// A download written to a pipe: curl and wget, plus wget2, aria2c and fetch (#574).
const DOWNLOAD_PROGRAMS = new Set(['curl', 'wget', 'wget2', 'aria2c', 'fetch']);
// Where a download reads from. A download command with no URL is not one here.
const DOWNLOAD_URL = /(?:https?|ftp):\/\/[^\s'"|;)]+/;
// A URL without the `user:password@` part: a refusal names the download but never a secret in it (core rule 11).
const withoutCredentials = (url: string) => url.replace(/\/\/[^/@]*@/, '//');

/** A pipeline that feeds a download into a shell, `eval`, or a program word that is not plain text runs code nobody read (#560, #574, #734, #745). */
export function checkPipeToShell(command: string): Finding | null {
  for (const pipeline of splitPipelines(command)) {
    const segments = splitPipeSegments(pipeline);
    if (segments.length < 2) continue;
    // The first download in the segments so far: one pass, so a long pipeline reads in
    // linear time. A shell in the first segment has nothing before it, so it passes.
    let downloader: string | undefined;
    let downloadUrl: string | undefined;
    for (const segment of segments) {
      const commands = commandWords(segment);
      const programs = commands.flatMap(findPrograms).map(programName);
      const shell = findPipeShell(programs, commands, segment) ?? findStdinRunner(commands) ?? findMakeStdin(commands);
      if (shell !== undefined && downloader !== undefined) {
        const download = downloadUrl === undefined ? 'a download' : `the download ${withoutCredentials(downloadUrl)}`;
        return finding('pipe-to-shell', `\`${downloader} | ${shell}\` runs ${download} without letting you read it first`, PIPE_SHELL_FIX);
      }
      if (downloader === undefined) {
        const program = programs.find((name) => DOWNLOAD_PROGRAMS.has(name.toLowerCase()));
        if (program !== undefined) {
          downloader = program;
          downloadUrl = DOWNLOAD_URL.exec(segment)?.[0];
        }
      }
    }
  }
  return null;
}

/**
 * The program that would run this segment as a shell.
 * A `$(…)`, backticks or `<(…)` inherits the pipe, so the nested command can run the download (#734).
 * A program word that is not plain text can become a shell too, so it is refused (#745).
 */
function findPipeShell(programs: string[], commands: string[][], segment: string): string | undefined {
  const first = programs[0];
  if (first !== undefined && isPipeShell(first)) return first;
  // `sudo -s` reads stdin wherever it sits, including inside a substitution.
  for (const words of commands) {
    const runner = findShellRunner(words);
    if (runner !== undefined) return runner;
  }
  const substitutions = scanSubstitutions(segment);
  if (substitutions.live) {
    // `bash -c "$(cat)"`: `$(cat)` is read first, so the shell is not the first program.
    const nested = programs.find((program) => isPipeShell(program));
    if (nested !== undefined) return nested;
    // `$x`, or a substitution that never closes, may be a shell. The guard cannot tell, so it refuses.
    const hidden = programs.find(isHiddenProgram);
    if (hidden !== undefined) return hidden;
    if (substitutions.unclosed) return 'sh';
  }
  // No shell name was written out. A prefix or a `$` name can still expand into one.
  return findUnplainProgram(commands);
}

/** A program whose name is still a `$` value or a substitution, so it may be a shell. */
const isHiddenProgram = (name: string) => name.startsWith('$') || name.includes('`') || name.includes('<(') || name.includes('>(');

// After a download, a program word may hold only these characters. The guard allows
// characters and does not read the shell's grammar: `s$(echo h)`, `$sh` and `sh*` are
// not plain, so they are refused, and so is `eval` with any argument (#734, #745).
const PLAIN_PROGRAM = /^[A-Za-z0-9._/-]+$/;
// The inside of `$((1+2))`. commandWords lists it as its own command. It is math, not a program.
const ARITHMETIC_BODY = /\$\(\(([0-9]+(?:[+\-*/%][0-9]+)*)\)\)/g;

/** Program words `$((…))` lists beside the real command, such as `1+2` from `echo $((1+2))`. */
function findArithmeticBodies(commands: string[][]): Set<string> {
  const bodies = new Set<string>();
  for (const words of commands) {
    for (const word of words) {
      spend(word.length);
      ARITHMETIC_BODY.lastIndex = 0;
      for (let match = ARITHMETIC_BODY.exec(word); match !== null; match = ARITHMETIC_BODY.exec(word)) bodies.add(match[1]);
    }
  }
  return bodies;
}

/**
 * A program word that is not plain text, or `eval` with an argument.
 * The word is the text before expansion, path included, so `/bin/s$(echo h)` is refused.
 */
function findUnplainProgram(commands: string[][]): string | undefined {
  const arithmetic = findArithmeticBodies(commands);
  for (const words of commands) {
    spend(words.length);
    if (words.length === 1 && arithmetic.has(words[0])) continue;
    for (const place of findProgramPlaces(words)) {
      if (!PLAIN_PROGRAM.test(place.word)) return place.word;
    }
    if (hasEvalArgument(words)) return 'eval';
  }
  return undefined;
}

/** Whether `eval` has an argument, so it runs that argument as a command. A redirect is not one. */
function hasEvalArgument(words: string[]): boolean {
  for (const place of findProgramPlaces(words)) {
    if (place.index < 0 || programName(place.word).toLowerCase() !== 'eval') continue;
    let index = place.index + 1;
    while (index < words.length && redirectLength(words, index) > 0) index += redirectLength(words, index);
    if (index < words.length) return true;
  }
  return false;
}

// ---- A download run without a pipe (#830) ----
//
// `bash -c "$(curl …)"`, `eval "$(curl …)"`, `sh <<< "$(curl …)"`, `bash <(curl …)` and a
// makefile from a pipe all run code nobody read. The guard allows a small set
// of characters rather than reading grammar, so a form it cannot name is refused.

/** Programs that run the text they are given as commands, beyond the shells (#830). */
const STRING_RUNNERS = new Set(['eval', 'source', '.', 'ssh', 'su', 'runuser', 'watch', 'script', 'flock', 'parallel', 'tmux', 'screen']);
// Programs that run their input as a program when no script file names one (#830).
// Rscript needs the `-` word; the others read their input with no word at all.
const STDIN_PROGRAMS = new Set(['python', 'node', 'nodejs', 'perl', 'ruby', 'php', 'lua', 'luajit', 'r', 'deno', 'bun', 'tclsh', 'guile', 'racket', 'osascript']);
const STDIN_NEEDS_DASH = new Set(['rscript']);
// An option that gives the program inline (`-c`, `-e`, `-m`), so no input is read.
const INLINE_PROGRAM_OPTION = /^-(?:[A-Za-z]*[cem]|-(?:eval|execute|print|require|import|command|module))/;
// An option that prints the version or the help and then exits, so no input is read.
const PRINT_ONLY_OPTION = /^(?:--(?:version|help|usage)|-[Vh])$/;
// `-v` is version for these, but verbose for python and R, which still run the program (#885).
const VERSION_IS_V = new Set(['perl', 'ruby', 'php', 'lua', 'luajit', 'node', 'nodejs', 'tclsh']);
// A file that is the program's input: `<` names it, `make -f` names it, and an
// interpreter operand names it too (#830, #885).
const STDIN_FILE = /^\/?(?:dev\/(?:stdin|fd\/0)|proc\/(?:self|\d+)\/fd\/0)$/;
const MAKE_PROGRAMS = new Set(['make', 'gmake', 'bmake']);
// The URL of a download inside `text`, if any.
const downloadIn = (text: string): string | undefined => DOWNLOAD_URL.exec(text)?.[0];

/** The base name of an interpreter, with its version dropped: `python3.12` is `python`. */
const interpreterName = (word: string) => programName(word).toLowerCase().replace(/\d+(?:\.\d+)*$/, '');

/** Whether `arg` only prints the program's version or help, so the program never reads input. */
function printsOnly(name: string, arg: string): boolean {
  if (PRINT_ONLY_OPTION.test(arg)) return true;
  return arg === '-v' && VERSION_IS_V.has(name);
}

/** Whether `words[from]` names an interpreter that reads its program from input. */
function interpreterReadsStdin(words: string[], from: number): boolean {
  const name = interpreterName(words[from] ?? '');
  const isInterpreter = STDIN_PROGRAMS.has(name) || STDIN_NEEDS_DASH.has(name);
  if (!isInterpreter) return false;
  const args = words.slice(from + 1);
  // A `-` word, or a file that is input, is the program the interpreter runs (#885).
  if (args.some((arg) => arg === '-' || STDIN_FILE.test(arg))) return true;
  // Another operand is a script file, unless an inline-program option came first.
  if (args.some((arg) => !arg.startsWith('-'))) return false;
  if (args.some((arg) => INLINE_PROGRAM_OPTION.test(arg))) return false;
  // `python3 --version` and `perl -v` print and exit: they never run the pipe as a program.
  if (args.some((arg) => printsOnly(name, arg))) return false;
  return STDIN_PROGRAMS.has(name);
}

/** The interpreter a command feeds from a pipe, or undefined (#830). */
function findStdinRunner(commands: string[][]): string | undefined {
  for (const words of commands) {
    for (const place of findProgramPlaces(words)) {
      if (place.index < 0) continue;
      if (interpreterReadsStdin(words, place.index)) {
        const args = words.slice(place.index + 1);
        const stdin = args.some((arg) => arg === '-' || STDIN_FILE.test(arg)) ? ' -' : '';
        return `${programName(place.word)}${stdin}`;
      }
    }
  }
  return undefined;
}

/** The makefile word of a make option at `at`, with the index of the word it used, or null. */
function makefileValue(words: string[], at: number): { value: string; next: number } | null {
  const word = words[at];
  if (word.startsWith('--')) {
    // make accepts a unique prefix of a long option, and so does the guard (#830).
    const match = /^--([A-Za-z][A-Za-z-]*)(?:=(.*))?$/s.exec(word);
    if (match === null) return null;
    const option = match[1].toLowerCase();
    const isFile = 'file'.startsWith(option) || 'makefile'.startsWith(option);
    if (!isFile) return null;
    if (match[2] !== undefined) return { value: match[2], next: at };
    return at + 1 < words.length ? { value: words[at + 1], next: at + 1 } : null;
  }
  if (!word.startsWith('-') || word === '-') return null;
  const letter = word.indexOf('f', 1);
  if (letter === -1) return null;
  const rest = word.slice(letter + 1);
  if (rest !== '') return { value: rest, next: at };
  return at + 1 < words.length ? { value: words[at + 1], next: at + 1 } : null;
}

/** Whether a make command runs a makefile from input, which a pipe can fill (#830). */
function makeReadsStdin(words: string[], from: number): boolean {
  for (let at = from + 1; at < words.length; at++) {
    const found = makefileValue(words, at);
    if (found === null) continue;
    at = found.next;
    if (found.value === '-' || STDIN_FILE.test(found.value) || runsDownload(found.value)) return true;
  }
  return false;
}

/** The make command that runs the makefile a pipe carries, or undefined (#830). */
function findMakeStdin(commands: string[][]): string | undefined {
  for (const words of commands) {
    for (const place of findProgramPlaces(words)) {
      if (place.index < 0) continue;
      const name = programName(place.word).toLowerCase();
      if (!MAKE_PROGRAMS.has(name)) continue;
      if (makeReadsStdin(words, place.index)) return `${name} -f -`;
    }
  }
  return undefined;
}

/** Whether a command in `text` downloads from the internet. */
function hasDownloadCommand(text: string): boolean {
  if (downloadIn(text) === undefined) return false;
  return commandWords(text).some((words) => findPrograms(words).some((program) => DOWNLOAD_PROGRAMS.has(programName(program).toLowerCase())));
}

/**
 * The text inside the substitution or process substitution that starts at `from`.
 * Undefined when it never closes, so the rest of the text is treated as inside it.
 */
function substitutionBody(text: string, from: number): string | undefined {
  const width = text[from] === '`' ? 1 : 2;
  const start = from + width;
  if (width === 1) {
    const end = text.indexOf('`', start);
    return end === -1 ? undefined : text.slice(start, end);
  }
  let depth = 1;
  for (let at = start; at < text.length; at++) {
    if (text.startsWith('$(', at) || text.startsWith('<(', at) || text.startsWith('>(', at)) {
      depth++;
      at++;
    } else if (text[at] === ')') {
      depth--;
      if (depth === 0) return text.slice(start, at);
    }
  }
  return undefined;
}

/**
 * Whether `text` runs a download inside a substitution or a process substitution (#830).
 * The download is a program of the substitution's own text, not just a word beside it:
 * `bash -c "curl <url>"` only reads, while `bash -c "$(curl <url>)"` runs the answer.
 * A download after the closing parenthesis is beside it, not inside it.
 */
function runsDownload(text: string): boolean {
  spend(text.length);
  for (let at = 0; at < text.length; at++) {
    const opens = text.startsWith('$(', at) || text.startsWith('<(', at) || text.startsWith('>(', at);
    if (!opens && text[at] !== '`') continue;
    const width = text[at] === '`' ? 1 : 2;
    const body = substitutionBody(text, at) ?? text.slice(at + width);
    if (hasDownloadCommand(body)) return true;
    at += width - 1;
  }
  return false;
}

/** The program that runs a substitution, process substitution or here-string in `words` (#830). */
function findStringRunner(words: string[]): string | undefined {
  for (const place of findProgramPlaces(words)) {
    if (place.index < 0) continue;
    const name = programName(place.word).toLowerCase();
    const run = isShell(name) || STRING_RUNNERS.has(name) || STDIN_PROGRAMS.has(interpreterName(place.word)) || STDIN_NEEDS_DASH.has(interpreterName(place.word));
    if (run) return name;
  }
  return undefined;
}

/**
 * A download run without a pipe, inside a substitution, a process substitution or a
 * here-string (#830). The guard cannot read the code, so it refuses.
 */
export function checkDownloadRunner(commands: string[][]): Finding | null {
  for (const words of commands) {
    const carried = words.find((word) => runsDownload(word));
    if (carried === undefined) continue;
    // `source <(…)` runs it; so does a makefile given as a process substitution.
    const runner = findStringRunner(words) ?? findMakeStdin([words]);
    if (runner !== undefined) return finding('pipe-to-shell', `\`${runner}\` runs a download without letting you read it first`, PIPE_SHELL_FIX);
    // A download inside a substitution where a command goes runs too (#885): `$(curl …)`,
    // the backtick form, and the same after an assignment or a launcher. Elsewhere it is
    // only read: `echo "$(curl …)"` prints it, and `X=$(curl …)` saves it.
    const place = findProgramPlaces(words).find((at) => at.index >= 0 && runsDownload(at.word));
    if (place === undefined) continue;
    const shape = place.word.includes('`') ? 'a backtick substitution' : '`$(…)`';
    return finding('pipe-to-shell', `a command from ${shape} runs a download without letting you read it first`, PIPE_SHELL_FIX);
  }
  return null;
}

// Whether a substitution in `text` runs, and whether one never closes.
// Single quotes and `$'…'` hide it. `<(…)` and `>(…)` do not run inside `"…"`. `$((…))` is arithmetic.
// A backslash and a newline inside `"…"` are removed before the shell parses.
interface SubstitutionScan {
  live: boolean;
  unclosed: boolean;
}

function scanSubstitutions(text: string): SubstitutionScan {
  spend(text.length);
  let live = false;
  let quote = '';
  let ansi = false;
  let inWord = false;
  let backtick = false;
  const kinds: Array<'run' | 'skip'> = [];
  // `at` stays on the last character of the opener. The loop then steps past it.
  const open = (kind: 'run' | 'skip', at: number, width: number) => {
    kinds.push(kind);
    if (kind === 'run') live = true;
    return at + width - 1;
  };
  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    const next = text[at + 1] ?? '';
    if (ansi) {
      if (character === '\\') at++;
      else if (character === "'") ansi = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      // `"$\⏎(sh)"` is `"$(sh)"`. The pair is not an escape of the next character.
      if (character === '\\' && next === '\n') {
        at++;
        continue;
      }
      if (character === '\\' && '$`"\\'.includes(next)) {
        at++;
        continue;
      }
      if (character === '"') {
        quote = '';
        continue;
      }
      if (character === '`') {
        live = true;
        backtick = !backtick;
      } else if (character === '$') {
        const opened = skipContinuation(text, at + 1);
        if (text[opened] === '(') {
          if (text[opened + 1] === '(') {
            kinds.push('skip', 'skip');
            at = opened + 1;
          } else at = open('run', opened, 1);
        }
      } else if (character === '(') kinds.push('skip');
      else if (character === ')' && kinds.length > 0) kinds.pop();
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      inWord = false;
      continue;
    }
    if (!inWord && character === '#') {
      while (at < text.length && text[at] !== '\n') at++;
      continue;
    }
    if (character === '\\') {
      at++;
      inWord = true;
      continue;
    }
    if (character === '$' && next === "'") {
      ansi = true;
      at++;
      inWord = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === '`') {
      live = true;
      backtick = !backtick;
    } else if ((character === '$' || character === '<' || character === '>') && next === '(') {
      if (character === '$' && text[at + 2] === '(') {
        kinds.push('skip', 'skip');
        at += 2;
      } else at = open('run', at, 2);
    } else if (character === '(') kinds.push('skip');
    else if (character === ')' && kinds.length > 0) kinds.pop();
    inWord = true;
  }
  return { live, unclosed: backtick || kinds.includes('run') };
}

/** Whether `name` is a shell. `powershell` stays beside `isShell`, which names `pwsh` (#574). */
function isPipeShell(name: string): boolean {
  const folded = name.toLowerCase();
  return folded === 'powershell' || isShell(folded);
}

/**
 * `sudo -s`, `sudo -i` or `doas -s` reads stdin as a shell when no program follows.
 * The flag meaning is `RUNNERS`. A later program is that program, so `sudo tee` passes.
 */
function findShellRunner(words: string[]): string | undefined {
  spend(words.length);
  let index = skipPrefix(words, 0);
  while (index < words.length) {
    if (HEADS.has(words[index])) return undefined;
    const name = programName(words[index]);
    const folded = name.toLowerCase();
    if (!Object.hasOwn(LAUNCHERS, folded)) return undefined;
    const launcher = LAUNCHERS[folded];
    const shellFlag = folded === 'sudo' || folded === 'doas' ? RUNNERS[folded] : null;
    index++;
    let readsShell = false;
    while (index < words.length && words[index].startsWith('-')) {
      if (shellFlag !== null && shellFlag.test(words[index])) readsShell = true;
      index += launcher.options.includes(words[index]) ? 2 : 1;
    }
    index += launcher.operands ?? 0;
    // A redirect names a file. `sudo -s > saved` still reads the pipe as a shell.
    while (index < words.length && redirectLength(words, index) > 0) index += redirectLength(words, index);
    if (readsShell && index >= words.length) return name;
  }
  return undefined;
}

/** Whether `text` ends in a pipe, so the shell reads the next line as its right side (#830). */
function endsWithPipe(text: string): boolean {
  let end = text.length - 1;
  while (end >= 0 && (text[end] === ' ' || text[end] === '\t')) end--;
  if (end < 0) return false;
  if (text[end] === '&' && text[end - 1] === '|') return true;
  return text[end] === '|' && text[end - 1] !== '|';
}

/** Whether the line break at `from` stands before a pipe, so the pipe belongs to this line (#830). */
function startsWithPipe(text: string, from: number): boolean {
  let at = from;
  while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\r')) at++;
  return text[at] === '|' && text[at + 1] !== '|';
}

/** The command's pipelines: cut at ; && || and line ends, outside quotes and groups. */
function splitPipelines(command: string): string[] {
  const pipelines: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  const push = () => {
    pipelines.push(current);
    current = '';
  };
  for (let at = 0; at < command.length; at++) {
    spend(1);
    const character = command[at];
    const next = command[at + 1] ?? '';
    if (quote === "'") {
      current += character;
      if (character === "'") quote = '';
    } else if (quote === '"') {
      current += character;
      if (character === '\\' && at + 1 < command.length) current += command[++at];
      else if (character === '"') quote = '';
    } else if (character === '\\') {
      current += character;
      if (at + 1 < command.length) current += command[++at];
    } else if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === '(') {
      depth++;
      current += character;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if ((character === ';' || character === '\n' || character === '\r') && depth === 0) {
      // A line break on either side of a pipe continues the same pipeline (#830).
      if ((character === '\n' || character === '\r') && (endsWithPipe(current) || startsWithPipe(command, at + 1))) continue;
      push();
    } else if ((character === '&' && next === '&') || (character === '|' && next === '|')) {
      if (depth === 0) {
        push();
        at++;
      } else current += character;
    } else current += character;
  }
  pipelines.push(current);
  return pipelines;
}

/** One pipeline's pipe segments: cut at | and |&, outside quotes. */
function splitPipeSegments(pipeline: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote = '';
  for (let at = 0; at < pipeline.length; at++) {
    spend(1);
    const character = pipeline[at];
    if (quote !== '') {
      current += character;
      if (character === '\\' && quote === '"' && at + 1 < pipeline.length) current += pipeline[++at];
      else if (character === quote) quote = '';
    } else if (character === '\\') {
      current += character;
      if (at + 1 < pipeline.length) current += pipeline[++at];
    } else if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === '|') {
      if (pipeline[at + 1] === '|') {
        current += '||';
        at++;
      } else {
        segments.push(current);
        current = '';
        if (pipeline[at + 1] === '&') at++;
      }
    } else current += character;
  }
  segments.push(current);
  return segments;
}

