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

import type { Config, Env } from './config.ts';
import { matcher } from './config.ts';
import { type Finding, finding } from './message.ts';

/** A file edit, by path relative to the repo root. */
export function checkEdit(path: string, { config, env }: { config: Config; env: Env }): Finding | null {
  if (env.YOKOTEN_FIX_TASK === '1' && matcher(config.tests)(path)) {
    return finding('test-file', `${path} is a test file, and this is a fix task (YOKOTEN_FIX_TASK=1)`, 'if the test is wrong, stop and say so in your report');
  }
  if (env.YOKOTEN_ROLE === 'worker' && matcher(config.leadOnly)(path)) {
    return finding('lead-only', `${path} is lead-only (yokoten.json "leadOnly")`, 'stop and hand the change to the lead');
  }
  return null;
}

/**
 * A shell command, as the agent wrote it. `config` brings the programs the project blocks
 * (yokoten.json "commands.block"); without it, only the core rules apply.
 */
export function checkCommand(command: string, { env, config }: { env: Env; config?: Pick<Config, 'commands'> }): Finding | null {
  for (const words of commandWords(command)) {
    const reason = checkGit(words, env, config) ?? checkHooksEnvironment(words) ?? checkPublish(words, env) ?? checkBlocked(words, config?.commands.block ?? {});
    if (reason) return reason;
  }
  return null;
}

const RELEASE_FIX = 'if the owner asked for this, they start a new session with YOKOTEN_RELEASE_APPROVAL=1 (`YOKOTEN_RELEASE_APPROVAL=1 claude`); do not look for another way';
const release = (what: string) => finding('release', what, RELEASE_FIX);

const base = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
const isGit = (word: string) => /(^|[/\\])git(\.exe)?$/.test(word);
// Git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--git-dir', '--work-tree', '--namespace', '--attr-source']);

// Each check looks for its program anywhere in the command, so a prefix such as FOO=1,
// sudo, env, command, exec, time, nice, nohup, timeout or xargs does not hide it.
function checkGit(words: string[], env: Env, config?: Pick<Config, 'commands'>): Finding | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  const settings: string[] = [];
  const fromEnvironment: string[] = []; // --config-env name=VARIABLE
  let i = start + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-c') settings.push(words[i + 1] ?? '');
    if (words[i] === '--config-env') fromEnvironment.push(words[i + 1] ?? '');
    if (words[i].startsWith('--config-env=')) fromEnvironment.push(words[i].slice('--config-env='.length));
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);

  const hooks = checkHooksSettings(settings, fromEnvironment);
  if (hooks) return hooks;
  if (settings.some((s) => /^push\.followtags/i.test(s)) && !env.YOKOTEN_RELEASE_APPROVAL) {
    return release('git -c push.followTags pushes tags');
  }
  // `git -c alias.x='!cmd' x` runs cmd through a shell.
  for (const s of settings) {
    const alias = /^alias\.[^=]*=!(.*)$/is.exec(s);
    const reason = alias && checkCommand(alias[1], { env, config });
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
  if (sub === 'config') return checkConfig(args);
  return null;
}

// ---- The hooks setting (#114) ----
//
// git runs the commit check from core.hooksPath. Reading the setting is fine. Any value
// but .githooks turns the check off: for good with `git config`, or for one command with
// `git -c`, `--config-env` or GIT_CONFIG_KEY_n. Keys are case-insensitive, as in git.
// A value the guard cannot see (from a variable) blocks.

const HOOKS_DIR = '.githooks';
const isHooksPath = (key: string) => key.trim().toLowerCase() === 'core.hookspath';
const hooksPath = (what: string) => finding('hooks-path', what, 'leave it at .githooks; only the owner changes it');

