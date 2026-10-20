// The rules an agent works under. Each check returns null to let the action go on, or a
// finding: what it stops, why, and what the agent does instead.
//
// `env` is the guard's own environment, which the session sets and the agent cannot change.
// The command text is never read for it: `YOKOTEN_FIX_TASK=0 git commit` inside a command
// changes nothing. A session is the lead unless whoever started it set YOKOTEN_ROLE=worker
// (the dispatch skill does, for each worker it starts).
//
// This is a guard against mistakes and drift, not a lock. It reads command text, so a
// command built up in pieces gets past it. The lock is on the server: branch protection,
// CODEOWNERS, and a release token the agents do not hold.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Config, Env } from './config.ts';
import { loadConfig, matcher } from './config.ts';
import { type Finding, finding } from './message.ts';
import { checkCommandTitle } from './pr.ts';
import { checkPost, type GhCommand, ghIndex } from './privacy.ts';

/** A file edit, by path relative to the repo root. */
export function checkEdit(path: string, { config, env }: { config: Config; env: Env }): Finding | null {
  if (env.YOKOTEN_FIX_TASK === '1' && matcher(config.tests)(path)) {
    return finding('test-file', `${path} is a test file, and this is a fix task (YOKOTEN_FIX_TASK=1)`, 'if the test is wrong, stop and say so in your report');
  }
  if (env.YOKOTEN_ROLE === 'worker' && isLeadOnly(path, config.leadOnly) && !isGranted(path, env)) {
    return finding('lead-only', `${path} is lead-only (yokoten.json "leadOnly")`, LEAD_ONLY_FIX);
  }
  return null;
}

const LEAD_ONLY_FIX = 'stop and hand the change to the lead: say in your report what to change in it, or ask the lead to start you with YOKOTEN_LEAD_ONLY_OK=<path>';

// On macOS and Windows a file name is the same file in any case: `agents.md` is AGENTS.md.
const FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** Whether yokoten.json "leadOnly" matches the path, in any case where file names ignore it. */
export function isLeadOnly(path: string, leadOnly: string[], foldsCase = FOLDS_CASE): boolean {
  return matcher(leadOnly, { foldsCase })(path);
}

/**
 * Whether the lead lets this worker change a lead-only path: YOKOTEN_LEAD_ONLY_OK, a
 * comma-separated list of paths from the repo root, set when the worker starts. An entry
 * with a `*` is a glob, as in yokoten.json (`*` alone grants every lead-only file); any
 * other entry is that one path. `\` reads as `/`, a trailing `/` and a leading `./` are
 * dropped, and an empty entry counts for nothing.
 */
export function isGranted(path: string, env: Env, foldsCase = FOLDS_CASE): boolean {
  const entries = (env.YOKOTEN_LEAD_ONLY_OK ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const same = (entry: string) => (foldsCase ? entry.toLowerCase() === path.toLowerCase() : entry === path);
  return entries.some((entry) => (entry.includes('*') ? matcher([entry], { foldsCase })(path) : same(entry)));
}

/**
 * A shell command, as the agent wrote it. `config` brings the programs the project blocks
 * (yokoten.json "commands.block"); without it, only the core rules apply. `cwd` is the
 * folder the command runs in, by default this process's: a change to core.hooksPath reads
 * that repo's setting and hooks. `titles` turns on the title check for gh issues and pull
 * requests: the hook sets it in a repo with a yokoten.json, never in the user-level hook,
 * since another project's titles follow its own rules. `repos` are the repos whose file rules
 * the hook applies to an edit (see `judge`): a worker's shell write is checked against the
 * same ones, and against a repo with a yokoten.json it finds above the file.
 */
export function checkCommand(command: string, options: { env: Env; config?: GuardConfig; cwd?: string; titles?: boolean; repos?: RuledRepo[] }): Finding | null {
  // The reader is not a full parser. Whatever goes wrong inside it, the command is refused,
  // never let through: an error here must not open the guard.
  const outerAnswers = gitAnswers;
  try {
    gitAnswers = outerAnswers ?? new Map();
    // The file rules are looked up once per call, and only for a worker.
    const rules = options.env.YOKOTEN_ROLE === 'worker' ? fileRules(options.repos ?? []) : undefined;
    return withBudget(command.length, () => checkEachCommand(command, { ...options, cwd: options.cwd ?? process.cwd(), rules }));
  } catch {
    return finding('unreadable-command', 'yokoten could not read this command', 'split it into simpler commands, one per call');
  } finally {
    gitAnswers = outerAnswers;
  }
}

// `cwd` is null when the guard cannot tell which repo git works in.
type GuardConfig = Pick<Config, 'commands'> & Partial<Pick<Config, 'privacy' | 'areas'>>;

/** A repo whose file rules apply, by its root, with its yokoten.json "leadOnly". */
export type RuledRepo = { root: string; leadOnly: string[] };

type EachOptions = { env: Env; config?: GuardConfig; cwd: string | null; titles?: boolean; rules?: FileRules };

function checkEachCommand(command: string, { env, config, cwd, titles = false, rules }: EachOptions): Finding | null {
  const commands = commandWords(command);
  // Where a gh command reads a relative body file: the folder, followed through each cd.
  let postCwd = cwd;
  // A command that moves to another folder or repo (`cd x && git config ...`, GIT_DIR=)
  // may change the hooks setting of a repo the guard does not look at.
  if (commands.some(movesRepo)) cwd = null;
  for (const words of commands) {
    const reason =
      checkGit(words, { env, config, cwd, rules }) ??
      checkHooksEnvironment(words) ??
      checkPublish(words, env) ??
      checkBlocked(words, config?.commands.block ?? {}) ??
      checkPosted(words, { env, config, cwd: postCwd, command, titles }) ??
      (rules ? checkLeadOnlyWrites(words, { env, rules, folder: postCwd }) : null);
    if (reason) return reason;
    postCwd = folderAfter(words, postCwd, env);
  }
  return null;
}

/**
 * What a release refusal tells the agent to do. `start` is the command that starts the agent
 * with the approval, when the caller knows the agent (#350): the hook passes it in. Without
 * one, as here, the message names no agent.
 */
export function releaseFix(start?: string): string {
  const session = start ? `a new session with ${start}` : 'a new session of their agent with YOKOTEN_RELEASE_APPROVAL=1';
  return `if the owner asked for this, they start ${session}; do not look for another way`;
}
const release = (what: string) => finding('release', what, releaseFix());

const MOVERS = new Set(['cd', 'pushd', 'popd']);
function movesRepo(words: string[]): boolean {
  // The options of an env or sudo are read once: an env word among them (`-/env`) would
  // read the same options again, to the same end.
  const readTo = { env: 0, sudo: 0 };
  for (const [index, word] of words.entries()) {
    if (/^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/.test(word) || word === '--worktree') return true;
    const name = programName(word);
    if ((name !== 'env' && name !== 'sudo') || index < readTo[name]) continue;
    const moved = changesFolder(name, words, index + 1);
    if (moved === true) return true;
    readTo[name] = moved;
  }
  return findPrograms(words).some((program) => MOVERS.has(programName(program)));
}

// `env -C dir`, `env --chdir=dir` (or cut short, `--ch`), `env -iC dir`, `sudo -D dir`,
// `sudo --chdir=dir`: the launcher runs its program elsewhere. Returns true, or the index
// after the launcher's options.
function changesFolder(name: 'env' | 'sudo', words: string[], index: number): true | number {
  const short = name === 'env' ? /^-[a-zA-RT-Z]*C/ : /^-[a-zA-Z]*D/;
  for (; index < words.length && words[index].startsWith('-'); index += LAUNCHERS[name].options.includes(words[index]) ? 2 : 1) {
    const long = /^--(c[a-z]*)(?:=|$)/.exec(words[index]);
    if ((long && 'chdir'.startsWith(long[1])) || short.test(words[index])) return true;
    if (name === 'env' && splitString(words, index) !== undefined) return index;
  }
  return index;
}

const base = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
const isGit = (word: string) => /(^|[/\\])git(\.exe)?$/.test(word);
// Git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source']);

// Each check looks for its program anywhere in the command, so a prefix such as FOO=1,
// sudo, env, command, exec, time, nice, nohup, timeout or xargs does not hide it.
function checkGit(words: string[], { env, config, cwd, rules }: { env: Env; config?: Pick<Config, 'commands'>; cwd: string | null; rules?: FileRules }): Finding | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  const settings: string[] = [];
  const fromEnvironment: string[] = []; // --config-env name=VARIABLE
  // The folder git works in: `-C` moves it. With --git-dir or --work-tree, the guard
  // does not know the repo, so it is null.
  let directory: string | null = cwd;
  let i = start + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C' && directory !== null) directory = resolve(directory, words[i + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(words[i])) directory = null;
    if (words[i] === '-c') settings.push(words[i + 1] ?? '');
    if (words[i] === '--config-env') fromEnvironment.push(words[i + 1] ?? '');
    if (words[i].startsWith('--config-env=')) fromEnvironment.push(words[i].slice('--config-env='.length));
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const argsAt = i + 1;
  const args = words.slice(argsAt);

  const hooks = checkHooksSettings(settings, fromEnvironment);
  if (hooks) return hooks;
  if (settings.some((s) => /^push\.followtags/i.test(s)) && !env.YOKOTEN_RELEASE_APPROVAL) {
    return release('git -c push.followTags pushes tags');
  }
  // `git -c alias.x='!cmd' x` runs cmd through a shell.
  for (const s of settings) {
    const alias = /^alias\.[^=]*=!(.*)$/is.exec(s);
    const reason = alias && checkEachCommand(alias[1], { env, config, cwd, rules });
    if (reason) return reason;
  }
  if (sub === 'push') {
    if (!env.YOKOTEN_RELEASE_APPROVAL) {
      const tagFlag = args.find((a) => ['--tags', '--follow-tags', '--mirror'].includes(a));
      if (tagFlag) return release(`git push ${tagFlag} pushes tags`);
      const tagRef = args.find((a) => /(^|[:+])(refs\/tags\/|v\d)/.test(a));
      if (tagRef) return release(`git push ${tagRef} pushes a release tag`);
    }
    const force = args.find((a) => a === '--force' || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'));
    if (force) return finding('force-push', `git push ${force} forces the push`, 'use --force-with-lease, which stops when the remote has work you have not seen');
  }
  const skip = args.includes('--no-verify') ? '--no-verify' : sub === 'commit' ? args.find((a) => /^-[a-z]*n[a-z]*$/i.test(a)) : undefined;
  if (skip) return finding('skip-check', `git ${sub} ${skip} skips the commit check`, 'fix what the check reports instead');
  if (sub === 'config') return checkConfig(withoutShellRedirects(words, argsAt), directory);
  return null;
}

// ---- The hooks setting (#114) ----
//
// git runs the commit check from core.hooksPath. Reading the setting is fine. Any value
// but .githooks can turn the check off: for good with `git config`, or for one command with
// `git -c`, `--config-env` or GIT_CONFIG_KEY_n. Keys are case-insensitive, as in git.
// A value the guard cannot see (from a variable) blocks.
//
// `git config` in the repo's own config may also set the value already set, or a folder
// whose pre-commit runs `yokoten check` (#217): husky's `.husky/_`, or a folder
// `yokoten init` kept.

const HOOKS_DIR = '.githooks';
const HOOKS_FIX = 'leave it as it is; another folder is fine once its pre-commit runs `yokoten check` (`yokoten init` adds it there)';
const isHooksPath = (key: string) => key.trim().toLowerCase() === 'core.hookspath';
const hooksPath = (what: string, fix = HOOKS_FIX) => finding('hooks-path', what, fix);

// An include (`include.path`, `includeIf.<condition>.path`) reads another config file,
// which can set core.hooksPath without naming it (#358). Section and key are
// case-insensitive; the condition is not, and does not matter here.
const isInclude = (key: string) => /^include(if\..*)?\.path$/is.test(key.trim());
const includes = (what: string) =>
  hooksPath(`${what} reads another config file, which can set core.hooksPath and turn off the commit check`, 'set the setting you need by name, so the guard can check it');

// `git -c core.hooksPath=<value>` and `--config-env core.hooksPath=<VARIABLE>`.
function checkHooksSettings(settings: string[], fromEnvironment: string[]): Finding | null {
  if (fromEnvironment.some((s) => isHooksPath(s.split('=')[0]))) {
    return hooksPath('git --config-env core.hooksPath sets the hooks folder from a variable, which can skip the commit check');
  }
  const fromVariable = fromEnvironment.map((s) => s.split('=')[0]).find(isInclude);
  if (fromVariable) return includes(`git --config-env ${fromVariable}`);
  const include = settings.map((s) => s.split('=')[0]).find(isInclude);
  if (include) return includes(`git -c ${include}`);
  for (const setting of settings) {
    const equals = setting.indexOf('=');
    const key = equals === -1 ? setting : setting.slice(0, equals);
    if (isHooksPath(key) && (equals === -1 || setting.slice(equals + 1) !== HOOKS_DIR)) {
      return hooksPath('git -c core.hooksPath with a value other than .githooks skips the commit check for that command');
    }
  }
  return null;
}

// `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=x git commit` does
// what `git -c` does, and so does GIT_CONFIG_PARAMETERS, the variable `-c` itself sets.
// An assignment counts when it stands before the program, after env, sudo or export, or
// anywhere before a git word. So `grep GIT_CONFIG_KEY_0=core.hooksPath file` is a read.
const ASSIGNERS = new Set(['env', 'sudo', 'doas', 'export', 'declare', 'typeset', 'readonly', 'local']);
const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function checkHooksEnvironment(words: string[]): Finding | null {
  const lastGit = words.findLastIndex(isGit);
  let values: Map<string, string> | null = null; // GIT_CONFIG_VALUE_n, the first of each n
  let isPrefix = true; // every word before this one is an assignment, an option or an assigner
  for (const [index, word] of words.entries()) {
    const variable = /^GIT_CONFIG_(KEY_(\d+)|PARAMETERS)=(.*)$/is.exec(word);
    const wasPrefix = isPrefix;
    isPrefix = isPrefix && (isAssignment(word) || word.startsWith('-') || ASSIGNERS.has(base(word)));
    if (!variable) continue;
    if (!wasPrefix && lastGit <= index) continue;
    const [, name, number, setting] = variable;
    if (name.toUpperCase() === 'PARAMETERS') {
      if (setting.toLowerCase().includes('core.hookspath')) return hooksPath('GIT_CONFIG_PARAMETERS names core.hooksPath, which can skip the commit check');
      if (/include(if\.[^=]*)?\.path/i.test(setting)) return includes('GIT_CONFIG_PARAMETERS with an include');
      continue;
    }
    if (isInclude(setting)) return includes(`GIT_CONFIG_KEY_${number} ${setting.trim()}`);
    if (!isHooksPath(setting)) continue;
    values ??= configValues(words);
    if (values.get(number) !== HOOKS_DIR) {
      return hooksPath(`GIT_CONFIG_KEY_${number} names core.hooksPath with a value other than .githooks, which skips the commit check`);
    }
  }
  return null;
}

// Each GIT_CONFIG_VALUE_n=value in the words, by n as written: the first one counts.
function configValues(words: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const word of words) {
    const value = /^GIT_CONFIG_VALUE_(\d+)=(.*)$/is.exec(word);
    if (value && !values.has(value[1])) values.set(value[1], value[2]);
  }
  return values;
}

