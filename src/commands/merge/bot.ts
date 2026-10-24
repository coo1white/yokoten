// `yokoten bot -- <gh or git command>`: runs it as the GitHub App, after checking its title
// and, for a pull request, its body.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { botConfig, botEnv, botProgram, type Gh, installationToken, readApprovalState, readBranchFiles, readCodeOwners, readIssueMilestone, readRepoLabelNames, repoOf } from '../../host/github/index.ts';
import { DEFAULTS, type Env, loadConfig } from '../../rules/config.ts';
import { finding, type Finding } from '../../rules/message.ts';
import { notUtc } from '../../rules/privacy.ts';
import { type CommandIssueLabels, type CommandLabels, type CommandMilestone, checkCommandTitle, checkMergeApproval, checkIssueLabels, checkOwnedTier, checkPullRequestBody, madeWithFindings, noMilestoneFinding, prTier, readCommandBody, readCommandIssueLabels, readCommandLabels, readCommandMilestone, readLabelTier } from '../../rules/pr.ts';
import { bullets, type Invocation, type Output, parse, print, readInput, requireRoot, rootOf, usage } from '../shared.ts';

// ---- Commit times on the way out (#789) ----
//
// The commit hook is the only other line that checks the zone, and a plain clone has
// no core.hooksPath, so the hook never runs. The bot is the one path every push takes.

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
const PUSH_VALUE_OPTIONS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option', '--recurse-submodules']);

/** Where a `git push` runs, and the words after `push`, or null when this is not one. `'elsewhere'` when `--git-dir` or `--work-tree` hides the repo. */
function pushTarget(command: string[], cwd: string): { dir: string; args: string[] } | 'elsewhere' | null {
  if (!/(^|[/\\])git(\.exe)?$/.test(command[0] ?? '')) return null;
  let dir = cwd;
  let index = 1;
  while (index < command.length && command[index].startsWith('-') && command[index] !== '--') {
    const word = command[index];
    if (/^--(git-dir|work-tree)(=|$)/.test(word)) return 'elsewhere';
    if (word === '-C') {
      dir = resolve(dir, command[index + 1] ?? '');
      index += 2;
      continue;
    }
    const name = word.split('=')[0];
    index += !word.includes('=') && GIT_VALUE_OPTIONS.has(name) ? 2 : 1;
  }
  if (command[index] !== 'push') return null;
  return { dir, args: command.slice(index + 1) };
}

/** What git printed, or null when it failed. The text is never shown: it can hold a path. */
function gitText(dir: string, env: Env, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 1 << 24 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/**
 * The commits a push sends: the revisions to read, and the commits the remote already
 * has. The base is what the remote reports, never a tracking ref: `refs/remotes/...` is a
 * local ref, and the agent can point it at the tip it is about to push (#789).
 */
interface PushSpec {
  local: string[];
  base: string[];
}

/** What stopped the check before it could read a commit: what happened, and its fix. */
interface PushProblem {
  what: string;
  fix: string;
}

/** The refs the remote reports, by name, or what went wrong. It asks; it never pushes. */
function remoteRefs(dir: string, env: Env, remote: string): Map<string, string> | PushProblem {
  const text = gitText(dir, env, ['ls-remote', remote]);
  if (text === null) {
    return { what: "git can't read what the remote already has, so nothing was pushed", fix: 'check the remote name and that this desk can reach it, then push again' };
  }
  const refs = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [sha, name] = line.split('\t');
    if (sha && name && /^[0-9a-f]{40,64}$/.test(sha)) refs.set(name, sha);
  }
  return refs;
}

/** The revisions a push sends, with the commits the remote already has. A delete sends no commit. */
function specsForPush(dir: string, env: Env, args: string[]): PushSpec[] | PushProblem {
  const words: string[] = [];
  const flags = new Set<string>();
  let repoOption: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (!word.startsWith('-')) {
      words.push(word);
      continue;
    }
    const name = word.split('=')[0];
    flags.add(name);
    // `--repo <repository>` names the destination when no word does.
    if (name === '--repo') repoOption = word.includes('=') ? word.slice(word.indexOf('=') + 1) : args[index + 1] ?? null;
    if (!word.includes('=') && PUSH_VALUE_OPTIONS.has(name)) index += 1;
  }
  // A delete sends no commit, so there is no time to check.
  if (flags.has('--delete') || flags.has('-d')) return [];
  // The first word that is not an option is the remote, the way git reads it: a name, a
  // path or a URL. Only the words after it are refspecs. `--repo` names it when no word
  // does; a word wins over the option, as git says.
  let remote = 'origin';
  let refspecs = words;
  let named = false;
  if (words.length) {
    remote = words[0];
    refspecs = words.slice(1);
    named = true;
  } else if (repoOption !== null) {
    remote = repoOption;
    named = true;
  }
  // Each spec: the local revisions to read, and the ref whose remote value is the base.
  const pending: { local: string[]; dest: string | null }[] = [];
  if (flags.has('--mirror')) pending.push({ local: ['--all'], dest: null });
  if (flags.has('--all')) pending.push({ local: ['--branches'], dest: null });
  if (flags.has('--tags')) pending.push({ local: ['--tags'], dest: null });
  // `--follow-tags` sends only tags that point into the refs already read, so it adds no commit.
  for (const spec of refspecs) {
    const text = spec.startsWith('+') ? spec.slice(1) : spec;
    const colon = text.indexOf(':');
    const source = colon === -1 ? text : text.slice(0, colon);
    const dest = colon === -1 ? text : text.slice(colon + 1);
    // `git push origin :branch` deletes that branch: a delete sends no commit.
    if (!source) continue;
    // A refspec may name a pattern (`refs/heads/*:refs/heads/*`), which git expands and
    // `git log` does not, so the pattern goes in as `--glob`.
    pending.push({ local: [/[*?[]/.test(source) ? `--glob=${source}` : source], dest: dest || source });
  }
  if (!pending.length) {
    // Every refspec named a delete, so this push sends no commit of its own.
    if (refspecs.length) return [];
    // A bare `git push` sends the current branch, to its upstream when it has one.
    const current = gitText(dir, env, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
    if (!current) return [];
    let dest = current;
    if (!named) {
      const upstream = gitText(dir, env, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])?.trim();
      const slash = upstream ? upstream.indexOf('/') : -1;
      if (upstream && slash > 0) {
        remote = upstream.slice(0, slash);
        dest = upstream.slice(slash + 1);
      }
    }
    pending.push({ local: [current], dest });
  }
  // A remote with a `pushurl` is pushed there, so the question goes there too.
  const pushUrl = gitText(dir, env, ['remote', 'get-url', '--push', remote])?.trim();
  const refs = remoteRefs(dir, env, pushUrl || remote);
  if (!(refs instanceof Map)) return refs;
  const known = [...new Set(refs.values())];
  return pending.map(({ local, dest }) => {
    // A ref the remote has: its value there is the base. A ref it does not have: every ref
    // it reports is history this push does not send, so a new branch is not read again.
    const names = dest === null ? [] : dest.startsWith('refs/') ? [dest] : [`refs/heads/${dest}`, `refs/tags/${dest}`];
    const base = names.map((name) => refs.get(name)).filter((sha): sha is string => sha !== undefined);
    return { local, base: base.length ? base : known };
  });
}