// `git -c core.hooksPath=<value>` and `--config-env core.hooksPath=<VARIABLE>`.
function checkHooksSettings(settings: string[], fromEnvironment: string[]): Finding | null {
  if (fromEnvironment.some((s) => isHooksPath(s.split('=')[0]))) {
    return hooksPath('git --config-env core.hooksPath sets the hooks folder from a variable, which can skip the commit check');
  }
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
  for (const [index, word] of words.entries()) {
    const variable = /^GIT_CONFIG_(KEY_(\d+)|PARAMETERS)=(.*)$/is.exec(word);
    if (!variable) continue;
    const isPrefix = words.slice(0, index).every((w) => isAssignment(w) || w.startsWith('-') || ASSIGNERS.has(base(w)));
    if (!isPrefix && !words.slice(index + 1).some(isGit)) continue;
    const [, name, number, setting] = variable;
    if (name.toUpperCase() === 'PARAMETERS') {
      if (setting.toLowerCase().includes('core.hookspath')) return hooksPath('GIT_CONFIG_PARAMETERS names core.hooksPath, which can skip the commit check');
      continue;
    }
    if (!isHooksPath(setting)) continue;
    const valueName = `git_config_value_${number}=`;
    const value = words.find((w) => w.toLowerCase().startsWith(valueName));
    if (value?.slice(valueName.length) !== HOOKS_DIR) {
      return hooksPath(`GIT_CONFIG_KEY_${number} names core.hooksPath with a value other than .githooks, which skips the commit check`);
    }
  }
  return null;
}

// `git config` options that take the next word as their value.
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l', 'get', 'list']);
const CONFIG_REMOVES = new Set(['--unset', '--unset-all', 'unset', '--edit', '-e', 'edit']);
const CONFIG_SECTIONS = new Set(['--rename-section', '--remove-section', 'rename-section', 'remove-section']);
// git 2.46 and later also takes a subcommand: `git config get|list|set|unset|...`.
const CONFIG_SUBCOMMANDS = new Set(['get', 'list', 'set', 'unset', 'edit', 'rename-section', 'remove-section']);

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
      options.push(args[i]);
      if (CONFIG_VALUE_OPTIONS.has(args[i])) i++;
    }
  }
  return { options, plain };
}

