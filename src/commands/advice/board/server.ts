// `yokoten board` (#601, #603): serves the team board on this machine only.
//
// The page is at /, its data as JSON at /data. The data comes from three places: one status
// file per worktree, `gh pr list`, and `git worktree list`. `board --text` prints the same
// data. A request needs the right Host and the link's token. Agents write the status files,
// so the page treats every word in them as text: a strict content policy lets only the
// page's own script run.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ghIn, type Gh } from '../../../host/github.ts';
import { type Env } from '../../../rules/config.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { type Invocation, parse, print, requireRoot, usage } from '../../shared.ts';
import { BOARD_READ_TIMEOUT_MS, readBoardWorktrees } from './agents.ts';
import { type BoardControls, collectBoardWaiting, createBoardControls, readBoardAttention, readBoardSnapshot, readBoardStartAsk, setBoardLimits, startBoardAgent, stopBoardAgent } from './controls.ts';
import { feedsJson, makeFeedStore, recordFeed } from './feed.ts';
import { boardPage, BOARD_REFRESH_SECONDS } from './page/page.ts';
import { renderBoardText } from './text.ts';
import { type BoardData, collectBoard } from './view.ts';

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
function isBoardHost(host: string | undefined, port: number): boolean {
  const clean = (host ?? '').trim().toLowerCase();
  return clean === `127.0.0.1:${port}` || clean === `localhost:${port}`;
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
function isBoardOrigin(origin: string | undefined, port: number): boolean {
  const clean = (origin ?? '').trim().toLowerCase();
  return clean === `http://127.0.0.1:${port}` || clean === `http://localhost:${port}`;
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

/** What the options carry: the board's controls, and how it reads its data. Tests pass their own. */
export interface BoardServerOptions {
  controls?: BoardControls;
  read?: () => BoardData;
}

/**
 * Start the board on 127.0.0.1 and a free port: the page at /, the data as JSON at
 * /data, and the owner's changes at /agents/start, /agents/stop and /agents/limits.
 * Resolves with the server and its link, which holds a random token; rejects when the
 * server cannot listen. The caller stops it with server.close. A request whose Host is
 * not this server, or whose token is missing or wrong, gets a 403. A change whose
 * Origin is not the page gets a 403 too.
 */
export function startBoardServer(root: string, env: Env, gh: Gh, options: BoardServerOptions = {}): Promise<{ server: Server; url: string }> {
  const token = randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  const controls = options.controls ?? createBoardControls(join(root, '.yokoten-board.log'));
  const read = options.read ?? (() => collectBoard(root, env, gh));
  const feeds = makeFeedStore();
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (!isBoardHost(req.headers.host, port)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    const [path, query] = (req.url ?? '').split('?');
    if (!isBoardToken(new URLSearchParams(query ?? '').get('t'), token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (req.method === 'GET') {
      if (path === '/') {
        const nonce = randomBytes(BOARD_TOKEN_BYTES).toString('base64');
        return serveText(res, 200, 'text/html; charset=utf-8', boardPage(nonce), { 'content-security-policy': contentPolicy(nonce) });
      }
      if (path === '/data') {
        try {
          const board = read();
          const trees = readBoardWorktrees(root, env);
          const snapshot = readBoardSnapshot(root, env, gh, controls, board, trees);
          recordFeed(feeds, board.agents, board.updated);
          return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...board, feeds: feedsJson(feeds), ...snapshot }));
        } catch {
          return serveText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'the board could not be read: run it again' }));
        }
      }
      return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
    if (req.method !== 'POST') return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (path !== '/agents/start' && path !== '/agents/stop' && path !== '/agents/limits') {
      return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    }
    if (!isBoardOrigin(req.headers.origin, port)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
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
  return new Promise((done, failed) => {
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ server, url: `http://127.0.0.1:${port}/?t=${token}` });
    });
  });
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
    print(invocation, renderBoardText(board, waiting.length || controls.runs.length ? { waiting, runs: controls.runs } : undefined));
    return 0;
  }
  return startBoardServer(root, invocation.env, gh, { controls }).then(
    ({ url }) => {
      print(invocation, [`yokoten board: the team is live at ${url}`, `The page refreshes every ${BOARD_REFRESH_SECONDS} seconds. Stop it with Ctrl-C.`]);
      return new Promise<number>(() => {});
    },
    () => {
      print(invocation, ['yokoten board: the page could not start: run it again.'], invocation.stderr);
      return 1;
    },
  );
}
