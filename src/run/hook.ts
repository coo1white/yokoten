// The tool-call hook. Before an agent runs a command or edits a file, its runtime asks
// the hook; a finding stops the action, null lets it go.
//
// The hook knows nothing about any one runtime. An adapter in src/agents/ turns the
// runtime's own call into an `Action` first.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import module from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { type Config, DEFAULTS, type Env, type IgnoredPart, loadConfig } from '../rules/config.ts';
import { checkCommand, checkEdit, checkTeamEdit, checkWorkerMarkEdit, configFolder, DONE_WHEN_FILE, gitLinkAbove, realPath as real } from '../rules/guards.ts';
import { type Finding, finding, place } from '../rules/message.ts';
import { findEnvironmentValues, makeSecretHider, SECRET } from '../rules/privacy/secrets.ts';

/** The start of a docs link, so a refusal shows a short path instead of the whole URL. */
const DOCS_PREFIX = 'https://github.com/yokoten-labs/yokoten/blob/main/';
const noFullStop = (text: string): string => text.replace(/[.。\s]+$/, '');
const shortDocs = (url: string | undefined): string | undefined =>
  url === undefined ? undefined : url.startsWith(DOCS_PREFIX) ? url.slice(DOCS_PREFIX.length) : url;

/** The two languages a refusal speaks: English, or Simplified Chinese. */
export type RefusalLanguage = 'en' | 'zh-CN';

/** What the guard can read about the place before it writes a refusal. */
export interface RefusalContext {
  lang?: RefusalLanguage;
  /** The action comes from a worker: its way forward is its lead, not its owner. */
  worker?: boolean;
  /** The repo has a workflow that starts a release from a tag or a release event. */
  hasReleaseWorkflow?: boolean;
  /** The repo has a yokoten.json, so its own rules are on top of the safeguard. */
  hasConfig?: boolean;
  /** Why this session is a worker, when the mark set the role (#555). */
  workerNote?: string;
}

/** The two ways forward: a sentence the person says back, and a command or a step. */
interface RefusalWays {
  tell: string;
  run: string;
}

interface RefusalLabels {
  stopped: string;
  why: string;
  tell: string;
  tellLead: string;
  run: string;
  /** The quote around the sentence: plain ASCII, or the Chinese pair. */
  quote: [string, string];
  stop: string;
}

const REFUSAL_LABELS: Record<RefusalLanguage, RefusalLabels> = {
  en: {
    stopped: 'yokoten stopped this: ',
    why: 'Why: ',
    tell: 'Tell the AI: ',
    tellLead: 'Tell the lead: ',
    run: 'Or run it yourself: ',
    quote: ['"', '"'],
    stop: '.',
  },
  'zh-CN': {
    stopped: 'yokoten 拦下了这个动作：',
    why: '为什么：',
    tell: '告诉 AI：',
    tellLead: '告诉 lead：',
    run: '或者你自己运行：',
    quote: ['“', '”'],
    stop: '。',
  },
};

/** The language of the refusal: YOKOTEN_LANG first, then the usual locale variables. */
export function refusalLanguage(env: Env): RefusalLanguage {
  const tag = env.YOKOTEN_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '';
  return /^zh([-_]|$)/i.test(tag) ? 'zh-CN' : 'en';
}

/**
 * Whether the repo starts a release from a tag or a release event. A release workflow
 * means the tag you make starts a release; without one, the tag is just a tag. A read
 * that fails says nothing, so the refusal keeps its plain wording.
 */
export function hasReleaseWorkflow(root: string | null | undefined): boolean {
  if (root === null || root === undefined || root === '') return false;
  const folder = join(root, '.github', 'workflows');
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => /\.ya?ml$/i.test(name));
  } catch {
    return false;
  }
  return names.some((name) => {
    if (/release/i.test(name)) return true;
    try {
      const text = readFileSync(join(folder, name), 'utf8');
      return /^\s*release\s*:/m.test(text) || /^\s*tags\s*:/m.test(text);
    } catch {
      return false;
    }
  });
}

/** The tag a release finding stopped, when it names one. */
const stoppedTag = (what: string): string | undefined => /creating the tag (\S+)/.exec(what)?.[1];
/** The path an edit finding stopped, when it names one. */
const stoppedPath = (what: string): string | undefined =>
  /^(\S+) is (?:lead-only|a test file)/.exec(what)?.[1] ??
  /writes (\S+), which is lead-only/.exec(what)?.[1] ??
  /changes (\S+), which is lead-only/.exec(what)?.[1];

