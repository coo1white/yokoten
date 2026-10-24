
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, type Env } from '../../rules/config.ts';
import { codeOwnersPath, WORKTREES_DIR } from '../../rules/layout.ts';
import { AGENT_STATUS_FILE } from '../../run/hook.ts';
import { CODEOWNERS_PLACES, type Gh, isOrganization, repoOf } from '../../host/github/index.ts';
import { readOriginUrl } from '../plan.ts';
import { writeNew } from '../files.ts';

/** yokoten's own repo runs its own bin; every other project runs a vendored copy. */
export const isSelf = (root: string): boolean => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'yokoten' && existsSync(join(root, 'bin', 'yokoten.ts'));
  } catch {
    return false;
  }
};

export const cliPath = (root: string): string => (isSelf(root) ? 'bin/yokoten.ts' : '.yokoten/bin/yokoten.ts');

/**
 * The entry the agent hooks run: bin/yokoten.mjs, next to `cliPath`. Plain JavaScript, so Node
 * starts it without its type stripper (#408). The git hook, CI and the docs keep `cliPath`.
 */
export const hookCliPath = (root: string): string => cliPath(root).replace(/\.ts$/, '.mjs');

export function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}


// ---- CODEOWNERS for the lead-only paths (#304) ----
//
// The guard and the commit check stop a worker on the machine; CODEOWNERS stops the same
// change on the server, where `check --pr` makes it tier A and the host asks the owner to
// review. Its paths come from DEFAULTS.leadOnly, so the two lists can't drift. init
// writes the file rather than copying it from the kit: both the paths and the owner vary.

/** The owner init writes when it can't tell who owns the repo. A GitHub handle has no underscore, so this is never a real account. */
export const OWNER_PLACEHOLDER = '@YOUR_GITHUB_HANDLE';

/** A lead-only glob as a CODEOWNERS path: `x/**` is the folder `/x/`, a file is `/file`. One rule, kept in `rules/layout.ts`. */
export const ownedPath = codeOwnersPath;

/**
 * The CODEOWNERS init writes: every default lead-only path, owned by `owner`, or by the
 * placeholder when null. `org` is the organization that owns the repo, named in the hint.
 */
export function codeOwnersText(owner: string | null, org?: string): string {
  const handle = owner ? `@${owner}` : OWNER_PLACEHOLDER;
  const lines = [
    '# Written by yokoten init. The owner reviews every change to these paths: the rules',
    "# the agents work under, their config, the hooks and CI (yokoten's lead-only defaults).",
    '# Turn on "Require review from Code Owners" in branch protection, or GitHub asks',
    '# nobody. `yokoten check --pr` makes a change here tier A either way.',
  ];
  if (!owner && org) lines.push(`# @${org} is an organization, and GitHub takes no organization here: put a person's handle or @${org}/<team> in place of ${OWNER_PLACEHOLDER} on each line below.`);
  else if (!owner) lines.push(`# Put your GitHub handle in place of ${OWNER_PLACEHOLDER} on each line below.`);
  const paths = DEFAULTS.leadOnly.map(ownedPath);
  const width = Math.max(...paths.map((path) => path.length));
  return [...lines, '', ...paths.map((path) => `${path.padEnd(width)} ${handle}`), ''].join('\n');
}

/** The GitHub account in the origin remote's URL, or null without a GitHub remote. */
const readRemoteOwner = (root: string, env: Env): string | null => repoOf(readOriginUrl(root, env))?.split('/')[0] ?? null;

/**
 * Write .github/CODEOWNERS unless the project has one in any place GitHub reads. Returns
 * the report line. An organization can't own a path in CODEOWNERS, so when gh says the
 * remote owner is one, the file gets the placeholder (#313). When gh can't tell, the
 * remote owner stays: most repos belong to a person.
 */