// A shell redirect is no argument to git: `git config core.hooksPath 2>/dev/null` reads
// the setting (#351). Only a redirect the reader saw with no quote in it is taken out, so
// `git config core.hooksPath '>x'` still sets the value ">x". Words that never went through
// the reader (an `env -S` string, the rough cut) have no marks, and keep every word.
const unquotedRedirects = new WeakMap<string[], Set<number>>();
// The word lists the reader made: in them, a redirect with no mark is quoted text.
const readWords = new WeakSet<string[]>();

// The words of `words` from `from` on, with each unquoted redirect and its file taken out.
function withoutShellRedirects(words: string[], from: number): string[] {
  const marks = unquotedRedirects.get(words);
  const kept: string[] = [];
  for (let index = from; index < words.length; ) {
    const length = marks?.has(index) ? redirectLength(words, index) : 0;
    if (length === 0) kept.push(words[index]);
    index += length || 1;
  }
  return kept;
}

// `git config` options that take the next word as their value.
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l', 'get', 'list']);
const CONFIG_REMOVES = new Set(['--unset', '--unset-all', 'unset']);
const CONFIG_EDITS = new Set(['--edit', '-e', 'edit']);
const CONFIG_SECTIONS = new Set(['--rename-section', '--remove-section', 'rename-section', 'remove-section']);
// git 2.46 and later also takes a subcommand: `git config get|list|set|unset|...`.
const CONFIG_SUBCOMMANDS = new Set(['get', 'list', 'set', 'unset', 'edit', 'rename-section', 'remove-section']);

// Every long option of `git config`, old form and subcommands, git 2.43 to 2.51.
const CONFIG_LONG_OPTIONS = [
  ...CONFIG_VALUE_OPTIONS, ...CONFIG_READS, ...CONFIG_REMOVES, ...CONFIG_EDITS, ...CONFIG_SECTIONS,
  '--global', '--system', '--local', '--worktree', '--replace-all', '--add', '--fixed-value', '--bool', '--int',
  '--bool-or-int', '--bool-or-str', '--path', '--expiry-date', '--null', '--name-only', '--includes',
  '--show-origin', '--show-scope', '--show-names', '--all', '--regexp', '--append',
].filter((option) => option.startsWith('--'));
// Short options that take a value: in `-fx` the rest of the word is the value.
const CONFIG_SHORT_VALUES = 'ft';

// An option as git reads it (#358). git takes a long option by any start of its name
// (`--ed` is --edit); a start several options share is each of them, since git refuses
// it anyway. Short options join (`-ef x` is `-e -f x`). `takesNext`: the next word is a value.
function readConfigOption(word: string): { names: string[]; takesNext: boolean } {
  if (word.startsWith('--')) {
    const [name, ...value] = word.split('=');
    const exact = CONFIG_LONG_OPTIONS.includes(name);
    const matches = exact ? [name] : CONFIG_LONG_OPTIONS.filter((option) => option.startsWith(name));
    const names = matches.length > 0 ? matches : [name];
    return { names: value.length > 0 ? names.map((n) => `${n}=${value.join('=')}`) : names, takesNext: value.length === 0 && names.some((n) => CONFIG_VALUE_OPTIONS.has(n)) };
  }
  const names: string[] = [];
  for (const [index, letter] of [...word.slice(1)].entries()) {
    names.push(`-${letter}`);
    if (CONFIG_SHORT_VALUES.includes(letter)) return { names, takesNext: index === word.length - 2 };
  }
  return { names, takesNext: false };
}

// Splits `git config` arguments into options and plain words. The old form (`isOldForm`)
// reads options only before the first plain word: `git config core.hooksPath --local`
// sets the value "--local". The subcommand form reads options anywhere.
function splitConfig(args: string[], isOldForm: boolean): { options: string[]; plain: string[] } {
  const options: string[] = [];
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((isOldForm && plain.length > 0) || !args[i].startsWith('-') || args[i] === '-') plain.push(args[i]);
    else if (args[i] === '--') {
      plain.push(...args.slice(i + 1));
      break;
    } else {
      const { names, takesNext } = readConfigOption(args[i]);
      options.push(...names);
      if (takesNext) i++;
    }
  }
  return { options, plain };
}

// `git config`: a read passes; a change to core.hooksPath passes only to .githooks, or as
// checkHooksFolder allows. `directory` is the folder git works in, or null when unknown.
function checkConfig(args: string[], directory: string | null): Finding | null {
  let { options, plain } = splitConfig(args, true);
  const subcommand = CONFIG_SUBCOMMANDS.has(plain[0]) ? plain[0] : undefined;
  if (subcommand) {
    const rest = splitConfig(plain.slice(1), false);
    options = [...options, ...rest.options];
    plain = rest.plain;
  }
  const actions = subcommand ? [subcommand] : options;
  // An editor can change any setting, core.hooksPath too, and the guard cannot see what
  // it writes: `GIT_EDITOR="sed -i ..." git config --edit` (#358). In any scope.
  const edit = actions.find((a) => CONFIG_EDITS.has(a));
  if (edit) {
    return hooksPath(
      `git config ${edit} opens a config file in an editor, which can change core.hooksPath and turn off the commit check`,
      'read a setting with `git config --get <key>`, and change one by name (`git config <key> <value>`), so the guard can check it',
    );
  }
  const section = actions.find((a) => CONFIG_SECTIONS.has(a));
  if (section) {
    if (plain.some((w) => w.toLowerCase() === 'core')) return hooksPath(`git config ${section} core changes core.hooksPath, which turns off the commit check`);
    // `--rename-section x include` makes the settings of x an include.
    const include = plain.slice(1).find((w) => isInclude(`${w}.path`));
    return include ? includes(`git config ${section} to ${include}`) : null;
  }
  const key = plain[0] ?? '';
  if (!isHooksPath(key) && !isInclude(key)) return null;
  const remove = actions.find((a) => CONFIG_REMOVES.has(a));
  if (remove) return isInclude(key) ? null : hooksPath(`git config ${remove} core.hooksPath turns off the commit check`);
  if (actions.some((a) => CONFIG_READS.has(a))) return null;
  // A set: `git config <key> <value>`, --add, --replace-all or `git config set`.
  // With no value and no action, it is a read.
  const value = plain[1];
  const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
  if (value === undefined && !isSet) return null;
  if (isInclude(key)) return includes(`git config ${key}`);
  if (value === HOOKS_DIR) return null;
  if (value === undefined) return hooksPath('git config set core.hooksPath with no value turns off the commit check');
  return checkHooksFolder(value, options, directory);
}

// Config that is not this repo's own: a change there reaches other repos, or none.
// --worktree writes the config of the worktree git works in, which may not be this one.
const OTHER_SCOPES = new Set(['--global', '--system', '-f', '--file', '--blob', '--worktree']);

// A new core.hooksPath in the repo's own config passes when it is the value already set,
// or when git runs the folder's pre-commit (an executable file whose first line names sh,
// bash, dash or zsh) and the script runs `yokoten check` (for husky, .husky/pre-commit).
function checkHooksFolder(value: string, options: string[], directory: string | null): Finding | null {
  const scope = options.find((o) => OTHER_SCOPES.has(o.split('=')[0]));
  if (scope) return hooksPath(`git config ${scope} core.hooksPath changes the hooks folder outside this repo's own config, which can turn off the commit check`);
  // git expands these, and the guard does not: it cannot tell which folder they name.
  if (value.startsWith('~') || value.startsWith('%(')) return hooksPath(`core.hooksPath ${value} names a folder git expands, which the guard cannot check`);
  const root = directory === null ? null : readGit(directory, ['rev-parse', '--show-toplevel']);
  if (root === null) return hooksPath('changing core.hooksPath where the guard cannot find the repo can turn off the commit check');
  if (readGit(root, ['config', '--get', 'core.hooksPath']) === value) return null;
  const file = hookFile(root, value);
  if (file === null) return hooksPath(`core.hooksPath ${value} is outside this repo, so the commit check does not run`);
  // git runs the folder's own pre-commit only when it is an executable file; husky's
  // `.husky/_/pre-commit` then runs `.husky/pre-commit`, with `sh -e`.
  const folder = hooksFolder(root, value);
  const runs = `${folder}/pre-commit`.replace(/^\//, '');
  const notRun = hookNotRun(join(root, runs));
  if (notRun) return hooksPath(`core.hooksPath ${value} turns off the commit check: git does not run ${runs}, ${notRun}`, `make ${runs} an executable shell script (\`yokoten init\` sets it up), then set core.hooksPath again`);
  const isHusky = folder === '.husky/_';
  const notHusky = isHusky ? notHuskys(root) : null;
  if (notHusky) return hooksPath(`core.hooksPath ${value} may not run the commit check: ${notHusky}`, 'run `npx husky` to write husky\'s own files, then set core.hooksPath again');
  if (runsCheck(readText(join(root, file)), isHusky)) return null;
  return hooksPath(`core.hooksPath ${value} turns off the commit check: ${file} does not run \`yokoten check\``, `add \`yokoten check\` to ${file} (\`yokoten init\` adds it), then set core.hooksPath again`);
}

// The shells a hook may name on its first line, directly or through /usr/bin/env (also
// `env -S`). A file with no #! line git runs with sh.
const SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s*)?|\/(?:[\w.+-]+\/)*)(?:sh|bash|dash|zsh)(?:[ \t].*)?$/;

// Why git would not run the hook file at `path` as a shell script, or null when it would.
function hookNotRun(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return 'which is not a file';
  } catch {
    return 'which does not exist';
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return 'which is not executable';
    }
  }
  const first = readText(path).split(/\r?\n/, 1)[0];
  return !first.startsWith('#!') || SHEBANG.test(first) ? null : 'whose first line does not name sh, bash, dash or zsh';
}

// husky 9's own files in `.husky/_`: each hook sources `h` from its folder, and `h` runs
// `.husky/<hook>` with `sh -e` (or sources it after `set -e`) and fails when it fails.
// Any other `.husky/_/pre-commit` or `h` may not run `.husky/pre-commit` at all.
const HUSKY_HOOK = new Set(['. "${0%/*}/h"', '. "$(dirname "$0")/h"']);
// The sha256 of each `h` husky 9.0.1 to 9.1.7 writes, without its comments, blank lines and indents.
const HUSKY_H = new Set([
  'b4b605f02218e49f92d437c0a447422cf962979c9805ec0722fd73bb12fc14ca', // 9.0.1
  '4cfec33fb6483d59ef799858e8ae5df0dfc98454ea386145c8382024076e9566', // 9.0.2 to 9.0.5
  '0ee76fc9c7a5dbce7cede4a7c6d99683c5e817164d5d86366541f008577daaa1', // 9.0.6
  '60898241f581d3f63d82dc61e43edbebcce35969496d446eadc3fba0854963ad', // 9.0.7 to 9.0.10
  '38db74aaa760471c57f52d64b89894a2a66098045068776c01fdde3518cdf8fb', // 9.0.11
  '035106e41eb342267fe34024d2aaebf81588523b28d46714283a273f62abdfa5', // 9.1.0 and 9.1.1
  'b4d32bb43592bfdc3a4077f47985f69777539e69ed16907148044b1d2b54f6ea', // 9.1.2
  '237b908c80bcad80439474bb49def6559697dbabee6cb2d6f6c969f354886d81', // 9.1.3 to 9.1.7
]);
const shellLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

// Why `.husky/_` in `root` is not husky's own, or null when it is.
function notHuskys(root: string): string | null {
  const hook = shellLines(readText(join(root, '.husky', '_', 'pre-commit')));
  if (hook.length !== 1 || !HUSKY_HOOK.has(hook[0])) return '.husky/_/pre-commit is not the one husky writes';
  const h = shellLines(readText(join(root, '.husky', '_', 'h'))).join('\n');
  if (!HUSKY_H.has(createHash('sha256').update(h).digest('hex'))) return '.husky/_/h is missing, or is not the one a husky 9 release writes';
  return null;
}

/**
 * The pre-commit file git runs for this core.hooksPath, relative to the repo root, or null
 * when the folder is outside the repo. husky's folder (`.husky/_`, or `.husky` before
 * husky 9) runs `.husky/pre-commit`. Any other folder runs its own pre-commit.
 */
export function hookFile(root: string, setting: string): string | null {
  const folder = hooksFolder(root, setting);
  if (folder === null) return null;
  if (folder === '.husky' || folder === '.husky/_') return '.husky/pre-commit';
  return folder ? `${folder}/pre-commit` : 'pre-commit';
}

// The hooks folder, relative to the repo root ('' for the root), or null when outside it.
function hooksFolder(root: string, setting: string): string | null {
  const folder = relative(root, resolve(root, setting)).split('\\').join('/');
  return folder === '..' || folder.startsWith('../') || isAbsolute(folder) ? null : folder;
}

