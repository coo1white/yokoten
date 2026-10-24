
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Env, loadConfig } from '../../rules/config.ts';
import { type Gh, isPrivateRepo, repoOf } from '../../host/github/index.ts';
import { readOriginUrl } from '../plan.ts';
import { fileHash, lfText, readWorkflowHashes, render, VERSION } from '../files.ts';
import { dependabotText, walk } from './project-files.ts';

// ---- A project that keeps CI off (#377) ----
//
// A private repo on a free plan pays for its Actions minutes. Such a project can keep CI
// off: yokoten.json "notNow" then names `ci`, and the commit hook and `yokoten check` are
// the gate. init never makes that choice itself. On a private repo it says what the
// workflows cost and how to keep them out; `init --no-ci` makes the choice.

/** The reason `init --no-ci` writes into "notNow". */
export const NO_CI_REASON = 'CI is off to save Actions minutes; the commit hook and yokoten check are the gate. Look again when the repo goes public';

/** The kit files that only CI uses: the workflows, and Dependabot, which updates only the actions CI runs. */
export const isCiFile = (rel: string): boolean => rel.startsWith('.github/workflows/') || rel === '.github/dependabot.yml';

/** True when yokoten.json "notNow" names `ci`; false when the file is missing or can't be read (`yokoten init` checks it first). */
export function isCiOffIn(root: string): boolean {
  try {
    return Object.hasOwn(loadConfig(root).notNow, 'ci');
  } catch {
    return false;
  }
}

/** True when something is at `path`, a broken symlink too. */
export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The first of the path's folders below the root, or the file itself, that is a symlink; null when none is. */
function symlinkOnPath(root: string, rel: string): string | null {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join('/');
    try {
      if (lstatSync(join(root, part)).isSymbolicLink()) return part;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The texts init writes for a kit file: the kit's copy, and for dependabot.yml also the
 * copy with the blocks for this repo's ecosystems (#379).
 */
const kitCopies = (root: string, rel: string, kitText: string): string[] =>
  [kitText, ...(rel === '.github/dependabot.yml' ? [dependabotText(root, kitText).text] : [])];

/** True when the file at `path` is a copy init wrote: the kit's newest, or (a workflow) an older one in the hash list. A folder or another odd file is not. */
function isKitCopy(root: string, rel: string, path: string, kitText: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    const text = lfText(readFileSync(path, 'utf8'));
    return kitCopies(root, rel, kitText).includes(text) || (readWorkflowHashes()[rel] ?? []).includes(fileHash(text));
  } catch {
    return false;
  }
}

/**
 * `init --no-ci`: write "notNow" `ci` into yokoten.json, and remove each CI file that is
 * still the kit's copy (line ends aside), so nobody deletes them by hand. A file the project
 * changed is kept, and so is one reached through a symlink: init never deletes through one.
 * Each kept file is named once. Returns the report lines.
 */
export function keepCiOff(root: string, cli: string, kit: string): string[] {
  const lines = [recordNotNow(root, 'ci', NO_CI_REASON)];
  for (const file of walk(kit)) {
    const rel = relative(kit, file).split('\\').join('/');
    const path = join(root, rel);
    if (!isCiFile(rel) || !lexists(path)) continue;
    const link = symlinkOnPath(root, rel);
    if (link) lines.push(`kept ${rel}: ${link} is a symlink, and init never deletes through one; delete it yourself if CI stays off`);
    else if (isKitCopy(root, rel, path, render(readFileSync(file, 'utf8'), { cli, version: VERSION }))) {
      rmSync(path);
      lines.push(`removed ${rel} (the kit's copy; CI is off)`);
    } else lines.push(`kept ${rel}: it is not the kit's copy, so delete it yourself if CI stays off`);
  }
  return lines;
}

/**
 * Set one key of yokoten.json "notNow", unless it is there. Only the text of that key
 * changes: the rest of the file keeps its formatting. When the edit can't be placed
 * safely, the file stays as it is and the line says to add the key by hand.
 */
function recordNotNow(root: string, key: string, reason: string): string {
  const path = join(root, 'yokoten.json');
  const byHand = `skipped "notNow" ${key} in yokoten.json: add "${key}": ${JSON.stringify(reason)} to "notNow" yourself`;
  let text = '{}\n';
  let file: Record<string, unknown>;
  try {
    if (existsSync(path)) text = readFileSync(path, 'utf8');
    file = JSON.parse(text);
  } catch {
    return byHand;
  }
  const notNow = (file.notNow ?? {}) as Record<string, string>;
  if (Object.hasOwn(notNow, key)) return `kept "notNow" ${key} in yokoten.json`;
  const entry = `"${key}": ${JSON.stringify(reason)}`;
  // After the opening brace of "notNow", or of the file when it has no "notNow": the new
  // entry goes first, with the same space after it as the next entry has.
  const insert = (match: RegExpExecArray | null, add: string): string | null => {
    if (!match) return null;
    const at = match.index + match[0].length;
    const space = text.slice(at).match(/^\s*/)?.[0] ?? '';
    const rest = text.slice(at + space.length);
    // An empty object: `{ "key": "…" }` on one line, whatever space it had inside.
    if (rest.startsWith('}')) return `${text.slice(0, at)} ${add} ${rest}`;
    return `${text.slice(0, at)}${space || ' '}${add},${space || ' '}${rest}`;
  };
  const hasKey = Object.hasOwn(file, 'notNow') && file.notNow !== null;
  const edited = hasKey ? insert(/"notNow"\s*:\s*\{/.exec(text), entry) : insert(/^\s*\{/.exec(text), `"notNow": { ${entry} }`);
  // The edit counts only when the file reads back as before, plus the one key.
  try {
    const after = edited === null ? null : JSON.parse(edited);
    const expected = { ...file, notNow: { ...notNow, [key]: reason } };
    if (!after || JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(expected))) return byHand;
  } catch {
    return byHand;
  }
  writeFileSync(path, edited as string);
  return `wrote "notNow" ${key} in yokoten.json (to take CI up again, remove it and run \`yokoten init\`)`;
}

/** A copy with the keys of every object in order, so two readings compare by content. */
const sortKeys = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])) : value;

/**
 * On a private repo, a note that the workflows use Actions minutes, and how to keep them
 * out. Nothing when gh can't tell, or the repo is public. One gh call, only with a GitHub remote.
 */
export function privateRepoNote(root: string, gh: Gh, env: Env): string[] {
  const repo = repoOf(readOriginUrl(root, env));
  if (!repo || isPrivateRepo(gh, repo) !== true) return [];
  return [
    'note: this repo is private, so the workflows in .github/workflows use Actions minutes from your plan',
    'to keep CI off, run `yokoten init --no-ci`: it removes the workflows init wrote, and records the choice in yokoten.json',
  ];
}
