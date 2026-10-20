// `yokoten install`: the machine layer, the same on every computer. It puts the skills
// where Claude Code and the agents that read `.agents/skills` find them in every project,
// the agents where Claude Code finds them, and adds two user-level hooks, for Claude Code,
// Codex and Gemini CLI alike:
//
// - SessionStart runs `doctor --session`, so every session in every repo starts by
//   hearing which practices that repo is missing. Nobody has to remember to ask.
// - PreToolUse (BeforeTool in Gemini CLI) runs `hook --commands-only`: no tag pushes, no
//   force pushes, no skipped checks, in every repo, adopted or not.
//
// Grok CLI gets the PreToolUse guard only, in ~/.grok/hooks/yokoten.json.
//
// `yokoten uninstall` takes back what install wrote and marked as its own, for a machine
// that moves to the Claude Code plugin (#300): the plugin brings the same pieces, and both
// at once run every hook twice and show every skill twice.
//
// It ends by saying how to call `yokoten` when no `yokoten` on the PATH runs this copy
// (#208): every message says `yokoten init`, and a clone install puts nothing on the
// PATH. It prints the alias and never edits the shell profile: that file is the user's.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { skillFile as sharedSkillFile } from '../agents/agent-skills.ts';
import { addUserHooks, agentFile, hasSessionDoctor, hasUserGuard, removeUserHooks, skillFile as claudeSkillFile, userDir } from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as grok from '../agents/runtimes/grok.ts';
import { skippedBecause, UnreadableHooksFile } from '../agents/hooks-file.ts';
import { copyRuntime, HOME_DIR, KIT, MANAGED, writeManaged, writeNew } from './files.ts';
import { type Gh, readLogin } from '../host/github.ts';
import { homeOf, isDomainShaped, isPersonalEmail, loadMarks, marksFile, NO_HOME, privateRemoteHosts, systemHome } from '../rules/privacy.ts';

/**
 * Where yokoten keeps its runtime, its config and the private marks. With no absolute home
 * folder it throws NO_HOME: a relative path would land in the folder the command runs in (#404).
 */
export const paths = (env: Env, system: () => string = systemHome) => {
  const home = homeOf(env, system);
  if (!home) throw new Error(NO_HOME);
  return {
    runtime: join(home, '.local', 'share', 'yokoten'),
    config: join(home, '.config', 'yokoten'),
    // As marksFile gives it, but never throwing: install and doctor name this path (#392).
    marks: env.YOKOTEN_PRIVATE_MARKS || join(home, '.config', 'yokoten', 'private-marks'),
  };
};

/** The runtime the user hooks run, and what they say when it is gone. `doctor` compares the hooks with these. */
export const USER_CLI = '"$HOME/.local/share/yokoten/bin/yokoten.ts"';
export const USER_MISSING = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';

/** Every place a skill goes: Claude Code's folder, and the shared one other agents read. */
export const skillFiles = (env: Env, name: string): string[] => [claudeSkillFile(env, name), sharedSkillFile(env, name)];

/** The skills folder a skill file is in, for the report: `~/.claude/skills`. */
export const skillsDir = (file: string): string => dirname(dirname(file));

const MARKS_HEADER = `# yokoten private marks: words that must never be published.
# One per line, matched without case. Your real name, city, domain, server names, other
# account names. This file stays on this machine; never commit it or paste it anywhere.
`;

/** The real path of a file, or null when it is not there. */
const realPath = (file: string): string | null => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * True when a `yokoten` on the PATH is this copy or the installed runtime: its real path
 * is one of their bin/yokoten.ts. A shell alias is not on the PATH, so it is not seen.
 */
export function isOnPath(env: Env, runtime: string): boolean {
  const ours = [join(runtime, 'bin', 'yokoten.ts'), join(HOME_DIR, 'bin', 'yokoten.ts')].map(realPath).filter(Boolean);
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => {
    const found = realPath(join(dir, 'yokoten'));
    return found !== null && ours.includes(found);
  });
}

