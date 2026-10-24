// `yokoten train <pr>...`: merge an approved queue one pull request at a time (#320).
//
// A hand-run merge order broke in three ways: a pull request stacked on a branch that was
// squash-merged and deleted merged onto a merge base older than its own copy of the base,
// which conflicts or repeats a block; two branches that add a name to the same import line
// conflict; and no gate ran between merges, so each pull request was tested against the
// main it grew from, not the main it lands on.
//
// This command keeps a gate between each merge. It records every pull request's base
// before the first merge, since GitHub forgets that base when it deletes the branch. For
// each pull request it refuses unless approved and green, brings main in with the merge
// base the branch really shares with its old base, resolves conflicts that are only
// import lines by taking the union, runs the project's tests and `check` on the merged
// tree, pushes the merge and waits for CI when GitHub would merge from a different base,
// then squash-merges. The first pull request that needs a person stops the train.
//
// The host and the tests are an API (TrainApi), so the git half runs against local
// branches in a test with no network. The command's default is the bot on GitHub.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { botConfig } from '../../host/github/index.ts';
import type { Env } from '../../rules/config.ts';
import { workerRole } from '../../rules/guards/index.ts';
import { runGit } from '../../run/check.ts';
import { runBot } from './bot.ts';
import { listPullRequests, nextPick } from './conflicts/order.ts';
import { MAP_FILE, MAP_MAX_AGE_MS, type ConflictMap } from './conflicts/types.ts';
import { type Invocation, type Output, parse, print, requireRoot, usage } from '../shared.ts';

/** How long one test or check run may take, in ms. */
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
/** How often `waitForChecks` asks GitHub again, in ms. */
const POLL_MS = 15000;
/** The default time to wait for CI after a push, in seconds. */
const WAIT_SECONDS = 1800;

/** The state of a pull request that the train has to trust. */
export interface PullRequest {
  number: number;
  /** The branch it lands on now, which may have moved since it was opened. */
  baseBranch: string;
  /** The tip of that branch now. */
  baseOid: string;
  headBranch: string;
  headOid: string;
  /** A code owner approved the current head, or a merge of the base since. */
  approved: boolean;
  checks: 'green' | 'red' | 'pending' | 'none';
  merged: boolean;
  draft: boolean;
}

/** What the train needs from the host and from the project. A string is the reason it stopped. */
export interface TrainApi {
  /** The pull request as the host sees it now. */
  read(number: number): Promise<PullRequest | string>;
  /** Make every pull request's base and head commits readable in this clone. */
  prepare(states: PullRequest[]): Promise<{ number: number; why: string } | null>;
  /** Push a local merge to the pull request's branch. */
  push(state: PullRequest, commit: string): Promise<string | null>;
  /** Wait until the checks on `commit` pass. */
  waitForChecks(state: PullRequest, commit: string): Promise<string | null>;
  /** Squash-merge the pull request on the host. */
  squashMerge(state: PullRequest): Promise<string | null>;
  /** Run the project's tests and check at `commit`; null when both pass. */
  verify(commit: string): Promise<string | null>;
}

/** Where the train got to: the pull requests it merged, and the first one that needed a person. */
export interface TrainResult {
  merged: number[];
  stopped: { number: number; why: string } | null;
}

/** One recorded base, taken before the first merge deletes or moves it. */
interface RecordedBase {
  branch: string;
  oid: string;
}

/** A merged result: a tree, or the paths that conflict. */
interface MergedTree {
  tree: string;
  conflicts: string[];
}

/**
 * Merge an approved queue in the given order. It stops at the first pull request that needs
 * a person, and says which one and why. Nothing is merged when a read or a check fails.
 */
