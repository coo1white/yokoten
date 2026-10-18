// Counts the pull requests that outside accounts opened in the last 7 days, and writes
// one short comment for issue #88 (#88). The weekly `outside-prs` workflow runs it with
// --post. Without --post it only reads and prints the comment: a safe dry run.
//
//   node scripts/outside-prs.ts           print the comment
//   node scripts/outside-prs.ts --post    post it on issue #88 (needs GH_TOKEN with issues: write)
//
// An outside account is one that is not an owner, member or collaborator. Bots are not
// counted: Dependabot and the repo's own App open pull requests too. The comment names
// pull requests by number only, never by the account that opened them.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WATCH_ISSUE = 88;
/** The decision in issue #88: 5 or more spam pull requests in one week turns the setting on. */
export const WEEKLY_THRESHOLD = 5;
const WINDOW_DAYS = 7;
const PAGE_SIZE = 100;
const OUTSIDE_ASSOCIATIONS = ['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'CONTRIBUTOR', 'NONE'];

/** The fields of a pull request this script reads, as the host's API returns them. */
export interface PullRequest {
  number: number;
  created_at: string;
  author_association: string;
  user: { login: string; type: string } | null;
}

export function isBot(pull: PullRequest): boolean {
  return pull.user === null || pull.user.type === 'Bot' || pull.user.login.endsWith('[bot]');
}

/** The numbers of the pull requests that outside people opened at or after `since`, lowest first. */
export function findOutsidePulls(pulls: PullRequest[], since: Date): number[] {
  return pulls
    .filter((pull) => Date.parse(pull.created_at) >= since.getTime())
    .filter((pull) => OUTSIDE_ASSOCIATIONS.includes(pull.author_association) && !isBot(pull))
    .map((pull) => pull.number)
    .sort((a, b) => a - b);
}

/** The comment for issue #88: the count, the threshold and the numbers. */
export function writeComment(numbers: number[], since: Date, until: Date): string {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const lines = [`Outside pull requests opened ${day(since)} to ${day(until)} (UTC): **${numbers.length}**. The threshold is ${WEEKLY_THRESHOLD} a week.`];
  if (numbers.length > 0) lines.push('', numbers.map((number) => `#${number}`).join(', '));
  if (numbers.length >= WEEKLY_THRESHOLD) lines.push('', `That is ${WEEKLY_THRESHOLD} or more. Check them for spam, by the rule in this issue.`);
  return `${lines.join('\n')}\n`;
}

// The API returns about 10 KB for each pull request. Keep only the fields read here.
const KEEP_FIELDS = 'map({number, created_at, author_association, user: (if .user then {login: .user.login, type: .user.type} else null end)})';

/** Newest first, page by page, until a page reaches back before `since`. */
function readRecentPulls(repo: string, since: Date): PullRequest[] {
  const pulls: PullRequest[] = [];
  for (let page = 1; ; page++) {
    const query = ['-f', 'state=all', '-f', 'sort=created', '-f', 'direction=desc', '-f', `per_page=${PAGE_SIZE}`, '-f', `page=${page}`];
    const output = execFileSync('gh', ['api', '-X', 'GET', `repos/${repo}/pulls`, ...query, '--jq', KEEP_FIELDS], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const batch: PullRequest[] = JSON.parse(output);
    pulls.push(...batch);
    const oldest = batch.at(-1);
    if (batch.length < PAGE_SIZE || !oldest || Date.parse(oldest.created_at) < since.getTime()) return pulls;
  }
}

function main(): void {
  const repo = process.env.GITHUB_REPOSITORY ?? 'yokoten-labs/yokoten';
  const until = new Date();
  const since = new Date(until.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const comment = writeComment(findOutsidePulls(readRecentPulls(repo, since), since), since, until);
  process.stdout.write(comment);
  if (!process.argv.includes('--post')) return;
  execFileSync('gh', ['issue', 'comment', String(WATCH_ISSUE), '--repo', repo, '--body-file', '-'], { input: comment, stdio: ['pipe', 'inherit', 'inherit'] });
}

// A test imports the functions above; only a run from the command line reads and posts.
// A failure prints one line: the full error would hold the API's answer, with account names.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`outside-prs: ${String((error as Error).message).split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}
