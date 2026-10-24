import { finding, type Finding } from '../../message.ts';
import { isAssignment, programName } from '../bash/read/words.ts';
import { commandWords } from '../bash/read/read.ts';

// ---- Commands that print account details (#390) ----
//
// Some commands print the owner's name, email, login or a private host: a git author line,
// a remote URL, an account report. Once that output reaches an agent it can't be taken
// back, so the hook pipes these commands through `yokoten redact`. Only a read is
// rewritten, and only when the whole command is one plain command from this table: no
// separator, pipe, redirect, substitution, prefix or launcher. Then the rewrite can't run
// anything the user did not already see. One row per kind of command. Add a row when an
// incident shows a new one.

/** One read-only command that prints account details. */
interface AccountPrinter {
  /** The program, by its base name. */
  program: string;
  /** Its subcommands that print them: the word right after the program. */
  subcommands: string[];
  /** True when the words after the subcommand keep it a plain read that prints them. */
  accepts: (args: string[]) => boolean;
  /** What it prints, for the message. */
  prints: string;
  /** Options the rewrite adds after the subcommand, so the read runs no program the repo names. */
  harden?: string[];
}

// Options that make a git read write a file or run another program. A format option keeps
// it a read: `--format=%an` prints the author with no "Author:" line, and redact hides the
// value wherever it stands (#413).
const GIT_UNSAFE = /^(?:--output|-o|--ext-diff|--exec-path|--textconv|--filters|--show-signature)/;
const isGitRead = (args: string[]) => !args.some((arg) => GIT_UNSAFE.test(arg));
// A log can run a program the repo's config names: a textconv, an external diff, or gpg to
// check a signature (log.showSignature). The rewrite turns them off, so an allowed read runs
// only git (#413).
const NO_DIFF_PROGRAMS = ['--no-ext-diff', '--no-textconv', '--no-show-signature'];
// `git shortlog` with no revision reads a log from stdin when stdin is no terminal, as in the
// rewrite: so it is rewritten only with a revision, `git shortlog -sne HEAD` (#413). The word
// after an option that takes one is no revision, nor is a path after `--`.
const SHORTLOG_VALUED = new Set(['--group', '--format', '-w']);
function isShortlogRead(args: string[]): boolean {
  if (!isGitRead(args)) return false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return false;
    if (SHORTLOG_VALUED.has(args[i])) i++;
    else if (!args[i].startsWith('-')) return true;
  }
  return false;
}

// `git cat-file -p <object>`, or `git cat-file commit|tag <object>`: one object, printed. A
// commit or a tag names its author. A batch reads object names from stdin: not rewritten.
const isCatFileRead = (args: string[]) => args.length === 2 && ['-p', 'commit', 'tag'].includes(args[0]) && !args[1].startsWith('-');

// `git remote -v`, or `git remote get-url|show <name>`: never add, remove or set.
const isRemoteRead = (args: string[]) =>
  (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) || ((args[0] === 'get-url' || args[0] === 'show') && args.slice(1).every((arg) => /^(?:--all|--push|-n|[\w.-]+)$/.test(arg)));

// `git config --list`, or a read of one account key. A write prints nothing.
const CONFIG_SCOPES = new Set(['--global', '--system', '--local', '--show-origin', '--show-scope', '--includes', '--name-only', '-z', '--null']);
const ACCOUNT_KEY = /^(?:user|remote|credential|url|sendemail)\./i;
export function isConfigRead(args: string[]): boolean {
  const [verb, key, ...more] = args.filter((arg) => !CONFIG_SCOPES.has(arg));
  if (verb === '--list' || verb === '-l' || verb === 'list') return key === undefined;
  if (verb === '--get' || verb === '--get-all' || verb === 'get' || verb === '--get-regexp') return key !== undefined && ACCOUNT_KEY.test(key) && more.length === 0;
  return false;
}

// A GET of a traffic or account path: one path, and only options that read.
function isAccountGet(args: string[]): boolean {
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--paginate', '-i', '--include', '--silent'].includes(arg)) continue;
    if (arg === '--jq' || arg === '-q' || arg === '-X' || arg === '--method') {
      const value = args[++i];
      if (value === undefined || ((arg === '-X' || arg === '--method') && value.toUpperCase() !== 'GET')) return false;
    } else if (/^--(?:jq)=/.test(arg)) continue;
    else if (/^(?:--method=|-X)/.test(arg)) {
      if (arg.replace(/^(?:--method=|-X)/, '').toUpperCase() !== 'GET') return false;
    } else if (arg.startsWith('-') || path !== undefined) return false;
    else path = arg;
  }
  return path !== undefined && /(^|\/)(?:traffic|user|users)(?:\/|$)/.test(path);
}

// Options that only choose which account or registry to ask: each takes a value.
const takesOnly = (valued: string[], flags: string[] = []) => (args: string[]) => {
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i]) && args[i + 1] !== undefined) i++;
    else if (!flags.includes(args[i])) return false;
  }
  return true;
};