const ZONE_FIX = 're-date in UTC, then push again: `TZ=UTC git commit --amend --date=<date>` for the latest commit, or a rebase that re-dates each older commit in UTC';

/**
 * A push whose author or committer time is not UTC (#789), or null when this is not a
 * push or every commit it sends is UTC. The offset is never printed.
 */
function zonedPushFinding(cwd: string, env: Env, command: string[]): Finding | null {
  const target = pushTarget(command, cwd);
  if (target === null) return null;
  if (target === 'elsewhere') {
    return finding('git-read', "this push points git at another folder, so the time check can't see the commits", 'run the push in the repo, with no --git-dir and no --work-tree');
  }
  const specs = specsForPush(target.dir, env, target.args);
  if (!Array.isArray(specs)) return finding('git-read', specs.what, specs.fix);
  let count = 0;
  for (const spec of specs) {
    // The base goes in on standard input: a repo can have more refs than a command line holds.
    const input = spec.base.map((sha) => `^${sha}\n`).join('');
    const result = spawnSync('git', ['--no-replace-objects', 'log', '--format=%ad %cd', '--date=format:%z', ...spec.local, '--stdin'], { cwd: target.dir, env, encoding: 'utf8', maxBuffer: 1 << 24, input });
    if (result.error || result.status !== 0) {
      return finding('git-read', "git can't list the commits this push sends, so nothing was pushed", 'check the branch name and that git runs, then push again');
    }
    for (const line of result.stdout.split('\n')) {
      if (line && line.split(/\s+/).some((zone) => notUtc(` ${zone}`))) count += 1;
    }
  }
  if (count === 0) return null;
  const what = count === 1 ? 'a commit this push sends records a time zone other than UTC' : `${count} commits this push sends record a time zone other than UTC`;
  return finding('time-zone', what, ZONE_FIX);
}

