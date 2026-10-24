import { isAbsolute, join, resolve } from 'node:path';
import { isBotProgram, PIPE_READERS, type Risk } from '../../privacy.ts';
import { type Env } from '../../config.ts';
import { MOVERS } from '../commands/check.ts';
import { base, unquotedRedirects, programName } from './read/words.ts';
import { WRITE_REDIRECT } from '../lead-only/targets.ts';

// ---- A body file the same command writes (#439) ----
//
// The guard runs before the command, so a file the command writes on its way to gh is not
// there yet. It follows one shape only, the whole command:
//
//   cat > body.md <<'EOF' && gh issue create --title "..." --body-file body.md
//   ...the body...
//   EOF
//
// The path is plain (letters, digits, . _ / -, or a leading ~/), the delimiter is a name in
// single quotes, the body ends at the first line that is the delimiter, and the gh line passes
// isPlainCommand. The guard then checks the heredoc's text, and the file on disk too when there
// is one, in case cat can't replace it. In any other command, a file on disk is trusted only
// when the whole command is plain and every other command surely writes no file; otherwise
// the command is refused (record 0014).

const HEREDOC_POST = /^cat[ \t]+>[ \t]*((?:~\/)?[A-Za-z0-9._/][A-Za-z0-9._/-]*)[ \t]+<<'([A-Za-z_]\w*)'[ \t]*&&[ \t]*(gh[ \t][^\n]*)$/;

/** The path and text of `cat > path <<'EOF' && gh …`, when that is the whole command; otherwise undefined. */
export function heredocPost(command: string, commands: string[][]): { path: string; text: string } | undefined {
  const end = command.indexOf('\n');
  const first = end === -1 ? null : HEREDOC_POST.exec(command.slice(0, end));
  if (!first || !isPlainCommand(first[3])) return undefined;
  const [, path, delimiter] = first;
  const lines = command.slice(end + 1).split('\n');
  const close = lines.indexOf(delimiter);
  // Nothing after the delimiter line but one line end.
  if (close === -1 || lines.length > close + 2 || (lines.length === close + 2 && lines[close + 1] !== '')) return undefined;
  // The reader agrees: cat writes the path, then gh runs, and nothing else.
  const [cat, post] = commands;
  const writes = cat?.[0] === 'cat' && ((cat.length === 3 && cat[1] === '>' && cat[2] === path) || (cat.length === 2 && cat[1] === `>${path}`));
  if (commands.length !== 2 || !writes || post[0] !== 'gh') return undefined;
  return { path, text: lines.slice(0, close).join('\n') };
}

// Commands that surely write no file (#439). Each list allows; anything else may write.
// Shell variables that change what bash runs or where it looks: setting one is not plain.
const SHELL_SPECIAL = /^(?:PS\d|PROMPT_\w*|HOME|PATH|CDPATH|IFS|ENV|BASH\w*|SHELLOPTS|BASHOPTS|TMOUT|HIST\w*|histchars|MAIL\w*|GLOBIGNORE|FIGNORE|EXECIGNORE|OLDPWD|PWD|OPTIND|OPTERR|POSIXLY_CORRECT|INPUTRC|TIMEFORMAT|FUNCNEST|COMP\w*|TMPDIR|SHELL|BROWSER|LD_\w*|DYLD_\w*|NODE_\w*|GIT_\w*|GH_\w*|LANG|LC_\w*)$/;
// The only variables an `export` or a command's own `X=1 cmd` may set. TZ only as
// TZ=UTC (#488): gh sends it as its Time-Zone header, so UTC keeps merges on UTC.
const EXPORTS = new Set(['GH_REPO', 'GH_HOST', 'NODE_USE_ENV_PROXY']);
const NAME_VALUE = /^([A-Za-z_]\w*)=/s;

/**
 * Whether a word sets a variable the guard trusts next to a gh post: a name in EXPORTS,
 * or TZ to UTC. A bare `export TZ` names a value the guard can't see, so it is refused.
 */
