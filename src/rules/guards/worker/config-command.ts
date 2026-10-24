import { existsSync, globSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { ghIndex, homeOf } from '../../privacy.ts';
import { type Env } from '../../config.ts';
import { WORKER_MARK, protectedGitDirs, markFinding, FIND_WRITES } from './mark.ts';
import { configFolder, configFinding, namesConfigFolder, withHomeRead, UNKNOWN_PART, ANY_PART } from './config.ts';
import { GIT_PLAIN_OPTIONS, isLongOption, hasShortOption } from './box.ts';
import { isAssignment, withoutShellRedirects, realPath, FIND_ACTIONS, REDIRECT, programName, findPrograms, findProgramPlaces } from '../bash/read/words.ts';
import { writesFile } from '../bash/body.ts';
import { plainArgs } from '../lead-only/targets.ts';

// ---- A worker's command aimed at the home config folder (#591) ----

// The home config folder by `~`, `$HOME` or `${HOME}`, a path that climbs out with `..`, or the worker list.
const POINTS_AT_CONFIG = /(~|\$HOME|\$\{HOME\})[/\\]+\.config(?=[/\\]|$|[\s;&|)`<>'"])|\.\.[/\\](?:[^\s'"`;&|<>]*[/\\])?\.config(?=[/\\]|$|[\s;&|)`<>'"])|yokoten[/\\]+workers/i;
// Programs that only read and run nothing else.
const PLAIN_READERS = new Set(['cat', 'ls', 'head', 'tail', 'wc', 'stat', 'file', 'grep', 'egrep', 'fgrep', 'rg', 'less', 'find', 'git', 'cd', 'pwd', 'echo', 'tr', 'true']);
const GIT_READS = new Set(['status', 'log', 'diff', 'show']);

/** Whether the text names the home config folder: as POINTS_AT_CONFIG, or by the home path itself. */
function namesHomeConfig(text: string, home: string | null): boolean {
  if (POINTS_AT_CONFIG.test(text)) return true;
  if (home === null) return false;
  const tidy = text.replace(/[/\\]+(\.[/\\]+)*/g, '/').toLowerCase();
  return tidy.includes(`${home.replace(/[/\\]+/g, '/').toLowerCase()}/.config`);
}

/**
 * Whether every program in `words` only reads: PLAIN_READERS, a find that runs and deletes
 * nothing, `rg` without `--pre`, and git with only status, log, diff or show; and the words
 * redirect into no file.
 */
export function onlyReads(words: string[]): boolean {
  if (writesFile(words)) return false;
  for (const program of findPrograms(words)) {
    const name = programName(program);
    if (!PLAIN_READERS.has(name)) return false;
    const args = words.slice(words.indexOf(program) + 1);
    if (name === 'find' && args.some((arg) => FIND_WRITES.test(arg) || FIND_ACTIONS.has(arg))) return false;
    if (name === 'rg' && args.some((arg) => /^--pre(=|$)/.test(arg))) return false;
    if (name === 'git' && !GIT_READS.has(args.find((arg) => !GIT_PLAIN_OPTIONS.has(arg)) ?? '')) return false;
  }
  return true;
}

/**
 * The real path of `raw` (absolute, or relative to `base`) the way the kernel resolves it:
 * one component at a time, following each symlink before any later `..` is applied. Node's
 * resolve and realpathSync collapse `..` first, so `link/../x` would slip past the symlink.
 */
function kernelReal(raw: string, base: string | null): string {
  const seed = isAbsolute(raw) ? '' : base === null ? '' : realPath(base);
  let cur = '/';
  const seen = new Set<string>();
  for (const part of `${seed}/${raw}`.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    cur = cur === '/' ? `/${part}` : `${cur}/${part}`;
    try {
      if (lstatSync(cur).isSymbolicLink() && !seen.has(cur)) {
        seen.add(cur);
        const target = readlinkSync(cur);
        const to = isAbsolute(target) ? target : resolve(dirname(cur), target);
        try {
          cur = realpathSync(to);
        } catch {
          cur = to;
        }
      }
    } catch {
      // a part that is not on disk yet: keep walking by name.
    }
  }
  return cur;
}

// Folders a glob the guard expands never walks into, so it stays fast in a big repo.
const SKIP_IN_GLOB = (path: string) => /(^|[\\/])(node_modules|\.git)$/.test(path);

// A glob character in a path or one of its parts.
export const HAS_GLOB = /[*?[\]{}]/;

/** Whether the real `path` is yokoten's config folder, is inside it, or holds it (case aside). */
function touchesConfigReal(path: string, forms: string[][]): boolean {
  const cand = path.split(/[\\/]+/).filter(Boolean);
  for (const config of forms) {
    const shared = Math.min(cand.length, config.length);
    let isMatch = shared > 0 || cand.length === config.length;
    for (let at = 0; at < shared && isMatch; at++) isMatch = cand[at].toLowerCase() === config[at].toLowerCase();
    if (isMatch) return true;
  }
  return false;
}

/**
 * Whether `cand` (a path string, maybe a glob) reaches yokoten's config folder, resolved the
 * way the kernel would (kernelReal), so a symlink the worktree holds, a `..` after it, or a
 * glob that matches it all count. A glob is expanded against `folder` (dotfiles as bash
 * leaves them): its literal start, its matches, and, when it matches nothing, its directory's
 * matches with the plain file name are each resolved.
 */
function reachesConfig(cand: string, folder: string | null, forms: string[][]): boolean {
  const touches = (raw: string) => touchesConfigReal(kernelReal(raw, folder), forms);
  if (!HAS_GLOB.test(cand)) return touches(cand);
  const parts = cand.split(/[\\/]+/);
  const firstGlob = parts.findIndex((part) => HAS_GLOB.test(part));
  const prefix = parts.slice(0, firstGlob).join('/');
  if (prefix && touches(prefix)) return true;
  const expand = (pattern: string) => {
    try {
      return { ok: true, matches: globSync(pattern, { ...(isAbsolute(cand) ? {} : { cwd: folder ?? '.' }), exclude: SKIP_IN_GLOB }) };
    } catch {
      return { ok: false, matches: [] as string[] }; // a glob the guard can't expand may reach the folder
    }
  };
  const direct = expand(cand);
  if (!direct.ok) return true;
  if (direct.matches.some((match) => touches(match))) return true;
  // A glob does not descend a symlinked folder, so when the last part is a glob the folder it
  // sits in is checked by its real path: a link to the config folder makes every name under
  // it count, matched or not.
  const base = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  if (dir && HAS_GLOB.test(base)) {
    const dirs = HAS_GLOB.test(dir) ? expand(dir) : { ok: true, matches: [dir] };
    if (!dirs.ok) return true;
    if (dirs.matches.some((match) => touches(match))) return true;
  }
  // A plain name under a globbed folder: resolve each matched folder with it, since a glob
  // does not descend a symlinked folder and the name may not be on disk yet.
  if (dir && HAS_GLOB.test(dir) && !HAS_GLOB.test(base)) {
    const dirs = expand(dir);
    if (!dirs.ok) return true;
    return dirs.matches.some((match) => touches(`${match}/${base}`));
  }
  return false;
}

/**
 * The path strings a worker's word may aim at, with `$PWD` read as `folder` and `~`, `$HOME`
 * and `~+` read too: a redirect target, a long option's `=value`, each suffix of an attached
 * short option (`-olink/workers`), an assignment's value, or the word itself. A value the
 * guard can't read (`$x`) or an unresolved `~` is left out.
 */
function pathCandidates(word: string, folder: string | null, home: string | null): string[] {
  const target = REDIRECT.exec(word)?.[1] ?? word;
  const out: string[] = [];
  // A part the guard can't read may be empty or any name, so the path is tried both ways:
  // with the part left out, and with the part as a glob.
  const add = (text: string) => {
    if (!text) return;
    const pwd = (value: string) => (folder === null ? value : value.replace(/^(\$PWD|\$\{PWD\})(?=[\\/]|$)/, folder));
    const read = (value: string) => withHomeRead(pwd(value), home, folder);
    // A `...` split across words (`echo link`/x) leaves a stray backtick: its side is unknown.
    const halves = (value: string) => (value.split('`').length % 2 === 0 ? value.replace(/^[^`]*`(?=[^`]*$)/, '$U').replace(/`[^`]*$/, '$U') : value);
    const unknown = (value: string) => value.replace(/\$\{?PWD\}?(?=[\\/]|$)/g, '\0').replace(UNKNOWN_PART, '').replace(/\0/g, '$PWD');
    for (const form of new Set([read(unknown(halves(text))), read(halves(text)).replace(UNKNOWN_PART, ANY_PART)])) {
      const expanded = form.replace(/\*\*+/g, '*'); // bash has no globstar unless it is set
      if (!expanded || /[$`]/.test(expanded) || expanded.startsWith('~') || (folder === null && !isAbsolute(expanded))) continue;
      out.push(expanded);
    }
  };
  if (target.startsWith('--')) {
    const eq = target.indexOf('=');
    if (eq !== -1) add(target.slice(eq + 1));
  } else if (target.startsWith('-')) {
    for (let at = 1; at < target.length; at++) add(target.slice(at));
  } else if (isAssignment(target)) {
    add(target.slice(target.indexOf('=') + 1));
  } else {
    add(target);
  }
  return out;
}

/**
 * For `ln -s` or `cp -s`: whether a link it makes would lead into yokoten's config folder. A
 * link's target is read from the folder the link sits in, so each target is resolved from the
 * last word and from its parent (the last word may be a folder or the link's own name), and
 * from a `-t` folder. A target the guard can't read counts.
 */
export function symlinkTargetReach(name: string, args: string[], folder: string, home: string | null, forms: string[][]): boolean {
  const makesLinks = name === 'ln' ? args.some((arg) => hasShortOption(arg, 's') || isLongOption(arg, 'symbolic')) : name === 'cp' && args.some((arg) => hasShortOption(arg, 's') || isLongOption(arg, 'symbolic-link'));
  if (!makesLinks) return false;
  // -t and -S take a value, attached (-tdir) or next, alone or in a group (-st dir).
  const plain: string[] = [];
  const into: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--') {
      plain.push(...args.slice(at + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const isTarget = isLongOption(arg, 'target-directory');
      if (isTarget || isLongOption(arg, 'suffix')) {
        const value = eq === -1 ? (args[++at] ?? '') : arg.slice(eq + 1);
        if (isTarget) into.push(value);
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      const letter = [...arg.slice(1)].findIndex((char) => char === 't' || char === 'S');
      if (letter !== -1) {
        const rest = arg.slice(letter + 2);
        const value = rest || (args[++at] ?? '');
        if (arg[letter + 1] === 't') into.push(value);
      }
    } else plain.push(arg);
  }
  // With one plain word, the link is made in the current folder under the target's name.
  const targets = into.length || plain.length === 1 ? plain : plain.slice(0, -1);
  const bases = into.length ? into : plain.length === 1 ? ['.'] : plain.length ? [plain[plain.length - 1], dirname(plain[plain.length - 1])] : [];
  return targets.some((target) => {
    const read = withHomeRead(target.replace(/^(\$PWD|\$\{PWD\})(?=[\\/]|$)/, folder), home, folder);
    if (/[$`~*?[\]{}]/.test(read)) return true; // a target the guard can't read counts
    return bases.some((base) => touchesConfigReal(kernelReal(read, resolve(folder, base)), forms));
  });
}

