// Where an agent's session log is (#694), found from its worktree. Each runtime keeps its logs
// in its own state folder: the lead's (~/.claude, ~/.local/share/muse, ~/.grok), or a desk's
// own, `<worktree>.state/<runtime>` (#637). The newest log that belongs to the worktree wins.
// The main checkout's lead registers its own log path (#700). That path is tried first.
//
// - Claude Code: `<state>/projects/<folder>/<session>.jsonl`, where the folder is the
//   worktree's path with each character other than a letter or digit as `-`. A subagent of a
//   lead elsewhere logs under the lead's session, `<session>/subagents/agent-<id>.jsonl`: it
//   belongs to the worktree when its task names the worktree.
// - Muse Code: `<state>/sessions/<year>/<month>/<day>/<id>/session.jsonl`, whose metadata names
//   its `workspace_root`.
// - Grok: `<state>/sessions/<the worktree's path, URL-encoded>/<id>/chat_history.jsonl`.
// - Codex: `<state>/sessions/<year>/<month>/<day>/rollout-*.jsonl`, whose session_meta
//   names `cwd`. The path is a guess (#698). DeepSeek runs on the Codex CLI, so it uses this.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { type Env } from '../../../../../rules/config.ts';
import { homeOf } from '../../../../../rules/privacy.ts';
import { commonGitDir } from '../../../../../run/hook.ts';
import { boardHome } from '../../agents.ts';
import { LINE_READERS, type StreamSource } from '../items.ts';

/** One session log the board can stream: which runtime wrote it, the file, and when it last changed. */
export interface FoundLog {
  source: StreamSource;
  file: string;
  mtime: number;
}

/** How much of a log's start the board reads to tell whose it is. */
const HEAD_BYTES = 64 * 1024;
/** The lead's log path, one line, in the repo's main git folder (#700). */
export const LEAD_SESSION_FILE = 'yokoten-lead-session';
/** The most bytes that file may hold. A log path is far shorter. */
const LEAD_SESSION_LIMIT = 4096;
/** How far back from the end the lead's last words are read. */
const LEAD_SCAN_BYTES = 1024 * 1024;
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

/** Claude Code's `projects` folders for a worktree: the lead's state, and a desk's own. */
function claudeProjects(tree: string, home: string, env: Env): string[] {
  return [stateDir(env.CLAUDE_CONFIG_DIR, ['.claude'], home), join(`${tree}.state`, 'claude-code')].map((root) => join(root, 'projects'));
}

/** The lead log file in the repo's main git folder, or null outside a checkout. */
function leadSessionPath(folder: string): string | null {
  const common = commonGitDir(boardHome(folder));
  return common ? join(common, LEAD_SESSION_FILE) : null;
}

/** True when `tree` is the repo's main checkout, not a linked worktree. */
function isMainCheckout(tree: string): boolean {
  const home = boardHome(tree);
  try {
    return realpathSync(tree) === realpathSync(home);
  } catch {
    return tree === home;
  }
}

/**
 * Record the lead's session log (#700). One line, mode 0600, replaced by a rename so a
 * reader never sees a half-written path. A new lead session overwrites the old path.
 * Returns whether it wrote. It never throws: a session still starts when it cannot.
 */