// A line that runs the check and stops the commit when it fails, in the shapes yokoten
// writes or knows: `exec node "bin/yokoten.ts" check --staged`, `npx yokoten check || exit 1`,
// `pnpm exec yokoten check`, `npx lint-staged && npx yokoten check`, and the guarded form
// `[ -f <cli> ] || { echo '...' >&2; exit 1; }; node <cli> check` (with `2>/dev/null` after
// the `]`, as `yokoten init` writes it).
//
// The program is yokoten itself: `yokoten`, `yokoten.ts` or `yokoten.mjs` (#408), bare or quoted, or under
// node_modules/.bin, bin/ or .yokoten/. `./fake-yokoten` is some other program. The check
// takes only --staged and --json (`check --pr` reads a pull request, not the commit). After
// it comes nothing, a `;`, or `|| exit` with no code, a code not 0, or `$?`.
const CLI = String.raw`(?:yokoten(?:\.ts|\.mjs)?|(?:\./)?(?:node_modules/\.bin/yokoten|bin/yokoten(?:\.ts|\.mjs)?|\.yokoten/(?:bin/)?yokoten(?:\.ts|\.mjs)?))`;
const PROGRAM = String.raw`(?:"${CLI}"|'${CLI}'|${CLI})`;
const RUNNER = String.raw`(?:(?:npx(?:\s+--no-install|\s+--no(?:\s+--)?)?|pnpm\s+exec|yarn|bunx)\s+)?(?:node\s+)?`;
const CHECK_TAIL = String.raw`\s+check(?:\s+--(?:staged|json))*(?<stop>\s*\|\|\s*exit(?:\s+(?:[1-9]\d*|\$\?))?)?(?:\s*;)?$`;
// Commands before the check with `&&`: they cannot end the script (no exit, exec, source).
const NOT_BEFORE = String.raw`(?!(?:exit|return|exec|eval|source|trap|kill|set|shift|break|continue|alias|unset|builtin|command|\.)(?:\s|$))`;
const BEFORE = String.raw`(?<before>(?:${NOT_BEFORE}[\w./@:=+-]+(?:\s+[\w./@:=+-]+)*\s*&&\s*)+)?`;
const CHECK_LINE = new RegExp(String.raw`^${BEFORE}(?<exec>exec\s+)?${RUNNER}${PROGRAM}${CHECK_TAIL}`);
const GUARDED_LINE = new RegExp(String.raw`^\[ -f (?<cli>${PROGRAM}) \](?: 2>/dev/null)? \|\| \{ echo '[^']*'(?: >&2)?; exit [1-9]\d*; \}; node \k<cli>${CHECK_TAIL}`);
// Shell words that open and close a block: a line inside one may never run.
const OPENERS = new Set(['if', 'while', 'until', 'for', 'case', 'select']);
const CLOSERS = new Set(['fi', 'done', 'esac']);

/**
 * This pre-commit script runs `yokoten check` and fails the commit when the check fails:
 * a line in one of the shapes above, at the top level (not inside an `if`, a loop, a group,
 * a quote, a heredoc, or after `||`, `&&` or `|` on the line before), with no `exit` or
 * `return` (but `exit 1`), `exec` or heredoc before it. A line with no `exec` and no
 * `|| exit` is the last command, or follows `set -e` (and no `set +e`). `startsStrict`:
 * the script runs with `sh -e`, as husky 9 runs `.husky/pre-commit`.
 */
export function runsCheck(script: string, startsStrict = false): boolean {
  return withBudget(
    script.length,
    () => {
      const lines = scriptLines(script);
      let depth = 0;
      let isStrict = startsStrict; // set -e: a failed command stops the script
      for (const [index, line] of lines.entries()) {
        const shape = CHECK_LINE.exec(line) ?? GUARDED_LINE.exec(line);
        if (shape && depth === 0) {
          const { before, exec, stop } = shape.groups ?? {};
          const isLast = index === lines.length - 1;
          // After `a &&`, a failed `a` skips the check: exec and set -e do not help.
          if (stop !== undefined || isLast || (before === undefined && (exec !== undefined || isStrict))) return true;
        }
        if (leaves(line)) return false;
        if (/(?:^|[;&|({]\s*)set\s+(?:\+[a-zA-Z]*e|\+o\s+errexit)/.test(line)) isStrict = false;
        else if (depth === 0 && /^set\s+(?:-[a-zA-Z]*e|-o\s+errexit)/.test(line)) isStrict = true;
        depth += blockDepth(line);
        if (depth < 0) return false;
      }
      return false;
    },
    true,
  );
}

// Whether a line may end the script, or hand it to a heredoc, before a later line runs.
// `exit 1` and `|| exit $?` stop the commit, so they do not count.
function leaves(line: string): boolean {
  if (line.includes('<<')) return true;
  const rest = line.replace(/\|\|\s*(?:exit|return)\s+\$\?/g, '').replace(/(?<![\w.-])(?:exit|return)\s+[1-9]\d*(?![\w$])/g, '');
  return /(?<![\w.-])(?:exec|exit|return)(?![\w.-])/.test(rest);
}

// The script's command lines, as the shell reads them: a \ before a line end joins the
// lines, a quote stays open across lines, a comment is dropped, and a line after one that
// ends in `||`, `&&` or `|` belongs to it. Blank lines are left out.
function scriptLines(script: string): string[] {
  const lines: string[] = [];
  let goesOn = false; // the last line ends in ||, && or | (or |&), so the next one joins it
  const add = (text: string) => {
    const line = text.trim();
    if (line === '') return;
    if (goesOn) lines[lines.length - 1] += ` ${line}`;
    else lines.push(line);
    goesOn = line.endsWith('|') || line.endsWith('&&') || line.endsWith('|&');
  };
  let line = '';
  let quote = ''; // the open quote: ', " or $'
  for (let at = 0; at < script.length; at++) {
    spend(1);
    const character = script[at];
    const next = script[at + 1] ?? '';
    if (quote === "'") {
      line += character;
      if (character === "'") quote = '';
    } else if (character === '\\' && (next === '\n' || (next === '\r' && script[at + 2] === '\n')) && quote !== "$'") {
      at += next === '\r' ? 2 : 1; // the line goes on
    } else if (character === '\\') {
      line += character + next;
      at++;
    } else if (quote) {
      line += character;
      if ((quote === '"' && character === '"') || (quote === "$'" && character === "'")) quote = '';
    } else if (character === "'" || character === '"') {
      quote = character;
      line += character;
    } else if (character === '$' && next === "'") {
      quote = "$'";
      line += "$'";
      at++;
    } else if (character === '#' && /^$|[\s;&|()]$/.test(line.slice(-1))) {
      while (at + 1 < script.length && script[at + 1] !== '\n') at++;
    } else if (character === '\n') {
      add(line);
      line = '';
    } else line += character;
  }
  add(line);
  return lines;
}

// How many blocks a line opens, less those it closes: keywords that lead a command, and
// ( and { and their closers outside quotes, ${...} and $(...).
function blockDepth(line: string): number {
  let depth = 0;
  for (const words of commandWords(line)) {
    for (const word of words) {
      if (OPENERS.has(word)) depth++;
      else if (CLOSERS.has(word)) depth--;
      else if (!KEYWORDS.has(word)) break;
    }
  }
  for (const character of withoutSubstitutions(withoutQuotes(line))) {
    if (character === '(' || character === '{') depth++;
    else if (character === ')' || character === '}') depth--;
  }
  return depth;
}

// The line without its '...' and "..." strings (a " string takes \ escapes). An unclosed
// quote stays as it is. Once a quote finds no end, no later one of its kind does, so each
// kind is looked for to the end of the line at most once.
function withoutQuotes(line: string): string {
  let out = '';
  const closes = new Set(["'", '"']); // the kinds that may still close
  for (let at = 0; at < line.length; at++) {
    const character = line[at];
    const end = closes.has(character) ? closeQuote(line, at) : -1;
    if (end !== -1) at = end;
    else {
      closes.delete(character);
      out += character;
    }
  }
  return out;
}

// The index of the quote that closes the one at `at`, or -1.
function closeQuote(line: string, at: number): number {
  if (line[at] === "'") return line.indexOf("'", at + 1);
  for (let i = at + 1; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') return i;
  }
  return -1;
}

// The text without ${...} and $(...) (also $((...)) and more parens): from the opener to the
// first } or ), with the run of ) after it. An opener with no closer after it stays, and
// then no later opener of its kind has one either.
function withoutSubstitutions(text: string): string {
  let out = '';
  const closes = new Set(['}', ')']); // the closers still found further on
  for (let at = 0; at < text.length; at++) {
    const closer = text[at] !== '$' ? '' : text[at + 1] === '{' ? '}' : text[at + 1] === '(' ? ')' : '';
    const end = closes.has(closer) ? text.indexOf(closer, at + 2) : -1;
    if (end === -1) {
      closes.delete(closer);
      out += text[at];
      continue;
    }
    at = end;
    if (closer === ')') while (text[at + 1] === ')') at++;
  }
  return out;
}

// What git prints, trimmed, or null when it fails. Within one checkCommand each question
// goes to git once: a command that sets core.hooksPath many times starts git twice, not
// twice for each.
let gitAnswers: Map<string, string | null> | null = null;

function readGit(directory: string, args: string[]): string | null {
  const key = [directory, ...args].join('\0');
  if (gitAnswers?.has(key)) return gitAnswers.get(key) ?? null;
  let answer: string | null;
  try {
    answer = execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    answer = null;
  }
  gitAnswers?.set(key, answer);
  return answer;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// A word anywhere after the program counts, so an option in between (`npm --tag x publish`)
// does not hide it. `npm run publish` blocks too: the script may well publish.
function checkPublish(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_RELEASE_APPROVAL) return null;
  const after = (names: string[]) => {
    const i = words.findIndex((w) => names.includes(base(w).replace(/\.(exe|cmd)$/i, '')));
    return i === -1 ? [] : words.slice(i + 1);
  };
  const gh = after(['gh']);
  const sub = gh.indexOf('release');
  if (sub !== -1 && gh.slice(sub + 1).some((a) => ['create', 'upload', 'edit'].includes(a))) return release('gh release publishes a release');
  if (after(['npm', 'pnpm', 'yarn']).includes('publish')) return release('this publishes a package');
  return null;
}

// What a gh command posts (#391). The title of an issue or a pull request gets the title
// check `yokoten bot` runs, so plain gh can't open one CI then fails. Then the text (an
// issue, a pull request, a comment, a release note) gets the privacy check: see privacy.ts.
// The privacy check comes first: a title is checked by it too, and a leak matters more.
function checkPosted(
  words: string[],
  { env, config, cwd, command, titles }: { env: Env; config?: Partial<Pick<Config, 'privacy' | 'areas'>>; cwd: string | null; command: string; titles: boolean },
): Finding | null {
  const at = ghIndex(words, findPrograms(words));
  if (at === -1) return null;
  const gh = ghCommand(words, at);
  const leak = checkPost(gh, { env, privacy: config?.privacy, cwd, command });
  if (leak || !titles) return leak;
  const [title] = checkCommandTitle([words[at], ...gh.args], config ?? {});
  return title ?? null;
}

// The words after gh without the shell's redirects, and what a `< file` or a `<<<` feeds
// to its stdin. Only an unquoted `<` counts: `--body "<"` is text. The reader does not mark
// a here-string, so any `<<<` counts: read wrongly, it only adds text to scan.
function ghCommand(words: string[], at: number): GhCommand {
  const marks = unquotedRedirects.get(words);
  const gh: GhCommand = { args: withoutShellRedirects(words, at + 1) };
  for (let index = at + 1; index < words.length; index++) {
    if (!marks?.has(index) && !words[index].startsWith('<<<')) continue;
    const redirect = /^0?(<<<|<)(?![<>&])(.*)$/s.exec(words[index]);
    if (!redirect) continue;
    const target = redirect[2] || words[index + 1];
    if (target === undefined) continue;
    if (redirect[1] === '<<<') gh.hereString = target;
    else gh.stdinFile = target;
  }
  return gh;
}

// The folder after a `cd` or `pushd` with a plain path, or null when the guard can't tell:
// a variable, a substitution, `cd -` or `popd`. Any other command leaves it as it was.
function folderAfter(words: string[], folder: string | null, env: Env): string | null {
  const name = programName(words[0] ?? '');
  if (name === 'popd') return null;
  if (name !== 'cd' && name !== 'pushd') return folder;
  const target = words.slice(1).find((word) => !/^-[LPe@]+$/.test(word));
  if (target === undefined) return env.HOME ?? null;
  if (target === '-' || /[$`*?[]/.test(target) || /^~[^/]/.test(target)) return null;
  const path = target.startsWith('~') ? (env.HOME ? join(env.HOME, target.slice(1)) : null) : target;
  if (path === null) return null;
  if (isAbsolute(path)) return path;
  return folder === null ? null : resolve(folder, path);
}

// ---- Lead-only files a worker's command writes (#402) ----
//
// The edit guard stops a worker's edit tool on a lead-only file. A shell write gets the
// same answer here: a redirect (`>`, `>>`, `&>`, `<>`, `>&file`), the files of the common
// writers in WRITERS, git's own writes (checkout, restore, rm, mv, apply), and the files
// a `git commit` would commit. A read (`cat`, `grep`, `sed -n`) writes nothing and passes.
// The commit check refuses the same commit only when the session has YOKOTEN_ROLE=worker,
// so for a subagent named worker the guard is what stops it. Like the rest of the guard
// it reads text: a target from a variable or stdin (`xargs rm`, `find -exec ... {}`,
// `git apply < x.patch`), or a script's own writes, gets past it.
//
// The rules apply where the edit guard's do: in the repos the hook rules (`judge`), and in
// a repo with a yokoten.json above the file. A worker in any other repo is not stopped.

/**
 * A file a command writes, as written, and the folder it is relative to (null: unknown).
 * `isUnread`: the path is a patch whose files the guard could not read, so what it writes
 * is unknown.
 */
type WriteTarget = { path: string; from: string | null; isUnread?: boolean };

/** The largest patch the guard reads for the files it names. */
const PATCH_LIMIT = 1 << 20;

// A redirect that writes its file. `>&2` copies a stream; `>&file` writes a file.
const WRITE_REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(>>|>\||<>|>&|>)(.*)$/s;

function checkLeadOnlyWrites(words: string[], { env, rules, folder }: { env: Env; rules: FileRules; folder: string | null }): Finding | null {
  // A folder counts when a lead-only file may be in it: `rm -r .github`.
  const stopped = (target: WriteTarget): string | null => {
    const ruled = rules.ruled(target, env);
    if (!ruled) return null;
    const matches = (path: string) => isLeadOnly(path, ruled.leadOnly);
    return (matches(ruled.path) || matches(`${ruled.path}/-`)) && !isGranted(ruled.path, env) ? ruled.path : null;
  };
  for (const target of writeTargets(words, folder, rules.rootOf)) {
    if (target.isUnread) {
      if (target.from !== null && rules.isRuled(target.from)) {
        return finding('lead-only', `this command applies ${base(target.path)}, and yokoten can't read which files it changes`, `apply a patch file under 1 MB, so the guard can read it, or ${LEAD_ONLY_FIX}`);
      }
      continue;
    }
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this command writes ${path}, which is lead-only (yokoten.json "leadOnly")`, LEAD_ONLY_FIX);
  }
  for (const target of commitTargets(words, folder, rules.rootOf)) {
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this commit changes ${path}, which is lead-only (yokoten.json "leadOnly")`, `unstage it with \`git restore --staged ${path}\`, then ${LEAD_ONLY_FIX}`);
  }
  return null;
}

