// The Gitea adapter (#505). Gitea's API is close to GitHub's, so the road's ideas map
// onto it: a protected branch, labels, milestones. Gitea has no Apps: the bot is a bot
// user, and its token is in GITEA_TOKEN (or YOKOTEN_GITEA_TOKEN). A token is never
// printed, and it is sent only over https.
//
// Read only, and only in full doctor. The shape returned is yokoten's neutral server
// read, the one the road judges; it lives with the GitHub adapter until a third host
// needs it somewhere else.
//
// Gitea differs from GitHub in what it has no API for: its core has no secret scanning,
// no Dependabot and no Actions approval switch, so those read as unknown ("can't
// check"), never as off. Tag protection covers future `v*` tags; code owner review is
// read from the fields a newer Gitea sends, and is missing when it sends none.

import type { Env } from '../rules/config.ts';
import type { Unread } from './github/index.ts';
import type { BranchRules, Security, ServerSettings } from './github/server.ts';
import type { Planning } from './github/planning.ts';

/** One answer from the Gitea API. `status` is HTTP; `body` is JSON, or null. */
export interface GiteaAnswer {
  status: number;
  body: unknown;
}

/** One API read, by path from the API root (`/repos/owner/name`). Injected, so a test needs no network. */
export type GiteaGet = (path: string) => Promise<GiteaAnswer>;

/** How long one API read waits for Gitea: the same cap full doctor puts on the GitHub read. */
const API_TIMEOUT_MS = 3000;

/** The most pages one list read follows; Gitea caps a page at 50 rows. */
const MAX_PAGES = 20;

/** The token the adapter uses, from either name Gitea projects use. */
export const giteaTokenOf = (env: Env): string => (env.GITEA_TOKEN || env.YOKOTEN_GITEA_TOKEN || '').trim();

/** The host and base path of an https API address, or null when the address is not https. */
function httpsBaseOf(api: string): { host: string; path: string } | null {
  try {
    const url = new URL(api);
    if (url.protocol !== 'https:') return null;
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    return { host: url.host, path };
  } catch {
    return null;
  }
}

