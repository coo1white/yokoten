// Who am I on the team (#674): from where the command runs, never from a flag.
//
// - In a desk: the desk sets YOKOTEN_DESK when it starts the agent (desk.ts), and the lead
//   never has it. The name comes from the roster entry whose desk is that folder, which only
//   the lead writes; the desk file `.git/yokoten-desk.json` at the desk's top must say the
//   same name and must be locked (a read-only mount, not just a file mode). The team folder
//   must not be writable here, or this is not inside the fence. The read state is the desk's
//   own state folder, `<desk>.state/<runtime>/`. Nothing but the name is read from the desk
//   file: a desk can't point the lead, or itself, at another folder.
// - A worker outside a desk: no name. Its messages could be faked.
// - The lead: only from the session's own folder, which must be in a main checkout (a `.git`
//   folder, not a worktree's link). A checkout inside a desk is a desk's, never the lead's:
//   an agent could plant one there, with its own team folder and read state.

import { closeSync, constants, existsSync, openSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Env } from '../../../rules/config.ts';
import { gitLinkAbove, workerMarkAt, workerRole } from '../../../rules/guards.ts';
import { DESK_FILE, LEAD, NAME, readCapped, readRoster, teamFolderFor } from './team.ts';

/** Who runs this command, and where its team and its read state are. */
export interface Me {
  name: string;
  team: string;
  /** The file that keeps what this agent has read. */
  readState: string;
  inDesk: boolean;
}

/** The read state's file in a desk's state folder. */
export const deskReadState = (desk: string, runtime: string): string => join(`${desk}.state`, runtime, 'yokoten-messages.json');

/**
 * True when this process can't make a file in the team folder: the sign that it runs inside
 * a desk's fence. A desk file seen from outside the fence (the lead looking into a desk) is
 * not that agent.
 */
export function isFenced(team: string): boolean {
  const probe = join(team, `.fence-${process.pid}-${Date.now()}`);
  try {
    closeSync(openSync(probe, 'wx'));
  } catch (error) {
    return ['EROFS', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
  rmSync(probe, { force: true });
  return false;
}

/**
 * True when `path` is on a mount this process can't write: bwrap's read-only bind gives
 * EROFS, seatbelt's deny gives EPERM. A file mode (EACCES) is not enough: an agent that
 * planted the file could have set it.
 */
export function isLockedMount(path: string): boolean {
  try {
    closeSync(openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)));
  } catch (error) {
    return ['EROFS', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
  }
  return false;
}

const realOr = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Whether `folder` is a desk, seen from outside: its state folder, its desk file, or the worker mark. */
function looksLikeDesk(top: string, gitDir: string, env: Env): boolean {
  return existsSync(`${top}.state`) || existsSync(join(gitDir, DESK_FILE)) || workerMarkAt(top, env) !== null;
}

/**
 * The lead's main checkout for a session in `root`, or the plain reason there is none. It
 * never follows a worktree's link (whose `commondir` an agent could write), and refuses a
 * checkout that is a desk or sits inside one.
 */
export function leadCheckout(root: string, env: Env): string | { refuse: string } {
  const link = gitLinkAbove(root);
  if (!link) return { refuse: 'this folder is not in a git checkout, so there is no team. Run it in your project.' };
  if (link.kind !== 'folder') return { refuse: "the lead's team is found only from its main checkout, not a worktree or a submodule. Run it in the main checkout." };
  for (let top = link.top, gitDir = link.gitDir; ; ) {
    if (looksLikeDesk(top, gitDir, env)) return { refuse: `${top === link.top ? 'this checkout' : `the checkout at ${top}, around this one,`} is a desk, so it has no lead. Run it in the main checkout.` };
    const above = gitLinkAbove(dirname(top));
    if (!above || above.kind === 'broken' || dirname(top) === top) break;
    top = above.top;
    gitDir = above.kind === 'folder' ? above.gitDir : join(above.top, '.git');
  }
  return link.top;
}

/** The agent of the desk at `desk`, from inside its fence, or why not. */
function deskAgent(desk: string, team: string, locked: (path: string) => boolean): Me | { refuse: string } {
  const again = 'Ask the lead to start the desk again.';
  const deskFile = join(desk, '.git', DESK_FILE);
  let said: { name?: unknown };
  try {
    said = JSON.parse(readCapped(deskFile).text);
  } catch {
    return { refuse: `this desk's file that names its agent can't be read. ${again}` };
  }
  if (typeof said?.name !== 'string' || !NAME.test(said.name) || said.name === LEAD) return { refuse: `this desk's file that names its agent is not in the shape yokoten writes. ${again}` };
  if (!locked(deskFile)) return { refuse: `this desk's file that names its agent is not locked, so it may not be the lead's. ${again}` };
  const member = readRoster(team).get(said.name);
  if (!member || realOr(member.desk) !== desk) return { refuse: `the team's roster has no agent named ${said.name} in this desk. ${again}` };
  if (!isFenced(team)) return { refuse: "this command runs outside the desk's fence, so it would speak for the desk's agent. Run `yokoten msg` from your own checkout." };
  return { name: said.name, team, readState: deskReadState(desk, member.runtime), inDesk: true };
}

/**
 * Who runs a command whose session is in `root`, or the plain reason there is no one to be.
 * `locked` is the check that the desk file is on a read-only mount; a test passes its own.
 */
export function whoAmI(root: string, env: Env, { locked = isLockedMount }: { locked?: (path: string) => boolean } = {}): Me | { refuse: string } {
  const desk = env.YOKOTEN_DESK;
  const team = env.YOKOTEN_TEAM;
  if (desk || team) {
    if (!desk || !team || !isAbsolute(desk) || !isAbsolute(team)) return { refuse: 'YOKOTEN_DESK and YOKOTEN_TEAM are set by the desk, both as full paths. Ask the lead to start the desk again.' };
    return deskAgent(realOr(desk), realOr(team), locked);
  }
  if (workerRole(env, [root]) !== null) return { refuse: "a worker outside a desk has no name on the team, so its messages could be faked. Report to the lead instead; a desk's agent can send." };
  const main = leadCheckout(root, env);
  if (typeof main !== 'string') return main;
  const folder = teamFolderFor(main);
  return { name: LEAD, team: folder, readState: join(folder, 'lead', 'read.json'), inDesk: false };
}