/**
 * The real path, through symlinks. git reports the repo root's real path, and a tool may
 * send a path through a symlink (on macOS, /var is /private/var). A file that does not
 * exist yet takes the real path of its nearest existing folder.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(realPath(parent), basename(path));
  }
}

/**
 * `ruled`: a target's path from its repo's root, and that repo's lead-only list; null when
 * no file rules apply. `rootOf`: the git root at or above a folder, from the same walks.
 */
type FileRules = {
  ruled: (target: WriteTarget, env: Env) => { path: string; leadOnly: string[] } | null;
  rootOf: (folder: string) => string | null;
  isRuled: (folder: string) => boolean;
};

/**
 * The file rules for one guard call. A file takes the deepest of `repos` that holds it, as
 * in `judge`; with the folder unknown, a relative path is taken as written, in the first
 * (the session's repo). A file outside them all takes the repo above it, found by one walk
 * up to its `.git`, when that repo has a yokoten.json. Walks and configs are kept for the
 * call, so a second file in the same folders reads nothing again.
 */
function fileRules(repos: RuledRepo[]): FileRules {
  const rootAbove = new Map<string, string | null>(); // folder → the git root above it
  const leadOnlyAt = new Map<string, string[] | null>(); // git root → its list, null without yokoten.json
  const rootOf = (folder: string) => gitRootAbove(folder, rootAbove);
  // Roots and files are compared by real path, as for an edit: a symlink to AGENTS.md is
  // AGENTS.md, and on macOS /var is /private/var. The roots are read once, on first use.
  let realRepos: RuledRepo[] | null = null;
  const ruled: FileRules['ruled'] = ({ path, from }, env) => {
    if (path === '' || path === '-') return null;
    const expanded = /^~(?=\/|$)/.test(path) && env.HOME ? join(env.HOME, path.slice(1)) : path;
    if (from === null && !isAbsolute(expanded)) {
      return repos.length ? { path: expanded.replace(/\\/g, '/').replace(/^(\.\/)+/, ''), leadOnly: repos[0].leadOnly } : null;
    }
    const full = realPath(resolve(from ?? '/', expanded));
    realRepos ??= repos.map((repo) => ({ ...repo, root: realPath(repo.root) }));
    let best: { path: string; leadOnly: string[] } | null = null;
    for (const repo of realRepos) {
      const inRepo = relative(repo.root, full);
      if (inRepo === '' || inRepo.startsWith('..') || isAbsolute(inRepo)) continue;
      if (!best || inRepo.length < best.path.length) best = { path: inRepo, leadOnly: repo.leadOnly };
    }
    if (best) return { ...best, path: best.path.split(sep).join('/') };
    const root = rootOf(dirname(full));
    if (root === null) return null;
    if (!leadOnlyAt.has(root)) leadOnlyAt.set(root, existsSync(join(root, 'yokoten.json')) ? loadConfig(root, { onProblem: () => {} }).leadOnly : null);
    const leadOnly = leadOnlyAt.get(root);
    return leadOnly ? { path: relative(root, full).split(sep).join('/'), leadOnly } : null;
  };
  // A folder is ruled when a file in it would be: `.git` stands for any file there.
  const isRuled = (folder: string) => ruled({ path: join(folder, '.git'), from: null }, {}) !== null;
  return { ruled, rootOf, isRuled };
}

// The nearest folder at or above `folder` with a `.git`. Each folder walked is kept, so a
// later walk stops where an earlier one passed.
function gitRootAbove(folder: string, known: Map<string, string | null>): string | null {
  const walked: string[] = [];
  let found: string | null = null;
  for (let dir = folder; ; dir = dirname(dir)) {
    if (known.has(dir)) {
      found = known.get(dir) ?? null;
      break;
    }
    walked.push(dir);
    if (existsSync(join(dir, '.git'))) {
      found = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  for (const dir of walked) known.set(dir, found);
  return found;
}

function writeTargets(words: string[], folder: string | null, rootOf: FileRules['rootOf']): WriteTarget[] {
  const targets: WriteTarget[] = [];
  const marks = unquotedRedirects.get(words);
  for (const [index, word] of words.entries()) {
    // Words the reader did not make (the rough cut) have no marks: any redirect counts.
    if (readWords.has(words) ? !marks?.has(index) : !REDIRECT.test(word)) continue;
    const redirect = WRITE_REDIRECT.exec(word);
    const path = redirect && (redirect[2] || words[index + 1]);
    if (!path || (redirect[1] === '>&' && /^(\d+|-)$/.test(path))) continue;
    targets.push({ path, from: folder });
  }
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue; // from an `env -S` string
    from = at + 1;
    const name = programName(program);
    const args = withoutShellRedirects(words, at + 1);
    if (isGit(program)) targets.push(...gitWrites(args, folder, rootOf));
    else if (Object.hasOwn(WRITERS, name)) targets.push(...WRITERS[name](args, folder).map((path) => ({ path, from: folder })));
  }
  return targets;
}

/**
 * The words that are no option, in order: after `--` every word is one. `valued` are the
 * options whose value is the next word.
 */
function plainArgs(args: string[], valued: string[] = []): string[] {
  const plain: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') return [...plain, ...args.slice(index + 1)];
    if (valued.includes(word)) index++;
    else if (!word.startsWith('-') || word === '-') plain.push(word);
  }
  return plain;
}

/** The value of the first of `names` in `args`: `-t x`, `-tx`, `--target-directory=x`. */
function optionValue(args: string[], names: string[]): string | undefined {
  for (const [index, word] of args.entries()) {
    for (const name of names) {
      if (word === name) return args[index + 1];
      if (name.startsWith('--') ? word.startsWith(`${name}=`) : word.startsWith(name) && word.length > 2) return word.slice(name.length + (name.startsWith('--') ? 1 : 0));
    }
  }
  return undefined;
}

// cp, mv, install and ln write their destination, and each source's name inside it when
// it is a folder: named by -t, ending in /, given more than one source, or one on disk.
// mv also removes its sources.
function copyTargets(args: string[], { valued, isMove, folder }: { valued: string[]; isMove: boolean; folder: string | null }): string[] {
  const plain = plainArgs(args, valued);
  const named = optionValue(args, ['-t', '--target-directory']);
  const sources = named === undefined ? plain.slice(0, -1) : plain;
  const into = named ?? plain.at(-1);
  if (into === undefined) return [];
  const isFolder = named !== undefined || into.endsWith('/') || sources.length > 1 || isFolderOnDisk(folder, into);
  return [...(isMove ? sources : []), into, ...(isFolder ? sources.map((source) => `${into}/${base(source)}`) : [])];
}

function isFolderOnDisk(folder: string | null, path: string): boolean {
  try {
    return statSync(resolve(folder ?? '.', path)).isDirectory();
  } catch {
    return false;
  }
}

// `sed -i`: the files after the script. A short option cluster ends at `i` (its suffix
// follows) or at e, f or l (their value follows).
function sedTargets(args: string[]): string[] {
  let isInPlace = false;
  let hasScript = false;
  const plain: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      plain.push(...args.slice(index + 1));
      break;
    }
    if (word.startsWith('--')) {
      if (/^--in-place(=|$)/.test(word)) isInPlace = true;
      if (/^--(expression|file)(=|$)/.test(word)) hasScript = true;
      if (/^--(expression|file|line-length)$/.test(word)) index++;
    } else if (word.startsWith('-') && word !== '-') {
      for (const [at, letter] of [...word].entries()) {
        if (at === 0) continue;
        if (letter === 'i') isInPlace = true;
        if (letter === 'e' || letter === 'f') hasScript = true;
        if ('efl'.includes(letter) && at === word.length - 1) index++;
        if ('iefl'.includes(letter)) break;
      }
    } else plain.push(word);
  }
  if (!isInPlace) return [];
  return hasScript ? plain : plain.slice(1);
}

// `perl -i` (`-pi`, `-i.bak`): the files after the script. Options end at the first plain
// word. In a cluster, e and E take the next word; I, M, m, F, C, x, d, D, l and 0 take
// the rest of the word.
function perlTargets(args: string[]): string[] {
  let isInPlace = false;
  let hasScript = false;
  let index = 0;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      index++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    for (const [at, letter] of [...word].entries()) {
      if (at === 0) continue;
      if (letter === 'i') isInPlace = true;
      if (letter === 'e' || letter === 'E') {
        hasScript = true;
        if (at === word.length - 1) index++;
      }
      if ('ieEIMmFCxdDl0'.includes(letter)) break;
    }
  }
  if (!isInPlace) return [];
  return hasScript ? args.slice(index) : args.slice(index + 1);
}

const COPY_VALUES = ['-t', '--target-directory', '-S', '--suffix'];
// Each writer by name, with the files it writes. Every other program is a read here.
const WRITERS: Record<string, (args: string[], folder: string | null) => string[]> = {
  tee: (args) => plainArgs(args),
  truncate: (args) => plainArgs(args, ['-s', '--size', '-r', '--reference']),
  rm: (args) => plainArgs(args),
  rmdir: (args) => plainArgs(args),
  unlink: (args) => plainArgs(args),
  shred: (args) => plainArgs(args, ['-n', '--iterations', '-s', '--size']),
  sed: sedTargets,
  perl: perlTargets,
  cp: (args, folder) => copyTargets(args, { valued: COPY_VALUES, isMove: false, folder }),
  ln: (args, folder) => copyTargets(args, { valued: COPY_VALUES, isMove: false, folder }),
  mv: (args, folder) => copyTargets(args, { valued: COPY_VALUES, isMove: true, folder }),
  install: (args, folder) => copyTargets(args, { valued: [...COPY_VALUES, '-m', '--mode', '-o', '--owner', '-g', '--group', '--strip-program'], isMove: false, folder }),
  dd: (args) => args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice('of='.length)),
};

/** git's subcommand, its arguments and the folder it works in (null: unknown), from the git word on. */
function gitParts(args: string[], folder: string | null): { sub: string | undefined; args: string[]; dir: string | null } {
  let dir = folder;
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '-C') dir = dir === null ? null : resolve(dir, args[index + 1] ?? '');
    if (/^--(git-dir|work-tree)(=|$)/.test(args[index])) dir = null;
    index += GIT_VALUE_OPTIONS.has(args[index]) ? 2 : 1;
  }
  return { sub: args[index], args: args.slice(index + 1), dir };
}

// git's own writes to files in the work tree. A patch's files are read from the patch.
function gitWrites(words: string[], folder: string | null, rootOf: FileRules['rootOf']): WriteTarget[] {
  const { sub, args, dir } = gitParts(words, folder);
  const at = (paths: string[]) => paths.map((path) => ({ path, from: dir }));
  if (sub === 'checkout') return at(args.includes('--') ? args.slice(args.indexOf('--') + 1) : plainArgs(args, ['-b', '-B', '--orphan']));
  // `git restore --staged` alone changes only what is staged: the way to undo a `git add`.
  const isIndexOnly = args.some((arg) => arg === '--staged' || arg === '-S') && !args.some((arg) => arg === '--worktree' || arg === '-W');
  if (sub === 'restore') return isIndexOnly ? [] : at(plainArgs(args, ['-s', '--source']));
  if (sub === 'rm') return at(plainArgs(args));
  if (sub === 'mv') return at(copyTargets(args, { valued: [], isMove: true, folder: dir }));
  if (sub !== 'apply' || dir === null) return [];
  const root = rootOf(dir);
  if (!root) return [];
  const targets: WriteTarget[] = [];
  // `-` is stdin, which the guard never reads. A patch is read only as a plain file of at
  // most PATCH_LIMIT bytes: never a FIFO, a device or /dev/stdin, which could wait or be huge.
  for (const patch of plainArgs(args, ['-p', '--exclude', '--include', '--directory']).filter((arg) => arg !== '-')) {
    const file = resolve(dir, patch);
    let isReadable = false;
    try {
      const stat = statSync(file);
      isReadable = stat.isFile() && stat.size <= PATCH_LIMIT;
    } catch {
      isReadable = false;
    }
    if (!isReadable) targets.push({ path: patch, from: dir, isUnread: true });
    else targets.push(...patchFiles(readText(file)).map((path) => ({ path: join(root, path), from: root })));
  }
  return targets;
}

// The files a patch names: `diff --git a/x b/y`, `--- a/x` and `+++ b/y`.
function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) files.push(header[1], header[2]);
    const side = /^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/.exec(line);
    if (side && side[1] !== '/dev/null') files.push(side[1]);
  }
  return files;
}

// `git commit` options whose value is the next word.
const COMMIT_VALUES = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--cleanup', '--template', '--trailer', '--pathspec-from-file']);