export function writeLeadSession(folder: string, transcriptPath: string): boolean {
  const line = transcriptPath.split(/[\r\n]/, 1)[0]?.trim() ?? '';
  if (!line || line.length > LEAD_SESSION_LIMIT) return false;
  const path = leadSessionPath(folder);
  if (!path) return false;
  const temp = join(dirname(path), `.${LEAD_SESSION_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${line}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file can stay. The session still starts.
    }
    return false;
  }
}

/** True when `realFile` is inside one of Claude Code's projects folders. */
function isInsideProjects(realFile: string, tree: string, env: Env): boolean {
  const home = homeOf(env);
  if (!home) return false;
  return claudeProjects(tree, home, env).some((root) => {
    try {
      const base = realpathSync(root);
      const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
      return realFile.startsWith(prefix);
    } catch {
      return false;
    }
  });
}

/**
 * The main checkout's registered lead log, or null. The path must be absolute, end in
 * `.jsonl`, and resolve to a regular file inside Claude Code's projects folder. A
 * missing file, a `..` path that leaves that folder, or a symlink out of it is refused.
 */
function readLeadSession(tree: string, env: Env): FoundLog | null {
  if (!isMainCheckout(tree)) return null;
  const path = leadSessionPath(tree);
  if (!path) return null;
  let given = '';
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size === 0 || stats.size > LEAD_SESSION_LIMIT) return null;
    given = readFileSync(path, 'utf8').split('\n', 1)[0]?.trim() ?? '';
  } catch {
    return null;
  }
  if (!isAbsolute(given) || !given.endsWith('.jsonl')) return null;
  let real = '';
  try {
    real = realpathSync(given);
    if (!statSync(real).isFile() || !real.endsWith('.jsonl')) return null;
  } catch {
    return null;
  }
  if (!isInsideProjects(real, tree, env)) return null;
  const mtime = fileTime(real);
  return mtime === null ? null : { source: 'claude', file: real, mtime };
}

/**
 * The newest thing the agent said in `file`, or ''. Only the end of a long log is read.
 * Tool calls with no text are skipped.
 */
function lastAssistantSay(file: string, source: StreamSource, tree: string): string {
  const reader = LINE_READERS[source];
  let opened: number | null = null;
  try {
    opened = openSync(file, 'r');
    const size = fstatSync(opened).size;
    const start = Math.max(0, size - LEAD_SCAN_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(opened, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    // The first line is cut off when the read starts mid-line. It is the oldest one.
    if (start > 0) {
      const cut = text.indexOf('\n');
      text = cut === -1 ? '' : text.slice(cut + 1);
    }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const said = reader(record, tree).find((item) => item.kind === 'say');
      if (said?.text.trim()) return said.text;
    }
    return '';
  } catch {
    return '';
  } finally {
    if (opened !== null) closeSync(opened);
  }
}

/** The first non-empty line of the newest thing the agent said in `file`, or ''. */
export function lastAssistantLine(file: string, source: StreamSource, tree: string): string {
  return lastAssistantSay(file, source, tree).split('\n').map((part) => part.trim()).find(Boolean) ?? '';
}

/** The newest thing the agent said in `file`, or ''. The desk shows its first sentence. */
export function lastAssistantText(file: string, source: StreamSource, tree: string): string {
  return lastAssistantSay(file, source, tree).trim();
}

/** The newest Claude Code log of a worktree: its own sessions, or a subagent whose task names it. */
export function findClaudeLog(tree: string, env: Env, cache: LogCache, now: number = Date.now()): FoundLog | null {
  const registered = readLeadSession(tree, env);
  if (registered) return registered;
  const home = homeOf(env);
  if (!home) return null;
  const roots = claudeProjects(tree, home, env);
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

/** The worktree a Codex rollout names, from `session_meta`, or ''. The line shape is a guess. */
function codexRoot(head: string): string {
  for (const line of head.split('\n')) {
    if (!line.includes('session_meta')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const row = record as { type?: unknown; payload?: { cwd?: unknown } };
    if (row.type === 'session_meta' && typeof row.payload?.cwd === 'string') return row.payload.cwd;
  }
  return '';
}

/**
 * The newest Codex rollout of a worktree. Logs live in `$CODEX_HOME/sessions`, or
 * `~/.codex/sessions`, and in a desk's own `<worktree>.state/codex`. A rollout counts
 * when its `cwd` is the worktree.
 */
export function findCodexLog(tree: string, env: Env, cache: LogCache, now: number = Date.now()): FoundLog | null {
  const home = homeOf(env);
  if (!home) return null;
  const roots = [stateDir(env.CODEX_HOME, ['.codex'], home), join(`${tree}.state`, 'codex')];
  const found: FoundLog[] = [];
  for (const root of roots) {
    const sessions = join(root, 'sessions');
    const days = list(sessions)
      .filter((year) => /^\d{4}$/.test(year))
      .flatMap((year) => list(join(sessions, year)).flatMap((month) => list(join(sessions, year, month)).map((day) => join(sessions, year, month, day))))
      .sort()
      .slice(-DAY_LIMIT);
    for (const day of days) {
      for (const name of list(day)) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = join(day, name);
        const mtime = fileTime(file);
        if (mtime === null || now - mtime > RECENT_MS) continue;
        if (!cache.has(file)) {
          const cwd = codexRoot(readHead(file));
          if (!cwd) continue;
          cache.set(file, cwd);
        }
        if (cache.get(file) === tree) found.push({ source: 'codex', file, mtime });
      }
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
  codex: findCodexLog,
};

/**
 * The session log of the agent in `tree`, or null when there is none. A known vendor's
 * runtime is asked; any other vendor, or none, gets the newest log any runtime has there.
 * DeepSeek runs on the Codex CLI, so it reads a Codex rollout and no other log.
 */
export function findAgentLog(tree: string, vendor: string, env: Env, cache: LogCache): FoundLog | null {
  const key = vendor.trim().toLowerCase();
  if (key === 'deepseek' || key === 'deepseek-harness') return findCodexLog(tree, env, cache);
  const finder = Object.hasOwn(LOG_FINDERS, key) ? LOG_FINDERS[key] : null;
  if (finder) return finder(tree, env, cache);
  return newest([findClaudeLog(tree, env, cache), findMuseLog(tree, env, cache), findGrokLog(tree, env), findCodexLog(tree, env, cache)].filter((log): log is FoundLog => log !== null));
}
