// `yokoten board` (#601, #603): serves the team board on this machine only.
//
// The page is at /, its data as JSON at /data. The data comes from three places: one status
// file per worktree, `gh pr list` and `gh issue list`, and `git worktree list`. /data reads
// the local parts each time and never waits for gh: gh reads in the background, one read at
// a time, and /data serves its last lists (#688). /feed sends one agent's session log, masked,
// from the page's cursor on (#694). `board --text` prints the same data. A request needs the right Host and the link's token. Agents write the status files,
// so the page treats every word in them as text: a strict content policy lets only the
// page's own script run.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ghIn, ghLaterIn, type GhLater, readBoardPullsLater, repoOf } from '../../../host/github/index.ts';
import { type Env } from '../../../rules/config.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { commonGitDir } from '../../../run/hook.ts';
import { readOriginUrl } from '../../../setup/plan.ts';
import { type Invocation, parse, print, requireRoot, usage } from '../../shared.ts';
import { BOARD_READ_TIMEOUT_MS, boardHome, readBoardWorktrees } from './agents.ts';
import { type BoardControls, collectBoardWaiting, createBoardControls, readBoardAttention, readBoardIssuesLater, readBoardSnapshot, readBoardStartAsk, setBoardLimits, startBoardAgent, stopBoardAgent } from './controls.ts';
import { feedAnswer, makeFeedStreams } from './feed/route.ts';
import { feedsJson, makeFeedStore, recordFeed } from './feed/steps.ts';
import { boardPage, BOARD_REFRESH_SECONDS } from './page/page.ts';
import { renderBoardText } from './text.ts';
import { BOARD_NO_REMOTE_ISSUES, BOARD_NO_REMOTE_PULLS, type BoardGitHub, collectBoard, collectBoardWith, createBoardGitHub, refreshBoardGitHub } from './view.ts';

/** How many random bytes the board link's token holds, and each page's script nonce. */
const BOARD_TOKEN_BYTES = 16;