/** The line that tells the user how to call `yokoten` when the PATH has no copy that runs this one. */
export const aliasLine = (runtime: string): string =>
  `no \`yokoten\` command on your PATH runs this copy. Add this line to your shell profile (~/.bashrc or ~/.zshrc), then open a new shell: alias yokoten='node ${join(runtime, 'bin', 'yokoten.ts')}'`;

/**
 * One agent's two user hooks, or one skip line when its file won't parse or has the wrong
 * shape (#248, #254), or is a Gemini CLI file with comments, which yokoten never rewrites
 * (#258; the line then holds the hooks to add by hand): the file stays as it was, the
 * other steps go on, and `ok` is false until the hooks are there.
 */
function agentHooks(cliName: string, file: string, add: () => string[]): { ok: boolean; lines: string[] } {
  try {
    return { ok: true, lines: add() };
  } catch (err) {
    if (!(err instanceof UnreadableHooksFile)) throw err;
    return { ok: false, lines: [`skipped ${cliName}: ${skippedBecause(file, err.problem, 'install')}`] };
  }
}

/** One line per thing done, kept or skipped; `ok` is false when a file was skipped (#248). */
export function install(env: Env, { cwd, gh, system = systemHome }: { cwd?: string; gh?: Gh; system?: () => string } = {}): { ok: boolean; lines: string[] } {
  // Refuse before writing anything: with no home, every path below would be relative (#404).
  if (!homeOf(env, system)) return { ok: false, lines: [`${NO_HOME}. Set HOME to your home folder's full path and run install again`] };
  const target = paths(env, system);
  const report: string[] = [];
  let ok = true;
  // Run from this copy, install keeps it (#204). The report shows the home folder as ~.
  const copied = copyRuntime(target.runtime, { withKit: true });
  report.push(copied === 'kept' ? `kept: ${target.runtime} is the copy running now` : `wrote ${target.runtime}`);

  const skills = join(KIT, 'user', 'skills');
  for (const name of readdirSync(skills)) {
    const content = readFileSync(join(skills, name, 'SKILL.md'), 'utf8');
    for (const file of skillFiles(env, name)) report.push(`${writeManaged(file, content)} skill ${name} in ${skillsDir(file)}`);
  }
  const agents = join(KIT, 'user', 'agents');
  for (const file of readdirSync(agents)) {
    const result = writeManaged(agentFile(env, file), readFileSync(join(agents, file), 'utf8'));
    report.push(`${result} agent ${file.replace(/\.md$/, '')}`);
  }

  const claudeHooks = agentHooks('Claude Code', '~/.claude/settings.json', () => {
    const hooks = addUserHooks(env, USER_CLI, USER_MISSING);
    return [`${hooks.doctor} the SessionStart doctor`, `${hooks.guard} the user-level command guard`];
  });
  ok &&= claudeHooks.ok;
  report.push(...claudeHooks.lines);
  // Codex and Gemini CLI get the same two hooks (#211), but only when the CLI's folder is
  // already there: install never makes ~/.codex or ~/.gemini for someone who doesn't use it.
  // A file that won't parse, or has the wrong shape, is named and skipped, never rewritten (#248).
  const otherHooks = (name: string, file: string, hooks: { doctor: string; guard: string }) => [`${hooks.doctor} the ${name} SessionStart doctor in ${file}`, `${hooks.guard} the ${name} command guard in ${file}`];
  if (codex.hasUserDir(env)) {
    const codexHooks = agentHooks('Codex CLI', '~/.codex/hooks.json', () => otherHooks('Codex', '~/.codex/hooks.json', codex.addUserHooks(env, USER_CLI, USER_MISSING)));
    ok &&= codexHooks.ok;
    report.push(...codexHooks.lines);
  } else report.push('skipped Codex CLI: ~/.codex not found (run `yokoten install` again after installing Codex)');
  if (gemini.hasUserDir(env)) {
    const geminiHooks = agentHooks('Gemini CLI', '~/.gemini/settings.json', () => otherHooks('Gemini CLI', '~/.gemini/settings.json', gemini.addUserHooks(env, USER_CLI, USER_MISSING)));
    ok &&= geminiHooks.ok;
    report.push(...geminiHooks.lines);
  } else report.push('skipped Gemini CLI: ~/.gemini not found (run `yokoten install` again after installing Gemini CLI)');
  // Grok CLI gets the command guard alone: it shows a session-start hook's output only to
  // the user, never to the agent (#407).
  if (grok.hasUserDir(env)) {
    const file = grok.userHooksFile(env);
    const grokHooks = agentHooks('Grok CLI', file, () => [`${grok.addUserHooks(env, USER_CLI, USER_MISSING).guard} the Grok CLI command guard in ${file}`]);
    ok &&= grokHooks.ok;
    report.push(...grokHooks.lines);
  } else report.push('skipped Grok CLI: ~/.grok not found (run `yokoten install` again after installing Grok CLI)');

  const marks = writeNew(target.marks, MARKS_HEADER, { mode: 0o600 });
  report.push(`${marks} ${target.marks}${marks === 'wrote' ? ' (add your marks to it)' : ''}`);
  // The obvious marks come from the machine; the rest only the owner knows (#390).
  const found = machineMarks(env, { cwd, gh });
  report.push(
    ...trySafely('the marks from this machine', () => {
      const lines = [filledLine(fillMarks(env, found), target.marks)];
      const missing = missingMarkKinds(loadMarks(env), found);
      if (missing.length) lines.push(`add ${missing.join(', ')} to ${target.marks}, one per line; yokoten can't find these on its own`);
      return lines;
    }),
    ...trySafely('the git mailmap', () => [setUpMailmap(env, found)]),
  );
  if (!isOnPath(env, target.runtime)) report.push(aliasLine(target.runtime));
  return { ok, lines: report };
}