/** The command in a fix, when it holds one in backticks, or the general explanation. */
const commandInFix = (f: Finding): string => {
  const command = /`([^`]+)`/.exec(f.fix)?.[1];
  return command === undefined ? `yokoten explain ${f.id}` : command;
};

/**
 * The two ways forward that fit this finding (#816). A specific case names the real value
 * and its safe road; a case with no words of its own gets one plain sentence and the
 * explanation command. The refusal never bends: only its wording follows the case.
 */
function refusalWays(finding: Finding, context: RefusalContext): RefusalWays {
  const zh = context.lang === 'zh-CN';
  const worker = context.worker === true;
  const leadReport = (zhText: string, enText: string, run: string): RefusalWays => ({ tell: zh ? zhText : enText, run });

  switch (finding.id) {
    case 'release': {
      const tag = stoppedTag(finding.what);
      if (worker) {
        return {
          tell: zh ? '只有我的 lead 能决定什么时候发布；请把这件事报告给 lead。' : 'Only my lead decides when to release; report this to your lead.',
          run: `yokoten msg send lead "${zh ? '请检查这个发布请求' : 'please check this release request'}"`,
        };
      }
      if (/public repo|making the repo public/i.test(finding.what)) {
        return { tell: zh ? '这个仓库我自己来公开。' : 'I will make this repo public myself.', run: 'gh repo edit --visibility public' };
      }
      if (/publish(es)? a package|npm|pnpm|yarn/i.test(finding.what)) {
        return { tell: zh ? '这个软件包我自己来发布。' : 'I will publish this package myself.', run: 'npm publish' };
      }
      const push = /^(git push .+?) (?:pushes|publishes)\b/.exec(finding.what)?.[1];
      if (push !== undefined) return { tell: zh ? '这些 tag 我自己来推。' : 'I will push these tags myself.', run: push };
      if (tag !== undefined) return { tell: zh ? '这个版本我自己来发布。' : 'I will publish this release myself.', run: `git tag ${tag}` };
      if (/gh release/i.test(finding.what)) return { tell: zh ? '这次发布我自己来。' : 'I will publish this release myself.', run: 'gh release create <tag>' };
      return { tell: zh ? '这次发布我自己来。' : 'I will publish this release myself.', run: commandInFix(finding) };
    }
    case 'force-push':
      return worker
        ? leadReport(
            '不要把分支强推上去；请把这个分支交给 lead。',
            'Do not force push; report this branch to your lead.',
            `yokoten msg send lead "${zh ? '请检查这个分支再推送' : 'please check this branch before any push'}"`,
          )
        : {
            tell: zh ? '不要 force push；把我的工作推到新分支。' : 'Do not force push; put my work on a new branch instead.',
            run: 'git push origin HEAD:refs/heads/safe-copy',
          };
    case 'hard-reset':
      return {
        tell: zh ? '不要 hard reset；保留我没有提交的改动。' : 'Do not reset hard; keep my uncommitted work.',
        run: 'git stash',
      };
    case 'remove-git':
      return {
        tell: zh ? '不要删 .git；只删我指定的文件。' : 'Do not delete .git; delete only the file I named.',
        run: 'git rm <path>',
      };
    case 'delete-default-branch':
      return {
        tell: zh ? '不要删默认分支；只删我指定的分支。' : 'Do not delete the default branch; delete only the branch I named.',
        run: 'git branch -a',
      };
    case 'delete-checkout':
      return {
        tell: zh ? '不要删掉整个项目文件夹；告诉我你想删哪些文件。' : 'Do not delete the whole project folder; tell me which files you want removed.',
        run: 'git status',
      };
    case 'discard-work':
      return {
        tell: zh ? '不要丢掉没有提交的工作；先留着给我看。' : 'Do not throw away uncommitted work; keep it so I can look.',
        run: 'git stash',
      };
    case 'erase-history':
      return {
        tell: zh ? '不要清除历史记录；我可能还要用它撤销。' : 'Do not erase the history; I may need it to undo.',
        run: 'git log --oneline -5',
      };
    case 'move-default-branch':
      return {
        tell: zh ? '不要把主分支往回移；我可能要保留那些提交。' : 'Do not move the main branch back; I may need those commits.',
        run: 'git log --oneline -5',
      };
    case 'pipe-to-shell': {
      const url = /(?:https?|ftp):\/\/[^\s'"|;)]+/.exec(finding.what)?.[0];
      return {
        tell: zh ? '先把文件下载下来给我看，再运行。' : 'Download the file and show it to me before anything runs it.',
        run: url === undefined ? 'curl -fsSL <url> -o download.sh' : `curl -fsSL ${url} -o download.sh`,
      };
    }
    case 'skip-check':
      return {
        tell: zh ? '不要跳过提交检查；先修好它报告的问题。' : 'Do not skip the commit check; fix what it reports.',
        run: 'yokoten check',
      };
    case 'hooks-path':
      return {
        tell: zh ? '保留提交检查；我需要它。' : 'Leave the commit check on; I need it.',
        run: 'yokoten init',
      };
    case 'workflow-disable':
      return {
        tell: zh ? '别关掉这个 workflow；由我来决定。' : 'Leave the workflow on; I will decide.',
        run: 'gh workflow list',
      };
    case 'test-file': {
      const path = stoppedPath(finding.what) ?? '<test file>';
      return {
        tell: zh ? '不要改测试；改代码直到测试通过。' : 'Do not change the test; fix the code until the test passes.',
        run: `git diff -- ${path}`,
      };
    }
    case 'lead-only': {
      const path = stoppedPath(finding.what) ?? '<file>';
      if (worker) {
        return {
          tell: zh ? `这是 lead 的文件；请把它报告给 lead。` : 'This file belongs to my lead; report it to your lead.',
          run: `yokoten msg send lead "${zh ? `请修改 ${path}` : `please change ${path}`}"`,
        };
      }
      const noConfig = context.hasConfig === false;
      return {
        tell: noConfig
          ? zh
            ? '这个项目没有 yokoten.json，守桥用默认规则；规则或 CI 的改动由我自己来。'
            : 'This project has no yokoten.json, so the safeguard uses its defaults; I will make the change to the rules or CI myself.'
          : zh
            ? '这是 lead 专属文件；这个改动由我自己来。'
            : 'This file is lead-only; I will make this change myself.',
        run: `yokoten explain lead-only`,
      };
    }
    case 'worker-push':
      return {
        tell: zh ? '这是 worker；请把工作报告给 lead，由 lead 审查后推送。' : 'This is a worker; report the work to your lead, who reviews and pushes it.',
        run: `yokoten msg send lead "${zh ? '请审查并推送我的工作' : 'please review and push my work'}"`,
      };
    case 'worker-mark':
      return {
        tell: zh ? '不要动 worker 标记；请把这件事报告给 lead。' : 'Leave the worker mark alone; report this to your lead.',
        run: `yokoten msg send lead "${zh ? '请检查我的 worktree 标记' : 'please check my worktree mark'}"`,
      };
    case 'secret': {
      const file = finding.file ?? '<file>';
      return {
        tell: zh ? '把密钥移到 git 忽略的文件里，然后换掉这个密钥。' : 'Move the key to a file git ignores, then rotate it.',
        run: `git check-ignore -v ${file}`,
      };
    }
    case 'email':
    case 'ip':
    case 'private-mark':
      return {
        tell: zh ? '提交前把它换成占位内容。' : 'Replace it with a placeholder before you commit.',
        run: finding.file === undefined ? `yokoten explain ${finding.id}` : `git diff --cached -- ${finding.file}`,
      };
    case 'gh-token':
      return {
        tell: zh ? '不要把 token 打出来；让 gh 自己用，不显示它。' : 'Do not print the token; let gh use it without showing it.',
        run: 'gh auth status',
      };
    case 'alias':
      return {
        tell: zh ? '直接跑完整命令，不要用别名。' : 'Run the full command instead of an alias.',
        run: 'yokoten explain alias',
      };
    case 'blocked-command':
      return {
        tell: zh ? '不要运行这个程序；这个项目禁用了它。' : 'Do not run that program; this project blocks it.',
        run: 'yokoten explain blocked-command',
      };
    case 'unreadable-command':
      return {
        tell: zh ? '把它拆成几条更小的命令。' : 'Split it into simpler commands, one per call.',
        run: 'yokoten explain unreadable-command',
      };
    case 'run-remove':
      return {
        tell: zh ? '不要动这次 Actions 运行；告诉我你需要什么。' : 'Leave the Actions run alone; tell me what you need.',
        run: 'gh run list',
      };
    case 'private-output':
      return {
        tell: zh ? '把输出交给 yokoten redact 再给我看。' : 'Show me the output through yokoten redact.',
        run: commandInFix(finding),
      };
    case 'home-folder':
      return {
        tell: zh ? '不要改我的主目录；yokoten 要用它。' : 'Do not change my home folder; yokoten needs it.',
        run: 'yokoten explain home-folder',
      };
    default:
      return {
        tell: zh ? '我没有让你这样做；请先停下来，用简单的话解释给我听。' : 'I did not ask for that; stop and explain it to me in plain words.',
        run: `yokoten explain ${finding.id}`,
      };
  }
}

/** Why the refusal matters, with the project's own release path when the guard can read it. */
function refusalWhy(f: Finding, context: RefusalContext): string {
  if (f.id !== 'release' || stoppedTag(f.what) === undefined) return f.why;
  if (context.lang === 'zh-CN') {
    return context.hasReleaseWorkflow === true
      ? '打 tag 会启动一个需要你批准的发布，只有你能决定什么时候发布'
      : '打 tag 会发布一个版本，只有你能决定什么时候发布';
  }
  return context.hasReleaseWorkflow === true
    ? 'a tag starts a release you approve, and only you decide when to release'
    : 'a tag publishes a release, and only you decide when to release';
}

/**
 * A finding as the five lines a refusal prints (#816): what was stopped, why, the sentence
 * to say to the AI, the command to run yourself, and the rule id with its link last. Every
 * runtime's hook uses this one function, so a person reads the same plain words under
 * Claude Code, Codex, Grok and OpenCode. A secret in a field reads `<hidden>`, never the
 * secret.
 */
export function formatRefusal(finding: Finding, context: RefusalContext = {}): string {
  const lang = context.lang ?? 'en';
  const labels = REFUSAL_LABELS[lang];
  const plain = (text: string) => noFullStop(makeSecretHider()(text).replaceAll(SECRET, '<hidden>'));
  const docs = shortDocs(finding.docs);
  const ways = refusalWays(finding, context);
  const baseWhy = refusalWhy(finding, context);
  const why = context.workerNote === undefined ? baseWhy : `${baseWhy}; ${context.workerNote}`;
  const [open, close] = labels.quote;
  return [
    `${labels.stopped}${plain(`${place(finding)}${finding.what}`)}${labels.stop}`,
    `${labels.why}${plain(why)}${labels.stop}`,
    `${context.worker === true ? labels.tellLead : labels.tell}${open}${plain(ways.tell)}${labels.stop}${close}`,
    `${labels.run}${plain(ways.run)}`,
    `(rule ${finding.id}${docs === undefined ? '' : ` \u00b7 more: ${docs}`})`,
  ].join('\n');
}

/** What an agent is about to do, in no runtime's terms. */
export interface Action {
  /** A shell command, as the agent wrote it. */
  command?: string;
  /** Every command on one call, when it carries more than one. The guard refuses if any entry is refused. */
  commands?: string[];
  /** The files an edit touches, absolute or relative to `cwd`. */
  paths: string[];
  cwd?: string;
  /** The action comes from a worker, whatever the session's own role. */
  worker: boolean;
}

/**
 * An end-of-turn event, in no runtime's terms. Each adapter maps its own Stop (or
 * SubagentStop, AfterAgent) payload into this.
 */
export interface StopEvent {
  cwd?: string;
  /** A stop hook already sent the agent back (`stop_hook_active`). */
  active: boolean;
  /** The event comes from a worker subagent. */
  worker: boolean;
  /** The event is a subagent ending (Claude Code's SubagentStop), not the lead's own turn. */
  subagent: boolean;
  /** The session or subagent id, for the done-when try count. */
  sessionId?: string;
}

/**
 * A worker's agent type: exactly `worker`, or a name that ends with `:worker`
 * (such as `yokoten:worker`). A name that only contains those letters, such as
 * `coworker`, is not a worker (#614).
 */
export function isWorkerType(type: string): boolean {
  const name = type.toLowerCase();
  return name === 'worker' || name.endsWith(':worker');
}

/**
 * The shared Stop fields Claude Code, Codex, Muse, Gemini and Grok send (#614). An adapter
 * still decides whether the payload is a stop event at all.
 */
export function readStopFields(input: object): StopEvent {
  const call = input as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const type = text(call.agent_type) ?? text(call.agentType) ?? text(call.subagent_type) ?? text(call.subagentType) ?? '';
  const eventName = (text(call.hook_event_name) ?? text(call.hookEventName) ?? '').toLowerCase();
  return {
    cwd: text(call.cwd),
    active: call.stop_hook_active === true || call.stopHookActive === true,
    worker: isWorkerType(type),
    subagent: eventName === 'subagentstop',
    sessionId: text(call.agent_id) ?? text(call.agentId) ?? text(call.session_id) ?? text(call.sessionId),
  };
}

/**
 * How many times a worker is sent back for a failing check (#614). The next stop is
 * then allowed. The worker tells the lead the checks are failing. It never says done.
 */
export const DONE_TRY_LIMIT = 3;

/** How long the done-when command may run, in milliseconds. */
export const DONE_WHEN_MS = 120_000;

/** How long to wait for the last output after the shell exits, in milliseconds. */
const CLOSE_GRACE_MS = 200;

/** The file in a worktree's git folder that holds the task's done-when command. */
export { DONE_WHEN_FILE };

/**
 * The agent's status file, at a linked worktree's root. The lead reads it.
 * The board will show `checks` later (#603). The guide shows its fields.
 */
export const AGENT_STATUS_FILE = '.yokoten-agent.json';

/** The largest status file that is read. A bigger file is left unread. */
export const STATUS_TEXT_LIMIT = 64 * 1024;

/**
 * A marker in the checkout's git folder when the try count could not be saved (#614).
 * The same worker is let through for this long after that refusal.
 */
export const REFUSED_MARK_DIR = 'yokoten-stop-refused';
export const REFUSED_WINDOW_MS = 5 * 60 * 1000;

const DONE_OUTPUT_CHARS = 2000;
const DONE_OUTPUT_CAP = 256 * 1024;
/** Count files older than this are removed when a new one is written (#614). */
const COUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The done-when command from the brief (`YOKOTEN_DONE_WHEN` or the git-folder file), or undefined. */
export function readDoneWhen(env: Env, folder: string): string | undefined {
  const fromEnv = env.YOKOTEN_DONE_WHEN?.trim();
  if (fromEnv) return fromEnv;
  const link = gitLinkAbove(folder);
  if (!link) return undefined;
  // A broken link still fails closed: read the file on disk (#746). It runs, or the stop
  // refuses when it fails. Never the parent's file, and never a silent skip.
  const gitDir = link.kind === 'broken' ? join(link.top, '.git') : link.gitDir;
  try {
    const text = readFileSync(join(gitDir, DONE_WHEN_FILE), 'utf8');
    const line = text.split('\n').find((row) => {
      const trimmed = row.trim();
      return trimmed !== '' && !trimmed.startsWith('#');
    });
    return line?.trim();
  } catch {
    return undefined;
  }
}

/** A key for the done-when try count: the session id when it is a safe name, else a hash of `cwd`. */
export function doneTryKey(sessionId: string | undefined, cwd: string): string {
  if (sessionId && /^[\w-]{1,128}$/.test(sessionId)) return sessionId;
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

const triesPath = (env: Env, key: string): string | null => {
  const folder = configFolder(env);
  return folder ? join(folder, 'done-tries', key) : null;
};

/**
 * Add one to the worker's done-when try count and return it. Null when the count cannot
 * be kept (no config folder, or the file cannot be written): the caller must not trap the
 * session.
 */
export function bumpDoneTries(env: Env, key: string): number | null {
  const path = triesPath(env, key);
  if (!path) return null;
  let count = 0;
  try {
    count = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (!Number.isInteger(count) || count < 0) count = 0;
  } catch {
    count = 0;
  }
  count += 1;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${count}\n`);
  } catch {
    return null;
  }
  deleteOldCountFiles(dirname(path), basename(path));
  return count;
}

