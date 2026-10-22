// What yokoten knows about the `gh` command and GitHub's API routes for an Actions run.
// Only src/host/ names a host's API (record 0004). The guard calls the functions below
// in host-neutral words. This file registers them when it loads.

import { type Finding, finding } from '../rules/message.ts';
import { findProgramPlaces, plainArgs, useHostCommands, withoutShellRedirects } from '../rules/guards.ts';
import { ghIndex, type HostApiCall, optionValue, useHostApi } from '../rules/privacy.ts';

// ---- Cancelling or deleting an Actions run (#650) ----
//
// The bot may rerun a run, so the lead can clear a stuck check. The same token can cancel
// a run or delete the run and its log. A cancelled run turns a check red and blocks the
// merge. A deleted log is evidence gone. Only the owner does those, on the Actions page.
// `gh run rerun`, `view`, `list` and `watch` stay allowed. `readApi` is the one walk of
// a `gh api` call: every option in `API_VALUES`. A cluster of short options is refused
// there, not split. Route words match in any case.

const RUN_FIX = 'ask the owner, who can cancel or delete the run on the Actions page';
// Two segments (`o/r`, `$OWNER/$REPO`), or one variable (`$REPO`, `${REPO}`, `$1`, `$@`, `$*`):
// that variable usually holds `owner/repo`, and the guard does not expand it (#650).
const ONE_VAR = String.raw`\$(?:\{(?:[A-Za-z_]\w*|\d+|[*@])\}|[A-Za-z_]\w*|\d+|[*@])`;
const ONE_VAR_WHOLE = new RegExp(`^${ONE_VAR}$`);
const OWNER_REPO = `(?:[^/]+/[^/]+|${ONE_VAR})`;
// `repositories/<id>` is the same route as `repos/<owner>/<repo>`.
const REPO = `(?:repos/${OWNER_REPO}|repositories/[^/]+)`;
const RUN_CANCEL = new RegExp(`^${REPO}/actions/runs/[^/]+/(?:cancel|force-cancel)$`, 'i');
const RUN_DELETE = new RegExp(`^${REPO}/actions/runs/[^/]+$`, 'i');
const RUN_LOGS = new RegExp(`^${REPO}/actions/runs/[^/]+/logs$`, 'i');
const JOB_LOGS = new RegExp(`^${REPO}/actions/jobs/[^/]+/logs$`, 'i');

/** Whether `path` has a `$` outside the owner/repo slot (`repos/<owner>/<repo>` or `repositories/<id>`) (#650). */
function dollarOutsideSlot(path: string): boolean {
  if (!path.includes('$')) return false;
  const two = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(path);
  if (two) return (two[3] ?? '').includes('$');
  const one = /^repos\/([^/]+)(?:\/(.*))?$/i.exec(path);
  if (one && ONE_VAR_WHOLE.test(one[1])) return (one[2] ?? '').includes('$');
  const byId = /^repositories\/([^/]+)(?:\/(.*))?$/i.exec(path);
  if (byId) return (byId[2] ?? '').includes('$');
  return true;
}

/** Whether `path` is only a variable after `repos/` or `repositories/`, with nothing after it (#650). */
function isOpenVariable(path: string): boolean {
  const one = /^(?:repos|repositories)\/([^/]+)$/i.exec(path);
  return one !== null && ONE_VAR_WHOLE.test(one[1]);
}

/** Whether this path is a run route, or is too unclear to say it is not (#650). */
function couldReachRun(path: string): boolean {
  return RUN_CANCEL.test(path) || RUN_DELETE.test(path) || RUN_LOGS.test(path) || JOB_LOGS.test(path) || dollarOutsideSlot(path);
}

/**
 * `gh run cancel`, `gh run delete`, or the `gh api` call that does the same.
 * Undefined when the command is none of those (#650).
 */