function isTrustedVariable(word: string): boolean {
  const name = NAME_VALUE.exec(word)?.[1] ?? word;
  if (EXPORTS.has(name)) return true;
  return name === 'TZ' && word.slice('TZ='.length) === 'UTC';
}
// `set` only for these: errexit, nounset and pipefail.
const SET_FLAGS = /^[-+][eu]+$/;
// Characters the shell takes as written outside quotes.
const PLAIN = /[A-Za-z0-9 \t._/=:,@%+-]/;
// Characters that are not literal inside "...": a value, a substitution, an escape, history.
const DOUBLE_QUOTED_SPECIAL = /[$`\\!]/;

// Whether the shell surely takes this command as written (#439): one line of plain words,
// joined only by ; and &&. Outside quotes it allows only PLAIN characters: no \, $, backticks,
// < or > (so no heredoc, redirect or substitution), no ( ) { } |, lone &, #, *, ? or [. A ~
// only starts a word, alone or before a /. Inside "..." it refuses only $, backticks, \ and !.
// The guard does not follow bash's grammar any further than this: anything else makes a
// body file on disk unsure. One pass over the text.
export function isPlainCommand(text: string): boolean {
  return plainBreak(text) === -1;
}

// Where the text stops being plain (see isPlainCommand): the index of the first character
// the guard does not trust, the text's length for a quote left open, or -1 when it is plain.
export function plainBreak(text: string): number {
  let quote = ''; // '' outside quotes, or ' or "
  let wordStart = true;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\n' || character === '\r') return index;
    if (quote === "'") {
      if (character === "'") quote = '';
    } else if (quote === '"') {
      if (character === '"') quote = '';
      else if (DOUBLE_QUOTED_SPECIAL.test(character)) return index;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === '&') {
      if (text[index + 1] !== '&') return index;
      index++;
    } else if (character === '~') {
      // `~+`, `~-`, `~1`, `~user` and `~'/x'` are not $HOME: only `~` and `~/` are.
      if (!wordStart || !/^(?:[/ \t;&]|$)/.test(text[index + 1] ?? '')) return index;
    } else if (character !== ';' && !PLAIN.test(character)) return index;
    wordStart = quote === '' && /[ \t;&]/.test(character);
  }
  return quote === '' ? -1 : text.length;
}

// ---- Naming what may write a body file (#498) ----
//
// A refusal names what the guard saw, so the agent knows what to leave out. The name only
// reports; the checks above decide.

const VARIABLE_RISK = 'a variable other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC set for a command';
const SHELL_VARIABLE_RISK = 'a shell variable, such as PATH or IFS, that changes what bash runs';
const TILDE_RISK = 'a `~` that may not be your home folder';
// The word after a `|`, to name the program.
const PIPE_TARGET = /[ \t]*([^\s|;&<>()'"`$\\]*)/y;
const SHOWN_PROGRAM = /^[\w.+-]{1,40}$/;

/** What may change a body file on disk before the gh in `words` reads it, or undefined (#439). */
// `plainText` is the command as the plain check reads it, and `plainAt` where it stops being
// plain (-1: all plain, so the `~` check failed). A word that holds a private mark is not
// named (`isMarked`).
type RiskInput = { heredoc?: object; plainText: string; plainAt: number; fills: boolean; writers: string[][]; isMarked: (word: string) => boolean };

export function writeRisk(words: string[], { heredoc, plainText, plainAt, fills, writers, isMarked }: RiskInput): Risk | undefined {
  if (heredoc !== undefined) return { what: 'a `cat >` heredoc' };
  if (fills && hasSedValue(plainText)) return SED_VALUE_RISK;
  if (fills) return { what: plainAt === -1 ? TILDE_RISK : breakName(plainText, plainAt, isMarked) };
  if (writesFile(words)) return { what: 'a redirect into a file' };
  if (isUnsure(words)) return { what: variableRisk(words) };
  const other = writers.find((command) => command !== words);
  return other && writerRisk(other, isMarked);
}

function breakName(text: string, at: number, isMarked: (word: string) => boolean): string {
  if (at >= text.length) return 'a quote that is not closed';
  const character = text[at];
  const next = text[at + 1] ?? '';
  switch (character) {
    case '$':
      return next === '(' ? 'a command substitution `$(…)`' : 'a `$` value the shell fills in';
    case '`':
      return 'a command substitution in backquotes';
    case '|':
      return next === '|' ? 'a `||`' : pipeName(text, at, isMarked);
    case '>':
    case '<':
      return `a redirect \`${character}\``;
    case '&':
      return 'a `&` that runs a command in the background';
    case '(':
    case ')':
      return 'a subshell `( … )`';
    case '{':
    case '}':
      return 'a `{ … }` group or brace expansion';
    case '\n':
      return 'a second line';
    case '\r':
      return 'a carriage return';
    case '\\':
      return 'a backslash';
    case '!':
      return 'a `!` inside "..."';
    case '~':
      return TILDE_RISK;
    case '#':
      return 'a `#` comment';
    case '[':
      if (/^[ \t]/.test(next) && (at === 0 || /[ \t;&]/.test(text[at - 1]))) return 'a `[ … ]` test';
      return 'a pattern `[` the shell expands';
    case '*':
    case '?':
      return `a pattern \`${character}\` the shell expands`;
  }
  return 'a character the guard does not trust';
}

