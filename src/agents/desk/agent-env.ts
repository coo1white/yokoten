// The environment for an agent that yokoten starts (#613). A worker started with the
// owner's whole shell environment can read the owner's tokens, print them, push with them
// or send them out. So an agent gets a short list of names it needs to run, and nothing
// that looks secret. Every place in yokoten that starts an agent or a vendor CLI builds
// its environment here, with `buildAgentEnv`.
//
// The design follows gemini-cli's environment sanitizer (packages/core/src/services/
// environmentSanitization.ts, Apache-2.0): an allow-list of names, then a deny-list of
// secret-looking names and values. The code here is written for yokoten; none is copied.
//
// Three filters, in order:
// 1. A name that looks secret (TOKEN, KEY, PASSWORD, ...) is dropped.
// 2. The name must be on the list: SHARED_NAMES, an LC_* name, one of YOKOTEN_NAMES, or
//    a name the runtime's own file gives (its `AGENT_ENV`).
// 3. A value shaped like a known key or token is dropped, whatever its name.
// A runtime's login names skip all three, because the vendor needs its own key to run.
// They pass only to that runtime's agent. YOKOTEN_NAMES skip the first.

import type { Env } from '../../rules/config.ts';
import { findSecrets } from '../../rules/privacy/secrets.ts';
import { AGENT_ENV as COPILOT } from '../copilot.ts';
import { AGENT_ENV as ANTIGRAVITY } from '../runtimes/small/antigravity.ts';
import { AGENT_ENV as CLAUDE_CODE } from '../runtimes/claude-code.ts';
import { AGENT_ENV as CODEX } from '../runtimes/codex.ts';
import { AGENT_ENV as DEEPSEEK_HARNESS } from '../runtimes/small/deepseek-harness.ts';
import { AGENT_ENV as OPENCODE } from '../runtimes/small/opencode.ts';
import { AGENT_ENV as GEMINI } from '../runtimes/gemini.ts';
import { AGENT_ENV as GROK } from '../runtimes/grok.ts';
import { AGENT_ENV as MUSE } from '../runtimes/muse.ts';

/** The names a runtime's own file adds for its agent: its login names, and the folders it reads its config from. */
export interface RuntimeEnv {
  /** Names that hold the vendor's own login, such as its API key. They pass only to this runtime, and are never checked. */
  login: readonly string[];
  /** Names that point at the runtime's config, such as its home folder. They are checked like any other name. */
  config: readonly string[];
}

/** Each runtime yokoten knows, by the name `--agent` takes. */
export const RUNTIME_ENVS: Readonly<Record<string, RuntimeEnv>> = {
  'claude-code': CLAUDE_CODE,
  codex: CODEX,
  gemini: GEMINI,
  antigravity: ANTIGRAVITY,
  muse: MUSE,
  'deepseek-harness': DEEPSEEK_HARNESS,
  grok: GROK,
  opencode: OPENCODE,
  copilot: COPILOT,
};

// What every program needs: where to find programs, the home and temp folders, the
// language, the terminal and the user. Windows names a few of these its own way.
// Names are compared in capitals (ASCII only), because Windows does not tell `Path` from `PATH`.
const SHARED_NAMES = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  // Windows.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'COMMONPROGRAMFILES',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
]);

// The YOKOTEN_* names an agent may take from the shell that starts it: those that make the
// guard stricter or tell it where things are. Never the bot's key or app id, the release
// approval, or a lead-only path: the lead gives those on purpose, through `set`.
// YOKOTEN_PRIVATE_MARKS is a path, and the guard needs it, though its name says PRIVATE.
const YOKOTEN_NAMES = new Set(['YOKOTEN_ROLE', 'YOKOTEN_FIX_TASK', 'YOKOTEN_DONE_WHEN', 'YOKOTEN_PRIVATE_MARKS', 'YOKOTEN_TEMP_DIRS', 'YOKOTEN_GUARD_DEADLINE_MS', 'YOKOTEN_MIN_FREE_GB']);

// A name that says it holds a secret.
export const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE/;

