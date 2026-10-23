// `yokoten board` (#601, #603): serves the team board on this machine only.
//
// The page is at /, its data as JSON at /data. The data comes from three places: one status
// file per worktree, `gh pr list` and `gh issue list`, and `git worktree list`. /data reads
// the local parts each time and never waits for gh: gh reads in the background, one read at
// a time, and /data serves its last lists (#688). /feed sends one agent's session log, masked,
// from the page's cursor on (#694). `board --text` prints the same data. A request needs
// the right Host and the board's cookie. The first visit, with ?token=, sets that cookie
// and redirects. Agents write the status files,
// so the page treats every word in them as text: a strict content policy lets only the
// page's own script run.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { ghIn, ghLaterIn, type GhLater, readBoardPullsLater, repoOf } from '../../../host/github/index.ts';
import { type Env } from '../../../rules/config.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { readOriginUrl } from '../../../setup/plan.ts';
import { type Invocation, parse, print, requireRoot, usage } from '../../shared.ts';
import { BOARD_READ_TIMEOUT_MS, readBoardWorktrees } from './agents.ts';
import { type BoardControls, collectBoardWaiting, createBoardControls, readBoardAttention, readBoardIssues, readBoardIssuesLater, readBoardSnapshot, readBoardStartAsk, setBoardLimits, startBoardAgent, stopBoardAgent } from './controls.ts';
import { feedAnswer, makeBoardMask, makeFeedStreams } from './feed/route.ts';
import { feedsJson, makeFeedStore, recordFeed } from './feed/steps.ts';
import { boardManifest, boardPage, BOARD_REFRESH_SECONDS } from './page/page.ts';
import { renderBoardText } from './page/text.ts';
import { BOARD_NO_REMOTE_ISSUES, BOARD_NO_REMOTE_PULLS, type BoardGitHub, collectBoard, collectBoardWith, createBoardGitHub, issueNumbersOf, refreshBoardGitHub } from './view.ts';

/** How many random bytes the board link's token holds, and each page's script nonce. */
const BOARD_TOKEN_BYTES = 16;

/** The cookie that carries the token after the first visit (#693). */
const BOARD_COOKIE = 'yokoten-board';

/** Ports the board tries first: a high range, stable for one repo path. */
const BOARD_PORT_BASE = 28416;

/** How many ports share that range. A taken port tries the next few, then any free port. */
const BOARD_PORT_SPAN = 4000;

/** How many ports past the stable one to try before asking the system for any port. */
const BOARD_PORT_TRIES = 32;

/** Paths a first visit may return to. Anything else returns to `/`. */
const BOARD_PATHS = new Set(['/', '/data', '/feed', '/manifest.webmanifest', '/agents/start', '/agents/stop', '/agents/limits']);

/** The content policy: nothing loads from outside, and only the script with this page's nonce runs. */
function contentPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "manifest-src 'self'",
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
 * The repo folder as one hostname label (#693). Letters and digits stay.
 * Anything else becomes a hyphen. An empty label is `board`.
 */
export function boardHostName(root: string): string {
  const label = basename(root).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '');
  return label || 'board';
}

/** The first port this repo asks for: a stable hash of its real path, in a high range. */
export function boardPort(root: string): number {
  let path = root;
  try {
    path = realpathSync(root);
  } catch {
    // The folder is not there yet: hash the path as given.
  }
  const hash = createHash('sha256').update(path).digest();
  return BOARD_PORT_BASE + (hash.readUInt32BE(0) % BOARD_PORT_SPAN);
}

/**
 * The private network's name for this computer, as `--share` gives it (#623), or
 * null when it is not a plain host name. A URL, a port or a loopback name is refused:
 * the first two hide where the board goes, and the last one names no phone.
 */
export function boardShareName(given: string): string | null {
  const name = given.trim().toLowerCase().replace(/\.$/, '');
  if (name.length === 0 || name.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(name)) return null;
  if (name === 'localhost' || name.endsWith('.localhost') || /^\d+(?:\.\d+){3}$/.test(name)) return null;
  return name;
}

/**
 * True when the Host header names this server: `<repo>.localhost:<port>`,
 * `127.0.0.1:<port>` or `localhost:<port>`. With `--share`, also the private name
 * the HTTPS proxy sends, with no port or with 443. Any other host gets a 403.
 */
function isBoardHost(host: string | undefined, port: number, name: string, share: string | null): boolean {
  const clean = (host ?? '').trim().toLowerCase();
  if (clean === `${name}.localhost:${port}` || clean === `127.0.0.1:${port}` || clean === `localhost:${port}`) return true;
  return share !== null && (clean === share || clean === `${share}:443`);
}

/** True when the given token matches, compared in constant time. A missing token, or one of another length, never reaches the compare. */
function isBoardToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const guess = Buffer.from(given, 'utf8');
  const want = Buffer.from(token, 'utf8');
  return guess.length === want.length && timingSafeEqual(guess, want);
}

/**
 * True when the Origin names this page. A change without it gets a 403, so a page
 * elsewhere cannot start or stop agents through this board. With `--share`, the
 * private name over HTTPS is the page's origin, with no port or with 443.
 */