export function hostRunRemoval(words: string[]): Finding | undefined {
  const at = ghIndex(words, findProgramPlaces(words));
  if (at === -1) return undefined;
  const args = withoutShellRedirects(words, at + 1);
  // The same global options the worker send rule skips, so `-R` and `--hostname` do not hide the subcommand.
  const plain = plainArgs(args, ['-R', '--repo', '--hostname']);
  if (plain[0] === 'run' && plain[1] === 'cancel') return finding('run-remove', '`gh run cancel` cancels an Actions run', RUN_FIX);
  if (plain[0] === 'run' && plain[1] === 'delete') return finding('run-remove', '`gh run delete` deletes an Actions run and its log', RUN_FIX);
  // The subcommand itself is a shell variable: `gh run $X 1`. It may be cancel or delete.
  if (plain[0] === 'run' && (plain[1] ?? '').startsWith('$')) return finding('run-remove', '`gh run` with a subcommand from the shell can cancel or delete a run', RUN_FIX);
  if (plain[0] !== 'api') return undefined;
  const call = readApi(args.slice(args.indexOf('api') + 1));
  if (call.cluster) return apiClusterFinding();
  // No method and a field or `--input`: gh sends POST. A named method wins, including GET.
  const method = call.method || (call.hasFields ? 'POST' : 'GET');
  if (method === 'POST' && RUN_CANCEL.test(call.path)) return finding('run-remove', 'this `gh api` call cancels an Actions run', RUN_FIX);
  if (method === 'DELETE' && RUN_DELETE.test(call.path)) return finding('run-remove', 'this `gh api` call deletes an Actions run', RUN_FIX);
  if (method === 'DELETE' && (RUN_LOGS.test(call.path) || JOB_LOGS.test(call.path))) return finding('run-remove', 'this `gh api` call deletes an Actions log', RUN_FIX);
  // A method from the shell, on a path that can be a run. The guard does not expand it.
  if (call.method.includes('$') && couldReachRun(call.path)) return finding('run-remove', 'this `gh api` call takes its method from the shell on a run path', RUN_FIX);
  // A `$` past the owner/repo slot, or a path that is only a variable, and the call is not a GET.
  if ((dollarOutsideSlot(call.path) || isOpenVariable(call.path)) && method !== 'GET') return finding('run-remove', 'this `gh api` call takes its path from the shell, so the run is not clear', RUN_FIX);
  return undefined;
}

const GH_ALIAS_FIX = 'ask the owner to add the alias by hand';

/** `gh alias set` and `gh alias import` hide any later command under a new name, for both roles (#650). */
function hostAlias(words: string[]): Finding | undefined {
  const at = ghIndex(words, findProgramPlaces(words));
  if (at === -1) return undefined;
  const plain = plainArgs(withoutShellRedirects(words, at + 1), ['-R', '--repo', '--hostname']);
  if (plain[0] !== 'alias' || (plain[1] !== 'set' && plain[1] !== 'import')) return undefined;
  return finding('alias', `\`gh alias ${plain[1]}\` makes an alias, which can hide any command from the guard`, GH_ALIAS_FIX);
}

// gh's own commands, from `gh help` of gh 2.103.0 (2026-10-21). A first word that is not
// here is an alias or an extension, and the guard cannot see what it runs. `help` is the
// help command: the help text names it under "LEARN MORE", not under the command headings.
// `co` is the built-in alias for `pr checkout`, listed under ALIAS COMMANDS. `ext` and
// `extensions` are aliases of `extension` (see `gh extension --help`), not names in this list.
const GH_COMMANDS = new Set([
  'help',
  'auth', 'browse', 'codespace', 'discussion', 'gist', 'issue', 'org', 'pr', 'project', 'release', 'repo', 'skill',
  'cache', 'run', 'workflow',
  'co',
  'agent-task', 'alias', 'api', 'attestation', 'completion', 'config', 'copilot', 'extension',
  'gpg-key', 'label', 'licenses', 'preview', 'ruleset', 'search', 'secret', 'ssh-key', 'status', 'variable',
]);
const GH_COMMAND_FIX = 'run the gh command by its own name, so the guard can read it';
const GH_EXTENSION_FIX = 'ask the owner to change extensions by hand';
// `exec` runs an installed extension. `browse` can install one. `list` stays allowed.
const BLOCKED_EXTENSION = new Set(['install', 'upgrade', 'exec', 'browse']);

/** A `gh` command that is not gh's own, or that installs, runs or browses an extension, or sets an alias (#650). */
function hostHiddenCommand(words: string[]): Finding | undefined {
  const at = ghIndex(words, findProgramPlaces(words));
  if (at === -1) return undefined;
  // `-h` and `--host` take a value on `gh config set`, so they do not become the key.
  const plain = plainArgs(withoutShellRedirects(words, at + 1), ['-R', '--repo', '--hostname', '-h', '--host']);
  const [group, sub, key] = plain;
  if (group === undefined || GH_COMMANDS.has(group)) {
    if (group === 'extension' && BLOCKED_EXTENSION.has(sub ?? '')) {
      if (sub === 'exec') return finding('alias', '`gh extension exec` runs an extension, so the guard cannot see what it runs', GH_EXTENSION_FIX);
      if (sub === 'browse') return finding('alias', '`gh extension browse` can install an extension, which gh will then run', GH_EXTENSION_FIX);
      return finding('alias', `\`gh extension ${sub}\` can put code on this machine that gh will run`, GH_EXTENSION_FIX);
    }
    if (group === 'config' && sub === 'set' && /^aliases(?:\.|$)/i.test(key ?? '')) {
      return finding('alias', '`gh config set aliases` adds an alias, which can hide any command from the guard', GH_ALIAS_FIX);
    }
    return undefined;
  }
  return finding('alias', `\`gh ${group}\` is not a gh command, so the guard cannot see what it runs`, GH_COMMAND_FIX);
}