// `git config`: a read passes; a change to core.hooksPath passes only to .githooks.
function checkConfig(args: string[]): Finding | null {
  let { options, plain } = splitConfig(args, true);
  const subcommand = CONFIG_SUBCOMMANDS.has(plain[0]) ? plain[0] : undefined;
  if (subcommand) {
    const rest = splitConfig(plain.slice(1), false);
    options = [...options, ...rest.options];
    plain = rest.plain;
  }
  const actions = subcommand ? [subcommand] : options;
  const section = actions.find((a) => CONFIG_SECTIONS.has(a));
  if (section) {
    return plain.some((w) => w.toLowerCase() === 'core') ? hooksPath(`git config ${section} core changes core.hooksPath, which turns off the commit check`) : null;
  }
  if (!isHooksPath(plain[0] ?? '')) return null;
  const remove = actions.find((a) => CONFIG_REMOVES.has(a));
  if (remove) return hooksPath(`git config ${remove} core.hooksPath turns off the commit check`);
  if (actions.some((a) => CONFIG_READS.has(a))) return null;
  // A set: `git config <key> <value>`, --add, --replace-all or `git config set`.
  // With no value and no action, it is a read.
  const value = plain[1];
  const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
  if (value === undefined && !isSet) return null;
  return value === HOOKS_DIR ? null : hooksPath('changing core.hooksPath turns off the commit check');
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

// ---- Programs the project blocks (#192) ----
//
// yokoten.json "commands.block" names programs no agent runs here, each with its reason.
// Only a program counts, so `echo python` and `cat python.md` pass. A command can run
// more than one program, and `findPrograms` lists each:
//
// - the first word after assignments (FOO=1) and shell keywords (`then`, `do`, `!`);
// - after a launcher that runs the next word as a program (env, sudo, nice, timeout,
//   xargs, stdbuf, setsid, busybox and the others in LAUNCHERS), the word after its
//   options;
// - the program after `find ... -exec`, `-execdir`, `-ok` and `-okdir`;
// - the programs of the string `env -S` splits.
//
// A shell string (`bash -c '...'`) is read by commandWords.

// Shell keywords before a program: `if x`, `then x`, `do x`, `! x`. `time` is a launcher.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', 'esac', '!', '{', '}', '(']);
// A loop or case head names a variable and data, not a program: `for f in a b`.
const HEADS = new Set(['for', 'select', 'case', 'in']);

// Each launcher, with the options that take the next word as their value, and how many
// plain words come before the program (timeout's duration, chrt's priority, taskset's mask).
const LAUNCHERS: Record<string, { options: string[]; operands?: number }> = {
  env: { options: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'] },
  sudo: { options: ['-u', '--user', '-g', '--group', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'] },
  doas: { options: ['-u', '-C'] },
  pkexec: { options: ['--user'] },
  command: { options: [] },
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

/** A program's name: no folder and no .exe. */
const programName = (word: string) => base(word).replace(/\.exe$/i, '');

// The string `env -S` splits into a command, from the option at `index`, or undefined.
function splitString(words: string[], index: number): string | undefined {
  const option = words[index];
  const long = /^--split-string(?:=(.*))?$/s.exec(option);
  if (long) return long[1] ?? words[index + 1];
  const short = /^-[a-zA-Z]*S(.*)$/s.exec(option);
  if (short) return short[1] || words[index + 1];
  return undefined;
}

/** The words that name the programs a command runs, in order. */
function findPrograms(words: string[]): string[] {
  const programs: string[] = [];
  // commandWords reads `bash -c 'x'` again as `-c x`: the shell's options come first.
  let index = words.findIndex((word) => !word.startsWith('-'));
  if (index === -1) return programs;
  while (index < words.length) {
    while (index < words.length && (isAssignment(words[index]) || KEYWORDS.has(words[index]))) index++;
    if (index >= words.length || HEADS.has(words[index])) return programs;
    const name = programName(words[index]);
    if (!Object.hasOwn(LAUNCHERS, name)) {
      programs.push(words[index]);
      if (name === 'find') {
        for (let action = index + 1; action < words.length; action++) {
          if (FIND_ACTIONS.has(words[action])) programs.push(...findPrograms(words.slice(action + 1)));
        }
      }
      return programs;
    }
    const launcher = LAUNCHERS[name];
    index++;
    // `command -v x` only says where x is; it does not run it.
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[index] ?? '')) return programs;
    while (index < words.length && words[index].startsWith('-')) {
      const split = name === 'env' ? splitString(words, index) : undefined;
      if (split !== undefined) programs.push(...commandWords(split).flatMap(findPrograms));
      index += launcher.options.includes(words[index]) ? 2 : 1;
    }
    index += launcher.operands ?? 0;
  }
  return programs;
}

function checkBlocked(words: string[], blockList: Record<string, string>): Finding | null {
  const name = findPrograms(words).map(programName).find((program) => Object.hasOwn(blockList, program));
  if (name === undefined) return null;
  const reason = blockList[name].trim().replace(/\.+$/, '');
  return finding('blocked-command', `\`${name}\` is blocked in this project`, 'use the project\'s own stack instead; yokoten.json "commands.block" lists what is blocked', { why: reason });
}

// ---- Reading bash ----
//
// A small reader for everyday bash, not a full parser. It turns command text into a list
// of commands, each a list of words.
//
// - Quotes: '...', "..." (with \ escapes), $'...' and $"..." are part of one word. A
//   separator inside them does not cut the command.
// - Separators: ; & && || | |& ( ) { } and line ends. A \ before a line end joins lines.
// - A word that starts with # begins a comment, to the line end.
// - $(...), `...`, <(...) and >(...) run, so their text is read as commands, even in "...".
// - A heredoc body is data, unless a shell reads it (see `bodies`).
// - A shell, eval or ssh runs a string, so the words after it are read again as commands.
//
// When the text is unclear, the guard blocks rather than guesses. An unclosed quote is
// dropped and the rest is read as plain words, so `echo 'x; npm publish` still blocks.
// Functions and aliases are not followed.

const MAX_DEPTH = 8;
const isShell = (word: string) => /^(?:ba|da|z|k|c|tc|fi|pw)?sh(?:\.exe)?$/.test(base(word));
// Programs that run a later word through a shell, beside the shells. A pattern means only
// with that option: sudo and doas pass their words to a program unless given -s or -i,
// and env unless given -S. xargs, nohup, time and the like run a program, not a shell
// string, so their words are already checked where they stand.
const RUNNERS: Record<string, RegExp | null> = {
  eval: null, ssh: null, su: null, runuser: null, watch: null, script: null, flock: null, parallel: null, tmux: null, screen: null,
  sudo: /^(-[a-zA-Z]*[si]|--shell|--login)/, doas: /^-[a-zA-Z]*s/, env: /^(-[a-zA-Z]*S|--split-string)/,
};

// Where a shell or a runner stands in the command, or -1. Anywhere counts: `find -exec sh
// -c`, `xargs sh -c` and `sudo bash -c` all run a string.
function runnerAt(words: string[]): number {
  return words.findIndex((w, i) => {
    if (isShell(w)) return true;
    const name = base(w);
    if (!Object.hasOwn(RUNNERS, name)) return false;
    const option = RUNNERS[name];
    return option === null || words.slice(i + 1).some((a) => option.test(a));
  });
}

/** Every command the text runs, as lists of words. Text that runs inside a command is listed too. */
export function commandWords(text: string, depth = 0): string[][] {
  const out: string[][] = [];
  read(text, 0, '', depth, out);
  return out;
}

interface Heredoc {
  delim: string;
  strip: boolean;
  quoted: boolean;
  /** The index, on its line, of the command that holds the <<. */
  cmd: number;
}

// Reads commands from `start` until `closer` (`)` or a backtick) or the end, and adds them
// to `out`. Returns the index after the closer, or -1 if a closer was wanted and not found.
function read(text: string, start: number, closer: string, depth: number, out: string[][]): number {
  // Too deep to follow: fall back to the rough cut, which finds more than is there.
  if (depth > MAX_DEPTH) {
    out.push(...rough(text.slice(start)));
    return text.length;
  }
  const nested = (s: string) => out.push(...commandWords(s, depth + 1));
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let line: string[][] = []; // the commands so far on this line, for heredocs
  let pipes: boolean[] = []; // for each of them, whether it pipes into the next
  let pending: Heredoc[] = [];
  let piped: string[] | null = null; // the command before a |

  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (pipe = false) => {
    endWord();
    line.push(words);
    pipes.push(pipe);
    if (words.length === 0) return;
    out.push(words);
    const at = runnerAt(words);
    if (at !== -1) {
      // `bash -c 'x'`, `eval "x"`, `ssh host 'x'`: read the words after it as commands.
      nested(words.slice(at + 1).join(' '));
      // `echo 'npm publish' | bash`: the words before the pipe are the shell's input.
      if (piped) nested(piped.slice(1).join(' ').replace(/\\n/g, '\n'));
    }
    piped = pipe ? words : null;
    words = [];
  };

  let index = start;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (closer && character === closer) {
      endCommand();
      return index + 1;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      endWord();
      index++;
    } else if (character === '\n') {
      endCommand();
      index = pending.length ? bodies(text, index + 1, pending, line, pipes, depth, out) : index + 1;
      pending = [];
      line = [];
      pipes = [];
    } else if (character === '#' && !inWord) {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '\\') {
      if (next !== '\n') {
        word += next ?? character;
        inWord = true;
      }
      index += 2;
    } else if (character === "'" || (character === '$' && next === "'")) {
      // '...' is as written. $'...' takes \ escapes, so \' does not close it.
      const ansi = character === '$';
      const open = ansi ? index + 1 : index;
      const end = ansi ? closeAnsi(text, open + 1) : text.indexOf("'", open + 1);
      if (end === -1) index = open + 1; // unclosed: drop the quote and read on
      else {
        const body = text.slice(open + 1, end);
        word += ansi ? body.replace(/\\(.)/gs, '$1') : body;
        inWord = true;
        index = end + 1;
      }
    } else if (character === '"' || (character === '$' && next === '"')) {
      const open = character === '$' ? index + 1 : index;
      const quoted = readDouble(text, open + 1, depth, out);
      if (!quoted) index = open + 1; // unclosed: drop the quote and read on
      else {
        word += quoted.value;
        inWord = true;
        index = quoted.end;
      }
    } else if ((character === '$' || character === '<' || character === '>') && next === '(') {
      // $(...), $((...)), <(...) and >(...): the inside runs on its own.
      const end = read(text, index + 2, ')', depth + 1, out);
      if (end === -1) {
        endCommand(); // unclosed: cut here and read on
        index += 2;
      } else {
        word += text.slice(index, end);
        inWord = true;
        index = end;
      }
    } else if (character === '`') {
      const end = read(text, index + 1, '`', depth + 1, out);
      inWord = true;
      index = end === -1 ? index + 1 : end;
    } else if (character === '(') {
      // A subshell or (( maths )): read the inside on its own, so a << there is no heredoc.
      endWord();
      const end = read(text, index + 1, ')', depth + 1, out);
      if (end === -1) endCommand();
      index = end === -1 ? index + 1 : end;
    } else if (character === ')' || character === ';' || ((character === '{' || character === '}') && !inWord && /[\s;]|^$/.test(next ?? ''))) {
      // A group `{ a; }` cuts like a separator. A brace inside a word (${x}, a{b,c}) does not.
      endCommand();
      index++;
    } else if (character === '&') {
      if (next === '>' || word.endsWith('>')) {
        // &> and >& are redirects, not separators.
        word += character;
        inWord = true;
        index++;
      } else {
        endCommand();
        index += next === '&' ? 2 : 1;
      }
    } else if (character === '|') {
      endCommand(next !== '|');
      index += next === '|' || next === '&' ? 2 : 1;
    } else if (character === '<' && next === '<' && text[index + 2] === '<') {
      // A here-string is one more word. A shell that reads it is a runner, so it is read.
      endWord();
      words.push('<<<');
      index += 3;
    } else if (character === '<' && next === '<' && !word.endsWith('<')) {
      endWord();
      const doc = heredoc(text, index + 2, line.length);
      if (doc) {
        pending.push(doc.doc);
        index = doc.end;
      } else {
        words.push('<<'); // no word after it: bash calls that an error; read on
        index += 2;
      }
    } else {
      word += character;
      inWord = true;
      index++;
    }
  }
  endCommand();
  return closer ? -1 : text.length;
}

// The end of a $'...' string: the next ' without a \ before it.
function closeAnsi(text: string, i: number): number {
  for (; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === "'") return i;
  }
  return -1;
}

// Reads "..." from after the opening quote. $(...) and `...` inside it run, so they are
// read as commands. Returns the word's text and the index after the closing quote, or null
// when it never closes. With `toEnd` there is no closing quote: it reads a heredoc body.
function readDouble(text: string, index: number, depth: number, out: string[][], toEnd = false): { value: string; end: number } | null {
  let value = '';
  while (index < text.length) {
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
      if (end === -1) return null;
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
function heredoc(text: string, index: number, cmd: number): { doc: Heredoc; end: number } | null {
  const strip = text[index] === '-';
  if (strip) index++;
  while (text[index] === ' ' || text[index] === '\t') index++;
  let delim = '';
  let quoted = false;
  while (index < text.length && !/[\s;&|()<>]/.test(text[index])) {
    const character = text[index];
    if (character === "'" || character === '"') {
      const end = text.indexOf(character, index + 1);
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
  return delim ? { doc: { delim, strip, quoted, cmd }, end: index } : null;
}

// Reads the heredoc bodies that start at `index`, in order, and returns the index after the
// last one. A body is data, unless a shell or runner reads it (#196): the program of the
// command that holds the <<, or of a command it pipes into (`cat <<EOF | bash`). The
// program is found after assignments and wrappers, so `nice -n 10 bash <<EOF` and
// `env X=1 bash -s <<EOF` count, and `cat > sh <<EOF` or `node - <<EOF` do not. A pipe
// left open at the line end (`cat <<EOF |`) counts too: its reader is on a later line.
// Then the body is read as commands. An unquoted body still runs $(...) and `...`, so
// those are read too. A body with no end line runs to the end of the text, as in bash.
function bodies(text: string, index: number, docs: Heredoc[], line: string[][], pipes: boolean[], depth: number, out: string[][]): number {
  for (const doc of docs) {
    const lines: string[] = [];
    while (index < text.length) {
      let nl = text.indexOf('\n', index);
      if (nl === -1) nl = text.length;
      const ln = text.slice(index, nl);
      index = nl + 1;
      if ((doc.strip ? ln.replace(/^\t+/, '') : ln).replace(/\r$/, '') === doc.delim) break;
      lines.push(ln);
    }
    const body = lines.join('\n');
    let last = doc.cmd;
    while (pipes[last] && last + 1 < line.length) last++;
    const readers = line.slice(doc.cmd, last + 1);
    const isOpenPipe = readers.length > 1 && readers[readers.length - 1].length === 0;
    if (isOpenPipe || readers.some(readsCommands)) out.push(...commandWords(body, depth + 1));
    else if (!doc.quoted) readDouble(body, 0, depth, out, true);
  }
  return Math.min(index, text.length);
}

// Whether a command reads its input as commands: its program is a shell or a runner, after
// assignments and wrappers (`sudo -s` and `env -S` count, as runners).
function readsCommands(words: string[]): boolean {
  const program = findPrograms(words)[0];
  const at = program === undefined ? -1 : words.indexOf(program);
  return runnerAt(at === -1 ? words : words.slice(0, at + 1)) !== -1;
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
