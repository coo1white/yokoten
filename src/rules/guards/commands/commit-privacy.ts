// Secrets in a commit (#824).
//
// A repo with no `yokoten init` has no pre-commit hook, so the tool-call guard checks the
// commit itself: it reads the staged diff, and with -a the tracked changes too, and scans
// the added lines with the privacy rules that `check` uses. Only a commit pays this cost:
// every other command returns after one look at its programs. A hit names the file, the
// line and the kind, never the secret: the refusal may land in a chat or a CI log.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { matcher, type Config, type Env } from '../../config.ts';
import { finding, type Finding, isFailingFinding, type RuleId } from '../../message.ts';
import { autoLogins, loadIgnores, mapMarkKinds, repoMarkKinds, scanText } from '../../privacy.ts';
import { findPrograms, isGit, withoutShellRedirects } from '../bash/read/words.ts';
import { gitParts, gitRootAbove, parseCommitOptions } from '../lead-only/targets.ts';

/** The largest patch the guard reads for a commit. Bigger than this is refused, never skipped. */
const COMMIT_PATCH_LIMIT = 16 << 20;

/** The largest file the guard reads for a commit that names it from a folder it cannot read. */
const COMMIT_FILE_LIMIT = 1 << 20;

/** One run of added lines in a patch: its file, the first line it has in that file, and its text. */
type AddedBlock = { file: string; line: number; lines: string[] };

/**
 * What a `git commit` would add: its staged diff, and what -a or a pathspec takes from the
 * work tree too. A change the guard cannot read is a problem, never a pass.
 */
type CommitChange =
  | { root: string; dir: string; staged: string; changed: string; named: string[]; isInclude: boolean }
  | { problem: 'too large' }
  | { problem: 'unreadable' }
  | { problem: 'names from a file' }
  | { problem: 'unknown folder'; named: string[] };

/** The added lines of a unified patch, in runs. `-U0` means a run is one hunk's added lines. */
function parsePatchAdditions(patch: string): AddedBlock[] {
  const blocks: AddedBlock[] = [];
  let file = '';
  let block: AddedBlock | null = null;
  let line = 0;
  const close = () => {
    if (block && block.lines.length > 0) blocks.push(block);
    block = null;
  };
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      close();
      file = '';
      continue;
    }
    if (text.startsWith('+++ ')) {
      close();
      const name = text.slice(4);
      file = name === '/dev/null' ? '' : name.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      close();
      line = Number(hunk[1]);
      block = { file, line, lines: [] };
      continue;
    }
    if (block === null) continue;
    if (text.startsWith('+')) block.lines.push(text.slice(1));
    else if (!text.startsWith('-')) close();
  }
  close();
  return blocks;
}

function readCommitChange(words: string[], folder: string | null, env: Env): CommitChange | null {
  const program = findPrograms(words).find(isGit);
  if (program === undefined) return null;
  const { sub, args, dir } = gitParts(withoutShellRedirects(words, words.indexOf(program) + 1), folder);
  if (sub !== 'commit') return null;
  const { named, isAll, isInclude, namesFromFile } = parseCommitOptions(args);
  // git reads the paths to commit from a file whose shape the guard cannot follow, so a
  // commit that names them that way is refused rather than guessed (#824).
  if (namesFromFile) return { problem: 'names from a file' };
  // From an unknown folder the staged diff cannot be read: the named files still can (#559).
  if (dir === null) return { problem: 'unknown folder', named };
  // git names files from the repo's root. The root is found by a walk, not a second git.
  const root = gitRootAbove(dir, new Map());
  if (root === null) return null;
  const staged = readGitPatch(dir, ['--cached'], env);
  if (staged === null) return null;
  if (staged === 'too large' || staged === 'error') return { problem: staged === 'error' ? 'unreadable' : 'too large' };
  // Without -a, only a named path brings its work tree version; the rest of the index stays.
  if (!isAll && named.length === 0) return { root, dir, staged, changed: '', named, isInclude };
  const changed = readGitPatch(dir, [], env);
  if (changed === null) return null;
  if (changed === 'too large' || changed === 'error') return { problem: changed === 'error' ? 'unreadable' : 'too large' };
  return { root, dir, staged, changed, named, isInclude };
}

/**
 * The whole text of each file a commit names from a folder the guard cannot read: that is
 * what such a commit takes. Null when a name is not one readable file (a folder, a glob, or
 * a relative name that needs the missing folder), so the caller refuses.
 */