const SED_VALUE_RISK: Risk = { what: 'a `$` value in a `sed` command', fix: 'type the value into the sed script in place of the `$`, or leave out the pipe' };

// Whether a sed after a pipe holds a `$`. This only picks the name, so it splits at every
// `|`, quoted or not: the pipe scan has already refused the command.
function hasSedValue(text: string): boolean {
  return text.split('|').some((part, index) => index > 0 && /^[ \t]*sed[ \t]/.test(part) && part.includes('$'));
}

function pipeName(text: string, at: number, isMarked: (word: string) => boolean): string {
  PIPE_TARGET.lastIndex = at + 1;
  const program = base(PIPE_TARGET.exec(text)?.[1] ?? '');
  if (PIPE_READERS.has(program)) return `a pipe to \`${program}\` that does not end the line in plain words`;
  return SHOWN_PROGRAM.test(program) && !isMarked(program) ? `a pipe to \`${program}\`` : 'a pipe';
}

function variableRisk(words: string[]): string {
  return words.every((word) => NAME_VALUE.test(word)) ? SHELL_VARIABLE_RISK : VARIABLE_RISK;
}

// A command that may write a file, by name.
function writerRisk(words: string[], isMarked: (word: string) => boolean): Risk {
  const at = ownVariables(words);
  if (at === -1) return { what: variableRisk(words) };
  if (writesFile(words)) return { what: 'a redirect into a file' };
  const program = base(words[at] ?? '');
  if (program === 'sed' && words.some((word) => word.includes('$'))) {
    return SED_VALUE_RISK;
  }
  if (program === 'sed') return { what: 'a `sed` with `-i`, `-f` or a script other than s/…/…/' };
  if (program === 'uniq') return { what: 'a `uniq` with a second file, which it writes' };
  if (PIPE_READERS.has(program)) return { what: `a \`${program}\` with an option that may write a file` };
  if (MOVERS.has(program)) return { what: `a \`${program}\` the guard can't follow` };
  if (program === 'export') return { what: 'an `export` of a name other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC' };
  if (isMarked(program)) return { what: 'a command' };
  return { what: SHOWN_PROGRAM.test(program) ? `a \`${program}\`` : 'a command the guard does not know' };
}

// A lone gh that reads its body from a file, `gh … --body-file - < body.md` (#391): the scan
// skips that one < at the end, since the file it names is the one checked.
export function withoutStdin(command: string, commands: string[][]): string {
  const at = command.indexOf('<');
  if (commands.length !== 1 || at === -1 || at !== command.lastIndexOf('<')) return command;
  return /^[ \t]*[A-Za-z0-9._/-]+[ \t]*$/.test(command.slice(at + 1)) ? command.slice(0, at) : command;
}

