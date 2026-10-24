// How yokoten is called. Hooks, the git hook and CI name the entry point by path, and
// setup and doctor need to recognise a command that runs it.

// A package runner that starts the published yokoten at the start of a line or a command:
// npx, npx --yes, bunx, pnpm dlx, npm exec. "yokoten-check" or "echo npx yokoten" is not one.
// The flags are read one word at a time, so a long line takes linear time and never throws
// (#431): a regex that repeats a group over the whole line ran out of stack.
const RUNNER_HEAD = /^[ \t]*(?:npx|bunx|pnpm[ \t]+dlx|npm[ \t]+exec)/gm;
const RUNNER_FLAG = /[ \t]+-\S+/y;

/** A test of a command, as `runs` gives it: true when the text holds the command. */
export interface CommandTest {
  test: (text: string) => boolean;
}

/** Whether a package runner at a line start, after its flags, runs what `rest` (a sticky regex) matches. */
function runsByRunner(text: string, rest: RegExp): boolean {
  for (const head of text.matchAll(RUNNER_HEAD)) {
    let at = head.index + head[0].length;
    for (RUNNER_FLAG.lastIndex = at; RUNNER_FLAG.test(text); RUNNER_FLAG.lastIndex = at) at = RUNNER_FLAG.lastIndex;
    rest.lastIndex = at;
    if (rest.test(text)) return true;
  }
  return false;
}

/** A command that runs yokoten's `<sub>`, by whatever path (yokoten.ts or, since #408, yokoten.mjs), or by a package runner (#298). */
export const runs = (sub: string): CommandTest => {
  const byPath = new RegExp(`yokoten\\.(?:ts|mjs)"?\\s+${sub}\\b`);
  const afterRunner = new RegExp(String.raw`[ \t]+yokoten(?:@[\w.^~-]+)?\s+${sub}\b`, 'y');
  return { test: (text) => byPath.test(text) || runsByRunner(text, afterRunner) };
};