// Values shaped like a known key or token. They are looser than the commit check's
// patterns in secrets.ts: a false hit here only drops a name an agent did not need.
// A pattern with two runs of characters has bounds and a lookbehind, so a long value
// takes linear time.
const SECRET_VALUES: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token
  /github_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained token
  /glpat-[A-Za-z0-9_-]{20,}/, // GitLab personal access token
  /hf_[A-Za-z0-9]{30,}/, // Hugging Face token
  /(?:AKIA|ASIA)[A-Z0-9]{16}/, // AWS access key id
  /AIza[A-Za-z0-9_-]{30,}/, // Google API key
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{0,4096}/, // JWT: base64 of `{"`, twice
  /xox[abeprs]-[A-Za-z0-9-]{10,}/, // Slack token
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/, // Anthropic, OpenAI and other `sk-` keys
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY/, // PEM private key
  /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/[^\s/?#@:]{0,256}:[^\s?#@]{1,256}@/, // URL with user:password@; the password may hold a /
];

// A value longer than this is dropped unread: no agent needs one, and reading it costs time.
const MAX_VALUE_LENGTH = 32 * 1024;

/** Why a name is not in an agent's environment. */
export type DropReason = 'not on the list' | 'secret name' | 'secret value' | 'too long';

/** What `sortAgentEnv` decides: the names kept, and each dropped name with its reason. Names only, never values. */
export interface SortedEnv {
  kept: string[];
  dropped: { name: string; reason: DropReason }[];
}

/** True when a value is shaped like a key or token. */
export function isSecretValue(value: string): boolean {
  if (SECRET_VALUES.some((pattern) => pattern.test(value))) return true;
  return findSecrets(value.split(/\r?\n|\\n/)).length > 0;
}

/** A name in capitals, ASCII letters only: `toUpperCase` would turn a long s (ſ) into S, and `ſHELL` into SHELL. */
const toAsciiUpper = (name: string): string => name.replace(/[a-z]+/g, (letters) => letters.toUpperCase());

/** The runtime's names, or an error that lists the runtimes yokoten knows. */
export function runtimeEnv(runtime: string): RuntimeEnv {
  const names = Object.hasOwn(RUNTIME_ENVS, runtime) ? RUNTIME_ENVS[runtime] : undefined;
  if (!names) throw new Error(`unknown runtime "${runtime}". Runtimes: ${Object.keys(RUNTIME_ENVS).join(', ')}`);
  return names;
}

/** Sort the names of `source` into kept and dropped, for an agent of `runtime` (or of no runtime). It never reads a value into its result. */
export function sortAgentEnv(source: Env, runtime?: string): SortedEnv {
  const own = runtime === undefined ? { login: [], config: [] } : runtimeEnv(runtime);
  const login = new Set(own.login.map(toAsciiUpper));
  const config = new Set(own.config.map(toAsciiUpper));
  const sorted: SortedEnv = { kept: [], dropped: [] };
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = toAsciiUpper(name);
    if (login.has(upper)) {
      sorted.kept.push(name);
      continue;
    }
    const isListed = SHARED_NAMES.has(upper) || upper.startsWith('LC_') || YOKOTEN_NAMES.has(upper) || config.has(upper);
    if (!YOKOTEN_NAMES.has(upper) && SECRET_NAME.test(upper)) sorted.dropped.push({ name, reason: 'secret name' });
    else if (!isListed) sorted.dropped.push({ name, reason: 'not on the list' });
    else if (value.length > MAX_VALUE_LENGTH) sorted.dropped.push({ name, reason: 'too long' });
    else if (isSecretValue(value)) sorted.dropped.push({ name, reason: 'secret value' });
    else sorted.kept.push(name);
  }
  sorted.kept.sort();
  sorted.dropped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted;
}

/**
 * The environment for an agent that yokoten starts: the names `sortAgentEnv` keeps from
 * `source`, then the YOKOTEN_* names yokoten sets on purpose (`set`), such as
 * YOKOTEN_ROLE=worker. `set` takes only YOKOTEN_* names, so no other value slips in.
 */
export function buildAgentEnv(source: Env, { runtime, set = {} }: { runtime?: string; set?: Env } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of sortAgentEnv(source, runtime).kept) env[name] = source[name] as string;
  for (const [name, value] of Object.entries(set)) {
    if (!name.startsWith('YOKOTEN_')) throw new Error(`buildAgentEnv sets only YOKOTEN_* names, not ${name}`);
    if (value !== undefined) env[name] = value;
  }
  return env;
}