/**
 * The files a `git commit` commits, as full paths: its pathspecs when it names any, else
 * what is staged, and with -a what is changed too. In a short option cluster, m, F, C, c
 * and t take a value; S and u take the rest of the word.
 */
function commitTargets(words: string[], folder: string | null, rootOf: FileRules['rootOf']): WriteTarget[] {
  const start = words.findIndex(isGit);
  if (start === -1) return [];
  const { sub, args, dir } = gitParts(withoutShellRedirects(words, start + 1), folder);
  if (sub !== 'commit' || dir === null) return [];
  let isAll = false;
  let isInclude = false;
  const named: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      named.push(...args.slice(index + 1));
      break;
    }
    if (word.startsWith('--')) {
      if (word === '--all') isAll = true;
      if (word === '--include') isInclude = true;
      if (COMMIT_VALUES.has(word)) index++;
    } else if (word.startsWith('-') && word !== '-') {
      for (const [at, letter] of [...word].entries()) {
        if (at === 0) continue;
        if (letter === 'a') isAll = true;
        if (letter === 'i') isInclude = true;
        if ('mFCct'.includes(letter) && at === word.length - 1) index++;
        if ('mFCctSu'.includes(letter)) break;
      }
    } else named.push(word);
  }
  const targets = named.map((path) => ({ path, from: dir }));
  if (named.length > 0 && !isInclude) return targets;
  // git names staged files from the repo's root. The root is found by a walk, not a second git.
  const root = rootOf(dir);
  if (root === null) return targets;
  const changed = (args: string[]) =>
    (readGit(dir, ['--no-optional-locks', 'diff', ...args, '--name-only', '--no-renames', '-z']) ?? '')
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path: join(root, path), from: root }));
  return [...targets, ...changed(['--cached']), ...(isAll ? changed([]) : [])];
}

// ---- Programs the project blocks (#192) ----
//
// yokoten.json "commands.block" names programs no agent runs here, each with its reason.
// Only a program counts, so `echo python` and `cat python.md` pass. A command can run
// more than one program, and `findPrograms` lists each:
//
// - the first word after assignments (FOO=1), redirects (`>out`, `2>&1`, `< in`) and
//   shell keywords (`then`, `do`, `!`);
// - after a launcher that runs the next word as a program (env, sudo, nice, timeout,
//   xargs, stdbuf, setsid, busybox and the others in LAUNCHERS), the word after its
//   options;
// - the program after `find ... -exec`, `-execdir`, `-ok` and `-okdir`;
// - the programs of the string `env -S` splits.
//
// A shell string (`bash -c '...'`, `ssh host '...'`, `flock f -c '...'`) is read by
// commandWords. A case pattern (`python3)`) is no command: the reader drops it.

// Shell keywords before a program: `if x`, `then x`, `do x`, `! x`. `time` is a launcher.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac', '!', '{', '}', '(']);
// A loop or case head names a variable and data, not a program: `for f in a b`.
const HEADS = new Set(['for', 'select', 'case', 'in']);
// The words that open a compound command, each with the word that closes it.
const COMPOUNDS: Record<string, 'fi' | 'done' | 'esac'> = { if: 'fi', while: 'done', until: 'done', for: 'done', select: 'done', case: 'esac' };

// Each launcher, with the options that take the next word as their value, and how many
// plain words come before the program (timeout's duration, chrt's priority, taskset's mask).
const LAUNCHERS: Record<string, { options: string[]; operands?: number }> = {
  env: { options: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  sudo: { options: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'] },
  doas: { options: ['-u', '-C'] },
  pkexec: { options: ['--user'] },
  command: { options: [] },
  builtin: { options: [] },
  exec: { options: ['-a'] },
  time: { options: ['-f', '--format', '-o', '--output'] },
  nice: { options: ['-n', '--adjustment'] },
  nohup: { options: [] },
  setsid: { options: [] },
  timeout: { options: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  xargs: { options: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars'] },
  stdbuf: { options: ['-i', '-o', '-e'] },
  unbuffer: { options: [] },
  busybox: { options: [] },
  chrt: { options: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'], operands: 1 },
  ionice: { options: ['-c', '--class', '-n', '--classdata'] },
  taskset: { options: [], operands: 1 },
  numactl: { options: ['-N', '-m', '-C', '-p', '-i', '--cpunodebind', '--membind', '--physcpubind', '--preferred', '--interleave'] },
  chroot: { options: [], operands: 1 },
  flock: { options: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code'], operands: 1 },
  faketime: { options: [], operands: 1 },
  fakeroot: { options: ['-l', '--lib', '--faked', '-s', '-i'] },
  eatmydata: { options: [] },
  nocache: { options: [] },
  catchsegv: { options: [] },
  strace: { options: ['-o', '-e', '-p', '-s', '-u', '-E', '-a', '-b', '-I', '-O', '-S', '-P', '-X'] },
  ltrace: { options: ['-o', '-e', '-p', '-s', '-u', '-a', '-n', '-l'] },
  firejail: { options: [] },
  proxychains: { options: ['-f'] },
  proxychains4: { options: ['-f'] },
  torsocks: { options: ['-u', '-p', '-a', '-P'] },
  'xvfb-run': { options: ['-n', '--server-num', '-e', '--error-file', '-f', '--auth-file', '-p', '--xauth-protocol', '-s', '--server-args', '-w', '--wait'] },
  caffeinate: { options: ['-t', '-w'] },
};
// find runs the program after each of these.
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// A redirect's operator, with the file descriptor before it.
const REDIRECT_OPERATOR = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(?:>>|<<<|<>|>\||[<>]&|[<>])/;
// Whether a > read now goes on the word as part of its redirect: the word so far is only a
// file descriptor (`2`, `{fd}`), `&`, or one >, with no quote. Otherwise it starts a new word.
const isOperatorStart = (word: string, isQuoted: boolean) => !isQuoted && /^(\d+|\{[A-Za-z_]\w*\}|&)?>?$/.test(word);
// A redirect: `>out`, `2>&1`, `&>>log`, `<in`, or one with its file in the next word (`> out`).
const REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(?:>>|<<<|<>|>\||[<>]&|[<>])(.*)$/s;

/** How many words the redirect at `index` takes: 0 when the word is no redirect. */
function redirectLength(words: string[], index: number): number {
  const redirect = REDIRECT.exec(words[index] ?? '');
  if (!redirect) return 0;
  return redirect[1] === '' && index + 1 < words.length ? 2 : 1;
}

/** The index of the first word at or after `index` that is not an assignment, a redirect or a keyword, at most `limit`. */
function skipPrefix(words: string[], index: number, limit = words.length): number {
  while (index < limit) {
    if (isAssignment(words[index]) || KEYWORDS.has(words[index])) index++;
    else if (redirectLength(words, index) > 0) index = Math.min(index + redirectLength(words, index), limit);
    else break;
  }
  return index;
}

/** A program's name: no folder and no .exe. */
const programName = (word: string) => base(word).replace(/\.exe$/i, '');

// The string `env -S` splits into a command, from the option at `index`, or undefined.
// A long option may be cut short, as getopt allows: `--split`, `--s`.
function splitString(words: string[], index: number): string | undefined {
  const option = words[index];
  const long = /^--(s[a-z-]*)(?:=(.*))?$/s.exec(option);
  if (long && 'split-string'.startsWith(long[1])) return envEscapes(long[2] ?? words[index + 1]);
  const short = /^-[a-zA-Z]*S(.*)$/s.exec(option);
  if (short) return envEscapes(short[1] || words[index + 1]);
  return undefined;
}

// env -S reads its own escapes before it splits: \_ (a space), \t \n \v \f \r are
// whitespace that cuts words, and \c ends the string. The other escapes (\\ \" \' \$ \#)
// are left for commandWords, which reads them as the shell does.
function envEscapes(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  spend(text.length);
  let out = '';
  const variable = /\$\{[A-Za-z_]\w*\}/y;
  for (let i = 0; i < text.length; i++) {
    const next = text[i + 1] ?? '';
    variable.lastIndex = i;
    // env puts the variable's value in place of ${NAME}; the guard does not know it, and
    // reads it as empty, so `--for${X}ce` reads as the option it may well be.
    if (text[i] === '$' && next === '{' && variable.test(text)) i = variable.lastIndex - 1;
    else if (text[i] !== '\\') out += text[i];
    else if (next === 'c') break;
    else {
      out += '_tnvfr'.includes(next) && next !== '' ? ' ' : text[i] + next;
      i++;
    }
  }
  return out;
}

// At most this many programs from one command: a longer list is refused (see checkBlocked).
const MAX_PROGRAMS = 256;

/** The words that name the programs a command runs, in order. */
function findPrograms(words: string[]): string[] {
  spend(words.length);
  const programs: string[] = [];
  // commandWords reads `bash -c 'x'` again as `-c x`: the shell's options come first.
  const start = words.findIndex((word) => !word.startsWith('-'));
  if (start === -1) return programs;
  const findAt = programAt(words, start, programs);
  // find runs the program after each -exec, -execdir, -ok and -okdir. One pass over the
  // words finds them all, a find inside a find too, without reading any word twice.
  if (findAt !== -1) {
    for (let action = findAt + 1; action < words.length && programs.length <= MAX_PROGRAMS; action++) {
      if (FIND_ACTIONS.has(words[action])) programAt(words, action + 1, programs, true);
    }
  }
  return programs;
}

// Adds the program of the command that starts at `index` to `programs`, after
// assignments, redirects, keywords and launchers, and the programs of an `env -S`
// string. Returns the index of the program when it is find, or -1. In a find action
// (`isAction`) the command ends at `;` or `{} +`, and the walk stops at the next action too:
// findPrograms reads that one itself, so no word is walked once for each action before it.
function programAt(words: string[], index: number, programs: string[], isAction = false): number {
  let limit = words.length;
  if (isAction) {
    limit = index;
    while (limit < words.length && !FIND_ACTIONS.has(words[limit]) && words[limit] !== ';' && !(words[limit] === '+' && words[limit - 1] === '{}')) limit++;
  }
  while (index < limit) {
    index = skipPrefix(words, index, limit);
    if (index >= limit || HEADS.has(words[index])) return -1;
    const name = programName(words[index]);
    if (!Object.hasOwn(LAUNCHERS, name)) {
      programs.push(words[index]);
      return name === 'find' ? index : -1;
    }
    const launcher = LAUNCHERS[name];
    index++;
    // `command -v x` only says where x is; it does not run it.
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[index] ?? '')) return -1;
    while (index < limit && words[index].startsWith('-')) {
      const split = name === 'env' ? splitString(words, index) : undefined;
      if (split !== undefined) {
        for (const command of commandWords(split)) for (const program of findPrograms(command)) programs.push(program);
      }
      index += launcher.options.includes(words[index]) ? 2 : 1;
    }
    index += launcher.operands ?? 0;
  }
  return -1;
}

function checkBlocked(words: string[], blockList: Record<string, string>): Finding | null {
  const programs = findPrograms(words);
  if (programs.length > MAX_PROGRAMS && Object.keys(blockList).length > 0) {
    return finding('unreadable-command', `yokoten could not read this command: it runs more than ${MAX_PROGRAMS} programs`, 'split it into simpler commands, one per call');
  }
  const name = programs.map(programName).find((program) => Object.hasOwn(blockList, program));
  if (name === undefined) return null;
  const reason = blockList[name].trim().replace(/\.+$/, '');
  return finding('blocked-command', `\`${name}\` is blocked in this project`, 'use the project\'s own stack instead; yokoten.json "commands.block" lists what is blocked', { why: reason });
}

// ---- Commands that print account details (#390) ----
//
// Some commands print the owner's name, email, login or a private host: a git author line,
// a remote URL, an account report. Once that output reaches an agent it can't be taken
// back, so the hook pipes these commands through `yokoten redact`. Only a read is
// rewritten, and only when the whole command is one plain command from this table: no
// separator, pipe, redirect, substitution, prefix or launcher. Then the rewrite can't run
// anything the user did not already see. One row per kind of command. Add a row when an
// incident shows a new one.

/** One read-only command that prints account details. */
interface AccountPrinter {
  /** The program, by its base name. */
  program: string;
  /** Its subcommands that print them: the word right after the program. */
  subcommands: string[];
  /** True when the words after the subcommand keep it a plain read that prints them. */
  accepts: (args: string[]) => boolean;
  /** What it prints, for the message. */
  prints: string;
}

// A log with its own format prints only what the format names.
const GIT_FORMAT = /^(?:--format|--pretty|--oneline)(?:=|$)/;
// Options that make a git read write a file or run another program.
const GIT_UNSAFE = /^(?:--output|-o|--ext-diff|--exec-path|--textconv)/;
const isGitRead = (args: string[]) => !args.some((arg) => GIT_FORMAT.test(arg) || GIT_UNSAFE.test(arg));

// `git remote -v`, or `git remote get-url|show <name>`: never add, remove or set.
const isRemoteRead = (args: string[]) =>
  (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) || ((args[0] === 'get-url' || args[0] === 'show') && args.slice(1).every((arg) => /^(?:--all|--push|-n|[\w.-]+)$/.test(arg)));

// `git config --list`, or a read of one account key. A write prints nothing.
const CONFIG_SCOPES = new Set(['--global', '--system', '--local', '--show-origin', '--show-scope', '--includes', '--name-only', '-z', '--null']);
const ACCOUNT_KEY = /^(?:user|remote|credential|url|sendemail)\./i;
function isConfigRead(args: string[]): boolean {
  const [verb, key, ...more] = args.filter((arg) => !CONFIG_SCOPES.has(arg));
  if (verb === '--list' || verb === '-l' || verb === 'list') return key === undefined;
  if (verb === '--get' || verb === '--get-all' || verb === 'get' || verb === '--get-regexp') return key !== undefined && ACCOUNT_KEY.test(key) && more.length === 0;
  return false;
}

// A GET of a traffic or account path: one path, and only options that read.
function isAccountGet(args: string[]): boolean {
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--paginate', '-i', '--include', '--silent'].includes(arg)) continue;
    if (arg === '--jq' || arg === '-q' || arg === '-X' || arg === '--method') {
      const value = args[++i];
      if (value === undefined || ((arg === '-X' || arg === '--method') && value.toUpperCase() !== 'GET')) return false;
    } else if (/^--(?:jq)=/.test(arg)) continue;
    else if (/^(?:--method=|-X)/.test(arg)) {
      if (arg.replace(/^(?:--method=|-X)/, '').toUpperCase() !== 'GET') return false;
    } else if (arg.startsWith('-') || path !== undefined) return false;
    else path = arg;
  }
  return path !== undefined && /(^|\/)(?:traffic|user|users)(?:\/|$)/.test(path);
}

// Options that only choose which account or registry to ask: each takes a value.
const takesOnly = (valued: string[], flags: string[] = []) => (args: string[]) => {
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i]) && args[i + 1] !== undefined) i++;
    else if (!flags.includes(args[i])) return false;
  }
  return true;
};