function readNamedFileBlocks(named: string[]): AddedBlock[] | 'too large' | null {
  const blocks: AddedBlock[] = [];
  for (const name of named) {
    if (!isAbsolute(name) || /[*?[]/.test(name)) return null;
    let stat: Stats;
    try {
      stat = statSync(name);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    if (stat.size > COMMIT_FILE_LIMIT) return 'too large';
    let text: string;
    try {
      text = readFileSync(name, 'utf8');
    } catch {
      return null;
    }
    // A binary file is scanned as text too: a key beside a NUL byte is still a key.
    blocks.push({ file: name, line: 1, lines: text.split('\n') });
  }
  return blocks;
}

/**
 * The patch `git diff` prints in `dir`: 'too large' past the limit, 'error' when git cannot
 * read the change, so the caller refuses, and null when the folder is no repository at all
 * (the commit fails by itself). `--text` shows a binary file's bytes as lines: a key beside
 * a NUL byte is still a key.
 */
function readGitPatch(dir: string, extra: string[], env: Env): string | 'too large' | 'error' | null {
  const result = spawnSync('git', ['--no-optional-locks', 'diff', ...extra, '-U0', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'], {
    cwd: dir,
    env,
    encoding: 'utf8',
    maxBuffer: COMMIT_PATCH_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return (result.error as NodeJS.ErrnoException).code === 'ENOBUFS' ? 'too large' : 'error';
  if (result.status === 0) return result.stdout;
  // Git and the commit look for the repository the same way: one that is no repository
  // cannot take the commit either, so let it fail on its own. Any other error refuses.
  return /not a git repository|does not point to a valid repository/i.test(result.stderr ?? '') ? null : 'error';
}

/**
 * Why to stop a commit that adds a secret or something private, or null. It costs a git
 * read, so it runs for a commit alone: the first look is the command's programs.
 */
export function checkCommitPrivacy(
  words: string[],
  { env, privacy, folder }: { env: Env; privacy?: Partial<Pick<Config['privacy'], 'allow' | 'skip' | 'skipOwnName'>>; folder: string | null },
): Finding | null {
  const change = readCommitChange(words, folder, env);
  if (change === null) return null;
  const tooLarge = () => finding('unreadable-command', 'this commit is too large for yokoten to read, so it can hide a secret', 'commit the change in smaller parts, so the guard can scan each one', { why: 'the guard reads the whole change before the commit runs, and a change it cannot read could hide a key' });
  let blocks: AddedBlock[];
  let root: string | null;
  if ('problem' in change) {
    if (change.problem === 'too large') return tooLarge();
    if (change.problem === 'names from a file') {
      return finding('unreadable-command', 'yokoten cannot scan the paths this commit reads from a file, so it could hide a secret', 'name each file to commit on the command line, so the guard can scan it', { why: 'a commit yokoten cannot read could add a secret it never sees' });
    }
    if (change.problem === 'unreadable') {
      return finding('unreadable-command', 'yokoten could not read the change this commit adds, so it could hide a secret', 'run `git status` and `git diff --cached` to see the change, then commit again', { why: 'a change the guard cannot read could add a secret it never sees' });
    }
    // With no pathspec a commit takes the staged change, which the guard cannot read from
    // an unknown folder: refuse rather than guess, as the lead-only rule does (#559, #824).
    if (change.named.length === 0) {
      return finding('unreadable-command', 'this commit runs from a folder yokoten cannot read, so it cannot scan what it adds', 'run `git commit` from the repo folder without `--git-dir` or `--work-tree`, or name each file by its full path', { why: 'a commit yokoten cannot read could add a secret it never sees' });
    }
    // A named path is read whole: from a folder the guard cannot read, that is what it commits.
    const named = readNamedFileBlocks(change.named);
    if (named === 'too large') return tooLarge();
    if (named === null) {
      return finding('unreadable-command', 'this commit runs from a folder yokoten cannot read, so it cannot scan what it adds', 'run it from a folder the guard knows (a full path, `./` or `../`), then commit again', { why: 'a commit yokoten cannot read could add a secret it never sees' });
    }
    blocks = named;
    root = null;
  } else {
    // A named path commits its work tree version; the index only counts for the paths it names,
    // unless -i adds the whole index (#402 follows the same rule for lead-only files).
    const isNamed = (file: string): boolean => {
      if (change.named.length === 0 || change.isInclude) return true;
      const full = resolve(change.root, file);
      return change.named.some((name) => /[*?[]/.test(name) || full === resolve(change.dir, name) || full.startsWith(`${resolve(change.dir, name)}${sep}`));
    };
    blocks = [...parsePatchAdditions(change.staged).filter((block) => isNamed(block.file)), ...parsePatchAdditions(change.changed).filter((block) => isNamed(block.file))];
    root = change.root;
  }
  if (blocks.length === 0) return null;
  // Without a repo root there is no ignore file and no marks to read: the guard checks what it can.
  const found = root === null ? [] : repoMarkKinds(env, root, privacy);
  const allow = privacy?.allow ?? [];
  const isSkipped = matcher(privacy?.skip ?? []);
  const ignores = root === null ? [] : loadIgnores(root).entries;
  const options = { marks: found.map((mark) => mark.value), logins: autoLogins(found), allow, kinds: mapMarkKinds(found), ignores, env, inlineIgnores: false };
  for (const block of blocks) {
    if (block.file === '' || isSkipped(block.file)) continue;
    const hit = scanText(block.lines.join('\n'), { ...options, file: block.file }).find(isFailingFinding);
    if (!hit) continue;
    // A secret leaves the repo for a file git ignores; the others already say their own fix.
    const fix = hit.id === 'secret' ? `take the value out of ${block.file}, put it in a file that .gitignore lists, and rotate the key` : hit.fix;
    const what = hit.id === 'private-mark' ? `this commit ${hit.what}` : `this commit adds ${hit.what}`;
    return finding(hit.id as RuleId, what, fix, { file: block.file, line: block.line + (hit.line ?? 1) - 1, grade: hit.grade, why: hit.why });
  }
  return null;
}
