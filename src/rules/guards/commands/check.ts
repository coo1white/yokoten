import { dirname, isAbsolute, resolve } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { checkCommandTitle } from '../../pr.ts';
import { checkPost, ghIndex, withoutReadPipe, type CommandFiles, type GhCommand } from '../../privacy.ts';
import { type Config, type Env } from '../../config.ts';
import { markFinding, checkWorkerWrites } from '../worker/mark.ts';
import { checkWorkerBox } from '../worker/box.ts';
import { checkWorkerPointers, hostRunRemoval, hostAlias, hostHiddenCommand, hostWorkflowOff, hostApiPublishes } from '../worker/config-command.ts';
import { sends, checkWorkerSends, checkWorkerUnmark } from '../worker/sends.ts';
import { base, isGit, GIT_VALUE_OPTIONS, unquotedRedirects, withoutShellRedirects, LAUNCHERS, programName, splitString, MAX_PROGRAMS, findPrograms, findProgramPlaces } from '../bash/read/words.ts';
import { aliasFinding, checkShellAlias, checkRemoveGit, deleteBranchFinding, findDeletedBranches, findPushedDeletes, findDeletedRef, tagToUpdate, isDefaultBranch, checkPipeToShell, checkGitLoseWork, isGitLongOption } from './lose-work.ts';
import { checkHooksSettings, checkHooksEnvironment, checkGitConfigEnvironment, checkGitSetupWrites, checkHomeSetting, checkWorkerRealHome } from '../hooks/settings.ts';
import { CONFIG_READS, checkConfig, gitAnswers, readGit, setsFollowTags } from '../hooks/read.ts';
import { heredocPost, plainBreak, writeRisk, withoutStdin, tildesPlain, isUnsure, writesNoFile, writesFile, QUOTED_TILDE, folderAfter } from '../bash/body.ts';
import { checkLeadOnlyWrites } from '../lead-only/writes.ts';
import { fileRules, plainArgs, type FileRules } from '../lead-only/targets.ts';
import { withBudget } from '../bash/read/run.ts';
import { commandWords } from '../bash/read/read.ts';
import { checkTokenUse } from './token.ts';