// A word that starts with ~ is the folder of a cd or pushd, or the file after -F,
// --body-file or --notes-file (#439), or the yokoten of a `yokoten bot --` (#498), as in
// `node ~/x/bin/yokoten.ts bot -- gh …`. It is `~` or starts `~/`: the guard reads only those
// as $HOME. The words have lost their quotes, so a '~ or "~ in the command makes any ~
// word unsure: bash does not expand a quoted ~.
export function tildesPlain(command: string, commands: string[][]): boolean {
  const isQuoted = /['"]~/.test(command);
  return commands.every((words) =>
    words.every(
      (word, index) =>
        !word.startsWith('~') ||
        (!isQuoted &&
          (word === '~' || word.startsWith('~/')) &&
          ((index === 1 && ['cd', 'pushd'].includes(words[0])) || ['-F', '--body-file', '--notes-file'].includes(words[index - 1] ?? '') || isBotCallAt(words, index))),
    ),
  );
}

// Whether the word at `index` is the yokoten of `yokoten bot --` or `node yokoten.ts bot --`,
// after only the command's own variables. Which yokoten runs does not change the file gh reads.
function isBotCallAt(words: string[], index: number): boolean {
  if (!isBotProgram(words[index]) || words[index + 1] !== 'bot' || words[index + 2] !== '--') return false;
  const start = ownVariables(words);
  return index === start || (index === start + 1 && words[start] === 'node');
}

/** Whether a command's own variables may change what it runs (#439). */
export function isUnsure(words: string[]): boolean {
  return ownVariables(words) === -1;
}

// Where the program starts after a command's own `X=1` words, or -1 when one of them sets a
// variable outside EXPORTS. A command of assignments only gives its length.
function ownVariables(words: string[]): number {
  let at = 0;
  while (at < words.length && NAME_VALUE.test(words[at])) at++;
  if (at === words.length) return words.every((word) => !SHELL_SPECIAL.test(NAME_VALUE.exec(word)?.[1] ?? '')) ? at : -1;
  return words.slice(0, at).every(isTrustedVariable) ? at : -1;
}

/**
 * Whether a command surely writes no file, so a body file on disk is still the one gh posts
 * (#439): no redirect into a file, no word that may run code, and either plain assignments
 * (a substitution in one is a command of its own, checked the same way) or a read in
 * `readsOnly`, maybe through `yokoten bot --`. Anything else may write one.
 */
export function writesNoFile(words: string[]): boolean {
  if (writesFile(words) || isUnsure(words)) return false;
  const at = ownVariables(words);
  return at === words.length || readsOnly(words.slice(at));
}

function readsOnly(words: string[]): boolean {
  const [program = '', sub = '', action = ''] = words;
  const args = words.slice(1);
  switch (program) {
    case 'true':
    case ':':
    case 'echo':
      return true;
    case 'printf':
      return !args.some((arg) => arg.startsWith('-v'));
    case 'test':
    case '[':
      return !args.includes('-v');
    case 'set':
      return args.length > 0 && args.every((arg, index) => SET_FLAGS.test(arg) || (/^[-+]o$/.test(arg) && args[index + 1] === 'pipefail') || (arg === 'pipefail' && /^[-+]o$/.test(args[index - 1] ?? '')));
    case 'export':
      return args.length > 0 && args.every(isTrustedVariable);
    case 'cd':
    case 'pushd':
      // A bare cd goes home, `cd -` to OLDPWD, and `pushd +1` round the stack: not followed.
      return args.length === 1 && !/^[-+]/.test(args[0]);
    case 'popd':
      return true;
    // The programs a read-only pipe may feed (#498). These have no option that writes a file.
    case 'tail':
    case 'head':
    case 'grep':
    case 'cut':
    case 'wc':
    case 'tr':
      return true;
    // These have one, so each word is checked. A word with a `$` may hold an option.
    case 'sort':
      return args.every((arg) => !arg.includes('$') && (!arg.startsWith('-') || SORT_OPTION.test(arg) || SORT_LONG_OPTIONS.has(arg)));
    case 'uniq':
      // `uniq input output` writes output; a lone `-` is the input.
      return args.every((arg) => !arg.includes('$') && (!arg.startsWith('-') || UNIQ_OPTION.test(arg))) && args.filter((arg) => arg === '-' || !arg.startsWith('-')).length <= 1;
    case 'sed':
      return sedReadsOnly(args);
    case 'gh':
      // `--web` opens a browser, which runs a program.
      return ['pr', 'issue', 'repo', 'run'].includes(sub) && ['view', 'list', 'checks'].includes(action) && !args.some((arg) => /^--web(=|$)/.test(arg) || /^-[A-Za-z]*w/.test(arg));
    case 'git':
      // Most git commands run repo config (fsmonitor, textconv, gpg); these few do not.
      if (sub === 'rev-parse') return args.slice(1).every((arg) => !arg.startsWith('--output'));
      if (sub === 'config') return words.length === 4 && action === '--get' && !words[3].startsWith('-');
      if (sub === 'remote') return words.length === 4 && action === 'get-url';
      return false;
  }
  // `yokoten bot -- x`, `node bin/yokoten.ts bot -- x`
  const bot = program === 'node' ? 1 : 0;
  if (isBotProgram(words[bot] ?? '') && words[bot + 1] === 'bot' && words[bot + 2] === '--') return readsOnly(words.slice(bot + 3));
  return false;
}

// sort's options that write nothing and run nothing: no -o, -T or --compress-program (#498).
// Flags, then at most one key (`-rk2,2n`) or one `-t`: the flags hold no `k` or `t`, so the parts
// can't overlap and the test stays linear (CodeQL found the older form exponential).
const SORT_OPTION = /^-[bdfghiMnRrsuVz]*(?:t.?|k[\d.,bdfghiMnRrV]*)?$/;
const SORT_LONG_OPTIONS = new Set(['--reverse', '--numeric-sort', '--unique', '--human-numeric-sort', '--version-sort', '--ignore-case', '--stable']);
const UNIQ_OPTION = /^-[cdDiuz]*(?:[fsw]\d*)?$/;
// sed's options that write nothing: no -i, --in-place or -f (a script from a file).
const SED_OPTION = /^-[nErsuz]+$/;
const SED_LONG_OPTIONS = new Set(['--posix', '--debug', '--sandbox', '--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data']);

// Whether a sed only prints (#498): the options above, and scripts that are only
// s/…/…/ commands, joined by `;`, with no w or e flag. Any other script is refused,
// since `w` writes a file and `e` runs one. A `$` anywhere is refused: bash fills in a
// value before sed reads the script, and a value can hold the delimiter and then `w`.
function sedReadsOnly(args: string[]): boolean {
  if (args.some((arg) => arg.includes('$'))) return false;
  let hasScript = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-e' || arg.startsWith('--expression=')) {
      const script = arg === '-e' ? args[++index] : arg.slice('--expression='.length);
      if (script === undefined || !isSubstitution(script)) return false;
      hasScript = true;
    } else if (arg.startsWith('-')) {
      if (!SED_OPTION.test(arg) && !SED_LONG_OPTIONS.has(arg)) return false;
    } else if (!hasScript) {
      if (!isSubstitution(arg)) return false;
      hasScript = true;
    }
  }
  return hasScript;
}