// Options that make a writer walk into a folder (recursively): -r, -R, -a (archive), and
// rsync's -K, which writes through a linked folder.
const RECURSES = (args: string[]) => args.some((arg) => hasShortOption(arg, 'rRaK') || isLongOption(arg, 'recursive') || isLongOption(arg, 'archive') || isLongOption(arg, 'keep-dirlinks'));

/**
 * Whether the real folder `root` holds a symlink whose real path reaches yokoten's config
 * folder. It walks at most 6 folders deep and 5,000 entries, skips .git and node_modules, and
 * never follows a link while walking; past those limits it answers no.
 */
function holdsConfigLink(root: string, forms: string[][]): boolean {
  let left = 5000;
  const queue: [string, number][] = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift() as [string, number];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // not a readable folder: nothing to walk.
    }
    for (const entry of entries) {
      if (--left < 0) return false;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (touchesConfigReal(kernelReal(path, null), forms)) return true;
      } else if (entry.isDirectory() && depth < 6 && entry.name !== '.git' && entry.name !== 'node_modules') {
        queue.push([path, depth + 1]);
      }
    }
  }
  return false;
}

/**
 * For a worker: a word of a command that does more than read (see onlyReads) whose path is
 * yokoten's config folder, is in it, or holds it, by real path (#591). So a program that no
 * writer list knows (`gzip`, `sort -o`, `npm --prefix`, `git archive -o`) can't reach the
 * folder through a symlink in the worktree, `~+` or a glob. Each word counts, an option's
 * `=value` and a setting's value too. A part the guard can't read (`$x`) may be empty or
 * any name, so it counts when any name in its place reaches the folder. `folder` is where
 * the words run.
 */
