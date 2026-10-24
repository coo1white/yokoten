import { isAbsolute, resolve, sep } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { homeOf } from '../../privacy.ts';
import { type Env } from '../../config.ts';
import { configFolder, configFinding, configForms, touchesConfig } from './config.ts';
import { gitLinkAbove, FIND_WRITES } from './mark.ts';
import { onlyReads, symlinkTargetReach, configReach } from './config-command.ts';
import { isGit, isAssignment, withoutShellRedirects, realPath, KEYWORDS, HEADS, LAUNCHERS, FIND_ACTIONS, REDIRECT, redirectLength, programName, findPrograms } from '../bash/read/words.ts';
import { plainArgs } from '../lead-only/targets.ts';

// ---- The worker's box (#591) ----
//
// Each review of the target reader found a new bash spelling past it (`$'\x2e'`, a glob in
// a `cd`, GIT_WORK_TREE set by `read`, `git diff --output`, LESSOPEN). The guard stops
// reading grammar for a worker and boxes it instead, by a small set of what is allowed:
// a `cd` only to a plain path inside its worktree, no `$'...'` or `${...@...}`, environment
// settings only from a short list, git with no option before its subcommand, and no
// output option on git, less or file. A command that still names the home config folder
// passes only when every program in it is a plain reader. Like the rest of the guard this
// reads text: a script the worker writes and then runs is out of its reach (issue #589).

/** The settings a worker may put before a command or export: none of them moves a folder or runs code. */
const WORKER_SETTINGS = new Set(['TZ', 'CI', 'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR', 'DEBUG', 'LANG', 'LC_ALL']);
const DECLARERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
const FOLDER_MOVERS = new Set(['cd', 'pushd', 'popd']);
const VARIABLE_SETTERS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'eval', 'source', '.']);
// A plain path: letters, digits, `.`, `_`, `/`, `-`, and `~` only as home at the start.
const PLAIN_PATH = /^(~(?=\/|$))?[A-Za-z0-9._/-]*$/;
// git options a worker may give before the subcommand: none of them moves a folder.
export const GIT_PLAIN_OPTIONS = new Set(['--no-pager', '-P', '--version', '--help']);
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
const GIT_CONFIG_WRITES = /^(--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e|set|unset|rename-section|remove-section|edit)$/;
const BOX_FIX = 'work inside your worktree with plain paths and no extra settings; if your task needs more, stop and ask the lead';
const boxFinding = (what: string) => finding('worker-mark', what, BOX_FIX);

/** Whether `name` is a long option `--x` that is `full`, an abbreviation of it, or longer (`--outp`, `--output-directory`). */
export function isLongOption(word: string, full: string): boolean {
  if (!word.startsWith('--')) return false;
  const name = word.slice(2).split('=')[0].toLowerCase();
  return name.length > 0 && (full.startsWith(name) || name.startsWith(full));
}

/** Whether `word` is a group of short options (`-Ro`) with any of `letters` in it. */
export const hasShortOption = (word: string, letters: string) => /^-[^-]/.test(word) && [...letters].some((letter) => word.slice(1).includes(letter));

/**
 * The first setting in `words` that a worker may not make, from `start` to `limit`: before
 * a command, after `env`, `sudo` or another launcher, or in export/declare/readonly/typeset/
 * local. An option to `env`, or a folder option to `sudo`, counts too. Null when all pass.
 */
function workerSettingAt(words: string[], start: number, limit = words.length): string | null {
  let index = start;
  while (index < limit) {
    for (;;) {
      const word = words[index];
      if (word === undefined || index >= limit) return null;
      if (isAssignment(word)) {
        if (!WORKER_SETTINGS.has(word.slice(0, word.indexOf('=')).replace(/\+$/, ''))) return word;
        index++;
      } else if (KEYWORDS.has(word)) index++;
      else if (redirectLength(words, index) > 0) index += redirectLength(words, index);
      else break;
    }
    if (HEADS.has(words[index])) return null;
    const name = programName(words[index]);
    if (DECLARERS.has(name)) {
      for (const arg of words.slice(index + 1, limit)) {
        const setting = arg.split('=')[0].replace(/\+$/, '');
        if (arg.startsWith('-') || !/^[A-Za-z_]\w*$/.test(setting) || !WORKER_SETTINGS.has(setting)) return arg;
      }
      return null;
    }
    if (!Object.hasOwn(LAUNCHERS, name)) return null;
    index++;
    if (name === 'env' && index < limit && words[index].startsWith('-')) return words[index];
    while (index < limit && words[index].startsWith('-')) {
      const option = words[index];
      if (['sudo', 'doas'].includes(name) && (option.startsWith('--c') || hasShortOption(option, 'D'))) return option;
      index += LAUNCHERS[name].options.includes(option) ? 2 : 1;
    }
    index += LAUNCHERS[name].operands ?? 0;
  }
  return null;
}

/** The command's text with quoted parts left out, for the characters that start a subshell. */
const withoutQuoted = (command: string) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');

