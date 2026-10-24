import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type Env } from '../../config.ts';
import { type Finding } from '../../message.ts';
import { aliasFinding } from '../commands/lose-work.ts';
import { HOOKS_DIR, isHooksPath, hooksPath, isInclude, includes } from './settings.ts';
import { leaves, KEYWORDS } from '../bash/read/words.ts';
import { spend, withBudget } from '../bash/read/run.ts';
import { commandWords } from '../bash/read/read.ts';

const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);
export const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l', 'get', 'list']);
const CONFIG_REMOVES = new Set(['--unset', '--unset-all', 'unset']);
const CONFIG_EDITS = new Set(['--edit', '-e', 'edit']);
const CONFIG_SECTIONS = new Set(['--rename-section', '--remove-section', 'rename-section', 'remove-section']);
// git 2.46 and later also takes a subcommand: `git config get|list|set|unset|...`.
const CONFIG_SUBCOMMANDS = new Set(['get', 'list', 'set', 'unset', 'edit', 'rename-section', 'remove-section']);

// Every long option of `git config`, old form and subcommands, git 2.43 to 2.51.
const CONFIG_LONG_OPTIONS = [
  ...CONFIG_VALUE_OPTIONS, ...CONFIG_READS, ...CONFIG_REMOVES, ...CONFIG_EDITS, ...CONFIG_SECTIONS,
  '--global', '--system', '--local', '--worktree', '--replace-all', '--add', '--fixed-value', '--bool', '--int',
  '--bool-or-int', '--bool-or-str', '--path', '--expiry-date', '--null', '--name-only', '--includes',
  '--show-origin', '--show-scope', '--show-names', '--all', '--regexp', '--append',
].filter((option) => option.startsWith('--'));
// Short options that take a value: in `-fx` the rest of the word is the value.
const CONFIG_SHORT_VALUES = 'ft';

// An option as git reads it (#358). git takes a long option by any start of its name
// (`--ed` is --edit); a start several options share is each of them, since git refuses
// it anyway. Short options join (`-ef x` is `-e -f x`). `takesNext`: the next word is a value.
function readConfigOption(word: string): { names: string[]; takesNext: boolean } {
  if (word.startsWith('--')) {
    const [name, ...value] = word.split('=');
    const exact = CONFIG_LONG_OPTIONS.includes(name);
    const matches = exact ? [name] : CONFIG_LONG_OPTIONS.filter((option) => option.startsWith(name));
    const names = matches.length > 0 ? matches : [name];
    return { names: value.length > 0 ? names.map((n) => `${n}=${value.join('=')}`) : names, takesNext: value.length === 0 && names.some((n) => CONFIG_VALUE_OPTIONS.has(n)) };
  }
  const names: string[] = [];
  for (const [index, letter] of [...word.slice(1)].entries()) {
    names.push(`-${letter}`);
    if (CONFIG_SHORT_VALUES.includes(letter)) return { names, takesNext: index === word.length - 2 };
  }
  return { names, takesNext: false };
}

// Splits `git config` arguments into options and plain words. The old form (`isOldForm`)
// reads options only before the first plain word: `git config core.hooksPath --local`
// sets the value "--local". The subcommand form reads options anywhere.
function splitConfig(args: string[], isOldForm: boolean): { options: string[]; plain: string[] } {
  const options: string[] = [];
  const plain: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((isOldForm && plain.length > 0) || !args[i].startsWith('-') || args[i] === '-') plain.push(args[i]);
    else if (args[i] === '--') {
      plain.push(...args.slice(i + 1));
      break;
    } else {
      const { names, takesNext } = readConfigOption(args[i]);
      options.push(...names);
      if (takesNext) i++;
    }
  }
  return { options, plain };
}

/**
 * Whether this `git config` call turns push.followTags on: it makes every later plain push
 * carry the tags, so a tag is published without a push that names it (#829). A read, a
 * removal and a false value change nothing.
 */