export async function runQueue({ root, env, prs, api, say }: { root: string; env: Env; prs: number[]; api: TrainApi; say: (line: string) => void }): Promise<TrainResult> {
  const merged: number[] = [];
  const readStates: PullRequest[] = [];
  for (const number of prs) {
    const state = await api.read(number);
    if (typeof state === 'string') return { merged, stopped: { number, why: state } };
    readStates.push(state);
  }
  // The base of every pull request is recorded now, before the first squash deletes the
  // branch and GitHub retargets the stack to the default branch. That is the only record
  // of the commit the stacked branch really shares with its old base.
  const recorded = new Map<number, RecordedBase>(readStates.map((state) => [state.number, { branch: state.baseBranch, oid: state.baseOid }]));
  const prepared = await api.prepare(readStates);
  if (prepared) return { merged, stopped: prepared };

  for (const number of prs) {
    const stopped = async (why: string): Promise<TrainResult> => ({ merged, stopped: { number, why } });
    const state = await api.read(number);
    if (typeof state === 'string') return stopped(state);
    if (state.merged) {
      say(`PR ${number}: already merged`);
      merged.push(number);
      continue;
    }
    if (state.draft) return stopped('the pull request is a draft');
    if (!state.approved) return stopped('no approving review from a code owner');
    if (state.checks !== 'green') return stopped(state.checks === 'none' ? 'the pull request has no checks' : `the checks are ${state.checks}`);
    say(`PR ${number}: approved and green on ${state.headOid.slice(0, 12)}`);

    try {
      // Which merge base the branch really shares with the branch it lands on: the newest
      // commit of its old base while that base existed, when the base was squash-merged.
      const base = mergeBaseOf(root, env, state, recorded.get(number));
      const isCurrent = isAncestor(root, env, state.baseOid, state.headOid);
      let target = state.headOid;
      let pushed = false;
      if (!isCurrent) {
        const mergedTree = mergeTreeOf(root, env, base, state.baseOid, state.headOid);
        let tree = mergedTree.tree;
        if (mergedTree.conflicts.length) {
          const resolved = resolveImports(root, env, tree, mergedTree.conflicts);
          if ('why' in resolved) return stopped(resolved.why);
          tree = resolved.tree;
          say(`PR ${number}: took the union of the import lines in ${mergedTree.conflicts.join(', ')}`);
        }
        target = commitMerge(root, env, tree, state.baseOid, state.headOid, state.baseBranch, state.headBranch);
        say(`PR ${number}: merged ${state.baseBranch} into ${state.headBranch}${base === state.baseOid ? '' : ' at the base it shares with its old branch'}`);
      }

      // The gate: the merged tree is tested before anything is pushed, so a broken merge
      // never reaches the pull request's checks or the reviewer.
      const failed = await api.verify(target);
      if (failed) return stopped(failed);
      say(`PR ${number}: tests and check pass on the merged tree`);

      if (!isCurrent) {
        const refused = await api.push(state, target);
        if (refused) return stopped(refused);
        pushed = true;
        const waiting = await api.waitForChecks(state, target);
        if (waiting) return stopped(waiting);
        say(`PR ${number}: CI is green on the pushed merge`);
      }

      // Without a push the checked head is the head GitHub will squash; with one it is the
      // merge GitHub will squash, and both have just been tested.
      const refused = await api.squashMerge(state);
      if (refused) return stopped(refused);
      merged.push(number);
      say(`PR ${number}: squash-merged${pushed ? ' after the pushed merge' : ''}`);
    } catch (err) {
      return stopped(firstLine((err as Error).message ?? String(err)));
    }
  }
  return { merged, stopped: null };
}

/** The base to merge from: the recorded old-base tip when that base was squashed, else git's merge base. */
function mergeBaseOf(root: string, env: Env, state: PullRequest, recorded: RecordedBase | undefined): string {
  if (recorded && hasLocalCommit(root, env, recorded.oid)) {
    // The old base branch is gone, or its commits are no longer in the base that took its
    // place: a squash replaced them. The recorded tip is the newest commit both sides know.
    const lost = recorded.branch !== state.baseBranch || !isAncestor(root, env, recorded.oid, state.baseOid);
    if (lost && isAncestor(root, env, recorded.oid, state.headOid)) return recorded.oid;
  }
  const result = runGit(root, ['merge-base', state.baseOid, state.headOid], { env, okCodes: [0, 1] });
  if (result.status !== 0) throw new Error(`pull request ${state.number} and ${state.baseBranch} have no common commit`);
  return text(result.stdout);
}

