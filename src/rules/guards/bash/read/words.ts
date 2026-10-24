import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spend } from './run.ts';
import { commandWords } from './read.ts';

export function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// A regular file of at most DOT_GIT_LIMIT bytes, or null. It is opened without waiting, and
// Whether the shell glob `pattern` matches `name`, case aside: `*`, `?`, `[...]` and `{a,b}`
// as bash reads them. A leading dot is matched only by a dot, as with bash's dotglob off.
// It evaluates the glob, so `.gi?` is `.git`; it does not guess at text.
export function globMatches(pattern: string, name: string): boolean {
  if (pattern.toLowerCase() === name) return true;
  if (!/[*?[{]/.test(pattern)) return false;
  return braceForms(pattern, 0).some((form) => {
    if (name.startsWith('.') && !form.startsWith('.') && !form.startsWith('\\.')) return false;
    let source = '';
    for (let at = 0; at < form.length; at++) {
      const char = form[at];
      if (char === '\\' && at + 1 < form.length) source += escapeRegExp(form[++at]);
      else if (char === '*') source += '.*';
      else if (char === '?') source += '.';
      else if (char === '[') {
        const close = form.indexOf(']', at + 2);
        if (close === -1) source += '\\[';
        else {
          const inner = form.slice(at + 1, close).replace(/^[!^]/, '^').replace(/\\/g, '\\\\');
          source += `[${inner}]`;
          at = close;
        }
      } else source += escapeRegExp(char);
    }
    try {
      return new RegExp(`^${source}$`, 'is').test(name);
    } catch {
      return true; // a class the guard can't read may match
    }
  });
}

// The words a brace expansion makes, at most 64; `{a,b}` with no nesting.
export function braceForms(pattern: string, depth: number): string[] {
  const brace = /\{([^{}]*,[^{}]*)\}/.exec(pattern);
  if (!brace || depth > 6) return [pattern];
  const head = pattern.slice(0, brace.index);
  const tail = pattern.slice(brace.index + brace[0].length);
  return brace[1].split(',').flatMap((part) => braceForms(`${head}${part}${tail}`, depth + 1)).slice(0, 64);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
export const base = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
export const isGit = (word: string) => /(^|[/\\])git(\.exe)?$/.test(word);
// Git options that take the next word as their value.
export const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source']);
// `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=x git commit` does
// what `git -c` does, and so does GIT_CONFIG_PARAMETERS, the variable `-c` itself sets.
// An assignment counts when it stands before the program, after env, sudo or export, or
// anywhere before a git word. So `grep GIT_CONFIG_KEY_0=core.hooksPath file` is a read.
// `NAME+=value` counts as `NAME=value`. A key that names core.hooksPath is refused
// whatever value goes with it: any GIT_CONFIG_KEY_n is refused below anyway (#361).
export const ASSIGNERS = new Set(['env', 'sudo', 'doas', 'export', 'declare', 'typeset', 'readonly', 'local']);
// `NAME+=value` adds to a setting: it is an assignment too.
export const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
// A shell redirect is no argument to git: `git config core.hooksPath 2>/dev/null` reads
// the setting (#351). Only a redirect the reader saw with no quote in it is taken out, so
// `git config core.hooksPath '>x'` still sets the value ">x". Words that never went through
// the reader (an `env -S` string, the rough cut) have no marks, and keep every word.
export const unquotedRedirects = new WeakMap<string[], Set<number>>();
// The word lists the reader made: in them, a redirect with no mark is quoted text.
export const readWords = new WeakSet<string[]>();

// The words of `words` from `from` on, with each unquoted redirect and its file taken out.
export function withoutShellRedirects(words: string[], from: number): string[] {
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

// Whether a line may end the script, or hand it to a heredoc, before a later line runs.
// `exit 1` and `|| exit $?` stop the commit, so they do not count.
export function leaves(line: string): boolean {
  if (line.includes('<<')) return true;
  const rest = line.replace(/\|\|\s*(?:exit|return)\s+\$\?/g, '').replace(/(?<![\w.-])(?:exit|return)\s+[1-9]\d*(?![\w$])/g, '');
  return /(?<![\w.-])(?:exec|exit|return)(?![\w.-])/.test(rest);
}

// The script's command lines, as the shell reads them: a \ before a line end joins the
// lines, a quote stays open across lines, a comment is dropped, and a line after one that

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
export const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac', '!', '{', '}', '(']);
// A loop or case head names a variable and data, not a program: `for f in a b`.
export const HEADS = new Set(['for', 'select', 'case', 'in']);
// The words that open a compound command, each with the word that closes it.
export const COMPOUNDS: Record<string, 'fi' | 'done' | 'esac'> = { if: 'fi', while: 'done', until: 'done', for: 'done', select: 'done', case: 'esac' };

// Each launcher, with the options that take the next word as their value, and how many
// plain words come before the program (timeout's duration, chrt's priority, taskset's mask).
export const LAUNCHERS: Record<string, { options: string[]; operands?: number }> = {
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
  toybox: { options: [] },
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
export const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

// A redirect's operator, with the file descriptor before it.
export const REDIRECT_OPERATOR = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(?:>>|<<<|<>|>\||[<>]&|[<>])/;
// Whether a > read now goes on the word as part of its redirect: the word so far is only a
// file descriptor (`2`, `{fd}`), `&`, or one >, with no quote. Otherwise it starts a new word.
export const isOperatorStart = (word: string, isQuoted: boolean) => !isQuoted && /^(\d+|\{[A-Za-z_]\w*\}|&)?>?$/.test(word);
// A redirect: `>out`, `2>&1`, `&>>log`, `<in`, or one with its file in the next word (`> out`).
export const REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(?:>>|<<<|<>|>\||[<>]&|[<>])(.*)$/s;

/** How many words the redirect at `index` takes: 0 when the word is no redirect. */
export function redirectLength(words: string[], index: number): number {
  const redirect = REDIRECT.exec(words[index] ?? '');
  if (!redirect) return 0;
  return redirect[1] === '' && index + 1 < words.length ? 2 : 1;
}

/** The index of the first word at or after `index` that is not an assignment, a redirect or a keyword, at most `limit`. */
export function skipPrefix(words: string[], index: number, limit = words.length): number {
  while (index < limit) {
    if (isAssignment(words[index]) || KEYWORDS.has(words[index])) index++;
    else if (redirectLength(words, index) > 0) index = Math.min(index + redirectLength(words, index), limit);
    else break;
  }
  return index;
}

/** A program's name: no folder and no .exe. */
export const programName = (word: string) => base(word).replace(/\.exe$/i, '');

// The string `env -S` splits into a command, from the option at `index`, or undefined.
// A long option may be cut short, as getopt allows: `--split`, `--s`.
export function splitString(words: string[], index: number): string | undefined {
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
export const MAX_PROGRAMS = 256;

/** A program a command runs, and where that word sits. `-1` is an `env -S` program. */
interface ProgramPlace {
  word: string;
  index: number;
}

/** The words that name the programs a command runs, in order. */
export function findPrograms(words: string[]): string[] {
  return findProgramPlaces(words).map((place) => place.word);
}

/** The programs a command runs, each with its index in `words`. */
export function findProgramPlaces(words: string[]): { word: string; index: number }[] {
  spend(words.length);
  const programs: ProgramPlace[] = [];
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
// findProgramPlaces reads that one itself, so no word is walked once for each action before it.
function programAt(words: string[], index: number, programs: ProgramPlace[], isAction = false): number {
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
      programs.push({ word: words[index], index });
      return name === 'find' ? index : -1;
    }
    const launcher = LAUNCHERS[name];
    index++;
    // `command -v x` only says where x is; it does not run it.
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[index] ?? '')) return -1;
    while (index < limit && words[index].startsWith('-')) {
      const split = name === 'env' ? splitString(words, index) : undefined;
      if (split !== undefined) {
        for (const command of commandWords(split)) {
          for (const program of findProgramPlaces(command)) programs.push({ word: program.word, index: -1 });
        }
      }
      index += launcher.options.includes(words[index]) ? 2 : 1;
    }
    index += launcher.operands ?? 0;
  }
  return -1;
}

// ---- Heavy jobs (#401) ----
//
// A build, a test suite, a package install or a container build can fill a disk. When the
// kept reading of the Windows drive under a WSL disk file is low, the hook asks the owner
// before one of these starts. Only a program counts, as for a blocked command: a text that
// merely mentions `npm test` is no heavy job, and a shell the guard cannot read names none.

const PACKAGE_PROGRAMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_INSTALLS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'rebuild', 'link', 'dedupe', 'prune', 'pack']);
const PACKAGE_RUNS = new Set(['run', 'run-script']);
// A script whose name says it builds, tests or checks the project.
const HEAVY_SCRIPTS = /(^|[:._-])(build|test|lint|check|typecheck|verify|ci)([:._-]|$)/i;
// A program that is a heavy job on its own (`null`), or the subcommands that are one.
const HEAVY_PROGRAMS: Record<string, ReadonlySet<string> | null> = {
  make: null, ninja: null, bazel: null, cmake: null, meson: null, tsc: null,
  jest: null, vitest: null, mocha: null, pytest: null, phpunit: null, rspec: null,
  mvn: null, mvnw: null, gradle: null, gradlew: null, buildah: null,
  cargo: new Set(['build', 'test', 'check', 'clippy', 'bench', 'install']),
  go: new Set(['build', 'test', 'install', 'generate']),
  dotnet: new Set(['build', 'test', 'restore', 'publish', 'pack']),
  docker: new Set(['build', 'buildx', 'pull', 'run', 'compose']),
  podman: new Set(['build', 'pull', 'run', 'compose']),
  nerdctl: new Set(['build', 'pull', 'run', 'compose']),
};
// A version or help word asks nothing about the project.
const PROBES = new Set(['--version', '-v', '-V', '--help', '-h']);

/** The package manager's job when it installs or runs a build or test script, or null. */
function packageJob(name: string, args: string[]): string | null {
  const first = args.find((arg) => !arg.startsWith('-'));
  if (first === undefined) return null;
  if (PACKAGE_INSTALLS.has(first)) return `${name} ${first}`;
  if (first === 'test' || first === 'build') return `${name} ${first}`;
  if (name === 'npm' && first === 't') return 'npm test';
  if (!PACKAGE_RUNS.has(first)) return null;
  const script = args.slice(args.indexOf(first) + 1).find((arg) => !arg.startsWith('-'));
  return script !== undefined && HEAVY_SCRIPTS.test(script) ? `${name} ${first} ${script}` : null;
}

/** The heavy job the program at `index` runs, as a person reads it, or null. */
function heavyAt(words: string[], index: number): string | null {
  const program = programName(words[index]);
  const args = words.slice(index + 1);
  if (program === 'node') return args.some((arg) => arg === '--test' || arg.startsWith('--test=')) ? 'node --test' : null;
  if (PACKAGE_PROGRAMS.has(program)) return packageJob(program, args);
  const subcommands = HEAVY_PROGRAMS[program];
  if (subcommands === undefined) return null;
  if (args[0] !== undefined && PROBES.has(args[0])) return null;
  if (subcommands === null) return program;
  const sub = args.find((arg) => !arg.startsWith('-'));
  return sub !== undefined && subcommands.has(sub) ? `${program} ${sub}` : null;
}

/**
 * The heavy job `command` starts, such as `npm test`, or null. It reads the command's
 * programs, not its text, so `echo npm test` names none.
 */
export function findHeavyJob(command: string): string | null {
  try {
    for (const words of commandWords(command)) {
      for (const place of findProgramPlaces(words)) {
        const job = heavyAt(words, place.index);
        if (job !== null) return job;
      }
    }
  } catch {
    return null;
  }
  return null;
}
