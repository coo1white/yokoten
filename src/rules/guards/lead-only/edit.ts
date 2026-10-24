import { matcher, type Config, type Env } from '../../config.ts';
import { WORKTREES_DIR } from '../../layout.ts';
import { finding, type Finding } from '../../message.ts';

/** A file edit, by path relative to the repo root. */
export function checkEdit(path: string, { config, env }: { config: Config; env: Env }): Finding | null {
  // A file in a worker worktree reads from that worktree (#571); the message keeps the path as given.
  const inWorktree = stripWorktreeRoot(path);
  if (env.YOKOTEN_FIX_TASK === '1' && matcher(config.tests)(inWorktree)) {
    return finding('test-file', `${path} is a test file, and this is a fix task (YOKOTEN_FIX_TASK=1)`, 'if the test is wrong, stop and say so in your report');
  }
  if (env.YOKOTEN_ROLE === 'worker' && isLeadOnly(inWorktree, config.leadOnly) && !isGranted(inWorktree, env)) {
    return finding('lead-only', `${path} is lead-only (yokoten.json "leadOnly")`, LEAD_ONLY_FIX);
  }
  return null;
}

/**
 * `path` (from the repo root, forward slashes) as the worker worktree holding it sees
 * it: each `.worktrees/<name>/` prefix reads as that worktree's root, so
 * `.worktrees/571-x/AGENTS.md` is `AGENTS.md`, still lead-only (#571). A path that is the
 * worktrees folder or a worktree itself stays as it is.
 */
export function stripWorktreeRoot(path: string): string {
  const prefix = `${WORKTREES_DIR}/`;
  while (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return path;
    path = rest.slice(slash + 1);
  }
  return path;
}

export const LEAD_ONLY_FIX = 'stop and hand the change to the lead: say in your report what to change in it, or ask the lead to start you with YOKOTEN_LEAD_ONLY_OK=<path>';

const FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32';

/** Whether yokoten.json "leadOnly" matches the path, in any case where file names ignore it. */
export function isLeadOnly(path: string, leadOnly: string[], foldsCase = FOLDS_CASE): boolean {
  return matcher(leadOnly, { foldsCase })(path);
}

/**
 * Whether the lead lets this worker change a lead-only path: YOKOTEN_LEAD_ONLY_OK, a
 * comma-separated list of paths from the repo root, set when the worker starts. An entry
 * with a `*` is a glob, as in yokoten.json (`*` alone grants every lead-only file); any
 * other entry is that one path. `\` reads as `/`, a trailing `/` and a leading `./` are
 * dropped, and an empty entry counts for nothing.
 */
export function isGranted(path: string, env: Env, foldsCase = FOLDS_CASE): boolean {
  const entries = (env.YOKOTEN_LEAD_ONLY_OK ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  const same = (entry: string) => (foldsCase ? entry.toLowerCase() === path.toLowerCase() : entry === path);
  return entries.some((entry) => (entry.includes('*') ? matcher([entry], { foldsCase })(path) : same(entry)));
}

/**
 * A shell command, as the agent wrote it. `config` brings the programs the project blocks
 * (yokoten.json "commands.block"); without it, only the core rules apply. `cwd` is the
 * folder the command runs in, null when it is not known: a change to core.hooksPath reads
 * that repo's setting and hooks. `titles` turns on the title check for gh issues and pull
 * requests: the hook sets it in a repo with a yokoten.json, never in the user-level hook,
 * since another project's titles follow its own rules. `repos` are the repos whose file rules
 * the hook applies to an edit (see `judge`): a worker's shell write is checked against the
 * same ones, and against a repo with a yokoten.json it finds above the file.
 */
