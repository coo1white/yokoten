import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadConfig, type Env } from '../../config.ts';
import { base, isGit, GIT_VALUE_OPTIONS, unquotedRedirects, readWords, withoutShellRedirects, realPath, REDIRECT, programName, findPrograms } from '../bash/read/words.ts';
import { type RuledRepo } from '../commands/check.ts';
import { readGit, readText } from '../hooks/read.ts';

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
export type WriteTarget = { path: string; from: string | null; isUnread?: boolean };

/** The largest patch the guard reads for the files it names. */
const PATCH_LIMIT = 1 << 20;

// A redirect that writes its file. `>&2` copies a stream; `>&file` writes a file.
export const WRITE_REDIRECT = /^(?:\d+|\{[A-Za-z_]\w*\}|&)?(>>|>\||<>|>&|>)(.*)$/s;

export const UNSURE_FOLDER_FIX = 'write the file by its full path, or first move to a folder the guard can read (an absolute folder, `./`, `../` or `~`), then write again';

// Whether a write target may be anywhere: a relative path from an unknown folder (#559).
// A `~` that names home is read as home, as in `ruled` below; anything else relative stays
// unsure, so unsure means refused wherever the folder is used.
export type FileRules = {
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
export function fileRules(repos: RuledRepo[]): FileRules {
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
export function gitRootAbove(folder: string, known: Map<string, string | null>): string | null {
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

// `keepsRestores`: false leaves out `git checkout` and `git restore`, which bring back committed files.
export function writeTargets(words: string[], folder: string | null, rootOf: FileRules['rootOf'], { keepsRestores = true } = {}): WriteTarget[] {
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
    if (isGit(program)) {
      if (!keepsRestores && ['checkout', 'restore'].includes(gitParts(args, folder).sub ?? '')) continue;
      targets.push(...gitWrites(args, folder, rootOf));
    }
    else if (Object.hasOwn(WRITERS, name)) targets.push(...WRITERS[name](args, folder).map((path) => ({ path, from: folder })));
  }
  return targets;
}

/**
 * The words that are no option, in order: after `--` every word is one. `valued` are the
 * options whose value is the next word.
 */
export function plainArgs(args: string[], valued: string[] = []): string[] {
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

export const COPY_VALUES = ['-t', '--target-directory', '-S', '--suffix'];
// Each writer by name, with the files it writes. Every other program is a read here.
export const WRITERS: Record<string, (args: string[], folder: string | null) => string[]> = {
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
  // A download writes its output file, or into its output folder (#591).
  curl: (args) => optionValues(args, ['o'], ['--output', '--output-dir']),
  wget: (args) => optionValues(args, ['O', 'o', 'a', 'P'], ['--output-document', '--output-file', '--append-output', '--directory-prefix']),
};

const PATCH_VALUES = ['-i', '--input', '-o', '--output', '-p', '-d', '--directory', '-B', '--prefix', '-D', '-F', '-r', '--reject-file', '-z', '--suffix', '-V', '-Y', '--basename-prefix'];
const EDITOR_VALUES = ['-c', '--cmd', '-S', '-u', '-U', '-i', '-T', '-w', '-W', '-s', '-t', '-q', '--listen'];

// vim and its kin: every file named; `+cmd` is a command, not a file.
const editorTargets = (args: string[]) => plainArgs(args, EDITOR_VALUES).filter((arg) => !arg.startsWith('+'));

// `awk -i inplace`: the files after the program text, or every plain word with -f or -e.
function awkTargets(args: string[]): string[] {
  const isInPlace = args.some((arg, at) => arg === '-iinplace' || arg === '--include=inplace' || ((arg === '-i' || arg === '--include') && args[at + 1] === 'inplace'));
  if (!isInPlace) return [];
  const plain = plainArgs(args, ['-f', '--file', '-v', '--assign', '-i', '--include', '-F', '--field-separator', '-l', '--load', '-e', '--source']);
  return args.some((arg) => /^(-[fe]|--file|--source)/.test(arg)) ? plain : plain.slice(1);
}

// More writers, read for git's config and hooks only (#361): editors and patchers change the
// files they name. A patch with no file named changes the files in the patch, which the
// guard does not read. They are not in WRITERS, whose files the lead-only rule also reads.
export const SETUP_WRITERS: Record<string, (args: string[]) => string[]> = {
  patch: (args) => [...plainArgs(args, PATCH_VALUES).slice(0, 1), ...optionValues(args, ['o', 'd', 'r'], ['--output', '--directory', '--reject-file'])],
  ed: (args) => plainArgs(args, ['-p', '--prompt']),
  ex: (args) => editorTargets(args),
  vi: (args) => editorTargets(args),
  vim: (args) => editorTargets(args),
  nvim: (args) => editorTargets(args),
  awk: (args) => awkTargets(args),
  gawk: (args) => awkTargets(args),
  // An archive unpacks into its folder: `tar -x -C dir`, `unzip -d dir`.
  tar: (args) => (/^[A-Za-z]*x[A-Za-z]*$/.test(args[0] ?? '') || args.some((arg) => /^(-[A-Za-z]*x[A-Za-z]*|--extract|--get)$/.test(arg)) ? optionValues(args, ['C'], ['--directory']) : []),
  unzip: (args) => optionValues(args, ['d'], []),
};

/**
 * Every value of the options named: `--long value`, `--long=value`, `-x value`, `-xvalue`,
 * and `-abx value`, where `x` ends a group of short options. `letters` are the short ones.
 */
function optionValues(args: string[], letters: string[], longs: string[]): string[] {
  const values: string[] = [];
  for (const [at, arg] of args.entries()) {
    if (arg === '--') break;
    const long = longs.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (long) values.push(arg === long ? (args[at + 1] ?? '') : arg.slice(long.length + 1));
    else if (/^-[A-Za-z]/.test(arg)) {
      if (letters.includes(arg[1]) && arg.length > 2) values.push(arg.slice(2));
      else if (letters.some((letter) => arg.endsWith(letter) && /^-[A-Za-z]+$/.test(arg))) values.push(args[at + 1] ?? '');
    }
  }
  return values.filter(Boolean);
}

/** git's subcommand, its arguments and the folder it works in (null: unknown), from the git word on. */
export function gitParts(args: string[], folder: string | null): { sub: string | undefined; args: string[]; dir: string | null } {
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
  if (sub !== 'apply') return [];
  if (dir === null) {
    // From an unknown folder a patch file cannot be placed, so what it changes is
    // unknown: unsure means refused where the folder is used (#559). `-` is stdin.
    return plainArgs(args, ['-p', '--exclude', '--include', '--directory'])
      .filter((patch) => patch !== '-')
      .map((patch) => ({ path: patch, from: dir, isUnread: true }));
  }
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
export function commitTargets(words: string[], folder: string | null, rootOf: FileRules['rootOf'], env: Env): WriteTarget[] {
  const start = words.findIndex(isGit);
  if (start === -1) return [];
  const { sub, args, dir } = gitParts(withoutShellRedirects(words, start + 1), folder);
  if (sub !== 'commit') return [];
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
  // From an unknown folder the staged files (and with -a, the changed ones too) are
  // unknowable: unsure means refused where the folder is used (#559). A commit that
  // names only absolute paths still checks them one by one above and below.
  if (dir === null) return [...targets, { path: '.', from: dir }];
  // git names staged files from the repo's root. The root is found by a walk, not a second git.
  const root = rootOf(dir);
  if (root === null) return targets;
  const changed = (args: string[]) =>
    (readGit(dir, ['--no-optional-locks', 'diff', ...args, '--name-only', '--no-renames', '-z'], env) ?? '')
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path: join(root, path), from: root }));
  return [...targets, ...changed(['--cached']), ...(isAll ? changed([]) : [])];
}

