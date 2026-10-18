// How yokoten is called. Hooks, the git hook and CI name the entry point by path, and
// setup and doctor need to recognise a command that runs it.

/** A command that runs yokoten's `<sub>`, by whatever path. */
export const runs = (sub: string): RegExp => new RegExp(`yokoten\\.ts"?\\s+${sub}\\b`);

/** The yokoten subcommand a command runs, if any. */
export const subcommand = (command: string): string | undefined => command.match(/yokoten\.ts"?\s+(\w\S*)/)?.[1];

/**
 * A hook command that runs `node <path> <args>`, with `path` quoted for the shell. When the
 * file is gone, it says `missing` in one line, never a Node stack trace with the full path
 * (#204). It exits 1: the agents report that and go on, so a missing copy never blocks
 * every tool call. At session start the line goes to stdout with exit 0, where the agent
 * reads it. `missing` has no single quote, and never names the file followed by a word,
 * or `subcommand` would read that word.
 */
export function guardCommand(path: string, args: string, missing: string, { isSessionStart = false }: { isSessionStart?: boolean } = {}): string {
  const say = isSessionStart ? `echo '${missing}'; exit 0` : `echo '${missing}' >&2; exit 1`;
  return `[ -f ${path} ] || { ${say}; }; node ${path} ${args}`;
}

/** The line a project's hook says when its runtime folder (`.yokoten/`, or `bin/` in yokoten's own repo) is gone. */
export const missingProjectRuntime = (cli: string): string =>
  `yokoten: the hook cannot run, because ${cli.split('/')[0]}/ is missing. Restore it from git, or run yokoten init again`;
