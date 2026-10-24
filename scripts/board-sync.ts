// Keeps the org board's items, dates and Status up to date, so nobody fills them in by hand (#165, #908).
// The `board` workflow runs it with the bot App's token; a person can run it with --dry-run.
//
//   node scripts/board-sync.ts --owner <org> --number <project number> --repo <owner/name> [--dry-run]
//
// Owner, number and repo can also come from BOARD_OWNER, BOARD_NUMBER and BOARD_REPO
// (GITHUB_REPOSITORY is read too), and GITHUB_GRAPHQL_URL changes the API. The token is
// read from GH_TOKEN or GITHUB_TOKEN, and is never printed.
//
// Every open issue and open pull request of the repository is added to the board when it
// is missing. A closed or merged item that is missing is left alone: no history flood.
//
// - Status follows the work: an open issue with a branch or a linked open pull request
//   gets In progress, an open issue without either gets Todo, an open pull request gets
//   In review, and a closed issue or a merged or closed pull request gets Done. A status
//   that no longer follows the work is corrected.
// - An empty Start gets the day it was created.
// - An empty Target gets the day it closed, or its milestone's due day, never before Start.
// A field that has a value is kept, except Status. Running it twice changes nothing the second time.
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const FIELDS = { start: 'Start', target: 'Target', status: 'Status' } as const;
export const STATUS = { todo: 'Todo', progress: 'In progress', review: 'In review', done: 'Done' } as const;

export type BoardOptions = {
  owner: string;
  number: number;
  repo: string;
  token: string;
  api: string;
  isDryRun: boolean;
  log: (line: string) => void;
};

type Content = {
  id: string;
  __typename: 'Issue' | 'PullRequest';
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  closedAt: string | null;
  milestone: { dueOn: string | null } | null;
  repository: { nameWithOwner: string };
  /** An issue's linked branches, from the Development section. */
  linkedBranches?: { nodes: Array<{ ref: { name: string } | null }> };
  /** An issue's open pull requests that say they close it. */
  closedByPullRequestsReferences?: { nodes: Array<{ number: number }> };
  /** A pull request's head branch. */
  headRefName?: string;
};

type Item = {
  id: string;
  start: { date?: string } | null;
  target: { date?: string } | null;
  status: { name?: string } | null;
  content: Content | { __typename: string } | null;
};

export type Change =
  | { kind: 'added'; item: string; label: string }
  | { kind: 'set'; item: string; label: string; field: string; value: string };

type Field = { id: string; name: string; options?: Array<{ id: string; name: string }> };

const CONTENT = `createdAt closedAt number repository { nameWithOwner } milestone { dueOn }`;

const ISSUE_CONTENT = `state ${CONTENT}
  linkedBranches(first: 10) { nodes { ref { name } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number } }`;

const PULL_CONTENT = `state ${CONTENT} headRefName`;

const ITEMS_QUERY = `query($owner: String!, $number: Int!, $after: String, $start: String!, $target: String!, $status: String!) {
  organization(login: $owner) { projectV2(number: $number) {
    items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id
      start: fieldValueByName(name: $start) { ... on ProjectV2ItemFieldDateValue { date } }
      target: fieldValueByName(name: $target) { ... on ProjectV2ItemFieldDateValue { date } }
      status: fieldValueByName(name: $status) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      content { id __typename
        ... on Issue { ${ISSUE_CONTENT} }
        ... on PullRequest { ${PULL_CONTENT} } } } } } } }`;

const OPEN_ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename ... on Issue { id ${ISSUE_CONTENT} } } } } }`;

const OPEN_PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename ... on PullRequest { id ${PULL_CONTENT} } } } } }`;

const FIELDS_QUERY = `query($owner: String!, $number: Int!) {
  organization(login: $owner) { projectV2(number: $number) { id
    fields(first: 50) { nodes {
      ... on ProjectV2FieldCommon { id name }
      ... on ProjectV2SingleSelectField { options { id name } } } } } } }`;

const ADD_ITEM = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`;

const SET_FIELD = `mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { projectV2Item { id } } }`;

async function callGraphql(options: BoardOptions, query: string, variables: Record<string, unknown>): Promise<any> {
  const response = await fetch(options.api, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json', 'user-agent': 'yokoten-board-sync' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GraphQL: HTTP ${response.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e: { message: string }) => e.message).join('; ')}`);
  return body.data;
}

const dayOf = (iso: string | null | undefined) => iso?.slice(0, 10) ?? null;

/** The issue number a work branch starts with, `<number>-<slug>`, or null. */
function issueNumberOnBranch(branch: string | undefined): number | null {
  const match = /^(\d+)-/.exec(branch ?? '');
  return match ? Number(match[1]) : null;
}

// What one item should get. Only empty fields and a status that no longer follows the
// work are named. `workingIssues` holds the issues an open pull request's branch names.
export function planItem(item: Item, workingIssues: ReadonlySet<number> = new Set()): Array<{ field: keyof typeof FIELDS; value: string }> {
  const content = item.content;
  if (!content || !('number' in content)) return [];
  const plan: Array<{ field: keyof typeof FIELDS; value: string }> = [];
  const created = dayOf(content.createdAt)!;
  const start = item.start?.date ?? created;
  if (!item.start?.date) plan.push({ field: 'start', value: created });
  if (!item.target?.date) {
    const end = content.state === 'OPEN' ? dayOf(content.milestone?.dueOn) : dayOf(content.closedAt);
    if (end) plan.push({ field: 'target', value: end < start ? start : end });
  }
  const status = item.status?.name;
  let wanted: string;
  if (content.state !== 'OPEN') {
    wanted = STATUS.done;
  } else if (content.__typename === 'PullRequest') {
    wanted = STATUS.review;
  } else {
    const hasBranch = (content.linkedBranches?.nodes.length ?? 0) > 0;
    const hasLinkedPull = (content.closedByPullRequestsReferences?.nodes.length ?? 0) > 0 || workingIssues.has(content.number);
    wanted = hasBranch || hasLinkedPull ? STATUS.progress : STATUS.todo;
  }
  if (wanted !== status) plan.push({ field: 'status', value: wanted });
  return plan;
}