/** The three-way merge of base, base branch and head. Conflict paths come with it. */
function mergeTreeOf(root: string, env: Env, base: string, baseOid: string, headOid: string): MergedTree {
  const result = runGit(root, ['merge-tree', '--write-tree', '--no-messages', '-z', '--name-only', `--merge-base=${base}`, baseOid, headOid], { env, okCodes: [0, 1] });
  const parts = result.stdout.toString('utf8').split('\0').filter(Boolean);
  return { tree: parts[0], conflicts: parts.slice(1) };
}

/**
 * Resolve conflicts that are only import lines, by taking the union. Returns the new tree,
 * or the reason it stopped when any file needs a person.
 */
function resolveImports(root: string, env: Env, tree: string, paths: string[]): { tree: string } | { why: string } {
  const blobs = treeBlobs(root, env, tree);
  const resolved = new Map<string, string>();
  for (const path of paths) {
    const oid = blobs.get(path);
    if (oid === undefined) return { why: `a real conflict in ${path}` };
    const blob = runGit(root, ['cat-file', 'blob', oid], { env }).stdout;
    const content = blob.toString('utf8');
    if (content.includes('\0')) return { why: `a real conflict in ${path}` };
    const union = resolveImportFile(content);
    if (union === null) return { why: `a real conflict in ${path}` };
    resolved.set(path, union);
  }
  const index = mkdtempSync(join(tmpdir(), 'yokoten-train-index-'));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: join(index, 'index') };
    runGit(root, ['read-tree', tree], { env: indexEnv });
    for (const [path, content] of resolved) {
      const oid = text(runGit(root, ['hash-object', '-w', '--stdin'], { env, input: content }).stdout);
      runGit(root, ['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], { env: indexEnv });
    }
    return { tree: text(runGit(root, ['write-tree'], { env: indexEnv }).stdout) };
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}

/** Every blob in a tree, by path. */
function treeBlobs(root: string, env: Env, tree: string): Map<string, string> {
  const out = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', tree], { env }).stdout.toString('utf8');
  const blobs = new Map<string, string>();
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [kind, oid] = entry.slice(0, tab).split(' ').slice(1);
    if (kind !== 'blob') continue;
    blobs.set(entry.slice(tab + 1), oid);
  }
  return blobs;
}

/** A conflict block with the two sides git could not reconcile. */
interface ConflictBlock {
  ours: string;
  theirs: string;
}

/** The parts of a file: plain text, or a conflict. */
type FilePart = { kind: 'text'; text: string } | ({ kind: 'conflict' } & ConflictBlock);

/**
 * The file with every conflict replaced by the union of its import lines, or null when
 * one conflict is more than imports and needs a person.
 */
export function resolveImportFile(content: string): string | null {
  const parts = splitConflicts(content);
  if (!parts || !parts.some((part) => part.kind === 'conflict')) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      out.push(part.text);
      continue;
    }
    const union = unionImports(part.ours, part.theirs);
    if (union === null) return null;
    out.push(union);
  }
  return out.join('');
}

function splitConflicts(content: string): FilePart[] | null {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const parts: FilePart[] = [];
  let plain = '';
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith('<<<<<<<')) {
      plain += line;
      index++;
      continue;
    }
    if (plain) parts.push({ kind: 'text', text: plain });
    plain = '';
    index++;
    const ours: string[] = [];
    const theirs: string[] = [];
    let side: 'ours' | 'base' | 'theirs' = 'ours';
    let closed = false;
    for (; index < lines.length; index++) {
      const at = lines[index];
      if (at.startsWith('|||||||')) {
        side = 'base';
        continue;
      }
      if (/^=======\s*$/.test(at)) {
        side = 'theirs';
        continue;
      }
      if (at.startsWith('>>>>>>>')) {
        closed = true;
        index++;
        break;
      }
      if (side === 'ours') ours.push(at);
      else if (side === 'theirs') theirs.push(at);
    }
    if (!closed) return null;
    parts.push({ kind: 'conflict', ours: ours.join(''), theirs: theirs.join('') });
  }
  if (plain) parts.push({ kind: 'text', text: plain });
  return parts;
}

