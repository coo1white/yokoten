// Which code host a remote is on, and whether yokoten has an adapter for it (#504).
// The road speaks in ideas ("main is protected"); an adapter knows how its host does
// them. GitHub has one (github.ts); Gitea gets one next (#505). A host with no adapter
// still gets the core: the rules, the guard and the commit check work the same there.
//
// A self-hosted server's name can point at a person (core rule 11), so yokoten never
// prints it: such a host is "this host" in what doctor says.

import { repoOf, type Unread } from './github.ts';

/** The code host of the origin remote. */
export type Host =
  /** No origin remote. */
  | { kind: 'none' }
  /** A host yokoten has an adapter for. */
  | { kind: 'github'; repo: string }
  /** A host with no adapter yet. `name` is its address, never printed; `label` is what doctor says. */
  | { kind: 'other'; name: string; label: string };

/** Public hosts that yokoten names in what it says, by their address. Any other is "this host". */
const PUBLIC_HOSTS: Record<string, string> = {
  'gitlab.com': 'GitLab',
  'codeberg.org': 'Codeberg',
  'gitea.com': 'Gitea',
  'bitbucket.org': 'Bitbucket',
};

/**
 * The host name of a remote: from a URL (`https://`, `ssh://`, `git://`), or from git's
 * short form `user@host:path`. Empty for a folder on this machine.
 */
function hostName(remote: string): string {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(remote);
  if (url) return url[1].toLowerCase();
  // git reads `host:path` as a remote host only when no slash comes before the colon.
  // One letter before the colon is a Windows drive (C:\repo), not a host.
  const short = /^(?:[^@/:\\]+@)?([^/:\\]{2,}):/.exec(remote);
  return short ? short[1].toLowerCase() : '';
}

/** The host of `remote`, the value of `remote.origin.url`; empty means no remote. */
export function hostOf(remote: string): Host {
  const text = remote.trim();
  if (!text) return { kind: 'none' };
  const repo = repoOf(text);
  if (repo) return { kind: 'github', repo };
  const name = hostName(text);
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
