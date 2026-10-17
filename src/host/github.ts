// The GitHub adapter. Everything yokoten knows about GitHub's API lives in src/host/
// (record 0004); a rule or a step names what it needs in host-neutral words. Two parts:
// the bot, and the pull request of a CI run.
//
// The bot: a GitHub App that pushes branches and opens pull requests for the lead, so
// the owner's account is never used for that. It signs in with one-hour tokens made from
// its private key.
//
// The token is handed to one command's environment and never printed: a printed token
// lands in the agent's transcript.

import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import type { PullRequest } from '../rules/pr.ts';

export interface BotConfig {
  appId: string;
  /** Path to the App's private key (.pem). */
  keyFile: string;
  /** The installation id; found from the repo when not set. */
  installation?: string;
  api: string;
}

/** The bot's settings from the environment, or the reason they are not usable. */
export function botConfig(env: Env): BotConfig | string {
  const appId = env.YOKOTEN_BOT_APP_ID;
  if (!appId) return 'YOKOTEN_BOT_APP_ID is not set: the App ID from the App\'s settings page (docs/server.md, step 3)';
  return {
    appId,
    keyFile: env.YOKOTEN_BOT_KEY || join(env.HOME || homedir(), '.config', 'yokoten', 'bot.pem'),
    installation: env.YOKOTEN_BOT_INSTALLATION || undefined,
    api: (env.YOKOTEN_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
  };
}

/** A bot is set up on this machine: its App ID is set and its key file is there. Reads no network. */
export function hasBot(env: Env): boolean {
  const config = botConfig(env);
  return typeof config !== 'string' && existsSync(config.keyFile);
}

const b64url =(data: string | Buffer) => Buffer.from(data).toString('base64url');

/** A JWT that says "I am App `appId`", signed RS256, good for nine minutes (GitHub allows ten). */
export function appJwt(appId: string, keyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // Issued a minute back, in case this clock runs ahead of GitHub's.
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), createPrivateKey(keyPem));
  return `${header}.${payload}.${b64url(signature)}`;
}

/** "owner/name" from a GitHub remote URL (https or ssh), or null. */
export function repoOf(remote: string): string | null {
  return remote.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

/** An installation token for `repo`, good for one hour. */
export async function installationToken(config: BotConfig, repo: string): Promise<string> {
  const jwt = appJwt(config.appId, readFileSync(config.keyFile, 'utf8'));
  const call = async (method: string, path: string) => {
    const res = await fetch(`${config.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'yokoten' },
    });
    if (!res.ok) throw new Error(`GitHub said ${res.status} to ${method} ${path}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as { id?: number; token?: string };
  };
  const id = config.installation ?? (await call('GET', `/repos/${repo}/installation`)).id;
  const { token } = await call('POST', `/app/installations/${id}/access_tokens`);
  if (!token) throw new Error('GitHub sent no token');
  return token;
}

/** The environment for one command run as the bot: gh reads GH_TOKEN, and git asks gh. */
export function botEnv(env: Env, token: string): Env {
  // Added after any git config already passed this way. The empty value clears other
  // credential helpers for github.com, so git cannot fall back to the owner's login.
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const key = 'credential.https://github.com.helper';
  return {
    ...env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: key,
    [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: key,
    [`GIT_CONFIG_VALUE_${n + 1}`]: '!gh auth git-credential',
  };
}

// A pull request as GitHub Actions describes it: the event file of the run. The rule that
// judges it (src/rules/pr.ts) knows no host; this part is the GitHub half.
//
// The event file holds the title, body, labels and milestone. The changed files come from
// git, between the base and the head commit of the pull request, so the checkout needs
// both (fetch-depth: 0).

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