export function setsFollowTags(args: string[]): boolean {
  const first = splitConfig(args, true);
  const subcommand = CONFIG_SUBCOMMANDS.has(first.plain[0] ?? '') ? first.plain[0] : undefined;
  const rest = subcommand ? splitConfig(first.plain.slice(1), false) : { options: [], plain: first.plain };
  const options = [...first.options, ...rest.options];
  const actions = subcommand ? [subcommand] : options;
  if ((rest.plain[0] ?? '').toLowerCase() !== 'push.followtags') return false;
  if (actions.some((a) => CONFIG_REMOVES.has(a))) return false;
  const value = rest.plain[1];
  const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
  if (actions.some((a) => CONFIG_READS.has(a)) || (value === undefined && !isSet)) return false;
  return value === undefined || !/^(false|no|off|0)$/i.test(value);
}

// `git config`: a read passes; a change to core.hooksPath passes only to .githooks, or as
// checkHooksFolder allows. `directory` is the folder git works in, or null when unknown.
export function checkConfig(args: string[], directory: string | null, env: Env): Finding | null {
  let { options, plain } = splitConfig(args, true);
  const subcommand = CONFIG_SUBCOMMANDS.has(plain[0]) ? plain[0] : undefined;
  if (subcommand) {
    const rest = splitConfig(plain.slice(1), false);
    options = [...options, ...rest.options];
    plain = rest.plain;
  }
  const actions = subcommand ? [subcommand] : options;
  // An editor can change any setting, core.hooksPath too, and the guard cannot see what
  // it writes: `GIT_EDITOR="sed -i ..." git config --edit` (#358). In any scope.
  const edit = actions.find((a) => CONFIG_EDITS.has(a));
  if (edit) {
    return hooksPath(
      `git config ${edit} opens a config file in an editor, which can change core.hooksPath and turn off the commit check`,
      'read a setting with `git config --get <key>`, and change one by name (`git config <key> <value>`), so the guard can check it',
    );
  }
  const section = actions.find((a) => CONFIG_SECTIONS.has(a));
  if (section) {
    if (plain.some((w) => w.toLowerCase() === 'core')) return hooksPath(`git config ${section} core changes core.hooksPath, which turns off the commit check`);
    // `--rename-section x include` makes the settings of x an include.
    const include = plain.slice(1).find((w) => isInclude(`${w}.path`));
    return include ? includes(`git config ${section} to ${include}`) : null;
  }
  const key = plain[0] ?? '';
  // `git config alias.x=...` defines an alias, which can run another command under a
  // new name: refused, not parsed (#560). A read passes. For a worker the worker rule
  // in checkGit still answers first, with its own id.
  if (/^alias\./i.test(key)) {
    const value = plain[1];
    const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
    const removes = actions.some((a) => CONFIG_REMOVES.has(a));
    const isRead = actions.some((a) => CONFIG_READS.has(a)) || (value === undefined && !isSet && !removes);
    return isRead ? null : aliasFinding(`\`git config ${key}\` changes an alias, which can run another command under a new name`);
  }
  if (!isHooksPath(key) && !isInclude(key)) return null;
  const remove = actions.find((a) => CONFIG_REMOVES.has(a));
  if (remove) return isInclude(key) ? null : hooksPath(`git config ${remove} core.hooksPath turns off the commit check`);
  if (actions.some((a) => CONFIG_READS.has(a))) return null;
  // A set: `git config <key> <value>`, --add, --replace-all or `git config set`.
  // With no value and no action, it is a read.
  const value = plain[1];
  const isSet = subcommand !== undefined || actions.some((a) => a === '--add' || a === '--replace-all');
  if (value === undefined && !isSet) return null;
  if (isInclude(key)) return includes(`git config ${key}`);
  if (value === HOOKS_DIR) return null;
  if (value === undefined) return hooksPath('git config set core.hooksPath with no value turns off the commit check');
  return checkHooksFolder(value, options, directory, env);
}

