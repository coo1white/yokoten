// The commit a code owner approved (#612): `yokoten bot` refuses `gh pr merge` of a
// tier A pull request whose Approve is on an older commit, so code nobody reviewed
// can't merge.

import { execFileSync } from 'node:child_process';
import type { Env } from '../../rules/config.ts';
import type { ApprovalCommit, CodeOwners, LeadApproval, MergeApprovalRead } from '../../rules/pr.ts';
import { ownersOf, parseCodeOwners, parseLeadApproval, prTier, vendorFamily, writerVendors } from '../../rules/pr.ts';
import { asText, type Gh, isObject, labelNames } from './planning.ts';
import { CODEOWNERS_PLACES, readCodeOwners } from './pull-request.ts';

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
  /** The review body, where an area lead writes its approval (#699). */
  body: string;
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
      newest = { login, state, commit: review.commit, at: review.at, body: asText(review.body) };
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

/** An area lead's approval on a review, with the commit the review names (#699). */
type LeadReview = LeadApproval & { commit: string; at: string; login: string };

/**
 * The newest Approve that carries an area lead's line (#699), or null. Only a login
 * that wrote the line on an Approve can approve this way; its newest deciding review
 * then counts, so a later changes-requested or dismissed review refuses it. When more
 * than one lead approved, a lead of another vendor's line is preferred.
 */
function latestLeadApproval(text: string, writers: string[]): LeadReview | null {
  const eligible = new Set<string>();
  const byLogin = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let review: unknown;
    try {
      review = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(review)) continue;
    const login = asText(review.login);
    if (!login) continue;
    const key = login.toLowerCase();
    byLogin.set(key, [...(byLogin.get(key) ?? []), line]);
    if (asText(review.state) === 'APPROVED' && parseLeadApproval(asText(review.body))) eligible.add(key);
  }
  const candidates: LeadReview[] = [];
  for (const login of eligible) {
    const newest = latestOwnerDecision((byLogin.get(login) ?? []).join('\n'), new Set([login]));
    if (!newest || newest.state !== 'APPROVED') continue;
    const approval = parseLeadApproval(newest.body);
    if (approval) candidates.push({ ...approval, commit: newest.commit, at: newest.at, login: newest.login });
  }
  candidates.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const otherVendor = candidates.find((candidate) => {
    const family = vendorFamily({ vendor: candidate.vendor, model: candidate.model });
    return writers.length > 0 && !writers.includes(family);
  });
  return otherVendor ?? candidates[0] ?? null;
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

/** A test path in any of the layouts yokoten meets. */
const isTestPath = (path: string): boolean => /(^|\/)(test|tests|__tests__|spec|specs)\//i.test(path) || /[._-](test|spec)\.[^/]+$/i.test(path);

/**
 * Whether a change is looser than the rule it changes (#699). Until the diff tier check
 * (#697) lands, a change to a test that already exists counts as looser, because that is
 * where a refusal gets weaker. A new test is stricter, and passes. When git can't say
 * whether the file existed, the owner is asked: fail closed.
 */