export const ACCOUNT_PRINTERS: AccountPrinter[] = [
  { program: 'git', subcommands: ['log', 'show', 'whatchanged'], accepts: isGitRead, prints: 'author names and emails', harden: NO_DIFF_PROGRAMS },
  { program: 'git', subcommands: ['blame', 'annotate'], accepts: isGitRead, prints: 'author names and emails', harden: ['--no-textconv'] },
  { program: 'git', subcommands: ['for-each-ref'], accepts: isGitRead, prints: 'author names and emails' },
  { program: 'git', subcommands: ['shortlog'], accepts: isShortlogRead, prints: 'author names and emails' },
  { program: 'git', subcommands: ['cat-file'], accepts: isCatFileRead, prints: 'author names and emails' },
  { program: 'git', subcommands: ['remote'], accepts: isRemoteRead, prints: 'remote URLs' },
  { program: 'git', subcommands: ['config'], accepts: isConfigRead, prints: 'your name, email and remotes' },
  { program: 'gh', subcommands: ['api'], accepts: isAccountGet, prints: 'the login and account details' },
  { program: 'gh', subcommands: ['auth'], accepts: (args) => args[0] === 'status' && takesOnly(['--hostname', '-h'], ['--active', '-a'])(args.slice(1)), prints: 'the login' },
  { program: 'npm', subcommands: ['whoami'], accepts: takesOnly(['--registry']), prints: 'the login' },
  { program: 'wrangler', subcommands: ['whoami'], accepts: (args) => args.length === 0, prints: 'the account name and email' },
];

// Shell text that makes more than one plain command: separators, pipes, background, redirects,
// substitutions, groups, a line end, an escape, a comment, or a glob: `git log *` in a folder
// with a file named `--output=x` passes that option (#413).
const NOT_SIMPLE = /[;&|<>`$(){}\\\n#*?[]/;
// Quoted text bash reads as it is: '...', or "..." with no $, ` or \ inside. A format such as
// '%(authorname) <%ae>' is one word, not a group or a redirect (#413). The search runs from
// the left, as bash reads. A quote left after it means the search and bash may not agree on
// where a string ends: a "..." with a $ inside, an escaped or an unclosed quote. Then the
// command is not plain, so a quote can never hide a redirect.
const LITERAL_QUOTED = /'[^'\n]*'|"[^"$`\\\n]*"/g;
export function isSimple(command: string): boolean {
  const rest = command.replace(LITERAL_QUOTED, 'x');
  return !/['"]/.test(rest) && !NOT_SIMPLE.test(rest);
}
// A word that reads as a redirect: a second check, in case a quote was read wrong.
const REDIRECT_WORD = /^\d*[<>]|^&>/;
// Runners that start a package's program by name: `npx wrangler`, `pnpm dlx wrangler`.
const PACKAGE_RUNNERS: Record<string, string[]> = { npx: [], bunx: [], pnpm: ['dlx', 'exec'], yarn: ['dlx', 'exec'] };

/** The mark every wrapped command carries, so the hook never wraps one twice. */
export const REDACT_MARKER = '# yokoten-redact';
const RUNS_REDACT = /\byokoten(?:\.ts|\.js)?["']?\s+redact\b/;
/**
 * A command that already sends its output through `yokoten redact`: it starts with the
 * wrapper's first line, marker included, and calls redact. A comment that names them does not count.
 */
export const isRedacted = (command: string): boolean => command.startsWith(`set -o pipefail ${REDACT_MARKER}\n`) && RUNS_REDACT.test(command);

/** What a plain read from ACCOUNT_PRINTERS prints, and the command as the rewrite runs it. */
function readAccount(command: string): { printed: string; hardened: string } | null {
  if (isRedacted(command) || !isSimple(command)) return null;
  let words: string[];
  try {
    const commands = commandWords(command);
    if (commands.length !== 1) return null;
    words = commands[0];
  } catch {
    return null;
  }
  if (!words.length || isAssignment(words[0]) || words.some((word) => REDIRECT_WORD.test(word))) return null;
  let at = 0;
  let name = programName(words[0]);
  if (Object.hasOwn(PACKAGE_RUNNERS, name)) {
    at = PACKAGE_RUNNERS[name].includes(words[1]) ? 2 : 1;
    if (words[at] === undefined) return null;
    name = programName(words[at]).replace(/@[^/]*$/, '');
  }
  const subcommand = words[at + 1];
  const row = ACCOUNT_PRINTERS.find((printer) => printer.program === name && printer.subcommands.includes(subcommand) && printer.accepts(words.slice(at + 2)));
  if (!row) return null;
  let hardened = command;
  if (row.harden) {
    // The options go right after the subcommand. Both words must stand unquoted at the start,
    // or the place is unclear, and the command is not rewritten.
    const head = /^(\s*)(\S+)(\s+)(\S+)(?=\s|$)/.exec(command);
    if (at !== 0 || !head || head[2] !== words[0] || head[4] !== subcommand) return null;
    hardened = `${head[0]} ${row.harden.join(' ')}${command.slice(head[0].length)}`;
  }
  return { printed: `\`${row.program} ${subcommand}\` prints ${row.prints}`, hardened };
}

/**
 * What the command prints about the owner, or null. Not null only when the whole command
 * is one plain command that a row of ACCOUNT_PRINTERS lists, its subcommand in place:
 * `git remote add show x` is no `git remote show`.
 */
export const printsAccount = (command: string): string | null => readAccount(command)?.printed ?? null;

/** The command as the rewrite runs it: a git log or blame with no textconv or external diff (#413). */
export const hardenRead = (command: string): string => readAccount(command)?.hardened ?? command;

/** The refusal for an agent whose hook can't change the command, with yokoten.json "privacy.output" "stop": the fix is the wrapped command. */
export const privateOutput = (printed: string, wrapped: string): Finding => finding('private-output', `${printed}, and this agent can't filter it`, `run it as \`${wrapped}\``);

/**
 * The command with its output, stderr too, sent through `redact`, the command that runs
 * `yokoten redact`. pipefail keeps the command's exit code. If redact can't start or
 * stops, `cat` passes the rest through: hiding output never stops the command. The
 * command sits on lines of its own, after the marker.
 */
export const wrapForRedact = (command: string, redact: string): string => `set -o pipefail ${REDACT_MARKER}\n(\n${command}\n) 2>&1 | { ${redact} || cat; }`;