// Config that is not this repo's own: a change there reaches other repos, or none.
// --worktree writes the config of the worktree git works in, which may not be this one.
const OTHER_SCOPES = new Set(['--global', '--system', '-f', '--file', '--blob', '--worktree']);

// A new core.hooksPath in the repo's own config passes when it is the value already set,
// or when git runs the folder's pre-commit (an executable file whose first line names sh,
// bash, dash or zsh) and the script runs `yokoten check` (for husky, .husky/pre-commit).
function checkHooksFolder(value: string, options: string[], directory: string | null, env: Env): Finding | null {
  const scope = options.find((o) => OTHER_SCOPES.has(o.split('=')[0]));
  if (scope) return hooksPath(`git config ${scope} core.hooksPath changes the hooks folder outside this repo's own config, which can turn off the commit check`);
  // git expands these, and the guard does not: it cannot tell which folder they name.
  if (value.startsWith('~') || value.startsWith('%(')) return hooksPath(`core.hooksPath ${value} names a folder git expands, which the guard cannot check`);
  const root = directory === null ? null : readGit(directory, ['rev-parse', '--show-toplevel'], env);
  if (root === null) return hooksPath('changing core.hooksPath where the guard cannot find the repo can turn off the commit check');
  if (readGit(root, ['config', '--get', 'core.hooksPath'], env) === value) return null;
  const file = hookFile(root, value);
  if (file === null) return hooksPath(`core.hooksPath ${value} is outside this repo, so the commit check does not run`);
  // git runs the folder's own pre-commit only when it is an executable file; husky's
  // `.husky/_/pre-commit` then runs `.husky/pre-commit`, with `sh -e`.
  const folder = hooksFolder(root, value);
  const runs = `${folder}/pre-commit`.replace(/^\//, '');
  const notRun = hookNotRun(join(root, runs));
  if (notRun) return hooksPath(`core.hooksPath ${value} turns off the commit check: git does not run ${runs}, ${notRun}`, `make ${runs} an executable shell script (\`yokoten init\` sets it up), then set core.hooksPath again`);
  const isHusky = folder === '.husky/_';
  const notHusky = isHusky ? notHuskys(root) : null;
  if (notHusky) return hooksPath(`core.hooksPath ${value} may not run the commit check: ${notHusky}`, 'run `npx husky` to write husky\'s own files, then set core.hooksPath again');
  if (runsCheck(readText(join(root, file)), isHusky)) return null;
  return hooksPath(`core.hooksPath ${value} turns off the commit check: ${file} does not run \`yokoten check\``, `add \`yokoten check\` to ${file} (\`yokoten init\` adds it), then set core.hooksPath again`);
}

// The shells a hook may name on its first line, directly or through /usr/bin/env (also
// `env -S`). A file with no #! line git runs with sh.
const SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s*)?|\/(?:[\w.+-]+\/)*)(?:sh|bash|dash|zsh)(?:[ \t].*)?$/;

// Why git would not run the hook file at `path` as a shell script, or null when it would.
function hookNotRun(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return 'which is not a file';
  } catch {
    return 'which does not exist';
  }
  if (process.platform !== 'win32') {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return 'which is not executable';
    }
  }
  const first = readText(path).split(/\r?\n/, 1)[0];
  return !first.startsWith('#!') || SHEBANG.test(first) ? null : 'whose first line does not name sh, bash, dash or zsh';
}

