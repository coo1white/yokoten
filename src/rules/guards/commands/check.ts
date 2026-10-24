import { resolve } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { checkCommandTitle } from '../../pr.ts';
import { checkPost, ghIndex, withoutReadPipe, type CommandFiles, type GhCommand } from '../../privacy.ts';
import { type Config, type Env } from '../../config.ts';
import { markFinding, checkWorkerWrites } from '../worker/mark.ts';
import { checkWorkerBox } from '../worker/box.ts';
import { checkWorkerPointers, hostRunRemoval, hostAlias, hostHiddenCommand, hostWorkflowOff } from '../worker/config-command.ts';
import { sends, checkWorkerSends, checkWorkerUnmark } from '../worker/sends.ts';
import { base, isGit, GIT_VALUE_OPTIONS, unquotedRedirects, withoutShellRedirects, LAUNCHERS, programName, splitString, MAX_PROGRAMS, findPrograms, findProgramPlaces } from '../bash/read/words.ts';
import { aliasFinding, checkShellAlias, checkRemoveGit, deleteBranchFinding, findDeletedBranches, findPushedDeletes, findDeletedRef, isDefaultBranch, checkPipeToShell, checkGitLoseWork, isGitLongOption } from './lose-work.ts';
import { checkHooksSettings, checkHooksEnvironment, checkGitConfigEnvironment, checkGitSetupWrites, checkHomeSetting, checkWorkerRealHome } from '../hooks/settings.ts';
import { CONFIG_READS, checkConfig, gitAnswers } from '../hooks/read.ts';
import { heredocPost, plainBreak, writeRisk, withoutStdin, tildesPlain, isUnsure, writesNoFile, writesFile, QUOTED_TILDE, folderAfter } from '../bash/body.ts';
import { checkLeadOnlyWrites } from '../lead-only/writes.ts';
import { fileRules, type FileRules } from '../lead-only/targets.ts';
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
      checkPublish(words, env) ??
      checkBlocked(words, config?.commands.block ?? {}) ??
      checkPosted(words, { env, config, cwd: postCwd, from, command, titles, files: { heredoc, mayWrite, saw, movesFolder } }) ??
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
    if (!env.YOKOTEN_RELEASE_APPROVAL) {
      const tagFlag = args.find((a) => ['--tags', '--follow-tags', '--mirror'].includes(a));
      if (tagFlag) return release(`git push ${tagFlag} pushes tags`);
      const tagRef = args.find((a) => /(^|[:+])(refs\/tags\/|v\d)/.test(a));
      if (tagRef) return release(`git push ${args.join(' ')} pushes a release tag`);
    }
    const force = args.find((a) => a === '--force' || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'));
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
    const ref = findDeletedRef(withoutShellRedirects(words, argsAt));
    if (ref !== null && isDefaultBranch(ref, directory, env)) return deleteBranchFinding(`\`git update-ref -d ${ref}\` deletes the default branch directly`);
  }
  const skip = args.includes('--no-verify') ? '--no-verify' : sub === 'commit' ? args.find((a) => /^-[a-z]*n[a-z]*$/i.test(a)) : undefined;
  if (skip) return finding('skip-check', `git ${sub} ${skip} skips the commit check`, 'fix what the check reports instead');
  if (sub === 'config') return checkConfig(withoutShellRedirects(words, argsAt), directory, env);
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

// A word anywhere after the program counts, so an option in between (`npm --tag x publish`)
// does not hide it. `npm run publish` blocks too: the script may well publish.
/** The visibility a `gh repo` call ends up with: `--visibility[=]x`, `--public`, `--private`; the last one wins. */
function visibilityOf(args: string[]): string | undefined {
  let value: string | undefined;
  for (const [at, word] of args.entries()) {
    if (word.startsWith('--visibility=')) value = word.slice('--visibility='.length);
    else if (word === '--visibility') value = args[at + 1];
    else if (word === '--public') value = 'public';
    else if (word === '--private' || word === '--internal') value = 'private';
  }
  return value;
}

function checkPublish(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_RELEASE_APPROVAL) return null;
  const after = (names: string[]) => {
    const i = words.findIndex((w) => names.includes(base(w).replace(/\.(exe|cmd)$/i, '')));
    return i === -1 ? [] : words.slice(i + 1);
  };
  const gh = after(['gh']);
  const sub = gh.indexOf('release');
  if (sub !== -1 && gh.slice(sub + 1).some((a) => ['create', 'upload', 'edit'].includes(a))) return release('gh release publishes a release');
  const repo = gh.indexOf('repo');
  const repoCall = repo === -1 ? '' : gh[repo + 1] ?? '';
  // gh keeps the last value when a visibility flag comes twice, so the last one counts.
  if ((repoCall === 'create' || repoCall === 'edit') && visibilityOf(gh.slice(repo + 2)) === 'public') {
    return release(repoCall === 'create' ? 'creating a public repo' : 'making the repo public');
  }
  if (after(['npm', 'pnpm', 'yarn']).includes('publish')) return release('this publishes a package');
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

