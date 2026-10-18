// How yokoten is called. Hooks, the git hook and CI name the entry point by path, and
// setup and doctor need to recognise a command that runs it.

/** A command that runs yokoten's `<sub>`, by whatever path. */
export const runs = (sub: string): RegExp => new RegExp(`yokoten\\.ts"?\\s+${sub}\\b`);

/** The yokoten subcommand a command runs, if any. */
export const subcommand = (command: string): string | undefined => command.match(/yokoten\.ts"?\s+(\S+)/)?.[1];

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
    usage: '[dir] [--github --yes [--remove-default-labels]]',
    text: [
      'Adds the practices to the project at [dir] (default: here). It keeps any file that is',
      'already there and says so. It also reads GitHub through gh and says which standard',
      'labels and milestone it would add. It changes GitHub only with --github --yes.',
    ],
    options: [
      { name: '--github', text: 'work on GitHub too; goes with --yes' },
      { name: '--yes', text: 'add the standard labels and a first milestone on GitHub' },
      { name: '--remove-default-labels', text: "also delete GitHub's default labels outside the set" },
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
    usage: '[--session] [--json]',
    text: ['Shows every stage and step of the road, and what this machine is missing.', 'It exits 1 while steps are left, and always 0 with --session.'],
    options: [
      { name: '--session', text: 'only the next step, for the start of a session' },
      { name: '--json', text: 'the report as JSON on stdout' },
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
    usage: '[--staged | --history | --pr | --issue] [--json]',
    text: ['Checks the whole tree by default. Use one mode at most.'],
    options: [
      { name: '--staged', text: 'the next commit, as the git hook runs it' },
      { name: '--history', text: 'the privacy check over every commit; run it before going public' },
      { name: '--pr', text: 'in CI: the title, tier, sections, issue and change file of the pull request' },
      { name: '--issue', text: 'in CI: the issue title, `area: summary` in 60 characters at most' },
      { name: '--json', text: 'the findings as JSON on stdout' },
    ],
    example: 'yokoten check --staged',
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
    usage: '<issue> [--write] | --ship <id>',
    text: [
      'Reads an incident issue (a number or a URL) through gh and drafts a check from it,',
      'for a person to review. It writes nothing without --write. In yokoten, --ship moves a',
      'reviewed lesson into kit/lessons/, where doctor runs it in every project.',
    ],
    options: [
      { name: '--write', text: 'put the draft in lessons/ (adds only, never overwrites)' },
      { name: '--ship', text: 'move a reviewed lesson into kit/lessons/; refused while a TODO is left' },
    ],
    argument: 'issue',
    example: 'yokoten learn 138',
  },
  {
    name: 'hook',
    summary: 'the tool-call guard, or the stop check with --stop',
    usage: '[--agent <name>] [--commands-only] [--stop] [--json]',
    text: ['Reads one tool call on stdin. It exits 2, with the reason on stderr, when it blocks the call.'],
    options: [
      { name: '--agent', value: 'name', text: 'the runtime that sends the call: claude-code (the default), codex or gemini' },
      { name: '--commands-only', text: 'judge commands only, and leave files to the project' },
      { name: '--stop', text: 'read a Claude Code Stop event, and check the changed files' },
      { name: '--json', text: 'the result as JSON on stdout' },
    ],
    example: `echo '{"tool_input":{"command":"git status"}}' | yokoten hook`,
  },
  {
    name: 'explain',
    summary: 'a rule or a step: what it is, why, and how it is checked',
    usage: '[<id>] [--json]',
    text: ['Explains one rule or one step of the road. With no id, it lists the ids.'],
    options: [{ name: '--json', text: 'the explanation as JSON on stdout' }],
    argument: 'id',
    example: 'yokoten explain release',
  },
  {
    name: 'bot',
    summary: 'run one command as the bot (gh, git push); the token is never printed',
    usage: '-- <command>',
    text: [
      'Runs the command after -- as the bot, with a one-hour token. It checks an issue or',
      'pull request title first, and sends nothing when the title is wrong. Everything',
      'after -- is passed on unchanged, --help too.',
    ],
    options: [],
    example: 'yokoten bot -- gh pr create --fill',
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