/** Drop count files in `dir` that are older than a day. `keepName` is the one just written. */
function deleteOldCountFiles(dir: string, keepName: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - COUNT_MAX_AGE_MS;
  for (const name of names) {
    if (name === keepName) continue;
    const path = join(dir, name);
    try {
      const stats = lstatSync(path);
      // A link is not a count file. Removing it by name would still be only the link,
      // but leave it: the count itself is a regular file.
      if (!stats.isFile() || stats.mtimeMs >= cutoff) continue;
      rmSync(path, { force: true });
    } catch {
      // An old count that cannot be removed must not trap the stop.
    }
  }
}

/**
 * Forget the worker's done-when try count, once the check passes or the worker is let
 * through. An error removing the file is ignored: it must not crash the hook (#614).
 */
export function clearDoneTries(env: Env, key: string): void {
  const path = triesPath(env, key);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // The count file can stay. The hook still ends the turn.
  }
}

/** The shell that runs a done-when command: `cmd.exe` on Windows, `sh` on every other system. */
export function doneWhenShell(): string {
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

/** Arguments for `taskkill` that stop `pid` and the programs it started, while that shell is still alive. */
export function windowsTreeKillArgs(pid: number): string[] {
  return ['/F', '/T', '/PID', String(pid)];
}

/**
 * Stop `pid` and the programs it started: the process group on POSIX, the tree on Windows.
 * On POSIX the group remains after the shell exits, so a kill then still stops what it
 * left behind (#641). On Windows, `taskkill /T` finds the tree only while the shell is
 * still running. `spawnSync`'s timeout kills `cmd.exe` first, and the tree would stay (#614).
 */
function killCommandTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', windowsTreeKillArgs(pid), { stdio: 'ignore', windowsHide: true });
      return;
    }
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process is already gone.
    }
  }
}

