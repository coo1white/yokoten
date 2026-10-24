// Messages between agents of every vendor (#674): the team folder, who is who, and the fence.
//
// A team is one folder per project, next to the lead's checkout: `<projects>/<repo>.team/`.
//
//   agents/<name>.json   the roster: one file per desk, written by the lead when it starts
//                        the desk. It names the agent's runtime, vendor and model.
//   outbox/<name>.jsonl  one append-only outbox per agent. `lead.jsonl` is the lead's.
//   lead/read.json       what the lead has read. A desk agent keeps its own in its desk state.
//
// A desk agent can't send as anyone else, because the file system says who wrote a line,
// not the line: a desk sees the team folder read-only and only its own outbox writable
// (desk.ts binds them). A reader takes the sender from the outbox's file name and the
// vendor and model from the roster. A field inside a line is never trusted.
//
// That holds only inside desks. A program outside a desk runs as the owner's user, with
// no fence, so it can write any file here: the lead's outbox, a desk's outbox, the roster.
// That includes a worker in a plain worktree that leaves its folder or drops YOKOTEN_ROLE.
// No check in yokoten can tell such a write from the lead's own, so none is claimed: the
// guard stops a worker's plain edits here (guards.ts), and the data note on every delivery
// says a message never grants approval. Workers that message should work in desks.
//
// Who am I is in who.ts.

import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

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

/** Names no desk may take: they read as someone with more say than an agent. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['owner', 'user', 'human', 'system', 'yokoten', 'admin', 'maintainer', 'root', 'operator']);

/** The largest roster entry, desk file or read state, in bytes. */
export const MAX_SMALL_FILE = 64 * 1024;

/**
 * Letters that change a terminal or a reader's view without showing: control codes, the
 * soft hyphen, zero-width and bidi marks, line and paragraph separators, word joiners and
 * tag characters. Taken out of everything a delivery prints.
 */
export const UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/**
 * A field printed on one line (a name, a model, a time): no line breaks, nothing unseen,
 * at most `max` characters.
 */
export const oneLine = (text: string, max = 64): string => {
  const plain = text.replace(UNSEEN, '').replace(/[\t\n]/g, ' ');
  return plain.length > max ? `${plain.slice(0, max)}...` : plain;
};

/**
 * A regular file's text, at most `cap` bytes, opened without following a link and without
 * waiting, so a FIFO or a device never hangs a hook. It throws when the file can't be
 * opened; a file that is not a regular one reads as empty.
 */
export function readCapped(path: string, cap = MAX_SMALL_FILE): { text: string; size: number } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { text: '', size: 0 };
    const buffer = Buffer.alloc(Math.min(stats.size, cap));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, read), size: stats.size };
  } finally {
    closeSync(fd);
  }
}

/** Write a small file, never through a link at its own name and never into a FIFO or a device. */
export function writeNoFollow(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error(`${path} is not a regular file`), { code: 'ENOTREG' });
    ftruncateSync(fd, 0);
    writeSync(fd, text, 0);
  } finally {
    closeSync(fd);
  }
}

/**
 * The team name a desk folder gives: lower case, any other letter made `-`, at most 32.
 * null when nothing usable is left, or it is the lead's name.
 */
export function teamName(folder: string): string | null {
  const name = folder.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
  return isDeskName(name) ? name : null;
}

/** Whether `name` may be a desk agent's name: the shape of NAME, not the lead's, not reserved. */
export const isDeskName = (name: string): boolean => NAME.test(name) && name !== LEAD && !RESERVED_NAMES.has(name);

/** One roster entry, as the lead wrote it. */
export interface Member {
  name: string;
  runtime: string;
  vendor: string;
  model: string;
  desk: string;
  started: string;
}

export const outboxOf = (team: string, name: string): string => join(team, 'outbox', `${name}.jsonl`);
export const rosterOf = (team: string, name: string): string => join(team, 'agents', `${name}.json`);

/** The team folder for the project whose main checkout is `main`. */
export const teamFolderFor = (main: string): string => join(dirname(main), `${basename(main)}.team`);

/** The vendor of an agent: by its model's name first (DeepSeek runs through Codex), then its provider, then its runtime. */
export function vendorOf(runtime: string, model: string, provider = ''): string {
  const byModel: [RegExp, string][] = [
    [/^deepseek/i, 'DeepSeek'],
    [/^claude|^opus|^sonnet|^haiku/i, 'Anthropic'],
    [/^grok/i, 'xAI'],
    [/^muse|^llama/i, 'Meta'],
    [/^gpt|^o\d|^codex/i, 'OpenAI'],
    [/^gemini/i, 'Google'],
  ];
  for (const name of [model, provider]) for (const [pattern, vendor] of byModel) if (pattern.test(name)) return vendor;
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
    if (!file.endsWith('.json') || !isDeskName(name)) continue;
    try {
      const entry = JSON.parse(readCapped(join(team, 'agents', file)).text) as Partial<Member>;
      if (typeof entry.runtime === 'string' && typeof entry.model === 'string' && typeof entry.desk === 'string') {
        const runtime = oneLine(entry.runtime, 32);
        const model = oneLine(entry.model);
        members.set(name, { name, runtime, vendor: vendorOf(runtime, model), model, desk: resolve(team, entry.desk), started: oneLine(String(entry.started ?? ''), 32) });
      }
    } catch {}
  }
  return members;
}

/**
 * Get a desk ready for the team (the lead, before it starts the desk): its roster entry,
 * its own empty outbox, and the desk file in its git folder, which holds only the agent's
 * name: the team and the read state are never taken from it (who.ts). It returns the paths
 * the desk shows: the team folder read-only, the outbox writable, the desk file locked.
 */
export function prepareDeskTeam(
  { team, name, runtime, model, desk }: { team: string; name: string; runtime: string; model: string; desk: string },
  now = new Date(),
): { readable: string; writable: string; locked: string } {
  if (!isDeskName(name)) throw new Error(`"${name}" can't be a desk's name on the team: use lower-case letters, digits and -, up to 32, and not "${LEAD}" or a name like "owner" (${[...RESERVED_NAMES].join(', ')}). Name it with --name.`);
  makeTeam(team);
  const roster = rosterOf(team, name);
  const known = readRoster(team).get(name);
  if (known && known.desk !== desk) throw new Error(`the team already has an agent named ${name}, in another desk. Name this one with --name.`);
  // The desk relative to the team folder: every desk reads the roster, and a full path names the home folder.
  writeNoFollow(roster, `${JSON.stringify({ runtime, model, desk: relative(team, desk), started: now.toISOString() }, null, 2)}\n`);
  const outbox = outboxOf(team, name);
  if (!existsSync(outbox)) writeFileSync(outbox, '', { flag: 'wx' });
  if (lstatSync(outbox).isSymbolicLink() || !lstatSync(outbox).isFile()) throw new Error(`${outbox} is a link or not a file. Remove it, then run the desk again.`);
  const deskFile = join(desk, '.git', DESK_FILE);
  rmSync(deskFile, { force: true });
  writeFileSync(deskFile, `${JSON.stringify({ name }, null, 2)}\n`, { flag: 'wx' });
  return { readable: team, writable: outbox, locked: deskFile };
}