// The options of the api subcommand that take a value (gh 2.102 help). One list for the
// path, the method and a posted body: `-q -XGET` is a jq program, not a second method.
const METHOD_OPTIONS = new Set(['-X', '--method']);
const FIELD_OPTIONS = new Set(['-f', '--raw-field', '-F', '--field']);
const INPUT_OPTIONS = new Set(['--input']);
const API_VALUES = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
// A short option that takes the rest of the word as its value: `-XDELETE`, `-fk=v`.
// `-R` is gh's global `--repo`, the same shape (`-Ro/r`). Any other run of two or more
// short letters is several flags (`-iX` is `-i` then `-X`). This walk does not split them (#650).
const JOINED_LETTER = new Set(['X', 'f', 'F', 'H', 'q', 't', 'p', 'R']);

/** A cluster of two or more short letters that is not one known option with its value joined (#650). */
function isOptionCluster(word: string): boolean {
  if (!word.startsWith('-') || word.startsWith('--')) return false;
  const letters = /^[A-Za-z]+/.exec(word.slice(1));
  return letters !== null && letters[0].length >= 2 && !JOINED_LETTER.has(letters[0][0]);
}

/** One walk of a `gh api` call: its method, its raw endpoint word, whether it sends fields, and a short-option cluster. */
function scanApi(args: string[]): { method: string; rawPath: string; hasFields: boolean; cluster: boolean } {
  let method = '';
  let rawPath = '';
  let hasFields = false;
  for (let index = 0; index < args.length; ) {
    // A cluster hides the method. Refuse the call; do not read the flags inside it.
    if (isOptionCluster(args[index] ?? '')) return { method, rawPath, hasFields, cluster: true };
    const option = optionValue(args, index, API_VALUES);
    if (option) {
      if (METHOD_OPTIONS.has(option.name)) {
        const value = (option.value ?? '').trim();
        if (value) method = value.toUpperCase();
      } else if (FIELD_OPTIONS.has(option.name) || INPUT_OPTIONS.has(option.name)) hasFields = true;
      index = option.next;
      continue;
    }
    if (rawPath === '' && !args[index].startsWith('-')) rawPath = args[index];
    index++;
  }
  return { method, rawPath, hasFields, cluster: false };
}

/** The finding for a `gh api` short-option cluster: the method is not clear (#650). */
function apiClusterFinding(): Finding {
  return finding('run-remove', 'this `gh api` call joins short options, so its method is not clear', 'write each short option as its own word, so the guard can read the method');
}

/**
 * The endpoint path, so a `repos/...` path and a full `https://api.github.com/...` URL are
 * the same call. A query or fragment is dropped. A GitHub Enterprise `/api/v3` prefix is
 * dropped. One `%` escape is read, so `%2F` is a slash. `.` is dropped, `..` goes up one
 * segment, and empty segments from `//` are merged.
 */
function plainEndpoint(endpoint: string): string {
  const bare = endpoint.split(/[?#]/, 1)[0] ?? '';
  let path = bare;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bare)) {
    try {
      path = new URL(bare).pathname;
    } catch {
      return '';
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // A `%` that is not an escape stays as written, and the call does not match.
  }
  path = path.replace(/^\/+/, '').replace(/^api\/v3\//, '').replace(/\/+$/, '');
  const kept: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      kept.pop();
      continue;
    }
    kept.push(part);
  }
  return kept.join('/');
}

/**
 * A `gh api` call as the guard reads it. `method` is upper case, or `''` when the call
 * names none: gh then sends POST if `hasFields` is set, else GET. `path` is the endpoint
 * with the URL parts removed. `cluster` is a run of short options this walk will not split (#650).
 */
function readApi(args: string[]): HostApiCall {
  const call = scanApi(args);
  return { method: call.method, rawPath: call.rawPath, path: plainEndpoint(call.rawPath), hasFields: call.hasFields, cluster: call.cluster };
}

// Known-bad commands for doctor's self-test. A check that lets one through is named here.
const GUARD_SAMPLES: { command: string; name: string }[] = [
  { command: 'gh run cancel 1', name: 'run-remove guard' },
  { command: 'gh api -iXDELETE repos/o/r/actions/runs/1', name: 'run-remove guard' },
  { command: 'gh api -X DELETE repos/$URL', name: 'run-remove guard' },
  { command: 'gh x 1', name: 'gh command guard' },
  { command: 'gh extension install o/gh-x', name: 'gh command guard' },
  { command: 'gh extension exec demo', name: 'gh command guard' },
  { command: 'gh extension browse', name: 'gh command guard' },
];

/** The names of the samples `check` did not catch. A finding counts as a catch. Each name is listed once. */
export function hostGuardMisses(check: (command: string) => unknown): string[] {
  const missed: string[] = [];
  const seen = new Set<string>();
  for (const sample of GUARD_SAMPLES) {
    if (check(sample.command)) continue;
    if (seen.has(sample.name)) continue;
    seen.add(sample.name);
    missed.push(sample.name);
  }
  return missed;
}

useHostApi({ read: readApi, clusterFinding: apiClusterFinding, values: () => API_VALUES });
useHostCommands({ hostRunRemoval, hostAlias, hostHiddenCommand });