/** The path of the refusal marker for `key`, in the checkout's git folder, or null when there is none. */
export function refusedMarkerPath(folder: string, key: string): string | null {
  const link = gitLinkAbove(folder);
  if (!link || link.kind === 'broken') return null;
  return join(link.gitDir, REFUSED_MARK_DIR, key);
}

/** Whether `key` was refused in this checkout within the last five minutes. */
export function wasRefusedRecently(folder: string, key: string, now = Date.now()): boolean {
  const path = refusedMarkerPath(folder, key);
  if (!path) return false;
  try {
    const then = Date.parse(readFileSync(path, 'utf8').trim());
    if (!Number.isFinite(then)) return false;
    const age = now - then;
    return age >= 0 && age <= REFUSED_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Remember that `key` was refused now, so a later stop in the window can be let through. */
export function noteRefused(folder: string, key: string, now = new Date()): void {
  const path = refusedMarkerPath(folder, key);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeReplacing(path, `${now.toISOString()}\n`);
  } catch {
    // The next stop cannot see this refusal. stop_hook_active is the other way out.
  }
}

/** Forget a refusal marker. A pass starts the next failure from a real refusal. */
export function clearRefusedMarker(folder: string, key: string): void {
  const path = refusedMarkerPath(folder, key);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // A marker that stays only widens the allow window.
  }
}

/**
 * Write `body` over `path` without following a link. A temp file in the same folder
 * is renamed onto the name, which replaces a link and does not open its target.
 */