export const ACCOUNT_PRINTERS: AccountPrinter[] = [
  { program: 'git', subcommands: ['log', 'show', 'whatchanged', 'blame', 'shortlog', 'annotate'], accepts: isGitRead, prints: 'author names and emails' },
  { program: 'git', subcommands: ['remote'], accepts: isRemoteRead, prints: 'remote URLs' },
  { program: 'git', subcommands: ['config'], accepts: isConfigRead, prints: 'your name, email and remotes' },
  { program: 'gh', subcommands: ['api'], accepts: isAccountGet, prints: 'the login and account details' },
  { program: 'gh', subcommands: ['auth'], accepts: (args) => args[0] === 'status' && takesOnly(['--hostname', '-h'], ['--active', '-a'])(args.slice(1)), prints: 'the login' },
  { program: 'npm', subcommands: ['whoami'], accepts: takesOnly(['--registry']), prints: 'the login' },
  { program: 'wrangler', subcommands: ['whoami'], accepts: (args) => args.length === 0, prints: 'the account name and email' },
];

// Shell text that makes more than one plain command: separators, pipes, background, redirects,
// substitutions, groups, a line end, an escape or a comment.
const NOT_SIMPLE = /[;&|<>`$(){}\\\n#]/;
// Runners that start a package's program by name: `npx wrangler`, `pnpm dlx wrangler`.
const PACKAGE_RUNNERS: Record<string, string[]> = { npx: [], bunx: [], pnpm: ['dlx', 'exec'], yarn: ['dlx', 'exec'] };

/** The mark every wrapped command carries, so the hook never wraps one twice. */
export const REDACT_MARKER = '# yokoten-redact';
const RUNS_REDACT = /\byokoten(?:\.ts|\.js)?["']?\s+redact\b/;
/**
 * A command that already sends its output through `yokoten redact`: it starts with the
 * wrapper's first line, marker included, and calls redact. A comment that names them does not count.
 */
export const isRedacted = (command: string): boolean => command.startsWith(`set -o pipefail ${REDACT_MARKER}\n`) && RUNS_REDACT.test(command);

/**
 * What the command prints about the owner, or null. Not null only when the whole command
 * is one plain command that a row of ACCOUNT_PRINTERS lists, its subcommand in place:
 * `git remote add show x` is no `git remote show`.
 */
export function printsAccount(command: string): string | null {
  if (isRedacted(command) || NOT_SIMPLE.test(command)) return null;
  let words: string[];
  try {
    const commands = commandWords(command);
    if (commands.length !== 1) return null;
    words = commands[0];
  } catch {
    return null;
  }
  if (!words.length || isAssignment(words[0])) return null;
  let at = 0;
  let name = programName(words[0]);
  if (Object.hasOwn(PACKAGE_RUNNERS, name)) {
    at = PACKAGE_RUNNERS[name].includes(words[1]) ? 2 : 1;
    if (words[at] === undefined) return null;
    name = programName(words[at]).replace(/@[^/]*$/, '');
  }
  const subcommand = words[at + 1];
  const row = ACCOUNT_PRINTERS.find((printer) => printer.program === name && printer.subcommands.includes(subcommand) && printer.accepts(words.slice(at + 2)));
  return row ? `\`${row.program} ${subcommand}\` prints ${row.prints}` : null;
}

/** The refusal for an agent whose hook can't change the command, with yokoten.json "privacy.output" "stop": the fix is the wrapped command. */
export const privateOutput = (printed: string, wrapped: string): Finding => finding('private-output', `${printed}, and this agent can't filter it`, `run it as \`${wrapped}\``);

/**
 * The command with its output, stderr too, sent through `redact`, the command that runs
 * `yokoten redact`. pipefail keeps the command's exit code. If redact can't start or
 * stops, `cat` passes the rest through: hiding output never stops the command. The
 * command sits on lines of its own, after the marker.
 */
export const wrapForRedact = (command: string, redact: string): string => `set -o pipefail ${REDACT_MARKER}\n(\n${command}\n) 2>&1 | { ${redact} || cat; }`;

// ---- Reading bash ----
//
// A small reader for everyday bash, not a full parser. It turns command text into a list
// of commands, each a list of words.
//
// - Quotes: '...', "..." (with \ escapes), $'...' and $"..." are part of one word. A
//   separator inside them does not cut the command.
// - Separators: ; & && || | |& ( ) { } and line ends. A \ before a line end joins lines.
//   A group `{ ...; }` or subshell `( ... )` stays open until its } or ).
// - A case pattern (`a|b)` after `case x in` or `;;`) is dropped: it names values.
// - A word that starts with # begins a comment, to the line end.
// - $(...), `...`, <(...) and >(...) run, so their text is read as commands, even in "...".
// - A heredoc body is data, unless a shell reads it (see `bodies`).
// - A shell, eval or ssh runs a string, so the words after it are read again as commands
//   (see `runString`). So does `source /dev/stdin` or `. /dev/fd/N` with its input.
// - Each construct is read once: an unclosed $(, <(, ((, ` or " has read the rest of the
//   text as commands, and the rest is not read again. All reads of one command share one
//   work budget (see withBudget); a command over it is refused.
//
// When the text is unclear, the guard blocks rather than guesses. An unclosed quote is
// dropped and the rest is read as plain words, so `echo 'x; npm publish` still blocks.
// Functions and aliases are not followed.

const MAX_DEPTH = 8;

// ---- The work budget ----
//
// Every read of one command draws on one budget: each character the reader visits, each
// word a word loop looks at. Nested constructs read text again (a shell string, an env -S
// string, a substitution), at most MAX_DEPTH times over, so a command that reads cleanly
// stays well inside it. A command that would cost more, by design or by accident, throws,
// and checkCommand refuses it: the guard never runs out of time or memory and lets it by.
const BUDGET_PER_CHARACTER = 20;
const BUDGET_BASE = 200_000;
let budget: { left: number } | null = null;

class OverBudget extends Error {}

function spend(amount: number): void {
  if (budget !== null && (budget.left -= amount) < 0) throw new OverBudget('the command costs too much to read');
}

// Runs `read` under a budget for text of `size` characters. A read inside another shares
// the outer budget, unless `fresh` (a hook file is not part of the command).
function withBudget<T>(size: number, read: () => T, fresh = false): T {
  if (budget !== null && !fresh) return read();
  const outer = budget;
  budget = { left: BUDGET_PER_CHARACTER * size + BUDGET_BASE };
  try {
    return read();
  } finally {
    budget = outer;
  }
}

const isShell = (word: string) => /^(?:ba|da|z|k|c|tc|fi|pw)?sh(?:\.exe)?$/.test(base(word));
// Programs that run a later word through a shell, beside the shells. A pattern means only
// with that option: sudo and doas pass their words to a program unless given -s or -i,
// and env unless given -S. xargs, nohup, time and the like run a program, not a shell
// string, so their words are already checked where they stand.
const RUNNERS: Record<string, RegExp | null> = {
  eval: null, ssh: null, su: null, runuser: null, watch: null, script: null, flock: null, parallel: null, tmux: null, screen: null,
  sudo: /^(-[a-zA-Z]*[si]|--shell|--login)/, doas: /^-[a-zA-Z]*s/, env: /^(-[a-zA-Z]*S|--s)/,
};

const RUNNER_OPTIONS = Object.entries(RUNNERS).flatMap(([runner, option]) => (option ? [[runner, option] as const] : []));

// Where a shell or a runner stands in the command, or -1. Anywhere counts: `find -exec sh
// -c`, `xargs sh -c` and `sudo bash -c` all run a string.
// It walks back from the end once, so each word is tested once against each option.
function runnerAt(words: string[]): number {
  spend(words.length);
  const later = new Set<string>(); // runners whose option stands after the current word
  let at = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    const name = base(words[i]);
    if (isShell(words[i]) || (Object.hasOwn(RUNNERS, name) && (RUNNERS[name] === null || later.has(name))) || sourcesInput(words, i)) at = i;
    for (const [runner, option] of RUNNER_OPTIONS) if (option.test(words[i])) later.add(runner);
  }
  return at;
}

// `source /dev/stdin` and `. /dev/fd/3` run what comes in, as a shell does;
// `source -- /dev/stdin`, `. //dev/stdin` and `. /proc/$$/fd/0` do too.
function sourcesInput(words: string[], i: number): boolean {
  if (words[i] !== 'source' && words[i] !== '.') return false;
  const file = (words[i + 1] === '--' ? words[i + 2] : words[i + 1]) ?? '';
  return /^\/(?:dev\/(?:stdin|fd\/\d+)|proc\/[^/]+\/fd\/\d+)$/.test(file.replace(/\/{2,}/g, '/'));
}

// A command that, in the middle of a pipeline, hands on what comes in: `tee` with any files,
// `cat` with no file but `-`. The next command gets what the one before it printed.
function passesOn(words: string[]): boolean {
  const program = findPrograms(words)[0];
  if (program === undefined) return false;
  const name = programName(program);
  if (name === 'tee') return true;
  if (name !== 'cat') return false;
  const at = words.indexOf(program, skipPrefix(words, 0));
  return at !== -1 && words.slice(at + 1).every((word) => word.startsWith('-'));
}

// `source x` and `. x`: the shell runs the file, so a `<(...)` given to it is commands.
function isSource(words: string[]): boolean {
  const program = findPrograms(words)[0];
  return program === 'source' || program === '.';
}

// The command xargs runs, without what comes in (`xargs -0 git` gives `git`), or null when
// the command has no xargs. With no program after its options, xargs runs echo.
function xargsCommand(words: string[]): string | null {
  spend(words.length);
  let index = words.findIndex((word) => programName(word) === 'xargs');
  if (index === -1) return null;
  for (index++; index < words.length && words[index].startsWith('-'); ) index += LAUNCHERS.xargs.options.includes(words[index]) ? 2 : 1;
  return words.slice(index).join(' ');
}

// What a command prints, as the command it pipes into reads it: for printf, its format
// filled in (see printfText); for any other, its words after the program, as echo prints
// them, with each \n a line end. Over-reading is fine: `cat x` "prints" x.
function printedText(words: string[]): string {
  const at = skipPrefix(words, 0);
  const program = findPrograms(words)[0];
  const printfAt = program !== undefined && programName(program) === 'printf' ? words.indexOf(program, at) : -1;
  if (printfAt !== -1) return printfText(words.slice(printfAt + 1));
  return words.slice(at + 1).join(' ').replace(/\\n/g, '\n');
}

// More text than this from printf's format said again for each set of arguments, and the
// guard reads the format and the arguments as plain words instead.
const MAX_PRINTF_REPEATS = 65_536;

// What `printf [-v name] [--] format args...` prints, when the format's only conversions are
// %s and %b (and %%): the format with each conversion filled by the next argument, again
// while arguments are left, and its escapes \n \t \\ read. For any harder format, the
// arguments and the format, as words: the guard reads more than printf prints, never less.
function printfText(args: string[]): string {
  let at = 0;
  if (args[at] === '-v') at += 2;
  if (args[at] === '--') at++;
  const format = args[at] ?? '';
  const values = args.slice(at + 1);
  spend(format.length + values.length);
  const texts: string[] = ['']; // the format's text before each conversion, and after the last
  const conversions: string[] = []; // 's' or 'b'
  let isSimple = true;
  for (let position = 0; position < format.length && isSimple; position++) {
    const next = format[position + 1] ?? '';
    if (format[position] === '%' && (next === 's' || next === 'b')) {
      conversions.push(next);
      texts.push('');
      position++;
    } else if (format[position] === '%' && next === '%') {
      texts[texts.length - 1] += '%';
      position++;
    } else if (format[position] === '%') isSimple = false;
    else if (format[position] === '\\') {
      texts[texts.length - 1] += printfEscape(next);
      position++;
    } else texts[texts.length - 1] += format[position];
  }
  const repeats = conversions.length === 0 ? 1 : Math.max(1, Math.ceil(values.length / conversions.length));
  if (!isSimple || (repeats - 1) * format.length > MAX_PRINTF_REPEATS) {
    // The arguments first, so xargs takes its program's first word from them; then each on a
    // line of its own, and the format with the arguments after it, for a shell.
    const joined = values.join(' ');
    return [joined, ...values, `${format} ${joined}`].join('\n').replace(/\\n/g, '\n');
  }
  let out = '';
  let filled = 0; // how many arguments are filled in
  for (let repeat = 0; repeat < repeats; repeat++) {
    spend(texts.length);
    for (const [index, conversion] of conversions.entries()) {
      const value = values[filled++] ?? '';
      // %b reads the escapes in its argument too.
      out += texts[index] + (conversion === 'b' ? value.replace(/\\(.?)/gs, (_, letter: string) => printfEscape(letter)) : value);
    }
    out += texts[conversions.length];
  }
  return out;
}

// What printf prints for the escape \<letter>: a line end for n, a tab for t, one \ for \,
// and for any other, both characters as written.
function printfEscape(letter: string): string {
  if (letter === 'n') return '\n';
  if (letter === 't') return '\t';
  if (letter === '\\') return '\\';
  return `\\${letter}`;
}

// ssh options that take a value, in the same word (-p22) or the next (-p 22).
const SSH_VALUE_OPTIONS = 'BbcDEeFIiJLlmOoPpQRSWw';
// flock options that take a value. -c (--command) takes the shell string.
const FLOCK_VALUE_OPTIONS = 'wE';

