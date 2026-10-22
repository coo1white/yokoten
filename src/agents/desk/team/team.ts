// Messages between agents of every vendor (#674): the team folder, who is who, and the fence.
//
// A team is one folder per project, next to the lead's checkout: `<projects>/<repo>.team/`.
//
//   agents/<name>.json   the roster: one file per desk, written by the lead when it starts
//                        the desk. It names the agent's runtime, vendor and model.
//   outbox/<name>.jsonl  one append-only outbox per agent. `lead.jsonl` is the lead's.
//   lead/read.json       what the lead has read. A desk agent keeps its own in its desk state.
//
// The sender can't be faked, because the file system says who wrote a line, not the line:
// a desk sees the team folder read-only and only its own outbox writable (desk.ts binds
// them). A reader takes the sender from the outbox's file name and the vendor and model
// from the roster, which only the lead writes. A field inside a line is never trusted.
//
// Who am I comes from where the command runs, never from a flag or a variable:
// - In a desk: the file `.git/yokoten-desk.json`, which the lead writes and the desk keeps
//   read-only. The team folder must not be writable here, or this is not inside the fence.
// - A worker outside a desk: no identity. Its messages go from a desk.
// - Anyone else is the lead.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Env } from '../../../rules/config.ts';
import { gitLinkAbove, workerRole } from '../../../rules/guards.ts';

/** The longest message, in characters. A message lands in another agent's context. */
export const MAX_MESSAGE_CHARS = 2000;
/** How many messages one agent may send in RATE_WINDOW_MS. */
export const MAX_PER_WINDOW = 20;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** The largest outbox, in bytes. A reader reads no more of one. */
export const MAX_OUTBOX_BYTES = 256 * 1024;
/** How many messages a hook adds to an agent's context at once. The rest wait. */
export const MAX_DELIVERED = 5;

/** The lead's name on the team. */
export const LEAD = 'lead';

/** The file in a desk's git folder that says which agent works there. */
export const DESK_FILE = 'yokoten-desk.json';

/** A name an agent goes by: short, lower case, safe as a file name. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** One roster entry, as the lead wrote it. */
export interface Member {
  name: string;
  runtime: string;
  vendor: string;
  model: string;
  desk: string;
  started: string;
}

/** Who runs this command, and where its team and its read state are. */
export interface Me {
  name: string;
  team: string;
  /** The file that keeps what this agent has read. */
  readState: string;
  inDesk: boolean;
}

export const outboxOf = (team: string, name: string): string => join(team, 'outbox', `${name}.jsonl`);
export const rosterOf = (team: string, name: string): string => join(team, 'agents', `${name}.json`);

/** The main checkout above `folder`, with no git process; null outside one. */
export function mainCheckout(folder: string): string | null {
  const link = gitLinkAbove(folder);
  if (!link || link.kind === 'broken') return null;
  if (link.kind === 'folder') return link.top;
  try {
    const common = resolve(link.gitDir, readFileSync(join(link.gitDir, 'commondir'), 'utf8').trim());
    return basename(common) === '.git' ? dirname(common) : null;
  } catch {
    return null;
  }
}

/** The team folder for the project whose main checkout is `main`. */
export const teamFolderFor = (main: string): string => join(dirname(main), `${basename(main)}.team`);

/** The vendor of an agent: by its model's name first (DeepSeek runs through Codex), then by its runtime. */
export function vendorOf(runtime: string, model: string): string {
  const byModel: [RegExp, string][] = [
    [/^deepseek/i, 'DeepSeek'],
    [/^claude|^opus|^sonnet|^haiku/i, 'Anthropic'],
    [/^grok/i, 'xAI'],
    [/^muse|^llama/i, 'Meta'],
    [/^gpt|^o\d|^codex/i, 'OpenAI'],
    [/^gemini/i, 'Google'],
  ];
  for (const [pattern, vendor] of byModel) if (pattern.test(model)) return vendor;
  const byRuntime: Record<string, string> = { 'claude-code': 'Anthropic', codex: 'OpenAI', grok: 'xAI', muse: 'Meta', gemini: 'Google' };
  return Object.hasOwn(byRuntime, runtime) ? byRuntime[runtime] : 'unknown vendor';
}

/** The model a desk command names (`--model x`, `--model=x`, `-m x`), or "model not named". */
export function modelOf(command: string[]): string {
  for (let i = 0; i < command.length; i++) {
    const word = command[i];
    if ((word === '--model' || word === '-m') && command[i + 1]) return command[i + 1];
    if (word.startsWith('--model=')) return word.slice('--model='.length);
  }
  return 'model not named';
}