/** A read through `fetch`, with the token in the header and never in a message. */
export function giteaGet(api: string, token: string, fetchImpl: typeof fetch = fetch): GiteaGet {
  const base = httpsBaseOf(api);
  return async (path) => {
    // The guard sits beside the fetch, not only in the caller: a token never goes over
    // http (#849).
    if (base === null) throw new Error('the Gitea address is not https, so the token is not sent');
    // The scheme is a literal here, so every address this adapter builds is https: no
    // read can send the token in the clear, whatever scheme the address was given in.
    const address = `https://${base.host}${base.path}${path}`;
    // The host comes from the address, and a path may not move the read off it: a path
    // such as `@another.example` cannot turn the host into another server (#849).
    if (new URL(address).host !== base.host) {
      throw new Error('the Gitea path leaves the server, so the read is refused');
    }
    const res = await fetchImpl(address, {
      headers: { authorization: `token ${token}`, accept: 'application/json', 'user-agent': 'yokoten' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    let body: unknown = null;
    if (res.status !== 204) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    return { status: res.status, body };
  };
}

/** Why Gitea could not answer, in words a beginner can act on. */
function noAnswer(): Unread {
  return { unread: 'Gitea gave no answer', fix: 'check the network and the address of the server, then run doctor again' };
}

/** Why Gitea refused, by status. A 404 and a 401 hide the same thing: no access. */
function refused(status: number): Unread {
  if (status === 401 || status === 403) return { unread: 'Gitea refused the token', fix: 'make a token for the bot user with repo read access, put it in GITEA_TOKEN, then run doctor again' };
  if (status === 404) return { unread: 'Gitea did not find the repo, or the token cannot see it', fix: 'check the origin address, and that the token belongs to a user with read access to the repo' };
  return { unread: `Gitea answered ${status}`, fix: 'run doctor again; if it keeps failing, check the server' };
}

/** The answer when it worked, or why not. */
type Read = { body: unknown } | Unread;

const isUnread = (value: unknown): value is Unread => typeof value === 'object' && value !== null && 'unread' in value;

async function ask(get: GiteaGet, path: string, whenMissing?: Unread): Promise<Read> {
  let answer: GiteaAnswer;
  try {
    answer = await get(path);
  } catch {
    return noAnswer();
  }
  if (answer.status < 200 || answer.status >= 300) {
    // A read that failed with 404 after the repo read worked means the endpoint is not
    // there, not that the repo is missing. The caller says which (#849).
    if (answer.status === 404 && whenMissing) return whenMissing;
    return refused(answer.status);
  }
  return { body: answer.body };
}

/** Every row of a list read, page by page. Gitea caps a page at 50 rows. */
async function getAll(get: GiteaGet, path: string, whenMissing?: Unread): Promise<unknown[] | Unread> {
  const rows: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const read = await ask(get, `${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=50`, whenMissing);
    if (isUnread(read)) return read;
    if (!Array.isArray(read.body)) return { unread: 'Gitea sent a list that is not a list', fix: 'run doctor again; if it keeps failing, check the server version' };
    rows.push(...read.body);
    if (read.body.length < 50) break;
  }
  return rows;
}

const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** A branch protection rule, as Gitea sends it. */
interface Protection {
  branch_name?: unknown;
  enable_status_check?: unknown;
  status_check_contexts?: unknown;
  required_approvals?: unknown;
  require_code_owner_approval?: unknown;
  enable_code_owner_review?: unknown;
}

/**
 * True when `text` matches `pattern`, where `*` matches any run of characters.
 *
 * It walks both strings and never builds a RegExp. The pattern comes from a server,
 * and a regex built from it can backtrack for a long time on a hostile pattern
 * (CodeQL js/polynomial-redos).
 */
function matchesPattern(pattern: string, text: string): boolean {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;
  while (textIndex < text.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      patternIndex++;
      textIndex++;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      patternIndex++;
      starTextIndex = textIndex;
    } else if (starIndex !== -1) {
      // The last `*` takes one more character, and matching carries on after it.
      patternIndex = starIndex + 1;
      textIndex = ++starTextIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

/** True when a Gitea branch pattern (`main`, `release/*`) names `branch`. */
function matchesBranch(pattern: string, branch: string): boolean {
  return matchesPattern(pattern, branch);
}

/**
 * True when a tag pattern covers the next release tags too, not only one tag that exists
 * now. The samples include a patch release: `v*.0.0` matches `v1.0.0` and `v2.0.0` but
 * leaves `v1.2.3` open, so it is not a release policy (#849).
 */
function coversReleaseTags(pattern: string): boolean {
  return pattern !== '' && ['v1.0.0', 'v1.2.3', 'v2.0.0'].every((tag) => matchesPattern(pattern, tag));
}

/** The default branch's rules, from the protection Gitea keeps, or none. */
function branchRules(protections: unknown[], defaultBranch: string): BranchRules {
  const found = protections
    .map(asObject)
    .map((rule) => rule as Protection)
    .find((rule) => matchesBranch(asText(rule.branch_name), defaultBranch));
  if (!found) {
    return { pullRequest: false, codeOwnerReview: false, mergeMethods: [], requiredChecks: [], noForcePush: false, noDeletion: false, approvals: 0 };
  }
  const checks = Array.isArray(found.status_check_contexts) ? found.status_check_contexts.map(asText).filter(Boolean) : [];
  // A Gitea version that does not send either code-owner field cannot be judged: that is
  // unknown, never off. Either field being on means code owner review is on (#849).
  const codeOwnerValues = [asBoolean(found.require_code_owner_approval), asBoolean(found.enable_code_owner_review)];
  const codeOwnerReview = codeOwnerValues.includes(true) ? true : codeOwnerValues.includes(false) ? false : null;
  return {
    pullRequest: true,
    codeOwnerReview,
    // Gitea sets merge methods on the repo, not on the protection; the repo read judges them.
    mergeMethods: [],
    requiredChecks: found.enable_status_check === true ? checks : [],
    // A protected branch refuses a force push and a deletion in Gitea.
    noForcePush: true,
    noDeletion: true,
    approvals: typeof found.required_approvals === 'number' && found.required_approvals > 0 ? found.required_approvals : 0,
  };
}

/** What a success read holds as a list; an empty list for an odd body. */
const rowsOf = (body: unknown): unknown[] => (Array.isArray(body) ? body : []);

/**
 * The server settings of a Gitea repo, or why they can't be read. `host` is what
 * `hostOf` worked out; `get` is for a test, and without it the adapter reads `env`.
 */
export async function readGiteaServer(host: { repo: string; api: string }, env: Env, get?: GiteaGet): Promise<ServerSettings | Unread> {
  const token = giteaTokenOf(env);
  if (!token) return { unread: 'GITEA_TOKEN is not set, so yokoten can\'t read the server', fix: 'make a token for the bot user with repo read access, put it in GITEA_TOKEN, then run doctor again' };
  if (httpsBaseOf(host.api) === null) return { unread: 'the Gitea address is not https, so the token is not sent', fix: 'give the repo an https origin address, or run doctor on the server itself' };
  const api = get ?? giteaGet(host.api, token);
  const base = `/repos/${host.repo}`;

  const infoRead = await ask(api, base);
  if (isUnread(infoRead)) return infoRead;
  const info = asObject(infoRead.body);
  if (!Object.keys(info).length) return { unread: 'Gitea sent no repo for the origin address', fix: 'check the origin address, then run doctor again' };
  const defaultBranch = asText(info.default_branch) || 'main';

  // An older Gitea has no tag protection endpoint. That is unknown, never "off". The
  // repo read worked, so a 404 here is the endpoint, not the repo (#849).
  const noTagApi: Unread = { unread: 'this Gitea has no tag protection API', fix: 'protect the v* tags by hand in the repo settings, or update Gitea, then run doctor again' };
  // A 404 here, after the repo read worked, is the endpoint or the token's rights, not a
  // missing repo (#849). Gitea asks for an admin token to read branch protections.
  const noProtectionApi: Unread = {
    unread: 'this Gitea has no branch protection API that yokoten can read, or the token is not an admin',
    fix: 'use a token for a repo admin, or protect the default branch by hand, then run doctor again',
  };
  const noListApi = (name: string, fix: string): Unread => ({ unread: `this Gitea has no ${name} API that yokoten can read`, fix });

  // The independent reads run together: doctor waits for the slowest, not the sum.
  const [protectionRead, tagRead, labelRead, milestoneRead, branchRead, pullRead] = await Promise.all([
    ask(api, `${base}/branch_protections`, noProtectionApi),
    getAll(api, `${base}/tag_protections`, noTagApi),
    getAll(api, `${base}/labels`, noListApi('label', 'add the labels by hand in the repo settings, then run doctor again')),
    getAll(api, `${base}/milestones?state=all`, noListApi('milestone', 'add the milestones by hand in the repo settings, then run doctor again')),
    getAll(api, `${base}/branches`, noListApi('branch list', 'list the forgotten branches by hand, then run doctor again')),
    getAll(api, `${base}/pulls?state=open`, noListApi('pull request list', 'list the open pull requests by hand, then run doctor again')),
  ]);

  const branch = isUnread(protectionRead) ? protectionRead : branchRules(rowsOf(protectionRead.body), defaultBranch);

  const tags: boolean | Unread = isUnread(tagRead)
    ? tagRead
    : tagRead.some((rule) => coversReleaseTags(asText(asObject(rule).name_pattern)));

  const planning: Planning | Unread =
    isUnread(labelRead) || isUnread(milestoneRead)
      ? (isUnread(labelRead) ? labelRead : milestoneRead as Unread)
      : {
          repo: host.repo,
          labels: labelRead.map(asObject).map((label) => ({ name: asText(label.name), color: asText(label.color), description: asText(label.description) })).filter((label) => label.name !== ''),
          milestones: milestoneRead.map(asObject).map((milestone) => ({ title: asText(milestone.title), open: asText(milestone.state) === 'open' })).filter((milestone) => milestone.title !== ''),
        };

  const forgotten: string[] | Unread = isUnread(branchRead) || isUnread(pullRead)
    ? (isUnread(branchRead) ? branchRead : pullRead as Unread)
    : (() => {
        const owner = host.repo.split('/')[0];
        const open = new Set(pullRead.map(asObject).map((pull) => {
          const head = asObject(pull.head);
          return asText(head.label) || `${owner}:${asText(head.ref)}`;
        }).filter(Boolean));
        return branchRead.map(asObject).map((row) => asText(row.name)).filter((name) => name && name !== defaultBranch && !open.has(`${owner}:${name}`));
      })();

  // Gitea's core has no secret scanning, Dependabot or private vulnerability reporting.
  // They are unknown, so the step says "can't check", never "off".
  const security: Security = { secretScanning: null, pushProtection: null, privateReporting: null, dependabotAlerts: null };

  // Gitea's tag protection has no bypass list for yokoten to read, and no `release`
  // environment with a required reviewer. Both stay unknown, never "off" (#850).
  const tagBypass: Unread = {
    unread: 'this Gitea has no tag bypass list that yokoten can read',
    fix: 'check by hand that your user, and no bot, may push a v* tag in the repo settings, then run doctor again',
  };
  const release: Unread = {
    unread: 'this Gitea has no release environment that yokoten can read',
    fix: 'approve each publish job by hand in the Gitea Actions log, then run doctor again',
  };

  // Gitea's own repository fields, not GitHub's (#849): the merge methods are
  // `allow_squash_merge`, `allow_merge_commits` and either rebase switch, and the
  // delete switch is `default_delete_branch_after_merge`.
  const rebaseValues = [asBoolean(info.allow_rebase), asBoolean(info.allow_rebase_explicit)];
  const rebase = rebaseValues.includes(true) ? true : rebaseValues.includes(false) ? false : null;
  const methods: [string, boolean | null][] = [
    ['squash', asBoolean(info.allow_squash_merge)],
    ['merge', asBoolean(info.allow_merge_commits)],
    ['rebase', rebase],
  ];
  const mergeMethods = methods.some(([, on]) => on === null) ? null : methods.filter(([, on]) => on).map(([name]) => name);

  return {
    repo: host.repo,
    defaultBranch,
    isPrivate: asBoolean(info.private),
    // Gitea has no Actions setting that lets a workflow approve a pull request.
    actionsCanApprove: null,
    actionsApprovalNote: 'Gitea has no Actions approval switch that yokoten can read, so check the approvals by hand',
    mergeMethods,
    deleteBranchOnMerge: asBoolean(info.default_delete_branch_after_merge),
    branch,
    tags,
    tagBypass,
    release,
    security,
    forgotten,
    planning,
    boards: [],
  };
}
