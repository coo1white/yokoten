// Which code host a remote is on, and whether yokoten has an adapter for it (#504).
// The road speaks in ideas ("main is protected"); an adapter knows how its host does
// them. GitHub has one (github/), Gitea has one too (gitea.ts, #505). A host with no
// adapter still gets the core: the rules, the guard and the commit check work the same.
//
// GitHub is worked out from the address. A self-hosted Gitea has no address yokoten can
// know, so the project names it in yokoten.json (`"host": "gitea"`); the address itself
// is never printed (core rule 11), because it can point at a person. Such a host is
// "this host" in what doctor says.

import type { Unread } from './github/index.ts';

/** The code host of the origin remote. */
export type Host =
  /** No origin remote. */
  | { kind: 'none' }
  /** A host yokoten has an adapter for. */
  | { kind: 'github'; repo: string }
  /** A Gitea server, self-hosted or public. `api` is where its API answers; never printed. */
  | { kind: 'gitea'; repo: string; api: string }
  /** A host with no adapter yet. `name` is its address, never printed; `label` is what doctor says. */
  | { kind: 'other'; name: string; label: string };

/** Public hosts that yokoten names in what it says, by their address. Any other is "this host". */
const PUBLIC_HOSTS: Record<string, string> = {
  'gitlab.com': 'GitLab',
  'codeberg.org': 'Codeberg',
  'gitea.com': 'Gitea',
  'bitbucket.org': 'Bitbucket',
};

/** Gitea servers yokoten recognises by their address, without a yokoten.json key. */
const PUBLIC_GITEA = ['gitea.com'];

/** The address of a remote: its scheme, host, port and path, or null for a folder on this machine. */
function remoteParts(remote: string): { scheme: string; host: string; port: string; path: string } | null {
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^/:?#]*)(?::(\d+))?\/?([^?#]*)/i.exec(remote);
  if (url) {
    const [, scheme, host, port = '', path = ''] = url;
    return host ? { scheme: scheme.toLowerCase(), host: host.toLowerCase(), port, path } : null;
  }
  // git reads `host:path` as a remote host only when no slash comes before the colon.
  // One letter before the colon is a Windows drive (C:\repo), not a host.
  const short = /^(?:[^@/:\\]+@)?([^/:\\]{2,}):(.*)$/.exec(remote);
  return short ? { scheme: '', host: short[1].toLowerCase(), port: '', path: short[2] } : null;
}

/** "owner/name" from any remote, or null when the path is not a repo. */
function ownerAndName(path: string): string | null {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = clean.split('/').filter(Boolean);
  return parts.length === 2 ? parts.join('/') : null;
}

/** Where the Gitea API of a remote answers. A port given by an http(s) URL is the API's too. */
function giteaApiOf(parts: { scheme: string; host: string; port: string }): string {
  const scheme = parts.scheme === 'http' || parts.scheme === 'https' ? parts.scheme : 'https';
  const port = parts.scheme === 'http' || parts.scheme === 'https' ? parts.port : '';
  return `${scheme}://${parts.host}${port ? `:${port}` : ''}/api/v1`;
}

/** The host of `remote`, the value of `remote.origin.url`; empty means no remote. */
export function hostOf(remote: string, declared: 'auto' | 'gitea' = 'auto'): Host {
  const text = remote.trim();
  if (!text) return { kind: 'none' };
  const parts = remoteParts(text);
  if (parts === null) return { kind: 'other', name: '', label: 'this host' };
  const repo = ownerAndName(parts.path);
  const name = parts.host;
  if (repo && (parts.host === 'github.com' || parts.host === 'www.github.com')) return { kind: 'github', repo };
  if (repo && (declared === 'gitea' || PUBLIC_GITEA.includes(name.replace(/^www\./, '')))) {
    return { kind: 'gitea', repo, api: giteaApiOf(parts) };
  }
  return { kind: 'other', name, label: PUBLIC_HOSTS[name.replace(/^www\./, '')] ?? 'this host' };
}

/** What doctor read from a host with no adapter: nothing, and which host it is. Its `unread` and `fix` are said once. */
export interface NoAdapter extends Unread {
  /** The host as doctor names it: "GitLab", or "this host". */
  otherHost: string;
}

/** The read for a host with no adapter. No network: there is nothing yokoten can ask it. */
export const noAdapter = (host: Extract<Host, { kind: 'other' }>): NoAdapter => ({
  unread: `yokoten can't read the server settings on ${host.label} yet`,
  fix: "the steps marked can't check say what each one asks, so you can set it up by hand",
  otherHost: host.label,
});

/** True when `read` is from a host with no adapter. */
export const isNoAdapter = (read: unknown): read is NoAdapter => typeof read === 'object' && read !== null && typeof (read as Partial<NoAdapter>).otherHost === 'string';