function isBoardOrigin(origin: string | undefined, port: number, name: string, share: string | null): boolean {
  const clean = (origin ?? '').trim().toLowerCase();
  if (clean === `http://${name}.localhost:${port}` || clean === `http://127.0.0.1:${port}` || clean === `http://localhost:${port}`) return true;
  return share !== null && (clean === `https://${share}` || clean === `https://${share}:443`);
}

/**
 * The cookie the first visit sets. The token is hex, so it needs no extra encoding.
 * No Domain, so it stays on this host. Secure is stored on *.localhost, a secure context.
 */
function boardSetCookie(token: string): string {
  return `${BOARD_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

/** The cookie's token, or null when the cookie is missing. */
function boardCookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const cut = part.trim();
    const eq = cut.indexOf('=');
    if (eq > 0 && cut.slice(0, eq) === BOARD_COOKIE) return cut.slice(eq + 1);
  }
  return null;
}

/**
 * Where a first visit returns, with the token removed. Only the board's own paths
 * are kept, so a token cannot turn into an open redirect.
 */
function boardReturnPath(path: string, query: URLSearchParams): string {
  const safe = BOARD_PATHS.has(path) ? path : '/';
  query.delete('token');
  const rest = query.toString();
  return rest ? `${safe}?${rest}` : safe;
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

/** What the options carry: the board's controls, what it last read from GitHub, and the private network's name for this computer. */
export interface BoardServerOptions {
  controls?: BoardControls;
  github?: BoardGitHub;
  /** The mask for /feed. Tests pass their own; the board builds it from the private marks. */
  feedMask?: (text: string) => string;
  /**
   * The name a private network gives this computer (#623), as `--share` gives it.
   * When set, the board answers that name over HTTPS through the network's proxy;
   * when absent, only this computer's names are answered. Off is the default.
   */
  share?: string;
}

/**
 * Every string value in a /data payload, masked once. Keys stay, so the page can
 * still read them. A new field cannot skip this walk.
 */
export function maskBoardPayload(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskBoardPayload(item, mask));
  if (value !== null && typeof value === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) masked[key] = maskBoardPayload(item, mask);
    return masked;
  }
  return value;
}

/** The /data body. Every string is masked at this boundary, then sent as JSON. */
export function boardDataBody(env: Env, root: string, payload: unknown): string {
  return JSON.stringify(maskBoardPayload(payload, makeBoardMask(env, root)));
}

/** The /data fields that say how fresh the GitHub lists are: reading now, when last read, and why the last read failed. */
function githubState(github: BoardGitHub | null): { isReading: boolean; readAt: string; failed: string } {
  return github ? { isReading: github.reading !== null, readAt: github.readAt, failed: github.failed } : { isReading: false, readAt: '', failed: '' };
}

/**
 * Start the board on 127.0.0.1: the page at /, the data as JSON at /data, and the
 * owner's changes at /agents/start, /agents/stop and /agents/limits. The link is
 * `http://<repo>.localhost:<port>/?token=...`. The port stays with the repo path.
 * The first visit sets a cookie and redirects to the address without the token.
 * Later requests must send that cookie. A wrong Host, a missing cookie or a wrong
 * cookie gets a 403. A change whose Origin is not the page gets a 403 too.
 * With `share`, the private network's name is also a right Host (with no port or
 * 443), and its HTTPS page is also a right Origin. The board still listens on
 * 127.0.0.1: the private network's own proxy calls it, so no phone reaches the
 * port directly and the token holds as it does here.
 * gh reads the pull requests and issues in the background: the first read starts
 * now, and /data never waits for it.
 */
