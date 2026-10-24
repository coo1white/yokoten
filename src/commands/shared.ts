// What every command uses: the command line, the parser, the repo root, and the output.
// Everything yokoten prints goes through `print`, `say` or `printJson` (core rule 11).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { annotations, isGitHubActions, stepSummary } from '../host/github/index.ts';
import type { Env } from '../rules/config.ts';
import { finding, type Finding, formatFinding, notRepoFinding } from '../rules/message.ts';
import { hideHome } from '../rules/privacy.ts';
import { gitRoot } from '../run/check.ts';
import { closestWord, findCommand, HELP_OPTIONS } from '../run/cli.ts';

/** A stream a command writes to: the process's own, or a test's stand-in. A real stream has its `fd`. */
export type Output = NodeJS.WritableStream & { isTTY?: boolean; fd?: number };

/**
 * A command's standard input (#475): `fd` 0 for the process, `text` for a test. `stream` is
 * the same input as a stream, for a command that reads it as it comes (redact) or asks
 * whether it is a terminal. The process's stream is made only when a command reads it:
 * making it puts a pipe in non-blocking mode, and costs a guard call time (#408).
 */
export interface Input {
  fd: number | null;
  text: string | null;
  readonly stream: NodeJS.ReadableStream & { isTTY?: boolean };
}

/** All of stdin as text: the test's, or the process's read to its end. */
export const readInput = ({ fd, text }: Input): string => text ?? (fd === null ? '' : readFileSync(fd, 'utf8'));

/**
 * One run of one command, as plain data (#475). bin/main.ts makes it from the process once;
 * a test makes its own. Below bin/main.ts, nothing reads process.argv, process.env,
 * process.cwd() or the process's streams: a command reads them from here. It holds values only,
 * never a method or a cache, so it cannot grow into a bag every module reaches into. The one
 * exception is `stdin.stream`, a getter, so the process's stdin is made only when read: never
 * spread or copy `stdin`, or the hook makes it and fd 0 turns non-blocking (see Input).
 */
export interface Invocation {
  /** The first word after `yokoten`, or undefined when there is none. */
  command: string | undefined;
  /** The words after the command. */
  args: string[];
  /** HOME is set when the system has one (#356): every module below reads it from here. */
  env: Env;
  cwd: string;
  stdout: Output;
  stderr: Output;
  stdin: Input;
  /** The path of the yokoten entry that runs, for a command that runs yokoten again (the redact wrapper). */
  script: string;
}

/** The command line, read strictly: an unknown option is refused, never ignored. */
export interface Parsed {
  flags: Set<string>;
  values: Record<string, string>;
  positional: string[];
}
/** Reads the words by the options and argument the command's help lists, nothing else. */
export function parse(name: string, words: string[]): Parsed | string {
  const command = findCommand(name);
  if (!command) throw new Error(`no help entry for ${name}`);
  const known = new Map(command.options.map((option) => [option.name, option]));
  const parsed: Parsed = { flags: new Set(), values: {}, positional: [] };
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    const option = known.get(a);
    if (option?.value) {
      const value = words[++i];
      if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
      parsed.values[a] = value;
    } else if (option) parsed.flags.add(a);
    else if (a.startsWith('-')) {
      const near = closestWord(a, [...known.keys(), HELP_OPTIONS[0]]);
      return `unknown option ${a}${near ? `. Did you mean ${near}?` : ''}`;
    } else parsed.positional.push(a);
  }
  const allowed = command.many ? Infinity : command.arguments?.length ?? (command.argument ? 1 : 0);
  if (parsed.positional.length > allowed) return `unexpected argument ${parsed.positional[allowed]}`;
  return parsed;
}

/**
 * --json among the command's own words, for a command that takes it (#280). It is read
 * before the parser, so a usage error and a crash are JSON too. For `bot`, the words after
 * `--` belong to the command it runs.
 */
function isJsonAsked({ command: name, args }: Invocation): boolean {
  const command = name === undefined ? undefined : findCommand(name);
  if (!command?.options.some((option) => option.name === '--json')) return false;
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).includes('--json');
}

/** With --json, an error as data on stdout too: `{ command, ok: false, error }`, one line. */
export function printJsonError(invocation: Invocation, error: string): void {
  if (isJsonAsked(invocation)) printJson(invocation, { command: invocation.command, ok: false, error });
}

/** A usage error: said on stderr, exit 1, as for an unknown command. With --json, also on stdout. */
export function usage(invocation: Invocation, error: string): number {
  const { command } = invocation;
  printJsonError(invocation, error);
  print(invocation, [`yokoten ${command}: ${error}${/[.?]$/.test(error) ? '' : '.'} Run \`yokoten ${command} --help\`.`], invocation.stderr);
  return 1;
}

// A git call that fails because git itself was not found, not because of the folder.
const isGitMissingError = (err: unknown, dir: string): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(dir);

export const rootOf = (dir: string, env: Env): string | null => {
  try {
    return gitRoot(dir, env);
  } catch {
    return null;
  }
};

/**
 * Why there is no repo root: git is missing, or the folder is not in a repo. Call it after
 * rootOf. It asks git once more, so no state is kept from one command to the next.
 */
export function noRootFinding(dir: string, env: Env): Finding {
  let isGitMissing = false;
  try {
    gitRoot(dir, env);
  } catch (err) {
    isGitMissing = isGitMissingError(err, dir);
  }
  return isGitMissing ? finding('not-a-repo', 'git is not installed (or not on PATH); yokoten needs git', 'install git, or add it to PATH') : notRepoFinding(dir);
}