/** The yokoten subcommand a command runs, if any. The word ends at a `;`, as in a tool-call guard (#260). */
export const subcommand = (command: string): string | undefined => command.match(/yokoten\.(?:ts|mjs)"?\s+(\w[\w-]*)/)?.[1];

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
 * install's tool-call guard is this text. The plugin's tool guard fails closed inside
 * bin/launch.mjs, so its hook command stays one short line (#706).
 */
export const refuseOnFailure = (path: string, args: string): string =>
  `command -v node >/dev/null 2>&1 || { echo '${MISSING_NODE}' >&2; exit 1; }; ` +
  `{ err=$( ( node ${GUARD_HEAP} ${path} ${args} 2>&1 1>&3 3>&-; c=$?; printf x; exit $c ) 2>/dev/null ); code=$?; } 3>&1; ` +
  'case $code in 0|2) printf %s "${err%x}" >&2;; ' +
  '*) echo "yokoten\'s guard failed (exit $code), so the command is refused; run \\`yokoten doctor\\`" >&2; code=2;; esac; exit $code';

/** What PreToolUse says when no safe plugin copy remains. It names no path. `bin/launch.mjs` says the same line. */
export const PLUGIN_GUARD_MISSING = 'yokoten: the guard cannot run, because no safe plugin copy was found, so the command is refused';

/** What SessionStart says when no safe plugin copy remains. It names no path, and the session still starts. `bin/launch.mjs` says the same line. */
export const PLUGIN_SESSION_MISSING = 'yokoten: the session check cannot run, because no safe plugin copy was found';

/** What the plugin hook says when `bin/launch.mjs` is not in this session's plugin folder. A tool call is refused. Session start still goes on. */
export const PLUGIN_COPY_GONE = 'yokoten: this plugin copy is gone; restart Claude Code';

/**
 * The Claude Code plugin hook (#706). The command is one short line, so a refusal
 * does not show a long program in front of the message. It runs `bin/launch.mjs`
 * when that file is there. When the file is gone, it says `PLUGIN_COPY_GONE` and
 * refuses a tool call (exit 2), or prints the line and exits 0 at session start.
 * The fallback path stays in the command, so the file scan still sees
 * `${CLAUDE_PLUGIN_ROOT}/bin/yokoten.mjs`. The launcher reads every other path.
 */
export function pluginHookCommand(isSessionStart: boolean): string {
  if (/['"\\]/.test(PLUGIN_COPY_GONE)) throw new Error('the gone line has a quote or a backslash');
  const launch = '"${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs"';
  const fallback = '"${CLAUDE_PLUGIN_ROOT}/bin/yokoten.mjs"';
  const mode = isSessionStart ? 'session' : 'tool';
  const yokotenArgs = isSessionStart ? 'doctor --session' : 'hook --commands-only';
  const say = isSessionStart ? `echo '${PLUGIN_COPY_GONE}'; exit 0` : `echo '${PLUGIN_COPY_GONE}' >&2; exit 2`;
  return `[ -f ${launch} ] 2>/dev/null || { ${say}; }; node ${launch} ${mode} ${fallback} ${yokotenArgs}`;
}

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
  /** The positional arguments it takes, in order, when it takes more than one: an action, then its word (#447). */
  arguments?: string[];
  /** It takes any number of positional arguments, in the order given: a merge train's queue (#320). */
  many?: boolean;
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
      '~/.claude/agents, a SessionStart doctor hook, a user-level command guard, an empty',
      'private-marks file, and a yokoten launcher in ~/.local/bin. It asks before it adds',
      'that folder to your PATH. Files you wrote yourself are left alone.',
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
      { name: '--agent', value: 'name', text: 'with --session: claude-code (the default), codex, muse, or gemini for Gemini CLI JSON' },
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
    name: 'mcp',
    summary: 'start the project MCP server and check its tools for every agent client',
    usage: '[dir] [--command "<command>"] [--json]',
    text: [
      'Starts each stdio server in .mcp.json, .vscode/mcp.json or mcp.json and calls tools/list.',
      'It checks each tool schema for Claude, Gemini and OpenAI strict mode, the tool and',
      'property names, all four annotations, the count under 40, and an outputSchema result',
      'that carries both structuredContent and text. It also reports any non-JSON-RPC line on',
      'stdout, and warns when a Windows config needs cmd /c for npx or a .cmd file.',
      'Use --command to check a server that has no config entry.',
    ],
    options: [
      { name: '--command', value: 'command', text: 'start this command instead of a config entry, such as "node server.ts"' },
      { name: '--json', text: 'the findings as JSON on stdout' },
    ],
    argument: 'dir',
    example: 'yokoten mcp',
  },
  {
    name: 'borrowed',
    summary: 'compare borrowed code with its upstream, and open issues when it moved',
    usage: '[--dry-run] [--json]',
    text: [
      "Compares each file in src/borrowed/ with upstream's default branch, through gh.",
      'It opens one issue per source that changed, and calls out a security fix.',
    ],
    options: [
      { name: '--dry-run', text: 'show the report and the issues it would open, and write nothing' },
      { name: '--json', text: 'the report as JSON on stdout' },
    ],
    example: 'yokoten borrowed --dry-run',
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
    name: 'marks',
    summary: 'count your private marks, add or remove one, turn a kind off, or allow one here',
    usage: '[add | remove | off <kind> | on <kind> | allow <mark> --here | allow --remove <mark> --here]',
    text: [
      'Alone, it counts your private marks by kind; it never shows a value. install adds your',
      'git name, git email and forge login by itself.',
      'add and remove read one mark: typed with no echo in a terminal, or from stdin. It is',
      'never a word on the command line, where your shell history would keep it.',
      'off <kind> stops install adding git-name, git-email or forge-login, and removes the',
      'marks it added for it; on <kind> brings the default back and adds it again. Marks you',
      'added yourself are never touched.',
      'allow keeps an allow on this machine, beside the private-marks file, for the repo you are',
      'in, by its origin remote; a repo with no origin cannot have one. The mark then passes the',
      'checks in this repo only, as with "privacy.allow" in yokoten.json, and nothing is',
      'written into the repo. Only a mark in your private-marks file can be allowed.',
      '--remove takes the allow back, so the checks stop the mark here again.',
    ],
    options: [
      { name: '--here', text: 'for the repo you are in (needed: an allow is always for one repo)' },
      { name: '--remove', text: 'take the allow back' },
    ],
    arguments: ['action', 'mark'],
    example: 'yokoten marks off git-name',
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
      { name: '--agent', value: 'name', text: 'the runtime that sends the call: claude-code (the default), codex, gemini, antigravity, muse, deepseek-harness, grok or opencode' },
      { name: '--commands-only', text: 'judge commands only, and leave files to the project' },
      { name: '--stop', text: 'read the end-of-turn event (Claude Code Stop or SubagentStop, Codex, Muse Code or Grok CLI Stop, Gemini AfterAgent) and check the changed files; a worker also runs the done-when command' },
      { name: '--json', text: 'the result as JSON on stdout' },
    ],
    example: `echo '{"tool_input":{"command":"git status"}}' | yokoten hook`,
  },
  {
    name: 'anchor',
    summary: "list a worker's checkpoints: commits whose checks passed",
    usage: '[--json]',
    text: [
      'Lists the anchors recorded in this checkout, newest first. A worker records one when',
      'its checks pass and its tree is clean. An anchor is a commit, so going back is a new',
      'branch from it: `git switch -c try-2 <commit>`. Nothing is reset or deleted.',
    ],
    options: [{ name: '--json', text: 'the anchors as JSON on stdout' }],
    example: 'yokoten anchor',
  },
  {
    name: 'stops',
    summary: 'the log of the guard stops on this computer, or turn it off and on',
    usage: '[off | on]',
    text: [
      'Shows where the stop log is, and whether yokoten writes it. `off` stops the writing',
      'and deletes the log; `on` starts it again. The log stays on this computer.',
    ],
    options: [],
    arguments: ['action'],
    example: 'yokoten stops off',
  },
  {
    name: 'worker',
    summary: "mark a worktree as a worker's, so the guard treats every agent there as a worker",
    usage: 'mark <dir> | unmark <dir> | env [runtime]',
    text: [
      "Marks the worktree at <dir> as a worker's. The guard then treats every agent there as",
      'a worker, even one whose runtime passes no YOKOTEN_ROLE to its hooks (Muse Code).',
      "The mark is a file in the worktree's own git folder, and its path on the worker list",
      "(under yokoten's config folder, outside the worktree), so moving `.git` away keeps the role.",
      "The guard refuses a worker's plain ways to remove it; the server and credentials kept",
      'from the worker are the real lock. Given a subfolder, it marks the worktree it is in, and names it.',
      '`git worktree remove <dir>` removes the file with the worktree; `yokoten worker unmark <dir>`',
      'clears the list entry, and only the lead runs it. A plain clone (a desk) is marked in its own `.git` (#672).',
      'Run it from your own checkout. The main checkout (the clone the lead runs in, or one with worktrees)',
      "and a submodule are never marked. A worker can't mark or unmark.",
      '`yokoten worker env [runtime]` lists the names an agent that yokoten starts would get from this shell.',
      'It never shows a value. Tokens, keys and passwords stay out (#613).',
    ],
    options: [],
    arguments: ['action', 'dir'],
    example: 'yokoten worker mark .worktrees/42',
  },
  {
    name: 'desk',
    summary: "start a worker's agent in its own fenced desk: its clone, no network but its API",
    usage: '<agent> <folder> [--name <name>] [--read <paths>] [--host <hosts>] [--marks] -- <command>',
    text: [
      'Starts the command after -- in a sandbox around <folder>, which must be its own git clone.',
      "The agent writes only in the folder and the desk's own state folder, <folder>.state, which",
      'gets only your login file. Your home, other projects and agent state are hidden.',
      "Commands have no network; only the agent's API hosts pass the proxy, for any command inside.",
      '.git/config and .git/hooks stay read-only. YOKOTEN_ROLE=worker and TZ=UTC; tokens stay out.',
      'Agents: claude-code, codex (DeepSeek too), grok, muse. Linux and WSL2 use bwrap; macOS',
      'uses sandbox-exec; native Windows is not built yet. Run the commit check outside until #665.',
      'The agent joins the team of the project you run it from, by the desk folder\'s name or --name: see `yokoten msg`.',
    ],
    options: [
      { name: '--name', value: 'name', text: "the agent's name on the team (default: the desk folder's name)" },
      { name: '--read', value: 'paths', text: 'more paths to show read-only, joined by commas' },
      { name: '--host', value: 'hosts', text: "more API hosts the agent may reach, joined by commas" },
      { name: '--marks', text: 'show the private-marks file read-only (off: the agent could read it until #665)' },
    ],
    arguments: ['agent', 'folder'],
    example: 'yokoten desk claude-code ../desks/42 -- claude -p "$(cat brief.md)"',
  },
  {
    name: 'msg',
    summary: 'agents of every vendor message each other: send, inbox, who, and the lead\'s log',
    usage: 'send <to> [<text>] | inbox | who | log',
    text: [
      'Each agent writes only its own outbox, in the team folder next to your checkout (<repo>.team).',
      'In a desk the rest of the team folder is read-only, so no agent can fake a sender.',
      'The text comes after the name, or on stdin. It gets the same privacy scan as posted text.',
      'Hooks add unread messages to the agent\'s context, marked as data that grants no approval.',
      'Claude Code and Grok get them before a tool call; every agent gets them at the end of a turn.',
      '`inbox` shows yours and marks them read. `who` lists the team. `log` shows every message; only the lead runs it.',
    ],
    options: [],
    arguments: ['action', 'to', 'text'],
    example: 'yokoten msg send lead "tests pass; ready for review"',
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
    name: 'pr',
    summary: 'keep open pull requests up to date and resolve mechanical conflicts',
    usage: 'sync',
    text: [
      'For each open pull request whose branch is behind its base branch, merges the base',
      'in, resolves only the mechanical conflicts (two added blocks, or two changed import',
      'lists), runs typecheck and the tests of the touched files, and pushes as the bot.',
      'Anything else stops with the files, the hunks and a dispatch brief. It never',
      'force-pushes, rebases or resolves on GitHub. Run it after every merge.',
    ],
    options: [],
    argument: 'action',
    example: 'yokoten pr sync',
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
    name: 'train',
    summary: 'merge an approved queue one pull request at a time, with a gate between each',
    usage: '<pr>... [--wait <seconds>]',
    text: [
      'Merges each pull request in the order given, as the bot, and stops at the first one',
      'that needs a person. Only the lead runs it.',
      'Before the first merge it records every base branch, because GitHub forgets a base',
      'when it deletes the branch. A pull request stacked on a squash-merged branch then',
      'merges from the base it really shares with its old branch, not an older one.',
      'A conflict that is only import lines is resolved by taking the union. Any other',
      'conflict, a failing test or a missing approval stops the train.',
      'Each merged tree runs the project\'s tests and `check` before it is pushed, and CI',
      'must pass on the pushed merge before the squash.',
    ],
    options: [{ name: '--wait', value: 'seconds', text: 'how long to wait for CI after a push (default 1800)' }],
    many: true,
    example: 'yokoten train 1207 1209 1211',
  },
  {
    name: 'board',
    summary: 'the team at a glance: agents, pull requests and worktrees, live on a page',
    usage: '[--text] [--no-open] [--role name] [--vendor name]',
    text: [
      'Serves a live page on this machine only, at http://<repo>.localhost:<port>/.',
      'The folder name is the host. The port stays with this repo. The first visit',
      'sets a cookie and opens the page without the token. Agents sit on the left.',
      'The picked one fills the rest. Needs you is a bell next to Live. The',
      'board opens the page in your browser, prints the link, and runs until you stop it.',
      'Chrome and Edge can install it as its own window. The page refreshes every 15',
      'seconds. Agents in this repo, its worktrees and its desks show by themselves:',
      'the hooks write .yokoten-agent.json for them.',
    ],
    options: [
      { name: '--text', text: 'print the agents, pull requests and worktrees as plain text and exit' },
      { name: '--no-open', text: 'only print the link; do not open the browser' },
      { name: '--role', value: 'name', text: 'with --text: only this role in the usage view: engineer, reviewer or checker' },
      { name: '--vendor', value: 'name', text: 'with --text: only this vendor in the usage view, such as claude or muse' },
    ],
    example: 'yokoten board --text',
  },
  {
    name: 'spend',
    summary: "the owner's spending limit for agents that pay on their own",
    usage: '[status] | check --amount <usd> --service <host> [--json] | pay --amount <usd> --service <host> -- <command> | limit --day <usd> --payment <usd> --service <host>[,<host>] [--yes] | off',
    text: [
      "Holds the owner's limit for agents that pay for a call by themselves: an amount a",
      'day, an amount a payment, and the services they may pay. The limit lives in',
      '~/.config/yokoten/spending.json, outside every repo; payments go in payments.jsonl',
      'beside it, and `board --text` shows them. A missing or broken limit pays nothing.',
      'check says pay or stop and ask the owner; it writes nothing. pay checks first, runs',
      'the command only inside the limit, and records what it cost. limit prints the change',
      'and writes it only with --yes when it allows more; a lower cap is safe by default.',
      'off removes the limit, and an agent then pays nothing. A worker cannot change it.',
    ],
    options: [
      { name: '--amount', value: 'usd', text: 'with check and pay: what the call costs, such as 0.10' },
      { name: '--service', value: 'host', text: 'with check and pay: who is paid; with limit: one or more hosts, comma separated' },
      { name: '--day', value: 'usd', text: 'with limit: the most one UTC day may cost, such as 2.00' },
      { name: '--payment', value: 'usd', text: 'with limit: the most one payment may cost, such as 0.10' },
      { name: '--yes', text: 'with limit: allow more spending than the current limit' },
      { name: '--json', text: 'with status and check: data on stdout' },
    ],
    argument: 'action',
    example: 'yokoten spend check --amount 0.10 --service api.example.com',
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
