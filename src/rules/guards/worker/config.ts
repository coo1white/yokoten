import { isAbsolute, join, resolve } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { homeOf } from '../../privacy.ts';
import { type Env } from '../../config.ts';
import { globMatches, braceForms, realPath } from '../bash/read/words.ts';

// ---- yokoten's config folder (#591) ----
//
// The worker list and the bot's keys are in `~/.config/yokoten`. A worker that clears the
// list loses its role, as with the mark (#555), so a worker's plain ways to change that
// folder are refused too: see checkWorkerWrites and checkWorkerMarkEdit. Reads pass.

/** yokoten's config folder, which holds the worker list and the bot's keys; null with no home folder. */
export function configFolder(env: Env): string | null {
  const home = homeOf(env);
  return home ? join(home, '.config', 'yokoten') : null;
}

/** The stop log's name, in yokoten's config folder (#621). */
export const STOPS_FILE = 'stops.jsonl';
/** The file that says the owner turned the stop log off (#621). */
export const STOPS_OFF_FILE = 'stops-off';

/** The stop log in yokoten's config folder, or null with no home folder. Nothing reads it from the project (#621). */
export function stopsFile(env: Env): string | null {
  const folder = configFolder(env);
  return folder ? join(folder, STOPS_FILE) : null;
}

/** The file that marks the stop log off, or null with no home folder (#621). */
export function stopsOffFile(env: Env): string | null {
  const folder = configFolder(env);
  return folder ? join(folder, STOPS_OFF_FILE) : null;
}

const CONFIG_FIX = "leave yokoten's config folder (~/.config/yokoten) as it is: only the lead changes the worker list and the bot's keys; if your task needs a change there, stop and tell the lead";
export const configFinding = (what: string) => finding('worker-mark', what, CONFIG_FIX);

// Text that names yokoten's config folder or the worker list.
const NAMES_CONFIG = /\.config[\\/]+yokoten|yokoten[\\/]+workers/i;

/**
 * Whether a command names yokoten's config folder or the worker list, in text or by a glob
 * that can match `.config/yokoten` or `yokoten/workers`. A pair of bare globs (`*` `/` `*`)
 * names nothing.
 */
export function namesConfigFolder(command: string): boolean {
  if (NAMES_CONFIG.test(command)) return true;
  for (const word of command.split(/[\s'"`;|&<>()=:]+/)) {
    const parts = word.split(/[\\/]+/);
    for (let at = 0; at + 1 < parts.length; at++) {
      const pair = [parts[at], parts[at + 1]];
      if (!pair.some((part) => /[a-z]/i.test(part))) continue;
      if (globMatches(pair[0], '.config') && globMatches(pair[1], 'yokoten')) return true;
      if (globMatches(pair[0], 'yokoten') && globMatches(pair[1], 'workers')) return true;
    }
  }
  return false;
}

/**
 * `path` with a leading `~`, `$HOME` or `${HOME}` read as `home`, and a leading `~+` (the
 * shell's `$PWD`) as `folder`; as it is when that one is unknown.
 */
export function withHomeRead(path: string, home: string | null, folder: string | null = null): string {
  if (folder !== null && /^~\+(?=[\\/]|$)/.test(path)) return folder + path.slice(2);
  if (home === null) return path;
  const lead = /^(~|\$HOME|\$\{HOME\})(?=[\\/]|$)/.exec(path);
  return lead ? home + path.slice(lead[0].length) : path;
}

/** The folders a path may not be, be in, or hold: the config folder as written and by real path. */
export function configForms(config: string): string[][] {
  return [...new Set([config, realPath(config)])].map((form) => form.split(/[\\/]+/).filter(Boolean));
}

/**
 * Whether the absolute `path` is yokoten's config folder, inside it, or a folder that holds
 * it (`~/.config`, `~`). It is compared by real path, so a symlink counts. A glob part
 * (`yoko*`, `{yokoten,x}`) counts when it can match the folder's part in the same place.
 */
export function touchesConfig(path: string, forms: string[][]): boolean {
  for (const form of braceForms(path, 0)) {
    const parts = form.split(/[\\/]+/).filter(Boolean);
    const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
    const candidates =
      firstGlob === -1
        ? [parts, realPath(form).split(/[\\/]+/).filter(Boolean)]
        : [parts, [...realPath(`/${parts.slice(0, firstGlob).join('/')}`).split(/[\\/]+/).filter(Boolean), ...parts.slice(firstGlob)]];
    for (const candidate of candidates) {
      for (const config of forms) {
        const shared = Math.min(candidate.length, config.length);
        let isMatch = true;
        for (let at = 0; at < shared && isMatch; at++) isMatch = globMatches(candidate[at], config[at].toLowerCase());
        if (isMatch) return true;
      }
    }
  }
  return false;
}

// A part of a path the guard can't read: a variable, `${...}`, `$(...)` or `...`.
export const UNKNOWN_PART = /\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]/g;
// What an unknown part may be: any name, a dot name too (`*` alone skips those).
export const ANY_PART = '{*,.*}';

/** Whether a path whose start can't be read goes on with `.config` and, if more, `yokoten` (`$H/.c*`, `$H/.config/yo*`). */
function hasConfigTail(path: string): boolean {
  const parts = path.split(/[\\/]+/);
  return parts.some((part, at) => /[a-z]/i.test(part) && globMatches(part, '.config') && (at + 1 === parts.length || !parts[at + 1] || globMatches(parts[at + 1], 'yokoten')));
}

export type ConfigContext = { folder: string | null; command: string; words: string[]; home: string | null; forms: string[][] };

/**
 * For a worker: why `target` may change yokoten's config folder (#591), or null. `does` is
 * what the command does to it; `shown` is the path as the command wrote it. `~`, `$HOME` and `${HOME}` are read as home; any other
 * unknown part (`$X`, `$(...)`) may be any name. A target whose start can't be read (`$H/...`,
 * `~user`, a relative path from an unknown folder) counts when the command, its words with
 * quotes taken off, or the target itself names the config folder or the worker list.
 */
export function configTargetRefusal(target: string, context: ConfigContext, { does = 'changes', shown = target } = {}): Finding | null {
  const { folder, command, words, home, forms } = context;
  const expanded = withHomeRead(target, home, folder);
  const globbed = expanded.replace(UNKNOWN_PART, ANY_PART);
  const isStartRead = !globbed.startsWith(ANY_PART) && !globbed.startsWith('~') && !/[$`]/.test(globbed) && (folder !== null || isAbsolute(globbed));
  if (isStartRead && forms.length) {
    const full = resolve(folder ?? '/', globbed);
    return touchesConfig(full, forms) ? configFinding(`this command ${does} ${shown}, which is or holds yokoten's config folder (~/.config/yokoten), where the worker list and the bot's keys are kept`) : null;
  }
  const isNamed = namesConfigFolder(command) || namesConfigFolder(words.join(' ')) || namesConfigFolder(globbed) || (!isStartRead && hasConfigTail(globbed));
  return isNamed ? configFinding(`this command ${does} ${shown}, a path yokoten can't read, and names yokoten's config folder, where the worker list is kept`) : null;
}

/** What the workers file starts with: what it is, and what clears an entry. */
