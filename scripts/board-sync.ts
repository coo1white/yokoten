// Keeps the org board's dates and Status up to date, so nobody fills them in by hand (#165).
// The `board` workflow runs it with the bot App's token; a person can run it with --dry-run.
//
//   node scripts/board-sync.ts --owner <org> --number <project number> [--dry-run]
//
// Owner and number can also come from BOARD_OWNER and BOARD_NUMBER. The token is read
// from GH_TOKEN or GITHUB_TOKEN, and is never printed.
//
// For each issue or pull request on the board:
// - an empty Start gets the day it was created;
// - an empty Target gets the day it closed, or its milestone's due day, never before Start;
// - Status: an open issue with none gets Todo, an open pull request gets In review, and a
//   closed issue or a merged or closed pull request gets Done. A Done item stays Done
//   unless it was reopened after it was set to Done.
// A field that has a value is kept. Running it twice changes nothing the second time.
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const FIELDS = { start: 'Start', target: 'Target', status: 'Status' } as const;
export const STATUS = { todo: 'Todo', review: 'In review', done: 'Done' } as const;

export type BoardOptions = {
  owner: string;
  number: number;
  token: string;
  api: string;
  isDryRun: boolean;
  log: (line: string) => void;
};

type Content = {
  __typename: 'Issue' | 'PullRequest';
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  closedAt: string | null;
  milestone: { dueOn: string | null } | null;
  repository: { nameWithOwner: string };
  timelineItems: { nodes: Array<{ createdAt?: string }> };
};

type Item = {
  id: string;
  start: { date?: string } | null;
  target: { date?: string } | null;
  status: { name?: string; updatedAt?: string } | null;
  content: Content | { __typename: string } | null;
};

export type Change = { item: string; label: string; field: string; value: string };

type Field = { id: string; name: string; options?: Array<{ id: string; name: string }> };

const CONTENT = `createdAt closedAt number repository { nameWithOwner } milestone { dueOn }
  timelineItems(itemTypes: [REOPENED_EVENT], last: 1) { nodes { ... on ReopenedEvent { createdAt } } }`;

const ITEMS_QUERY = `query($owner: String!, $number: Int!, $after: String, $start: String!, $target: String!, $status: String!) {
  organization(login: $owner) { projectV2(number: $number) {
    items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id
      start: fieldValueByName(name: $start) { ... on ProjectV2ItemFieldDateValue { date } }
      target: fieldValueByName(name: $target) { ... on ProjectV2ItemFieldDateValue { date } }
      status: fieldValueByName(name: $status) { ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt } }
      content { __typename
        ... on Issue { state ${CONTENT} }
        ... on PullRequest { state ${CONTENT} } } } } } } }`;

const FIELDS_QUERY = `query($owner: String!, $number: Int!) {
  organization(login: $owner) { projectV2(number: $number) { id
    fields(first: 50) { nodes {
      ... on ProjectV2FieldCommon { id name }
      ... on ProjectV2SingleSelectField { options { id name } } } } } } }`;

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

// What one item should get. Only empty or plainly wrong fields are named.
export function planItem(item: Item): Array<{ field: keyof typeof FIELDS; value: string }> {
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
  const isOpen = content.state === 'OPEN';
  const reopenedAt = content.timelineItems.nodes[0]?.createdAt;
  const isReopenedAfterDone = status === STATUS.done && isOpen && !!reopenedAt && (!item.status?.updatedAt || reopenedAt > item.status.updatedAt);
  let wanted: string | null = null;
  if (!isOpen) wanted = STATUS.done;
  else if (status === STATUS.done && !isReopenedAfterDone) wanted = null;
  else if (content.__typename === 'PullRequest') wanted = STATUS.review;
  else if (!status || isReopenedAfterDone) wanted = STATUS.todo;
  if (wanted && wanted !== status) plan.push({ field: 'status', value: wanted });
  return plan;
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

  const items: Item[] = [];
  let after: string | null = null;
  do {
    const page: any = (await callGraphql(options, ITEMS_QUERY, { ...base, after, ...FIELDS })).organization.projectV2.items;
    items.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const changes: Change[] = [];
  for (const item of items) {
    const content = item.content as Content;
    for (const { field, value } of planItem(item)) {
      const label = `${content.repository.nameWithOwner}#${content.number}`;
      changes.push({ item: item.id, label, field: FIELDS[field], value });
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
  const { values } = parseArgs({ options: { owner: { type: 'string' }, number: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const owner = values.owner ?? process.env.BOARD_OWNER;
  const number = Number(values.number ?? process.env.BOARD_NUMBER);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!owner || !Number.isInteger(number) || number < 1 || !token) {
    console.error('usage: node scripts/board-sync.ts --owner <org> --number <n> [--dry-run], with GH_TOKEN or GITHUB_TOKEN set');
    process.exit(2);
  }
  const api = process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql';
  syncBoard({ owner, number, token, api, isDryRun: !!values['dry-run'], log: (line) => console.log(line) }).catch((error: Error) => {
    console.error(`board-sync: ${error.message}`);
    process.exit(1);
  });
}