function looserChange(root: string, env: Env, base: string, files: string[]): { looser: boolean; file: string | null } | { unsure: string } {
  const tests = files.filter(isTestPath);
  if (!tests.length) return { looser: false, file: null };
  if (!hasLocalCommit(root, base, env)) return { unsure: `the base commit ${base.slice(0, 7)} isn't in this checkout, so a looser change can't be ruled out` };
  for (const file of tests) {
    const existed = gitRead(root, ['--no-replace-objects', 'cat-file', '-e', `${base}:${file}`], env) !== null;
    if (existed) return { looser: true, file };
  }
  return { looser: false, file: null };
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

/** A commit id: 4 to 64 hex characters. A branch name is not one. */
const COMMIT_ID = /^[0-9a-f]{4,64}$/i;

/** Our cap on a contents read, not GitHub's. Over this, the read fails closed. */
const CODEOWNERS_TEXT_LIMIT = 64 * 1024;

/** True when this gh failure is HTTP 404: that place is not there. */
function isMissingContents(err: unknown): boolean {
  return /HTTP 404/.test(String((err as { stderr?: string }).stderr || (err as Error).message));
}

/** Whether `sha` names a commit in this checkout. */
function hasLocalCommit(root: string, sha: string, env: Env): boolean {
  if (!COMMIT_ID.test(sha)) return false;
  try {
    execFileSync('git', ['--no-replace-objects', 'cat-file', '-e', `${sha}^{commit}`], { cwd: root, env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * One CODEOWNERS place from the contents API. `missing` is only a real HTTP 404.
 * Any other failure, including a file over the cap, is `failed`. The text never
 * goes into a reason.
 */
function readContentsPlace(gh: Gh, repo: string, place: string, base: string): { text: string } | { missing: true } | { failed: true } {
  let body: unknown;
  try {
    body = JSON.parse(gh(['api', `repos/${repo}/contents/${place}?ref=${base}`]));
  } catch (err) {
    return isMissingContents(err) ? { missing: true } : { failed: true };
  }
  if (!isObject(body) || asText(body.type) !== 'file') return { failed: true };
  if (body.encoding !== undefined && body.encoding !== 'base64') return { failed: true };
  if (typeof body.content !== 'string') return { failed: true };
  const text = Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (Buffer.byteLength(text) > CODEOWNERS_TEXT_LIMIT) return { failed: true };
  return { text };
}

/**
 * CODEOWNERS at `base` from the contents API. The next place is read only after
 * a real 404. A failed read stops the search. `from` is the base branch.
 */
function readContentsOwners(gh: Gh, repo: string, base: string): { owners: CodeOwners | null } | { failed: true } {
  for (const place of CODEOWNERS_PLACES) {
    const read = readContentsPlace(gh, repo, place, base);
    if ('failed' in read) return { failed: true };
    if ('missing' in read) continue;
    return { owners: { text: read.text, from: 'the base branch' } };
  }
  return { owners: null };
}

/**
 * CODEOWNERS at the base commit, or why it could not be read. A missing commit
 * is fetched, then read again. When it is still missing, the contents API is
 * next. Only a 404 moves to the next place. The reason never holds the file text.
 */
function loadBaseOwners(gh: Gh, root: string, env: Env, number: number, repo: string, base: string): { owners: CodeOwners | null } | { unsure: string } {
  const unreadable = { unsure: `the CODEOWNERS file for pull request ${number} could not be read` };
  try {
    return { owners: readCodeOwners(root, base, env) };
  } catch {
    // A branch name, or a commit this clone already has, keeps today's failure.
    if (!COMMIT_ID.test(base) || hasLocalCommit(root, base, env)) return unreadable;
  }
  gitRead(root, ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', base], env);
  try {
    return { owners: readCodeOwners(root, base, env) };
  } catch {
    // The fetch brought the commit, but git still cannot read the file.
    if (hasLocalCommit(root, base, env)) return unreadable;
  }
  const remote = readContentsOwners(gh, repo, base);
  if ('failed' in remote) return unreadable;
  if (remote.owners) return { owners: remote.owners };
  if (!hasLocalCommit(root, base, env)) {
    return { unsure: `the base commit ${base.slice(0, 7)} isn't in this clone; run \`git fetch origin\`` };
  }
  return unreadable;
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
 * The login whose latest Approve names pull request `number`, or '' when gh can't read
 * its reviews or none is approved (#756). A newer Approve wins; a tie keeps the later row.
 */
export function readApproverLogin(gh: Gh, number: number): string {
  let rows = '';
  try {
    rows = gh(['pr', 'view', String(number), '--json', 'reviews', '--jq', '.reviews[] | select(.state == "APPROVED") | [.author.login, .submittedAt] | @tsv']);
  } catch {
    return '';
  }
  let approver = '';
  let newest = '';
  for (const row of rows.split('\n')) {
    const [login, at] = row.split('\t');
    if (!login || !at) continue;
    if (at >= newest) {
      newest = at;
      approver = login;
    }
  }
  return approver;
}

/**
 * What came after `approved` on a pull request, or why git can't tell (#612). An
 * approval on the head needs no git. Otherwise the commits are fetched, and only base
 * merges after the approval leave `after` at 0 with `sameDiff` true.
 */
function approvalFreshness(
  root: string,
  env: Env,
  number: number,
  head: string,
  base: string,
  headName: string,
  baseName: string,
  approved: string,
): ApprovalCommit | { unsure: string } {
  if (approved.toLowerCase() === head.toLowerCase()) return { commit: approved, after: 0, sameDiff: true };
  // The commits may live on GitHub only: fetch the pull request's head and the base
  // branch first, the way `gh pr edit <number>` names them. A fetch that fails is
  // ignored; the commit reads below fail closed.
  for (const ref of [`pull/${number}/head`, ...(headName ? [headName] : []), ...(baseName ? [baseName] : [])]) {
    gitRead(root, ['fetch', '--quiet', '--no-tags', 'origin', '--end-of-options', ref], env);
  }
  if (!hasLocalCommit(root, approved, env) || !hasLocalCommit(root, head, env) || !hasLocalCommit(root, base, env)) {
    return { unsure: `the commits of pull request ${number} are not all in this checkout` };
  }
  // The approval's commit may come from a rewritten history, so ancestor is checked, not
  // assumed. `--is-ancestor` prints nothing: only a throw says it is not one.
  const ancestor = gitRead(root, ['--no-replace-objects', 'merge-base', '--is-ancestor', approved, head], env) !== null;
  // `--not base`: a base commit the merge brought in is not the pull request's own.
  const count = gitRead(root, ['--no-replace-objects', 'rev-list', '--count', '--no-merges', `${approved}..${head}`, '--not', base, '--'], env);
  if (count === null || !/^\d+\s*$/.test(count)) return { unsure: `git could not list what came after the Approve on pull request ${number}` };
  const after = Number(count.trim());
  if (!ancestor) return { commit: approved, after: Math.max(after, 1), sameDiff: false };
  if (after > 0) return { commit: approved, after, sameDiff: false };
  // Only merges of the base branch came after the approval: the pull request's own diff
  // must still be the same. Each side is diffed from where it left the base, and the
  // stable names match when the changes match, even on moved lines.
  const oldBase = gitRead(root, ['--no-replace-objects', 'merge-base', base, approved], env)?.trim();
  const newBase = gitRead(root, ['--no-replace-objects', 'merge-base', base, head], env)?.trim();
  if (!oldBase || !newBase) return { unsure: `git could not find where pull request ${number} left the base branch` };
  const oldName = patchName(root, oldBase, approved, env);
  const newName = patchName(root, newBase, head, env);
  if (oldName === null || newName === null) return { unsure: `git could not compare pull request ${number} with its Approve` };
  return { commit: approved, after: 0, sameDiff: oldName === newName };
}

/**
 * What the merge check knows about pull request `number` in `repo` ("owner/name"):
 * its tier, its head, what came after the latest code-owner Approve, and an area lead's
 * approval (#699). A hard-line file or a looser change keeps the owner's approval. When
 * gh or git can't answer, it returns `unsure` with the reason; the caller refuses it.
 * Reads no token itself: `gh` runs with whatever sign-in the caller set up.
 */
export function readApprovalState(gh: Gh, root: string, env: Env, number: number, repo: string): MergeApprovalRead | { unsure: string } {
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
  const body = asText(pulled.body);
  const tier = prTier(body, labelNames(pulled.labels));
  if (tier === null) return { unsure: `neither the body nor a label says the tier of pull request ${number}` };
  if (tier !== 'A') return { tier, head, approved: null, after: 0, sameDiff: true };
  const files = changedFiles(gh, number, repo);
  if (files === null) return { unsure: `gh could not read the changed files of pull request ${number}` };
  let reviews = '';
  try {
    reviews = gh(['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate', '--jq', '.[] | {login: .user.login, assoc: .author_association, state: .state, commit: .commit_id, at: .submitted_at, body: .body}']);
  } catch {
    return { unsure: `gh could not read the reviews of pull request ${number}` };
  }
  const writers = writerVendors(body);
  const lead = latestLeadApproval(reviews, writers);
  const loaded = loadBaseOwners(gh, root, env, number, repo, base);
  if ('unsure' in loaded) return loaded;
  const owners = loaded.owners;
  // The CODEOWNERS paths are the hard lines: a change to one still needs the owner.
  const hardLine = owners ? files.filter((file) => ownersOf(parseCodeOwners(owners.text), file).length > 0) : [];
  let looser: { looser: boolean; file: string | null } = { looser: false, file: null };
  if (lead && !hardLine.length) {
    const found = looserChange(root, env, base, files);
    if ('unsure' in found) return found;
    looser = found;
  }
  const ownerOnly = Boolean(lead) && (hardLine.length > 0 || looser.looser);
  const shown = hardLine.slice(0, 5).join(', ') + (hardLine.length > 5 ? `, and ${hardLine.length - 5} more` : '');
  const ownerWhy = hardLine.length ? `a hard-line file (${shown})` : looser.looser ? `a looser change (${looser.file})` : null;
  // A lead approval can stand alone on a change with no hard-line file. Without one,
  // the code owner is still the only approval the check reads.
  if (!owners && !lead) return { unsure: `no CODEOWNERS file covers pull request ${number}, so no code owner can approve it` };
  let eligible = new Set<string>();
  if (owners) {
    const rules = parseCodeOwners(owners.text);
    let entries = [...new Set(files.flatMap((file) => ownersOf(rules, file)))];
    if (!entries.length) {
      // GitHub's code-owner rule enforces nothing file-specific on unowned files,
      // so requiring any repo owner is strictly stronger than GitHub there.
      entries = [...new Set(rules.flatMap((rule) => rule.owners))];
    }
    const { users, teams } = splitOwners(entries);
    for (const login of users) eligible.add(login);
    for (const team of teams) {
      const members = teamMembers(gh, team);
      if (members === null) return { unsure: `gh could not list the members of @${team} for pull request ${number}` };
      for (const login of members) eligible.add(login);
    }
    if (!eligible.size && (!lead || ownerOnly)) return { unsure: `no code owner owns the changed files of pull request ${number}` };
  }
  // No code owner Approve, or a newer changes-requested or dismissed review from a
  // code owner: the pull request may still be waiting for its review.
  const decision = eligible.size ? latestOwnerDecision(reviews, eligible) : null;
  const ownerState = decision?.state === 'APPROVED' ? approvalFreshness(root, env, number, head, base, asText(headRef.ref), asText(baseRef.ref), decision.commit) : null;
  if (ownerState && 'unsure' in ownerState) return ownerState;
  const baseState = {
    tier,
    head,
    approved: ownerState ? ownerState.commit : null,
    after: ownerState ? ownerState.after : 0,
    sameDiff: ownerState ? ownerState.sameDiff : true,
  };
  if (!lead) return ownerOnly ? { ...baseState, ownerOnly: true, ownerWhy } : baseState;
  if (ownerOnly) return { ...baseState, ownerOnly: true, ownerWhy };
  const leadState = approvalFreshness(root, env, number, head, base, asText(headRef.ref), asText(baseRef.ref), lead.commit);
  if ('unsure' in leadState) return leadState;
  return {
    ...baseState,
    lead: { lead: lead.lead, vendor: lead.vendor, model: lead.model, ...leadState },
    writers,
  };
}
