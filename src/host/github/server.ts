// The server settings (#7): what the owner sets once per repo, read through `gh api`.
// Read only: nothing here changes a setting. A part gh can't read is an `Unread`, never
// a crash, so doctor says it could not check and goes on.
//
// It also reads an incident issue for `yokoten learn` (#77), through `gh issue view`.

import { type Incident, terminalText } from '../../run/learn.ts';
import { type Board, type Gh, type Planning, type Unread, readLinkedBoards, readPlanning, unread } from './planning.ts';

/** The rules that apply to the default branch, from every active ruleset. */
export interface BranchRules {
  pullRequest: boolean;
  /** Whether a merge needs code owner review; null when the host does not send the field. */
  codeOwnerReview: boolean | null;
  /** Merge methods the rules allow; empty when they do not limit them. */
  mergeMethods: string[];
  requiredChecks: string[];
  noForcePush: boolean;
  noDeletion: boolean;
  /** The approving reviews a merge needs: the most any ruleset, or the old branch protection, asks for; null when no ruleset asks and the old protection can't be read. */
  approvals: number | null;
}

/** Each security switch: on, off, or null when gh can't see it. */
export interface Security {
  secretScanning: boolean | null;
  pushProtection: boolean | null;
  privateReporting: boolean | null;
  dependabotAlerts: boolean | null;
}

export interface ServerSettings {
  repo: string;
  defaultBranch: string;
  /** Whether the repo is private, or null when GitHub did not say. */
  isPrivate: boolean | null;
  /** Whether a workflow may approve a pull request (an Actions setting), or null without admin rights. */
  actionsCanApprove: boolean | null;
  /** Why the approval switch can't be read here, in the host's words (#505); GitHub leaves it out. */
  actionsApprovalNote?: string;
  /** Merge methods the repo allows, or null without admin rights. */
  mergeMethods: string[] | null;
  deleteBranchOnMerge: boolean | null;
  branch: BranchRules | Unread;
  /** A ruleset on v* tags limits creation, update and deletion. */
  tags: boolean | Unread;
  /** Every v* tag ruleset that blocks creation: whether each names Repository admin, and whether one names a bot (an App). */
  tagBypass: { admin: boolean; bot: boolean } | Unread;
  /** The `release` environment: a required reviewer, a tag rule on v*, and whether a branch rule on v* is there instead. */
  release: { reviewer: boolean; tagRule: boolean; branchRule: boolean } | Unread;
  security: Security;
  /** Branches with no open pull request, apart from the default branch. */
  forgotten: string[] | Unread;
  /** The labels and milestones (#10), for the road's stage 2. Left out by a reader that does not need them. */
  planning?: Planning | Unread;
  /** The boards linked to the repo (#156), so doctor can list what to set by hand. */
  boards?: Board[] | Unread;
  /** The organization that owns the repo, from the same repo read; null for a user. Left out when unknown (#313). */
  org?: string | null;
}

type Rule = { type?: string; parameters?: Record<string, unknown> };
type Ruleset = { id?: number; target?: string; enforcement?: string; conditions?: { ref_name?: { include?: string[] } }; rules?: Rule[]; bypass_actors?: { actor_id?: number; actor_type?: string }[] };

/** The id GitHub gives the built-in "Repository admin" role in a ruleset's bypass list (#537). */
const REPOSITORY_ADMIN_ROLE_ID = 5;