const kitSkills = (): string[] => readdirSync(join(KIT, 'user', 'skills'));
const kitAgents = (): string[] => readdirSync(join(KIT, 'user', 'agents'));

/** Whether `path` is a file yokoten wrote: it carries the managed mark. */
const isManaged = (path: string): boolean => {
  try {
    return readFileSync(path, 'utf8').includes(MANAGED);
  } catch {
    return false;
  }
};

/** Remove a file yokoten owns, and its folder when that is left empty. A file without the mark is the user's. */
function removeManaged(path: string, { folder = false }: { folder?: boolean } = {}): 'removed' | 'kept (yours)' | 'not there' {
  if (!existsSync(path)) return 'not there';
  if (!isManaged(path)) return 'kept (yours)';
  rmSync(path);
  if (folder) {
    try {
      rmdirSync(dirname(path));
    } catch {
      // the folder holds other files: they are the user's
    }
  }
  return 'removed';
}

/**
 * The pieces of install that are on this machine, for the doctor note when the plugin is
 * on too (#300). Empty when install never ran, or `uninstall` took them back.
 */
export function installedPieces(env: Env): string[] {
  const pieces: string[] = [];
  const hooks = [hasSessionDoctor(env) && 'the SessionStart doctor', hasUserGuard(env) && 'the command guard'].filter((hook) => hook !== false);
  if (hooks.length) pieces.push(`${hooks.join(' and ')} in ${join(userDir(env), 'settings.json')}`);
  const skillDirs = new Set(kitSkills().flatMap((name) => skillFiles(env, name).filter(isManaged).map(skillsDir)));
  if (skillDirs.size) pieces.push(`the skills in ${[...skillDirs].join(' and ')}`);
  if (kitAgents().some((file) => isManaged(agentFile(env, file)))) pieces.push(`the agents in ${join(userDir(env), 'agents')}`);
  if (existsSync(paths(env).runtime)) pieces.push(paths(env).runtime);
  return pieces;
}

/**
 * Take back what install wrote: the skills and agents that carry the managed mark, the two
 * user-level hooks, and the runtime. The keys and the private marks in ~/.config/yokoten
 * stay: the user wrote them. A second run finds nothing and changes nothing.
 */
