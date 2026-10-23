// The board's agents (#601, #603): one status file per worktree, and the worktrees git lists,
// with the desks `yokoten desk` started (#685). An agent joins by writing the file at its
// worktree's root, and leaves by removing it. The hooks write it for every vendor (#685).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Env } from '../../../rules/config.ts';
import { commonGitDir, DESK_LIST_FILE } from '../../../run/hook.ts';

/** The repo's main folder. Every worktree shares it, and the lead's log path is kept there. */
export function boardHome(root: string): string {
  const common = commonGitDir(root);
  return common && basename(common) === '.git' ? dirname(common) : root;
}

/** How long the board waits for `gh pr list` or `git worktree list`, at most. */
export const BOARD_READ_TIMEOUT_MS = 15000;
/** An agent's status file, at its worktree's root. One file per worktree. */
export const BOARD_AGENT_FILE = '.yokoten-agent.json';
/** The most changed files the agent panel shows. */
export const BOARD_OUTPUT_LIMIT = 20;
/** The most background tasks the panel shows. */
export const BOARD_BACKGROUND_LIMIT = 8;
/** How long the changed files stand before git is asked again. */
export const BOARD_OUTPUT_CACHE_MS = 10000;
/** Seats per vendor, in the common git folder. The owner writes it by hand (#698). */
export const BOARD_SEATS_FILE = 'yokoten-seats.json';
/** Keys a seats file must not set. A bad file is ignored, not trusted. */
const SEAT_SKIP = new Set(['__proto__', 'constructor', 'prototype']);

/** The role text a status file wrote. The page groups it by the work the word names. */
export type BoardRole = string;

/** One background task an agent reported: what it started, and since when. */
export interface BoardBackground {
  text: string;
  /** The time it started, as filed, or '' when the file does not say. */
  since: string;
}

/** One agent on the board, from its status file. The guide shows the open format. */
export interface BoardAgent {
  name: string;
  vendor: string;
  /** The model and the effort it runs with, as filed, or ''. */
  model: string;
  effort: string;
  task: string;
  worktree: string;
  doing: string;
  /** When the agent last wrote, as filed, or '' when unknown. */
  updated: string;
  /** When this work started, as filed, or '' when the file does not say. */
  started: string;
  role: BoardRole;
  /** What the agent says of itself: still working, waiting for the owner, or done. */
  state: '' | 'working' | 'waiting' | 'done';
  /** The project's checks at its last stop, written by the stop hook (#614). */
  checks: '' | 'passing' | 'failing';
  /** Tokens used in its context, or null when its status file does not say (#644). */
  contextUsed: number | null;
  /** Tokens its context can hold, or null when its status file does not say (#644). */
  contextLimit: number | null;
  /** What it started in the background, at most BOARD_BACKGROUND_LIMIT (#644). */
  background: BoardBackground[];
}

/** Plain text of a status field, or '' when it is missing or not text. */
function fieldText(fields: Record<string, unknown>, name: string): string {
  const value: unknown = fields[name];
  return typeof value === 'string' ? value : '';
}

/** A count of tokens from a status field, or null when it is missing or not a count. */
function fieldCount(fields: Record<string, unknown>, name: string): number | null {
  const value: unknown = fields[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Plain text, one line, cut to 240 characters. */
function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
}

/** One background task from the file, or null when it names nothing to show. */
function parseBackground(value: unknown): BoardBackground | null {
  if (typeof value === 'string') {
    const text = oneLine(value);
    return text ? { text, since: '' } : null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const text = oneLine(fields.text) || oneLine(fields.name) || oneLine(fields.doing) || oneLine(fields.task);
  if (!text) return null;
  const since = fieldText(fields, 'since') || fieldText(fields, 'started');
  return { text, since };
}

/** The `background` list, keeping only what names a task, then at most BOARD_BACKGROUND_LIMIT. */
function fieldBackground(fields: Record<string, unknown>): BoardBackground[] {
  const value: unknown = fields.background;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const itemTask = parseBackground(item);
    return itemTask ? [itemTask] : [];
  }).slice(0, BOARD_BACKGROUND_LIMIT);
}

/** A field's text when it is one of `allowed`, else ''. */
function pickWord<Word extends string>(fields: Record<string, unknown>, name: string, allowed: readonly Word[]): Word | '' {
  const value = fieldText(fields, name);
  return (allowed as readonly string[]).includes(value) ? (value as Word) : '';
}

/** One status file as an agent, or null when it is not a JSON object. The worktree's own folder name fills a missing name. */
export function parseBoardAgent(text: string, worktree: string): BoardAgent | null {
  let status: unknown;
  try {
    status = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof status !== 'object' || status === null || Array.isArray(status)) return null;
  const fields = status as Record<string, unknown>;
  return {
    name: fieldText(fields, 'name') || basename(worktree),
    vendor: fieldText(fields, 'vendor'),
    model: fieldText(fields, 'model'),
    effort: fieldText(fields, 'effort'),
    task: fieldText(fields, 'task'),
    worktree: fieldText(fields, 'worktree'),
    doing: fieldText(fields, 'doing'),
    updated: fieldText(fields, 'updated'),
    started: fieldText(fields, 'started'),
    role: fieldText(fields, 'role').trim(),
    state: pickWord(fields, 'state', ['working', 'waiting', 'done'] as const),
    checks: pickWord(fields, 'checks', ['passing', 'failing'] as const),
    contextUsed: fieldCount(fields, 'context_used'),
    contextLimit: fieldCount(fields, 'context_limit'),
    background: fieldBackground(fields),
  };
}

