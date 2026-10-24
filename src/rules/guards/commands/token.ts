import { finding, type Finding } from '../../message.ts';
import { hostTokenReveal } from '../worker/config-command.ts';
import { isGit, GIT_VALUE_OPTIONS, withoutShellRedirects, programName } from '../bash/read/words.ts';
import { plainArgs } from '../lead-only/targets.ts';

// itself (#659, #668). No agent needs to see it, since gh and `yokoten bot` use it without
// showing it. So, for every agent, the guard refuses the plain ways to print or send it:
// gh's own commands that print it, a gh alias (which can run them under another name), the
// token's variables, git's and the system's credential stores, and settings that make the
// bot's gh or git run another program in the bot's environment, which holds the token.
// It reads characters, not code: a script written and then run, or one that reads gh's
// files itself, gets past (guide: What it doesn't do).

const TOKEN_FIX = 'run gh itself, or `yokoten bot -- gh …`, which use the token without showing it; `gh auth status` says whether gh is signed in';
// The names, with a way around a refusal that only mentions one.
const NAME_FIX = `${TOKEN_FIX}. To write the name in a post, put the text in a body file; to search for it, leave out the \`$\` (\`rg GH_TOKEN\`)`;
const BOT_FIX = 'run the bot\'s gh or git with no settings in front and no `-c`; a pager, an editor or a credential helper would run in the bot\'s environment, which holds its token';

const TOKEN_NAMES = 'GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN';
// `$GH_TOKEN`, `${GH_TOKEN}`, `${GH_TOKEN:-x}`, `${#GH_TOKEN}`, `${!GH_TOKEN}`, in any quotes.
const TOKEN_VARIABLE = new RegExp(String.raw`\$\{?[#!]?(?:${TOKEN_NAMES})(?!\w)`);
// PowerShell's `$env:GH_TOKEN` and cmd's `%GH_TOKEN%`. Windows names ignore case.
const WINDOWS_VARIABLE = new RegExp(String.raw`\$env:(?:${TOKEN_NAMES})(?!\w)|%(?:${TOKEN_NAMES})%`, 'i');
const TOKEN_NAME = new RegExp(String.raw`(?<!\w)(?:${TOKEN_NAMES})(?!\w)`);
// Programs that run the code they are given, or print a variable by name: `process.env.GH_TOKEN`
// in `node -e` reads the token. A shell is left out: the guard reads `bash -c` text as commands.
const READS_ENV = /^(python[\d.]*|node|nodejs|deno|bun|tsx|ts-node|perl|ruby|php|lua|osascript|pwsh|powershell|printenv|awk|gawk|mawk|jq|Rscript|tclsh|java)$/;
// Git prints the Authorization header in a trace only when this is turned off.
const TRACE_UNREDACTED = /(?<!\w)GIT_TRACE_REDACT=(?!["']?(?:1|true|yes|on)(?:["'\s;&|)]|$))/i;
// Git settings in the environment: they reach the bot's git, which keeps the variables it is given.
const GIT_CONFIG_VARIABLE = /(?<!\w)GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)=/;
// The files gh and git keep a login in, as plain text.
const CREDENTIAL_FILE = /(?:^|[\\/])(?:\.git-credentials|gh[\\/]hosts\.ya?ml)$/;
const shows = (what: string, fix = TOKEN_FIX) => finding('gh-token', what, fix);

/** The keys git's `-c key=value` and `--config-env key=VAR` set before git's command, in lower case. */
function gitSettings(args: string[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (!word.startsWith('-')) break;
    let setting: string | undefined;
    if (word === '-c' || word === '--config-env') setting = args[++index];
    else if (word.startsWith('--config-env=')) setting = word.slice('--config-env='.length);
    else if (word.startsWith('-c')) setting = word.slice(2);
    else if (GIT_VALUE_OPTIONS.has(word)) index++;
    if (setting !== undefined) keys.push(setting.split('=')[0].toLowerCase());
  }
  return keys;
}

/** Where the bot's command starts in the words (`yokoten bot -- git …`), or -1. */
const botAt = (words: string[]) => {
  const at = words.findIndex((word, index) => word === 'bot' && words[index + 1] === '--');
  return at === -1 ? -1 : at + 2;
};

/** For every agent: a command that shows gh's token, or lets a program take it, or null. */
export function checkTokenUse(command: string, commands: string[][]): Finding | null {
  if (TOKEN_VARIABLE.test(command) || WINDOWS_VARIABLE.test(command)) {
    return shows("the command expands gh's token from the environment, so it can reach the host around the guard", NAME_FIX);
  }
  if (TRACE_UNREDACTED.test(command)) return shows('GIT_TRACE_REDACT turned off makes a git trace print the token git sends');
  const bot = commands.some((words) => botAt(words) !== -1);
  if (bot && GIT_CONFIG_VARIABLE.test(command)) return shows('git settings in the environment reach the bot\'s git, and can run a program where the bot\'s token is', BOT_FIX);
  for (const raw of commands) {
    // A here-string is read as a command of its own: `bash <<< 'gh auth token'`.
    const words = raw[0] === '<<<' ? raw.slice(1) : raw;
    const names = words.map(programName);
    const runner = names.find((name) => READS_ENV.test(name));
    if (runner && words.some((word) => TOKEN_NAME.test(word))) return shows(`\`${runner}\` is given the name of gh's token, so it can read the token and reach the host around the guard`, NAME_FIX);
    if (words.some((word) => CREDENTIAL_FILE.test(word))) return shows('the command names a file where gh or git keeps a login as plain text');
    const reached = checkCredentialStores(words, names) ?? checkTokenGit(words) ?? hostTokenReveal(words);
    if (reached) return reached;
  }
  return null;
}

/** The system's password stores and git's credential helpers, asked for a password. */
function checkCredentialStores(words: string[], names: string[]): Finding | null {
  const at = (name: string) => names.indexOf(name);
  const security = at('security');
  if (security !== -1 && /^find-(internet|generic)-password$/.test(words[security + 1] ?? '') && words.some((word) => /^-[a-zA-Z]*[wg]$/.test(word))) {
    return shows('`security find-…-password -w` prints a password from the keychain, where gh may keep its token');
  }
  const secretTool = at('secret-tool');
  if (secretTool !== -1 && words[secretTool + 1] === 'lookup') return shows('`secret-tool lookup` prints a password from the keyring, where gh may keep its token');
  if (names.some((name) => name.startsWith('git-credential')) && words.includes('get')) return shows('a git credential helper with `get` prints the password it keeps, which may be gh\'s token');
  return null;
}

/** git: a credential read, a credential helper set with `-c`, and any setting given to the bot's git. */
function checkTokenGit(words: string[]): Finding | null {
  const at = words.findIndex(isGit);
  if (at === -1) return null;
  const args = withoutShellRedirects(words, at + 1);
  const keys = gitSettings(args);
  if (at === botAt(words) && keys.length) return shows(`\`-c ${keys[0]}\` on the bot's git can run a program where the bot's token is`, BOT_FIX);
  if (keys.some((key) => key.startsWith('credential.'))) return shows('a credential helper set with `-c` runs a program that gets git\'s login');
  const [sub, action] = plainArgs(args, [...GIT_VALUE_OPTIONS]);
  if (sub === 'credential' && action === 'fill') return shows("`git credential fill` prints the password git keeps for a host, which is gh's token when gh signs git in");
  if (sub?.startsWith('credential-') && args.includes('get')) return shows(`\`git ${sub} get\` prints the password it keeps, which may be gh's token`);
  return null;
}