export function uninstall(env: Env, { system = systemHome }: { system?: () => string } = {}): { ok: boolean; lines: string[] } {
  // As install: with no home, every path below would be relative (#404).
  if (!homeOf(env, system)) return { ok: false, lines: [`${NO_HOME}. Set HOME to your home folder's full path and run uninstall again`] };
  const target = paths(env, system);
  const report: string[] = [];
  for (const name of kitSkills()) {
    for (const file of skillFiles(env, name)) report.push(`${removeManaged(file, { folder: true })} skill ${name} in ${skillsDir(file)}`);
  }
  for (const file of kitAgents()) report.push(`${removeManaged(agentFile(env, file))} agent ${file.replace(/\.md$/, '')}`);

  const settings = join(userDir(env), 'settings.json');
  const hooks = removeUserHooks(env);
  if (hooks) report.push(`${hooks.doctor} the SessionStart doctor`, `${hooks.guard} the user-level command guard`);
  else report.push(`kept ${settings}: it is not JSON, so the two hooks are still in it; take them out by hand`);

  const hadRuntime = existsSync(target.runtime);
  rmSync(target.runtime, { recursive: true, force: true });
  report.push(`${hadRuntime ? 'removed' : 'not there'} ${target.runtime}`);
  if (existsSync(target.config)) report.push(`kept ${target.config} (your keys and private marks)`);
  return { ok: true, lines: report };
}

// ---- What this machine knows about its owner (#390) ----
//
// The obvious marks are on the machine already: git's user.name and user.email, the login
// gh is signed in with, the hosts of private remotes. `install` and full `doctor` add the
// ones the private-marks file lacks, and never print a value. A machine-level mailmap makes
// `git log` and `git show` print a placeholder for the owner's emails at the source.

