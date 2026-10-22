// The bot: a GitHub App that pushes branches and opens pull requests for the lead, so
// the owner's account is never used for that. It signs in with one-hour tokens made from
// its private key.
//
// The token is handed to one command's environment and never printed: a printed token
// lands in the agent's transcript.

import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { docsLink } from '../../rules/message.ts';
import { homeOf, NO_HOME } from '../../rules/privacy.ts';

export interface BotConfig {
  appId: string;
  /** Path to the App's private key (.pem). */
  keyFile: string;
  /** The installation id; found from the repo when not set. */
  installation?: string;
  api: string;
}

/** The keys file, as the reports name it. */
export const KEYS_FILE = '~/.config/yokoten/keys.env';

/** The bot's own settings, the only names read from the keys file. */
const BOT_SETTINGS = ['YOKOTEN_BOT_APP_ID', 'YOKOTEN_BOT_KEY', 'YOKOTEN_BOT_INSTALLATION'];

/**
 * A value as a shell profile line gives it: quotes taken off, a ` # comment` after an
 * unquoted value dropped, and a leading `~/` or `$HOME/` made the home folder. Single
 * quotes keep `$HOME` as it is, and quotes keep `~`, as in a shell.
 */
export function shellValue(raw: string, home: string): string {
  const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw.trim());
  if (quoted?.[1] === "'") return quoted[2];
  if (quoted) return quoted[2].replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, home);
  return raw.replace(/(?:^|\s+)#.*$/, '').trim().replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

/**
 * The bot's settings in the keys file (#405): `NAME=value` lines, `export` and quotes
 * allowed. A session's environment often does not load this file, so the bot reads it
 * itself. Only the bot's own names are read; other keys in the file are never touched.
 * No HOME, no file: then nothing.
 */
export function readKeysFile(env: Env): Env {
  const home = homeOf(env);
  if (!home) return {};
  let text = '';
  try {
    text = readFileSync(join(home, '.config', 'yokoten', 'keys.env'), 'utf8');
  } catch {
    return {};
  }
  const found: Env = {};
  for (const line of text.split(/\r?\n/)) {
    const pair = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!pair || !BOT_SETTINGS.includes(pair[1])) continue;
    const value = shellValue(pair[2], home);
    if (value) found[pair[1]] = value;
  }
  return found;
}

/**
 * The bot's settings, or the reason they are not usable. The environment comes first,
 * then the keys file. `yokoten bot` and the road's bot step both read them here, so
 * they always agree (#405).
 */
export function botConfig(env: Env): BotConfig | string {
  const settings = { ...readKeysFile(env), ...Object.fromEntries(BOT_SETTINGS.filter((name) => env[name]).map((name) => [name, env[name]])) };
  const appId = settings.YOKOTEN_BOT_APP_ID;
  if (!appId) return `YOKOTEN_BOT_APP_ID is not set, in the environment or in ${KEYS_FILE}: the App ID from the App's settings page (step 3 of ${docsLink('server.md')})`;
  const keyFile = settings.YOKOTEN_BOT_KEY || defaultKeyFile(env);
  if (!keyFile) return `${NO_HOME}: set YOKOTEN_BOT_KEY to the key file's full path`;
  return {
    appId,
    keyFile,
    installation: settings.YOKOTEN_BOT_INSTALLATION || undefined,
    api: (env.YOKOTEN_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
  };
}

/** The key file's default place, or '' with no home (#356): never the system's home. */
const defaultKeyFile = (env: Env) => {
  const home = homeOf(env);
  return home ? join(home, '.config', 'yokoten', 'bot.pem') : '';
};

/**
 * What of the bot's setup is missing on this machine, in words, or null when it is all
 * here. Names a setting or a file, never a value. Reads no network.
 */
export function missingBotSetup(env: Env): string | null {
  const config = botConfig(env);
  if (typeof config !== 'string') return existsSync(config.keyFile) ? null : `the bot's key file is missing (${env.YOKOTEN_BOT_KEY || readKeysFile(env).YOKOTEN_BOT_KEY ? 'YOKOTEN_BOT_KEY' : '~/.config/yokoten/bot.pem'})`;
  const isKeyHere = existsSync(defaultKeyFile(env));
  return `${isKeyHere ? "the bot's key file is here, but " : ''}YOKOTEN_BOT_APP_ID is not set, in the environment or in ${KEYS_FILE}`;
}

/** A bot is set up on this machine: its App ID is set and its key file is there. Reads no network. */
export function hasBot(env: Env): boolean {
  return missingBotSetup(env) === null;
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

// The title a gh command sets is read in rules/pr.ts, where the guard reads it too (#391).
export { type BotProgram, botProgram, type CommandTitle, readCommandTitle, type UnreadableTitle } from '../../rules/pr.ts';

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

// `node --test` sets NODE_TEST_CONTEXT for the test files it starts. A `node --test` that
// inherits it reports to that parent run instead, and exits 0 even when a test fails (#168).

/** A copy of `env` that a child `node --test` cannot mistake for a parent test run's. */
export function cleanChildEnv(env: Env): Env {
  const clean = { ...env };
  delete clean.NODE_TEST_CONTEXT;
  return clean;
}

/** The environment for one command run as the bot: gh reads GH_TOKEN, and git asks gh.
 * TZ is always UTC (#488): gh sends it as the Time-Zone header, and GitHub writes that
 * zone into the commits it makes, such as a merge. The command may run tests (a push
 * hook, npm test), so it gets a clean child env (#168). GH_REPO and GH_HOST are
 * dropped (#612): they would point gh at another repo or host than the one checked,
 * while the bot always names its repo itself. */
export function botEnv(env: Env, token: string): Env {
  // Added after any git config already passed this way. The empty value clears other
  // credential helpers for github.com, so git cannot fall back to the owner's login.
  const count = Number(env.GIT_CONFIG_COUNT) || 0;
  const key = 'credential.https://github.com.helper';
  const clean = {
    ...cleanChildEnv(env),
    TZ: 'UTC',
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: '',
    [`GIT_CONFIG_KEY_${count + 1}`]: key,
    [`GIT_CONFIG_VALUE_${count + 1}`]: '!gh auth git-credential',
  };
  delete clean.GH_REPO;
  delete clean.GH_HOST;
  return clean;
}