async function bot(invocation: Invocation, command: string[]): Promise<number> {
  const { env, cwd } = invocation;
  // gh and git only (#295): a wrapper such as `env gh` or `sh -c` would run a title unchecked.
  if (command.length && !botProgram(command[0])) {
    print(invocation, [`yokoten bot: runs gh and git only; run \`${command[0]}\` without the bot`], invocation.stderr);
    return 1;
  }
  // The title first: a bad title is refused before anything is sent, so it never needs a rename.
  const root = rootOf(cwd, env);
  const titleProblems = checkCommandTitle(command, root ? loadConfig(root) : DEFAULTS);
  if (titleProblems.length) {
    print(invocation, [`yokoten bot: ${titleProblems.length} problem(s) in the title; nothing was sent. Fix the title and run it again:`, ...bullets(titleProblems)], invocation.stderr);
    return 1;
  }
  // Then a pull request's body (#406), by the body rules of `check --pr`. A body for this
  // branch, or one `--head` or `gh pr edit <branch>` names, is checked before anything is sent.
  const body = root ? readPendingBody(invocation, command, root) : null;
  if (body && !isLookup(body) && refuseBody(invocation, checkBody(body, localBranch(body), env))) return 1;
  // A comment, a review with a body and a new issue carry the same `Made with` line as a
  // pull request body (#609), so a reader can tell which AI wrote them. Only that line is
  // checked here; an edit stays as it is.
  const note = root ? readPendingNoteBody(invocation, command, root) : null;
  if (note && refuseBody(invocation, { problems: checkNote(note) })) return 1;
  // Then the labels of `gh pr create` (#422): a tier label the body contradicts is refused.
  const labels = root ? readPendingLabels(command, root, body, env) : null;
  if (labels?.problems.length) {
    print(invocation, [`yokoten bot: ${labels.problems.length} problem(s) in the labels; nothing was sent. Fix the labels and run it again:`, ...bullets(labels.problems)], invocation.stderr);
    return 1;
  }
  // Then the labels of `gh issue create` (#544): checked below, once the token can
  // list the repo's labels. A bad issue is refused, never sent; its labels are not
  // added, as no line of the command names the type.
  const pendingIssue = root ? readPendingIssueLabels(command, root, env) : null;
  const config = botConfig(env);
  if (typeof config === 'string') {
    print(invocation, [`yokoten bot: ${config}`], invocation.stderr);
    return 1;
  }
  if (!command.length) {
    print(invocation, ['yokoten bot: no command. Example: yokoten bot -- gh pr create --fill'], invocation.stderr);
    return 1;
  }
  if (!requireRoot(invocation, cwd)) return 1;
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, env, encoding: 'utf8' });
  const repo = repoOf(remote);
  if (!repo) {
    print(invocation, ['yokoten bot: the origin remote is not a GitHub repo'], invocation.stderr);
    return 1;
  }
  const token = await installationToken(config, repo);
  const runEnv = botEnv(env, token);
  // Before the push (#789): a commit time that is not UTC never leaves. The base is what
  // the remote reports, so it is asked with the bot's own credential.
  const zoned = zonedPushFinding(cwd, runEnv, command);
  if (zoned) {
    print(invocation, ['yokoten bot: 1 problem(s); nothing was pushed. Fix it and run the push again:', ...bullets([zoned])], invocation.stderr);
    return 1;
  }
  const [file, ...given] = command;
  const ghEnv = botEnv(env, token);
  // A new pull request with no milestone takes its linked issue's (#512): one `gh issue view`.
  const wanted = body && !isLookup(body) ? readCommandMilestone(command, body.text) : null;
  const milestone = wanted ? chooseMilestone(invocation, wanted, ghWith(file, cwd, ghEnv)) : null;
  if (milestone === false) return 1;
  if (pendingIssue) {
    const issueProblems = checkIssueLabels(pendingIssue.labels, readRepoLabelNames(ghWith(file, cwd, ghEnv)));
    if (issueProblems.length) {
      print(invocation, [`yokoten bot: ${issueProblems.length} problem(s) in the labels; nothing was sent. Fix the labels and run it again:`, ...bullets(issueProblems)], invocation.stderr);
      return 1;
    }
  }
  // `gh pr edit <number or URL>`: one `gh pr view` with the same token names its branches,
  // and its labels, so an edit can move the tier label to the one its new body sets (#422).
  let current: string[] | null = null;
  let lookedUp = false;
  if (body && isLookup(body)) {
    const branch = lookupBranch(body, file, ghEnv, env);
    lookedUp = true;
    current = 'labels' in branch ? branch.labels ?? null : null;
    if (refuseBody(invocation, checkBody(body, branch, env))) return 1;
  }
  // The type and tier labels the command leaves out, by the names the repo has (#422).
  // An edit also moves the tier label: the pull request's labels say which old one to remove.
  const wantedTier = labels?.edit?.tier ?? null;
  if (wantedTier !== null && !lookedUp) current = readPullRequestLabels(invocation, labels?.edit?.selector ?? null, labels?.repo ?? null, file, ghEnv);
  // A read that failed leaves the old tier label where it is, so the note says so: two tier
  // labels fail `check --pr`, and the caller can remove the old one itself (#422).
  if (wantedTier !== null && current === null) {
    print(invocation, [`yokoten bot: note: gh could not read this pull request's labels, so an older tier label may stay next to \`tier ${wantedTier}\`; remove it with --remove-label. \`check --pr\` refuses two tier labels`], invocation.stderr);
  }
  const chosen = labels?.missing.length ? chooseLabels(invocation, labels, file, ghEnv) : [];
  const addLabel = labels?.edit ? '--add-label' : '--label';
  const adds = chosen.filter((name) => !current?.some((label) => label.toLowerCase() === name.toLowerCase()));
  // The old tier label goes only when the new one is in place: the command gives it, the
  // bot adds it, or the pull request already has it. A tier the repo does not have is left
  // out by `chooseLabels`, so the pull request keeps its current tier label (#422).
  const hasNewTier = Boolean(labels?.hasTierLabel)
    || chosen.some((name) => readLabelTier(name) === wantedTier)
    || (current?.some((label) => readLabelTier(label) === wantedTier) ?? false);
  const removes = wantedTier === null || !hasNewTier ? [] : current?.filter((label) => {
    const tier = readLabelTier(label);
    return tier !== null && tier !== wantedTier && !labels?.removes.some((given) => given.toLowerCase() === label.toLowerCase());
  }) ?? [];
  const labelArgs = [...adds.flatMap((name) => [addLabel, name]), ...removes.flatMap((name) => ['--remove-label', name])];
  const withLabels = labelArgs.length ? addArgs(given, labelArgs) : given;
  const rest = milestone ? addArgs(withLabels, ['--milestone', milestone]) : withLabels;
  // A `gh pr merge` of a tier A pull request needs a code owner's Approve on its head
  // (#612): the merge is refused when the Approve is older, or can't be checked.
  if (file === 'gh' && isPrMerge(rest)) {
    const stopped = refuseStaleMerge(invocation, ghWith(file, cwd, botEnv(env, token)), cwd, env, repo, rest);
    if (stopped) return 1;
  }
  // An `api` call on a pull request's merge endpoint merges too (#612): it goes
  // through the same gate, unless it is provably a read.
  if (file === 'gh' && refuseApiMerge(invocation, ghWith(file, cwd, botEnv(env, token)), cwd, env, repo, rest)) return 1;
  // A body read from standard input was used up by the check, so gh gets it the same way.
  const input = body?.input ?? note?.input;
  const { stdin, stdout, stderr } = invocation;
  const piped = input ?? (stdin.fd === null ? (stdin.text ?? '') : undefined);
  // `gh pr status` shows the Approve check too (#612), so the lead sees a stale Approve
  // before trying to merge. Its output is captured to add the lines after gh's table.
  if (file === 'gh' && showsPrStatus(rest)) {
    return runPrStatus(invocation, file, rest, { cwd, token, origin: repo, piped });
  }
  const result = spawnSync(file, rest, { cwd, stdio: [piped === undefined ? (stdin.fd ?? 'pipe') : 'pipe', childStream(stdout), childStream(stderr)], input: piped, env: botEnv(env, token), maxBuffer: 1 << 30 });
  // What gh said, for a stream that is not the process's own: written as it is, as a terminal would show it.
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  // A command that never ran, or that a signal ended, says so (#282). Only the file and the
  // code or signal are named: never the token or the environment.
  if (result.error) {
    print(invocation, [`yokoten bot: could not run ${file}: ${(result.error as NodeJS.ErrnoException).code ?? result.error.message.split('\n')[0]}`], invocation.stderr);
    return 1;
  }
  if (result.signal) {
    print(invocation, [`yokoten bot: ${file} was ended by ${result.signal}`], invocation.stderr);
    return 1;
  }
  return result.status ?? 1;
}

/** The process's own stream by its fd, so gh writes to it straight; else a pipe, copied after (#475). */
const childStream = (stream: Output): number | 'pipe' => (typeof stream.fd === 'number' ? stream.fd : 'pipe');

