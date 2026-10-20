// How yokoten is called. Hooks, the git hook and CI name the entry point by path, and
// setup and doctor need to recognise a command that runs it.

// A package runner that starts the published yokoten at the start of a line or a command:
// npx, npx --yes, bunx, pnpm dlx, npm exec. "yokoten-check" or "echo npx yokoten" is not one.
const PACKAGE_RUN = String.raw`^[ \t]*(?:npx|bunx|pnpm[ \t]+dlx|npm[ \t]+exec)(?:[ \t]+-\S+)*[ \t]+yokoten(?:@[\w.^~-]+)?`;

/** A command that runs yokoten's `<sub>`, by whatever path, or by a package runner (#298). */
export const runs = (sub: string): RegExp => new RegExp(`(?:yokoten\\.ts"?|${PACKAGE_RUN})\\s+${sub}\\b`, 'm');

/** The yokoten subcommand a command runs, if any. The word ends at a `;`, as in a tool-call guard (#260). */
export const subcommand = (command: string): string | undefined => command.match(/yokoten\.ts"?\s+(\w[\w-]*)/)?.[1];

/**
 * A hook command that runs `node <path> <args>`, with `path` quoted for the shell. When the
 * file is gone, it says `missing` in one line, never a Node stack trace with the full path
 * (#204). It exits 1: the agents report that and go on, so a missing copy never blocks
 * every tool call. At session start the line goes to stdout with exit 0, where the agent
 * reads it, as plain text or, for Gemini CLI, as JSON (`sessionOutput`). The test's own
 * error goes to /dev/null, so a broken path never prints the full path.
 * `missing` has no quote or backslash, so it fits in the echo and the JSON as it is. It
 * never names the file followed by a word, or `subcommand` would read that word.
 * A tool-call guard (`isToolCall`) fails closed: see `refuseOnFailure`.
 */
export function guardCommand(
  path: string,
  args: string,
  missing: string,
  {
    isSessionStart = false,
    sessionOutput = 'text',
    isToolCall = false,
  }: { isSessionStart?: boolean; sessionOutput?: 'text' | 'json'; isToolCall?: boolean } = {},
): string {
  if (/['"\\]/.test(missing)) throw new Error(`a missing-runtime line has a quote or a backslash: ${missing}`);
  const line = sessionOutput === 'json' ? `{"hookSpecificOutput":{"additionalContext":"${missing}"}}` : missing;
  const say = isSessionStart ? `echo '${line}'; exit 0` : `echo '${missing}' >&2; exit 1`;
  const check = `[ -f ${path} ] 2>/dev/null || { ${say}; }; `;
  return check + (isToolCall ? refuseOnFailure(path, args) : `node ${path} ${args}`);
}

/**
 * Caps the tool-call guard's heap at 256 MB. A read that runs away aborts in a second or
 * two and is refused, instead of swapping until the agent's hook timeout lets the call
 * through (#260). One tool call is at most a few MB of JSON, so this leaves a wide margin.
 */
export const GUARD_HEAP = '--max-old-space-size=256';

/** What a tool-call guard says when node is not on the agent's PATH. It lets the call go on, as a missing runtime does. */
export const MISSING_NODE = 'yokoten: the guard cannot run, because node is not on PATH for this agent; run yokoten doctor in a terminal';

/**
 * `node <path> <args>`, a tool-call guard, failing closed (#260). The agents block a call
 * on exit 2 only, and run it on any other failure, so a guard that crashes, runs out of
 * memory or is killed would let the call through. Here 0 and 2 pass as they are, stdout
 * and stderr both, and anything else, a signal (128 + its number) included, becomes 2
 * with one line on stderr and nothing more: node's own stderr, a heap trace, is dropped.
 * - No node on PATH is one line and exit 1, as a missing runtime is: refusing every call
 *   would refuse the `yokoten doctor` that explains it.
 * - node's stderr goes to a variable, with an `x` after it so a trailing newline stays;
 *   its stdout goes straight to the hook's own, through fd 3.
 * - The subshell's stderr is /dev/null, so the shell's job line for a killed node
 *   ("Killed", or bash's line with the whole command and its paths) never shows.
 * The plugin's PreToolUse hook in .claude-plugin/plugin.json is this text; a test holds them equal.
 */
export const refuseOnFailure = (path: string, args: string): string =>
  `command -v node >/dev/null 2>&1 || { echo '${MISSING_NODE}' >&2; exit 1; }; ` +
  `{ err=$( ( node ${GUARD_HEAP} ${path} ${args} 2>&1 1>&3 3>&-; c=$?; printf x; exit $c ) 2>/dev/null ); code=$?; } 3>&1; ` +
  'case $code in 0|2) printf %s "${err%x}" >&2;; ' +
  '*) echo "yokoten\'s guard failed (exit $code), so the command is refused; run \\`yokoten doctor\\`" >&2; code=2;; esac; exit $code';

/**
 * The line that runs the commit check from a project's own pre-commit, by `cli`'s path.
 * Without the runtime, one plain line and exit 1, as in the kit's pre-commit (#204).
 * `init` writes it, and its advice and `doctor`'s show the same line.
 */
export const commitCheckLine = (cli: string): string =>
  `[ -f "${cli}" ] 2>/dev/null || { echo 'yokoten: the commit check cannot run, because ${cli} is missing. Restore it from git, or run yokoten init again' >&2; exit 1; }; node "${cli}" check --staged || exit 1`;

/** The line a project's hook says when its runtime folder (`.yokoten/`, or `bin/` in yokoten's own repo) is gone. */
export const missingProjectRuntime = (cli: string): string =>
  `yokoten: the hook cannot run, because ${cli.split('/')[0]}/ is missing. Restore it from git, or run yokoten init again`;

/** One option a command takes: `value` names the word that follows it, if any. */
export interface CommandOption {
  name: string;
  value?: string;
  text: string;
}

/**
 * One command: what `yokoten <name> --help` prints, and what its parser accepts. The
 * parser reads `options` and `argument` from here, so the help and the parser can't
 * drift apart (#207).
 */
export interface Command {
  name: string;
  /** One line, for the command list. */
  summary: string;
  /** The words after `yokoten <name>`, as the usage line shows them. */
  usage: string;
  text: string[];
  options: CommandOption[];
  /** The one positional argument it takes, if any. */
  argument?: string;
  example: string;
}

/** Every command takes these, and prints its help. */
export const HELP_OPTIONS = ['--help', '-h'];

export const COMMANDS: Command[] = [
  {
    name: 'install',
    summary: 'skills, agents and user-level hooks for this machine',
    usage: '',
    text: [
      'Installs the skills into ~/.claude/skills and ~/.agents/skills, the agents into',
      '~/.claude/agents, a SessionStart doctor hook, a user-level command guard, and an',
      'empty private-marks file. Files you wrote yourself are left alone.',
    ],
    options: [],
    example: 'yokoten install',
  },
  {
    name: 'init',
    summary: 'put the practices into a project (adds only, never overwrites)',
    usage: '[dir] [--no-ci] [--github --yes [--remove-default-labels] [--board]]',
    text: [
      'Adds the practices to the project at [dir] (default: here). It keeps any file that is',
      'already there and says so. It also reads GitHub through gh and says which standard',
      'labels and milestone it would add. It changes GitHub only with --github --yes.',
      'With "notNow" ci in yokoten.json, it writes no workflow and no Dependabot config.',
    ],
    options: [
      { name: '--no-ci', text: 'keep CI off: no workflows or Dependabot, and "notNow" ci in yokoten.json' },
      { name: '--github', text: 'work on GitHub too; goes with --yes' },
      { name: '--yes', text: 'add the standard labels, a first milestone and up to 8 area labels on GitHub' },
      { name: '--remove-default-labels', text: "also delete GitHub's default labels outside the set" },
      { name: '--board', text: "also make a board linked to the repo (needs the gh token's project scope)" },
    ],
    argument: 'dir',
    example: 'yokoten init --github --yes',
  },
  {
    name: 'update',
    summary: "the core rules in a project's AGENTS.md: preview, or replace with --write",
    usage: '[dir] [--write]',
    text: [
      "Shows what this yokoten changes in the core rules of the project's AGENTS.md.",
      'With --write it replaces them and keeps the "This project" part as it is.',
    ],
    options: [{ name: '--write', text: 'replace the core rules in AGENTS.md' }],
    argument: 'dir',
    example: 'yokoten update --write',
  },
  {
    name: 'doctor',
    summary: 'the road: where this project is and its next step',
    usage: '[--session] [--json] [--agent <name>]',
    text: ['Shows every stage and step of the road, and what this machine is missing.', 'It exits 1 on a problem: a failed self-test, or a core-rules, tree or machine line', 'marked MISSING. Steps left on the road are to do, not problems. Always 0 with --session.'],
    options: [
      { name: '--session', text: 'only the next step, for the start of a session' },
      { name: '--json', text: 'the report as JSON on stdout' },
      { name: '--agent', value: 'name', text: 'with --session: claude-code (the default), codex, or gemini for Gemini CLI JSON' },
    ],
    example: 'yokoten doctor --session',
  },
  {
    name: 'adopt',
    summary: 'a draft of the adoption table for an old project',
    usage: '[--json]',
    text: ['Drafts the adoption table: what the project does today, and as-is, lighter or not now', 'for each step. You decide every row. It writes no file.'],
    options: [{ name: '--json', text: 'the rows as JSON on stdout' }],
    example: 'yokoten adopt',
  },
  {
    name: 'check',
    summary: 'layout, privacy and lead-only files; the pull request or issue in CI',
    usage: '[--staged | --history | --pr [number] | --issue] [--json]',
    text: ['Checks the whole tree by default. Use one mode at most.', '--pr with a number reads that pull request through gh, so you can run it without CI.'],
    options: [
      { name: '--staged', text: 'the next commit, as the git hook runs it' },
      { name: '--history', text: 'the privacy check over every commit; run it before going public' },
      { name: '--pr', text: 'the title, tier, sections, issue and change file of the pull request: in CI, or by its number' },
      { name: '--issue', text: 'in CI: the issue title, `area: summary` in 60 characters at most' },
      { name: '--json', text: 'the findings as JSON on stdout' },
    ],
    argument: 'number',
    example: 'yokoten check --staged',
  },
  {
    name: 'redact',
    summary: 'command output with your name, emails, logins and private hosts hidden',
    usage: '',
    text: [
      'Reads text on stdin and writes it to stdout with placeholders: <secret>, <owner>,',
      '<email>, <host> and <mark>. It hides secrets, your private marks, private email',
      'addresses, git user.name and private remote hosts. If it fails, the text passes as it is.',
    ],
    options: [],
    example: 'git log -1 2>&1 | yokoten redact',
  },
  {
    name: 'changelog',
    summary: 'the entries the files in changes/ add under [Unreleased]',
    usage: '[--write]',
    text: ['Shows the entries the files in changes/ add under [Unreleased] in CHANGELOG.md.'],
    options: [{ name: '--write', text: 'put them into CHANGELOG.md and delete the files (before a release)' }],
    example: 'yokoten changelog',
  },
  {
    name: 'learn',
    summary: 'a check draft from an incident issue, for a person to review',
    usage: '<issue> [--write] | --ship <id> | --upstream "<what happened>" [--area <name>] [--fix <idea>] | --upstream --list | --upstream --done <id>',
    text: [
      'Reads an incident issue (a number or a URL) through gh and drafts a check from it,',
      'for a person to review. It writes nothing without --write. In yokoten, --ship moves a',
      'reviewed lesson into kit/lessons/, where doctor runs it in every project.',
      '--upstream keeps a note about a gap in yokoten itself, found in any project, in',
      '~/.config/yokoten/upstream/, outside every repo. The project name, its path, your',
      'home folder and your name are hidden first; a note with a known secret shape is refused.',
    ],
    options: [
      { name: '--write', text: 'put the draft in lessons/ (adds only, never overwrites)' },
      { name: '--ship', text: 'move a reviewed lesson into kit/lessons/; refused while a TODO is left' },
      { name: '--upstream', text: 'a note for the yokoten repo: what happened, in a few words' },
      { name: '--area', value: 'name', text: 'with --upstream: the part of yokoten it is about, such as hook or doctor' },
      { name: '--fix', value: 'idea', text: 'with --upstream: how it could be fixed' },
      { name: '--list', text: 'with --upstream: the notes that wait' },
      { name: '--done', text: 'with --upstream: remove a note, once its issue is open' },
    ],
    argument: 'issue',
    example: 'yokoten learn 138',
  },
  {
    name: 'hook',
    summary: 'the tool-call guard, or the stop check with --stop',
    usage: '[--agent <name>] [--commands-only] [--stop] [--json]',
    text: ['Reads one tool call on stdin. It exits 2, with the reason on stderr, when it blocks the call.', 'With --agent antigravity, it says deny on stdout and exits 0, as Antigravity CLI asks.'],
    options: [
      { name: '--agent', value: 'name', text: 'the runtime that sends the call: claude-code (the default), codex, gemini, antigravity, muse or deepseek-harness' },
      { name: '--commands-only', text: 'judge commands only, and leave files to the project' },
      { name: '--stop', text: 'read the end-of-turn event (Claude Code, Codex or Muse Code Stop, Gemini AfterAgent) and check the changed files' },
      { name: '--json', text: 'the result as JSON on stdout' },
    ],
    example: `echo '{"tool_input":{"command":"git status"}}' | yokoten hook`,
  },
  {
    name: 'explain',
    summary: 'a rule or a step: what it is, why, and how it is checked',
    usage: '[<id>] [--json]',
    text: ['Explains one rule or one step of the road. With no id, it lists the ids.'],
    options: [{ name: '--json', text: 'the explanation, or the ids, as JSON on stdout' }],
    argument: 'id',
    example: 'yokoten explain release',
  },
  {
    name: 'bot',
    summary: 'run one command as the bot (gh, git push); the token is never printed',
    usage: '-- <command>',
    text: [
      'Runs the command after -- as the bot, with a one-hour token. It runs gh and git',
      'only. It checks an issue or pull request title first, and sends nothing when the',
      'title is wrong. Everything after -- is passed on unchanged, --help too.',
    ],
    options: [],
    example: 'yokoten bot -- gh pr create --fill',
  },
  {
    name: 'uninstall',
    summary: 'take back what install wrote, for example to use the plugin instead',
    usage: '',
    text: [
      'Removes the skills and agents that install wrote (only files marked as managed by',
      'yokoten), its two hooks in ~/.claude/settings.json, and ~/.local/share/yokoten.',
      'Your own files, your other settings and ~/.config/yokoten (keys, private marks) stay.',
    ],
    options: [],
    example: 'yokoten uninstall',
  },
  {
    name: 'help',
    summary: 'this list, or the help of one command',
    usage: '[<command>]',
    text: ['Prints the command list, or the usage, options and an example of one command.'],
    options: [],
    argument: 'command',
    example: 'yokoten help check',
  },
  {
    name: 'version',
    summary: 'the version of this yokoten',
    usage: '',
    text: ['Prints the version. `yokoten --version` and `yokoten -v` do the same.'],
    options: [],
    example: 'yokoten version',
  },
];

/** The command with this name, if there is one. */
export const findCommand = (name: string): Command | undefined => COMMANDS.find((command) => command.name === name);

/** The option as its help shows it: `--agent <name>`. */
const optionLabel = (option: CommandOption): string => (option.value ? `${option.name} <${option.value}>` : option.name);

/** What `yokoten <name> --help` prints. */
export function commandHelp(command: Command): string[] {
  const rows: [string, string][] = [...command.options.map((option): [string, string] => [optionLabel(option), option.text]), [HELP_OPTIONS.join(', '), 'this help']];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return [
    `Usage: yokoten ${command.name}${command.usage ? ` ${command.usage}` : ''}`,
    '',
    ...command.text,
    '',
    'Options:',
    ...rows.map(([label, text]) => `  ${label.padEnd(width)}${text}`),
    '',
    'Example:',
    `  ${command.example}`,
  ];
}

/** The command list, for `yokoten help`. */
export function commandList(): string[] {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  return COMMANDS.map((command) => `  ${command.name.padEnd(width)}${command.summary}`);
}

/** How many single-letter edits turn one word into the other (Levenshtein). */
export function editDistance(from: string, to: string): number {
  let previous = Array.from({ length: to.length + 1 }, (_, i) => i);
  for (let i = 1; i <= from.length; i++) {
    const current = [i];
    for (let j = 1; j <= to.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (from[i - 1] === to[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[to.length];
}

/** The known word closest to a typo, when two edits or fewer turn one into the other. */
export function closestWord(word: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of known) {
    const distance = editDistance(word, candidate);
    if (distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best;
}