/**
 * For a worker: why the command leaves the box, or null. `cwd` is the folder the command
 * starts in; the worktree is the checkout at or above it.
 */
export function checkWorkerBox(command: string, commands: string[][], { cwd, env }: { cwd: string | null; env: Env }): Finding | null {
  if (/\$'/.test(command)) return boxFinding("a worker can't use $'...' strings, which can spell any path; write the path plainly");
  if (/\$\{[^}]*@/.test(command)) return boxFinding("a worker can't use ${...@...} expansions, which can run or rename text; write the value plainly");
  if (/\$\{?OLDPWD\b/.test(command)) return boxFinding("a worker can't use $OLDPWD, which may be any folder; write the path plainly");
  if (commands.some((words) => words.some((word) => /^~([+-]?\d|-($|[\\/]))/.test(word)))) {
    return boxFinding("a worker can't use ~N, ~+N, ~-N or ~- (the directory stack); write the path plainly");
  }
  // Reads may name these; a command that does more than read may not.
  const pathWords = commands.filter((words) => !onlyReads(words)).flatMap((words) => words.map((word) => REDIRECT.exec(word)?.[1] ?? word));
  if (pathWords.some((word) => /^~[A-Za-z_]/.test(word.replace(/^[^=]*=/, '')))) {
    return boxFinding("a worker can't use ~name (another account's home); write the path plainly");
  }
  // These lead to a process's own folders, and the guard's process is not the shell's.
  if (pathWords.some((word) => /(^|[=/])(proc\/[^/]+\/(cwd|root|fd)|proc\/self|dev\/fd)(\/|$)/.test(word))) {
    return boxFinding("a worker can't use /proc/<id>/cwd, /proc/<id>/root, /proc/self or /dev/fd paths, which lead to another folder; write the path plainly");
  }
  const home = homeOf(env);
  const config = configFolder(env);
  // The box starts where the shell is: a shell already in or above the config folder has none.
  if (cwd !== null && config !== null && touchesConfig(resolve(cwd), configForms(config))) {
    return boxFinding("this shell is in or above yokoten's config folder (~/.config/yokoten); a worker works inside its worktree, so ask the lead to start you there");
  }
  const link = cwd === null ? null : gitLinkAbove(cwd);
  const box = cwd === null ? null : realPath(link ? link.top : cwd);
  let folder = cwd;
  const movesFolder = commands.some((words) => findPrograms(words).some((program) => FOLDER_MOVERS.has(programName(program))));
  // A cd in a subshell, a pipe or the background leaves the guard unsure where the next one starts.
  if (movesFolder && /[(){}`]|(^|[^|])\|(?!\|)|(^|[^&>])&(?![&>])/.test(withoutQuoted(command))) {
    return boxFinding("a worker's cd may not run in a subshell, a pipe or the background; run it on its own, joined with && or ;");
  }
  const forms = config === null ? [] : configForms(config);
  // A reader that follows symlinks, piped into xargs, could hand a config-folder path to a
  // writer the guard never sees spelled out.
  const hasXargs = commands.some((words) => words.some((word) => programName(word) === 'xargs'));
  const followsLinks = (words: string[]) => {
    const has = (name: string) => words.some((word) => programName(word) === name);
    if (has('find') && words.some((word) => /^-(H|L|follow)$/.test(word))) return true;
    if (['grep', 'egrep', 'fgrep', 'rg'].some(has) && words.some((word) => hasShortOption(word, 'R') || isLongOption(word, 'dereference-recursive'))) return true;
    return has('ls') && words.some((word) => hasShortOption(word, 'L'));
  };
  if (hasXargs && commands.some(followsLinks)) {
    return configFinding("a worker can't pipe a symlink-following read (find -L, grep -R, ls -L) into xargs: it could hand a writer a path inside yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept");
  }
  for (const words of commands) {
    const reach = configReach(words, { folder, home, forms });
    if (reach !== null) return reach;
    const setting = workerSettingAt(words, 0);
    if (setting !== null) return boxFinding(`a worker can't set ${setting.split('=')[0].replace(/\+$/, '')}: only ${[...WORKER_SETTINGS].join(', ')} may be set, so no setting moves a folder or runs a program`);
    for (const action of words.flatMap((word, at) => (FIND_ACTIONS.has(word) ? [at + 1] : []))) {
      const inner = workerSettingAt(words, action);
      if (inner !== null) return boxFinding(`a worker can't set ${inner.split('=')[0].replace(/\+$/, '')}: only ${[...WORKER_SETTINGS].join(', ')} may be set`);
    }
    let from = 0;
    for (const program of findPrograms(words)) {
      const at = words.indexOf(program, from);
      if (at === -1) continue;
      from = at + 1;
      const name = programName(program);
      const args = withoutShellRedirects(words, at + 1);
      if (FOLDER_MOVERS.has(name)) {
        // pushd and popd keep a stack of folders the guard does not follow; cd does the same job.
        if (name !== 'cd') return boxFinding(`a worker can't use ${name}, whose folder stack yokoten does not follow; run cd on its own`);
        if (args.some((arg) => /^-[LP]*P[LP]*$/.test(arg))) return boxFinding("a worker's cd may not use -P, which follows a link before a later ..; run cd without it");
        const paths = args.filter((arg) => !/^-L+$/.test(arg));
        const target = paths[0];
        if (paths.length !== 1 || target === '-' || target.startsWith('-') || !PLAIN_PATH.test(target) || target === '') {
          return boxFinding(`a worker's ${name} takes one plain path inside its worktree (letters, digits, . _ / - and a leading ~), not ${paths.join(' ') || 'no path'}`);
        }
        const expanded = target.startsWith('~') ? (home === null ? null : home + target.slice(1)) : target;
        const full = expanded === null ? null : isAbsolute(expanded) ? expanded : folder === null ? null : resolve(folder, expanded);
        const real = full === null ? null : realPath(full);
        if (real === null || box === null || (real !== box && !real.startsWith(box + sep))) {
          return boxFinding(`a worker's ${name} stays inside its worktree; ${target} is outside it, or yokoten can't tell where it goes`);
        }
        folder = full;
        continue;
      }
      if (isGit(program)) {
        let index = 0;
        while (GIT_PLAIN_OPTIONS.has(args[index] ?? '')) index++;
        if (args[index]?.startsWith('-')) return boxFinding(`a worker's git takes no ${args[index]} before the subcommand: it can move the folder git works in`);
        if (args.some((arg) => isLongOption(arg, 'output'))) return boxFinding('a worker\'s git may not write its output to a file (--output); print it instead');
        const sub = args[index];
        const rest = args.slice(index + 1);
        const isWrite = rest.some((arg) => GIT_CONFIG_WRITES.test(arg));
        // `git config user.name` with one name and no value reads it, as --get does.
        const isNameRead = plainArgs(rest).length === 1 && !rest.some((arg) => /^-/.test(arg) && !['--global', '--local', '--system', '--worktree', '--show-origin', '-z', '--null'].includes(arg));
        const isConfigRead = rest[0] === 'get' || rest[0] === 'list' || (!isWrite && (rest.some((arg) => GIT_CONFIG_READS.has(arg)) || isNameRead));
        if (sub === 'config' && !isConfigRead) return boxFinding('a worker\'s git config only reads (--get, --get-all, --list); the lead changes settings');
      }
      // Programs that set a variable named by a word, not by `NAME=`: the settings list can't see them.
      if (VARIABLE_SETTERS.has(name) || (name === 'printf' && args.some((arg) => hasShortOption(arg, 'v')))) {
        return boxFinding(`a worker can't run ${name}${name === 'printf' ? ' -v' : ''}, which can set any variable, git's and the shell's too; write values plainly`);
      }
      if (name === 'less' && args.some((arg) => arg.startsWith('+') || hasShortOption(arg, 'oO') || isLongOption(arg, 'log-file'))) {
        return boxFinding("a worker's less may not write a log file or run start-up commands (-o, -O, --log-file, +)");
      }
      if (name === 'file' && args.some((arg) => hasShortOption(arg, 'C') || isLongOption(arg, 'compile'))) return boxFinding("a worker's file may not compile a magic file (-C)");
      if (name === 'alias' && args.some((arg) => arg.includes('='))) return boxFinding("a worker can't define an alias, which can run any program under another name; run the program by its own name");
      if (folder !== null && forms.length && symlinkTargetReach(name, args, folder, home, forms)) {
        return configFinding(`a worker's ${name} may not make a link that leads into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`);
      }
      if (name === 'set' && args.some((arg, index) => /^[-+][A-Za-z]*P/.test(arg) || (args[index - 1] === '-o' && arg === 'physical'))) {
        return boxFinding("a worker can't turn on the shell's physical mode (set -P, set -o physical), where cd follows a link before a later ..");
      }
      if (name === 'hash' && args.some((arg) => hasShortOption(arg, 'p'))) return boxFinding("a worker can't run hash -p, which points a name at another program; run the program by its own path");
      if (name === 'enable' && args.some((arg) => arg.startsWith('-'))) return boxFinding('a worker can\'t turn a builtin on or off (enable with an option); run the program by its own name');
      if (['chmod', 'chown', 'chgrp'].includes(name) && args.some((arg) => hasShortOption(arg, 'LH') || isLongOption(arg, 'dereference'))) {
        return configFinding(`a worker's ${name} may not follow symlinks (-L, -H): a link can lead into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`);
      }
      if (name === 'find' && args.some((arg) => /^-(L|follow)$/.test(arg)) && args.some((arg) => FIND_WRITES.test(arg) || FIND_ACTIONS.has(arg))) {
        return configFinding("a worker's find that changes files or runs a program may not follow symlinks (-L, -follow): a link can lead into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept");
      }
    }
  }
  return null;
}

