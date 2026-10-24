import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { homeOf } from '../../privacy.ts';
import { type Env } from '../../config.ts';
import { globMatches, braceForms, base, isGit, ASSIGNERS, isAssignment, withoutShellRedirects, realPath, KEYWORDS, LAUNCHERS, programName, findPrograms, findProgramPlaces, REDIRECT, REDIRECT_OPERATOR, redirectLength } from '../bash/read/words.ts';
import { isShell } from '../bash/read/run.ts';
import { MARK_WRITERS, RUNS_CODE, findWrites, protectedGitDirs } from '../worker/mark.ts';
import { HAS_GLOB } from '../worker/config-command.ts';
import { gitRootAbove, writeTargets, plainArgs, WRITERS, SETUP_WRITERS, gitParts } from '../lead-only/targets.ts';

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

export const HOOKS_DIR = '.githooks';
const HOOKS_FIX = 'leave it as it is; another folder is fine once its pre-commit runs `yokoten check` (`yokoten init` adds it there)';
export const isHooksPath = (key: string) => key.trim().toLowerCase() === 'core.hookspath';
export const hooksPath = (what: string, fix = HOOKS_FIX) => finding('hooks-path', what, fix);

// An include (`include.path`, `includeIf.<condition>.path`) reads another config file,
// which can set core.hooksPath without naming it (#358). Section and key are
// case-insensitive; the condition is not, and does not matter here.
export const isInclude = (key: string) => /^include(if\..*)?\.path$/is.test(key.trim());
export const includes = (what: string) =>
  hooksPath(`${what} reads another config file, which can set core.hooksPath and turn off the commit check`, 'set the setting you need by name, so the guard can check it');

