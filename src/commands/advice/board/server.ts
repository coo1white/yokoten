// `yokoten board` (#601, #603): serves the team board on this machine only.
//
// The page is at /, its data as JSON at /data. The data comes from three places: one status
// file per worktree, `gh pr list`, and `git worktree list`. `board --text` prints the same
// data. A request needs the right Host and the link's token. Agents write the status files,
// so the page treats every word in them as text: a strict content policy lets only the
// page's own script run.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { ghIn, type Gh } from '../../../host/github.ts';
import { type Env } from '../../../rules/config.ts';
import { type Invocation, parse, print, requireRoot, usage } from '../../shared.ts';
import { BOARD_READ_TIMEOUT_MS } from './agents.ts';
import { feedsJson, makeFeedStore, recordFeed } from './feed.ts';
import { boardPage, BOARD_REFRESH_SECONDS } from './page.ts';
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
 * Start the board on 127.0.0.1 and a free port. Resolves with the server and its link,
 * which holds a random token; rejects when the server cannot listen. The caller stops it
 * with server.close. A request whose Host is not this server, or whose token is missing or
 * wrong, gets a 403. `read` is how the board reads its data; tests pass their own.
 */
export function startBoardServer(root: string, env: Env, gh: Gh, read: () => BoardData = () => collectBoard(root, env, gh)): Promise<{ server: Server; url: string }> {
  const token = randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  const feeds = makeFeedStore();
  const server = createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (!isBoardHost(req.headers.host, port)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    const [path, query] = (req.url ?? '').split('?');
    if (!isBoardToken(new URLSearchParams(query ?? '').get('t'), token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (req.method !== 'GET') return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (path === '/') {
      const nonce = randomBytes(BOARD_TOKEN_BYTES).toString('base64');
      return serveText(res, 200, 'text/html; charset=utf-8', boardPage(nonce), { 'content-security-policy': contentPolicy(nonce) });
    }
    if (path === '/data') {
      let board: BoardData;
      try {
        board = read();
      } catch {
        return serveText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'the board could not be read: run it again' }));
      }
      recordFeed(feeds, board.agents, board.updated);
      return serveText(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...board, feeds: feedsJson(feeds) }));
    }
    return serveText(res, 404, 'text/plain; charset=utf-8', 'not found');
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

export function runBoard(invocation: Invocation): number | Promise<number> {
  const options = parse('board', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = requireRoot(invocation, invocation.cwd);
  if (!root) return 1;
  const gh = ghIn(root, invocation.env, BOARD_READ_TIMEOUT_MS);
  if (options.flags.has('--text')) {
    print(invocation, renderBoardText(collectBoard(root, invocation.env, gh)));
    return 0;
  }
  return startBoardServer(root, invocation.env, gh).then(
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