// The text a runner at `at` hands to a shell. For most it is every word after the runner.
// ssh runs the words after its options and the host (`ssh -p 22 host 'x'`), and flock the
// string after -c (`flock f -c 'x'`) or the command after its file (`flock f x`).
function runString(words: string[], at: number): string {
  const name = base(words[at]);
  if (name === 'ssh') return words.slice(sshCommand(words, at + 1)).join(' ');
  if (name === 'flock') return flockCommand(words, at + 1);
  if (name === 'env') return envCommand(words, at + 1) ?? words.slice(at + 1).join(' ');
  return words.slice(at + 1).join(' ');
}

// The command `env -S` runs: its split string, then the words after it
// (`env -iS'git push' x`, `env --split-string='a b'`, `env -u X -S 'a b'`).
function envCommand(words: string[], index: number): string | undefined {
  while (index < words.length && words[index].startsWith('-')) {
    const split = splitString(words, index);
    if (split !== undefined) {
      const isInline = /^--[^=]*=/.test(words[index]) || /^-[a-zA-Z]*S./s.test(words[index]);
      return [split, ...words.slice(index + (isInline ? 1 : 2))].join(' ');
    }
    index += LAUNCHERS.env.options.includes(words[index]) ? 2 : 1;
  }
  return undefined;
}

// The index of the first word after ssh's options and host.
function sshCommand(words: string[], index: number): number {
  while (index < words.length && words[index].startsWith('-') && words[index] !== '-') {
    if (words[index] === '--') return index + 2;
    const option = words[index];
    const value = [...option.slice(1)].findIndex((letter) => SSH_VALUE_OPTIONS.includes(letter));
    // A value option last in its word takes the next word: `-tp 22`.
    index += value !== -1 && value === option.length - 2 ? 2 : 1;
  }
  return index + 1;
}

// flock's command: the string after -c or --command, before or after the file, or the
// words after the file.
function flockCommand(words: string[], index: number): string {
  let file = false;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith('--')) {
      const command = /^--command(?:=(.*))?$/s.exec(word);
      if (command) return command[1] ?? words[index + 1] ?? '';
      if (/^--(wait|timeout|conflict-exit-code)$/.test(word)) index++;
    } else if (word.startsWith('-') && word.length > 1) {
      for (let letter = 1; letter < word.length; letter++) {
        const rest = word.slice(letter + 1);
        if (word[letter] === 'c') return rest || (words[index + 1] ?? '');
        if (FLOCK_VALUE_OPTIONS.includes(word[letter])) {
          if (!rest) index++;
          break;
        }
      }
    } else if (!file) file = true;
    else return words.slice(index).join(' ');
  }
  return '';
}

/** Every command the text runs, as lists of words. Text that runs inside a command is listed too. */
export function commandWords(text: string, depth = 0): string[][] {
  const out: string[][] = [];
  withBudget(text.length, () => read(text, 0, '', depth, out));
  return out;
}

interface Heredoc {
  delim: string;
  strip: boolean;
  quoted: boolean;
  /** The index, on its line, of the command that holds the <<. */
  cmd: number;
  /** The groups open around it, outermost first. */
  groups: Group[];
  /** The group it follows, `{ read a; } <<EOF`: the body is the group's input. */
  group?: Group;
}

// A group `{ ...; }`, a subshell `( ... )`, or a compound command (`if ... fi`, a loop to
// its `done`, `case ... esac`). What its commands print goes where the group sends it, so a
// heredoc body or an echo inside may reach a shell after the group: `{ cat <<EOF; } | bash`,
// `if x; then echo y; fi | bash`. A compound command's kind is the word that closes it.
interface Group {
  kind: '(' | '{' | 'fi' | 'done' | 'esac';
  /** The index, on the current line, of its first command, and of the one after it once closed. */
  from: number;
  to: number;
  /** What its commands print (heredoc bodies, the words an echo prints), waiting for where the group's output goes. */
  bodies: string[];
  /** The groups closed inside it that sent their output on to it: their bodies are its own. */
  inner: Group[];
  /** Whether a command in it reads its input as commands. */
  reads: boolean;
}

// Reads commands from `start` until `closer` (`)` or a backtick) or the end, and adds them
// to `out`. Returns the index after the closer, or -1 if a closer was wanted and not found.
function read(text: string, start: number, closer: string, depth: number, out: string[][]): number {
  // Too deep to follow: fall back to the rough cut, which finds more than is there.
  if (depth > MAX_DEPTH) {
    spend(text.length - start);
    for (const words of rough(text.slice(start))) out.push(words);
    return text.length;
  }
  const nested = (s: string) => out.push(...commandWords(s, depth + 1));
  let words: string[] = [];
  let substitutions: string[] = []; // the text inside each $(...) and <(...) of this command
  let word = '';
  let inWord = false;
  let isQuoted = false; // the word has a quote or a \ in it, so it is no keyword: `'case'`, `\case`
  let quotedAt = 0; // with isQuoted, how much of the word came before its first quote
  // Marks the word as quoted from here on, before the quoted text is added.
  const quote = () => {
    if (!isQuoted) quotedAt = word.length;
    isQuoted = true;
  };
  let caseAt = -1; // where `case` stands in words, when it starts the command
  let isLeading = true; // every word so far is a keyword, so the next one leads the command
  let line: string[][] = []; // the commands so far on this line, for heredocs
  let pipes: boolean[] = []; // for each of them, whether it pipes into the next
  let pending: Heredoc[] = [];
  let piped: string[] | null = null; // the command before a |
  let pipedSubstitutions: string[] = []; // the text inside each $(...) and <(...) of that command
  const groups: Group[] = []; // the groups open now, outermost first
  // A group that just closed, until we see where it sends its output. closeGroup sets it, so
  // the type is written out: TypeScript would take it for null.
  let closed = null as Group | null;
  let carried: string[] = []; // heredoc bodies a closed group pipes on, waiting for the command that reads them
  let cases = 0; // how many `case ... in` are open
  let isPattern = false; // reading a case pattern, up to its )
  let alternative = 0; // words in the pattern since the last |: more than one is no pattern

  const endWord = () => {
    const ended = inWord ? word : null;
    const isKeyword = !isQuoted;
    const isFirst = isLeading;
    if (ended !== null) {
      words.push(ended);
      readWords.add(words);
      // A redirect whose operator is unquoted, whatever its file: `>"AGENTS.md"` (#402).
      if (REDIRECT.test(ended) && (!isQuoted || (REDIRECT_OPERATOR.exec(ended)?.[0].length ?? Infinity) <= quotedAt)) {
        const marks = unquotedRedirects.get(words) ?? new Set<number>();
        marks.add(words.length - 1);
        unquotedRedirects.set(words, marks);
      }
      isLeading = isLeading && isKeyword && KEYWORDS.has(ended);
    }
    word = '';
    inWord = false;
    isQuoted = false;
    if (ended === null) return;
    if (isPattern && ++alternative > 1) isPattern = false; // `a b)` is no pattern: read it as a command
    if (!isKeyword) return;
    // A compound command is a group, open from its first word to the word that closes it.
    if (isFirst && Object.hasOwn(COMPOUNDS, ended)) {
      groups.push({ kind: COMPOUNDS[ended], from: line.length, to: 0, bodies: [], inner: [], reads: false });
    } else if (isFirst && groups.length > 0 && groups[groups.length - 1].kind === ended) {
      closeGroup(line.length + 1); // the command the closing word leads is the group's too
    }
    if (ended === 'esac' && isFirst && cases > 0) {
      cases--;
      isPattern = false;
    } else if (ended === 'case' && isFirst) {
      caseAt = words.length - 1;
    } else if (ended === 'in' && !isPattern) {
      // `case $x in`: what comes next is a pattern, not a command.
      if (caseAt !== -1 && words.length - 1 === caseAt + 2) {
        endCommand();
        cases++;
        isPattern = true;
        alternative = 0;
      }
    }
  };
  // Closes the innermost group, whose commands end before `to`. A group that reads commands
  // makes its parent one that does.
  const closeGroup = (to: number) => {
    closed = groups.pop() ?? null;
    if (closed === null) return;
    closed.to = to;
    const parent = groups.at(-1);
    if (parent && closed.reads) parent.reads = true;
  };
  // Where a group that just closed sends the bodies inside it, and whether this command
  // reads bodies a group piped on. A body that reaches no reader stays data.
  const settle = (pipe: boolean) => {
    if (carried.length > 0 && words.length > 0) {
      const reads = readsCommands(words);
      if (reads) for (const body of carried) nested(body);
      // `{ echo push --force; } | xargs git`: xargs hands the bodies to its program as words.
      const handed = reads ? null : xargsCommand(words);
      if (handed !== null) nested(`${handed} ${carried.join(' ').replace(/\s+/g, ' ')}`);
      if (reads || handed !== null || !pipe) carried = [];
    }
    if (closed) {
      if (pipe) {
        spend(closed.to - closed.from);
        groupBodies(closed, carried);
        // For the bodies read at this line's end: the group's commands pipe on, too.
        for (let i = closed.from; i < closed.to; i++) pipes[i] = true;
      } else groups.at(-1)?.inner.push(closed); // its bodies are its parent's now
      closed = null;
    }
  };
  // The end of the text or of a substitution. Bodies that still wait for a reader, after a
  // pipe to nothing or in a group that never closed, are read as commands, not guessed.
  const finish = () => {
    endCommand();
    for (const group of groups) groupBodies(group, carried);
    for (const body of carried) nested(body);
  };
  const endCommand = (pipe = false) => {
    endWord();
    spend(words.length);
    line.push(words);
    pipes.push(pipe);
    settle(pipe);
    if (words.length === 0) return;
    out.push(words);
    if (groups.length > 0) {
      // The innermost group reads; it tells its parent when it closes (see closeGroup).
      if (readsCommands(words)) groups[groups.length - 1].reads = true;
      // What the command prints, as `echo` would, waits in the group for where it goes.
      const printed = printedText(words);
      if (printed) groups[groups.length - 1].bodies.push(printed);
    }
    const at = runnerAt(words);
    if (at !== -1) {
      // `bash -c 'x'`, `eval "x"`, `ssh host 'x'`: read the string it runs as commands.
      nested(runString(words, at));
      // `echo 'npm publish' | bash`: the words before the pipe are the shell's input.
      if (piped) nested(printedText(piped));
    }
    // `bash <(x)`, `source <(x)`, `eval "$(x)"`: what x prints is commands, as in `x | bash`.
    // All of them in one group: in a group piped to a shell, every line is read as commands.
    if (substitutions.length > 0 && (at !== -1 || isSource(words))) nested(`{ ${substitutions.join('\n')}\n} | bash`);
    // `echo push | xargs git`: xargs hands what comes in to its program as words.
    const handed = piped ? xargsCommand(words) : null;
    if (piped && handed !== null) nested(`${handed} ${printedText(piped).replace(/\s+/g, ' ')}`);
    // `cat <(x) | bash`, `echo "$(x)" | xargs git`: the command before the pipe may print
    // what x prints. In a group piped on, each line x prints reaches the reader.
    if (pipedSubstitutions.length > 0 && (at !== -1 || handed !== null)) {
      nested(`{ ${pipedSubstitutions.join('\n')}\n} | ${at !== -1 ? 'bash' : `xargs ${handed}`}`);
    }
    if (pipe && piped !== null && passesOn(words)) {
      // `echo x | tee f | bash`: tee hands on what echo printed. Its own `$(x)` and `<(x)`
      // substitutions are read too: over-reading is fine. pipedSubstitutions is this reader's own array.
      for (const substitution of substitutions) pipedSubstitutions.push(substitution);
    } else {
      piped = pipe ? words : null;
      pipedSubstitutions = pipe ? substitutions : [];
    }
    substitutions = [];
    words = [];
    caseAt = -1;
    isLeading = true;
  };

  let index = start;
  while (index < text.length) {
    spend(1);
    const character = text[index];
    const next = text[index + 1];
    // A separator inside what looked like a pattern means it was none: the words so far, and
    // every command before, are read as commands. Only words since the last cut are dropped.
    const isCut = character === ';' || character === '&' || (character === '|' && next === '|') || ((character === '\n' || character === '(') && (inWord || words.length > 0));
    if (isPattern && isCut) isPattern = false;
    if (isPattern && (character === ')' || character === '|' || character === '(')) endWord();
    if (isPattern && (character === ')' || character === '|' || character === '(')) {
      // A case pattern, `a|b)` or `(a)`, names values, not programs. The commands come after the ).
      if (character === ')') {
        words = [];
        caseAt = -1;
        isLeading = true;
        isPattern = false;
      }
      alternative = 0;
      index++;
      continue;
    }
    if (closer && character === closer && !(character === ')' && groups.at(-1)?.kind === '(')) {
      finish();
      return index + 1;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      endWord();
      index++;
    } else if (character === '\n') {
      endCommand();
      index = pending.length ? bodies(text, index + 1, pending, { line, pipes, groups }, depth, out) : index + 1;
      pending = [];
      line = [];
      pipes = [];
      spend(groups.length);
      for (const group of groups) group.from = 0;
    } else if (character === '#' && !inWord) {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '\\') {
      if (next !== '\n') {
        quote();
        word += next ?? character;
        inWord = true;
      }
      index += 2;
    } else if (character === "'" || (character === '$' && next === "'")) {
      // '...' is as written. $'...' takes \ escapes, so \' does not close it.
      const ansi = character === '$';
      const open = ansi ? index + 1 : index;
      const end = ansi ? closeAnsi(text, open + 1) : text.indexOf("'", open + 1);
      spend((end === -1 ? text.length : end) - open);
      if (end === -1) index = open + 1; // unclosed: drop the quote and read on
      else {
        const body = text.slice(open + 1, end);
        quote();
        word += ansi ? body.replace(/\\(.)/gs, '$1') : body;
        inWord = true;
        index = end + 1;
      }
    } else if (character === '"' || (character === '$' && next === '"')) {
      const open = character === '$' ? index + 1 : index;
      const quoted = readDouble(text, open + 1, depth, out, false, substitutions);
      if (quoted === RAN_OUT) index = text.length; // a substitution in it never closed and read the rest
      else if (!quoted) index = open + 1; // unclosed: drop the quote and read on
      else {
        quote();
        word += quoted.value;
        inWord = true;
        index = quoted.end;
      }
    } else if ((character === '$' || character === '<' || character === '>') && next === '(') {
      // $(...), $((...)), <(...) and >(...): the inside runs on its own.
      const end = read(text, index + 2, ')', depth + 1, out);
      if (end === -1) {
        // Unclosed: the read inside already read the rest as commands. Never read it again.
        endCommand();
        index = text.length;
      } else {
        if (character !== '>' && text[index + 2] !== '(') substitutions.push(text.slice(index + 2, end - 1));
        word += text.slice(index, end);
        inWord = true;
        index = end;
      }
    } else if (character === '`') {
      const end = read(text, index + 1, '`', depth + 1, out);
      if (end !== -1) substitutions.push(text.slice(index + 1, end - 1));
      inWord = true;
      index = end === -1 ? text.length : end; // unclosed: the read inside read the rest
    } else if (character === '(' && next === '(') {
      // (( maths )): read the inside on its own, so a << there is a shift, not a heredoc.
      endWord();
      const end = read(text, index + 1, ')', depth + 1, out);
      if (end === -1) endCommand();
      index = end === -1 ? text.length : end; // unclosed: the read inside read the rest
    } else if (character === '(' || (character === '{' && !inWord && /\s/.test(next ?? ''))) {
      // A subshell or a group cuts like a separator, and is open until its ) or }.
      endCommand();
      groups.push({ kind: character, from: line.length, to: 0, bodies: [], inner: [], reads: false });
      index++;
    } else if ((character === ')' && groups.at(-1)?.kind === '(') || (character === '}' && !inWord && /[\s;|&)<>]|^$/.test(next ?? '') && groups.at(-1)?.kind === '{')) {
      endCommand();
      closeGroup(line.length);
      index++;
    } else if (character === ';' && cases > 0 && (next === ';' || next === '&')) {
      // `;;`, `;&` and `;;&` end a case item: a pattern comes next.
      endCommand();
      isPattern = true;
      alternative = 0;
      index += next === ';' && text[index + 2] === '&' ? 3 : 2;
    } else if (character === ')' || character === ';' || (character === '}' && !inWord && /[\s;]|^$/.test(next ?? ''))) {
      // A brace inside a word (${x}, a{b,c}) does not cut.
      endCommand();
      index++;
    } else if (character === '&') {
      if (next === '>' || word.endsWith('>')) {
        // &> and >& are redirects, not separators. `hi&>f` is `hi &>f`.
        if (next === '>' && inWord && !isOperatorStart(word, isQuoted)) endWord();
        word += character;
        inWord = true;
        index++;
      } else {
        endCommand();
        index += next === '&' ? 2 : 1;
      }
    } else if (character === '|' && !isQuoted && /^(\d+|\{[A-Za-z_]\w*\}|&)?>$/.test(word)) {
      // `>|` writes its file even with noclobber on: a redirect, not a pipe (#402).
      word += character;
      index++;
    } else if (character === '|') {
      endCommand(next !== '|');
      index += next === '|' || next === '&' ? 2 : 1;
    } else if (character === '<' && next === '<' && text[index + 2] === '<') {
      // A here-string is one more word. A shell that reads it is a runner, so it is read.
      endWord();
      words.push('<<<');
      index += 3;
    } else if (character === '<' && next === '<' && !word.endsWith('<')) {
      // `3<<EOF`: the number names the file descriptor, part of the redirect, not a word.
      if (inWord && !isQuoted && /^(\d+|\{[A-Za-z_]\w*\})$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      spend(groups.length);
      const doc = heredoc(text, index + 2, line.length, [...groups]);
      if (doc) {
        // Right after a group closes, the heredoc is the group's input: `{ read a; } <<EOF`,
        // `while read l; do x; done <<EOF` (there the closing word leads the command).
        if (closed && withoutRedirects(words).length === (closed.kind === '(' || closed.kind === '{' ? 0 : 1)) doc.doc.group = closed;
        pending.push(doc.doc);
        index = doc.end;
      } else {
        words.push('<<'); // no word after it: bash calls that an error; read on
        index += 2;
      }
    } else if (character === '>' && inWord && !isOperatorStart(word, isQuoted)) {
      // An unquoted > inside a word starts a redirect, as in bash: `echo hi>f` is `echo hi >f` (#402).
      endWord();
      word = character;
      inWord = true;
      index++;
    } else {
      word += character;
      inWord = true;
      index++;
    }
  }
  finish();
  return closer ? -1 : text.length;
}

