// The commit a code owner approved (#612): `yokoten bot` refuses `gh pr merge` of a
// tier A pull request whose Approve is on an older commit, so code nobody reviewed
// can't merge.

import { execFileSync } from 'node:child_process';
import type { Env } from '../../rules/config.ts';
import type { ApprovalRead, CodeOwners } from '../../rules/pr.ts';
import { ownersOf, parseCodeOwners, prTier } from '../../rules/pr.ts';
import { asText, type Gh, isObject, labelNames } from './planning.ts';
import { readCodeOwners } from './pull-request.ts';

// An Approve counts when its author owns the changed files: the owner's login approves
// with a COLLABORATOR association on this repo, so the association never counts, only
// CODEOWNERS membership does. Among the deciding reviews of the owners (APPROVED,
// CHANGES_REQUESTED, DISMISSED), the newest decides: a newer changes-requested or
// dismissed review refuses. A COMMENTED review is neutral. Fail closed: what git or gh
// can't answer is an `unsure`, and the caller refuses it.

/** A deciding review by a code owner, as the `reviews` endpoint names it. */
interface OwnerReview {
  login: string;
  state: string;
  commit: string;
  at: string;
}

/** The review states that decide a merge. Any other state, such as COMMENTED, is neutral. */
const DECIDING_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/**
 * The newest deciding review by a code owner, or null with none. `eligible` holds
 * every owner login in lowercase. A review with no commit or time can't be placed,
 * so it never counts as the newest.
 */
function latestOwnerDecision(text: string, eligible: Set<string>): OwnerReview | null {
  let newest: OwnerReview | null = null;
  // The states decided in the newest second: more than one means a tie.
  const newestStates = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let review: unknown;
    try {
      review = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(review) || !DECIDING_STATES.has(asText(review.state))) continue;
    if (typeof review.commit !== 'string' || !review.commit || typeof review.at !== 'string' || !review.at) continue;
    const login = asText(review.login);
    if (!login || !eligible.has(login.toLowerCase())) continue;
    const state = asText(review.state);
    if (!newest || review.at > newest.at) {
      newest = { login, state, commit: review.commit, at: review.at };
      newestStates.clear();
      newestStates.add(state);
    } else if (review.at.slice(0, 19) === newest.at.slice(0, 19)) {
      newestStates.add(state);
    }
  }
  // Two deciding reviews sharing the newest second with different states: neither
  // wins by being listed first, so there is no decision. The caller refuses with
  // the plain message, the way it does with no Approve.
  if (newest && newestStates.size > 1) return null;
  return newest;
}

/**
 * The code owners named by CODEOWNERS entries: plain logins, and teams as
 * "org/slug". An entry that names nobody who can approve through GitHub, such as
 * an email, is ignored: it never makes anyone an owner.
 */
function splitOwners(entries: string[]): { users: string[]; teams: string[] } {
  const users: string[] = [];
  const teams: string[] = [];
  for (const entry of entries) {
    const team = /^@([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(entry.trim());
    if (team) {
      teams.push(`${team[1]}/${team[2]}`);
      continue;
    }
    const user = /^@?([A-Za-z0-9-]+)$/.exec(entry.trim());
    if (user) users.push(user[1].toLowerCase());
  }
  return { users, teams };
}

/** The logins of an `@org/team`'s members in lowercase, or null when gh can't list them. */
function teamMembers(gh: Gh, team: string): string[] | null {
  const [org, slug] = team.split('/');
  try {
    const text = gh(['api', `orgs/${org}/teams/${slug}/members`, '--paginate', '--jq', '.[] | .login | tojson']);
    const members: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let login: unknown;
      try {
        login = JSON.parse(line);
      } catch {
        return null;
      }
      if (typeof login !== 'string' || !login) return null;
      members.push(login.toLowerCase());
    }
    return members;
  } catch {
    return null;
  }
}

/**
 * The changed files of pull request `number`, or null when gh can't list them.
 * A line gh can't parse fails the whole read: a half-known file list is never a pass.
 */
function changedFiles(gh: Gh, number: number, repo: string): string[] | null {
  let text: string;
  try {
    text = gh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--jq', '.[] | .filename | tojson']);
  } catch {
    return null;
  }
  const files: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let file: unknown;
    try {
      file = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof file === 'string') files.push(file);
    else if (Array.isArray(file)) {
      for (const item of file) {
        if (typeof item !== 'string') return null;
        files.push(item);
      }
    } else return null;
  }
  return files;
}

/** How long a git read for the Approve check may take (ms): the same budget as a gh read. */
export const APPROVAL_GIT_TIMEOUT_MS = 15000;

/** One git command's output, or null when git can't answer. Never throws. */
function gitRead(root: string, args: string[], env: Env, input?: string): string | null {
  try {
    return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: input === undefined ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore'], input, timeout: APPROVAL_GIT_TIMEOUT_MS });
  } catch {
    return null;
  }
}