// Whether a sed script is only s/…/…/ commands, joined by `;`. Flags: g, p, i, I, m, M, digits.
function isSubstitution(script: string): boolean {
  let index = 0;
  for (;;) {
    if (script[index] !== 's') return false;
    const delimiter = script[index + 1] ?? '';
    if (!delimiter || /[\s\\$A-Za-z0-9]/.test(delimiter)) return false;
    index += 2;
    for (let part = 0; part < 2; part++) {
      while (index < script.length && script[index] !== delimiter) index += script[index] === '\\' ? 2 : 1;
      if (script[index] !== delimiter) return false;
      index++;
    }
    while (index < script.length && /[gpiImM0-9]/.test(script[index])) index++;
    if (index === script.length) return true;
    if (script[index] !== ';') return false;
    index++;
    while (script[index] === ' ') index++;
  }
}

// Whether a command's own redirects write a file: `gh … > body.md` empties it before gh reads it.
export function writesFile(words: string[]): boolean {
  for (const index of unquotedRedirects.get(words) ?? []) {
    const redirect = WRITE_REDIRECT.exec(words[index]);
    const path = redirect && (redirect[2] || words[index + 1]);
    if (path && path !== '/dev/null' && !(redirect[1] === '>&' && /^(\d+|-)$/.test(path))) return true;
  }
  return false;
}

// A quote or backslash before or after a ~: bash then does not read that ~ as the home folder.
export const QUOTED_TILDE = /[\\'"]~|~[\\'"]/;

// The folder after a `cd` or `pushd` with a plain path, or null when the guard can't tell:
// a variable, a substitution, `cd -`, `popd`, a ~ that was quoted (`isTildeQuoted`, #465):
// bash keeps a quoted ~ as a folder named ~, or a bare relative folder (#559): bash
// searches CDPATH for one, and CDPATH may be set in the shell without being exported.
// Any other command leaves the folder as it was.
export function folderAfter(words: string[], folder: string | null, { env, isTildeQuoted, isCdPathSkipped = false }: { env: Env; isTildeQuoted: boolean; isCdPathSkipped?: boolean }): string | null {
  const name = programName(words[0] ?? '');
  if (name === 'popd') return null;
  if (name !== 'cd' && name !== 'pushd') return folder;
  const target = words.slice(1).find((word) => !/^-[LPe@]+$/.test(word));
  if (target === undefined) return env.HOME ?? null;
  if (target === '-' || /[$`*?[]/.test(target) || /^~[^/]/.test(target)) return null;
  if (target.startsWith('~') && isTildeQuoted) return null;
  const path = target.startsWith('~') ? (env.HOME ? join(env.HOME, target.slice(1)) : null) : target;
  if (path === null) return null;
  if (isAbsolute(path)) return path;
  // Only `/`, `./`, `../` and `.` and `..` alone say where a relative `cd` goes: bash
  // searches CDPATH for the rest, even with a `/` inside (`cd sub/dir`).
  // `isCdPathSkipped` reads it as written instead: the likely folder, never a sure one.
  if (!isCdPathSkipped && target !== '.' && target !== '..' && !target.startsWith('./') && !target.startsWith('../')) return null;
  return folder === null ? null : resolve(folder, path);
}

