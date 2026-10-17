// The rules an agent works under. Each check returns null to let the action go on, or the
// reason it stops, written so the agent knows what to do next.
//
// `env` is the guard's own environment, which the session sets and the agent cannot change.
// The command text is never read for it: `YOKOTEN_FIX_TASK=0 git commit` inside a command
// changes nothing. A session is the lead unless whoever started it set YOKOTEN_ROLE=worker
// (the dispatch skill does, for each worker it starts).
//
// This is a guard against mistakes and drift, not a lock. It reads command text, so a
// command built up in pieces gets past it. The lock is on the server: branch protection,
// CODEOWNERS, and a release token the agents do not hold.

import { matcher } from './glob.mjs';

/** A file edit, by path relative to the repo root. */
export function checkEdit(path, { config, env }) {
  if (env.YOKOTEN_FIX_TASK === '1' && matcher(config.tests)(path)) {
    return `${path} is a test file, and this is a fix task (YOKOTEN_FIX_TASK=1). A fix task changes the code until the test passes, never the test. If the test is wrong, stop and say so in your report.`;
  }
  if (env.YOKOTEN_ROLE === 'worker' && matcher(config.leadOnly)(path)) {
    return `${path} is lead-only (yokoten.json "leadOnly"). Stop and hand the change to the lead.`;
  }
  return null;
}

/** A shell command, as the agent wrote it. */
export function checkCommand(command, { env }) {
  for (const words of segments(command)) {
    const reason = checkGit(words, env) ?? checkPublish(words, env);
    if (reason) return reason;
  }
  return null;
}

const RELEASE = 'Only the owner decides when to release. If the owner asked for this, they start the session with YOKOTEN_RELEASE_APPROVAL set.';

// Quotes become spaces, so `bash -c 'git push --tags'` reads like the plain command. Then
// the text is cut at ; | & ( ) and line ends, and each piece is split into words.
function segments(command) {
  return command
    .replace(/['"`]/g, ' ')
    .split(/[;|&()\r\n]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

const isGit = (word) => /(^|[/\\])git(\.exe)?$/.test(word);
// Git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function checkGit(words, env) {
  const start = words.findIndex(isGit);
  if (start === -1) return null;
  const settings = [];
  let i = start + 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-c') settings.push(words[i + 1] ?? '');
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  const lower = args.map((a) => a.toLowerCase());

  if (settings.some((s) => /^push\.followtags/i.test(s)) && !env.YOKOTEN_RELEASE_APPROVAL) {
    return `git -c push.followTags pushes tags. ${RELEASE}`;
  }
  if (sub === 'push') {
    if (!env.YOKOTEN_RELEASE_APPROVAL) {
      const tagFlag = args.find((a) => ['--tags', '--follow-tags', '--mirror'].includes(a));
      if (tagFlag) return `git push ${tagFlag} pushes tags. ${RELEASE}`;
      const tagRef = args.find((a) => /(^|[:+])(refs\/tags\/|v\d)/.test(a));
      if (tagRef) return `git push ${tagRef} pushes a release tag. ${RELEASE}`;
    }
    if (args.some((a) => a === '--force' || /^-[a-z]*f[a-z]*$/i.test(a) || a.startsWith('+'))) {
      return 'A plain force push can throw away work that someone else pushed. Use --force-with-lease.';
    }
  }
  if (args.includes('--no-verify') || (sub === 'commit' && args.some((a) => /^-[a-z]*n[a-z]*$/i.test(a)))) {
    return '--no-verify skips the commit check, which is the inspection step. Fix what the check reports instead.';
  }
  if (sub === 'config' && lower.includes('core.hookspath')) {
    const value = args[lower.indexOf('core.hookspath') + 1];
    if (value !== '.githooks') return 'Changing core.hooksPath turns off the commit check. Only the owner changes it.';
  }
  return null;
}

function checkPublish(words, env) {
  if (env.YOKOTEN_RELEASE_APPROVAL) return null;
  const line = words.join(' ');
  if (/(^|\s)gh release (create|upload|edit)(\s|$)/.test(line)) return `gh release publishes a release. ${RELEASE}`;
  if (/(^|\s)(npm|pnpm|yarn)( npm)? publish(\s|$)/.test(line)) return `This publishes a package. ${RELEASE}`;
  return null;
}