// husky 9's own files in `.husky/_`: each hook sources `h` from its folder, and `h` runs
// `.husky/<hook>` with `sh -e` (or sources it after `set -e`) and fails when it fails.
// Any other `.husky/_/pre-commit` or `h` may not run `.husky/pre-commit` at all.
const HUSKY_HOOK = new Set(['. "${0%/*}/h"', '. "$(dirname "$0")/h"']);
// The sha256 of each `h` husky 9.0.1 to 9.1.7 writes, without its comments, blank lines and indents.
const HUSKY_H = new Set([
  'b4b605f02218e49f92d437c0a447422cf962979c9805ec0722fd73bb12fc14ca', // 9.0.1
  '4cfec33fb6483d59ef799858e8ae5df0dfc98454ea386145c8382024076e9566', // 9.0.2 to 9.0.5
  '0ee76fc9c7a5dbce7cede4a7c6d99683c5e817164d5d86366541f008577daaa1', // 9.0.6
  '60898241f581d3f63d82dc61e43edbebcce35969496d446eadc3fba0854963ad', // 9.0.7 to 9.0.10
  '38db74aaa760471c57f52d64b89894a2a66098045068776c01fdde3518cdf8fb', // 9.0.11
  '035106e41eb342267fe34024d2aaebf81588523b28d46714283a273f62abdfa5', // 9.1.0 and 9.1.1
  'b4d32bb43592bfdc3a4077f47985f69777539e69ed16907148044b1d2b54f6ea', // 9.1.2
  '237b908c80bcad80439474bb49def6559697dbabee6cb2d6f6c969f354886d81', // 9.1.3 to 9.1.7
]);
const shellLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

// Why `.husky/_` in `root` is not husky's own, or null when it is.
function notHuskys(root: string): string | null {
  const hook = shellLines(readText(join(root, '.husky', '_', 'pre-commit')));
  if (hook.length !== 1 || !HUSKY_HOOK.has(hook[0])) return '.husky/_/pre-commit is not the one husky writes';
  const h = shellLines(readText(join(root, '.husky', '_', 'h'))).join('\n');
  if (!HUSKY_H.has(createHash('sha256').update(h).digest('hex'))) return '.husky/_/h is missing, or is not the one a husky 9 release writes';
  return null;
}

/**
 * The pre-commit file git runs for this core.hooksPath, relative to the repo root, or null
 * when the folder is outside the repo. husky's folder (`.husky/_`, or `.husky` before
 * husky 9) runs `.husky/pre-commit`. Any other folder runs its own pre-commit.
 */
export function hookFile(root: string, setting: string): string | null {
  const folder = hooksFolder(root, setting);
  if (folder === null) return null;
  if (folder === '.husky' || folder === '.husky/_') return '.husky/pre-commit';
  return folder ? `${folder}/pre-commit` : 'pre-commit';
}

// The hooks folder, relative to the repo root ('' for the root), or null when outside it.
function hooksFolder(root: string, setting: string): string | null {
  const folder = relative(root, resolve(root, setting)).split('\\').join('/');
  return folder === '..' || folder.startsWith('../') || isAbsolute(folder) ? null : folder;
}