export function startBoardServer(root: string, env: Env, gh: GhLater, options: BoardServerOptions = {}): Promise<{ server: Server; url: string; shareUrl?: string }> {
  const token = randomBytes(BOARD_TOKEN_BYTES).toString('hex');
  const hostName = boardHostName(root);
  const share = options.share === undefined ? null : boardShareName(options.share);
  if (share === null && options.share !== undefined) throw new Error('that is not a private network name: give the name alone, such as machine.example.ts.net');
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
    if (!isBoardHost(req.headers.host, port, hostName, share)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    const [path, queryText] = (req.url ?? '').split('?');
    const query = new URLSearchParams(queryText ?? '');
    // The query token only starts a visit. It never authorizes a page or a change.
    const fromLink = query.get('token');
    if (fromLink !== null) {
      if (req.method !== 'GET' || !isBoardToken(fromLink, token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
      return serveText(res, 303, 'text/plain; charset=utf-8', '', { location: boardReturnPath(path || '/', query), 'set-cookie': boardSetCookie(token) });
    }
    if (!isBoardToken(boardCookieToken(req.headers.cookie), token)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (req.method === 'GET') {
      if (path === '/') {
        const nonce = randomBytes(BOARD_TOKEN_BYTES).toString('base64');
        return serveText(res, 200, 'text/html; charset=utf-8', boardPage(nonce), { 'content-security-policy': contentPolicy(nonce) });
      }
      if (path === '/data') {
        try {
          const remote = refreshGitHub();
          const issues = remote ? github.issues : BOARD_NO_REMOTE_ISSUES;
          const board = collectBoardWith(root, env, remote, remote ? github.pulls : BOARD_NO_REMOTE_PULLS, Date.now(), issueNumbersOf(issues));
          const trees = readBoardWorktrees(root, env);
          const snapshot = readBoardSnapshot(env, controls, board, trees, issues, root);
          recordFeed(feeds, board.agents, board.updated);
          const fresh = githubState(remote ? github : null);
          const payload = { ...board, feeds: feedsJson(feeds), ...snapshot, github: fresh };
          return serveText(res, 200, 'application/json; charset=utf-8', boardDataBody(env, root, payload));
        } catch {
          return serveText(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'the board could not be read: run it again' }));
        }
      }
      if (path === '/manifest.webmanifest') {
        return serveText(res, 200, 'application/manifest+json; charset=utf-8', boardManifest());
      }
      if (path === '/feed') {
        // One agent's session, from its cursor on (#694). Masked, as text; a failed mask sends nothing.
        const ask = query;
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
    if (!isBoardOrigin(req.headers.origin, port, hostName, share)) return serveText(res, 403, 'text/plain; charset=utf-8', 'forbidden');
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
    const first = boardPort(root);
    let attempt = 0;
    let hasTriedAnyPort = false;
    const listenAt = (port: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EADDRINUSE') {
          failed(error);
          return;
        }
        if (attempt < BOARD_PORT_TRIES) {
          attempt += 1;
          listenAt(first + attempt);
          return;
        }
        if (!hasTriedAnyPort) {
          hasTriedAnyPort = true;
          listenAt(0);
          return;
        }
        failed(error);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        // A later error is handled, so it never becomes an uncaught throw.
        server.on('error', () => {});
        try {
          refreshGitHub();
        } catch {
          // The first /data starts the read instead.
        }
        const address = server.address();
        const bound = typeof address === 'object' && address !== null ? address.port : 0;
        done({ server, url: `http://${hostName}.localhost:${bound}/?token=${token}`, ...(share === null ? {} : { shareUrl: `https://${share}/?token=${token}` }) });
      });
    };
    listenAt(first);
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
  const askedShare = parsed.values['--share'];
  const share = askedShare === undefined ? undefined : boardShareName(askedShare);
  if (askedShare !== undefined && share === null) {
    print(invocation, ['yokoten board: --share needs the plain name your private network gives this computer, such as machine.tailnet-name.ts.net. Leave out the scheme and the port.'], invocation.stderr);
    return 1;
  }
  if (parsed.flags.has('--text')) {
    if (share !== undefined) {
      print(invocation, ['yokoten board: --text prints on this computer only. Leave out --share to read the team here.'], invocation.stderr);
      return 1;
    }
    const remote = repoOf(readOriginUrl(root, invocation.env));
    const openIssues = issueNumbersOf(remote ? readBoardIssues(gh, remote) : BOARD_NO_REMOTE_ISSUES);
    const board = collectBoard(root, invocation.env, gh, Date.now(), openIssues);
    const trees = readBoardWorktrees(root, invocation.env);
    const waiting = collectBoardWaiting(board, typeof trees === 'string' ? [] : readBoardAttention(trees), controls.runs, controls.seen);
    // A run's worktree hides the home folder here, exactly as /data serves it.
    const runs = controls.runs.map((run) => ({ ...run, worktree: hideHome(run.worktree, invocation.env) }));
    print(invocation, renderBoardText(board, waiting.length || runs.length ? { waiting, runs } : undefined));
    return 0;
  }
  const shareOptions = share === undefined || share === null ? {} : { share };
  return startBoardServer(root, invocation.env, ghLaterIn(root, invocation.env, BOARD_READ_TIMEOUT_MS), { controls, ...shareOptions }).then(
    ({ url, shareUrl }) => {
      const isOpening = !parsed.flags.has('--no-open');
      if (shareUrl === undefined) {
        print(invocation, [`yokoten board: the team is live at ${url}`, `${isOpening ? 'It opens in your browser now. ' : ''}The page refreshes every ${BOARD_REFRESH_SECONDS} seconds. Stop it with Ctrl-C.`]);
        if (isOpening) openInBrowser(url, invocation.env);
      } else {
        print(invocation, [
          `yokoten board: the team is live at ${shareUrl}`,
          `${share} reaches this board over its HTTPS proxy; who can open that address is the proxy's call, not the board's. The browser needs the link once; the host check and the token hold as they do here.`,
          `This board still listens on 127.0.0.1 only, so no phone reaches this computer directly. Here: ${url}`,
          `${isOpening ? 'It opens in your browser now. ' : ''}The page refreshes every ${BOARD_REFRESH_SECONDS} seconds. Stop it with Ctrl-C; without --share the board is this computer only.`,
        ]);
        if (isOpening) openInBrowser(shareUrl, invocation.env);
      }
      return new Promise<number>(() => {});
    },
    () => {
      print(invocation, ['yokoten board: the page could not start: run it again.'], invocation.stderr);
      return 1;
    },
  );
}
