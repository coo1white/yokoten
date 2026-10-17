// How yokoten is called. Hooks, the git hook and CI name the entry point by path, and
// setup and doctor need to recognise a command that runs it.

/** A command that runs yokoten's `<sub>`, by whatever path. */
export const runs = (sub: string): RegExp => new RegExp(`yokoten\\.ts"?\\s+${sub}\\b`);

/** The yokoten subcommand a command runs, if any. */
export const subcommand = (command: string): string | undefined => command.match(/yokoten\.ts"?\s+(\S+)/)?.[1];