function writeReplacing(path: string, body: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, body, { flag: 'wx' });
    try {
      renameSync(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can refuse to rename onto a name that exists. Removing the name
      // drops a link. It does not change the link's target.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
      rmSync(path, { force: true });
      renameSync(temp, path);
    }
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file can stay. The caller still hears the original error.
    }
    throw error;
  }
}

/** Whether `opened` is the file `listed` saw. `dev` and `ino` both have to match. */
export function isSameFile(listed: { dev: number; ino: number }, opened: { dev: number; ino: number }): boolean {
  return listed.dev === opened.dev && listed.ino === opened.ino;
}

/**
 * Why a status file was not read. The words are plain, for the warning on stderr.
 */
export type StatusRefusal = 'too large' | 'cannot be read' | 'changed while it was read';

/** The text of a status file, or the reason it was refused. */
export type StatusReadResult = { text: string } | { refused: StatusRefusal };

/**
 * Read a regular status file, or say why it was refused. A link is not opened. The
 * open does not wait on a pipe. The open file is checked before any byte is read. It
 * must be the same file the list saw, and it must be under the size cap. Windows has
 * no `O_NOFOLLOW`, so that check compares `dev` and `ino`. `openFile` opens the path.
 * A test passes one that opens another file.
 */
export function readStatusResult(path: string, openFile: (file: string, flags: number) => number = openSync): StatusReadResult {
  let listed: { dev: number; ino: number };
  try {
    const before = lstatSync(path);
    if (!before.isFile()) return { refused: 'cannot be read' };
    listed = { dev: before.dev, ino: before.ino };
  } catch {
    return { refused: 'cannot be read' };
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number | undefined;
  try {
    try {
      fd = openFile(path, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { refused: code === 'ENOENT' || code === 'ELOOP' ? 'changed while it was read' : 'cannot be read' };
    }
    const opened = fstatSync(fd);
    if (!opened.isFile() || !isSameFile(listed, opened)) return { refused: 'changed while it was read' };
    if (opened.size > STATUS_TEXT_LIMIT) return { refused: 'too large' };
    const buffer = Buffer.alloc(opened.size);
    const count = readSync(fd, buffer, 0, opened.size, 0);
    if (count !== opened.size) return { refused: 'changed while it was read' };
    return { text: buffer.toString('utf8', 0, count) };
  } catch {
    return { refused: 'cannot be read' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The text of a regular status file, or null when it was refused. */
export function readStatusText(path: string, openFile: (file: string, flags: number) => number = openSync): string | null {
  const result = readStatusResult(path, openFile);
  return 'text' in result ? result.text : null;
}

/** One warning line for a refused status file. It never contains the file's text. */
function statusRefusalLine(reason: StatusRefusal): string {
  const phrase = reason === 'too large' ? 'is too large' : reason;
  return `yokoten: ${AGENT_STATUS_FILE} ${phrase}, so it was left unchanged.\n`;
}

function parseStatus(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the new checks replace it.
  }
  return {};
}

/**
 * Record `checks` in `.yokoten-agent.json` at `folder`. Other fields stay. `updated` is UTC.
 * A refused status file is left unchanged and named on `warn` in one line. That
 * includes a link or other non-file, a file over the size cap, a file that cannot be
 * read, and a file that changed while it was read.
 * The bytes go to a temp file in the same folder and are renamed over the path, so a
 * link that appears in between is replaced and never followed. A file that cannot be
 * written does not crash the hook.
 */
export function writeAgentChecks(folder: string, checks: 'failing' | 'passing', now: Date, warn: (line: string) => void): void {
  const path = join(folder, AGENT_STATUS_FILE);
  let status: Record<string, unknown> = {};
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) {
      warn(`yokoten: ${AGENT_STATUS_FILE} is not a regular file, so it was left unchanged.\n`);
      return;
    }
    const result = readStatusResult(path);
    if ('refused' in result) {
      warn(statusRefusalLine(result.refused));
      return;
    }
    status = parseStatus(result.text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(statusRefusalLine('cannot be read'));
      return;
    }
  }
  status.checks = checks;
  status.updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    writeReplacing(path, `${JSON.stringify(status, null, 2)}\n`);
  } catch {
    // The worker's own message still tells the lead. A locked file must not trap the stop.
  }
}

/** How often an allowed tool call rewrites the status file, at most (#685). */
export const STATUS_EVERY_MS = 5000;
/** The file in a desk clone's git folder that says it is a desk (#685). `yokoten desk` writes it. */
export const DESK_FILE = 'yokoten-desk';
/** The file in a repo's shared git folder that lists its desks, one path a line (#685). */
export const DESK_LIST_FILE = 'yokoten-desks';

/** One checkout an agent works in: its root, its own git folder, and the shared git folder of all its worktrees. */
export interface StatusCheckout {
  top: string;
  gitDir: string;
  common: string;
  /** A main checkout or a plain clone, not a linked worktree. */
  isMain: boolean;
  /** A clone that `yokoten desk` set up. */
  isDesk: boolean;
}

/**
 * The checkout at or above `folder` whose status file the hooks keep (#685), or null. It
 * must hold `yokoten.json`, so a repo that does not use yokoten never gets the file.
 * The folder's real path is used, so a link out of it names no other checkout.
 */
export function findStatusCheckout(folder: string): StatusCheckout | null {
  let link: ReturnType<typeof gitLinkAbove>;
  try {
    link = gitLinkAbove(real(folder));
  } catch {
    return null;
  }
  if (!link || link.kind === 'broken' || !existsSync(join(link.top, 'yokoten.json'))) return null;
  if (link.kind === 'folder') return { top: link.top, gitDir: link.gitDir, common: link.gitDir, isMain: true, isDesk: existsSync(join(link.gitDir, DESK_FILE)) };
  return { top: link.top, gitDir: link.gitDir, common: commonGitDir(link.top) ?? link.gitDir, isMain: false, isDesk: false };
}

/**
 * Whether a session may keep the status file of `checkout`: the main checkout's file is
 * the lead's, so a worker writes only in its own worktree or desk.
 */
export const canKeepStatus = (checkout: StatusCheckout, isWorker: boolean): boolean => !isWorker || !checkout.isMain || checkout.isDesk;

/** Add the status file to the repo's own exclude list once, so `git status` never shows it, even without a `.gitignore` line. */
function excludeStatusFile(common: string): void {
  const path = join(common, 'info', 'exclude');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // No exclude file yet: it is made below.
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === AGENT_STATUS_FILE || line.trim() === `/${AGENT_STATUS_FILE}`)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# yokoten board: each agent's live status (#685)\n${AGENT_STATUS_FILE}\n`);
}