/** One import statement, as far as the union has to read it. */
interface ImportPart {
  module: string;
  quote: string;
  /** `named` is `import { a, b } from 'm'`, the only kind whose names join. */
  kind: 'named' | 'other' | 'side';
  names: string[];
  typeOnly: boolean;
  text: string;
}

/**
 * The union of two sides that are made only of import lines: imports of one module with
 * only names join their names; every other import statement is kept as it is. Null when a
 * side has anything that is not an import.
 */
function unionImports(ours: string, theirs: string): string | null {
  const left = parseImportBlock(ours);
  const right = parseImportBlock(theirs);
  if (!left || !right) return null;
  const out = left.map((part) => ({ ...part, names: [...part.names] }));
  for (const part of right) {
    const join = out.find((held) => held.kind === 'named' && part.kind === 'named' && held.module === part.module && held.typeOnly === part.typeOnly);
    if (join) {
      for (const name of part.names) if (!join.names.includes(name)) join.names.push(name);
      continue;
    }
    if (!out.some((held) => held.text === part.text)) out.push({ ...part, names: [...part.names] });
  }
  return out.map(renderImport).map((line) => `${line}\n`).join('');
}

function parseImportBlock(side: string): ImportPart[] | null {
  const text = side.trim();
  if (!text) return null;
  const parts: ImportPart[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index >= text.length) break;
    const parsed = readImport(text.slice(index));
    if (!parsed) return null;
    parts.push(parsed.part);
    index += parsed.length;
  }
  return parts.length ? parts : null;
}

const IMPORT_SIDE = /^import\s*(['"])([^'"]+)\1\s*;?/;
const IMPORT_FROM = /^import\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2\s*;?/;
const NAMED_ONLY = /^\{([\s\S]*)\}$/;
const DEFAULT_AND_NAMED = /^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*)\}$/;

/** One import statement at the start of `text`, and how many characters it took. */
function readImport(text: string): { part: ImportPart; length: number } | null {
  const side = IMPORT_SIDE.exec(text);
  if (side) {
    return { part: { module: side[2], quote: side[1], kind: 'side', names: [], typeOnly: false, text: `import '${side[2]}';` }, length: side[0].length };
  }
  const found = IMPORT_FROM.exec(text);
  if (!found) return null;
  const clause = found[1].trim();
  const quote = found[2];
  const module = found[3];
  const length = found[0].length;
  if (!clause) return null;
  const typeOnly = /^type\s+/.test(clause);
  const rest = clause.replace(/^type\s+/, '');
  const named = NAMED_ONLY.exec(rest);
  if (named) {
    const names = named[1].split(',').map((name) => name.trim()).filter(Boolean);
    if (!names.length || names.some((name) => /[{};]/.test(name))) return null;
    return { part: { module, quote, kind: 'named', names, typeOnly, text: '' }, length };
  }
  if (DEFAULT_AND_NAMED.test(rest)) {
    return { part: { module, quote, kind: 'other', names: [], typeOnly, text: `import ${rest} from ${quote}${module}${quote};` }, length };
  }
  if (!/^(\*\s+as\s+)?[A-Za-z_$][\w$]*$/.test(rest)) return null;
  return { part: { module, quote, kind: 'other', names: [], typeOnly, text: `import ${rest} from ${quote}${module}${quote};` }, length };
}

function renderImport(part: ImportPart): string {
  if (part.kind === 'side') return part.text;
  if (part.kind === 'named') return `import${part.typeOnly ? ' type' : ''} { ${part.names.join(', ')} } from ${part.quote}${part.module}${part.quote};`;
  return part.text;
}