// `git -c core.hooksPath=<value>` and `--config-env core.hooksPath=<VARIABLE>`.
export function checkHooksSettings(settings: string[], fromEnvironment: string[]): Finding | null {
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


export function checkHooksEnvironment(words: string[]): Finding | null {
  const lastGit = words.findLastIndex(isGit);
  let isPrefix = true; // every word before this one is an assignment, an option or an assigner
  for (const [index, word] of words.entries()) {
    const variable = /^GIT_CONFIG_(KEY_(\d+)|PARAMETERS)(\+?)=(.*)$/is.exec(word);
    const wasPrefix = isPrefix;
    isPrefix = isPrefix && (isAssignment(word) || word.startsWith('-') || ASSIGNERS.has(base(word)));
    if (!variable) continue;
    if (!wasPrefix && lastGit <= index) continue;
    const [, name, number, adds, setting] = variable;
    if (name.toUpperCase() === 'PARAMETERS') {
      if (setting.toLowerCase().includes('core.hookspath')) return hooksPath('GIT_CONFIG_PARAMETERS names core.hooksPath, which can skip the commit check');
      if (/include(if\.[^=]*)?\.path/i.test(setting)) return includes('GIT_CONFIG_PARAMETERS with an include');
      continue;
    }
    if (adds) return hooksPath(`GIT_CONFIG_KEY_${number}+= adds to a key yokoten can't see, which may make core.hooksPath and skip the commit check`);
    if (isInclude(setting)) return includes(`GIT_CONFIG_KEY_${number} ${setting.trim()}`);
    if (isHooksPath(setting)) return hooksPath(`GIT_CONFIG_KEY_${number} names core.hooksPath, which can skip the commit check`);
  }
  return null;
}

// ---- Settings an agent may not make (#361, #664) ----
//
// Some variables change what the commit check reads. HOME and USERPROFILE move the home
// folder, where the private marks are; GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and
// GIT_CONFIG_COUNT/KEY_n/VALUE_n give git settings the guard does not read one by one. A
// name counts as set:
// - for one program, by an assignment just before it, also after env, sudo or another
//   launcher: `HOME=x git commit`, `env HOME=x gh issue create`;
// - for the rest of the line, by an assignment with no program after it, by export,
//   declare and the like, by read, mapfile, printf -v, getopts, let, a for or select
//   loop, and by `${NAME:=x}` or `${NAME=x}`.
// A setting for the rest of the line is refused. A setting for one program is refused when
// that program is git, gh, yokoten, or a shell or eval that runs another line. Before any
// other program it passes: `HOME=$(mktemp -d) npm test` keeps a test away from your files.
// The guard reads names, not grammar: an indirect name (`export $name=x`) gets past.

/** A name a command sets, and the index of the one program it is set for (null: the rest of the line). */
type Setting = { name: string; program: number | null };

// Programs that run another command line, so a setting before them reaches git too.
const RUNS_LINES = /^(sh|bash|zsh|dash|ksh|mksh|fish|eval|source|\.|xargs|exec|su|sudo|doas|env|nohup|setsid|script)$/;
const isYokotenWord = (word: string) => /^yokoten(\.[cm]?[jt]s)?$/i.test(base(word));
// read, mapfile and readarray set every name after them; printf only the one after -v.
const NAME_READERS = new Set(['read', 'mapfile', 'readarray']);
const nameOf = (word: string) => word.slice(0, word.indexOf('=')).replace(/\+$/, '');

function settingsIn(words: string[]): Setting[] {
  const settings: Setting[] = [];
  const programs: number[] = [];
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    programs.push(at);
    from = at + 1;
  }
  // For each word: the program right after it, when only assignments, options and
  // launchers stand between them. One pass from the end keeps it linear.
  const isProgram = new Set(programs);
  const programAfter: number[] = new Array(words.length).fill(-1);
  let next = -1;
  for (let index = words.length - 1; index >= 0; index--) {
    if (isProgram.has(index)) {
      next = index;
      continue;
    }
    programAfter[index] = next;
    const word = words[index];
    if (!isAssignment(word) && !word.startsWith('-') && !Object.hasOwn(LAUNCHERS, programName(word))) next = -1;
  }
  let isPrefix = true; // every word before this one is an assignment, an option or an assigner
  for (const [index, word] of words.entries()) {
    const wasPrefix = isPrefix;
    isPrefix = isPrefix && (isAssignment(word) || word.startsWith('-') || ASSIGNERS.has(base(word)));
    if (isAssignment(word)) {
      if (programAfter[index] !== -1) settings.push({ name: nameOf(word), program: programAfter[index] });
      else if (wasPrefix) settings.push({ name: nameOf(word), program: null });
    }
    // `${NAME:=x}` and `${NAME=x}` set NAME wherever they stand.
    for (const [, name] of word.matchAll(/\$\{([A-Za-z_]\w*):?=/g)) settings.push({ name, program: null });
  }
  for (const at of programs) {
    const name = programName(words[at]);
    // The tail is long inside `find -exec find`. Copy it only for a program that reads names.
    if (!NAME_READERS.has(name) && name !== 'let' && name !== 'printf' && name !== 'getopts') continue;
    const args = words.slice(at + 1);
    if (NAME_READERS.has(name)) args.forEach((arg) => settings.push({ name: arg.replace(/^-[A-Za-z]*a/, ''), program: null }));
    if (name === 'let') args.filter(isAssignment).forEach((arg) => settings.push({ name: nameOf(arg), program: null }));
    if (name === 'printf') {
      args.forEach((arg, index) => {
        if (arg === '-v' && index + 1 < args.length) settings.push({ name: args[index + 1], program: null });
        else if (/^-v./.test(arg)) settings.push({ name: arg.slice(2), program: null });
      });
    }
    // `getopts optstring name`: the second plain word.
    if (name === 'getopts') {
      const plain = args.filter((arg) => !arg.startsWith('-'));
      if (plain[1] !== undefined) settings.push({ name: plain[1], program: null });
    }
  }
  // `for NAME in ...` and `select NAME in ...`: only the name slot.
  const head = words.findIndex((word) => !KEYWORDS.has(word));
  if ((words[head] === 'for' || words[head] === 'select') && words[head + 1] !== undefined) settings.push({ name: words[head + 1], program: null });
  return settings;
}

/**
 * The settings in `words` whose name passes `isNamed`, that the rule refuses: see above.
 * `guards` replaces the usual program test (git, gh, yokoten, a shell). A setting for the
 * rest of the line is refused when `includeRest` is set, which it is unless a caller says
 * the script never reaches the check.
 */
function refusedSetting(words: string[], isNamed: (name: string) => boolean, guards?: (at: number) => boolean, includeRest = true): string | null {
  const settings = settingsIn(words).filter((setting) => isNamed(setting.name));
  if (settings.length === 0) return null;
  const lastYokoten = words.findLastIndex(isYokotenWord);
  const runsGuarded = guards ?? ((at: number) => isGit(words[at]) || ['gh', 'yokoten'].includes(programName(words[at])) || RUNS_LINES.test(programName(words[at])) || lastYokoten >= at);
  return settings.find((setting) => (includeRest && setting.program === null) || (setting.program !== null && runsGuarded(setting.program)))?.name ?? null;
}

// git's config variables (#361). GIT_CONFIG_PARAMETERS is read above, for core.hooksPath.
const GIT_CONFIG_NAME = /^GIT_CONFIG_(GLOBAL|SYSTEM|COUNT|KEY_\d+|VALUE_\d+)$/i;

export function checkGitConfigEnvironment(words: string[]): Finding | null {
  const name = refusedSetting(words, (setting) => GIT_CONFIG_NAME.test(setting));
  if (name === null) return null;
  const shown = name.toUpperCase().replace(/_\d+$/, '_n');
  const what = /_(GLOBAL|SYSTEM)$/.test(shown) ? 'points git at another config file' : 'sets git settings yokoten does not read one by one';
  return hooksPath(`${shown} ${what}, which can set core.hooksPath and skip the commit check`, 'run git without it; to set one setting for one command, use `git -c <name>=<value>`, which the guard can check');
}

// ---- Shell writes to git's config and hooks (#361) ----
//
// `git config` is read setting by setting above. A shell write to the same files is not:
// `printf '[core]\nhooksPath=x' >> .git/config`, `sed -i` on it, or `rm`/`chmod -x` on
// `.githooks/pre-commit` can each turn the commit check off. So a command that names
// `.git/config`, `.git/commondir`, `.git/hooks` or `.githooks` as a file it writes is
// refused, for lead and worker: a redirect, the files of the writers in WRITERS (cp, mv,
// tee, sed -i, rm, ln, install, truncate, patch, vim, tar -C, ...) and of chmod and the
// rest of MARK_WRITERS. `mkdir` passes, and so do the lead's `git checkout` and
// `git restore`, which bring back the committed hook. A path is placed from the likely
// folder, so `cd .git && echo >> config` is refused, and one in another repo (`/tmp/x/.git`)
// passes. A path with a glob (`*?[{`) is refused when it could reach into `.git` or `.githooks`.
// A read (`cat .git/config`, `git config --get`) writes nothing and passes.
const GIT_SETUP_FILE = /(^|\/)\.git(\/?$|\/config(\.worktree)?$|\/hooks(\/|$)|\/commondir$|\/worktrees\/[^/]+\/(config\.worktree|commondir)$)|(^|\/)\.githooks(\/|$)/i;
const GIT_SETUP_FIX = 'change a git setting with `git config <name> <value>`, and a hook with your edit tool or `yokoten init`, so the guard can check it';

// Whether a path, as text, may be git's config or hooks; with a glob, whether it could match one.
function namesGitSetup(path: string): boolean {
  const plain = posix.normalize(path.replace(/\\/g, '/'));
  if (GIT_SETUP_FILE.test(plain)) return true;
  if (!HAS_GLOB.test(plain)) return false;
  return braceForms(plain, 0).some((form) => {
    const parts = form.split('/');
    return parts.some((part, at) =>
      // A glob for the .git folder itself (`chmod 000 .gi?`) is left to the other rules.
      (HAS_GLOB.test(part) && ((at < parts.length - 1 && globMatches(part, '.git')) || globMatches(part, '.githooks'))) ||
      (/^\.git(hooks)?$/i.test(part) && parts.slice(at + 1).some((rest) => HAS_GLOB.test(rest))) ||
      GIT_SETUP_FILE.test(form));
  });
}

const isInside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

export function checkGitSetupWrites(words: string[], { folder, from, env }: { folder: string | null; from: string | null; env: Env }): Finding | null {
  const known = new Map<string, string | null>();
  const isWorker = env.YOKOTEN_ROLE === 'worker';
  const targets = writeTargets(words, folder, (dir) => gitRootAbove(dir, known), { keepsRestores: isWorker }).map((target) => target.path);
  const findStarts = (args: string[]) => findWrites(args, (writer) => Object.hasOwn(WRITERS, writer) || Object.hasOwn(SETUP_WRITERS, writer) || MARK_WRITERS.has(writer) || RUNS_CODE.test(writer))?.starts ?? [];
  let at = 0;
  // Set when the outer find's tail has a write. Nested finds then add their own start folders.
  let findTailWrites = false;
  let findTailRead = false;
  for (const program of findPrograms(words)) {
    const index = words.indexOf(program, at);
    if (index === -1) continue;
    at = index + 1;
    const name = programName(program);
    const isMarkWriter = name !== 'mkdir' && MARK_WRITERS.has(name);
    const isSetupWriter = Object.hasOwn(SETUP_WRITERS, name);
    if (isMarkWriter || isSetupWriter) {
      const args = withoutShellRedirects(words, index + 1);
      if (isMarkWriter) targets.push(...plainArgs(args));
      if (isSetupWriter) targets.push(...SETUP_WRITERS[name](args));
    }
    // A find that writes changes files under where it starts: `find .githooks -exec rm {} +`.
    // Its tail holds every nested find. Read that tail once, unless it writes.
    if (name !== 'find') continue;
    if (!findTailRead) {
      findTailRead = true;
      const starts = findStarts(withoutShellRedirects(words, index + 1));
      findTailWrites = starts.length > 0;
      targets.push(...starts);
      continue;
    }
    if (findTailWrites) targets.push(...findStarts(withoutShellRedirects(words, index + 1)));
  }
  if (targets.length === 0) return null;
  // The repo the command starts in, and its git folders: a placed path outside them all is
  // another repo's file, such as a test repo in /tmp.
  const root = from === null ? null : gitRootAbove(from, known);
  const held = root === null ? [] : [realPath(root), ...protectedGitDirs(from ?? root)];
  const home = homeOf(env);
  const target = targets.find((path) => {
    const expanded = /^~(?=[\\/]|$)/.test(path) ? (home === null ? null : join(home, path.slice(1))) : path;
    const isPlaced = expanded !== null && !/[$`]/.test(path) && (folder !== null || isAbsolute(expanded));
    if (!isPlaced || held.length === 0) return namesGitSetup(path);
    const full = realPath(resolve(folder ?? '/', expanded));
    const holders = held.filter((dir) => isInside(full, dir));
    if (holders.length === 0) return false;
    // Inside the work tree, the path from its root; inside a git folder, the path in `.git`.
    const inside = (dir: string) => relative(dir, full).split(sep).join('/');
    return holders.some((dir) => namesGitSetup(dir === held[0] ? inside(dir) || '.' : posix.join('.git', inside(dir)))) || namesGitSetup(path);
  });
  return target === undefined ? null : hooksPath(`this command changes ${target}, which holds git's settings or the commit check`, GIT_SETUP_FIX);
}

// ---- The home folder (#664) ----
//
// The commit check and the guard for gh posts read the private marks from the home folder:
// HOME, or USERPROFILE on Windows when HOME is not set. `HOME=/tmp/x git commit` would make
// them look in another folder, find no marks and pass. So the guard refuses these names
// where the settings rule above does. Names on Windows ignore case, so `home=` counts too.
// Reading $HOME is fine. For the lead, XDG_CONFIG_HOME moves nothing these checks read, so
// it passes. A worker may not set it before the commit check: see checkWorkerRealHome (#739).
const HOME_NAMES = new Set(['HOME', 'USERPROFILE']);
const HOME_FIX = 'run the command without changing the home folder; yokoten reads the private marks from your own home';

export function checkHomeSetting(words: string[], env: Env): Finding | null {
  const name = refusedSetting(words, (setting) => HOME_NAMES.has(setting.toUpperCase()));
  if (name !== null) return finding('home-folder', `this command sets ${name}, which moves where yokoten finds your private marks`, HOME_FIX);
  // A worker unsets only when the script reaches the commit check: see checkWorkerRealHome.
  if (env.YOKOTEN_ROLE === 'worker') return null;
  const cleared = clearedHomeName(words, HOME_NAMES);
  return cleared === null ? null : finding('home-folder', `this command unsets ${cleared}, which moves where yokoten finds your private marks`, HOME_FIX);
}

/**
 * A home name this command clears, or null (#739). `unset NAME` holds for the rest of the
 * line, like `export`. `env -u NAME` clears it for the one program after `env`, and only
 * when that program is git, gh, yokoten or a shell. `env -u HOME npm test` stays allowed.
 */
function clearedHomeName(words: string[], names: Set<string>): string | null {
  const isHome = (name: string) => names.has(name.toUpperCase());
  const fromUnset = (args: string[]): string | null => {
    for (const arg of args) {
      if (!arg.startsWith('-') && isHome(arg)) return arg;
    }
    return null;
  };
  // env's own options, from the word after `env` to the program it runs. A cluster is read
  // here: findPrograms does not treat `-iu` as `-u`, so `env -iu HOME git` would hide git.
  const readEnv = (start: number): { cleared: string | null; program: number | null } => {
    let cleared: string | null = null;
    let index = start;
    while (index < words.length) {
      const word = words[index];
      if (isAssignment(word)) {
        index += 1;
        continue;
      }
      if (!word.startsWith('-')) return { cleared, program: index };
      const inline = /^--unset=(.*)$/.exec(word);
      if (inline) {
        if (cleared === null && isHome(inline[1])) cleared = inline[1];
        index += 1;
        continue;
      }
      if (word === '--unset') {
        const next = words[index + 1] ?? '';
        if (cleared === null && isHome(next)) cleared = next;
        index += next === '' ? 1 : 2;
        continue;
      }
      // `-u NAME`, `-uNAME`, and a cluster whose last flag is `u` (`-iuHOME`, `-iu HOME`).
      const cluster = /^-([a-zA-Z]*)u(.*)$/.exec(word);
      if (cluster) {
        const rest = cluster[2];
        if (rest === '') {
          const next = words[index + 1] ?? '';
          if (cleared === null && isHome(next)) cleared = next;
          index += next === '' ? 1 : 2;
        } else {
          if (cleared === null && isHome(rest)) cleared = rest;
          index += 1;
        }
        continue;
      }
      // These take the next word. Skipping it keeps a later `-u HOME` visible.
      if (word === '-C' || word === '--chdir' || word === '-S' || word === '--split-string') {
        index += index + 1 < words.length ? 2 : 1;
        continue;
      }
      index += 1;
    }
    return { cleared, program: null };
  };
  const lastYokoten = words.findLastIndex(isYokotenWord);
  const guarded = (at: number) => isGit(words[at]) || ['gh', 'yokoten'].includes(programName(words[at])) || RUNS_LINES.test(programName(words[at])) || lastYokoten >= at;
  // One pass over the programs, then one pass over the words before the last of them.
  // Reading every earlier word once per program made `find -exec find` take quadratic time.
  let lastProgram = -1;
  for (const place of findProgramPlaces(words)) {
    if (place.index === -1) continue;
    if (place.index > lastProgram) lastProgram = place.index;
    if (programName(place.word) === 'unset') {
      const cleared = fromUnset(words.slice(place.index + 1));
      if (cleared !== null) return cleared;
    }
  }
  for (let cursor = 0; cursor < lastProgram; cursor++) {
    if (programName(words[cursor]) !== 'env') continue;
    const read = readEnv(cursor + 1);
    if (read.cleared !== null && read.program !== null && guarded(read.program)) return read.cleared;
  }
  return null;
}

// A worker's home before the commit check (#739). HOME and USERPROFILE move the marks file.
// XDG_CONFIG_HOME is the same door for a worker: the desk already refuses other settings, and
// this one must say why, before git commit, yokoten check, or a shell that runs them. The
// lead's XDG_CONFIG_HOME is left alone. The box still refuses every other setting.
// A shell script file is the same door with the assignment hidden in the file. The guard
// reads the command, not the file, so a worker's `bash file` or `sh file` is refused.
// `bash -c` stays, because that text is in the command.
const REAL_HOME_NAMES = new Set(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']);
const REAL_HOME_FIX = 'the commit check needs the real home; in a desk, the runner commits for you (issue #736)';
// Shell flags that do not name a file and do not take a value. `s` reads stdin, which the
// reader already has when the text is in the command. Anything else may name a file.
const SHELL_FLAG = /^-[euxnvfhlips]+$/;
const SHELL_LONG_FLAGS = new Set(['--posix', '--noprofile', '--norc', '--login', '--noediting', '--restricted', '--help', '--version']);

/** Whether the program at `at` is git commit, yokoten check, or a shell that can run them. */
function runsCommitCheck(words: string[], at: number): boolean {
  const program = words[at];
  if (RUNS_LINES.test(programName(program))) return true;
  if (isGit(program)) return gitParts(withoutShellRedirects(words, at + 1), null).sub === 'commit';
  const tail = words.slice(at);
  return tail.some(isYokotenWord) && tail.includes('check');
}

/** Whether any program in `words` is git commit, yokoten check, or a shell that can run them. */
function commandReachesCheck(words: string[]): boolean {
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (runsCommitCheck(words, at)) return true;
  }
  return false;
}

/** Whether `word` is a shell that can run a script file, in any case (`Bash`, `rbash`, `mksh`). */
function isScriptShell(word: string): boolean {
  const name = programName(word).toLowerCase();
  return isShell(name) || name === 'mksh' || name === 'rbash';
}

/**
 * Whether a shell's arguments hide the script (#739). `bash -c text` and `--command` are in
 * the command, so they are not hidden. A file operand, an input redirect (`< file`, not a
 * heredoc) and an option the guard does not know (`--rcfile`, `-o`) are hidden: the guard
 * cannot tell whether that file sets HOME, so it refuses.
 */
function shellOperandsHide(args: string[]): boolean {
  let index = 0;
  let inline = false;
  while (index < args.length) {
    const arg = args[index];
    if (REDIRECT.test(arg)) {
      const operator = REDIRECT_OPERATOR.exec(arg)?.[0] ?? '';
      if (operator.includes('<') && !operator.includes('<<') && !inline) return true;
      index += redirectLength(args, index) || 1;
      continue;
    }
    if (arg === '--') {
      if (!inline) return true;
      index += 1;
      continue;
    }
    if (arg === '-c' || arg === '--command') {
      const script = args[index + 1] ?? '';
      if (script === '' || REDIRECT.test(script)) return true;
      inline = true;
      index += 2;
      continue;
    }
    if (arg.startsWith('--command=')) {
      if (arg.length === '--command='.length) return true;
      inline = true;
      index += 1;
      continue;
    }
    // `-lc`, `-cecho hi`: `c` ends the flags, or the rest of the word is the script text.
    const cluster = /^-(?:[euxnvfhlips]*)c(.*)$/s.exec(arg);
    if (cluster && !arg.startsWith('--')) {
      const rest = cluster[1];
      if (rest === '') {
        const script = args[index + 1] ?? '';
        if (script === '' || REDIRECT.test(script)) return true;
        index += 2;
      } else index += 1;
      inline = true;
      continue;
    }
    if (SHELL_FLAG.test(arg) || SHELL_LONG_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-') || !inline) return true;
    index += 1;
  }
  return false;
}

/** Whether `words` runs a shell script the guard cannot read. The lead is not asked. */
function shellHidesScript(words: string[]): boolean {
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (isScriptShell(program) && shellOperandsHide(words.slice(at + 1))) return true;
  }
  return false;
}

/**
 * For a worker: a home setting that would hide the private marks from the commit check, or
 * null. A setting for the rest of the line counts only when this script reaches that check,
 * so `HOME+=x; rm` stays with the worker box (#591). A shell script file counts too: the
 * guard cannot read it, so it refuses instead of guessing.
 */
export function checkWorkerRealHome(commands: string[][]): Finding | null {
  const reaches = commands.some(commandReachesCheck);
  for (const words of commands) {
    const name = refusedSetting(words, (setting) => REAL_HOME_NAMES.has(setting.toUpperCase()), (at) => runsCommitCheck(words, at), reaches);
    if (name !== null) return finding('home-folder', `this command sets ${name}, so the commit check would not see your private marks`, REAL_HOME_FIX);
    if (reaches) {
      const cleared = clearedHomeName(words, REAL_HOME_NAMES);
      if (cleared !== null) return finding('home-folder', `this command unsets ${cleared}, so the commit check would not see your private marks`, REAL_HOME_FIX);
    }
    if (shellHidesScript(words)) return finding('home-folder', 'this command runs a shell script yokoten cannot read, so the commit check might not see your private marks', REAL_HOME_FIX);
  }
  return null;
}