// Adds the bodies of `group` and of the groups closed inside it to `into`. Each closed group
// has one parent, and its bodies are taken once, so a deep nest of groups costs no more
// than its bodies.
function groupBodies(group: Group, into: string[]): void {
  const stack = [group];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    spend(1 + next.bodies.length);
    for (const body of next.bodies) into.push(body);
    for (const inner of next.inner) stack.push(inner);
    next.bodies = [];
    next.inner = [];
  }
}

// The end of a $'...' string: the next ' without a \ before it.
function closeAnsi(text: string, i: number): number {
  for (; i < text.length; i++) {
    spend(1);
    if (text[i] === '\\') i++;
    else if (text[i] === "'") return i;
  }
  return -1;
}

// What readDouble returns when a substitution inside never closed: that read went on to the
// end of the text, so the caller must not read the rest again.
const RAN_OUT = Symbol('ran out');

// Reads "..." from after the opening quote. $(...) and `...` inside it run, so they are
// read as commands. Returns the word's text and the index after the closing quote, or null
// when it never closes (RAN_OUT when a substitution in it never closes). With `toEnd` there is no closing quote: it reads a heredoc body.
function readDouble(text: string, index: number, depth: number, out: string[][], toEnd = false, substitutions: string[] = []): { value: string; end: number } | typeof RAN_OUT | null {
  let value = '';
  while (index < text.length) {
    spend(1);
    const character = text[index];
    if (character === '"' && !toEnd) return { value, end: index + 1 };
    if (character === '\\') {
      // In "...", \ escapes only $ ` " \ and a line end. Before anything else it stays.
      const n = text[index + 1] ?? '';
      if (n && '$`"\\'.includes(n)) value += n;
      else if (n !== '\n') value += character + n;
      index += 2;
    } else if ((character === '$' && text[index + 1] === '(') || character === '`') {
      const from = character === '`' ? index + 1 : index + 2;
      const end = read(text, from, character === '`' ? '`' : ')', depth + 1, out);
      if (end === -1) return RAN_OUT;
      substitutions.push(text.slice(from, end - 1));
      value += text.slice(index, end);
      index = end;
    } else {
      value += character;
      index++;
    }
  }
  return toEnd ? { value, end: index } : null;
}

// Reads the word after << or <<-. A quoted word means the body is not expanded.
function heredoc(text: string, index: number, cmd: number, groups: Group[]): { doc: Heredoc; end: number } | null {
  const strip = text[index] === '-';
  if (strip) index++;
  while (text[index] === ' ' || text[index] === '\t') index++;
  let delim = '';
  let quoted = false;
  // A \r is part of the word, as in bash: `<<EOF\r` ends at a line `EOF\r`.
  while (index < text.length && !/[ \t\n;&|()<>]/.test(text[index])) {
    const character = text[index];
    // `<<$'EOF'` and `<<$"EOF"`: bash ends the body at EOF, without the $.
    if (character === '$' && (text[index + 1] === "'" || text[index + 1] === '"')) {
      index++;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = text.indexOf(character, index + 1);
      spend((end === -1 ? text.length : end) - index);
      if (end === -1) return null;
      delim += text.slice(index + 1, end);
      quoted = true;
      index = end + 1;
    } else if (character === '\\') {
      delim += text[index + 1] ?? '';
      quoted = true;
      index += 2;
    } else {
      delim += character;
      index++;
    }
  }
  return delim ? { doc: { delim, strip, quoted, cmd, groups }, end: index } : null;
}

// Reads the heredoc bodies that start at `index`, in order, and returns the index after the
// last one. A body is data, unless a shell or runner reads it (#196): the program of the
// command that holds the <<, or of a command it pipes into (`cat <<EOF | bash`). The
// program is found after assignments, keywords and launchers (see readsCommands), so
// `then bash <<EOF` and `env X=1 bash -s <<EOF` count, and `cat > sh <<EOF` or
// `node - <<EOF` do not. So does a command with no program (see feedsShell). A pipe left open at the line end (`cat <<EOF |`) counts too: its
// reader is on a later line. A group that closed on the line pipes its commands on
// (`{ cat <<EOF; } | bash`). Then the body is read as commands. A body in a group still
// open waits in the group: where the group sends its output decides (see `settle` in read).
// A heredoc right after a group closes is the group's input (`{ read a; } <<EOF`): it is
// commands when a command in the group reads commands, or the group pipes into one.
// An unquoted body still runs $(...) and `...`, so those are read too. A body with no end
// line runs to the end of the text, as in bash.
function bodies(text: string, index: number, docs: Heredoc[], { line, pipes, groups }: { line: string[][]; pipes: boolean[]; groups: Group[] }, depth: number, out: string[][]): number {
  // Once per line, from the last command back: where the pipeline from each command ends,
  // and whether a command from it to there reads commands. Each heredoc then looks it up.
  spend(line.length);
  const ends: number[] = [];
  const reads: boolean[] = [];
  for (let i = line.length - 1; i >= 0; i--) {
    const pipesOn = pipes[i] && i + 1 < line.length;
    ends[i] = pipesOn ? ends[i + 1] : i;
    reads[i] = readsCommands(line[i]) || (pipesOn && reads[i + 1]);
  }
  const handedTo = new Map<number, string | null>(); // what xargs runs, for each command that holds a heredoc
  for (const doc of docs) {
    const lines: string[] = [];
    while (index < text.length) {
      let nl = text.indexOf('\n', index);
      if (nl === -1) nl = text.length;
      spend(nl - index + 1);
      const ln = text.slice(index, nl);
      index = nl + 1;
      // As in bash, a line ends the body only when it is the word exactly: `EOF\r` does not.
      if ((doc.strip ? ln.replace(/^\t+/, '') : ln) === doc.delim) break;
      lines.push(ln);
    }
    const body = lines.join('\n');
    // `xargs git <<EOF`: the body's words are the program's words.
    if (!handedTo.has(doc.cmd)) handedTo.set(doc.cmd, xargsCommand(line[doc.cmd] ?? []));
    const handed = handedTo.get(doc.cmd) ?? null;
    if (handed !== null) out.push(...commandWords(`${handed} ${body.replace(/\s+/g, ' ')}`, depth + 1));
    const last = ends[doc.cmd] ?? doc.cmd;
    const isOpenPipe = last > doc.cmd && line[last].length === 0;
    const isRead = doc.group ? doc.group.reads : feedsShell(line[doc.cmd] ?? []);
    if (isOpenPipe || isRead || reads[doc.cmd] === true) {
      out.push(...commandWords(body, depth + 1));
      continue;
    }
    if (!doc.quoted) readDouble(body, 0, depth, out, true);
    doc.groups.findLast((group) => groups.includes(group))?.bodies.push(body);
  }
  return Math.min(index, text.length);
}

// A heredoc on a command with no program feeds the shell itself: `exec <<EOF`, `exec
// 3<<EOF; bash <&3`, or a bare redirect. A keyword (`done <<EOF`) hands it to its loop.
function feedsShell(words: string[]): boolean {
  return words.every((word) => !KEYWORDS.has(word) && !HEADS.has(word)) && findPrograms(words).length === 0;
}

// Programs that read their input as data, never as commands.
const DATA_READERS = new Set([
  'cat', 'tee', 'node', 'deno', 'bun', 'gh', 'git', 'yokoten', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq',
  'jq', 'yq', 'tr', 'cut', 'less', 'more', 'diff', 'patch', 'base64', 'xxd', 'od', 'column', 'fold', 'fmt', 'nl', 'paste', 'rev', 'iconv',
  'gzip', 'xz', 'zstd', 'bzip2', 'tar', 'curl', 'wget', 'mail', 'mailx', 'sendmail', 'pbcopy', 'xclip', 'wl-copy', 'clip', 'sponge',
  'read', 'mapfile', 'readarray', 'true', ':',
]);

// Whether a command reads its input as commands. The program is found after assignments,
// shell keywords and launchers (`then bash`, `stdbuf -oL bash`). When it is one of
// DATA_READERS, only a shell or runner up to it counts, so `cat > sh <<EOF` and
// `node x.ts --shell bash <<EOF` are data, and `sudo -s` still counts. When it is not, the
// guard does not know what the program does with its input, so a shell or runner anywhere
// in the command counts: `mystery-launcher bash <<EOF` is refused rather than guessed.
// The answer is kept per command: a line of heredocs and pipes asks again for the same one.
// An empty list is not kept: the reader may still fill it.
const readsCache = new WeakMap<string[], boolean>();

function readsCommands(words: string[]): boolean {
  const known = readsCache.get(words);
  if (known !== undefined) return known;
  const program = findPrograms(words)[0];
  let reads: boolean;
  // A program from a variable (`$line`) may be anything, so its input may run.
  if (program?.startsWith('$')) reads = true;
  else if (program === undefined || !DATA_READERS.has(programName(program))) reads = runnerAt(words) !== -1;
  else {
    const at = words.indexOf(program);
    reads = runnerAt(withoutRedirects(at === -1 ? words : words.slice(0, at + 1))) !== -1;
  }
  if (words.length > 0) readsCache.set(words, reads);
  return reads;
}

// The words with each redirect and its file taken out: `> sh cat` names no shell.
function withoutRedirects(words: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; ) {
    const length = redirectLength(words, index);
    if (length === 0) kept.push(words[index]);
    index += length || 1;
  }
  return kept;
}

// The old cut: quotes become spaces, then cut at ; | & ( ) and line ends. It finds more
// than is there, so it is only the fallback when nesting is too deep to follow.
function rough(text: string): string[][] {
  return text
    .replace(/['"`]/g, ' ')
    .split(/[;|&()\r\n]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}