/** The merge commit: the tested tree, with the base first so the branch keeps its history. */
function commitMerge(root: string, env: Env, tree: string, baseOid: string, headOid: string, baseBranch: string, headBranch: string): string {
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const name = env.YOKOTEN_BOT_NAME || 'yokoten-bot';
  const email = env.YOKOTEN_BOT_EMAIL || 'yokoten-bot@users.noreply.github.com';
  const commitEnv = { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const message = `Merge branch '${baseBranch}' into ${headBranch}\n\nBrings the branch up to date with ${baseBranch}, so the pull request lands on the tree the train tested.\n`;
  return text(runGit(root, ['commit-tree', tree, '-p', baseOid, '-p', headOid, '-F', '-'], { env: commitEnv, input: message }).stdout);
}

function isAncestor(root: string, env: Env, older: string, newer: string): boolean {
  const result = runGit(root, ['merge-base', '--is-ancestor', older, newer], { env, okCodes: [0, 1] });
  return result.status === 0;
}

function hasLocalCommit(root: string, env: Env, oid: string): boolean {
  try {
    runGit(root, ['cat-file', '-e', `${oid}^{commit}`], { env });
    return true;
  } catch {
    return false;
  }
}

const text = (bytes: Buffer): string => bytes.toString('utf8').trim();

/** The first non-empty line of a message, short enough to print. */
function firstLine(message: string): string {
  const line = message.split('\n').map((part) => part.trim()).find(Boolean) ?? 'it needs a person';
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * Run the project's tests and `check` at `commit`, in a temporary worktree. It links the
 * main checkout's node_modules when there is one, because a worktree does not have it.
 * Returns null when both pass, or the first line of what failed.
 */
export function verifyInWorktree({ root, commit, env, script, cwd }: { root: string; commit: string; env: Env; script: string; cwd: string }): string | null {
  const place = mkdtempSync(join(tmpdir(), 'yokoten-train-'));
  const tree = join(place, 'tree');
  try {
    runGit(root, ['worktree', 'add', '--detach', '--quiet', tree, commit], { env });
    const modules = join(root, 'node_modules');
    if (existsSync(modules) && !existsSync(join(tree, 'node_modules'))) {
      try {
        symlinkSync(modules, join(tree, 'node_modules'), 'dir');
      } catch {
        // A link that cannot be made is not a reason to stop: the tests say what is missing.
      }
    }
    const hasTests = (() => {
      try {
        const config = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')) as { scripts?: { test?: unknown } };
        return typeof config.scripts?.test === 'string';
      } catch {
        return false;
      }
    })();
    if (hasTests) {
      const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const result = spawnSync(command, ['test'], { cwd: tree, env, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS });
      if (result.status !== 0) return `the project's tests fail: ${firstLine(result.stdout || result.stderr || 'npm test gave no answer')}`;
    }
    const scriptPath = isAbsolute(script) ? script : resolve(cwd, script);
    const result = spawnSync(process.execPath, [scriptPath, 'check'], { cwd: tree, env, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS });
    if (result.status !== 0) return `check fails: ${firstLine(result.stdout || result.stderr || 'check gave no answer')}`;
    return null;
  } finally {
    try {
      runGit(root, ['worktree', 'remove', '--force', tree], { env });
    } catch {
      // The folder is removed below; a stale worktree entry is doctor's business.
    }
    rmSync(place, { recursive: true, force: true });
  }
}

/** A stream a bot call writes into, so its answer can be read as JSON. */
function collect(): { stream: Output; read: () => string } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array) {
      chunks.push(String(chunk));
      return true;
    },
  } as Output;
  return { stream, read: () => chunks.join('') };
}

/**
 * The GitHub side of the train: reads through `yokoten bot -- gh`, pushes through the
 * bot's git credentials, and verifies in a worktree. Only the lead runs this.
 */
