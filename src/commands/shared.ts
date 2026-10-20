// What every command uses: the command line, the parser, the repo root, and the output.
// Everything yokoten prints goes through `print`, `say` or `printJson` (core rule 11).

import { appendFileSync, existsSync } from 'node:fs';
import { annotations, isGitHubActions, stepSummary } from '../host/github.ts';
import { finding, type Finding, formatFinding, notRepoFinding } from '../rules/message.ts';
import { hideHome, withHome } from '../rules/privacy.ts';
import { gitRoot } from '../run/check.ts';
import { closestWord, findCommand, HELP_OPTIONS } from '../run/cli.ts';

export const [cmd, ...args] = process.argv.slice(2);
// The one place HOME falls back to the system's home (#356): every module below reads it from env.
export const env = withHome(process.env);

/** The command line, read strictly: an unknown option is refused, never ignored. */
export interface Parsed {
  flags: Set<string>;
  values: Record<string, string>;
  positional: string[];
}
/** Reads the words by the options and argument the command's help lists, nothing else. */
export function parse(name: string, words: string[] = args): Parsed | string {
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
  const allowed = command.arguments?.length ?? (command.argument ? 1 : 0);
  if (parsed.positional.length > allowed) return `unexpected argument ${parsed.positional[allowed]}`;
  return parsed;
}

/**
 * --json among the command's own words, for a command that takes it (#280). It is read
 * before the parser, so a usage error and a crash are JSON too. For `bot`, the words after
 * `--` belong to the command it runs.
 */
const isJsonAsked = ((): boolean => {
  const command = cmd === undefined ? undefined : findCommand(cmd);
  if (!command?.options.some((option) => option.name === '--json')) return false;
  const end = args.indexOf('--');
  return (end === -1 ? args : args.slice(0, end)).includes('--json');
})();

/** With --json, an error as data on stdout too: `{ command, ok: false, error }`, one line. */
export function printJsonError(error: string): void {
  if (isJsonAsked) printJson({ command: cmd, ok: false, error });
}

/** A usage error: said on stderr, exit 1, as for an unknown command. With --json, also on stdout. */
export function usage(error: string): number {
  printJsonError(error);
  print([`yokoten ${cmd}: ${error}${/[.?]$/.test(error) ? '' : '.'} Run \`yokoten ${cmd} --help\`.`], process.stderr);
  return 1;
}

// Set when a git call failed because git itself was not found, not because of the folder.
let isGitMissing = false;

export const rootOf = (dir: string): string | null => {
  try {
    return gitRoot(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(dir)) isGitMissing = true;
    return null;
  }
};

/** Why there is no repo root: git is missing, or the folder is not in a repo. Call it after rootOf. */
export const noRootFinding = (dir: string): Finding =>
  isGitMissing ? finding('not-a-repo', 'git is not installed (or not on PATH); yokoten needs git', 'install git, or add it to PATH') : notRepoFinding(dir);

/**
 * The repo root, or null after one plain finding on stderr (#205): a command that needs a
 * repo calls this before it writes anything. With --json, `json` shapes the output.
 */
export function requireRoot(dir: string, json?: (missing: Finding) => unknown): string | null {
  const root = rootOf(dir);
  if (root) return root;
  const missing = noRootFinding(dir);
  if (json) printJson(json(missing));
  else print([`yokoten ${cmd}: ${formatFinding(missing)}`], process.stderr);
  return null;
}

// Everything yokoten prints goes through here or `say`, never straight to a stream: the
// output lands in transcripts and CI logs, so the home folder is shown as ~ (core rule 11).
export function print(lines: string[], stream: NodeJS.WritableStream = process.stdout): void {
  if (lines.length) say(`${lines.join('\n')}\n`, stream);
}
export function say(text: string, stream: NodeJS.WritableStream): void {
  stream.write(hideHome(text, env));
}

// --json: stdout holds the JSON and nothing else. The home folder is hidden in every
// string before it is encoded, as in the text form.
export function printJson(data: unknown): void {
  const hide = (v: unknown): unknown =>
    typeof v === 'string' ? hideHome(v, env) : Array.isArray(v) ? v.map(hide) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x)])) : v;
  process.stdout.write(`${JSON.stringify(hide(data), null, 2)}\n`);
}

export const bullets = (findings: Finding[]) => findings.map((f) => `- ${formatFinding(f)}`);

/**
 * In a GitHub Actions job, the findings of a check also go on the pull request page
 * (#91): annotations on stdout, and a job summary. Outside Actions, nothing. With
 * --json, stdout holds only the JSON, so there are no annotations; the summary is a file.
 * A summary that can't be written is said on stderr; it never changes the result.
 */
export function showOnPullRequest(name: string, problems: Finding[], notes: Finding[], { json, isPlaceAFile }: { json: boolean; isPlaceAFile: boolean }): void {
  if (!isGitHubActions(env)) return;
  if (!json) print(annotations(problems, notes, isPlaceAFile));
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, hideHome(stepSummary(name, problems, notes), env));
  } catch (err) {
    say(`${name}: the job summary was not written: ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, process.stderr);
  }
}