/** Make the team folder and its parts. Only the lead calls it. */
export function makeTeam(team: string): void {
  for (const part of ['', 'agents', 'outbox', 'lead']) {
    const path = join(team, part);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error(`${path} is a link or not a folder. Remove it, then run it again.`);
  }
  const outbox = outboxOf(team, LEAD);
  if (!existsSync(outbox)) writeFileSync(outbox, '', { flag: 'wx' });
}

/** The roster, by name. A file that is not a roster entry is left out. */
export function readRoster(team: string): Map<string, Member> {
  const members = new Map<string, Member>();
  let files: string[] = [];
  try {
    files = readdirSync(join(team, 'agents'));
  } catch {
    return members;
  }
  for (const file of files.sort()) {
    const name = file.replace(/\.json$/, '');
    if (!file.endsWith('.json') || !NAME.test(name)) continue;
    try {
      const entry = JSON.parse(readFileSync(join(team, 'agents', file), 'utf8')) as Partial<Member>;
      if (typeof entry.runtime === 'string' && typeof entry.model === 'string') {
        members.set(name, { name, runtime: entry.runtime, vendor: vendorOf(entry.runtime, entry.model), model: entry.model, desk: String(entry.desk ?? ''), started: String(entry.started ?? '') });
      }
    } catch {}
  }
  return members;
}

/**
 * Get a desk ready for the team (the lead, before it starts the desk): its roster entry,
 * its own empty outbox, and the desk file in its git folder. It returns the paths the desk
 * shows: the team folder read-only, the outbox writable, the desk file locked.
 */
export function prepareDeskTeam(
  { team, name, runtime, model, desk, state }: { team: string; name: string; runtime: string; model: string; desk: string; state: string },
  now = new Date(),
): { readable: string; writable: string; locked: string } {
  if (!NAME.test(name) || name === LEAD) throw new Error(`"${name}" can't be a desk's name on the team: use lower-case letters, digits and -, up to 32, and not "${LEAD}". Name it with --name.`);
  makeTeam(team);
  const roster = rosterOf(team, name);
  const known = readRoster(team).get(name);
  if (known && known.desk !== desk) throw new Error(`the team already has an agent named ${name}, in another desk. Name this one with --name.`);
  writeFileSync(roster, `${JSON.stringify({ runtime, model, desk, started: now.toISOString() }, null, 2)}\n`);
  const outbox = outboxOf(team, name);
  if (!existsSync(outbox)) writeFileSync(outbox, '', { flag: 'wx' });
  if (lstatSync(outbox).isSymbolicLink() || !lstatSync(outbox).isFile()) throw new Error(`${outbox} is a link or not a file. Remove it, then run the desk again.`);
  const deskFile = join(desk, '.git', DESK_FILE);
  rmSync(deskFile, { force: true });
  writeFileSync(deskFile, `${JSON.stringify({ team, name, readState: join(state, 'yokoten-messages.json') }, null, 2)}\n`, { flag: 'wx' });
  return { readable: team, writable: outbox, locked: deskFile };
}

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

/** Who runs a command in `cwd`, or the plain reason there is no one to be. */
export function whoAmI(cwd: string, env: Env): Me | { refuse: string } {
  const link = gitLinkAbove(cwd);
  const deskFile = link?.kind === 'folder' ? join(link.gitDir, DESK_FILE) : null;
  if (deskFile && existsSync(deskFile)) {
    let said: { team?: unknown; name?: unknown; readState?: unknown };
    try {
      said = JSON.parse(readFileSync(deskFile, 'utf8'));
    } catch {
      return { refuse: `${deskFile} can't be read. Ask the lead to start the desk again.` };
    }
    const { team, name, readState } = said;
    if (typeof team !== 'string' || typeof name !== 'string' || typeof readState !== 'string' || !NAME.test(name)) return { refuse: `${deskFile} is not in the shape yokoten writes. Ask the lead to start the desk again.` };
    if (!existsSync(team)) return { refuse: "this desk's team folder is not here. Ask the lead to start the desk again." };
    if (!isFenced(team)) return { refuse: 'this folder is a desk, but this command runs outside its fence, so it would speak for the desk\'s agent. Run `yokoten msg` from your own checkout.' };
    return { name, team, readState, inDesk: true };
  }
  if (workerRole(env, [cwd]) !== null) return { refuse: "a worker outside a desk has no name on the team, so its messages could be faked. Report to the lead instead; a desk's agent can send." };
  const main = mainCheckout(cwd);
  if (!main) return { refuse: 'this folder is not in a git checkout, so there is no team. Run it in your project.' };
  const team = teamFolderFor(main);
  return { name: LEAD, team, readState: join(team, 'lead', 'read.json'), inDesk: false };
}