/** The server settings of `repo` ("owner/name"), or why gh can't read the repo at all. */
export function readServer(gh: Gh, repo: string): ServerSettings | Unread {
  const api = <T>(path: string): T => JSON.parse(gh(['api', path]) || 'null') as T;
  const lines = (path: string, jq: string) => gh(['api', '--paginate', path, '--jq', jq]).split('\n').filter(Boolean);
  const attempt = <T>(read: () => T): T | Unread => {
    try {
      return read();
    } catch (err) {
      return unread(err);
    }
  };
  type Repo = {
    default_branch?: string;
    private?: boolean;
    permissions?: { admin?: boolean };
    allow_squash_merge?: boolean;
    allow_merge_commit?: boolean;
    allow_rebase_merge?: boolean;
    delete_branch_on_merge?: boolean;
    security_and_analysis?: Record<string, { status?: string } | undefined>;
    owner?: { login?: string; type?: string };
  };
  const info = attempt(() => api<Repo>(`repos/${repo}`));
  if ('unread' in info) return info;
  const defaultBranch = info.default_branch ?? 'main';
  // GitHub sends the merge settings only to an admin.
  const methods: [string, boolean | undefined][] = [['squash', info.allow_squash_merge], ['merge', info.allow_merge_commit], ['rebase', info.allow_rebase_merge]];
  const admin = info.permissions?.admin === true;
  const mergeMethods = methods.some(([, on]) => on === undefined) ? null : methods.filter(([, on]) => on).map(([name]) => name);

  const branch = attempt((): BranchRules => {
    const rules = api<Rule[]>(`repos/${repo}/rules/branches/${encodeURIComponent(defaultBranch)}`) ?? [];
    const of = (type: string) => rules.filter((r) => r.type === type);
    const pr = of('pull_request').map((r) => r.parameters ?? {});
    // The old branch protection, which only an admin can read: a 404 to an admin means none, any other failure is unknown.
    const oldApprovals = (): number | null => { try { return api<{ required_approving_review_count?: number }>(`repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection/required_pull_request_reviews`)?.required_approving_review_count ?? 0; } catch (err) { return admin && /HTTP 404/.test(String((err as { stderr?: string }).stderr || (err as Error).message)) ? 0 : null; } };
    const ruled = Math.max(0, ...pr.map((p) => Number(p.required_approving_review_count) || 0));
    const old = oldApprovals();
    return {
      pullRequest: pr.length > 0,
      codeOwnerReview: pr.some((p) => p.require_code_owner_review === true),
      mergeMethods: [...new Set(pr.flatMap((p) => (Array.isArray(p.allowed_merge_methods) ? (p.allowed_merge_methods as string[]) : [])))],
      requiredChecks: of('required_status_checks').flatMap((r) => ((r.parameters?.required_status_checks ?? []) as { context?: string }[]).map((c) => c.context ?? '')).filter(Boolean),
      noForcePush: of('non_fast_forward').length > 0,
      noDeletion: of('deletion').length > 0,
      approvals: old === null ? (ruled >= 1 ? ruled : null) : Math.max(ruled, old),
    };
  });

  const targetsV = (s: Ruleset) => (s.conditions?.ref_name?.include ?? []).some((p) => ['~ALL', 'refs/tags/v*', 'v*'].includes(p));
  const tagRules = attempt(() => {
    const sets = api<Ruleset[]>(`repos/${repo}/rulesets?targets=tag&includes_parents=true&per_page=100`) ?? [];
    return sets
      .filter((s) => s.target === 'tag' && s.enforcement === 'active' && s.id !== undefined)
      .map((s) => api<Ruleset>(`repos/${repo}/rulesets/${s.id}`));
  });
  const tags = 'unread' in tagRules ? tagRules : tagRules.some((s) => {
    const types = new Set((s.rules ?? []).map((r) => r.type));
    return targetsV(s) && ['creation', 'update', 'deletion'].every((t) => types.has(t));
  });
  // The owner pushes a release tag through the bypass list; a bot on it can push one too.
  // A bypass only helps on the ruleset that blocks the push: a bypass on another v* ruleset,
  // with no creation rule, leaves the owner unable to push a tag (#537). Two v* rulesets can
  // both block creation, and a push meets both, so one bypass is not enough: every such
  // ruleset must name it (#850).
  const blocksCreation = (s: Ruleset) => (s.rules ?? []).some((r) => r.type === 'creation');
  const creationRulesets = 'unread' in tagRules ? [] : tagRules.filter((s) => targetsV(s) && blocksCreation(s));
  const namesAdmin = (s: Ruleset) => (s.bypass_actors ?? []).some((a) => a.actor_type === 'RepositoryRole' && a.actor_id === REPOSITORY_ADMIN_ROLE_ID);
  const namesBot = (s: Ruleset) => (s.bypass_actors ?? []).some((a) => a.actor_type === 'Integration');
  const tagBypass = 'unread' in tagRules ? tagRules : {
    // With no v* ruleset blocking creation, the tag is free to push and needs no bypass.
    admin: creationRulesets.every(namesAdmin),
    bot: creationRulesets.some(namesBot),
  };

  // The `release` environment. A missing environment answers 404: it then has neither piece.
  type Environment = { protection_rules?: { type?: string; reviewers?: unknown[] }[] };
  type DeploymentPolicy = { name?: string; type?: string };
  const isNotFound = (err: unknown) => /HTTP 404/.test(String((err as { stderr?: string }).stderr || (err as Error).message));
  const release = attempt(() => {
    let environment: Environment;
    try {
      environment = api<Environment>(`repos/${repo}/environments/release`);
    } catch (err) {
      if (isNotFound(err)) return { reviewer: false, tagRule: false, branchRule: false };
      throw err;
    }
    const reviewer = (environment.protection_rules ?? []).some((r) => r.type === 'required_reviewers' && (r.reviewers?.length ?? 0) > 0);
    let policies: DeploymentPolicy[] = [];
    try {
      policies = api<{ branch_policies?: DeploymentPolicy[] }>(`repos/${repo}/environments/release/deployment-branch-policies`)?.branch_policies ?? [];
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return {
      reviewer,
      tagRule: policies.some((p) => p.type === 'tag' && p.name === 'v*'),
      branchRule: policies.some((p) => p.type === 'branch' && p.name === 'v*'),
    };
  });

  // security_and_analysis is sent only to an admin; without it, a switch is unknown.
  const sa = info.security_and_analysis;
  const status = (key: string) => (sa?.[key]?.status ? sa[key]?.status === 'enabled' : null);
  const reporting = attempt(() => api<{ enabled?: boolean }>(`repos/${repo}/private-vulnerability-reporting`)?.enabled === true);
  // 204 when on, 404 when off; but 404 also means "not allowed to see", so only an admin learns "off".
  let alerts: boolean | null = null;
  try {
    gh(['api', `repos/${repo}/vulnerability-alerts`]);
    alerts = true;
  } catch (err) {
    if (sa && /HTTP 404/.test(String((err as { stderr?: string }).stderr || (err as Error).message))) alerts = false;
  }
  const security: Security = {
    secretScanning: status('secret_scanning'),
    pushProtection: status('secret_scanning_push_protection'),
    privateReporting: typeof reporting === 'boolean' ? reporting : null,
    dependabotAlerts: alerts,
  };

  const forgotten = attempt(() => {
    const open = new Set(lines(`repos/${repo}/pulls?state=open&per_page=100`, '.[].head.label'));
    const owner = repo.split('/')[0];
    return lines(`repos/${repo}/branches?per_page=100`, '.[].name').filter((b) => b !== defaultBranch && !open.has(`${owner}:${b}`));
  });

  // With this Actions setting on, a workflow the bot pushes could approve the bot's own pull request.
  const actions = attempt(() => api<{ can_approve_pull_request_reviews?: boolean }>(`repos/${repo}/actions/permissions/workflow`)?.can_approve_pull_request_reviews);
  const actionsCanApprove = typeof actions === 'boolean' ? actions : null;

  const planning = readPlanning(gh, repo);
  const boards = readLinkedBoards(gh, repo);

  const org = info.owner?.type === 'Organization' ? (info.owner.login ?? repo.split('/')[0]) : info.owner?.type === 'User' ? null : undefined;

  return { repo, defaultBranch, isPrivate: info.private ?? null, actionsCanApprove, mergeMethods, deleteBranchOnMerge: info.delete_branch_on_merge ?? null, branch, tags, tagBypass, release, security, forgotten, planning, boards, ...(org === undefined ? {} : { org }) };
}

// An incident issue for `yokoten learn` (#77), read through `gh issue view`, so it uses
// the owner's own sign-in and holds no token. A number names an issue of this repo; a URL
// names one in any repo. Read only.

const ISSUE_REFERENCE = /^(\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)$/;

/** The issue's number, title, body, URL and labels, or the reason gh can't read it. */
export function readIncident(gh: Gh, reference: string): Incident | string {
  if (!ISSUE_REFERENCE.test(reference)) return `${reference} is not an issue: give its number, or a URL like https://github.com/owner/repo/issues/12`;
  let text: string;
  try {
    text = gh(['issue', 'view', reference, '--json', 'number,title,body,url,labels']);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gh is not installed: get it from https://cli.github.com, then run `gh auth login`';
    const reason = terminalText(String((err as { stderr?: string }).stderr || '').split('\n')[0].trim());
    return `gh can't read issue ${reference}${reason ? ` (${reason})` : ''}: run \`gh auth login\`, and check the number and the repo`;
  }
  const issue = JSON.parse(text) as { number?: unknown; title?: unknown; body?: unknown; url?: unknown; labels?: unknown };
  // The number names the draft's folder (lessons/incident-<n>), so only a whole number will do.
  const { number } = issue;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return `gh gave no issue number for ${reference}: it must be a whole number above 0`;
  // gh's JSON is checked, not cast: a null or odd title, body, url or label must not crash the draft.
  const { title, body, url, labels } = issue;
  if (typeof title !== 'string') return `gh gave no title for ${reference}`;
  return {
    number,
    title,
    body: typeof body === 'string' ? body : '',
    url: typeof url === 'string' ? url : '',
    labels: (Array.isArray(labels) ? labels : [])
      .map((label: unknown) => (label as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === 'string' && name !== ''),
  };
}