export function writeCodeOwners(root: string, gh: Gh, env: Env): string {
  const found = CODEOWNERS_PLACES.find((place) => existsSync(join(root, place)));
  if (found) return `kept ${found}`;
  const remote = readRemoteOwner(root, env);
  const org = remote !== null && isOrganization(gh, remote) === true;
  const owner = org ? null : remote;
  writeNew(join(root, '.github', 'CODEOWNERS'), codeOwnersText(owner, org ? remote : undefined));
  if (org) return `wrote .github/CODEOWNERS (the lead-only paths; @${remote} is an organization, so put a person or @${remote}/<team> in place of ${OWNER_PLACEHOLDER})`;
  return owner
    ? `wrote .github/CODEOWNERS (the lead-only paths, owned by @${owner})`
    : `wrote .github/CODEOWNERS (the lead-only paths; make the repo, add the remote and push, then put your GitHub handle in place of ${OWNER_PLACEHOLDER})`;
}

// ---- Dependabot for the project's own packages (#379) ----
//
// The kit's dependabot.yml updates the actions CI runs. init adds one block for each
// package manager it finds, from the manifest and lock files at the root and in the
// folders one level down. An ecosystem at the root gets `/` only: a workspace there (npm,
// Cargo, Go) covers its members, and a second block for a member would open a second pull
// request for the same lock file. An ecosystem only in subfolders gets each of them.
// Only init runs this; the hooks never do. A dependabot.yml that is already there is the
// project's: init keeps it and names the ecosystems it doesn't update.

/** The Dependabot ecosystems in the order init writes them, each with the files that show it. */
const ECOSYSTEMS: readonly (readonly [string, (name: string) => boolean])[] = [
  ['bun', (name) => name === 'bun.lock' || name === 'bun.lockb'],
  ['npm', (name) => name === 'package.json'],
  ['cargo', (name) => name === 'Cargo.toml'],
  ['uv', (name) => name === 'uv.lock'],
  ['pip', (name) => ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'].includes(name)],
  ['gomod', (name) => name === 'go.mod'],
  ['bundler', (name) => name === 'Gemfile'],
  ['nuget', (name) => /\.(?:cs|fs|vb)proj$|\.sln$|^packages\.config$|^Directory\.Packages\.props$/.test(name)],
  ['maven', (name) => name === 'pom.xml'],
  ['gradle', (name) => /^(?:build|settings)\.gradle(?:\.kts)?$/.test(name)],
  ['composer', (name) => name === 'composer.json'],
  ['mix', (name) => name === 'mix.exs'],
  ['pub', (name) => name === 'pubspec.yaml'],
  ['swift', (name) => name === 'Package.swift'],
];

/** Folders that hold built, fetched or tool files, not a project of their own. */
const NOT_PROJECTS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'coverage', 'venv', '__pycache__']);

/** The ecosystems that the file names in one folder show. A bun or uv lock file means that manager, not npm or pip. */
function readFolderEcosystems(names: string[]): Set<string> {
  const found = new Set(ECOSYSTEMS.filter(([, shows]) => names.some(shows)).map(([name]) => name));
  if (found.has('bun')) found.delete('npm');
  if (found.has('uv')) found.delete('pip');
  return found;
}