/** Whether `sha` names a commit in this checkout. */
function hasLocalCommit(root: string, sha: string, env: Env): boolean {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return false;
  try {
    execFileSync('git', ['--no-replace-objects', 'cat-file', '-e', `${sha}^{commit}`], { cwd: root, env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The stable name of a diff: the same changes on moved lines give the same name. */
function patchName(root: string, from: string, to: string, env: Env): string | null {
  // No context lines (`-U0`): a base merge that moves lines keeps the name, a new change does not.
  const diff = gitRead(root, ['--no-replace-objects', 'diff', '-U0', '--no-color', '--no-ext-diff', `${from}`, `${to}`, '--'], env);
  if (diff === null) return null;
  if (!diff) return 'empty';
  const named = gitRead(root, ['patch-id', '--stable'], env, diff);
  const name = named?.split('\n').map((line) => line.split(' ')[0]).filter(Boolean).sort().join(' ');
  return name ? name : null;
}

/**
 * What the Approve check knows about pull request `number` in `repo` ("owner/name"):
 * its tier, its head, and what came after the latest Approve by a code owner of its
 * changed files. `unsure` when gh or git can't answer, with the reason; the caller
 * refuses it. Reads no token itself: `gh` runs with whatever sign-in the caller set up.
 */
export function readApprovalState(gh: Gh, root: string, env: Env, number: number, repo: string): ApprovalRead | { unsure: string } {
  let pulled: unknown;
  try {
    pulled = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
  } catch {
    return { unsure: `gh could not read pull request ${number}` };
  }
  if (!isObject(pulled)) return { unsure: `gh gave no pull request ${number}` };
  const headRef = isObject(pulled.head) ? pulled.head : {};
  const baseRef = isObject(pulled.base) ? pulled.base : {};
  const head = asText(headRef.sha);
  const base = asText(baseRef.sha);
  if (!head || !base) return { unsure: `gh gave no commits for pull request ${number}` };
  const tier = prTier(asText(pulled.body), labelNames(pulled.labels));
  if (tier === null) return { unsure: `neither the body nor a label says the tier of pull request ${number}` };
  if (tier !== 'A') return { tier, head, approved: null, after: 0, sameDiff: true };
  const files = changedFiles(gh, number, repo);
  if (files === null) return { unsure: `gh could not read the changed files of pull request ${number}` };
  let owners: CodeOwners | null;
  try {
    owners = readCodeOwners(root, base, env);
  } catch {
    return { unsure: `the CODEOWNERS file for pull request ${number} could not be read` };
  }
  if (!owners) return { unsure: `no CODEOWNERS file covers pull request ${number}, so no code owner can approve it` };
  const rules = parseCodeOwners(owners.text);
  let entries = [...new Set(files.flatMap((file) => ownersOf(rules, file)))];
  if (!entries.length) {
    // GitHub's code-owner rule enforces nothing file-specific on unowned files,
    // so requiring any repo owner is strictly stronger than GitHub there.
    entries = [...new Set(rules.flatMap((rule) => rule.owners))];
  }
  const { users, teams } = splitOwners(entries);
  const eligible = new Set(users);
  for (const team of teams) {
    const members = teamMembers(gh, team);
    if (members === null) return { unsure: `gh could not list the members of @${team} for pull request ${number}` };
    for (const login of members) eligible.add(login);
  }
  if (!eligible.size) return { unsure: `no code owner owns the changed files of pull request ${number}` };
  let reviews = '';
  try {
    reviews = gh(['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate', '--jq', '.[] | {login: .user.login, assoc: .author_association, state: .state, commit: .commit_id, at: .submitted_at}']);
  } catch {
    return { unsure: `gh could not read the reviews of pull request ${number}` };
  }
  const decision = latestOwnerDecision(reviews, eligible);
  // No code owner Approve, or a newer changes-requested or dismissed review from a
  // code owner: the pull request may still be waiting for its review.
  if (!decision || decision.state !== 'APPROVED') return { tier, head, approved: null, after: 0, sameDiff: true };
  const approved = decision.commit;
  if (approved.toLowerCase() === head.toLowerCase()) return { tier, head, approved, after: 0, sameDiff: true };
  // The commits may live on GitHub only: fetch the pull request's head and the base
  // branch first, the way `gh pr edit <number>` names them. A fetch that fails is
  // ignored; the commit reads below fail closed.
  const headName = asText(headRef.ref);
  const baseName = asText(baseRef.ref);
  for (const ref of [`pull/${number}/head`, ...(headName ? [headName] : []), ...(baseName ? [baseName] : [])]) {
    gitRead(root, ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', ref], env);
  }
  if (!hasLocalCommit(root, approved, env) || !hasLocalCommit(root, head, env) || !hasLocalCommit(root, base, env)) {
    return { unsure: `the commits of pull request ${number} are not all in this checkout` };
  }
  // The Approve's commit may come from a rewritten history, so ancestor is checked, not
  // assumed. `--is-ancestor` prints nothing: only a throw says it is not one.
  const ancestor = gitRead(root, ['--no-replace-objects', 'merge-base', '--is-ancestor', approved, head], env) !== null;
  // `--not base`: a base commit the merge brought in is not the pull request's own.
  const count = gitRead(root, ['--no-replace-objects', 'rev-list', '--count', '--no-merges', `${approved}..${head}`, '--not', base, '--'], env);
  if (count === null || !/^\d+\s*$/.test(count)) return { unsure: `git could not list what came after the Approve on pull request ${number}` };
  const after = Number(count.trim());
  if (!ancestor) return { tier, head, approved, after: Math.max(after, 1), sameDiff: false };
  if (after > 0) return { tier, head, approved, after, sameDiff: false };
  // Only merges of the base branch came after the Approve: the pull request's own diff
  // must still be the same. Each side is diffed from where it left the base, and the
  // stable names match when the changes match, even on moved lines.
  const oldBase = gitRead(root, ['--no-replace-objects', 'merge-base', base, approved], env)?.trim();
  const newBase = gitRead(root, ['--no-replace-objects', 'merge-base', base, head], env)?.trim();
  if (!oldBase || !newBase) return { unsure: `git could not find where pull request ${number} left the base branch` };
  const oldName = patchName(root, oldBase, approved, env);
  const newName = patchName(root, newBase, head, env);
  if (oldName === null || newName === null) return { unsure: `git could not compare pull request ${number} with its Approve` };
  return { tier, head, approved, after: 0, sameDiff: oldName === newName };
}