/** The content policy: nothing loads from outside, and only the script with this page's nonce runs. */
function contentPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** One answer of the board server: the status, the kind, and the text. Nothing is stored, and the page sends no referrer. */
function serveText(res: ServerResponse, status: number, kind: string, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': kind,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/**
 * True when the Host header names this server: 127.0.0.1:<port> or localhost:<port>.
 * Any other host is a rebound name, and gets a 403, so a page open in the same
 * browser cannot read the board through another name for this machine.
 */
function isBoardHost(host: string | undefined, port: number, name: string): boolean {
  const clean = (host ?? '').trim().toLowerCase();
  return clean === `127.0.0.1:${port}` || clean === `localhost:${port}` || clean === `${name}:${port}`;
}

/** The cookie that keeps the board's token after the first visit, so the address stays clean (#693). */
const BOARD_COOKIE = 'yokoten_board';
/** The first port of the range the board takes its stable port from (#693). */
const BOARD_PORT_BASE = 41000;
const BOARD_PORT_RANGE = 1000;
/** The file in the repo's git folder that keeps the board's token between runs, so a bookmark keeps working. */
const BOARD_TOKEN_FILE = 'yokoten-board-token';

/** The board's host name: the repo folder under .localhost, which browsers send to this machine (#693). */
export function boardHostName(root: string): string {
  const name = basename(boardHome(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return `${name || 'board'}.localhost`;
}

/** A port that stays the same for a repo, from its path, so the address can be bookmarked (#693). */
export function boardPort(root: string): number {
  return BOARD_PORT_BASE + (createHash('sha256').update(boardHome(root)).digest().readUInt16BE(0) % BOARD_PORT_RANGE);
}

/**
 * The board's token: kept in the repo's git folder, readable only by this user, so the
 * cookie and a bookmark keep working after a restart. A new random one when it can't be kept.
 */
function boardToken(root: string): string {
  const common = commonGitDir(root);
  if (!common) return randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  const file = join(common, BOARD_TOKEN_FILE);
  try {
    const kept = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(kept)) return kept;
  } catch {
    // No token kept yet: make one below.
  }
  const token = randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  try {
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // It can't be kept: this run still works, with a token of its own.
  }
  return token;
}

/** The token a request carries: ?t= when given, else the board's cookie. */
function requestToken(query: string, cookie: string | undefined): string | null {
  const given = new URLSearchParams(query).get('t');
  if (given) return given;
  for (const part of (cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === BOARD_COOKIE) return value.join('=');
  }
  return null;
}

/** True when the given token matches, compared in constant time. A missing token, or one of another length, never reaches the compare. */
function isBoardToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const guess = Buffer.from(given, 'utf8');
  const want = Buffer.from(token, 'utf8');
  return guess.length === want.length && timingSafeEqual(guess, want);
}

/**
 * True when the Origin names this page: 127.0.0.1:<port> or localhost:<port>. A change
 * without the page's Origin gets a 403, so a page elsewhere cannot start or stop agents
 * through this board.
 */
function isBoardOrigin(origin: string | undefined, port: number, name: string): boolean {
  const clean = (origin ?? '').trim().toLowerCase();
  return clean === `http://127.0.0.1:${port}` || clean === `http://localhost:${port}` || clean === `http://${name}:${port}`;
}

/** The most of a change request the board reads. */
const BOARD_BODY_LIMIT = 64 * 1024;

/** One request body, or null when it is too large to read. */
function readBoardBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((done) => {
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stop = (body: string | null) => {
      if (settled) return;
      settled = true;
      done(body);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BOARD_BODY_LIMIT) {
        req.destroy();
        stop(null);
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => stop(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => stop(null));
  });
}

/**
 * One change request as fields: JSON, or a form. Null when the kind is JSON but the
 * text is not. The page sends a form, so it never builds raw JSON.
 */
function boardFields(text: string, kind: string | undefined): Record<string, string> | null {
  if ((kind ?? '').split(';')[0].trim().toLowerCase() === 'application/json') {
    try {
      const parsed: unknown = JSON.parse(text || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) fields[key] = typeof value === 'string' ? value : '';
      return fields;
    } catch {
      return null;
    }
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) fields[key] = value;
  return fields;
}

/** The status for a refused start: over the limit is a conflict, a failed spawn is the server, the rest is the request. */
function startRefuseStatus(reason: string): number {
  if (reason.startsWith('the board already runs')) return 409;
  if (reason.startsWith('the board could not')) return 500;
  return 400;
}

/** The status for a refused stop: unknown is missing, done is a conflict, the rest is the request. */
function stopRefuseStatus(reason: string): number {
  if (reason.startsWith('no agent called') || reason === 'name the agent to stop') return 404;
  if (reason.endsWith('already stopped')) return 409;
  return 400;
}

/** What the options carry: the board's controls, and what it last read from GitHub. Tests pass their own. */
export interface BoardServerOptions {
  controls?: BoardControls;
  github?: BoardGitHub;
  /** The mask for /feed. Tests pass their own; the board builds it from the private marks. */
  feedMask?: (text: string) => string;
  /** The port to listen on; the stable port of the repo when left out, 0 for any free one. */
  port?: number;
  /** The token; kept in the repo's git folder when left out. */
  token?: string;
}

/** The /data fields that say how fresh the GitHub lists are: reading now, when last read, and why the last read failed. */
function githubState(github: BoardGitHub | null): { isReading: boolean; readAt: string; failed: string } {
  return github ? { isReading: github.reading !== null, readAt: github.readAt, failed: github.failed } : { isReading: false, readAt: '', failed: '' };
}

/**
 * Start the board on 127.0.0.1 and a free port: the page at /, the data as JSON at
 * /data, and the owner's changes at /agents/start, /agents/stop and /agents/limits.
 * Resolves with the server and its link, which holds a random token; rejects when the
 * server cannot listen. The caller stops it with server.close. A request whose Host is
 * not this server, or whose token is missing or wrong, gets a 403. A change whose
 * Origin is not the page gets a 403 too. gh reads the pull requests and issues in the
 * background: the first read starts now, and /data never waits for it.
 */
export function startBoardServer(root: string, env: Env, gh: GhLater, options: BoardServerOptions = {}): Promise<{ server: Server; url: string }> {
  const token = options.token ?? boardToken(root);
  const name = boardHostName(root);
  const controls = options.controls ?? createBoardControls(join(root, '.yokoten-board.log'));
  const github = options.github ?? createBoardGitHub();
  const stopReads = new AbortController();
  // The GitHub repo, or null without a GitHub remote. Starts a background read when the lists are old.
  const refreshGitHub = (): string | null => {
    const remote = repoOf(readOriginUrl(root, env));
    if (!remote) return null;
    const read = async () => {
      const [pulls, issues] = await Promise.all([readBoardPullsLater(gh, remote, stopReads.signal), readBoardIssuesLater(gh, remote, stopReads.signal)]);
      return { pulls, issues };
    };
    refreshBoardGitHub(github, remote, read, BOARD_REFRESH_SECONDS * 1000);
    return remote;
  };
  const feeds = makeFeedStore();
  const streams = makeFeedStreams(env, root, options.feedMask);
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (!isBoardHost(req.headers.host, port, name)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    const [path, query] = (req.url ?? '').split('?');
    if (!isBoardToken(requestToken(query ?? '', req.headers.cookie), token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden: open the link that yokoten board printed in its terminal once. After that, this address works by itself.');
    if (req.method === 'GET') {
      if (path === '/' && new URLSearchParams(query ?? '').get('t')) {
        // The token moves from the address to a cookie only this page gets, and the address is clean again.
        res.writeHead(303, { location: '/', 'set-cookie': `${BOARD_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (path === '/') {
        const nonce = randomBytes(BOARD_TOKEN_BYTES).toString('base64');
        return serveText(res, 200, 'text/html; charset=utf-8', boardPage(nonce), { 'content-security-policy': contentPolicy(nonce) });
      }
      if (path === '/data') {
        try {
          const remote = refreshGitHub();
          const board = collectBoardWith(root, env, remote, remote ? github.pulls : BOARD_NO_REMOTE_PULLS);
          const trees = readBoardWorktrees(root, env);
          const snapshot = readBoardSnapshot(env, controls, board, trees, remote ? github.issues : BOARD_NO_REMOTE_ISSUES);
          recordFeed(feeds, board.agents, board.updated);
          const fresh = githubState(remote ? github : null);
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...board, feeds: feedsJson(feeds), ...snapshot, github: fresh }));
        } catch {
          return serveText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'the board could not be read: run it again' }));
        }
      }
      if (path === '/feed') {
        // One agent's session, from its cursor on (#694). Masked, as text; a failed mask sends nothing.
        const ask = new URLSearchParams(query ?? '');
        try {
          const answer = feedAnswer(streams, root, env, ask.get('agent') ?? '', ask.get('after') ?? '');
          if (!answer) return serveText(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'no agent by that name on the board' }));
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify(answer));
        } catch {
          return serveText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'the board could not read that log safely: run it again' }));
        }
      }
      return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
    if (req.method !== 'POST') return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (path !== '/agents/start' && path !== '/agents/stop' && path !== '/agents/limits') {
      return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
    if (!isBoardOrigin(req.headers.origin, port, name)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    readBoardBody(req).then((body) => {
      if (res.writableEnded) return;
      if (body === null) return serveText(res, 400, 'text/plain; charset=utf-8', 'the board could not read that: send it again');
      try {
        if (path === '/agents/start') {
          const fields = boardFields(body, req.headers['content-type']);
          if (!fields) return serveText(res, 400, 'text/plain; charset=utf-8', 'send JSON or form fields');
          const ask = readBoardStartAsk(fields);
          if (typeof ask === 'string') return serveText(res, 400, 'text/plain; charset=utf-8', ask);
          const started = startBoardAgent(root, env, controls, ask);
          if (typeof started === 'string') return serveText(res, startRefuseStatus(started), 'text/plain; charset=utf-8', started);
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ name: started.name, worktree: hideHome(started.worktree, env), pid: started.pid }));
        }
        if (path === '/agents/stop') {
          const fields = boardFields(body, req.headers['content-type']);
          if (!fields) return serveText(res, 400, 'text/plain; charset=utf-8', 'send JSON or form fields');
          const stopped = stopBoardAgent(controls, fields.name ?? '');
          if (typeof stopped === 'string') return serveText(res, stopRefuseStatus(stopped), 'text/plain; charset=utf-8', stopped);
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ name: stopped.name, status: stopped.status }));
        }
        const fields = boardFields(body, req.headers['content-type']);
        if (!fields) return serveText(res, 400, 'text/plain; charset=utf-8', 'send JSON or form fields');
        const limits = setBoardLimits(controls, fields);
        if (typeof limits === 'string') return serveText(res, 400, 'text/plain; charset=utf-8', limits);
        return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ limits }));
      } catch {
        return serveText(res, 500, 'text/plain; charset=utf-8', 'the board could not do that: run it again');
      }
    });
  });
  server.on('close', () => stopReads.abort());
  return new Promise((done, failed) => {
    const wanted = options.port ?? boardPort(root);
    // The stable port, or any free one when another program holds it.
    let isRetried = false;
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (isRetried || error.code !== 'EADDRINUSE' || wanted === 0 || server.listening) return failed(error);
      isRetried = true;
      server.listen(0, '127.0.0.1');
    });
    server.listen(wanted, '127.0.0.1', () => {
      try {
        refreshGitHub();
      } catch {
        // The first /data starts the read instead.
      }
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ server, url: `http://${name}:${port}/?t=${token}` });
    });
  });
}

/**
 * The program that opens a link in the default browser (#685), as a command and its words,
 * or null where none is known. WSL opens the Windows browser. The link goes as one word,
 * never through a shell.
 */
export function browserCommand(url: string, platform: NodeJS.Platform, env: Env): string[] | null {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler', url];
  if (platform === 'linux') return env.WSL_DISTRO_NAME ? ['explorer.exe', url] : ['xdg-open', url];
  return null;
}

/** Open the link in the browser, and never wait or fail: the printed link is the way back. */
function openInBrowser(url: string, env: Env): void {
  const command = browserCommand(url, process.platform, env);
  if (!command) return;
  try {
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore', env });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser to open: the link is printed.
  }
}

export function runBoard(invocation: Invocation, options: BoardServerOptions = {}): number | Promise<number> {
  const parsed = parse('board', invocation.args);
  if (typeof parsed === 'string') return usage(invocation, parsed);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const gh = ghIn(root, invocation.env, BOARD_READ_TIMEOUT_MS);
  const controls = options.controls ?? createBoardControls(join(root, '.yokoten-board.log'));
  if (parsed.flags.has('--text')) {
    const board = collectBoard(root, invocation.env, gh);
    const trees = readBoardWorktrees(root, invocation.env);
    const waiting = collectBoardWaiting(board, typeof trees === 'string' ? [] : readBoardAttention(trees), controls.runs, controls.seen);
    // A run's worktree hides the home folder here, exactly as /data serves it.
    const runs = controls.runs.map((run) => ({ ...run, worktree: hideHome(run.worktree, invocation.env) }));
    print(invocation, renderBoardText(board, waiting.length || runs.length ? { waiting, runs } : undefined));
    return 0;
  }
  return startBoardServer(root, invocation.env, ghLaterIn(root, invocation.env, BOARD_READ_TIMEOUT_MS), { controls }).then(
    ({ url }) => {
      const isOpening = !parsed.flags.has('--no-open');
      print(invocation, [`yokoten board: the team is live at ${url}`, `After the first visit, ${url.split('?')[0]} is enough: bookmark it, or install it as an app from the browser.`, `${isOpening ? 'It opens in your browser now. ' : ''}The page refreshes every ${BOARD_REFRESH_SECONDS} seconds. Stop it with Ctrl-C.`]);
      if (isOpening) openInBrowser(url, invocation.env);
      return new Promise<number>(() => {});
    },
    () => {
      print(invocation, ['yokoten board: the page could not start: run it again.'], invocation.stderr);
      return 1;
    },
  );
}