function githubApi({ invocation, root, waitSeconds }: { invocation: Invocation; root: string; waitSeconds: number }): TrainApi {
  const asBot = async (words: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const stdout = collect();
    const stderr = collect();
    const code = await runBot({
      ...invocation,
      command: 'bot',
      args: ['--', ...words],
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: { fd: null, text: '', stream: Readable.from([]) },
    });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const read = async (number: number): Promise<PullRequest | string> => {
    const result = await asBot(['gh', 'pr', 'view', String(number), '--json', 'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,reviewDecision,statusCheckRollup']);
    if (result.code !== 0) return firstLine(result.stderr || `gh could not read pull request ${number}`);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return `gh gave no readable answer for pull request ${number}`;
    }
    return {
      number,
      baseBranch: String(data.baseRefName ?? ''),
      baseOid: String(data.baseRefOid ?? ''),
      headBranch: String(data.headRefName ?? ''),
      headOid: String(data.headRefOid ?? ''),
      approved: data.reviewDecision === 'APPROVED',
      checks: checksOf(data.statusCheckRollup),
      merged: data.state === 'MERGED',
      draft: data.isDraft === true,
    };
  };
  const prepare = async (states: PullRequest[]): Promise<{ number: number; why: string } | null> => {
    const branches = [...new Set(states.flatMap((state) => [state.baseBranch, state.headBranch]).filter(Boolean))];
    for (const branch of branches) {
      // A branch that is already gone (a stacked one, after its base merged) is not an
      // error here: its commit is fetched with the next branch, or it is already local.
      try {
        runGit(root, ['fetch', '--quiet', '--no-tags', 'origin', branch], { env: invocation.env });
      } catch {
        // The read below fails closed when a commit is really missing.
      }
    }
    for (const state of states) {
      for (const oid of [state.baseOid, state.headOid]) {
        if (!oid || !hasLocalCommit(root, invocation.env, oid)) return { number: state.number, why: `the commits of pull request ${state.number} are not in this checkout` };
      }
    }
    return null;
  };
  const push = async (state: PullRequest, commit: string): Promise<string | null> => {
    const result = await asBot(['git', 'push', '--quiet', 'origin', `${commit}:refs/heads/${state.headBranch}`]);
    return result.code === 0 ? null : `the push was refused: ${firstLine(result.stderr || 'git push gave no answer')}`;
  };
  const waitForChecks = async (state: PullRequest, commit: string): Promise<string | null> => {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const now = await read(state.number);
      if (typeof now === 'string') return now;
      if (now.checks === 'red') return 'the checks fail on the pushed merge';
      if (now.headOid === commit && now.checks === 'green') return null;
      if (Date.now() >= deadline) return `the checks were still ${now.checks} after ${waitSeconds} s`;
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  };
  const squashMerge = async (state: PullRequest): Promise<string | null> => {
    const result = await asBot(['gh', 'pr', 'merge', String(state.number), '--squash', '--delete-branch']);
    if (result.code !== 0) return `the merge was refused: ${firstLine(result.stderr || 'gh pr merge gave no answer')}`;
    // Bring the moved base branch into this clone, so the next pull request sees the main
    // it will land on, not the one it grew from. The next merge base comes from this fetch.
    try {
      runGit(root, ['fetch', '--quiet', '--no-tags', 'origin'], { env: invocation.env });
    } catch (err) {
      return `the base branch could not be fetched after the merge: ${firstLine((err as Error).message ?? String(err))}`;
    }
    return null;
  };
  const verify = async (commit: string): Promise<string | null> => verifyInWorktree({ root, commit, env: invocation.env, script: invocation.script, cwd: invocation.cwd });
  return { read, prepare, push, waitForChecks, squashMerge, verify };
}

/** Green means every check finished with a pass, a skip or a neutral result. */
function checksOf(list: unknown): PullRequest['checks'] {
  if (!Array.isArray(list) || !list.length) return 'none';
  let pending = false;
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const check = entry as Record<string, unknown>;
    const conclusion = String(check.conclusion ?? '');
    const state = String(check.state ?? '');
    if (state === 'SUCCESS' || ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) continue;
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(conclusion) || state === 'FAILURE' || state === 'ERROR') return 'red';
    pending = true;
  }
  return pending ? 'pending' : 'green';
}