/** A change to a status file: `set` replaces fields (null removes one), `fill` sets fields only where they are missing. */
export interface StatusChange {
  set?: Record<string, string | null>;
  fill?: Record<string, string>;
  /** Skip the write when the file changed less than this long ago. A new file is always written. */
  throttleMs?: number;
}

/**
 * Change the agent's status file at `checkout`'s root (#685). Other fields stay, so an
 * agent's own `task` or `question` is kept. `updated` is UTC. A link or any other non-file
 * is left unchanged. The write replaces the file through a temp file, as writeAgentChecks
 * does. Returns whether it wrote; it never throws, so the hook never fails on it.
 */
export function changeAgentStatus(checkout: StatusCheckout, change: StatusChange, now: Date = new Date()): boolean {
  const path = join(checkout.top, AGENT_STATUS_FILE);
  try {
    let status: Record<string, unknown> = {};
    let isNew = false;
    try {
      const stats = lstatSync(path);
      if (!stats.isFile()) return false;
      if (change.throttleMs && now.getTime() - stats.mtimeMs < change.throttleMs) return false;
      status = parseStatus(readStatusText(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      isNew = true;
    }
    for (const [name, value] of Object.entries(change.fill ?? {})) if (typeof status[name] !== 'string' || !status[name]) status[name] = value;
    for (const [name, value] of Object.entries(change.set ?? {})) {
      if (value === null) delete status[name];
      else status[name] = value;
    }
    status.updated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (isNew) excludeStatusFile(checkout.common);
    writeReplacing(path, `${JSON.stringify(status, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The shared git folder of the checkout at or above `folder`, with no git process, or null outside one. */
export function commonGitDir(folder: string): string | null {
  const link = gitLinkAbove(folder);
  if (!link || link.kind === 'broken') return null;
  if (link.kind === 'folder') return link.gitDir;
  try {
    return resolve(link.gitDir, readFileSync(join(link.gitDir, 'commondir'), 'utf8').trim());
  } catch {
    return link.gitDir;
  }
}

/**
 * Note a desk clone for the board (#685): a mark in the desk's own git folder, so its
 * hooks keep a status file there, and its path on the list in the lead's repo, so the
 * board shows it though `git worktree list` does not. Returns why it could not, or ''.
 */
export function registerDesk(leadFolder: string, desk: string): string {
  const deskGit = join(desk, '.git');
  try {
    if (!lstatSync(deskGit).isDirectory()) return 'the desk is not a plain clone';
    writeFileSync(join(deskGit, DESK_FILE), 'A desk that yokoten desk started: its agent shows on the lead\'s board.\n');
  } catch {
    return 'the desk has no git folder yet';
  }
  const common = commonGitDir(leadFolder);
  if (!common) return 'the lead is not in a repo';
  const list = join(common, DESK_LIST_FILE);
  try {
    let text = '';
    try {
      text = readFileSync(list, 'utf8');
    } catch {
      // The first desk makes the list.
    }
    const paths = text.split('\n').filter((line) => line && existsSync(line));
    if (!paths.includes(desk)) paths.push(desk);
    writeFileSync(list, `${paths.join('\n')}\n`);
  } catch {
    return 'the desk list can\'t be written';
  }
  return '';
}

/** The fields a session starts with: who runs, in which role, where, when it started, and that it works. */
export function startFields(vendor: string, isWorker: boolean, checkout: StatusCheckout, model: string): { set: Record<string, string>; fill: Record<string, string> } {
  return {
    set: { vendor, state: 'working', ...(model ? { model } : {}) },
    // `started` is set once. Later writes keep it, so the timeline bar does not move.
    fill: { role: isWorker ? 'engineer' : 'lead', worktree: checkout.top, started: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
  };
}

/** What a tool call does, in a few words for the board: the program it runs, or the file it edits. Secrets are hidden. */
export function describeAction(action: Action): string {
  if (action.command !== undefined) {
    const words = action.command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const shown = words.slice(0, 2).map((word) => word.replace(/['"`]/g, '').slice(0, 40)).filter(Boolean);
    return shown.length ? makeSecretHider()(`running ${shown.join(' ')}`) : '';
  }
  const [path] = action.paths;
  return path ? makeSecretHider()(`editing ${basename(path)}`.slice(0, 80)) : '';
}

/** The last `DONE_OUTPUT_CHARS` of `text`, with secrets and the real values of secret-looking variables in `env` replaced (#616). */
export function shortenOutput(text: string, env: Env = {}): string {
  let hidden = makeSecretHider()(text.replace(/\s+$/, ''));
  for (const value of findEnvironmentValues(env)) hidden = hidden.replaceAll(value, SECRET);
  if (hidden.length <= DONE_OUTPUT_CHARS) return hidden;
  const cut = hidden.slice(hidden.length - DONE_OUTPUT_CHARS);
  const newline = cut.indexOf('\n');
  return newline >= 0 ? cut.slice(newline + 1) : cut;
}

/**
 * Run the task's done-when command in `cwd`. `ok` is true only on exit 0. The output is
 * short, with secrets hidden, for the worker to read.
 *
 * The command is started with `spawn`, and a timer in this process stops it. That timer
 * runs while the shell is still alive. On Windows it calls `taskkill /F /T /PID` then.
 * `spawnSync`'s timeout would have killed `cmd.exe` first, and the tree would stay (#614).
 * When the shell exits, programs still in its group are stopped the same way. The check
 * ends on the shell's own result. A short wait collects the last output, then the pipes
 * are dropped. A program that left the group is not stopped, and it cannot hold the
 * check open. The result is given once.
 */
