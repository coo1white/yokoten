import { base, LAUNCHERS, skipPrefix, programName, splitString, findPrograms } from './words.ts';
import { noteWork } from '../../../message.ts';

// ---- The work budget ----
//
// Every read of one command draws on one budget: each character the reader visits, each
// word a word loop looks at. Nested constructs read text again (a shell string, an env -S
// string, a substitution), at most MAX_DEPTH times over, so a command that reads cleanly
// stays well inside it. A command that would cost more, by design or by accident, throws,
// and checkCommand refuses it: the guard never runs out of time or memory and lets it by.
const BUDGET_PER_CHARACTER = 20;
const BUDGET_BASE = 200_000;
let budget: { left: number } | null = null;

class OverBudget extends Error {}

export function spend(amount: number): void {
  // The same steps the budget draws. The linear tests read the count (#754).
  noteWork(amount);
  if (budget !== null && (budget.left -= amount) < 0) throw new OverBudget('the command costs too much to read');
}

// Runs `read` under a budget for text of `size` characters. A read inside another shares
// the outer budget, unless `fresh` (a hook file is not part of the command).
export function withBudget<T>(size: number, read: () => T, fresh = false): T {
  if (budget !== null && !fresh) return read();
  const outer = budget;
  budget = { left: BUDGET_PER_CHARACTER * size + BUDGET_BASE };
  try {
    return read();
  } finally {
    budget = outer;
  }
}

// Every shell name, including the small ones a minimal image ships (#830): ash, mksh,
// pdksh, yash, posh, oksh and rbash all run a script from a pipe.
export const isShell = (word: string) => /^(?:ba|da|z|k|c|tc|fi|pw|a|mk|pdk|ya|po|ok|rba)?sh(?:\.exe)?$/.test(base(word));
// Programs that run a later word through a shell, beside the shells. A pattern means only
// with that option: sudo and doas pass their words to a program unless given -s or -i,
// and env unless given -S. xargs, nohup, time and the like run a program, not a shell
// string, so their words are already checked where they stand.
export const RUNNERS: Record<string, RegExp | null> = {
  eval: null, ssh: null, su: null, runuser: null, watch: null, script: null, flock: null, parallel: null, tmux: null, screen: null,
  sudo: /^(-[a-zA-Z]*[si]|--shell|--login)/, doas: /^-[a-zA-Z]*s/, env: /^(-[a-zA-Z]*S|--s)/,
};

const RUNNER_OPTIONS = Object.entries(RUNNERS).flatMap(([runner, option]) => (option ? [[runner, option] as const] : []));

// Where a shell or a runner stands in the command, or -1. Anywhere counts: `find -exec sh
// -c`, `xargs sh -c` and `sudo bash -c` all run a string.
// It walks back from the end once, so each word is tested once against each option.
export function runnerAt(words: string[]): number {
  spend(words.length);
  const later = new Set<string>(); // runners whose option stands after the current word
  let at = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    const name = base(words[i]);
    if (isShell(words[i]) || (Object.hasOwn(RUNNERS, name) && (RUNNERS[name] === null || later.has(name))) || sourcesInput(words, i)) at = i;
    for (const [runner, option] of RUNNER_OPTIONS) if (option.test(words[i])) later.add(runner);
  }
  return at;
}

// `source /dev/stdin` and `. /dev/fd/3` run what comes in, as a shell does;
// `source -- /dev/stdin`, `. //dev/stdin` and `. /proc/$$/fd/0` do too.
function sourcesInput(words: string[], i: number): boolean {
  if (words[i] !== 'source' && words[i] !== '.') return false;
  const file = (words[i + 1] === '--' ? words[i + 2] : words[i + 1]) ?? '';
  return /^\/(?:dev\/(?:stdin|fd\/\d+)|proc\/[^/]+\/fd\/\d+)$/.test(file.replace(/\/{2,}/g, '/'));
}

// A command that, in the middle of a pipeline, hands on what comes in: `tee` with any files,
// `cat` with no file but `-`. The next command gets what the one before it printed.
export function passesOn(words: string[]): boolean {
  const program = findPrograms(words)[0];
  if (program === undefined) return false;
  const name = programName(program);
  if (name === 'tee') return true;
  if (name !== 'cat') return false;
  const at = words.indexOf(program, skipPrefix(words, 0));
  return at !== -1 && words.slice(at + 1).every((word) => word.startsWith('-'));
}

// `source x` and `. x`: the shell runs the file, so a `<(...)` given to it is commands.
export function isSource(words: string[]): boolean {
  const program = findPrograms(words)[0];
  return program === 'source' || program === '.';
}