/** A pull request body a command is about to set, read and not yet checked. */
interface PendingBody {
  root: string;
  text: string;
  /** The body as read from standard input, which gh then gets the same way. */
  input?: string;
  base: string | null;
  head: string | null;
  repo: string | null;
}

/**
 * The body `gh pr create` or `gh pr edit` sets, read from the command, a file or standard
 * input. Null when there is none, the repo has no yokoten.json, the command names another
 * repo, or the file can't be read (gh then says why, and sends nothing).
 */
function readPendingBody(invocation: Invocation, command: string[], root: string): PendingBody | null {
  const found = readCommandBody(command);
  if (!found || !existsSync(join(root, 'yokoten.json')) || !isOrigin(root, found.repo, invocation.env)) return null;
  try {
    if ('text' in found.body) return { root, text: found.body.text, base: found.base, head: found.head, repo: found.repo };
    const input = found.body.file === '-' ? readInput(invocation.stdin) : undefined;
    return { root, text: input ?? readFileSync(resolve(invocation.cwd, found.body.file), 'utf8'), input, base: found.base, head: found.head, repo: found.repo };
  } catch {
    return null;
  }
}

/** A comment, review or new-issue body a command is about to set, read and not yet checked. */
interface PendingNote {
  root: string;
  text: string;
  /** The body as read from standard input, which gh then gets the same way. */
  input?: string;
  repo: string | null;
  /** Whether the command names `--attach`: gh posts those uploads after the body. */
  attach: boolean;
}

// The options of `issue`/`pr` `comment`, `pr review` and `issue create` that take a value,
// so their value is not read as the noun or the verb. Gh's host flag is here too, so a
// host before the noun is not read as the noun. A run-together word expands letter
// by letter, the way gh reads it; a value that looks like another flag is not consumed,
// the way `parse` reads yokoten's own options. `--attach` uploads land after the body,
// so any `--attach` is refused rather than checked.
const NOTE_VALUES = new Set(['--body', '-b', '--body-file', '-F', '--repo', '-R', '--hostname', '--title', '-t', '--label', '-l', '--add-label', '--milestone', '-m', '--project', '-p', '--assignee', '-a', '--reviewer', '-r', '--base', '-B', '--head', '-H', '--template', '-T', '--type', '--attach']);
const NOTE_SHORT_VALUES = 'bFRtlmarBHpT';
// On `gh pr review`, `-a` (`--approve`) and `-r` (`--request-changes`) are booleans, and
// there is no assignee or reviewer: those four spellings take no value there.
const REVIEW_VALUES = new Set([...NOTE_VALUES].filter((flag) => flag !== '--assignee' && flag !== '-a' && flag !== '--reviewer' && flag !== '-r'));
// The short letters that take a value on `gh pr review`: only the body and repo letters,
// since `-a`, `-r` and `-c` (`--comment`) are booleans there.
const REVIEW_SHORT_VALUES = 'bFR';

/** The words and the option values of a note command's args, read with one command's flags. */
interface NoteArgs {
  /** Each word that is not an option or an option's value. */
  words: string[];
  /** Each option and its value, in order, with `--attach` kept apart. */
  options: [name: string, value: string][];
  /** Whether the command names `--attach`. */
  attach: boolean;
}

/**
 * The words and the option values of a note command's args. As in gh, the last spelling
 * of an option wins; a run-together word expands letter by letter (`-wb` is `-w -b`); a
 * separate value that looks like another flag is not consumed, so it is read as a flag.
 * A bare `--` is the exception: in value position it is the value, as gh reads it, and
 * parsing continues after it; in flag position it still ends the flags.
 */
function readNoteArgs(args: string[], values: Set<string>, shorts: string): NoteArgs {
  const rest = [...args];
  const words: string[] = [];
  const options: [string, string][] = [];
  let attach = false;
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index];
    if (word === '--') break;
    if (word === '-' || !word.startsWith('-')) {
      words.push(word);
      continue;
    }
    let name = word;
    let value: string | undefined;
    const equals = word.startsWith('--') ? word.indexOf('=') : -1;
    if (equals > 0) {
      name = word.slice(0, equals);
      value = word.slice(equals + 1);
    } else if (!word.startsWith('--') && word.length > 2) {
      if (!shorts.includes(word[1])) {
        // A run-together word starting with a boolean letter: gh reads the letter as a
        // flag and the rest again, so the letter is dropped and the rest is read again.
        rest[index] = `-${word.slice(2)}`;
        index -= 1;
        continue;
      }
      name = word.slice(0, 2);
      value = word.slice(2);
      // Gh drops the `=` of an attached short value: `-t=x` is the title `x`.
      if (value.startsWith('=')) value = value.slice(1);
    }
    if (!values.has(name)) continue;
    if (value === undefined) {
      const next = rest[index + 1];
      if (next === undefined) break;
      // A bare `--` here is the value, as gh reads it; any longer `--` word is a flag.
      if (next !== '--' && next.startsWith('--')) continue;
      index += 1;
      value = rest[index];
    }
    if (name === '--attach') {
      attach = true;
      continue;
    }
    options.push([name, value]);
  }
  return { words, options, attach };
}

/**
 * The body that `gh pr comment`, `gh issue comment`, `gh pr review` or `gh issue create`
 * sets with `--body`, `-b`, `--body-file` or `-F`, in any spelling gh takes. As in gh, the
 * last one wins. Null for any other command, for one with no body and no `--attach` (a
 * plain approve), for an edit (which stays as it is), or when the repo has no yokoten.json,
 * the command names another repo, or the file can't be read (gh then says why, and sends
 * nothing). A `--attach` alone still returns a note, so the upload is refused below: gh
 * would post it with no `Made with` line.
 */
