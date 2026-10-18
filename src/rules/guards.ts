// The rules an agent works under. Each check returns null to let the action go on, or a
// finding: what it stops, why, and what the agent does instead.
//
// `env` is the guard's own environment, which the session sets and the agent cannot change.
// The command text is never read for it: `YOKOTEN_FIX_TASK=0 git commit` inside a command
// changes nothing. A session is the lead unless whoever started it set YOKOTEN_ROLE=worker
// (the dispatch skill does, for each worker it starts).
//
// This is a guard against mistakes and drift, not a lock. It reads command text, so a
// command built up in pieces gets past it. The lock is on the server: branch protection,
// CODEOWNERS, and a release token the agents do not hold.

import type { Config, Env } from './config.ts';
import { matcher } from './config.ts';
import { type Finding, finding } from './message.ts';

/** A file edit, by path relative to the repo root. */
export function checkEdit(path: string, { config, env }: { config: Config; env: Env }): Finding | null {
  if (env.YOKOTEN_FIX_TASK === '1' && matcher(config.tests)(path)) {
    return finding('test-file', `${path} is a test file, and this is a fix task (YOKOTEN_FIX_TASK=1)`, 'if the test is wrong, stop and say so in your report');
  }
  if (env.YOKOTEN_ROLE === 'worker' && matcher(config.leadOnly)(path)) {
    return finding('lead-only', `${path} is lead-only (yokoten.json "leadOnly")`, 'stop and hand the change to the lead');
  }
  return null;
}

/** A shell command, as the agent wrote it. */
export function checkCommand(command: string, { env }: { env: Env }): Finding | null {
  for (const words of segments(command)) {
    const reason = checkGit(words, env) ?? checkPublish(words, env);
    if (reason) return reason;
  }
  return null;
}

const RELEASE_FIX = 'if the owner asked for this, they start a new session with YOKOTEN_RELEASE_APPROVAL=1 (`YOKOTEN_RELEASE_APPROVAL=1 claude`); do not look for another way';
const release = (what: string) => finding('release', what, RELEASE_FIX);

// Quotes become spaces, so `bash -c 'git push --tags'` reads like the plain command. Then
// the text is cut at ; | & ( ) and line ends, and each piece is split into words.
function segments(command: string): string[][] {
  return command
    .replace(/['"`]/g, ' ')
    .split(/[;|&()\r\n]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

const isGit = (word: string) => /(^|[/\\])git(\.exe)?$/.test(word);
// Git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function checkGit(words: string[], env: Env): Finding | null {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  const settings: string[] = [];
  let i = start + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-c') settings.push(words[i + 1] ?? '');
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  const lower = args.map((a) => a.toLowerCase());

  if (settings.some((s) => /^push\.followtags/i.test(s)) && !env.YOKOTEN_RELEASE_APPROVAL) {
    return release('git -c push.followTags pushes tags');
  }
  if (sub === 'push') {
    if (!env.YOKOTEN_RELEASE_APPROVAL) {
      const tagFlag = args.find((a) => ['--tags', '--follow-tags', '--mirror'].includes(a));
      if (tagFlag) return release(`git push ${tagFlag} pushes tags`);
      const tagRef = args.find((a) => /(^|[:+])(refs\/tags\/|v\d)/.test(a));
      if (tagRef) return release(`git push ${tagRef} pushes a release tag`);
    }
    const force = args.find((a) => a === '--force' || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'));
    if (force) return finding('force-push', `git push ${force} forces the push`, 'use --force-with-lease, which stops when the remote has work you have not seen');
  }
  const skip = args.includes('--no-verify') ? '--no-verify' : sub === 'commit' ? args.find((a) => /^-[a-z]*n[a-z]*$/i.test(a)) : undefined;
  if (skip) return finding('skip-check', `git ${sub} ${skip} skips the commit check`, 'fix what the check reports instead');
  if (sub === 'config' && lower.includes('core.hookspath')) {
    const value = args[lower.indexOf('core.hookspath') + 1];
    if (value !== '.githooks') return finding('hooks-path', 'changing core.hooksPath turns off the commit check', 'leave it at .githooks; only the owner changes it');
  }
  return null;
}

function checkPublish(words: string[], env: Env): Finding | null {
  if (env.YOKOTEN_RELEASE_APPROVAL) return null;
  const line = words.join(' ');
  if (/(^|\s)gh release (create|upload|edit)(\s|$)/.test(line)) return release('gh release publishes a release');
  if (/(^|\s)(npm|pnpm|yarn)( npm)? publish(\s|$)/.test(line)) return release('this publishes a package');
  return null;
}