/**
 * The conflict map this clone built, or a plain reason there is none to read. The reason
 * names the map file, never a full path, so it says nothing about the person's machine.
 */
function readConflictMap(root: string, env: Env): ConflictMap | string {
  const commonDir = text(runGit(root, ['rev-parse', '--git-common-dir'], { env }).stdout);
  const path = resolve(root, commonDir, MAP_FILE);
  if (!existsSync(path)) return `no conflict map at ${MAP_FILE} in this clone; run \`yokoten conflicts\` first, then the train again`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `the conflict map at ${MAP_FILE} is not readable JSON; run \`yokoten conflicts\` again`;
  }
  if (!isConflictMap(parsed)) return `the conflict map at ${MAP_FILE} has a shape this version cannot read; run \`yokoten conflicts\` again with this version of yokoten`;
  // An old map names changes that merged since and misses new ones: order nothing from it.
  const age = Date.now() - Date.parse(parsed.builtAt);
  if (!Number.isFinite(age) || age > MAP_MAX_AGE_MS) return `the conflict map at ${MAP_FILE} is more than an hour old; run \`yokoten conflicts\` again`;
  return parsed;
}

/** Whether the parsed file is a map this version reads. A version it does not know counts as missing. */
function isConflictMap(value: unknown): value is ConflictMap {
  if (typeof value !== 'object' || value === null) return false;
  const map = value as Partial<ConflictMap>;
  return map.version === 1 && Array.isArray(map.changes) && Array.isArray(map.collisions);
}

/** `yokoten train <pr>...`: the command's entry, which refuses a worker and reads the queue. */
export async function runTrain(invocation: Invocation): Promise<number> {
  const options = parse('train', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const isNext = options.flags.has('--next');
  if (isNext && options.positional.length) return usage(invocation, '--next prints the next pick; leave the pull request numbers out');
  const given = options.positional.map((word) => Number(word));
  if (given.some((number) => !Number.isInteger(number) || number <= 0)) return usage(invocation, 'a pull request number is a whole number above zero, as in `yokoten train 1207 1209`');
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  if (workerRole(invocation.env, [invocation.cwd, root]) !== null) {
    print(invocation, ['yokoten train: only the lead runs the train; report to the lead instead'], invocation.stderr);
    return 1;
  }
  const map = isNext || !given.length ? readConflictMap(root, invocation.env) : null;
  if (typeof map === 'string') {
    print(invocation, [`yokoten train: ${map}`], invocation.stderr);
    return 1;
  }
  if (map && isNext) {
    const pick = nextPick(map);
    if (!pick) {
      print(invocation, ['yokoten train: no open change to merge in the conflict map']);
      return 0;
    }
    const label = map.changes.find((change) => change.id === pick.id)?.label ?? pick.id;
    print(invocation, [`yokoten train: next is ${label}: ${pick.why}`]);
    return 0;
  }
  const prs = given.length ? given : map ? listPullRequests(map) : [];
  if (!prs.length) {
    print(invocation, ['yokoten train: the conflict map names no pull request to merge; name one, as in `yokoten train 1207`'], invocation.stderr);
    return 1;
  }
  const wait = options.values['--wait'] === undefined ? WAIT_SECONDS : Number(options.values['--wait']);
  if (!Number.isInteger(wait) || wait <= 0) return usage(invocation, '--wait takes a whole number of seconds');
  const config = botConfig(invocation.env);
  if (typeof config === 'string') {
    print(invocation, [`yokoten train: ${config}`], invocation.stderr);
    return 1;
  }
  const api = githubApi({ invocation, root, waitSeconds: wait });
  const result = await runQueue({ root, env: invocation.env, prs, api, say: (line) => print(invocation, [line]) });
  if (!result.stopped) {
    print(invocation, [`yokoten train: merged ${result.merged.length} of ${prs.length} pull request(s)`]);
    return 0;
  }
  print(invocation, [`yokoten train: stopped at pull request ${result.stopped.number}: ${result.stopped.why}`], invocation.stderr);
  return 1;
}