function readPendingNoteBody(invocation: Invocation, command: string[], root: string): PendingNote | null {
  const [file, ...rest] = command;
  if (!file || botProgram(file) !== 'gh') return null;
  const { words } = readNoteArgs(rest, NOTE_VALUES, NOTE_SHORT_VALUES);
  const [kind, verb] = words;
  const isNote = (kind === 'issue' && (verb === 'comment' || verb === 'create' || verb === 'new')) || (kind === 'pr' && (verb === 'comment' || verb === 'review'));
  if (!isNote) return null;
  const isReview = kind === 'pr' && verb === 'review';
  const found = isReview ? readNoteArgs(rest, REVIEW_VALUES, REVIEW_SHORT_VALUES) : readNoteArgs(rest, NOTE_VALUES, NOTE_SHORT_VALUES);
  let body: string | { file: string } | null = null;
  let repo: string | null = null;
  for (const [name, value] of found.options) {
    if (name === '--body' || name === '-b') body = value;
    else if (name === '--body-file' || name === '-F') body = { file: value };
    else if (name === '--repo' || name === '-R') repo = value;
  }
  if ((!body && !found.attach) || !existsSync(join(root, 'yokoten.json')) || !isOrigin(root, repo, invocation.env)) return null;
  try {
    // An empty body is nothing to check, as gh posts it as it is; `--attach` alone
    // still returns a note below, so the upload is refused.
    if (typeof body === 'string' && body === '' && !found.attach) return null;
    if (typeof body === 'string') return { root, text: body, repo, attach: found.attach };
    if (body === null) return { root, text: '', repo, attach: found.attach };
    const input = body.file === '-' ? readInput(invocation.stdin) : undefined;
    const text = input ?? readFileSync(resolve(invocation.cwd, body.file), 'utf8');
    if (text === '' && !found.attach) return null;
    return { root, text, input, repo, attach: found.attach };
  } catch {
    return null;
  }
}

/**
 * The problems with a comment, review or new-issue body: `--attach` uploads land after
 * the body, past the `Made with` line, so any `--attach` is refused; otherwise only the
 * `Made with` line is checked, with or without a body (#609).
 */
function checkNote(note: PendingNote): Finding[] {
  if (note.attach) return [finding('pr-made-with', 'body: `--attach` appends the upload after the `Made with` line', 'drop `--attach`, or link an uploaded file in the body instead')];
  return checkNoteMadeWith(note.text);
}

/**
 * The problems with a comment, review or new-issue body: only the `Made with` line, with
 * the same check (`madeWithFindings`) and the same message as a pull request body (#609). The
 * wording here mirrors `checkPullRequestBody`, which owns it.
 */
function checkNoteMadeWith(text: string): Finding[] {
  return madeWithFindings(text);
}