export function runDoneWhen(
  command: string,
  cwd: string,
  env: Env,
  timeoutMs: number = DONE_WHEN_MS,
  killTree: (pid: number) => void = killCommandTree,
): Promise<{ ok: boolean; output: string }> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) childEnv[name] = value;
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { ok: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolvePromise(value);
    };
    let child: ChildProcess;
    try {
      // A new process group on POSIX, so a timeout or a normal exit can stop what the shell started.
      // Windows stays in this process's tree: `taskkill /T` follows the parent, not a group.
      child = spawn(command, {
        shell: doneWhenShell(),
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, output: shortenOutput((error as Error).message.split('\n')[0], env) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (have: string, chunk: string) => (have.length >= DONE_OUTPUT_CAP ? have : (have + chunk).slice(0, DONE_OUTPUT_CAP));
    const stoppedOutput = (output: string) => shortenOutput(output ? `${output}\nthe check ran too long and was stopped` : 'the check ran too long and was stopped', env);
    const resultFor = (code: number | null, signal: NodeJS.Signals | null) => {
      const output = `${stderr}${stdout}`.trimEnd();
      if (timedOut || signal === 'SIGTERM') return { ok: false, output: stoppedOutput(output) };
      const body = shortenOutput(output, env);
      if (code === 0) return { ok: true, output: body };
      return { ok: false, output: body || `the check exited ${code}` };
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = take(stderr, chunk);
    });
    // Drop our end of the pipes. A grandchild that left the group can hold the other end.
    const dropPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) killTree(child.pid);
        dropPipes();
      } catch {
        // The tree kill can throw. The check still ends below.
      } finally {
        finish(resultFor(null, null));
      }
    }, timeoutMs);
    child.once('error', (error) => finish({ ok: false, output: shortenOutput(error.message.split('\n')[0], env) }));
    child.once('exit', (code, signal) => {
      if (settled || timedOut) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // The shell has exited. Stop programs still in its group. A program that
      // called setsid is in another group, so this does not reach it (#641).
      try {
        if (child.pid) killTree(child.pid);
      } catch {
        // The tree kill can throw. The check still ends on the shell's status.
      }
      if (settled) return;
      grace = setTimeout(() => {
        try {
          dropPipes();
        } finally {
          finish(resultFor(code, signal));
        }
      }, CLOSE_GRACE_MS);
    });
    child.once('close', (status, signal) => finish(resultFor(status, signal)));
  });
}

/** A repo whose file rules apply to an edit: its root, and the config read there. */
export interface Repo {
  root: string;
  config: Config;
}

/**
 * The config the hook works with: the repo's yokoten.json, or the defaults outside a repo.
 * The hook never fails open on its own config (#218): a file it cannot read gives the
 * defaults, and a key with the wrong shape gives only that key's default (#192, #228).
 * The core checks still run, and `warn` gets one line for each part it ignored, with why.
 */
export function loadHookConfig(root: string | null, warn: (line: string) => void): Config {
  if (!root) return DEFAULTS;
  return loadConfig(root, { onProblem: (problem, ignored) => warn(`yokoten hook: ${sayIgnored(ignored)}; the core checks still run. ${problem}`) });
}

const sayIgnored = (ignored: IgnoredPart) =>
  ignored === 'file' ? 'yokoten.json was ignored, so the defaults apply' : `yokoten.json "${ignored}" was ignored, so its default applies`;

/**
 * Why to stop the action (what, why, fix), or null. `root` is the session's repo root, or
 * null outside a repo. `commandsOnly` is the user-level hook: it runs in every repo, so it
 * keeps to the rules that hold everywhere (no tag pushes, no force pushes, no skipped
 * checks), and applies file rules only through `repos`.
 *
 * `repos` are the yokoten repos (with a `yokoten.json`) the edit's files are in (#307): a
 * worktree in another folder, or a session started above the repo, loads no project hook,
 * yet still gets the file's own repo's file rules. A file takes the rules of the deepest
 * repo that holds it.
 *
 * `cwd` is the folder the hook runs in, for an action that names no folder and has no root.
 */
export function judge(
  action: Action,
  { root, config, env, cwd, commandsOnly = false, repos = [] }: { root: string | null; config: Config; env: Env; cwd: string; commandsOnly?: boolean; repos?: Repo[] },
): Finding | null {
  // Set before the command check: the lead-only check on shell writes reads it (#402).
  if (action.worker) env = { ...env, YOKOTEN_ROLE: 'worker' };
  // The repos whose file rules apply: to an edit's files, and to a worker's shell writes (#402).
  const ruled = commandsOnly || !root ? repos : [{ root, config }, ...repos];
  // A command may also edit files (Codex runs apply_patch through the shell): check both.
  // The command runs in the call's folder: a hooks setting is judged in that repo (#217).
  // Every command the call carries is judged: `commands` and `command` both, so an empty list never hides one.
  const commands = [...(action.commands ?? []), ...(action.command !== undefined && !action.commands?.includes(action.command) ? [action.command] : [])];
  if (commands.length > 0) {
    // Titles follow a project's own rules: only its hook checks them, never the user-level one (#391).
    const titles = !commandsOnly && root !== null && existsSync(join(root, 'yokoten.json'));
    const ruledRepos = ruled.map((repo) => ({ root: repo.root, leadOnly: repo.config.leadOnly }));
    for (const command of commands) {
      const reason = checkCommand(command, { env, config, cwd: action.cwd ?? root ?? cwd, titles, repos: ruledRepos });
      if (reason) return reason;
    }
  }
  // A worker's edit inside a git folder may change the worker mark (#555), in any repo;
  // one inside a team folder may speak for another agent (#674);
  // one inside yokoten's config folder may change the worker list (#591).
  if (env.YOKOTEN_ROLE === 'worker') {
    const folder = resolve(action.cwd ?? root ?? cwd);
    for (const p of action.paths) {
      const reason = checkWorkerMarkEdit(resolve(folder, p), folder, env) ?? checkTeamEdit(resolve(folder, p));
      if (reason) return reason;
    }
  }
  if (!ruled.length) return null;
  const reals = ruled.map((repo) => ({ config: repo.config, real: real(repo.root) }));
  for (const p of action.paths) {
    const file = real(resolve(action.cwd ?? root ?? cwd, p));
    let best: { rel: string; config: Config } | null = null;
    for (const repo of reals) {
      const rel = relative(repo.real, file);
      // A file outside the repo is not this repo's business.
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
      if (!best || rel.length < best.rel.length) best = { rel, config: repo.config };
    }
    if (!best) continue;
    const reason = checkEdit(best.rel.split(sep).join('/'), { config: best.config, env });
    if (reason) return reason;
  }
  return null;
}