async function readBoardItems(options: BoardOptions, base: Record<string, unknown>): Promise<Item[]> {
  const items: Item[] = [];
  let after: string | null = null;
  do {
    const page: any = (await callGraphql(options, ITEMS_QUERY, { ...base, after, ...FIELDS })).organization.projectV2.items;
    items.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return items;
}

async function readOpenContent(options: BoardOptions, query: string, key: 'issues' | 'pullRequests', owner: string, name: string): Promise<Content[]> {
  const nodes: Content[] = [];
  let after: string | null = null;
  do {
    const repository: any = (await callGraphql(options, query, { owner, name, after })).repository;
    const connection: any = repository?.[key];
    if (!connection) throw new Error(`cannot read the open ${key} of ${owner}/${name}`);
    for (const node of connection.nodes as Content[]) if (node?.id) nodes.push(node);
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

export async function syncBoard(options: BoardOptions): Promise<Change[]> {
  const base = { owner: options.owner, number: options.number };
  const project = (await callGraphql(options, FIELDS_QUERY, base)).organization?.projectV2;
  if (!project) throw new Error(`no project ${options.number} for ${options.owner}`);
  const fields = new Map<string, Field>();
  for (const node of project.fields.nodes as Field[]) if (node?.name) fields.set(node.name, node);
  for (const name of Object.values(FIELDS)) if (!fields.has(name)) throw new Error(`the board has no field named ${name}`);
  const statusOptions = new Map((fields.get(FIELDS.status)!.options ?? []).map((o) => [o.name, o.id]));
  for (const name of Object.values(STATUS)) if (!statusOptions.has(name)) throw new Error(`the ${FIELDS.status} field has no option ${name}`);

  const [repoOwner, repoName] = options.repo.split('/');
  if (!repoOwner || !repoName) throw new Error(`the repo is not owner/name: ${options.repo}`);

  const items = await readBoardItems(options, base);
  const openPulls = await readOpenContent(options, OPEN_PULLS_QUERY, 'pullRequests', repoOwner, repoName);
  const openIssues = await readOpenContent(options, OPEN_ISSUES_QUERY, 'issues', repoOwner, repoName);
  const workingIssues = new Set<number>();
  for (const pull of openPulls) {
    const number = issueNumberOnBranch(pull.headRefName);
    if (number) workingIssues.add(number);
  }

  const changes: Change[] = [];
  const onBoard = new Set<string>();
  for (const item of items) {
    const content = item.content;
    if (content && 'number' in content) onBoard.add(content.id);
  }
  for (const content of [...openIssues, ...openPulls]) {
    if (onBoard.has(content.id)) continue;
    const label = `${content.repository.nameWithOwner}#${content.number}`;
    changes.push({ kind: 'added', item: content.id, label });
    options.log(`${options.isDryRun ? 'would add' : 'added'} ${label}`);
    if (options.isDryRun) {
      items.push({ id: `new:${content.id}`, start: null, target: null, status: null, content });
      continue;
    }
    const added: any = await callGraphql(options, ADD_ITEM, { project: project.id, content: content.id });
    items.push({ id: added.addProjectV2ItemById.item.id, start: null, target: null, status: null, content });
  }

  for (const item of items) {
    const content = item.content as Content;
    for (const { field, value } of planItem(item, workingIssues)) {
      const label = `${content.repository.nameWithOwner}#${content.number}`;
      changes.push({ kind: 'set', item: item.id, label, field: FIELDS[field], value });
      options.log(`${options.isDryRun ? 'would set' : 'set'} ${label} ${FIELDS[field]}: ${value}`);
      if (options.isDryRun) continue;
      const fieldValue = field === 'status' ? { singleSelectOptionId: statusOptions.get(value) } : { date: value };
      await callGraphql(options, SET_FIELD, { project: project.id, item: item.id, field: fields.get(FIELDS[field])!.id, value: fieldValue });
    }
  }
  options.log(`${items.length} items, ${changes.length} change(s)${options.isDryRun ? ' (dry run: nothing written)' : ''}`);
  return changes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { owner: { type: 'string' }, number: { type: 'string' }, repo: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const owner = values.owner ?? process.env.BOARD_OWNER;
  const number = Number(values.number ?? process.env.BOARD_NUMBER);
  const repo = values.repo ?? process.env.BOARD_REPO ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!owner || !Number.isInteger(number) || number < 1 || !repo || !token) {
    console.error('usage: node scripts/board-sync.ts --owner <org> --number <n> --repo <owner/name> [--dry-run], with GH_TOKEN or GITHUB_TOKEN set');
    process.exit(2);
  }
  const api = process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql';
  syncBoard({ owner, number, repo, token, api, isDryRun: !!values['dry-run'], log: (line) => console.log(line) }).catch((error: Error) => {
    console.error(`board-sync: ${error.message}`);
    process.exit(1);
  });
}