/** Whether `--repo` names this repo's origin, or no repo at all. */
function isOrigin(root: string, repo: string | null, env: Env): boolean {
  if (repo === null) return true;
  let origin: string | null = null;
  try {
    origin = repoOf(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // no origin: the named repo is another one
  }
  return origin?.toLowerCase() === repo.replace(/^(https?:\/\/)?github\.com\//, '').toLowerCase();
}

/**
 * The labels `gh pr create` leaves out, and the problems with those it gives, by `check
 * --pr` (#422). Null when the repo has no yokoten.json, or the command names another repo.
 */
function readPendingLabels(command: string[], root: string, body: PendingBody | null, env: Env): CommandLabels | null {
  if (!existsSync(join(root, 'yokoten.json'))) return null;
  const labels = readCommandLabels(command, body?.text ?? null);
  return labels && isOrigin(root, labels.repo, env) ? labels : null;
}

/**
 * The labels a `gh issue create` command gives, or null when the repo has no
 * yokoten.json, the command names another repo, or it is no issue create (#544).
 */
function readPendingIssueLabels(command: string[], root: string, env: Env): CommandIssueLabels | null {
  if (!existsSync(join(root, 'yokoten.json'))) return null;
  const found = readCommandIssueLabels(command);
  return found && isOrigin(root, found.repo, env) ? found : null;
}

/**
 * For each missing label, the first name the repo has, from one `gh label list` with the
 * bot's token. A label the repo does not have is said plainly and left out; the bot never
 * creates one. When gh can't list the labels, the best name is used, and gh says the rest.
 */
function chooseLabels(invocation: Invocation, labels: CommandLabels, gh: string, ghEnv: Env): string[] {
  const list = spawnSync(gh, ['label', 'list', '--json', 'name', '--limit', '1000', ...(labels.repo ? ['--repo', labels.repo] : [])], { cwd: invocation.cwd, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  let names: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(list.stdout ?? '');
    if (list.status === 0 && Array.isArray(parsed)) names = parsed.map((label: { name?: unknown }) => String(label?.name ?? ''));
  } catch {
    // gh said no list: use the best names
  }
  if (!names) return labels.missing.map(([best]) => best);
  const known = new Map(names.map((name) => [name.toLowerCase(), name]));
  const chosen: string[] = [];
  for (const wanted of labels.missing) {
    const found = wanted.map((name) => known.get(name.toLowerCase())).find((name) => name !== undefined);
    if (found !== undefined) chosen.push(found);
    else print(invocation, [`yokoten bot: note: the repo has no label \`${wanted[0]}\`, so the pull request gets none; create it on GitHub, or pass another with --label. \`check --pr\` asks for it`], invocation.stderr);
  }
  return chosen;
}

/**
 * The labels of the pull request an edit names, from one `gh pr view` with the bot's token.
 * Null when gh can't say: the caller then adds what the command says and removes nothing.
 */
function readPullRequestLabels(invocation: Invocation, selector: string | null, repo: string | null, gh: string, ghEnv: Env): string[] | null {
  const args = ['pr', 'view', ...(selector === null ? [] : [selector]), '--json', 'labels', ...(repo === null ? [] : ['--repo', repo])];
  const view = spawnSync(gh, args, { cwd: invocation.cwd, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const parsed: unknown = JSON.parse(view.stdout ?? '');
    if (view.status === 0 && Array.isArray((parsed as { labels?: unknown })?.labels)) {
      return ((parsed as { labels: { name?: unknown }[] }).labels).map((label) => String(label?.name ?? ''));
    }
  } catch {
    // said by the caller
  }
  return null;
}

/** The gh arguments with `added` before any `--`. */
function addArgs(args: string[], added: string[]): string[] {
  const end = args.indexOf('--');
  return end === -1 ? [...args, ...added] : [...args.slice(0, end), ...added, ...args.slice(end)];
}

/**
 * Runs the gh the command names, with the bot's token. It throws when gh fails.
 * The error keeps gh's stderr, so a contents 404 is not a failed read.
 */
const ghWith =
  (file: string, cwd: string, ghEnv: Env): Gh =>
  (args) =>
    execFileSync(file, args, { cwd, env: ghEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The milestone of the first linked issue that has one (#512). False, after saying why,
 * when every linked issue was read and none has one. Null, with a note, when gh can't read
 * an issue: a network hiccup never stops a post, and `check --pr` still asks for it.
 */
function chooseMilestone(invocation: Invocation, wanted: CommandMilestone, gh: Gh): string | null | false {
  const unread: number[] = [];
  for (const issue of wanted.issues) {
    const milestone = readIssueMilestone(gh, issue, wanted.repo);
    if (milestone) return milestone;
    if (milestone === undefined) unread.push(issue);
  }
  if (unread.length) {
    const named = unread.map((issue) => `#${issue}`).join(', ');
    print(invocation, [`yokoten bot: note: gh could not read the milestone of issue ${named}, so the pull request gets none; pass --milestone. \`check --pr\` asks for it`], invocation.stderr);
    return null;
  }
  print(invocation, ['yokoten bot: 1 problem(s) in the milestone; nothing was sent. Fix the command and run it again:', ...bullets([noMilestoneFinding(wanted.issues)])], invocation.stderr);
  return false;
}

/** Whether the pull request is named by a number or a URL, so gh must say its branches. */
const isLookup = (body: PendingBody): boolean => body.head !== null && /^\d+$|^https?:/.test(body.head);

/** The branches to compare and the pull request's labels, or why the body is checked without the changed files. */
type Branch = { base: string; head: string; files?: ReturnType<typeof readBranchFiles>; labels?: string[] } | { why: string };

/** This branch, or the one `--head` or `gh pr edit <branch>` names, against origin/<base>. */
function localBranch(body: PendingBody): Branch {
  // Another owner's branch (`owner:branch`) is not here to compare.
  if (body.head?.includes(':')) return { why: `\`${body.head}\` is another owner's branch` };
  return { base: `origin/${body.base ?? 'main'}`, head: body.head ?? 'HEAD' };
}

/**
 * The branches of the pull request `gh pr edit <number or URL>` names, from one `gh pr view`
 * with the bot's token (#406). The edit goes to the network anyway. A branch that is not
 * here yet is fetched from origin, quietly.
 */
function lookupBranch(body: PendingBody, gh: string, ghEnv: Env, env: Env): Branch {
  const view = spawnSync(gh, ['pr', 'view', body.head ?? '', '--json', 'headRefName,baseRefName,labels', ...(body.repo ? ['--repo', body.repo] : [])], { cwd: body.root, encoding: 'utf8', env: ghEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  let refs: { headRefName?: unknown; baseRefName?: unknown; labels?: unknown } = {};
  try {
    refs = JSON.parse(view.stdout ?? '');
  } catch {
    // said below
  }
  if (view.status !== 0 || typeof refs.headRefName !== 'string' || typeof refs.baseRefName !== 'string') {
    return { why: `gh could not say the branches of pull request \`${body.head}\`` };
  }
  const base = body.base ?? refs.baseRefName;
  const branch = { base: `origin/${base}`, head: `origin/${refs.headRefName}` };
  const labels = Array.isArray(refs.labels) ? refs.labels.map((label) => String((label as { name?: unknown })?.name ?? '')) : undefined;
  const files = readBranchFiles(body.root, branch.base, branch.head, env);
  if (files) return { ...branch, files, labels };
  spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', refs.headRefName, base], { cwd: body.root, env, stdio: 'ignore' });
  return { ...branch, labels };
}

/** The problems with a body: every body rule of `check --pr` when the branch's files can be read, else the body alone, with a note. */
function checkBody(body: PendingBody, branch: Branch, env: Env): { problems: Finding[]; note?: string } {
  const config = loadConfig(body.root);
  const files = 'why' in branch ? null : (branch.files ?? readBranchFiles(body.root, branch.base, branch.head, env));
  if ('why' in branch || !files) {
    const why = 'why' in branch ? branch.why : `git can't compare ${branch.head} with ${branch.base}`;
    return { problems: checkPullRequestBody({ body: body.text, files: [] }, config), note: `${why}, so the body was checked without the changed files; CI checks the rest` };
  }
  const pr = { body: body.text, ...files };
  const problems = checkPullRequestBody(pr, config);
  const owned = checkOwnedTier(pr, readCodeOwners(body.root, branch.base, env));
  if (owned) problems.push(owned);
  return { problems };
}

/** Prints the problems with a body the way the title check does, or its note. True when it refuses. */
function refuseBody(invocation: Invocation, { problems, note }: { problems: Finding[]; note?: string }): boolean {
  if (problems.length) {
    print(invocation, [`yokoten bot: ${problems.length} problem(s) in the body; nothing was sent. Fix the body and run it again:`, ...bullets(problems)], invocation.stderr);
    return true;
  }
  if (note) print(invocation, [`yokoten bot: note: ${note}`], invocation.stderr);
  return false;
}

/** The gh options that take a value, by long name, for `pr merge` and `pr status`. */
const PR_VALUE_OPTIONS = new Set(['--repo', '--body', '--body-file', '--subject', '--author-email', '--match-head-commit', '--jq', '--template', '--json']);
/** The short forms of those: R, b, F, q, t. */
const PR_VALUE_SHORTS = new Map([['R', '--repo'], ['b', '--body'], ['F', '--body-file'], ['q', '--jq'], ['t', '--template']]);

/** A gh command split into plain words and valued options: a value is never read as a word. */
function splitGhArgs(args: string[]): { words: string[]; options: [string, string][] } {
  const words: string[] = [];
  const options: [string, string][] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      words.push(...args.slice(index + 1));
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      words.push(word);
      continue;
    }
    if (word.startsWith('--')) {
      const cut = word.indexOf('=');
      const name = cut === -1 ? word : word.slice(0, cut);
      if (!PR_VALUE_OPTIONS.has(name)) continue;
      options.push([name, cut === -1 ? (args[++index] ?? '') : word.slice(cut + 1)]);
      continue;
    }
    // A short word: a value letter takes the rest of the word, or the next word.
    const mapped = PR_VALUE_SHORTS.get(word[1]);
    if (mapped === undefined) continue;
    const rest = word.slice(2).replace(/^=/, '');
    options.push([mapped, rest || (args[++index] ?? '')]);
  }
  return { words, options };
}

/** "owner/name" with no URL, path or case left in it, for comparing repos. */
const normalizeRepoName = (name: string): string => name.trim().replace(/^(?:https?:\/\/)?github\.com\//i, '').replace(/\.git\/?$/, '').toLowerCase();

/** Whether the gh command merges a pull request: `pr merge ...`. */
const isPrMerge = (args: string[]): boolean => {
  const { words } = splitGhArgs(args);
  return words[0] === 'pr' && words[1] === 'merge';
};

/** Whether the gh command lists pull requests as a table: `pr status` with no format option. */
const showsPrStatus = (args: string[]): boolean => {
  const { words, options } = splitGhArgs(args);
  if (words[0] !== 'pr' || words[1] !== 'status' || words.length > 2 || args.includes('--json')) return false;
  // `--json` is a valued option, so `--json=<fields>` lands in the options too (#612).
  return !options.some(([name]) => name === '--jq' || name === '--template' || name === '--json');
};

/** The `--repo` value of a gh command, or null when it names none. */
const repoFlag = (args: string[]): string | null => splitGhArgs(args).options.filter(([name]) => name === '--repo').at(-1)?.[1] ?? null;

/** The number in a `gh pr view` answer, or null. Never throws. */
function viewedNumber(gh: Gh, args: string[]): number | null {
  try {
    const viewed: unknown = JSON.parse(gh(args));
    if (typeof viewed === 'object' && viewed !== null && typeof (viewed as { number?: unknown }).number === 'number') return (viewed as { number: number }).number;
  } catch {
    // said below
  }
  return null;
}

/** The pull request a `gh pr merge` names: its number and repo, or why it can't be read. */
function mergeRequest(gh: Gh, args: string[], origin: string | null): { number: number; repo: string } | { unsure: string } {
  const { words } = splitGhArgs(args);
  const flag = repoFlag(args);
  const repo = flag ?? origin;
  if (!repo) return { unsure: 'no repo is named and this checkout names no origin' };
  if (flag && origin && normalizeRepoName(flag) !== normalizeRepoName(origin)) return { unsure: `${flag} is not this checkout, so its commits are not here` };
  const repoArgs = flag ? ['--repo', flag] : [];
  const target = words[2];
  if (target === undefined) {
    const number = viewedNumber(gh, ['pr', 'view', '--json', 'number', ...repoArgs]);
    return number === null ? { unsure: 'gh could not say the pull request of this branch' } : { number, repo };
  }
  const digits = /^(\d+)$/.exec(target);
  if (digits) return { number: Number(digits[1]), repo };
  // A URL names its own repo: `github.com/owner/name/pull/12`, or the API form
  // `repos/owner/name/pulls/12`. Any other `/pull/12` keeps the old answer below.
  const urlRepo = /(?:github\.com\/|repos\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/pulls?\/\d+(?:[/#?]|$)/i.exec(target);
  const fromUrl = /\/pulls?\/(\d+)(?:[/#?]|$)/.exec(target);
  if (fromUrl) {
    if (urlRepo) {
      const named = urlRepo[1];
      if (origin && normalizeRepoName(named) !== normalizeRepoName(origin)) return { unsure: `${named} is not this checkout, so its commits are not here` };
      return { number: Number(fromUrl[1]), repo: named };
    }
    return { number: Number(fromUrl[1]), repo };
  }
  if (words.length > 3) return { unsure: 'more than one pull request is named; merge one at a time' };
  // A branch: gh says its pull request's number.
  const number = viewedNumber(gh, ['pr', 'view', target, '--json', 'number', ...repoArgs]);
  return number === null ? { unsure: `gh could not say the pull request of branch \`${target}\`` } : { number, repo };
}

/** An `api` path that merges a pull request: repos/{owner}/{repo}/pulls/<n>/merge. */
const API_MERGE_ENDPOINT = /^\/?repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge(\?.*)?$/;

/** The `api` option names that make a call something other than a bare GET. */
const API_WRITE_OPTIONS = new Set(['-X', '--method', '-f', '--field', '-F', '--raw-field', '--input']);

/**
 * The merge an `api` command attempts, or null. A merge endpoint with a method or
 * a field option merges (or may merge), so it goes through the gate; a bare path is
 * a GET read and passes through (#612). A `--` ends the flags, as in gh.
 */
function apiMerge(args: string[]): { number: number; repo: string } | null {
  const end = args.indexOf('--');
  const before = end === -1 ? args : args.slice(0, end);
  const found = before.find((word) => API_MERGE_ENDPOINT.test(word));
  const endpoint = found && API_MERGE_ENDPOINT.exec(found);
  if (!endpoint) return null;
  // A run-together word expands letter by letter, the way gh reads it (`-sF` is
  // `-s -F`), so any write letter in it counts, mirroring the note parser.
  const writes = before.some((word) => {
    if (!word.startsWith('-') || word === '-') return false;
    if (word.startsWith('--')) return API_WRITE_OPTIONS.has(word.split('=')[0]);
    return [...word.slice(1)].some((letter) => API_WRITE_OPTIONS.has(`-${letter}`));
  });
  if (!writes) return null;
  return { number: Number(endpoint[3]), repo: `${endpoint[1]}/${endpoint[2]}` };
}

/** Refuses an `api` merge the Approve check stops. True when it refused. */
function refuseApiMerge(invocation: Invocation, gh: Gh, cwd: string, env: Env, origin: string | null, args: string[]): boolean {
  const merge = apiMerge(args);
  if (!merge) return false;
  if (origin && normalizeRepoName(merge.repo) !== normalizeRepoName(origin)) {
    print(invocation, [`yokoten bot: could not check the owner's Approve (${merge.repo} is not this checkout, so its commits are not here). Nothing was merged`], invocation.stderr);
    return true;
  }
  const refusal = approvalRefusal(gh, cwd, env, merge.number, merge.repo);
  if (!refusal) return false;
  print(invocation, [`yokoten bot: ${refusal.text}. Nothing was merged`], invocation.stderr);
  return true;
}

/** Why a merge stops. `kind` picks the status list, so the words of `text` do not. */
interface MergeStop {
  kind: 'unchecked' | 'needsApprove';
  text: string;
}

/**
 * Why pull request `number` must not merge yet, or null when it may: not tier A, or the
 * owner's Approve is on its head, or an area lead of another vendor than the writer
 * approved it, or only base merges came after that Approve with the same own diff.
 * What gh or git can't answer is `unchecked`. It names the cause and does not ask for
 * a new Approve. A missing or stale Approve is `needsApprove`.
 */
function approvalRefusal(gh: Gh, root: string, env: Env, number: number, repo: string): MergeStop | null {
  const state = readApprovalState(gh, root, env, number, repo);
  if ('unsure' in state) return { kind: 'unchecked', text: `could not check the owner's Approve (${state.unsure})` };
  if (state.tier !== 'A') return null;
  const problem = checkMergeApproval(state);
  return problem ? { kind: 'needsApprove', text: problem.what } : null;
}

/** Refuses a `gh pr merge` the Approve check stops. True when it refused. */
function refuseStaleMerge(invocation: Invocation, gh: Gh, cwd: string, env: Env, origin: string | null, args: string[]): boolean {
  const found = mergeRequest(gh, args, origin);
  if ('unsure' in found) {
    print(invocation, [`yokoten bot: could not check the owner's Approve (${found.unsure}); nothing was merged.`], invocation.stderr);
    return true;
  }
  const refusal = approvalRefusal(gh, cwd, env, found.number, found.repo);
  if (!refusal) return false;
  print(invocation, [`yokoten bot: ${refusal.text}. Nothing was merged`], invocation.stderr);
  return true;
}

/**
 * The tier a `pr list` row with a body and labels says, or null when it says none:
 * then the deep check reads it (#612).
 */
function listTier(entry: { body?: unknown; labels?: unknown }): string | null {
  const body = typeof entry.body === 'string' ? entry.body : '';
  const names = Array.isArray(entry.labels)
    ? entry.labels.map((label) => (typeof label === 'object' && label !== null ? String((label as { name?: unknown }).name ?? '') : '')).filter(Boolean)
    : [];
  if (!body && !names.length) return null;
  return prTier(body, names);
}

/**
 * Runs `gh pr status`, shows its table as gh wrote it, then the Approve check for every
 * open pull request. One list call says each tier, and only tier A (or a row whose tier
 * it can't say) needs the deep check (#612). A missing or stale Approve is one list.
 * A check that could not be read is another. A list is printed only when it has a row.
 */
function runPrStatus(invocation: Invocation, file: string, args: string[], run: { cwd: string; token: string; origin: string | null; piped: string | undefined }): number {
  const { stdout, stderr } = invocation;
  const env = botEnv(invocation.env, run.token);
  const gh = ghWith(file, run.cwd, env);
  const shown = spawnSync(file, args, { cwd: run.cwd, stdio: [run.piped === undefined ? (invocation.stdin.fd ?? 'pipe') : 'pipe', 'pipe', 'pipe'], input: run.piped, env, maxBuffer: 1 << 30 });
  if (shown.stdout) stdout.write(shown.stdout);
  if (shown.stderr) stderr.write(shown.stderr);
  if (shown.error) {
    print(invocation, [`yokoten bot: could not run ${file}: ${(shown.error as NodeJS.ErrnoException).code ?? shown.error.message.split('\n')[0]}`], invocation.stderr);
    return 1;
  }
  if (shown.signal) {
    print(invocation, [`yokoten bot: ${file} was ended by ${shown.signal}`], invocation.stderr);
    return 1;
  }
  if (shown.status !== 0) return shown.status ?? 1;
  const flag = repoFlag(args);
  const repo = flag ?? run.origin;
  // With no repo to check, the status says nothing: never a bogus ask-the-owner line (#612).
  if (!repo) return 0;
  let listed: unknown;
  try {
    listed = JSON.parse(gh(['pr', 'list', '--json', 'number,body,labels', '--state', 'open', '--limit', '100', ...(flag ? ['--repo', flag] : [])]));
  } catch {
    return 0;
  }
  if (!Array.isArray(listed)) return 0;
  const needsApprove: string[] = [];
  const unchecked: string[] = [];
  for (const entry of listed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const number = (entry as { number?: unknown }).number;
    if (typeof number !== 'number') continue;
    const tier = listTier(entry as { body?: unknown; labels?: unknown });
    if (tier !== null && tier !== 'A') continue;
    const refusal = approvalRefusal(gh, run.cwd, invocation.env, number, repo);
    if (!refusal) continue;
    const row = `- #${number}: ${refusal.text}`;
    // A check that could not be read is not a missing Approve.
    if (refusal.kind === 'unchecked') unchecked.push(row);
    else needsApprove.push(row);
  }
  if (needsApprove.length) print(invocation, ['yokoten bot: these need a new owner Approve before they merge:', ...needsApprove]);
  if (unchecked.length) print(invocation, ['yokoten bot: these could not be checked:', ...unchecked]);
  return 0;
}

export function runBot(invocation: Invocation): number | Promise<number> {
  const { args } = invocation;
  // No options of its own: everything after `--` is the command, passed on unchanged.
  const end = args.indexOf('--');
  const options = parse('bot', end === -1 ? args : args.slice(0, end));
  if (typeof options === 'string') return usage(invocation, options);
  return bot(invocation, end === -1 ? [] : args.slice(end + 1));
}
