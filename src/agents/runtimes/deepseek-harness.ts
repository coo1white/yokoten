// What yokoten knows about DeepSeek Harness (`dsh`): how its hook bridge reaches the guard,
// and the two project files that set it up. Source: deepseek-harness 687f282 (MIT), checked
// against dsh 0.2.1-rc.2 on 2026-10-20 (#334).
//
// dsh runs Claude Code command hooks through a plugin, `@deepseek-ai/dsh-hooks-claude-code`.
// What the real runs showed:
// - The bridge is not in the dsh package. Each profile needs it and its peer
//   `@deepseek-ai/dsh-hook-protocol`, added with `dsh plugin --profile <p> add` (needs pnpm).
// - It loads a hooks file named by `configPath`, in the profile's cordis.patch.yml or in a
//   file passed with `--patch`. A relative `configPath` resolves from the launch folder.
// - It fails open without a word: a missing hooks file or a missing peer runs no hooks.
// - Tool names are lowercase and matched exactly: `bash` (`pwsh` on Windows), `write` and
//   `edit` with `file_path` relative to `cwd`. The payload is otherwise Claude Code's, with
//   no `agent_type`, so YOKOTEN_ROLE alone tells a worker.
// - Exit 2 with the reason on stderr refuses the call; the model sees the reason.
// - `--patch` is a launcher flag: it goes right after the profile name, before the app's own
//   flags (`dsh headless --patch <file> --json "<task>"`), or dsh says "unknown option".
// - The bridge's Stop hook has no loop guard (`stop_hook_active` is always false), so
//   yokoten writes no stop check here.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { guardCommand, missingProjectRuntime } from '../../run/cli.ts';
import { type Added, addHook, checkHooksFile, type HookState, hookState } from '../hooks-file.ts';

/**
 * A PreToolUse call, as an Action. The payload is Claude Code's, and its reader goes by the
 * fields, not the tool's name: `command` for bash, `file_path` for write and edit. A relative
 * `file_path` is resolved against `cwd` by the guard, as in Claude Code.
 */
export { readToolCall } from './claude-code.ts';

/** The tools the guard sees: the shells (`pwsh` on Windows) and the two edit tools. */
export const MATCHER = 'bash|pwsh|edit|write';
/** The bridge and its peer, at the version the real run used. Both go in every profile. */
export const VERSION = '0.2.1-rc.2';
export const PACKAGES = ['dsh-hooks-claude-code', 'dsh-hook-protocol'] as const;

export const HOOKS_FILE = '.dsh/hooks.json';
export const PATCH_FILE = '.dsh/yokoten.patch.yml';

/**
 * The launch overlay: it turns on the bridge for one run, with the project's hooks file.
 * dsh resolves the relative path from the launch folder, so dsh starts at the repo root.
 */
export const PATCH = `# yokoten: the tool-call guard for DeepSeek Harness. Start dsh at the repo root with
#   dsh <profile> --patch ${PATCH_FILE}
# The profile needs the bridge and its peer: see \`yokoten init\` or docs/guide.md#works-with.
- insert:
    - id: hooks-claude-code
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: ${HOOKS_FILE}
`;

// dsh sets no git-root variable (CLAUDE_PROJECT_DIR is the launch folder), so the path comes
// from the git root, as in Codex's hook.
const guardArgs = (root: string, cli: string) =>
  [join(root, HOOKS_FILE), 'PreToolUse', MATCHER, guardCommand(`"$(git rev-parse --show-toplevel)/${cli}"`, 'hook --agent deepseek-harness', missingProjectRuntime(cli), { isToolCall: true })] as const;

/** What `addPatch` would do: 'same', 'updated' or 'added'. yokoten owns the whole file. */
export function patchState(root: string): Added {
  const path = join(root, PATCH_FILE);
  if (!existsSync(path)) return 'added';
  return readFileSync(path, 'utf8') === PATCH ? 'same' : 'updated';
}

/**
 * Write the guard into `.dsh/hooks.json` (PreToolUse only), keeping every other hook, and the
 * launch overlay into `.dsh/yokoten.patch.yml`. A hooks file yokoten can't edit throws
 * `UnreadableHooksFile`, and neither file changes. Nothing outside the project is touched:
 * adding the packages to a profile is the user's step.
 */
export function addProjectHooks(root: string, cli: string): { guard: Added; patch: Added } {
  checkHooksFile(join(root, HOOKS_FILE), ['PreToolUse']);
  const guard = addHook(...guardArgs(root, cli));
  const patch = patchState(root);
  if (patch !== 'same') {
    mkdirSync(dirname(join(root, PATCH_FILE)), { recursive: true });
    writeFileSync(join(root, PATCH_FILE), PATCH);
  }
  return { guard, patch };
}

/** What `addProjectHooks` would do, read-only. */
export const projectHooksState = (root: string, cli: string): { guard: HookState; patch: Added } => ({
  guard: hookState(...guardArgs(root, cli)),
  patch: patchState(root),
});

/** dsh's home: `DSH_HOME`, else ~/.dsh. */
export const dshHome = (env: Env): string => env.DSH_HOME || join(env.HOME || homedir(), '.dsh');

/**
 * The profiles that have both packages, read-only; null when there is no dsh home to look
 * in. Having them does not prove the guard runs: only a real deny does.
 */
export function profilesWithBridge(env: Env): { found: string[]; all: string[] } | null {
  const profiles = join(dshHome(env), 'profiles');
  let all: string[];
  try {
    all = readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  const found = all.filter((name) => PACKAGES.every((pkg) => existsSync(join(profiles, name, 'node_modules', '@deepseek-ai', pkg, 'package.json'))));
  return { found, all };
}

/** The two commands that add the bridge to a profile. */
export const pluginAddCommands = (profile: string): string[] => PACKAGES.map((pkg) => `dsh plugin --profile ${profile} add @deepseek-ai/${pkg}@${VERSION}`);
