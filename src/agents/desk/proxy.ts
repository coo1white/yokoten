// The desk's network door (#637). Commands in a desk get no network; the agent program
// reaches its model's API through this proxy, which runs outside the desk. It takes HTTP
// CONNECT only, to a host on the list and port 443 (or the port the entry names), and
// refuses everything else. It never
// reads what passes through the tunnel: the agent speaks TLS to the API host itself.
//
// It listens on whatever Node's `net` takes: a Unix socket path, a Windows pipe name, or a
// TCP port. So it holds no code for one system; each desk backend chooses the address.

import { connect, createServer, type Server, type Socket } from 'node:net';

/** The longest request head the proxy reads before it refuses: a CONNECT line is short. */
const MAX_HEAD_BYTES = 8 * 1024;

/** How long a client has to send its request head. */
const HEAD_TIMEOUT_MS = 10_000;

/** The one port a tunnel may reach: HTTPS. */
const ALLOWED_PORT = 443;

/** One line a proxy writes for each request it saw: what was asked, and if it was let through. */
export interface ProxyEvent {
  target: string;
  isAllowed: boolean;
}

/** A proxy that runs until `close`. */
export interface DeskProxy {
  server: Server;
  close: () => Promise<void>;
}

/** A host name as the proxy compares it: lower case, with no trailing dot. */
const normalHost = (host: string): string => host.toLowerCase().replace(/\.$/, '');

/**
 * The host and port a CONNECT request names, or null when the head is not a CONNECT
 * line with a plain `host:443`. A bracketed IPv6 address or a raw IP is not a host name
 * on the list, so it is refused here too.
 */
export function readConnectTarget(head: string): { host: string; port: number } | null {
  const line = head.split('\r\n', 1)[0];
  const match = /^CONNECT ([A-Za-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
  if (!match) return null;
  return { host: normalHost(match[1]), port: Number(match[2]) };
}

/**
 * Whether a tunnel to `host:port` is allowed: a host on the list, exactly, and port 443.
 * An entry may name its own port (`host:8443`); then only that port.
 */
export function isAllowedTarget(target: { host: string; port: number }, hosts: readonly string[]): boolean {
  return hosts.some((entry) => {
    const match = /^(.*):(\d{1,5})$/.exec(entry);
    const [host, port] = match ? [match[1], Number(match[2])] : [entry, ALLOWED_PORT];
    return normalHost(host) === target.host && port === target.port;
  });
}

/** Refuse a client with a short HTTP answer, then close. */
function refuse(client: Socket, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** Handle one client: read the head, check it, then open the tunnel or refuse. */
function handleClient(client: Socket, hosts: readonly string[], onEvent: (event: ProxyEvent) => void): void {
  let head = Buffer.alloc(0);
  client.setTimeout(HEAD_TIMEOUT_MS, () => client.destroy());
  client.on('error', () => client.destroy());
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) {
      if (head.length > MAX_HEAD_BYTES) refuse(client, '431 Request Header Fields Too Large');
      return;
    }
    client.off('data', onData);
    client.setTimeout(0);
    const text = head.subarray(0, end).toString('latin1');
    const target = readConnectTarget(text);
    const label = target ? `${target.host}:${target.port}` : (text.split('\r\n', 1)[0].split(' ', 2).join(' ') || '(empty)');
    if (!target || !isAllowedTarget(target, hosts)) {
      onEvent({ target: label, isAllowed: false });
      refuse(client, target ? '403 Forbidden' : '405 Method Not Allowed');
      return;
    }
    onEvent({ target: label, isAllowed: true });
    // Bytes the client sent after the head (a TLS hello sent early) go on to the host.
    const rest = head.subarray(end + 4);
    const upstream = connect({ host: target.host, port: target.port });
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('error', () => {
      if (!client.destroyed && client.bytesWritten === 0) refuse(client, '502 Bad Gateway');
      else client.destroy();
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  };
  client.on('data', onData);
}

/**
 * Start the proxy on `address` (a socket path, a pipe name or a port). It lets through a
 * CONNECT to a host on `hosts` and port 443, and nothing else. `onEvent` hears of every
 * request, for the desk's log line; it never gets a byte of a tunnel.
 */
export function startProxy(address: string | number, hosts: readonly string[], onEvent: (event: ProxyEvent) => void = () => {}): Promise<DeskProxy> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    handleClient(client, hosts, onEvent);
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = () => {
      server.off('error', reject);
      resolve({ server, close });
    };
    if (typeof address === 'number') server.listen(address, '127.0.0.1', done);
    else server.listen(address, done);
  });
}