// A line that runs the check and stops the commit when it fails, in the shapes yokoten
// writes or knows: `exec node "bin/yokoten.ts" check --staged`, `npx yokoten check || exit 1`,
// `pnpm exec yokoten check`, `npx lint-staged && npx yokoten check`, and the guarded form
// `[ -f <cli> ] || { echo '...' >&2; exit 1; }; node <cli> check` (with `2>/dev/null` after
// the `]`, as `yokoten init` writes it).
//
// The program is yokoten itself: `yokoten`, `yokoten.ts` or `yokoten.mjs` (#408), bare or quoted, or under
// node_modules/.bin, bin/ or .yokoten/. `./fake-yokoten` is some other program. The check
// takes only --staged and --json (`check --pr` reads a pull request, not the commit). After
// it comes nothing, a `;`, or `|| exit` with no code, a code not 0, or `$?`.
const CLI = String.raw`(?:yokoten(?:\.ts|\.mjs)?|(?:\./)?(?:node_modules/\.bin/yokoten|bin/yokoten(?:\.ts|\.mjs)?|\.yokoten/(?:bin/)?yokoten(?:\.ts|\.mjs)?))`;
const PROGRAM = String.raw`(?:"${CLI}"|'${CLI}'|${CLI})`;
const RUNNER = String.raw`(?:(?:npx(?:\s+--no-install|\s+--no(?:\s+--)?)?|pnpm\s+exec|yarn|bunx)\s+)?(?:node\s+)?`;
const CHECK_TAIL = String.raw`\s+check(?:\s+--(?:staged|json))*(?<stop>\s*\|\|\s*exit(?:\s+(?:[1-9]\d*|\$\?))?)?(?:\s*;)?$`;
// Commands before the check with `&&`: they cannot end the script (no exit, exec, source).
const NOT_BEFORE = String.raw`(?!(?:exit|return|exec|eval|source|trap|kill|set|shift|break|continue|alias|unset|builtin|command|\.)(?:\s|$))`;
const BEFORE = String.raw`(?<before>(?:${NOT_BEFORE}[\w./@:=+-]+(?:\s+[\w./@:=+-]+)*\s*&&\s*)+)?`;
const CHECK_LINE = new RegExp(String.raw`^${BEFORE}(?<exec>exec\s+)?${RUNNER}${PROGRAM}${CHECK_TAIL}`);
const GUARDED_LINE = new RegExp(String.raw`^\[ -f (?<cli>${PROGRAM}) \](?: 2>/dev/null)? \|\| \{ echo '[^']*'(?: >&2)?; exit [1-9]\d*; \}; node \k<cli>${CHECK_TAIL}`);
// Shell words that open and close a block: a line inside one may never run.
const OPENERS = new Set(['if', 'while', 'until', 'for', 'case', 'select']);
const CLOSERS = new Set(['fi', 'done', 'esac']);

/**
 * This pre-commit script runs `yokoten check` and fails the commit when the check fails:
 * a line in one of the shapes above, at the top level (not inside an `if`, a loop, a group,
 * a quote, a heredoc, or after `||`, `&&` or `|` on the line before), with no `exit` or
 * `return` (but `exit 1`), `exec` or heredoc before it. A line with no `exec` and no
 * `|| exit` is the last command, or follows `set -e` (and no `set +e`). `startsStrict`:
 * the script runs with `sh -e`, as husky 9 runs `.husky/pre-commit`.
 */
