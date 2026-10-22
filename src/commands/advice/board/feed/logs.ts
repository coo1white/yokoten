// Where an agent's session log is (#694), found from its worktree. Each runtime keeps its logs
// in its own state folder: the lead's (~/.claude, ~/.local/share/muse, ~/.grok), or a desk's
// own, `<worktree>.state/<runtime>` (#637). The newest log that belongs to the worktree wins.
//
// - Claude Code: `<state>/projects/<folder>/<session>.jsonl`, where the folder is the
//   worktree's path with each character other than a letter or digit as `-`. A subagent of a
//   lead elsewhere logs under the lead's session, `<session>/subagents/agent-<id>.jsonl`: it
//   belongs to the worktree when its task names the worktree.
// - Muse Code: `<state>/sessions/<year>/<month>/<day>/<id>/session.jsonl`, whose metadata names
//   its `workspace_root`.
// - Grok: `<state>/sessions/<the worktree's path, URL-encoded>/<id>/chat_history.jsonl`.
// - Codex: not read yet. No Codex session log on this machine showed its format; a reader
//   for it goes in LOG_FINDERS and LINE_READERS (items.ts).

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type Env } from '../../../../rules/config.ts';
import { homeOf } from '../../../../rules/privacy.ts';
import type { StreamSource } from './items.ts';

/** One session log the board can stream: which runtime wrote it, the file, and when it last changed. */
export interface FoundLog {
  source: StreamSource;
  file: string;
  mtime: number;
}

/** How much of a log's start the board reads to tell whose it is. */
const HEAD_BYTES = 64 * 1024;
/** A subagent log or a Muse session older than this is not looked at. */
const RECENT_MS = 24 * 60 * 60 * 1000;
/** The most Muse day folders, and Claude project folders, looked at for one worktree. */
const DAY_LIMIT = 3;
const FOLDER_LIMIT = 64;

/** The entries of a folder, or none when it can't be read. */
function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** When a file last changed, or null when it is not a file. */
function fileTime(file: string): number | null {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The first bytes of a file as text, or '' when it can't be read. */
export function readHead(file: string, bytes: number = HEAD_BYTES): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The newest of some logs, or null. */
function newest(logs: FoundLog[]): FoundLog | null {
  return logs.reduce<FoundLog | null>((best, log) => (!best || log.mtime > best.mtime ? log : best), null);
}

/** A state folder named by a setting, when it is a full path; else the default under home. */
function stateDir(value: string | undefined, fallback: string[], home: string): string {
  return value && isAbsolute(value) ? value : join(home, ...fallback);
}

/** Claude Code's folder name for a worktree: every character but a letter or digit becomes `-`. */
export function claudeFolder(tree: string): string {
  return tree.replace(/[^A-Za-z0-9]/g, '-');
}

/** True when `text` names the worktree, by its full path or with `~` for home, as a whole path. */
export function namesTree(text: string, tree: string, home: string | null): boolean {
  const forms = [tree, ...(home && tree.startsWith(`${home}/`) ? [`~${tree.slice(home.length)}`] : [])];
  return forms.some((form) => {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      // A full stop ends the path when no name goes on after it: "in ~/dev/repo." names ~/dev/repo.
      if (!/^(?:[A-Za-z0-9_-]|\.[A-Za-z0-9_-])/.test(text.slice(at + form.length, at + form.length + 2))) return true;
    }
    return false;
  });
}