// The command xargs runs, without what comes in (`xargs -0 git` gives `git`), or null when
// the command has no xargs. With no program after its options, xargs runs echo.
export function xargsCommand(words: string[]): string | null {
  spend(words.length);
  let index = words.findIndex((word) => programName(word) === 'xargs');
  if (index === -1) return null;
  for (index++; index < words.length && words[index].startsWith('-'); ) index += LAUNCHERS.xargs.options.includes(words[index]) ? 2 : 1;
  return words.slice(index).join(' ');
}

/** Whether a delimiter word is a null: a real null, or printf's `\0`, `\000` or `\x00`. */
const isNullDelimiter = (text: string) => text === '\0' || /^\\0{1,3}$/.test(text) || /^\\x00$/i.test(text);

/** Whether xargs splits its input on a null: `-0`, `--null`, `-d '\0'`, or a short cluster that holds `0` (`-r0`). */
export function xargsUsesNull(words: string[]): boolean {
  let index = words.findIndex((word) => programName(word) === 'xargs');
  if (index === -1) return false;
  for (index++; index < words.length && /^--?[^-]/.test(words[index]); ) {
    const word = words[index];
    if (word === '--null') return true;
    if (word === '--delimiter' || word.startsWith('--delimiter=')) {
      const inline = word.startsWith('--delimiter=');
      const delim = inline ? word.slice('--delimiter='.length) : (words[index + 1] ?? '');
      if (isNullDelimiter(delim)) return true;
      index += inline ? 1 : 2;
      continue;
    }
    if (word.startsWith('--')) {
      index += LAUNCHERS.xargs.options.includes(word) ? 2 : 1;
      continue;
    }
    let valued = false;
    for (let letter = 1; letter < word.length; letter++) {
      if (word[letter] === '0') return true;
      if (word[letter] === 'd') {
        const rest = word.slice(letter + 1);
        if (isNullDelimiter(rest || (words[index + 1] ?? ''))) return true;
        valued = rest === '';
        break;
      }
      // A valued short option takes the rest of the word (`-s0` is -s 0, not -0).
      if (LAUNCHERS.xargs.options.includes(`-${word[letter]}`)) {
        valued = letter === word.length - 1;
        break;
      }
    }
    index += valued || LAUNCHERS.xargs.options.includes(word) ? 2 : 1;
  }
  return false;
}

// printf leaves a null as `\0`, `\000` or `\x00`. A later shell read swallows the
// backslash (`\0` becomes `0`), so xargs -0 would not see the word in front of it.
const PRINTF_NULL = /\\(?:0{1,3}(?![0-7])|x00(?![0-9A-Fa-f]))/gi;

/** The text xargs reads, as words. `xargs -0` also splits on a null (#573). */
export function xargsInput(words: string[], text: string): string {
  const split = xargsUsesNull(words) ? text.replace(PRINTF_NULL, ' ').replace(/\0/g, ' ') : text;
  return split.replace(/\s+/g, ' ');
}


// What a command prints, as the command it pipes into reads it: for printf, its format
// filled in (see printfText); for any other, its words after the program, as echo prints
// them, with each \n a line end. Over-reading is fine: `cat x` "prints" x.
export function printedText(words: string[]): string {
  const at = skipPrefix(words, 0);
  const program = findPrograms(words)[0];
  const printfAt = program !== undefined && programName(program) === 'printf' ? words.indexOf(program, at) : -1;
  if (printfAt !== -1) return printfText(words.slice(printfAt + 1));
  return words.slice(at + 1).join(' ').replace(/\\n/g, '\n');
}

// More text than this from printf's format said again for each set of arguments, and the
// guard reads the format and the arguments as plain words instead.
const MAX_PRINTF_REPEATS = 65_536;