/** One git read with the caller's environment (its HOME and global config), or null. Nothing is printed. */
function readGitValue(env: Env, args: string[], cwd?: string): string | null {
  try {
    const value = execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** One value this machine knows about its owner, and its kind in plain words. */
export interface MachineMark {
  kind: 'git name' | 'git email' | 'forge login' | 'private remote host';
  value: string;
}

/**
 * The owner's values this machine knows: git user.name and user.email (as git reads them in
 * `cwd`), the login gh is signed in with (only when `gh` is given: it may reach the network),
 * and the hosts of remotes in `cwd` that are not public forges.
 */
export function machineMarks(env: Env, { cwd, gh }: { cwd?: string; gh?: Gh } = {}): MachineMark[] {
  const found: MachineMark[] = [];
  const name = readGitValue(env, ['config', '--get', 'user.name'], cwd);
  if (name) found.push({ kind: 'git name', value: name });
  const email = readGitValue(env, ['config', '--get', 'user.email'], cwd);
  // A noreply address is meant to be public; the login in it is added on its own.
  if (email && isPersonalEmail(email)) found.push({ kind: 'git email', value: email });
  const login = gh ? readLogin(gh) : null;
  if (login) found.push({ kind: 'forge login', value: login });
  const urls = (readGitValue(env, ['config', '--get-regexp', String.raw`^remote\..*\.url$`], cwd) ?? '').split('\n').map((line) => line.split(/\s+/)[1] ?? '');
  for (const host of privateRemoteHosts(urls)) found.push({ kind: 'private remote host', value: host });
  return found;
}

/** Where yokoten keeps what it read about this machine: outside every repo. Throws NO_HOME with no home. */
export const machineStateFile = (env: Env, system: () => string = systemHome): string => join(paths(env, system).config, 'machine.json');

/**
 * Write a file whole or not at all: a temp file in the same folder, then a rename. Two
 * yokoten processes that write at once then never leave half a file (#404).
 */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** The file reads and writes machine.json needs: doctor's probe and the user-name probe both have them. */
interface StateFiles {
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
}

/** What machine.json holds, or an empty object when it is missing or broken. */
export function readMachineState(file: string, files: StateFiles): Record<string, unknown> {
  try {
    const state: unknown = JSON.parse(files.readText(file) ?? 'null');
    return state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Set one key of machine.json and keep the others. Throws when the file can't be written. */
export function saveMachineState(file: string, files: StateFiles, key: string, value: unknown): void {
  files.writeText(file, `${JSON.stringify({ ...readMachineState(file, files), [key]: value }, null, 2)}\n`);
}

/** What `machineUserNames` reads, so a test can give fake values. */
export interface UserNameProbe extends StateFiles {
  /** The account name, as the system's user database gives it. May throw. */
  username(): string;
  /** The home folder in the system's user database. */
  systemHome(): string;
  /** The names of the folders in `path`, or null when it can't be read. */
  listFolders(path: string): string[] | null;
  now(): Date;
}

/** The real machine. It never starts a program. */
export const REAL_USER_PROBE: UserNameProbe = {
  username: () => userInfo().username,
  systemHome,
  listFolders(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return null;
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: writeFileAtomic,
  now: () => new Date(),
};

// Account names that every machine of a kind has (a CI runner, a container, a cloud VM).
// They name nobody, and hiding them would hide common words such as "root" and "test".
const SHARED_ACCOUNTS = new Set([
  ...['root', 'runner', 'user', 'users', 'admin', 'administrator', 'guest', 'nobody', 'temp', 'dev', 'test', 'app', 'build'],
  ...['ubuntu', 'debian', 'node', 'vscode', 'codespace', 'codespaces', 'gitpod', 'vagrant', 'ec2-user', 'jenkins'],
]);
// The folders in a Windows Users folder that are not a person's: shared, system and service accounts.
const WINDOWS_SHARED_FOLDERS = new Set(['public', 'default', 'default user', 'all users', 'wdagutilityaccount', 'temp', 'postgres', 'mysql', 'sshd', 'updatususer', 'wsiaccount', 'defaultapppool']);
const WINDOWS_SHARED_PATTERN = /^(?:defaultuser\d+|.*\.migrated|\.net v.*|classic \.net apppool|mssql.*|\$.*)$/;
/** Whether a folder in a Windows Users folder is a person's. */
const isPersonFolder = (name: string): boolean => !WINDOWS_SHARED_FOLDERS.has(name.toLowerCase()) && !WINDOWS_SHARED_PATTERN.test(name.toLowerCase()) && !SHARED_ACCOUNTS.has(name.toLowerCase());
// A folder that holds the users' homes: its child is a user name.
const USERS_FOLDER = /^(?:\/home|\/Users|\/mnt\/[a-z]\/Users|\/[a-z]\/Users|[A-Za-z]:[\\/]Users)$/i;

/** The user name in a home path such as `/home/<name>` or `C:\Users\<name>`, or null for any other path. */
function homeUserName(home: string | undefined): string | null {
  const path = (home ?? '').replace(/[\\/]+$/, '');
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return split > 0 && USERS_FOLDER.test(path.slice(0, split)) ? path.slice(split + 1) : null;
}

/** The Windows user names machine.json keeps: the folders found, when, and how long the read took. */
interface WindowsUsersCache {
  names: string[];
  readAt: string;
  scanMs: number;
}

/** Kept names older than this are read again: an account may have come or gone. */
const MAX_NAMES_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A read of the drives slower than this is not repeated when the names go old: a sleeping drive must not slow every redact. */
const SLOW_SCAN_MS = 50;
/** What each probe read in this process, for when machine.json can't be written. */
const namesRead = new WeakMap<UserNameProbe, string[]>();

/**
 * The Windows accounts a WSL distro can see: the person folders in `/mnt/<drive>/Users`.
 * Read once, then kept in machine.json as `windowsUsers` for 30 days, so a later run reads
 * one local file (#404). With no file, the names are kept for this process only.
 */
function windowsUserNames(env: Env, probe: UserNameProbe): string[] {
  const known = namesRead.get(probe);
  if (known) return known;
  let file: string | null = null;
  try {
    file = machineStateFile(env, () => probe.systemHome());
  } catch {
    // no home: read the drives, and keep the names in this process
  }
  const kept = file ? (readMachineState(file, probe).windowsUsers as Partial<WindowsUsersCache> | undefined) : undefined;
  const isValid = Array.isArray(kept?.names) && kept.names.every((name) => typeof name === 'string') && typeof kept.readAt === 'string';
  const age = isValid ? probe.now().getTime() - Date.parse(kept?.readAt ?? '') : Number.NaN;
  const isFresh = Number.isFinite(age) && age >= 0 && age <= MAX_NAMES_AGE_MS;
  let names: string[];
  if (isValid && (isFresh || (kept?.scanMs ?? 0) > SLOW_SCAN_MS)) names = kept?.names ?? [];
  else {
    const start = probe.now().getTime();
    const drives = (probe.listFolders('/mnt') ?? []).filter((name) => /^[a-z]$/.test(name));
    names = [...new Set(drives.flatMap((drive) => probe.listFolders(`/mnt/${drive}/Users`) ?? []).filter(isPersonFolder))];
    const cache: WindowsUsersCache = { names, readAt: probe.now().toISOString(), scanMs: probe.now().getTime() - start };
    // An empty list is kept too: no drive is mounted, and the next run need not look again.
    try {
      if (file) saveMachineState(file, probe, 'windowsUsers', cache);
    } catch {
      // a read-only home: this process keeps the names below
    }
  }
  // Filtered again: a file from an older yokoten, or one edited by hand, may hold a shared folder.
  const result = names.filter(isPersonFolder);
  namesRead.set(probe, result);
  return result;
}

/**
 * The user names of this machine, which git and the forge do not know (#404): the account
 * name, the last folder of each home under a users folder, and in WSL the Windows user name.
 * The Windows name comes from USERPROFILE when WSLENV passes it, else from the folders in
 * `/mnt/<drive>/Users`: the one named like a Linux name, or every person folder when none is.
 * Shared account names (root, runner, test) and names of under 3 characters are left out.
 * It starts no program.
 */
export function machineUserNames(env: Env, probe: UserNameProbe = REAL_USER_PROBE): string[] {
  const read = (get: () => string): string => {
    try {
      return get();
    } catch {
      return '';
    }
  };
  const names = [env.USER, env.LOGNAME, read(() => probe.username())];
  for (const home of [env.HOME, read(() => probe.systemHome()), env.USERPROFILE]) names.push(homeUserName(home) ?? '');
  const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (isWsl && !homeUserName(env.USERPROFILE)) {
    const linux = new Set(names.map((name) => (name ?? '').toLowerCase()));
    const windows = windowsUserNames(env, probe);
    const same = windows.filter((name) => linux.has(name.toLowerCase()));
    // No folder named like the Linux user: hide them all, as privacy comes first.
    names.push(...(same.length ? same : windows));
  }
  const kept = new Map<string, string>();
  for (const name of names) {
    const trimmed = (name ?? '').trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length >= 3 && !SHARED_ACCOUNTS.has(key) && !kept.has(key)) kept.set(key, trimmed);
  }
  return [...kept.values()];
}

/**
 * Add the machine's marks that the private-marks file lacks, at its end. It only appends,
 * and makes the file (mode 600) when it is missing. Returns the kinds it added, never a value.
 */
export function fillMarks(env: Env, found: MachineMark[]): string[] {
  const file = marksFile(env);
  const known = new Set(loadMarks(env));
  const added: MachineMark[] = [];
  // The git display name is left out: as a mark, a common name would flag every file that
  // holds the word. `redact` still hides it, from git, as a whole word.
  for (const mark of found.filter((one) => one.kind !== 'git name')) {
    const key = mark.value.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    added.push(mark);
  }
  if (!added.length) return [];
  if (!existsSync(file)) writeNew(file, MARKS_HEADER, { mode: 0o600 });
  const text = readFileSync(file, 'utf8');
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${FOUND_HEADER}\n${added.map((mark) => mark.value).join('\n')}\n`);
  return [...new Set(added.map((mark) => mark.kind))];
}

/** The comment above the marks `fillMarks` adds. They run to the next comment line. */
const FOUND_HEADER = '# added by yokoten from this machine';

/** How many marks the owner wrote: the lines of the file outside the parts `fillMarks` added. */
export function countOwnMarks(env: Env): number {
  let text = '';
  try {
    text = readFileSync(marksFile(env), 'utf8');
  } catch {
    return 0;
  }
  let isFound = false;
  let count = 0;
  for (const line of text.split(/\r?\n/).map((part) => part.trim())) {
    if (line.startsWith('#')) isFound = line === FOUND_HEADER;
    else if (line && !isFound) count++;
  }
  return count;
}

/** The line install and doctor print after `fillMarks`: the kinds, never the values. */
export const filledLine = (kinds: string[], file: string): string =>
  kinds.length ? `added to ${file} from this machine: ${kinds.join(', ')} (the values are not shown)` : `kept ${file}: it already has what this machine knows`;

/**
 * The kinds of mark yokoten can't find on its own, which the file seems to lack, in plain
 * words. A name has a space; a domain has a dot; anything else not from the machine may
 * be the city. A guess from the shape, so doctor shows it as a note.
 */
export function missingMarkKinds(marks: string[], found: MachineMark[]): string[] {
  const fromMachine = new Set(found.map((mark) => mark.value.toLowerCase()));
  const own = marks.filter((mark) => !fromMachine.has(mark) && !mark.includes('@'));
  const missing: string[] = [];
  if (!own.some((mark) => /\s/.test(mark))) missing.push('your real name');
  if (!own.some((mark) => !/\s/.test(mark) && !isDomainShaped(mark))) missing.push('your city');
  if (!own.some(isDomainShaped)) missing.push('your domains');
  return missing;
}

/** The mailmap yokoten keeps, outside every repo, as git config names it (git expands `~/`). */
export const MAILMAP_SETTING = '~/.config/yokoten/mailmap';
/** The name and address git prints for the owner once the mailmap is set. */
export const MAILMAP_OWNER = 'owner <owner@noreply.invalid>';

/** Whether git's global mailmap.file is yokoten's, another file, or not set. */
export function mailmapState(env: Env): 'ours' | 'other' | 'unset' {
  const value = readGitValue(env, ['config', '--global', '--get', 'mailmap.file']);
  if (!value) return 'unset';
  return value === MAILMAP_SETTING || value === join(paths(env).config, 'mailmap') ? 'ours' : 'other';
}

/**
 * Write yokoten's mailmap: one line per owner email (git user.email and the marks shaped
 * like an address), each shown as MAILMAP_OWNER. Then point git's global mailmap.file at
 * it, unless the user set another file: that one is theirs, so it stays and the line says so.
 */
export function setUpMailmap(env: Env, found: MachineMark[]): string {
  const emails = [...new Set([...found.filter((mark) => mark.kind === 'git email').map((mark) => mark.value), ...loadMarks(env).filter((mark) => /^[^@\s]+@[^@\s]+$/.test(mark))].map((email) => email.toLowerCase()))];
  const file = join(paths(env).config, 'mailmap');
  // The file may hold lines the owner wrote: it only gets the lines it lacks.
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const mapped = new Set([...(before ?? '').matchAll(/<([^<>\s]+)>\s*$/gm)].map((match) => match[1].toLowerCase()));
  const missing = emails.filter((email) => !mapped.has(email));
  if (before === null) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# yokoten: git prints the owner\'s emails as a placeholder. Kept outside every repo; never commit it.\n', { mode: 0o600 });
  }
  if (missing.length) appendFileSync(file, `${before && !before.endsWith('\n') ? '\n' : ''}${missing.map((email) => `${MAILMAP_OWNER} <${email}>\n`).join('')}`);
  const state = mailmapState(env);
  if (state === 'other') return `kept your own git mailmap.file setting; add the lines of ${file} to that file`;
  // git prints nothing when it sets a value, so the setting is read back to see it took.
  if (state === 'unset') readGitValue(env, ['config', '--global', 'mailmap.file', MAILMAP_SETTING]);
  if (mailmapState(env) !== 'ours') return `skipped the git mailmap: git config could not set mailmap.file; run \`git config --global mailmap.file ${MAILMAP_SETTING}\``;
  if (state === 'ours') return missing.length ? `added ${missing.length} line(s) to ${file}` : `kept ${file}: it already maps your emails`;
  return `${before === null ? 'wrote' : 'kept'} ${file}, and git log and git show now print your emails as a placeholder`;
}

/**
 * One privacy step of install or doctor, which never stops them: an error becomes one plain
 * line that says what was skipped and why.
 */
export function trySafely(what: string, step: () => string[]): string[] {
  try {
    return step();
  } catch (err) {
    return [`skipped ${what}: ${String((err as Error)?.message ?? err).split('\n')[0]}`];
  }
}
