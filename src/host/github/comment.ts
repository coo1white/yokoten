// One comment per pull request (#615). The `pr` workflow's comment job posts the
// findings of `check --pr`, edits that same comment on every run, and deletes it when
// the check passes. A local run never gets here: only GitHub Actions with --comment
// calls this module.
//
// The comment is found by a hidden marker, so an edit follows the same comment however
// many runs there are. Its text is the same summary the job page shows; a finding never
// carries a private value or text from the pull request (core rule 11).
//
// The token is sent only over https (or to this machine, for tests). No message names
// the token or the API's address.

import type { Env } from '../../rules/config.ts';
import type { Finding } from '../../rules/message.ts';
import { asText, isObject } from './planning.ts';
import { isUnreadable, readEvent, stepSummary } from './pull-request.ts';

/** The hidden line that marks yokoten's comment. */
export const CHECK_COMMENT_MARKER = '<!-- yokoten check --pr -->';

/** What the comment job did, and why when it failed. Never holds a token. */
export interface CommentOutcome {
  action: 'created' | 'updated' | 'deleted' | 'none' | 'failed';
  problem?: string;
}

/** How long one API call waits. */
const API_TIMEOUT_MS = 15000;

/** The comment's body for one check: the marker, the summary, and how it behaves. */
export function checkComment(name: string, problems: Finding[], notes: Finding[]): string {
  const summary = stepSummary(name, problems, notes).trimEnd();
  return `${CHECK_COMMENT_MARKER}\n${summary}\n\nThis comment is edited on each run. It is removed when the check passes.\n`;
}

/** The API's address can carry a token: https, or plain http to this machine only. */
function isSafeApi(api: string): boolean {
  try {
    const url = new URL(api);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

interface Place {
  api: string;
  token: string;
  repo: string;
  number: number;
}

const PLACE_FIX = 'run it in a pull_request job with `GITHUB_TOKEN: ${{ github.token }}` and `pull-requests: write`';

/** The repo, number, token and API of this run, or why they can't be read. */
function placeOf(env: Env): Place | string {
  const token = env.GITHUB_TOKEN;
  if (!token) return `GITHUB_TOKEN is not set, so the comment can't be posted; ${PLACE_FIX}`;
  const event = readEvent(env);
  if (event === null) return `there is no CI event file (GITHUB_EVENT_PATH), so the pull request is not named; ${PLACE_FIX}`;
  if (isUnreadable(event)) return `the CI event file (GITHUB_EVENT_PATH) can't be read, so the pull request is not named; ${PLACE_FIX}`;
  const pr = isObject(event.pull_request) ? event.pull_request : {};
  const number = pr.number;
  const repo = isObject(event.repository) ? asText(event.repository.full_name) : asText(env.GITHUB_REPOSITORY);
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return `the CI event names no pull request number; ${PLACE_FIX}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return `the CI event names no repository; ${PLACE_FIX}`;
  const api = (env.YOKOTEN_GITHUB_API || env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  if (!isSafeApi(api)) return 'the GitHub API address is not https, so the token is not sent; set GITHUB_API_URL or YOKOTEN_GITHUB_API to an https address';
  return { api, token, repo, number };
}

/** One API call with the token in the header. The answer is JSON, or null for an empty one. */
async function call(place: Place, method: string, route: string, body?: unknown): Promise<{ status: number; answer: unknown }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${place.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'yokoten',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${place.api}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  let answer: unknown = null;
  if (res.status !== 204) {
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
  }
  return { status: res.status, answer };
}

/** The pull request's first comment that carries yokoten's marker, or null. */
function markerComment(comments: unknown): { id: number; body: string } | null {
  if (!Array.isArray(comments)) return null;
  for (const comment of comments) {
    if (!isObject(comment) || typeof comment.id !== 'number') continue;
    const body = asText(comment.body);
    if (body.startsWith(CHECK_COMMENT_MARKER)) return { id: comment.id, body };
  }
  return null;
}

/**
 * Keep one comment on the pull request: create it, edit it, or delete it when `body` is
 * null. A failed call returns `failed` and never throws, so a comment problem never
 * changes the check's result.
 */
export async function upsertPullRequestComment(env: Env, body: string | null): Promise<CommentOutcome> {
  const place = placeOf(env);
  if (typeof place === 'string') return { action: 'failed', problem: place };
  try {
    const list = await call(place, 'GET', `/repos/${place.repo}/issues/${place.number}/comments?per_page=100`);
    if (list.status !== 200) return { action: 'failed', problem: `GitHub answered ${list.status} when the comments were read` };
    const found = markerComment(list.answer);
    if (body === null) {
      if (!found) return { action: 'none' };
      const removed = await call(place, 'DELETE', `/repos/${place.repo}/issues/comments/${found.id}`);
      if (removed.status !== 204 && removed.status !== 200) return { action: 'failed', problem: `GitHub answered ${removed.status} when the comment was removed` };
      return { action: 'deleted' };
    }
    if (found) {
      const edited = await call(place, 'PATCH', `/repos/${place.repo}/issues/comments/${found.id}`, { body });
      if (edited.status !== 200) return { action: 'failed', problem: `GitHub answered ${edited.status} when the comment was edited` };
      return { action: 'updated' };
    }
    const made = await call(place, 'POST', `/repos/${place.repo}/issues/${place.number}/comments`, { body });
    if (made.status !== 201) return { action: 'failed', problem: `GitHub answered ${made.status} when the comment was made` };
    return { action: 'created' };
  } catch {
    return { action: 'failed', problem: 'GitHub gave no answer when the comment was posted' };
  }
}