// What `printf [-v name] [--] format args...` prints, when the format's only conversions are
// %s and %b (and %%): the format with each conversion filled by the next argument, again
// while arguments are left, and its escapes \n \t \\ read. For any harder format, the
// arguments and the format, as words: the guard reads more than printf prints, never less.
function printfText(args: string[]): string {
  let at = 0;
  if (args[at] === '-v') at += 2;
  if (args[at] === '--') at++;
  const format = args[at] ?? '';
  const values = args.slice(at + 1);
  spend(format.length + values.length);
  const texts: string[] = ['']; // the format's text before each conversion, and after the last
  const conversions: string[] = []; // 's' or 'b'
  let isSimple = true;
  for (let position = 0; position < format.length && isSimple; position++) {
    const next = format[position + 1] ?? '';
    if (format[position] === '%' && (next === 's' || next === 'b')) {
      conversions.push(next);
      texts.push('');
      position++;
    } else if (format[position] === '%' && next === '%') {
      texts[texts.length - 1] += '%';
      position++;
    } else if (format[position] === '%') isSimple = false;
    else if (format[position] === '\\') {
      texts[texts.length - 1] += printfEscape(next);
      position++;
    } else texts[texts.length - 1] += format[position];
  }
  const repeats = conversions.length === 0 ? 1 : Math.max(1, Math.ceil(values.length / conversions.length));
  if (!isSimple || (repeats - 1) * format.length > MAX_PRINTF_REPEATS) {
    // The arguments first, so xargs takes its program's first word from them; then each on a
    // line of its own, and the format with the arguments after it, for a shell.
    const joined = values.join(' ');
    return [joined, ...values, `${format} ${joined}`].join('\n').replace(/\\n/g, '\n');
  }
  let out = '';
  let filled = 0; // how many arguments are filled in
  for (let repeat = 0; repeat < repeats; repeat++) {
    spend(texts.length);
    for (const [index, conversion] of conversions.entries()) {
      const value = values[filled++] ?? '';
      // %b reads the escapes in its argument too.
      out += texts[index] + (conversion === 'b' ? value.replace(/\\(.?)/gs, (_, letter: string) => printfEscape(letter)) : value);
    }
    out += texts[conversions.length];
  }
  return out;
}

// What printf prints for the escape \<letter>: a line end for n, a tab for t, one \ for \,
// and for any other, both characters as written.
function printfEscape(letter: string): string {
  if (letter === 'n') return '\n';
  if (letter === 't') return '\t';
  if (letter === '\\') return '\\';
  return `\\${letter}`;
}

// ssh options that take a value, in the same word (-p22) or the next (-p 22).
const SSH_VALUE_OPTIONS = 'BbcDEeFIiJLlmOoPpQRSWw';
// flock options that take a value. -c (--command) takes the shell string.
const FLOCK_VALUE_OPTIONS = 'wE';

// The text a runner at `at` hands to a shell. For most it is every word after the runner.
// ssh runs the words after its options and the host (`ssh -p 22 host 'x'`), and flock the
// string after -c (`flock f -c 'x'`) or the command after its file (`flock f x`).
export function runString(words: string[], at: number): string {
  const name = base(words[at]);
  if (name === 'ssh') return words.slice(sshCommand(words, at + 1)).join(' ');
  if (name === 'flock') return flockCommand(words, at + 1);
  if (name === 'env') return envCommand(words, at + 1) ?? words.slice(at + 1).join(' ');
  return words.slice(at + 1).join(' ');
}

// The command `env -S` runs: its split string, then the words after it
// (`env -iS'git push' x`, `env --split-string='a b'`, `env -u X -S 'a b'`).
function envCommand(words: string[], index: number): string | undefined {
  while (index < words.length && words[index].startsWith('-')) {
    const split = splitString(words, index);
    if (split !== undefined) {
      const isInline = /^--[^=]*=/.test(words[index]) || /^-[a-zA-Z]*S./s.test(words[index]);
      return [split, ...words.slice(index + (isInline ? 1 : 2))].join(' ');
    }
    index += LAUNCHERS.env.options.includes(words[index]) ? 2 : 1;
  }
  return undefined;
}

// The index of the first word after ssh's options and host.
function sshCommand(words: string[], index: number): number {
  while (index < words.length && words[index].startsWith('-') && words[index] !== '-') {
    if (words[index] === '--') return index + 2;
    const option = words[index];
    const value = [...option.slice(1)].findIndex((letter) => SSH_VALUE_OPTIONS.includes(letter));
    // A value option last in its word takes the next word: `-tp 22`.
    index += value !== -1 && value === option.length - 2 ? 2 : 1;
  }
  return index + 1;
}

// flock's command: the string after -c or --command, before or after the file, or the
// words after the file.
function flockCommand(words: string[], index: number): string {
  let file = false;
  for (; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith('--')) {
      const command = /^--command(?:=(.*))?$/s.exec(word);
      if (command) return command[1] ?? words[index + 1] ?? '';
      if (/^--(wait|timeout|conflict-exit-code)$/.test(word)) index++;
    } else if (word.startsWith('-') && word.length > 1) {
      for (let letter = 1; letter < word.length; letter++) {
        const rest = word.slice(letter + 1);
        if (word[letter] === 'c') return rest || (words[index + 1] ?? '');
        if (FLOCK_VALUE_OPTIONS.includes(word[letter])) {
          if (!rest) index++;
          break;
        }
      }
    } else if (!file) file = true;
    else return words.slice(index).join(' ');
  }
  return '';
}

/** Every command the text runs, as lists of words. Text that runs inside a command is listed too. */