export function checkCommand(command: string, options: { env: Env; config?: GuardConfig; cwd: string | null; titles?: boolean; repos?: RuledRepo[] }): Finding | null {
  // The reader is not a full parser. Whatever goes wrong inside it, the command is refused,
  // never let through: an error here must not open the guard.
  const outerAnswers = gitAnswers.map;
  try {
    gitAnswers.map = outerAnswers ?? new Map();
    const isWorker = options.env.YOKOTEN_ROLE === 'worker';
    // The file rules are looked up once per call, and only for a worker.
    const rules = isWorker ? fileRules(options.repos ?? []) : undefined;
    return withBudget(command.length, () => checkEachCommand(command, { ...options, rules }));
  } catch {
    return finding('unreadable-command', 'yokoten could not read this command', 'split it into simpler commands, one per call');
  } finally {
    gitAnswers.map = outerAnswers;
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
  // The same, with a bare relative `cd` read as written, not through CDPATH: where git most
  // likely runs, for the worker's config-folder check (#591).
  let nearCwd = cwd;
  // Where the line starts: a gh post after a cd keeps an allow only within this repo (#447).
  const from = cwd;
  // A command that moves to another folder or repo (`cd x && git config ...`, GIT_DIR=)
  // may change the hooks setting of a repo the guard does not look at.
  if (commands.some(movesRepo)) cwd = null;
  // What the rest of the command may do to a file gh reads (#439).
  const heredoc = heredocPost(command, commands);
  const writers = commands.filter((words) => !writesNoFile(words));
  // Anything but plain words may run code; after a cd, `..` goes up from the real folder.
  // A read-only pipe at the end is left out first (#498).
  const plainText = heredoc === undefined ? withoutStdin(withoutReadPipe(command), commands) : '';
  const plainAt = heredoc === undefined ? plainBreak(plainText) : -1;
  const fills = heredoc === undefined && (plainAt !== -1 || !tildesPlain(command, commands));
  const movesFolder = commands.some((words) => ['cd', 'pushd', 'popd'].includes(words[0] ?? ''));
  // The words have lost their quotes: a quote or \ next to any ~ makes a ~ folder unsure (#465).
  const isTildeQuoted = QUOTED_TILDE.test(command);
  // A download piped into a shell, eval, or a `$` program runs code nobody read (#560, #734, #745).
  const piped = checkPipeToShell(command);
  if (piped) return piped;
  const token = checkTokenUse(command, commands);
  if (token) return token;
  // Rules that refuse any form of a setting or a write (#361, #664). They answer after the
  // rest, which name the case more exactly; the first one found is kept.
  let later: Finding | null = null;
  for (const words of commands) {
    const mayWrite = heredoc !== undefined || fills || writesFile(words) || isUnsure(words) || writers.some((other) => other !== words);
    // The name is built only on a refusal (#498).
    const saw = (isMarked: (word: string) => boolean) => writeRisk(words, { heredoc, plainText, plainAt, fills, writers, isMarked });
    const reason =
      checkGit(words, { env, config, cwd, rules }) ??
      // Before the worker's own send rule: the fix is to ask the owner, and the lead cannot do it either (#650).
      hostRunRemoval(words) ??
      hostAlias(words) ??
      hostHiddenCommand(words) ??
      hostWorkflowOff(words) ??
      // A worker hears its own rule first: what it may not send, its own unmark, and the git folder (#555, #566).
      (env.YOKOTEN_ROLE === 'worker' ? (checkWorkerSends(words) ?? checkWorkerUnmark(words) ?? checkWorkerWrites(words, { folder: postCwd, near: nearCwd, command, env })) : null) ??
      // An alias runs another command under a new name: refused, not parsed (#560).
      // For a worker the worker rule already answers, with its own id.
      checkShellAlias(words, env) ??
      // Removing the .git folder throws away every commit (#560). A find that deletes
      // with nothing keeping it out of .git is the same loss (#573, #744). For a worker
      // the mark rule above already answers, with its own id.
      checkRemoveGit(words, postCwd, env) ??
      checkHooksEnvironment(words) ??
      checkBlocked(words, config?.commands.block ?? {}) ??
      // The text a post carries comes before the publish rule: a publish that would leak a
      // private mark names the mark, which is the part the agent must fix (#391, #829).
      checkPosted(words, { env, config, cwd: postCwd, from, command, titles, files: { heredoc, mayWrite, saw, movesFolder } }) ??
      checkPublish(words, env) ??
      (rules ? checkLeadOnlyWrites(words, { env, rules, folder: postCwd }) : null);
    if (reason) return reason;
    later ??=
      checkGitConfigEnvironment(words) ??
      // The likely folder, read as written: a write there is refused, never let through.
      checkGitSetupWrites(words, { folder: nearCwd, from, env }) ??
      // A changed home folder hides the private marks (#664).
      checkHomeSetting(words, env) ??
      // Git's own ways to lose uncommitted work, a stash, the reflog or the default branch
      // (#828). It answers last among the late rules, so a command that also points at the
      // config folder or sets the folder git works in keeps its own rule (#591).
      checkGitLoseWork(words, postCwd, env);
    postCwd = folderAfter(words, postCwd, { env, isTildeQuoted });
    nearCwd = folderAfter(words, nearCwd, { env, isTildeQuoted, isCdPathSkipped: true });
  }
  // A worker's changed home, before the box: the box would answer first and hide this fix (#739).
  const worker = env.YOKOTEN_ROLE === 'worker' ? (checkWorkerRealHome(commands) ?? checkWorkerBox(command, commands, { cwd: from, env }) ?? checkWorkerPointers(command, commands, env)) : null;
  return worker ?? later;
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

// `git tag` alone, `git tag -l` and `git tag --contains` only read. Deleting a local tag
// (`-d`) and verifying one (`-v`) publish nothing. Every other `git tag` writes a tag,
// which the owner alone creates (record 0028): `git push --follow-tags` would publish it.
const TAG_READ_FLAGS = new Set(['-l', '--list', '-d', '--delete', '-v', '--verify']);
// These choose what a listing matches, so git stays in listing mode after one.
const TAG_READ_OPTIONS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
// `--sort`, `--format` and `--column` only change how a listing prints. With a name,
// git still creates the tag, so they must not mark the command as a read (#873).
// `--sort` and `--format` take their value as the next word, or after `=`.
const TAG_VALUE_OPTIONS = new Set(['-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup', '--trailer', '--sort', '--format']);
// A combined short flag keeps its letters: `git tag -ln v1` lists, because `-n` only shapes
// the listing. A writing letter in the group (`-af`) still makes the command a write (#873).
const TAG_SHORT_GROUP = /^-[a-zA-Z]{2,}$/;
function isTagRead(arg: string): boolean {
  if (TAG_READ_FLAGS.has(arg) || /^-n\d*$/.test(arg)) return true;
  if (TAG_READ_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`))) return true;
  return TAG_SHORT_GROUP.test(arg) && /[ldv]/.test(arg.slice(1)) && !/[asf]/.test(arg.slice(1));
}
const TAG_WRITE_OPTIONS = new Set(['--annotate', '--sign', '--force']);

/** The name a `git tag` command creates, or null when its words name no tag. */
function tagNameOf(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    if (TAG_VALUE_OPTIONS.has(args[index])) index++;
    else if (!args[index].startsWith('-')) return args[index];
  }
  return null;
}

function createsTag(args: string[]): boolean {
  if (args.some(isTagRead)) return false;
  const isWriteFlag = args.some((arg) => TAG_WRITE_OPTIONS.has(arg) || /^-[a-zA-Z]*[asf]/.test(arg));
  return tagNameOf(args) !== null || isWriteFlag;
}

/** A word a shell can run as it is: anything else goes inside single quotes. */
function quoteShellWord(word: string): string {
  return /^[A-Za-z0-9._/:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}


export const MOVERS = new Set(['cd', 'pushd', 'popd']);
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


/**
 * The folder whose git reads the same tags and settings as `--git-dir <path>` (#865). A
 * path that names a work tree's `.git` folder reads through its parent; any other path is
 * the git folder itself, which git also opens from inside. A path the guard cannot place
 * leaves the repo unknown, as before.
 */
function folderForGitDirectory(value: string | undefined, from: string | null): string | null {
  if (value === undefined || value === '') return null;
  // A relative folder needs a folder to start from: `GIT_DIR=` sets the working folder to
  // null, and then only a path that stands on its own can be read.
  if (from === null && !isAbsolute(value)) return null;
  const folder = resolve(from ?? '', value);
  return base(folder) === '.git' ? dirname(folder) : folder;
}

// The `git push` options that take the next word as their value. A value that looks like
// an option belongs to its option, not to the push (#865).
const PUSH_VALUE_OPTIONS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);

/**
 * The words `git push` reads as options, leaving out each option's value. The push still
 * sends tags for `git push -o --dry-run --tags`, because `--dry-run` is the value of `-o`
 * (#865).
 */
function pushOptions(args: string[]): string[] {
  const options: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') break;
    if (!word.startsWith('-') || word === '-') continue;
    options.push(word);
    if (PUSH_VALUE_OPTIONS.has(word)) index++;
  }
  return options;
}

/**
 * Whether a `git push` is a dry run. Git keeps the last of `--dry-run`, `--no-dry-run` and
 * `-n`, so `--no-dry-run` after `--dry-run` makes the push send for real (#865).
 */
function pushDryRun(options: string[]): boolean {
  let isDryRun = false;
  for (const word of options) {
    if (isGitLongOption(word, '--no-dry-run')) isDryRun = false;
    else if (isGitLongOption(word, '--dry-run') || word === '-n') isDryRun = true;
  }
  return isDryRun;
}

/** Whether a ref name is a tag: a tag ref, a `v1` name, or a local tag (#829). */
function isTagRef(refspec: string, directory: string | null, env: Env): boolean {
  const [source, destination] = refspec.replace(/^\+/, '').split(':');
  if (destination !== undefined && destination.startsWith('refs/tags/')) return true;
  if (source === undefined || source === '') return false;
  if (source.startsWith('refs/tags/') || /^v\d/.test(source)) return true;
  return directory !== null && readGit(directory, ['rev-parse', '--verify', '--quiet', `refs/tags/${source}`], env) !== null;
}

/**
 * Whether a `git push` names a tag. A tag ref, a `v1` name and a local tag all count; a
 * plain branch name does not (#829).
 */
function pushesTag(args: string[], directory: string | null, env: Env): boolean {
  const plain = plainArgs(args, ['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
  const refs = plain.length > 1 ? plain.slice(1) : plain;
  return refs.some((ref) => isTagRef(ref, directory, env));
}

/** Whether git will carry tags on a plain push, because push.followTags is set (#829). */
function followsTags(directory: string | null, env: Env): boolean {
  if (directory === null) return false;
  const answer = readGit(directory, ['config', '--get', 'push.followTags'], env);
  return answer !== null && !/^(false|no|off|0)$/i.test(answer);
}

// Each check looks for its program anywhere in the command, so a prefix such as FOO=1,
// sudo, env, command, exec, time, nice, nohup, timeout or xargs does not hide it.
function checkGit(words: string[], { env, config, cwd, rules }: { env: Env; config?: Pick<Config, 'commands'>; cwd: string | null; rules?: FileRules }): Finding | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  const settings: string[] = [];
  const fromEnvironment: string[] = []; // --config-env name=VARIABLE
  // The folder git works in: `-C` moves it, and `GIT_DIR=…` names the git folder before
  // the program does. With `--git-dir`, the folder that reads the same tags and settings is
  // the git folder's parent, so a push of a tag stays visible; `--work-tree` does not move
  // the git folder at all (#865).
  // The shell keeps the last assignment, and so does git: the first one can be a decoy.
  const namedDirectory = words.slice(0, start).findLast((word) => /^GIT_DIR=/.test(word));
  let directory: string | null = cwd;
  if (namedDirectory !== undefined) directory = folderForGitDirectory(namedDirectory.slice('GIT_DIR='.length), cwd);
  let index = start + 1;
  while (index < words.length && words[index].startsWith('-')) {
    if (words[index] === '-C' && directory !== null) directory = resolve(directory, words[index + 1] ?? '');
    const gitDirectory = /^--git-dir(?:=(.*))?$/s.exec(words[index]);
    if (gitDirectory) directory = folderForGitDirectory(gitDirectory[1] ?? words[index + 1], directory);
    if (words[index] === '-c') settings.push(words[index + 1] ?? '');
    if (words[index] === '--config-env') fromEnvironment.push(words[index + 1] ?? '');
    if (words[index].startsWith('--config-env=')) fromEnvironment.push(words[index].slice('--config-env='.length));
    index += GIT_VALUE_OPTIONS.has(words[index]) ? 2 : 1;
  }
  const sub = words[index];
  const argsAt = index + 1;
  const args = words.slice(argsAt);

  const hooks = checkHooksSettings(settings, fromEnvironment);
  if (hooks) return hooks;
  if (settings.some((s) => /^push\.followtags/i.test(s)) && !env.YOKOTEN_RELEASE_APPROVAL) {
    return release('git -c push.followTags pushes tags');
  }
  // `git -c alias.x=...` makes an alias, which can run another command under a new name:
  // refused, not parsed, so the guard never reads a hidden command as safe (#560). For a
  // worker the worker rule below still answers first, with its own id.
  const aliasSetting = [...settings, ...fromEnvironment].find((text) => /^alias\./i.test(text.trim()));
  if (aliasSetting && env.YOKOTEN_ROLE !== 'worker') {
    return aliasFinding(`git with \`${aliasSetting.split('=')[0].trim()}\` makes an alias, which can run another command under a new name`);
  }
  for (const s of settings) {
    const alias = /^alias\.[^=]*=!(.*)$/is.exec(s);
    const reason = alias && checkEachCommand(alias[1], { env, config, cwd, rules });
    if (reason) return reason;
  }
  if (env.YOKOTEN_ROLE === 'worker') {
    const reason = checkWorkerGit(words, { options: words.slice(start + 1, argsAt - 1), settings: [...settings, ...fromEnvironment], sub, args: withoutShellRedirects(words, argsAt) });
    if (reason) return reason;
  }
  if (sub === 'push') {
    // Only the words git reads as options count: a value of `-o` or `--repo` can look like
    // one, and the push still sends what it names (#865).
    const options = pushOptions(args);
    const dryRun = pushDryRun(options);
    const help = options.some((a) => a === '--help');
    if (!env.YOKOTEN_RELEASE_APPROVAL && !help) {
      const tagFlag = options.find((a) => isGitLongOption(a, '--tags') || isGitLongOption(a, '--follow-tags') || isGitLongOption(a, '--mirror'));
      // A dry run changes nothing on the remote, so it may name tags.
      if (tagFlag && !dryRun) return release(`git push ${tagFlag} pushes tags`);
      if (!dryRun && pushesTag(args, directory, env)) return release(`git push ${args.join(' ')} pushes a release tag`);
      // The setting can arrive in an earlier call: `git config push.followTags true`, then
      // a plain `git push` (#829). Read the config git will read.
      if (!dryRun && followsTags(directory, env)) return release('git push carries tags, because push.followTags is set');
    }
    const force = args.find((a) => isGitLongOption(a, '--force') || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'));
    if (force) return finding('force-push', `git push ${force} forces the push`, 'use --force-with-lease, which stops when the remote has work you have not seen');
    // A worker commits in its worktree; the lead reviews and pushes (#555).
    if (env.YOKOTEN_ROLE === 'worker') return sends('a worker does not push');
    const pushed = findPushedDeletes(withoutShellRedirects(words, argsAt));
    const gone = pushed?.find((name) => isDefaultBranch(name, directory, env));
    if (gone !== undefined) return deleteBranchFinding(`\`git push\` deletes the default branch \`${gone}\` on the remote`);
  }
  if (sub === 'tag' && !env.YOKOTEN_RELEASE_APPROVAL) {
    const tagArgs = withoutShellRedirects(words, argsAt);
    if (createsTag(tagArgs)) {
      const tag = tagNameOf(tagArgs);
      // Name the tag, as the branch's #828 message did; a form whose name the guard cannot
      // read still refuses, with the whole command as the word it names (#873).
      if (tag !== null) {
        return finding('release', `creating the tag ${tag}`, `if the owner asked for this, they run \`git tag ${quoteShellWord(tag)}\` themselves, or start a new session with YOKOTEN_RELEASE_APPROVAL=1; do not look for another way`);
      }
      return release(`git tag ${tagArgs.join(' ')} creates a tag`);
    }
  }
  if (sub === 'reset' && args.some((arg) => isGitLongOption(arg, '--hard'))) {
    return finding('hard-reset', 'git reset --hard throws away uncommitted work', 'commit or stash the work first; to undo a commit, use `git revert`');
  }
  if (sub === 'branch') {
    const names = findDeletedBranches(withoutShellRedirects(words, argsAt));
    const gone = names?.find((name) => isDefaultBranch(name, directory, env));
    if (gone !== undefined) return deleteBranchFinding(`\`git branch\` deletes the default branch \`${gone}\``);
  }
  if (sub === 'update-ref') {
    const updateArgs = withoutShellRedirects(words, argsAt);
    const ref = findDeletedRef(updateArgs);
    if (ref !== null && isDefaultBranch(ref, directory, env)) return deleteBranchFinding(`\`git update-ref -d ${ref}\` deletes the default branch directly`);
    // `git update-ref refs/tags/rel-1 HEAD` makes a tag without `git tag` (#829). Stdin
    // is already refused as `move-default-branch`, since it can write any ref (#847).
    const tag = tagToUpdate(updateArgs);
    if (tag !== null && !env.YOKOTEN_RELEASE_APPROVAL) {
      return finding('release', `creating the tag ${tag}`, `if the owner asked for this, they run \`git tag ${tag}\` themselves; do not look for another way`);
    }
  }
  const skip = args.includes('--no-verify') ? '--no-verify' : sub === 'commit' ? args.find((a) => /^-[a-z]*n[a-z]*$/i.test(a)) : undefined;
  if (skip) return finding('skip-check', `git ${sub} ${skip} skips the commit check`, 'fix what the check reports instead');
  if (sub === 'config') {
    const configArgs = withoutShellRedirects(words, argsAt);
    // `push.followTags` makes every later plain push carry the tags: a tag published after a
    // config change, not by a push that names it (#829).
    if (!env.YOKOTEN_RELEASE_APPROVAL && setsFollowTags(configArgs)) return release('git config push.followTags makes every push carry tags');
    return checkConfig(configArgs, directory, env);
  }
  return null;
}

/**
 * For a worker: git's ways to push, to make an alias that can hide a push, to work in another
 * git folder, and to change a worktree (#555), or null. `start` is git's word; `options` its
 * own options, before the subcommand.
 */
function checkWorkerGit(words: string[], { options, settings, sub, args }: { options: string[]; settings: string[]; sub: string | undefined; args: string[] }): Finding | null {
  if (words.some((word) => /^GIT_(DIR|COMMON_DIR)=/.test(word)) || options.some((word) => /^--git-dir(=|$)/.test(word))) {
    return markFinding('git with GIT_DIR or --git-dir works in another git folder, where the worker mark may be');
  }
  // Removing or moving its worktree removes a worker's mark, and a new one has none.
  if (sub === 'worktree' && args[0] !== 'list') return markFinding(`git worktree ${args[0] ?? ''} changes a worktree, which carries the worker mark`);
  if (sub === 'send-pack') return sends('git send-pack pushes');
  if (sub === 'subtree' && args.find((arg) => !arg.startsWith('-')) === 'push') return sends('git subtree push pushes');
  if (settings.some((setting) => /^alias\./i.test(setting.trim()))) return sends('git -c alias.* makes an alias, which can run a push under another name');
  if (sub === 'config' && args.some((arg) => /^alias\./i.test(arg)) && !args.some((arg) => CONFIG_READS.has(arg))) {
    return sends('git config alias.* sets an alias in the config every worktree shares, which can run a push under another name');
  }
  return null;
}

/** The visibility a `gh repo` call ends up with: `--visibility[=]x`, `--public`, `--private`; the last one wins. A `=false` turns the flag round (#865). */
function visibilityOf(args: string[]): string | undefined {
  let value: string | undefined;
  for (const [at, word] of args.entries()) {
    if (word.startsWith('--visibility=')) value = word.slice('--visibility='.length);
    else if (word === '--visibility') value = args[at + 1];
    else if (word === '--public') value = 'public';
    else if (word === '--public=true') value = 'public';
    else if (word === '--public=false') value = 'private';
    else if (word === '--private=false') value = 'public';
    else if (word === '--private' || word === '--internal') value = 'private';
  }
  return value;
}

// A word anywhere after the program counts, so an option in between (`npm --tag x publish`)
// does not hide it. `npm run publish` blocks too: the script may well publish.
// Each tool that publishes, with the words after it that publish. The list is a small set
// of names, not grammar: a form that is not on it and not read as safe is refused.
const PUBLISH_TOOLS: Record<string, string[]> = {
  cargo: ['publish'],
  gem: ['push'],
  poetry: ['publish'],
  uv: ['publish'],
  twine: ['upload'],
  bun: ['publish'],
  deno: ['publish'],
  docker: ['push'],
  podman: ['push'],
  helm: ['push'],
};
// A script name that may publish: `npm run release`, `make publish`. A name we cannot see
// into is refused, never read as safe.
const RELEASE_SCRIPT = /(publish|release|deploy|ship|upload)/i;
// A release tool that publishes a package when a runner starts it (#829, #865).
const RELEASE_TOOLS = new Set(['publish', 'semantic-release', 'release-it', 'np']);
// A tool's name without a version: `semantic-release@latest` runs `semantic-release`, and
// `release-it@1.2.3` runs `release-it` (#865).
const toolName = (word: string) => base(word).replace(/\.(exe|cmd)$/i, '').replace(/@.*$/, '');
// The words a boolean flag reads as false. npm reads `--dry-run false` as dry-run off and
// then publishes (#865).
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

// Whether a command carries an `npm`-style dry run. `--dry-run` alone and `--dry-run=true`
// publish nothing; `--dry-run=false` and `--dry-run false` do publish, because npm's parser
// takes the next word as the flag's value. A flag given twice keeps the last one, as npm
// does, so `--dry-run --dry-run false` publishes (#865).
function isDryRun(words: string[]): boolean {
  let isDryRun = false;
  for (const [index, word] of words.entries()) {
    if (word === '--dry-run') isDryRun = !FALSE_WORDS.has((words[index + 1] ?? '').toLowerCase());
    else if (word.startsWith('--dry-run=')) isDryRun = !FALSE_WORDS.has(word.slice('--dry-run='.length).toLowerCase());
  }
  return isDryRun;
}

function checkPublish(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_RELEASE_APPROVAL) return null;
  // `--help` prints help instead of publishing for a direct tool. It does not save a
  // script: `npm run release --help` still runs the release script.
  const help = words.includes('--help');
  const after = (names: string[]) => {
    const i = words.findIndex((w) => names.includes(base(w).replace(/\.(exe|cmd)$/i, '')));
    return i === -1 ? [] : words.slice(i + 1);
  };
  // The words that start a tool after a package runner: `npx <tool>` runs it, and so does
  // `npm exec <tool>` or `pnpm dlx <tool>`. `npm install <tool>` only installs it (#865).
  const startedBy = (names: string[], subcommands: string[]): string[] => {
    const rest = after(names);
    const first = rest.find((word) => !word.startsWith('-'));
    if (first === undefined) return [];
    if (subcommands.includes(first)) return rest.slice(rest.indexOf(first) + 1);
    return subcommands.length === 0 ? rest : [];
  };
  const gh = after(['gh']);
  if (!help) {
    const sub = gh.indexOf('release');
    if (sub !== -1 && gh.slice(sub + 1).some((a) => ['create', 'upload', 'edit'].includes(a))) return release('gh release publishes a release');
    const repo = gh.indexOf('repo');
    const repoCall = repo === -1 ? '' : gh[repo + 1] ?? '';
    // gh keeps the last value when a visibility flag comes twice, so the last one counts.
    if ((repoCall === 'create' || repoCall === 'edit') && visibilityOf(gh.slice(repo + 2)) === 'public') {
      return release(repoCall === 'create' ? 'creating a public repo' : 'making the repo public');
    }
    // The host's API is the whole API behind one command: a release, a tag, or a public
    // repo is one POST away. The host adapter knows which routes publish, and a write to
    // one of them, an unreadable query or a mutation is refused. A plain read passes (#829).
    const api = gh.indexOf('api');
    if (api !== -1 && hostApiPublishes(gh.slice(api + 1))) return release('this call to the host API can publish a release, a tag or a public repo');
    // A release workflow publishes after the owner starts it by name (#829). A test or
    // lint workflow (`gh workflow run ci.yml`) still passes.
    const workflow = gh.indexOf('workflow');
    if (workflow !== -1 && gh[workflow + 1] === 'run' && gh.slice(workflow + 2).some((a) => RELEASE_SCRIPT.test(a))) {
      return release('gh workflow run starts a release workflow');
    }
    // Another code host publishes a release the same way (#829).
    for (const host of ['glab', 'tea']) {
      const hostArgs = after([host]);
      const at = hostArgs.indexOf('release');
      if (at !== -1 && hostArgs.slice(at + 1).some((a) => ['create', 'upload'].includes(a))) return release(`${host} release publishes a release`);
    }
  }
  // A script with a release-like name can publish, and the guard cannot see inside it. This
  // comes before the dry-run and help checks: `npm run release -- --dry-run` still runs the
  // script.
  const runner = after(['npm', 'pnpm', 'yarn', 'yarnpkg']);
  const run = runner.findIndex((a) => a === 'run' || a === 'run-script');
  if (run !== -1) {
    const script = runner.slice(run + 1).find((a) => !a.startsWith('-'));
    if (script !== undefined && RELEASE_SCRIPT.test(script)) return release(`the script ${script} may publish`);
  }
  // `yarn release` and `pnpm release` run a script without `run`.
  const runnerFirst = runner.find((a) => !a.startsWith('-'));
  const runnerSubcommands = ['add', 'ci', 'create', 'dlx', 'exec', 'install', 'link', 'pack', 'publish', 'test', 'update', 'version'];
  if (runnerFirst !== undefined && !runnerSubcommands.includes(runnerFirst) && RELEASE_SCRIPT.test(runnerFirst)) return release(`the script ${runnerFirst} may publish`);
  const make = after(['make']);
  const target = make.find((a) => !a.startsWith('-') && RELEASE_SCRIPT.test(a));
  if (target !== undefined) return release(`the make target ${target} may publish`);
  // `npm version patch` makes a commit and a tag, without `git tag` (#829).
  if (!help) {
    const npm = after(['npm', 'pnpm']);
    const version = npm.indexOf('version');
    if (version !== -1) {
      const rest = npm.slice(version + 1);
      if (!rest.some((a) => a === '--no-git-tag-version') && rest.some((a) => !a.startsWith('-'))) return release('npm version makes a tag');
    }
  }
  // A dry run publishes nothing: `npm publish --dry-run` passes. It is read before the
  // direct tools only, because `npm run release -- --dry-run` still runs the script. The
  // exact word only, or `=true`: an option a tool does not know may be ignored, and then it
  // publishes. A value of `false` turns the dry run off, and npm then publishes (#865).
  const dryRun = isDryRun(words);
  if (!dryRun && !help && after(['npm', 'pnpm', 'yarn']).includes('publish')) return release('this publishes a package');
  // A release tool started by a package runner publishes for the agent (#829, #865): `npx
  // semantic-release`, and the same by `npm exec`, `pnpm dlx`, `yarn dlx` or `bun x`.
  const startedTools = [
    ...startedBy(['npx', 'bunx', 'pnpx'], []),
    ...startedBy(['npm', 'pnpm', 'yarn', 'yarnpkg'], ['exec', 'dlx', 'x']),
    ...startedBy(['bun'], ['x']),
  ];
  if (!dryRun && !help && startedTools.some((word) => RELEASE_TOOLS.has(toolName(word)))) return release('this publishes a package');
  // Another language's package tool publishes the same way (#829).
  if (!dryRun && !help) {
    for (const [program, action] of Object.entries(PUBLISH_TOOLS)) {
      if (after([program]).some((a) => action.includes(a))) return release('this publishes a package');
    }
    // `dotnet nuget push` publishes a package (#829).
    const dotnet = after(['dotnet']);
    const nuget = dotnet.indexOf('nuget');
    if (nuget !== -1 && dotnet.slice(nuget + 1).includes('push')) return release('this publishes a package');
    // `python -m twine upload` publishes a package (#829).
    const python = after(['python', 'python3', 'python2', 'py']);
    const module = python.indexOf('-m');
    if (module !== -1 && python[module + 1] === 'twine' && python.slice(module + 2).includes('upload')) return release('this publishes a package');
  }
  return null;
}

// What a gh command posts (#391). The title of an issue or a pull request gets the title
// check `yokoten bot` runs, so plain gh can't open one CI then fails. Then the text (an
// issue, a pull request, a comment, a release note) gets the privacy check: see privacy.ts.
// The privacy check comes first: a title is checked by it too, and a leak matters more.
function checkPosted(
  words: string[],
  { env, config, cwd, from, command, titles, files }: { env: Env; config?: Partial<Pick<Config, 'privacy' | 'areas'>>; cwd: string | null; from: string | null; command: string; titles: boolean; files: CommandFiles },
): Finding | null {
  const at = ghIndex(words, findProgramPlaces(words));
  if (at === -1) return null;
  const gh = ghCommand(words, at);
  const leak = checkPost(gh, { env, privacy: config?.privacy, cwd, from, command, files });
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