/** How long the guard may read one tool call. YOKOTEN_GUARD_DEADLINE_MS changes it. */
export const GUARD_DEADLINE_MS = 5000;
/** The most YOKOTEN_GUARD_DEADLINE_MS may set: well under the runtimes' own hook timeouts, which let the call through. */
export const GUARD_DEADLINE_MAX_MS = 30_000;

/**
 * The deadline YOKOTEN_GUARD_DEADLINE_MS asks for, in whole milliseconds. Anything else
 * (empty, 0, a sign, a fraction, hex, words) keeps the default, and a value past the cap
 * is cut to it, so the setting can never turn the deadline off.
 */
export function guardDeadline(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return GUARD_DEADLINE_MS;
  const ms = Number(value);
  return ms > 0 ? Math.min(ms, GUARD_DEADLINE_MAX_MS) : GUARD_DEADLINE_MS;
}

type JudgeOptions = Parameters<typeof judge>[1];

// A worker does not share the main thread's compile cache, so it turns the cache on
// itself, in the main thread's folder (bin/yokoten.mjs), then loads this module (#286).
// It starts as plain JavaScript: this module's imports are compiled before any of its
// code runs, and the cache must be on by then. An error from the cache is ignored, as in
// bin/yokoten.mjs.
const workerStart = (cacheDir = module.getCompileCacheDir?.()) => `
const { enableCompileCache } = require('node:module');
try { enableCompileCache?.(${cacheDir === undefined ? '' : JSON.stringify(cacheDir)}); } catch {}
import(${JSON.stringify(import.meta.url)});
`;

/** The guard worker's stack, in MB: about the main thread's. */
const WORKER_STACK_MB = 1;

/** A guard worker, started before the tool call is read (`startGuard`). */
export interface Guard {
  /** `judge` in the worker, with a deadline: see `judgeWithDeadline`. Call it once. */
  judge(action: Action, options: JudgeOptions, deadlineMs: number): Promise<Finding | null>;
}

/**
 * Start the guard's worker now, before the tool call is known (#408). A worker takes tens
 * of milliseconds to start, as long as the rest of the hook; started first, it starts
 * while the hook loads and reads the call. It does not keep the process alive until
 * `judge` is called, so a hook that ends early (a usage error, no tool call) just exits.
 * A failure before `judge` is kept, and `judge` refuses the call with it.
 */
export function startGuard(): Guard {
  // The main thread's stack (V8's default, just under 1 MB), not a worker's default 4 MB:
  // the guard reads a command the same way in the worker as in `judge`, so a command too
  // deep to read there is refused here too, not let through.
  const worker = new Worker(workerStart(), { eval: true, workerData: { yokotenJudge: true }, resourceLimits: { stackSizeMb: WORKER_STACK_MB } });
  worker.unref();
  let ended: string | null = null;
  let onEnd: (what: string) => void = () => {};
  const end = (what: string) => {
    ended ??= what;
    onEnd(what);
  };
  worker.once('error', (err) => end(`the guard failed while reading this tool call: ${err.message}`));
  worker.once('exit', (code) => end(`the guard stopped (exit ${code}) before it read this tool call`));
  return {
    judge: (action, options, deadlineMs) =>
      new Promise((settle) => {
        let done = false;
        const finish = (found: Finding | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          settle(found);
          void worker.terminate();
        };
        const timer = setTimeout(() => finish(lateFinding(action, deadlineMs)), deadlineMs);
        if (ended !== null) return finish(unreadable(ended));
        onEnd = (what) => finish(unreadable(what));
        worker.once('message', (found: Finding | null) => finish(found));
        worker.ref();
        // Plain data only: process.env does not cross to a worker as it is.
        worker.postMessage({ action, options: { ...options, env: { ...options.env } } });
      }),
  };
}

// The worker bin/yokoten.mjs starts before it loads the command, for `takeGuard`.
let early: Guard | null = null;

/** Start the guard's worker for the tool call to come, before anything else loads; `takeGuard` hands it on. */
export function startGuardEarly(): void {
  early ??= startGuard();
}

/**
 * The worker `startGuardEarly` started, once, or undefined when none was: `judgeWithDeadline`
 * then starts one only when it judges. A command run in-process, as in a test, starts none early.
 */
export function takeGuard(): Guard | undefined {
  const guard = early ?? undefined;
  early = null;
  return guard;
}

/**
 * `judge`, in a worker thread, with a deadline. The runtimes let a tool call through when
 * the hook runs past their own timeout, so a slow guard would open the gate. A timer in
 * the same thread never fires while the guard reads, so the guard runs in a worker that
 * can be stopped. Past the deadline, or when the worker fails, the call is refused. The
 * deadline runs from this call; a worker from `startGuard` may have started before it.
 */
export function judgeWithDeadline(action: Action, options: JudgeOptions, deadlineMs: number, guard: Guard = startGuard()): Promise<Finding | null> {
  return guard.judge(action, options, deadlineMs);
}

/** The finding when the guard reads an action past its deadline. */
export const lateFinding = (action: Action, deadlineMs: number): Finding => unreadable(`the guard took longer than ${deadlineMs} ms to read this ${action.command === undefined ? 'edit' : 'command'}`);
const unreadable = (what: string): Finding => finding('unreadable-command', what, 'split the command into smaller ones');

// The guard worker loads this file alone. This layer cannot import the host layer
// (record 0004). Load the host command list before the worker reads a call.
await import('../host/gh-commands.ts');

// The worker's side: wait for one action, judge it and send the finding back.
if (!isMainThread && parentPort && workerData?.yokotenJudge) {
  const port = parentPort;
  port.once('message', ({ action, options }: { action: Action; options: JudgeOptions }) => port.postMessage(judge(action, options)));
}
