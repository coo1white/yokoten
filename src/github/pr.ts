// A pull request as GitHub Actions describes it: the event file of the run. The rule that
// judges it (src/rules/pr.ts) knows no host; this file is the GitHub half.
//
// The event file holds the title, body, labels and milestone. The changed files come from
// git, between the base and the head commit of the pull request, so the checkout needs
// both (fetch-depth: 0).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Env } from '../rules/config.ts';
import type { PullRequest } from '../rules/pr.ts';

interface Event {
  pull_request?: {
    title?: string;
    body?: string | null;
    labels?: { name?: string }[];
    milestone?: { title?: string } | null;
    base?: { sha?: string };
    head?: { sha?: string };
  };
}

/** The pull request of this run, or null when the run is not for one. */
export function readPullRequest(root: string, env: Env): (PullRequest & { head: string; numstat: string }) | null {
  if (!env.GITHUB_EVENT_PATH) return null;
  const event: Event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) return null;
  const base = pr.base?.sha ?? '';
  const head = pr.head?.sha ?? '';
  const files = base && head ? execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean) : [];
  const numstat = base && head ? execFileSync('git', ['diff', '--numstat', '-z', `${base}...${head}`], { cwd: root, encoding: 'utf8' }) : '';
  return {
    title: pr.title ?? '',
    body: pr.body ?? '',
    files,
    labels: (pr.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    milestone: pr.milestone?.title ?? null,
    head,
    numstat,
  };
}
