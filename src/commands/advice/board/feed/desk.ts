// The lead's desk file (#701). The lead writes it in the main checkout's git folder.
// The board reads it the same way it reads a status file: no link, a size cap, and a
// bad file is ignored. The words are masked like a session before they reach the page.

import { join } from 'node:path';
import { type Env } from '../../../../rules/config.ts';
import { commonGitDir, readStatusText } from '../../../../run/hook.ts';
import { boardHome } from '../agents.ts';
import { findAgentLog, lastAssistantText } from './logs.ts';
import { makeFeedMask } from './route.ts';

/** The desk file, in the repo's main git folder. */
export const LEAD_DESK_FILE = 'yokoten-lead-desk.json';
/** How many decisions the desk shows. */
export const DESK_DECISIONS = 3;
/** How many one-word answers one decision shows. */
const ANSWER_LIMIT = 4;
/** The longest now line, question or recommendation kept. */
const TEXT_LIMIT = 240;
/** The longest reply kept, so one log cannot fill the page. */
const REPLY_LIMIT = 4000;

/** One decision the lead asks the owner to make. */
export interface DeskDecision {
  question: string;
  recommend: string;
  answers: string[];
}

/** What the desk file holds, after a good read. */
export interface DeskFile {
  now: string;
  decisions: DeskDecision[];
  updated: string;
}

/** The desk the page shows: the file, plus the lead's last reply. */
export interface LeadDesk extends DeskFile {
  /** The first sentence of the newest reply, masked. */
  reply: string;
  /** The rest of that reply, masked. Empty when the reply is one sentence. */
  rest: string;
}

/** A desk with nothing in it. */
export const EMPTY_DESK: LeadDesk = { now: '', decisions: [], updated: '', reply: '', rest: '' };

/** One word, or '' when the text is empty, has a space, or is too long. */
function oneWord(text: string): string {
  const word = text.trim();
  return word && !/\s/.test(word) && word.length <= 24 ? word : '';
}

/** Plain text, one line, cut to the cap. */
function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT) : '';
}

/** One decision from the file, or null when it has no question. */
function parseDecision(value: unknown): DeskDecision | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const question = oneLine(fields.question);
  if (!question) return null;
  const answers = Array.isArray(fields.answers)
    ? fields.answers.flatMap((answer) => {
        const word = oneWord(typeof answer === 'string' ? answer : '');
        return word ? [word] : [];
      }).slice(0, ANSWER_LIMIT)
    : [];
  return { question, recommend: oneLine(fields.recommend), answers };
}

/**
 * The desk in `text`, or null when it is not a JSON object. A `decisions` value that
 * is not a list makes the whole file bad. At most DESK_DECISIONS decisions are kept.
 */
export function parseLeadDesk(text: string): DeskFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if ('now' in fields && typeof fields.now !== 'string') return null;
  if ('decisions' in fields && !Array.isArray(fields.decisions)) return null;
  const updated = typeof fields.updated === 'string' && !Number.isNaN(Date.parse(fields.updated)) ? fields.updated : '';
  const decisions = Array.isArray(fields.decisions)
    ? fields.decisions.flatMap((item) => {
        const decision = parseDecision(item);
        return decision ? [decision] : [];
      }).slice(0, DESK_DECISIONS)
    : [];
  return { now: oneLine(fields.now), decisions, updated };
}

/** Issue numbers named on a "Depends on" line, in the order they appear. */
export function dependsOf(body: string): number[] {
  const found: number[] = [];
  for (const line of body.split('\n')) {
    if (!/depends on/i.test(line)) continue;
    for (const match of line.matchAll(/#(\d+)/g)) {
      const number = Number(match[1]);
      if (!found.includes(number)) found.push(number);
    }
  }
  return found;
}

/** The first sentence of `text`, and the rest. `.` `!` `?` need a space or the end, so `3.14` stays. `。` `！` `？` end a sentence on their own. */
export function firstSentence(text: string): { reply: string; rest: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = /^.+?(?:[.!?](?=\s|$)|[。！？])/.exec(clean);
  if (!match || match[0].length >= clean.length) {
    if (clean.length <= TEXT_LIMIT) return { reply: clean, rest: '' };
    return { reply: clean.slice(0, TEXT_LIMIT).trim(), rest: clean.slice(TEXT_LIMIT).trim() };
  }
  return { reply: match[0], rest: clean.slice(match[0].length).trim() };
}

/**
 * The desk file, masked, or null when there is none or it is bad. A link, a huge file
 * and a file that is not a JSON object are bad. A mask that cannot be built hides the
 * file, so unmarked private text never reaches the page.
 */
export function readLeadDesk(root: string, env: Env): DeskFile | null {
  const common = commonGitDir(boardHome(root));
  if (!common) return null;
  const text = readStatusText(join(common, LEAD_DESK_FILE));
  if (text === null) return null;
  const parsed = parseLeadDesk(text);
  if (!parsed) return null;
  try {
    const mask = makeFeedMask(env, root);
    return {
      now: mask(parsed.now),
      updated: parsed.updated,
      decisions: parsed.decisions.map((item) => ({
        question: mask(item.question),
        recommend: mask(item.recommend),
        answers: item.answers.map((answer) => mask(answer)),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * The lead's newest reply, masked, as the first sentence and the rest.
 * No log, or a mask that cannot be built: both parts are empty.
 */
export function readLeadReply(tree: string, vendor: string, env: Env, root: string): { reply: string; rest: string } {
  const log = findAgentLog(tree, vendor, env, new Map());
  if (!log) return { reply: '', rest: '' };
  const text = lastAssistantText(log.file, log.source, tree).slice(0, REPLY_LIMIT);
  if (!text.trim()) return { reply: '', rest: '' };
  try {
    return firstSentence(makeFeedMask(env, root)(text));
  } catch {
    return { reply: '', rest: '' };
  }
}
