import { finding, type Finding } from '../../message.ts';
import { ghIndex, hostApiValues } from '../../privacy.ts';
import { withoutShellRedirects, programName, findPrograms, findProgramPlaces } from '../bash/read/words.ts';
import { plainArgs } from '../lead-only/targets.ts';

// ---- What a worker sends (#555) ----
//
// A worker commits in its worktree and reports; the lead reviews, then pushes and posts. So
// for a worker the guard refuses, past `git push`: `yokoten bot` in any form, `git send-pack`,
// `git subtree push`, an alias (`git config alias.*`, `git -c alias.*`), gh's pull request
// writes, and gh's `api` with a write method or fields. A GraphQL query that reads passes.

const SEND_FIX = 'commit in your worktree and report; the lead pushes after review';
export const sends = (what: string) => finding('worker-push', what, SEND_FIX);
const YOKOTEN_CLI = /^yokoten(\.ts|\.js|\.mjs|\.cjs)?$/i;
// Programs that run another program's script or package: `node bin/yokoten.ts`, `npx yokoten`.
const SCRIPT_RUNNERS = new Set(['node', 'nodejs', 'npx', 'bunx', 'bun', 'deno', 'tsx', 'pnpm', 'pnpx', 'yarn', 'npm']);
const PR_WRITES = new Set(['create', 'merge', 'edit', 'close', 'comment', 'review', 'ready', 'reopen']);

/** For a worker: a command that pushes or posts for the lead, or null. */
export function checkWorkerSends(words: string[]): Finding | null {
  const places = findProgramPlaces(words);
  let from = 0;
  for (const place of places) {
    // The program's own index. An `env -S` program has none, so the word is looked up.
    const at = place.index >= 0 ? place.index : words.indexOf(place.word, from);
    if (at < 0) continue;
    from = at + 1;
    const name = programName(place.word);
    const cli = YOKOTEN_CLI.test(name) ? at : SCRIPT_RUNNERS.has(name) ? words.findIndex((word, index) => index > at && YOKOTEN_CLI.test(programName(word))) : -1;
    if (cli !== -1 && words.slice(cli + 1).find((word) => !word.startsWith('-')) === 'bot') {
      return sends('`yokoten bot` runs a command as the bot, which pushes and posts for the lead');
    }
  }
  const at = ghIndex(words, places);
  if (at === -1) return null;
  const args = withoutShellRedirects(words, at + 1);
  const plain = plainArgs(args, ['-R', '--repo', '--hostname']);
  if (plain[0] === 'pr' && PR_WRITES.has(plain[1] ?? '')) return sends(`gh pr ${plain[1]} changes a pull request on the host`);
  if (plain[0] === 'api') return checkGhApi(args.slice(args.indexOf('api') + 1));
  return null;
}

/**
 * For a worker: `yokoten worker unmark`, which would clear its own worker mark (#566),
 * or null. The role is the session's own, set from its folders before the command runs,
 * so a `cd` away inside the command never evades it. Only the lead unmarks a worktree.
 */
export function checkWorkerUnmark(words: string[]): Finding | null {
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    const name = programName(program);
    const cli = YOKOTEN_CLI.test(name) ? at : SCRIPT_RUNNERS.has(name) ? words.findIndex((word, index) => index > at && YOKOTEN_CLI.test(programName(word))) : -1;
    if (cli === -1) continue;
    const plain = plainArgs(withoutShellRedirects(words, cli + 1));
    if (plain[0] === 'worker' && plain[1] === 'unmark') {
      return finding('worker-mark', '`yokoten worker unmark` clears a worker mark, and only the lead unmarks a worktree', 'commit in your worktree and report; the lead unmarks after review, from its own checkout');
    }
    // A worker that marks the lead's checkout makes the lead a worker too (#672).
    if (plain[0] === 'worker' && plain[1] === 'mark') {
      return finding('worker-mark', '`yokoten worker mark` sets a worker mark, and only the lead marks a worktree or a clone', 'commit in your worktree and report; the lead marks checkouts, from its own');
    }
  }
  return null;
}

/** gh's `api`: a write method, or fields (gh then sends a POST), except a GraphQL query that reads. */
function checkGhApi(args: string[]): Finding | null {
  let method: string | undefined;
  let endpoint: string | undefined;
  const fields: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '-X' || word === '--method') method = args[++index] ?? '';
    else if (word.startsWith('--method=')) method = word.slice('--method='.length);
    else if (/^-X./.test(word)) method = word.slice(2);
    else if (['-f', '-F', '--field', '--raw-field'].includes(word)) fields.push(args[++index] ?? '');
    else if (/^--(raw-)?field=/.test(word)) fields.push(word.slice(word.indexOf('=') + 1));
    else if (/^-[fF]./.test(word)) fields.push(word.slice(2));
    else if (word === '--input' || word.startsWith('--input=')) {
      fields.push('@');
      if (word === '--input') index++;
    } else if (hostApiValues().has(word)) index++;
    else if (!word.startsWith('-') && endpoint === undefined) endpoint = word;
  }
  if (method !== undefined) return ['GET', 'HEAD'].includes(method.toUpperCase()) ? null : sends(`gh's \`api --method ${method}\` writes to the host`);
  if (!fields.length) return null;
  // A GraphQL read sends its query as a field. A mutation, or a query the guard can't read, counts.
  const isRead = endpoint === 'graphql' && fields.every((field) => field !== '@' && !(/^query=/.test(field) && /^query=[@$`]|\bmutation\b/i.test(field)));
  return isRead ? null : sends('`gh` `api` with fields sends a POST, which writes to the host');
}

// On macOS and Windows a file name is the same file in any case: `agents.md` is AGENTS.md.