/** Each ecosystem the project uses, with the folders Dependabot reads it in (`/` or `/sub`), in a fixed order. */
export function findEcosystems(root: string): Map<string, string[]> {
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const fileNames = (dir: string) => list(dir).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const top = list(root);
  const atRoot = readFolderEcosystems(top.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const subfolders = top
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NOT_PROJECTS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const inSubfolders = subfolders.map((sub) => [sub, readFolderEcosystems(fileNames(join(root, sub)))] as const);
  const found = new Map<string, string[]>();
  for (const [name] of ECOSYSTEMS) {
    const dirs = atRoot.has(name) ? ['/'] : inSubfolders.filter(([, names]) => names.has(name)).map(([sub]) => `/${sub}`);
    if (dirs.length > 0) found.set(name, dirs);
  }
  return found;
}

// ---- A .gitignore for the status file, the worker worktrees and the dependency folders (#521, #571, #614) ----
//
// Without one, `git add -A` stages node_modules. init always ignores the folder worker
// worktrees live in, reads the same package managers as Dependabot to write the folders
// each one fills, and the board's agent status file (#601, #614). It only adds lines that are missing.

/** The folders each package manager fills with fetched or built files. */
const IGNORED_FOLDERS: Record<string, string[]> = {
  bun: ['node_modules/'],
  npm: ['node_modules/'],
  cargo: ['target/'],
  uv: ['.venv/', '__pycache__/'],
  pip: ['.venv/', '__pycache__/'],
  bundler: ['vendor/bundle/'],
  composer: ['vendor/'],
  maven: ['target/'],
  gradle: ['.gradle/', 'build/'],
  nuget: ['bin/', 'obj/'],
  mix: ['_build/', 'deps/'],
  pub: ['.dart_tool/'],
  swift: ['.build/'],
};

/** A .gitignore line as a bare folder name, so `/node_modules` and `node_modules/` count as the same. */
const folderOf = (line: string): string => line.trim().replace(/^\//, '').replace(/\/$/, '');

/** Add the worker worktrees folder, the board's agent file, and the dependency folders of the project's package managers to .gitignore. */
export function writeGitignore(root: string): string {
  const folders = [...new Set([...findEcosystems(root).keys()].flatMap((name) => IGNORED_FOLDERS[name] ?? []))];
  const wanted = [`${WORKTREES_DIR}/`, ...folders, AGENT_STATUS_FILE];
  const path = join(root, '.gitignore');
  const old = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const have = new Set((old ?? '').split(/\r?\n/).map(folderOf));
  const missing = wanted.filter((line) => !have.has(folderOf(line)));
  if (old === null) {
    writeNew(path, `${missing.join('\n')}\n`);
    return `wrote .gitignore (${missing.join(', ')})`;
  }
  if (missing.length === 0) return 'kept .gitignore';
  const lead = old === '' || old.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${lead}${missing.join('\n')}\n`);
  return `added to .gitignore: ${missing.join(', ')}`;
}

/** One update block in the kit's shape: monthly, a week old, one grouped pull request, prefix chore. */
export function formatDependabotBlock(ecosystem: string, dirs: string[]): string {
  const where = dirs.length === 1 ? [`    directory: ${dirs[0]}`] : ['    directories:', ...dirs.map((dir) => `      - ${dir}`)];
  return [
    `  - package-ecosystem: ${ecosystem}`,
    ...where,
    '    schedule:',
    '      interval: monthly',
    '    cooldown:',
    '      default-days: 7',
    '    groups:',
    `      ${ecosystem}:`,
    "        patterns: ['*']",
    '    commit-message:',
    '      prefix: chore',
    '',
  ].join('\n');
}

/** The ecosystems a dependabot.yml names. */
export const readDependabotEcosystems = (text: string): Set<string> =>
  new Set([...text.matchAll(/^\s*-?\s*package-ecosystem:\s*["']?([\w-]+)/gm)].map((match) => match[1]));

/** The dependabot.yml init writes here: the kit's file and a block for each ecosystem found. */
export function dependabotText(root: string, kitText: string): { text: string; found: Map<string, string[]> } {
  const found = findEcosystems(root);
  const blocks = [...found].map(([name, dirs]) => formatDependabotBlock(name, dirs)).join('');
  return { text: kitText.replace(/\n*$/, '\n') + blocks, found };
}

/**
 * Write .github/dependabot.yml: the kit's file and a block for each ecosystem found. A
 * dependabot.yml or .yaml that is there is kept, and the line names what it doesn't update.
 */
export function writeDependabot(root: string, kitText: string): string {
  const { text, found } = dependabotText(root, kitText);
  const existing = ['.github/dependabot.yml', '.github/dependabot.yaml'].find((place) => existsSync(join(root, place)));
  if (existing) {
    const has = readDependabotEcosystems(readFileSync(join(root, existing), 'utf8'));
    const missing = [...found.keys()].filter((name) => !has.has(name));
    if (missing.length === 0) return `kept ${existing}`;
    return `kept ${existing}; it does not update ${missing.join(', ')}. Copy its github-actions block for each, with prefix chore`;
  }
  writeNew(join(root, '.github', 'dependabot.yml'), text);
  return found.size === 0
    ? 'wrote .github/dependabot.yml (the actions CI runs)'
    : `wrote .github/dependabot.yml (the actions CI runs, and ${[...found.keys()].join(', ')})`;
}