/** One agent with the worktree it was read from, so the board can tell two agents apart. */
export interface FoundAgent {
  agent: BoardAgent;
  tree: BoardWorktree;
}

/** Every agent with a status file at its worktree's root, in worktree order. A missing, broken or unreadable file is skipped. */
export function readBoardAgents(trees: BoardWorktree[]): FoundAgent[] {
  const found: FoundAgent[] = [];
  for (const tree of trees) {
    let text: string;
    try {
      text = readFileSync(join(tree.path, BOARD_AGENT_FILE), 'utf8');
    } catch {
      continue;
    }
    const agent = parseBoardAgent(text, tree.path);
    if (agent) found.push({ agent, tree });
  }
  return found;
}

/** How long ago `when` was, in plain words, or '' when it is missing or not a time. */
export function ageText(when: string, now: number = Date.now()): string {
  if (!when) return '';
  const then = Date.parse(when);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** One worktree of the repo: its path and its branch. */
export interface BoardWorktree {
  path: string;
  /** The branch, or '' when bare or detached. */
  branch: string;
}

/** `git worktree list --porcelain -z` as worktrees, then the desks, or why git can't read them. */
export function readBoardWorktrees(root: string, env: Env): BoardWorktree[] | string {
  const trees = readGitWorktrees(root, env);
  if (typeof trees === 'string') return trees;
  const seen = new Set(trees.map((tree) => tree.path));
  return [...trees, ...readBoardDesks(root).filter((desk) => !seen.has(desk.path))];
}

/**
 * The desks `yokoten desk` started from this repo (#685): plain clones, so `git worktree
 * list` misses them. Their paths are on a list in the repo's git folder. A desk that is
 * gone, or is no clone, is skipped. The branch comes from its HEAD, with no git process.
 */
export function readBoardDesks(root: string): BoardWorktree[] {
  const common = commonGitDir(root);
  if (!common) return [];
  let text: string;
  try {
    text = readFileSync(join(common, DESK_LIST_FILE), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((path) => path && existsSync(join(path, '.git')))
    .map((path) => {
      let head = '';
      try {
        head = readFileSync(join(path, '.git', 'HEAD'), 'utf8').trim();
      } catch {
        // No HEAD to read: the branch stays blank.
      }
      return { path, branch: head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : '' };
    });
}

/** `git worktree list --porcelain -z` as worktrees, or why git can't read them. */
function readGitWorktrees(root: string, env: Env): BoardWorktree[] | string {
  let text: string;
  try {
    text = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: BOARD_READ_TIMEOUT_MS });
  } catch {
    return 'git could not list the worktrees: run it again';
  }
  return text
    .split('\0\0')
    .filter((record) => record.startsWith('worktree '))
    .map((record) => {
      const fields = record.split('\0');
      const value = (key: string) => fields.find((field) => field === key || field.startsWith(`${key} `))?.slice(key.length + 1) ?? '';
      return { path: value('worktree'), branch: value('branch').replace(/^refs\/heads\//, '') };
    })
    .filter((worktree) => worktree.path !== '');
}

/**
 * The files a worktree changed against `base`, at most BOARD_OUTPUT_LIMIT (#644).
 * One git call. The answer stands for BOARD_OUTPUT_CACHE_MS, because the page reads
 * every 15 seconds. A git failure is no files, not a broken board.
 */
export function readBoardOutputs(tree: string, base: string, env: Env, now: number = Date.now()): string[] {
  const key = `${tree}\0${base}`;
  const held = outputsCache.get(key);
  if (held && now - held.at < BOARD_OUTPUT_CACHE_MS) return held.files;
  let files: string[] = [];
  try {
    const text = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, '--'], { cwd: tree, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: BOARD_READ_TIMEOUT_MS, maxBuffer: 1 << 24 });
    files = text.split('\0').filter((file) => file !== '').slice(0, BOARD_OUTPUT_LIMIT);
  } catch {
    // No git, no base or no worktree: the panel says it has no files to show.
  }
  outputsCache.set(key, { at: now, files });
  return files;
}

/** The changed files the board has read, by worktree and base. */
const outputsCache = new Map<string, { at: number; files: string[] }>();

/**
 * Seats from the text of `.git/yokoten-seats.json`, or null when it is not a JSON object.
 * A vendor name is kept in lower case. A count that is not a whole number, or is negative, is skipped.
 */
export function parseBoardSeats(text: string): Record<string, number> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const seats: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    const key = name.trim().toLowerCase();
    if (!key || SEAT_SKIP.has(key)) continue;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
    seats[key] = count;
  }
  return seats;
}

/** The seats file in the common git folder, or null when it is missing or bad. */
export function readBoardSeats(root: string): Record<string, number> | null {
  const common = commonGitDir(root);
  if (!common) return null;
  try {
    return parseBoardSeats(readFileSync(join(common, BOARD_SEATS_FILE), 'utf8'));
  } catch {
    return null;
  }
}