/** The task a Claude Code subagent was given: the text of the first user turn in its log. */
export function claudeTask(head: string): string {
  for (const line of head.split('\n')) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const { type, message } = record as { type?: unknown; message?: { content?: unknown } };
    if (type !== 'user' || typeof message !== 'object' || message === null) continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part: { type?: unknown; text?: unknown }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

/** What a finder may keep between reads: whose each log is never changes. */
export type LogCache = Map<string, boolean | string>;

/** The newest Claude Code log of a worktree: its own sessions, or a subagent whose task names it. */
export function findClaudeLog(tree: string, env: Env, cache: LogCache, now: number = Date.now()): FoundLog | null {
  const home = homeOf(env);
  if (!home) return null;
  const roots = [stateDir(env.CLAUDE_CONFIG_DIR, ['.claude'], home), join(`${tree}.state`, 'claude-code')].map((root) => join(root, 'projects'));
  const found: FoundLog[] = [];
  for (const projects of roots) {
    const own = join(projects, claudeFolder(tree));
    for (const name of list(own)) {
      const mtime = name.endsWith('.jsonl') ? fileTime(join(own, name)) : null;
      if (mtime !== null) found.push({ source: 'claude', file: join(own, name), mtime });
    }
    for (const folder of list(projects).slice(0, FOLDER_LIMIT)) {
      if (folder === claudeFolder(tree)) continue;
      for (const session of list(join(projects, folder))) {
        const subagents = join(projects, folder, session, 'subagents');
        for (const name of list(subagents)) {
          if (!name.endsWith('.jsonl')) continue;
          const file = join(subagents, name);
          const mtime = fileTime(file);
          if (mtime === null || now - mtime > RECENT_MS) continue;
          if (!cache.has(file)) {
            const head = readHead(file);
            // Too early to tell: the task is not written yet. Ask again on the next read.
            if (!head.includes('\n')) continue;
            cache.set(file, namesTree(claudeTask(head), tree, home));
          }
          if (cache.get(file) === true) found.push({ source: 'claude', file, mtime });
        }
      }
    }
  }
  return newest(found);
}

/** The workspace a Muse session runs in, from the metadata at its start, or ''. */
export function museRoot(head: string): string {
  const hit = /"workspace_root"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
  if (!hit) return '';
  try {
    const root: unknown = JSON.parse(hit[1]);
    return typeof root === 'string' ? root : '';
  } catch {
    return '';
  }
}

/** The newest Muse Code session of a worktree: one whose workspace is the worktree. */
export function findMuseLog(tree: string, env: Env, cache: LogCache, now: number = Date.now()): FoundLog | null {
  const home = homeOf(env);
  if (!home) return null;
  const roots = [join(stateDir(env.XDG_DATA_HOME, ['.local', 'share'], home), 'muse'), join(`${tree}.state`, 'muse', 'data', 'muse')].map((root) => join(root, 'sessions'));
  const found: FoundLog[] = [];
  for (const sessions of roots) {
    const days = list(sessions)
      .filter((year) => /^\d{4}$/.test(year))
      .flatMap((year) => list(join(sessions, year)).flatMap((month) => list(join(sessions, year, month)).map((day) => join(sessions, year, month, day))))
      .sort()
      .slice(-DAY_LIMIT);
    for (const day of days) {
      for (const id of list(day)) {
        const file = join(day, id, 'session.jsonl');
        const mtime = fileTime(file);
        if (mtime === null || now - mtime > RECENT_MS) continue;
        if (!cache.has(file)) {
          const root = museRoot(readHead(file));
          if (!root) continue;
          cache.set(file, root);
        }
        if (cache.get(file) === tree) found.push({ source: 'muse', file, mtime });
      }
    }
  }
  return newest(found);
}

/** The newest Grok session of a worktree: Grok keeps one folder of sessions per working folder. */
export function findGrokLog(tree: string, env: Env): FoundLog | null {
  const home = homeOf(env);
  if (!home) return null;
  const roots = [stateDir(env.GROK_HOME, ['.grok'], home), join(`${tree}.state`, 'grok')];
  const found: FoundLog[] = [];
  for (const root of roots) {
    const folder = join(root, 'sessions', encodeURIComponent(tree));
    for (const id of list(folder)) {
      const file = join(folder, id, 'chat_history.jsonl');
      const mtime = fileTime(file);
      if (mtime !== null) found.push({ source: 'grok', file, mtime });
    }
  }
  return newest(found);
}

/** The finders by runtime, as a status file's vendor names it. */
const LOG_FINDERS: Record<string, (tree: string, env: Env, cache: LogCache) => FoundLog | null> = {
  claude: findClaudeLog,
  'claude-code': findClaudeLog,
  muse: findMuseLog,
  grok: findGrokLog,
};

/**
 * The session log of the agent in `tree`, or null when there is none. A known vendor's
 * runtime is asked; any other vendor, or none, gets the newest log any runtime has there.
 * Codex has no finder yet, so a Codex agent shows its `doing` steps.
 */
export function findAgentLog(tree: string, vendor: string, env: Env, cache: LogCache): FoundLog | null {
  const key = vendor.trim().toLowerCase();
  if (key === 'codex' || key === 'deepseek') return null;
  const finder = Object.hasOwn(LOG_FINDERS, key) ? LOG_FINDERS[key] : null;
  if (finder) return finder(tree, env, cache);
  return newest([findClaudeLog(tree, env, cache), findMuseLog(tree, env, cache), findGrokLog(tree, env)].filter((log): log is FoundLog => log !== null));
}