export function configReach(words: string[], { folder, home, forms }: { folder: string | null; home: string | null; forms: string[][] }): Finding | null {
  if (!forms.length || onlyReads(words)) return null;
  const names = (shown: string) =>
    `this command does more than read and works on ${shown}, which ${/[$\`]/.test(shown) ? 'may be or hold' : 'is or holds'} yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`;
  for (const word of words) {
    if (word.includes('\n')) continue;
    for (const cand of pathCandidates(word, folder, home)) {
      if (reachesConfig(cand, folder, forms)) return configFinding(names(REDIRECT.exec(word)?.[1] ?? word));
    }
  }
  // A recursive writer whose folder holds a symlink that leaves the worktree for the config folder.
  let from = 0;
  for (const program of findPrograms(words)) {
    const at = words.indexOf(program, from);
    if (at === -1) continue;
    from = at + 1;
    if (PLAIN_READERS.has(programName(program))) continue;
    const args = withoutShellRedirects(words, at + 1);
    if (!RECURSES(args)) continue;
    for (const arg of plainArgs(args)) {
      if (/[$`]/.test(arg) || HAS_GLOB.test(arg) || arg.startsWith('~')) continue;
      if (holdsConfigLink(kernelReal(arg, folder), forms)) {
        return configFinding(`this command runs recursively in ${arg}, which holds a link into yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`);
      }
    }
  }
  return null;
}

/**
 * For a worker: a command that names the home config folder (`~/.config`, `$HOME/.config`,
 * the home path, a `..` path) or the worker list, read case aside and with quotes and
 * backslashes taken off, unless each program in it is a plain reader: PLAIN_READERS, a find
 * that runs and deletes nothing, `rg` without `--pre`, and git with only status, log, diff
 * or show. One with a substitution or a file redirect never passes. A repo's own
 * `.config/` folder is not the home one, and passes.
 */
export function checkWorkerPointers(command: string, commands: string[][], env: Env): Finding | null {
  const home = homeOf(env);
  const bare = command.replace(/['"\\]/g, '');
  if (![command, bare].some((text) => namesHomeConfig(text, home) || namesConfigFolder(text))) return null;
  const refusal = finding(
    'worker-mark',
    "a worker can't run commands that point at yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept, unless every program in it only reads",
    "run plain reads only there (cat, ls, grep, git status): only the lead changes the worker list and the bot's keys; if your task needs more, stop and tell the lead",
  );
  if (/\$\(|`|[<>]\(/.test(command)) return refusal;
  return commands.every(onlyReads) ? null : refusal;
}

/**
 * For a worker: an edit inside a git folder, or of the mark (#555), or null. `path` is
 * absolute. It is compared by real path too, so a symlink to a git folder counts; `folder` is
 * where the worker works, whose git folders count wherever they are. `env` finds yokoten's
 * config folder, where the worker list is kept (#591): an edit inside it counts too.
 */
export function checkWorkerMarkEdit(path: string, folder?: string, env: Env = {}): Finding | null {
  const what = 'this edit is inside a .git folder, where the worker mark is kept';
  const full = realPath(path);
  const config = configFolder(env);
  if (config !== null) {
    // Case aside, as in the command check: on macOS and Windows the names fold case.
    const edited = [full, resolve(path)].map((form) => form.toLowerCase());
    for (const base of new Set([resolve(config), realPath(config)].map((form) => form.toLowerCase()))) {
      if (edited.some((form) => form === base || form.startsWith(base + sep))) {
        return configFinding("this edit is inside yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept");
      }
    }
  }
  for (const form of [path, full]) {
    const parts = form.split(/[/\\]+/);
    if (parts.some((part) => part.toLowerCase() === '.git') || parts.at(-1)?.toLowerCase() === WORKER_MARK) return markFinding(what);
  }
  const dirs = folder === undefined ? [] : protectedGitDirs(folder);
  if (dirs.some((dir) => full === dir || full.startsWith(dir + sep))) return markFinding(what);
  return null;
}

/**
 * A worker's edit inside a team folder (#674): `<repo>.team/{agents,outbox,lead}`, next to a
 * checkout named `<repo>`. Outside a desk nothing else fences it, and an edit there would
 * speak for another agent. A desk's agent sends with `yokoten msg send`. Any other folder
 * whose name ends in `.team` is not a team folder.
 */
export function checkTeamEdit(path: string): Finding | null {
  for (const form of new Set([resolve(path), realPath(path)])) {
    const parts = form.split(sep);
    for (let at = 1; at + 1 < parts.length; at++) {
      const name = parts[at];
      if (!name.toLowerCase().endsWith('.team') || name.length <= '.team'.length || !TEAM_PARTS.has(parts[at + 1].toLowerCase())) continue;
      const checkout = [...parts.slice(0, at), name.slice(0, -'.team'.length), '.git'].join(sep) || sep;
      if (existsSync(checkout)) return finding('lead-only', 'this edit is inside a team folder (<repo>.team), where the agents\' messages and the roster are kept', 'send with `yokoten msg send <to> <text>` from a desk, or report to the lead');
    }
  }
  return null;
}

// The parts of a team folder (agents/desk/team/team.ts).
const TEAM_PARTS = new Set(['agents', 'outbox', 'lead']);

// Cancelling a run, an alias, and a command the host did not ship (#650). The host adapter
// owns the command names, the routes and the finding text. Both roles hear it before the
// worker's own send rule: the fix is to ask the owner, and the lead cannot do it either.

/** What a host adapter says about its own commands. The guard calls these and does not know the host. */
export interface HostCommands {
  hostRunRemoval(words: string[]): Finding | undefined;
  hostAlias(words: string[]): Finding | undefined;
  hostHiddenCommand(words: string[]): Finding | undefined;
  /** A gh command that prints its token (#668). */
  hostTokenReveal(words: string[]): Finding | undefined;
  /** A gh command that turns a workflow off (#668). */
  hostWorkflowOff(words: string[]): Finding | undefined;
  /**
   * Whether the words after the host's API command can publish a release, a tag or a public
   * repo (#829). Optional, so a stub that only lists its own commands still fits.
   */
  isPublishingApiCall?(args: string[]): boolean;
}

/**
 * The host adapter's checks, once it has loaded. The run rules refuse a `gh` command until
 * then; the host-neutral checks read a missing adapter as "no route known".
 */
let hostCommands: HostCommands | undefined;

/** The host adapter registers its command checks, once: a second registration is refused. */
export function useHostCommands(commands: HostCommands): void {
  if (hostCommands && hostCommands !== commands) throw new Error('the host command checks are already registered');
  hostCommands = commands;
}

export function hostRunRemoval(words: string[]): Finding | null {
  if (!hostCommands) {
    // A caller that never loaded src/host/gh-commands.ts must not turn the run rule off.
    return ghIndex(words, findProgramPlaces(words)) === -1 ? null : finding('run-remove', "the guard's GitHub command rules did not load, so it cannot read this `gh` command", 'start the session again; if it happens again, report it as a yokoten bug');
  }
  return hostCommands.hostRunRemoval(words) ?? null;
}

export function hostAlias(words: string[]): Finding | null {
  return hostCommands?.hostAlias(words) ?? null;
}

export function hostHiddenCommand(words: string[]): Finding | null {
  return hostCommands?.hostHiddenCommand(words) ?? null;
}

export function hostTokenReveal(words: string[]): Finding | null {
  return hostCommands?.hostTokenReveal(words) ?? null;
}

export function hostWorkflowOff(words: string[]): Finding | null {
  return hostCommands?.hostWorkflowOff(words) ?? null;
}

// The hook loads src/host/gh-commands.ts before it reads a call, so the route names live
// in the host layer and this file stays host-neutral (record 0004). A caller that does not
// load the adapter gets no route decision, so a publishing API call can pass: load the
// adapter first (the hook does, see src/run/hook.ts).
export function hostApiPublishes(args: string[]): boolean {
  return hostCommands?.isPublishingApiCall?.(args) ?? false;
}