export function runsCheck(script: string, startsStrict = false): boolean {
  return withBudget(
    script.length,
    () => {
      const lines = scriptLines(script);
      let depth = 0;
      let isStrict = startsStrict; // set -e: a failed command stops the script
      for (const [index, line] of lines.entries()) {
        const shape = CHECK_LINE.exec(line) ?? GUARDED_LINE.exec(line);
        if (shape && depth === 0) {
          const { before, exec, stop } = shape.groups ?? {};
          const isLast = index === lines.length - 1;
          // After `a &&`, a failed `a` skips the check: exec and set -e do not help.
          if (stop !== undefined || isLast || (before === undefined && (exec !== undefined || isStrict))) return true;
        }
        if (leaves(line)) return false;
        if (/(?:^|[;&|({]\s*)set\s+(?:\+[a-zA-Z]*e|\+o\s+errexit)/.test(line)) isStrict = false;
        else if (depth === 0 && /^set\s+(?:-[a-zA-Z]*e|-o\s+errexit)/.test(line)) isStrict = true;
        depth += blockDepth(line);
        if (depth < 0) return false;
      }
      return false;
    },
    true,
  );
}
// ends in `||`, `&&` or `|` belongs to it. Blank lines are left out.
function scriptLines(script: string): string[] {
  const lines: string[] = [];
  let goesOn = false; // the last line ends in ||, && or | (or |&), so the next one joins it
  const add = (text: string) => {
    const line = text.trim();
    if (line === '') return;
    if (goesOn) lines[lines.length - 1] += ` ${line}`;
    else lines.push(line);
    goesOn = line.endsWith('|') || line.endsWith('&&') || line.endsWith('|&');
  };
  let line = '';
  let quote = ''; // the open quote: ', " or $'
  for (let at = 0; at < script.length; at++) {
    spend(1);
    const character = script[at];
    const next = script[at + 1] ?? '';
    if (quote === "'") {
      line += character;
      if (character === "'") quote = '';
    } else if (character === '\\' && (next === '\n' || (next === '\r' && script[at + 2] === '\n')) && quote !== "$'") {
      at += next === '\r' ? 2 : 1; // the line goes on
    } else if (character === '\\') {
      line += character + next;
      at++;
    } else if (quote) {
      line += character;
      if ((quote === '"' && character === '"') || (quote === "$'" && character === "'")) quote = '';
    } else if (character === "'" || character === '"') {
      quote = character;
      line += character;
    } else if (character === '$' && next === "'") {
      quote = "$'";
      line += "$'";
      at++;
    } else if (character === '#' && /^$|[\s;&|()]$/.test(line.slice(-1))) {
      while (at + 1 < script.length && script[at + 1] !== '\n') at++;
    } else if (character === '\n') {
      add(line);
      line = '';
    } else line += character;
  }
  add(line);
  return lines;
}

// How many blocks a line opens, less those it closes: keywords that lead a command, and
// ( and { and their closers outside quotes, ${...} and $(...).
function blockDepth(line: string): number {
  let depth = 0;
  for (const words of commandWords(line)) {
    for (const word of words) {
      if (OPENERS.has(word)) depth++;
      else if (CLOSERS.has(word)) depth--;
      else if (!KEYWORDS.has(word)) break;
    }
  }
  for (const character of withoutSubstitutions(withoutQuotes(line))) {
    if (character === '(' || character === '{') depth++;
    else if (character === ')' || character === '}') depth--;
  }
  return depth;
}

// The line without its '...' and "..." strings (a " string takes \ escapes). An unclosed
// quote stays as it is. Once a quote finds no end, no later one of its kind does, so each
// kind is looked for to the end of the line at most once.
function withoutQuotes(line: string): string {
  let out = '';
  const closes = new Set(["'", '"']); // the kinds that may still close
  for (let at = 0; at < line.length; at++) {
    const character = line[at];
    const end = closes.has(character) ? closeQuote(line, at) : -1;
    if (end !== -1) at = end;
    else {
      closes.delete(character);
      out += character;
    }
  }
  return out;
}

// The index of the quote that closes the one at `at`, or -1.
function closeQuote(line: string, at: number): number {
  if (line[at] === "'") return line.indexOf("'", at + 1);
  for (let i = at + 1; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') return i;
  }
  return -1;
}

// The text without ${...} and $(...) (also $((...)) and more parens): from the opener to the
// first } or ), with the run of ) after it. An opener with no closer after it stays, and
// then no later opener of its kind has one either.
function withoutSubstitutions(text: string): string {
  let out = '';
  const closes = new Set(['}', ')']); // the closers still found further on
  for (let at = 0; at < text.length; at++) {
    const closer = text[at] !== '$' ? '' : text[at + 1] === '{' ? '}' : text[at + 1] === '(' ? ')' : '';
    const end = closes.has(closer) ? text.indexOf(closer, at + 2) : -1;
    if (end === -1) {
      closes.delete(closer);
      out += text[at];
      continue;
    }
    at = end;
    if (closer === ')') while (text[at + 1] === ')') at++;
  }
  return out;
}

// What git prints, trimmed, or null when it fails. Within one checkCommand each question
// goes to git once: a command that sets core.hooksPath many times starts git twice, not
// twice for each.
export const gitAnswers: { map: Map<string, string | null> | null } = { map: null };

export function readGit(directory: string, args: string[], env: Env): string | null {
  const key = [directory, ...args].join('\0');
  if (gitAnswers.map?.has(key)) return gitAnswers.map.get(key) ?? null;
  let answer: string | null;
  try {
    answer = execFileSync('git', args, { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    answer = null;
  }
  gitAnswers.map?.set(key, answer);
  return answer;
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