/**
 * The repo root, or null after one plain finding on stderr (#205): a command that needs a
 * repo calls this before it writes anything. With --json, `json` shapes the output.
 */
export function requireRoot(invocation: Invocation, dir: string, json?: (missing: Finding) => unknown): string | null {
  const root = rootOf(dir, invocation.env);
  if (root) return root;
  const missing = noRootFinding(dir, invocation.env);
  if (json) printJson(invocation, json(missing));
  else print(invocation, [`yokoten ${invocation.command}: ${formatFinding(missing)}`], invocation.stderr);
  return null;
}

// A person's terminal output (#707): colour and a shape that reads at a glance, like
// `node -h`. An agent reads plain text, so a hook answer, a log and a file never get a
// code. Colour is for a terminal only, and `NO_COLOR` turns it off (no-color.org).
const BOLD = '1';
const GREEN = '32';
const YELLOW = '33';
const RED = '31';
const CYAN = '36';

/** `text` in a colour code, or as it is when colour is off. */
export const paint = (text: string, code: string, isColour: boolean): string => (isColour ? `\u001b[${code}m${text}\u001b[0m` : text);

/**
 * Whether a stream gets colour: a terminal, and `NO_COLOR` is not set. `TERM=dumb` is a
 * terminal that can't show it either.
 */
export const isColourTerminal = (env: Env, stream: { isTTY?: boolean }): boolean => stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== 'dumb';

// A mark at the start of a line, padded to the column the next word starts in.
const MARK = /^(\s*)(ok|done|MISSING|note|next|to do|not now|can't check)(\s+)(.*)$/;
const HEADING = /^(?:yokoten \d|yokoten stopped this:|the road:|project:|machine:|unsaved work|server \(|Usage:|Start:|Exit codes:)/;
const STAGE = /^\s+\d+\. \S/;
const COMMAND = /`[^`\n]+`/g;

/**
 * One line of a person's output: a mark in its colour, a heading in bold, a refusal in
 * red, a command in cyan. Everything else stays as it is. The columns do not move: the
 * code goes around the mark, not in place of its padding.
 */
export function styleLine(line: string, isColour: boolean): string {
  if (!isColour) return line;
  const mark = MARK.exec(line);
  // The style of the whole line, when one covers it. A command's reset would end that
  // style for the rest of the line, so it is opened again after each command (#707).
  let outer: string | undefined;
  let styled = line;
  if (line.startsWith('yokoten stopped this: ')) {
    outer = `${BOLD};${RED}`;
  } else if (mark) {
    const colour = mark[2] === 'ok' || mark[2] === 'done' ? GREEN : mark[2] === 'MISSING' ? RED : YELLOW;
    styled = `${mark[1] ?? ''}${paint(mark[2] ?? '', colour, true)}${mark[3] ?? ''}${mark[4] ?? ''}`;
  } else if (HEADING.test(line) || STAGE.test(line)) {
    outer = BOLD;
  }
  const painted = styled.replace(COMMAND, (command, offset: number) =>
    `${paint(command, CYAN, true)}${outer !== undefined && offset + command.length < styled.length ? `\u001b[${outer}m` : ''}`,
  );
  return outer === undefined ? painted : paint(painted, outer, true);
}

/** A whole text, line by line. */
export const styleText = (text: string, isColour: boolean): string => (isColour ? text.split('\n').map((line) => styleLine(line, true)).join('\n') : text);

/**
 * Whether a command may colour its text on this stream (#707): a terminal, no `NO_COLOR`,
 * and never the hook, whose answer an agent reads.
 */
export const canColour = (invocation: Invocation, stream: Output): boolean => invocation.command !== 'hook' && isColourTerminal(invocation.env, stream);

// Everything yokoten prints goes through here or `say`, never straight to a stream: the
// output lands in transcripts and CI logs, so the home folder is shown as ~ (core rule 11).
// Colour is added here only, and only on a terminal, so an agent or a file never sees it.
export function print(invocation: Invocation, lines: string[], stream: Output = invocation.stdout): void {
  if (!lines.length) return;
  const text = lines.join('\n');
  say(invocation, `${canColour(invocation, stream) ? styleText(text, true) : text}\n`, stream);
}
export function say(invocation: Invocation, text: string, stream: Output): void {
  stream.write(hideHome(text, invocation.env));
}

// --json: stdout holds the JSON and nothing else. The home folder is hidden in every
// string before it is encoded, as in the text form.
export function printJson(invocation: Invocation, data: unknown): void {
  const hide = (v: unknown): unknown =>
    typeof v === 'string' ? hideHome(v, invocation.env) : Array.isArray(v) ? v.map(hide) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x)])) : v;
  invocation.stdout.write(`${JSON.stringify(hide(data), null, 2)}\n`);
}

export const bullets = (findings: Finding[]) => findings.map((f) => `- ${formatFinding(f)}`);

/**
 * In a GitHub Actions job, the findings of a check also go on the pull request page
 * (#91): annotations on stdout, and a job summary. Outside Actions, nothing. With
 * --json, stdout holds only the JSON, so there are no annotations; the summary is a file.
 * A summary that can't be written is said on stderr; it never changes the result.
 */
export function showOnPullRequest(invocation: Invocation, name: string, problems: Finding[], notes: Finding[], { json, isPlaceAFile }: { json: boolean; isPlaceAFile: boolean }): void {
  const { env } = invocation;
  if (!isGitHubActions(env)) return;
  if (!json) print(invocation, annotations(problems, notes, isPlaceAFile));
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, hideHome(stepSummary(name, problems, notes), env));
  } catch (err) {
    say(invocation, `${name}: the job summary was not written: ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, invocation.stderr);
  }
}
