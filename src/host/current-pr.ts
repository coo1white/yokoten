// The pull request as it is now (#645), read from the GitHub API.
//
// GitHub can start the runs of one pull request in any order, and each event file keeps
// the title, body, labels and milestone of its own moment. A run for `opened` that starts
// last would judge a pull request with no labels, and a rerun reuses its old event file.
// So a workflow can ask `check --pr` to read these fields when the run starts: it sets
// YOKOTEN_PR_LIVE and gives the step the job's GITHUB_TOKEN. The event file still names
// the pull request, and its commits stay the ones the run is for. Every run then judges
// the same pull request, the one there is now, and a rerun judges it again.
//
// Without YOKOTEN_PR_LIVE nothing here runs: the GitHub Action and local runs keep the
// event file. With it, a read that fails fails the check; the old event file is never
// the answer. The token goes only into the request's header, and only over https (or to
// this machine, for tests). No message names the token or the API's address.

import type { Env } from '../rules/config.ts';
import { finding } from '../rules/message.ts';
import { asText, EVENT_FIX, isObject, isUnreadable, labelNames, milestoneTitle, readEvent, SHA_FIX, type Unreadable } from './github.ts';

/** The fields of a pull request that change without a new commit, as they are now. */
export interface CurrentPullRequest {
  title: string;
  body: string;
  labels: string[];
  milestone: string | null;
  author: string;
}

/** How long one API read waits for GitHub. */
const API_TIMEOUT_MS = 15000;

const CURRENT_FIX = 'give the step `GITHUB_TOKEN: ${{ github.token }}` and the job `pull-requests: read`, then run the job again';

/** The workflow asked `check --pr` to read the pull request as it is now. */
export const readsCurrentPullRequest = (env: Env): boolean => Boolean(env.YOKOTEN_PR_LIVE);

/** The API's address can carry a token: https, or plain http to this machine only. */
function isSafeApi(api: string): boolean {
  try {
    const url = new URL(api);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

/**
 * The pull request of this run as it is now, read from the API with GITHUB_TOKEN, or why
 * it can't be read. The event file names the repo and the number.
 */
export async function readCurrentPullRequest(env: Env): Promise<CurrentPullRequest | Unreadable> {
  const fail = (what: string, fix = CURRENT_FIX): Unreadable => ({ problem: finding('pr-current', what, fix) });
  const token = env.GITHUB_TOKEN;
  if (!token) return fail('GITHUB_TOKEN is not set, so the pull request as it is now can\'t be read');
  const event = readEvent(env);
  if (event === null) return fail('there is no CI event file (GITHUB_EVENT_PATH), so the pull request is not named', EVENT_FIX);
  if (isUnreadable(event)) return event;
  const pr = isObject(event.pull_request) ? event.pull_request : {};
  const number = pr.number;
  const repo = isObject(event.repository) ? asText(event.repository.full_name) : asText(env.GITHUB_REPOSITORY);
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return fail('the CI event names no pull request number', SHA_FIX);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail('the CI event names no repository', SHA_FIX);
  const api = (env.YOKOTEN_GITHUB_API || env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  if (!isSafeApi(api)) return fail('the GitHub API address is not https, so the token is not sent', 'set GITHUB_API_URL or YOKOTEN_GITHUB_API to an https address, or leave both unset');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'yokoten' };
  let answer = '';
  // One more try when GitHub gives no answer or a server error: those often pass on their own.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${api}/repos/${repo}/pulls/${number}`, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      if (res.ok) {
        const body: unknown = await res.json();
        if (!isObject(body)) return fail(`GitHub gave no pull request ${number}`);
        return {
          title: asText(body.title),
          body: asText(body.body),
          labels: labelNames(body.labels),
          milestone: milestoneTitle(body.milestone),
          author: isObject(body.user) ? asText(body.user.login) : '',
        };
      }
      await res.body?.cancel();
      answer = `GitHub answered ${res.status}`;
      if (res.status < 500) break;
    } catch {
      answer = 'GitHub gave no answer';
    }
  }
  return fail(`pull request ${number} can't be read as it is now: ${answer}`);
}
