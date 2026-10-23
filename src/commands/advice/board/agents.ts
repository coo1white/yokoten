// The board's agents (#601, #603): one status file per worktree, and the worktrees git lists,
// with the desks `yokoten desk` started (#685). An agent joins by writing the file at its
// worktree's root, and leaves by removing it. The hooks write it for every vendor (#685).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type Env, loadConfig } from '../../../rules/config.ts';
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
/** Seats per vendor, in the common git folder. The owner writes it by hand (#698). */
export const BOARD_SEATS_FILE = 'yokoten-seats.json';
/** Keys a seats file must not set. A bad file is ignored, not trusted. */
const SEAT_SKIP = new Set(['__proto__', 'constructor', 'prototype']);

/** The role text a status file wrote. The page groups it by the work the word names. */
export type BoardRole = string;

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
}

/** Plain text of a status field, or '' when it is missing or not text. */
function fieldText(fields: Record<string, unknown>, name: string): string {
  const value: unknown = fields[name];
  return typeof value === 'string' ? value : '';
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
 * One total per vendor, or null when no vendor has a seat. Each role's count is added (#779).
 * A filed vendor name maps to the same key the agents use, and a table of zeros is no seats.
 */
export function seatTotals(seats: Record<string, Record<string, number>>): Record<string, number> | null {
  const totals: Record<string, number> = {};
  for (const [vendor, roles] of Object.entries(seats)) {
    const key = vendorKeyOf(vendor);
    if (!key || SEAT_SKIP.has(key)) continue;
    let total = 0;
    for (const count of Object.values(roles)) total += count;
    totals[key] = (totals[key] ?? 0) + total;
  }
  return Object.values(totals).some((count) => count > 0) ? totals : null;
}

/**
 * Seats from the text of `.git/yokoten-seats.json`, or null when it is not a JSON object.
 * A vendor name maps to the same key the agents use, and a table of zeros is no seats.
 * A count that is not a whole number, or is negative, is skipped.
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
    const key = vendorKeyOf(name);
    if (!key || SEAT_SKIP.has(key)) continue;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) continue;
    seats[key] = (seats[key] ?? 0) + count;
  }
  return Object.values(seats).some((count) => count > 0) ? seats : null;
}

/**
 * Seats per vendor (#779). `team.seats` in yokoten.json wins, and each role's count is added.
 * With no seats there, `.git/yokoten-seats.json` is used. A bad file of either kind is ignored.
 */
export function readBoardSeats(root: string): Record<string, number> | null {
  const fromConfig = seatTotals(loadConfig(root, { onProblem: () => undefined }).team.seats);
  if (fromConfig) return fromConfig;
  const common = commonGitDir(root);
  if (!common) return null;
  try {
    return parseBoardSeats(readFileSync(join(common, BOARD_SEATS_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// Vendors: How a vendor shows on the board (#693), and the one key every name maps to (#779).
// An agent files its own name, and an owner writes seats by vendor, so both map here.

/** A vendor's shown name and colour. */
export interface VendorLook {
  name: string;
  color: string;
}

/** Filed names that share one shown name (#693). The hooks file each agent by its --agent name. */
const VENDOR_KEY: Record<string, string> = {
  anthropic: 'claude',
  claude: 'claude',
  'claude-code': 'claude',
  xai: 'grok',
  grok: 'grok',
  muse: 'muse',
  deepseek: 'deepseek',
  'deepseek-harness': 'deepseek',
  'codex-deepseek': 'deepseek',
  'codex on deepseek': 'deepseek',
};

const VENDOR_LOOKS: Record<string, VendorLook> = {
  claude: { name: 'Claude', color: '#d97757' },
  codex: { name: 'Codex', color: '#10a37f' },
  gemini: { name: 'Gemini', color: '#4285f4' },
  antigravity: { name: 'Antigravity', color: '#4285f4' },
  grok: { name: 'Grok', color: '#9ca3af' },
  muse: { name: 'Muse', color: '#0866ff' },
  deepseek: { name: 'DeepSeek', color: '#4d6bfe' },
};
const OTHER_VENDOR_COLOR = '#8b8b8b';

/**
 * The one key a filed vendor name maps to, in lower case. Seats and agents use it, so
 * "deepseek-harness" and "DeepSeek" meet. Codex on a DeepSeek model is DeepSeek.
 */
export function vendorKeyOf(vendor: string, model = ''): string {
  const filed = vendor.trim().toLowerCase();
  let key = Object.hasOwn(VENDOR_KEY, filed) ? VENDOR_KEY[filed] : filed;
  if (key === 'codex' && model.toLowerCase().includes('deepseek')) key = 'deepseek';
  return key;
}

/**
 * How a vendor shows (#693). Claude, Grok, Muse and DeepSeek each have one name.
 * Codex on a DeepSeek model shows as DeepSeek. Claude on that model stays Claude.
 * Any other vendor keeps its filed name, in grey.
 */
export function vendorOf(vendor: string, model = ''): VendorLook {
  const key = vendorKeyOf(vendor, model);
  const known = Object.hasOwn(VENDOR_LOOKS, key) ? VENDOR_LOOKS[key] : null;
  return known ?? { name: vendor.trim() || 'Unknown', color: OTHER_VENDOR_COLOR };
}
