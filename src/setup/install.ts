// `yokoten install`: the machine layer, the same on every computer. It puts one entry
// skill where Claude Code and the agents that read `.agents/skills` find it in every
// project, and the agents where Claude Code finds them. The other skills stay in the kit
// copy and are read through the entry skill, so the skill list does not grow seven lines.
// It adds two user-level hooks, for Claude Code, Codex and Gemini CLI alike:
//
// - SessionStart runs `doctor --session`, so every session in every repo starts by
//   hearing which practices that repo is missing. Nobody has to remember to ask.
// - PreToolUse (BeforeTool in Gemini CLI) runs `hook --commands-only`: no tag pushes, no
//   force pushes, no skipped checks, in every repo, adopted or not.
//
// Grok CLI, Antigravity CLI and Copilot CLI get the PreToolUse guard only, in
// ~/.grok/hooks/yokoten.json, ~/.gemini/config/hooks.json and
// ~/.copilot/hooks/yokoten.json.
//
// `yokoten uninstall` takes back what install wrote and marked as its own, for a machine
// that moves to the Claude Code plugin (#300): the plugin brings the same pieces, and both
// at once run every hook twice and show every skill twice.
//
// It puts a small `yokoten` launcher in ~/.local/bin (#433): every message says
// `yokoten init`, and a clone install has no other command on the PATH (#208). That
// folder is on the PATH on most setups. When it is not, install asks once before it adds
// one marked line to the shell profile, and never edits the profile in a run with no terminal.

import { execFileSync } from 'node:child_process';
import { configEntries } from '../run/check.ts';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, delimiter, dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { Env } from '../rules/config.ts';
import { STOPS_FILE, STOPS_OFF_FILE } from '../rules/guards/index.ts';
import { skillFile as sharedSkillFile } from '../agents/agent-skills.ts';
import * as copilot from '../agents/copilot.ts';
import { addUserHooks, agentFile, hasPlugin, hasSessionDoctor, hasUserGuard, removeUserHooks, skillFile as claudeSkillFile, userDir } from '../agents/runtimes/claude-code.ts';
import * as codex from '../agents/runtimes/codex.ts';
import * as gemini from '../agents/runtimes/gemini.ts';
import * as antigravity from '../agents/runtimes/small/antigravity.ts';
import * as grok from '../agents/runtimes/grok.ts';
import * as muse from '../agents/runtimes/muse.ts';
import * as opencode from '../agents/runtimes/small/opencode.ts';
import { type Added, skippedBecause, UnreadableHooksFile } from '../agents/hooks-file.ts';
import { copyRuntime, describeWrite, HOME_DIR, isEditedManaged, isManagedText, isNewerKitCopy, KIT, MANAGED, writeManaged, writeNew } from './files.ts';
import { type Gh, readLocalLogins, readLogin } from '../host/github/index.ts';
import { FOUND_HEADER, foundHeader, homeIn, loadMarkKinds, markLines, type Mark, homeOf, isDomainShaped, isEmailShaped, OWN_HEADER, isPersonalEmail, loadMarks, marksFile, NO_HOME, writtenMarksOnly, privateRemoteHosts, systemHome } from '../rules/privacy.ts';

/**
 * Where yokoten keeps its runtime, its config and the private marks. With no absolute home
 * folder it throws NO_HOME: a relative path would land in the folder the command runs in (#404).
 */
export const paths = (env: Env) => {
  const home = homeIn(env);
  return {
    runtime: join(home, '.local', 'share', 'yokoten'),
    config: join(home, '.config', 'yokoten'),
    // As marksFile gives it with a home folder: the default file, never YOKOTEN_PRIVATE_MARKS,
    // which only adds marks (#656). Install and doctor name this path (#392).
    marks: join(home, '.config', 'yokoten', 'private-marks'),
  };
};

/** The runtime the user hooks run, and what they say when it is gone. `doctor` compares the hooks with these. */
export const USER_CLI = '"$HOME/.local/share/yokoten/bin/yokoten.mjs"';
export const USER_MISSING = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';

/** Every place a skill goes: Claude Code's folder, and the shared one other agents read. */
export const skillFiles = (env: Env, name: string): string[] => [claudeSkillFile(env, name), sharedSkillFile(env, name)];

/**
 * The one skill install puts in the global folders (#904). It routes to the other skills,
 * which stay in the kit copy at ~/.local/share/yokoten and are read from there. With the
 * Claude Code plugin on, install writes no global skill at all: the plugin brings them.
 */
export const ENTRY_SKILL = 'yokoten';
/** The file install copies as the one entry skill; the plugin brings its own set. */
const entryFile = (): string => join(KIT, 'user', 'entry', 'SKILL.md');

/**
 * Yokoten's skill in the shared folder, as a link to Claude Code's copy (#557). Muse reads
 * both ~/.claude/skills and ~/.agents/skills, and warns once per skill when it sees the two
 * copies (`skill-shadowed`). One real file with one link to it reads as one skill, so Muse
 * sees each skill once, while Claude Code keeps a real file and the other agents read
 * through the link. A folder with the user's own files in it stays real and only the skill
 * file is synced: replacing it with a link would throw their files away. So does a file of
 * theirs, and a link of theirs that points elsewhere.
 */
function writeSharedSkill(linkFile: string, targetFile: string, content: string, platform: NodeJS.Platform): 'linked' | 'same' | 'updated' | 'kept (yours)' | 'kept (your edit)' {
  const path = dirname(linkFile);
  const target = dirname(targetFile);
  // A link, when one is there: readlinkSync throws for a real file or folder, or nothing.
  const linkTarget = (): string | null => {
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      return null;
    }
  };
  // The skill file's text when it is a file yokoten wrote; null when it is missing or not ours.
  const managedText = (): string | null => {
    try {
      const text = readFileSync(linkFile, 'utf8');
      return isManagedText(text) ? text : null;
    } catch {
      return null;
    }
  };
  const isManaged = (): boolean => managedText() !== null;
  // A junction on Windows: a plain link needs rights a user may not have.
  const link = (): 'linked' => {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, platform === 'win32' ? 'junction' : 'dir');
    return 'linked';
  };
  const seen = linkTarget();
  if (seen !== null) return seen === target ? 'same' : isManaged() ? link() : 'kept (yours)';
  if (!existsSync(path)) return link();
  let onlyOurs = false;
  try {
    onlyOurs = statSync(path).isDirectory() && readdirSync(path).join() === 'SKILL.md';
  } catch {
    onlyOurs = false;
  }
  if (onlyOurs && isManaged()) {
    // Their own edit to the copy stays a real folder: a link would throw it away (0015).
    const text = managedText();
    if (text !== null && isEditedManaged(text)) return 'kept (your edit)';
    return link();
  }
  if (!isManaged()) return 'kept (yours)';
  // The skill file is there and managed, so this is 'same' or 'updated'.
  const synced = writeManaged(linkFile, content);
  return synced === 'wrote' ? 'updated' : synced;
}

/** The skills folder a skill file is in, for the report: `~/.claude/skills`. */
export const skillsDir = (file: string): string => dirname(dirname(file));

/** The home skill folders that hold a managed yokoten skill, for the duplicate note (#540). */
export function installedSkillDirs(env: Env): string[] {
  return [...new Set(kitSkills().flatMap((name) => skillFiles(env, name).filter(isManaged).map(skillsDir)))];
}

/**
 * The project folders that hold one managed yokoten skill, relative to `root`, for the
 * duplicate note (#540): `.agents/skills/dispatch` and so on. `npx skills add` puts a copy
 * in `.agents/skills` or `.claude/skills`. The note names each folder, never the whole
 * folder above it, which holds other packages' skills too.
 */
export function projectSkillDirs(root: string): string[] {
  const dirs = ['.agents/skills', '.claude/skills'];
  return dirs.flatMap((dir) => kitSkills().filter((name) => isManaged(join(root, dir, name, 'SKILL.md'))).map((name) => `${dir}/${name}`));
}

/** The example install prints when it asks the owner to type a mark (#525). */
const MARK_EXAMPLE = 'for example: your city, a company domain, a server name';

export const MARKS_HEADER = `# yokoten private marks: words that must never be published.
# One per line, matched without case. A name or a city (letters and spaces) is found as
# whole words: a letter next to it hides it, a digit or _ - . / @ does not. yokoten adds
# your git name, git email and forge login by itself; \`yokoten marks add\` adds your city,
# domain, server names, other account names.
# ${MARK_EXAMPLE}
# This file stays on this machine; never commit it or paste it anywhere.
`;

/** The real path of a file, or null when it is not there. */
const realPath = (file: string): string | null => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/** The launcher's file name: a `.cmd` on Windows, a shell script everywhere else. */
const launcherName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'yokoten.cmd' : 'yokoten');

/** Whether `file` is a launcher yokoten wrote that runs one of `clis`. */
const isOurLauncher = (file: string, clis: string[]): boolean => {
  try {
    const text = readFileSync(file, 'utf8');
    return isManagedText(text) && clis.some((cli) => text.includes(cli));
  } catch {
    return false;
  }
};

/**
 * True when a `yokoten` on the PATH is this copy or the installed runtime: its real path
 * is one of their bin/yokoten.ts or bin/yokoten.mjs, or it is a launcher install wrote for
 * one of them (#433). A launcher from an older install runs yokoten.ts, so it still counts.
 * A shell alias is not on the PATH, so it is not seen.
 */
export function isOnPath(env: Env, runtime: string, platform: NodeJS.Platform = process.platform): boolean {
  const clis = [runtime, HOME_DIR].flatMap((dir) => [join(dir, 'bin', 'yokoten.mjs'), join(dir, 'bin', 'yokoten.ts')]);
  const ours = clis.map(realPath).filter(Boolean);
  const names = platform === 'win32' ? ['yokoten.cmd', 'yokoten'] : ['yokoten'];
  return (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).some((dir) =>
    names.some((name) => {
      const found = realPath(join(dir, name));
      return found !== null && (ours.includes(found) || isOurLauncher(found, clis));
    }),
  );
}

/** The line that tells the user how to call `yokoten` when the PATH has no copy that runs this one. */
export const aliasLine = (runtime: string): string =>
  `no \`yokoten\` command on your PATH runs this copy. Add this line to your shell profile (~/.bashrc or ~/.zshrc), then open a new shell: alias yokoten='node ${join(runtime, 'bin', 'yokoten.ts')}'`;

// ---- The launcher on the PATH (#433) ----

/** The mark on the one line install adds to a shell profile; uninstall removes the lines that end with it. */
export const PROFILE_MARK = '# added by yokoten';
/** The line install adds to the shell profile, when the user says yes. */
export const PROFILE_LINE = `export PATH="$HOME/.local/bin:$PATH" ${PROFILE_MARK}`;
/** The profiles uninstall looks in for the marked line. */
const PROFILES = ['.bashrc', '.zshrc'];

/** The folder the launcher goes in: ~/.local/bin, on the PATH on most setups. */
export const launcherDir = (home: string): string => join(home, '.local', 'bin');

/** The launcher file for this platform. */
export const launcherFile = (home: string, platform: NodeJS.Platform = process.platform): string => join(launcherDir(home), launcherName(platform));

/**
 * What the launcher holds: it runs the installed runtime with every argument, and carries the
 * managed mark. It runs bin/yokoten.mjs, the entry the user hooks run (USER_CLI), which turns on
 * the compile cache. Install rewrites a launcher from an older install that ran yokoten.ts.
 */
export function launcherText(runtime: string, platform: NodeJS.Platform = process.platform): string {
  const cli = join(runtime, 'bin', 'yokoten.mjs');
  if (platform === 'win32') return `@echo off\r\nrem ${MANAGED}: \`yokoten uninstall\` removes this file.\r\nnode "${cli}" %*\r\n`;
  // Single quotes keep every character of the path as it is; a ' inside is closed, escaped and reopened.
  return `#!/bin/sh\n# ${MANAGED}: \`yokoten uninstall\` removes this file.\nexec node '${cli.replaceAll("'", "'\\''")}' "$@"\n`;
}

/** The profile of the user's shell, from $SHELL: ~/.bashrc for bash, ~/.zshrc for zsh, else null. */
export function shellProfile(env: Env, home: string): string | null {
  const shell = basename(env.SHELL ?? '');
  if (shell === 'bash') return join(home, '.bashrc');
  if (shell === 'zsh') return join(home, '.zshrc');
  return null;
}

/** Whether `dir` is one of the folders on the PATH. */
function isDirOnPath(env: Env, dir: string, platform: NodeJS.Platform): boolean {
  const wanted = realPath(dir) ?? resolve(dir);
  return (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).some((entry) => (realPath(entry) ?? resolve(entry)) === wanted);
}

/** Whether a profile already has the marked line. */
const hasProfileLine = (profile: string): boolean => existsSync(profile) && readFileSync(profile, 'utf8').split('\n').some((line) => line.trimEnd().endsWith(PROFILE_MARK));

/**
 * The question install asks, and the answer: the line typed, or null when nobody can answer.
 * Only a run with a terminal on stdin and stdout passes one.
 */
export type Ask = (question: string) => string | null;

/** Whether an answer to a [Y/n] question is yes: Enter alone, y or yes. */
export const isYes = (answer: string | null): boolean => answer !== null && /^\s*(y|yes)?\s*$/i.test(answer);

/**
 * Write the launcher and make sure the shell finds it. A file at that place without the
 * managed mark is the user's: it stays and is named. When ~/.local/bin is not on the PATH,
 * it asks once (only with `ask`) before it adds PROFILE_LINE to the shell's profile; on no,
 * or with no terminal, it prints the line instead. Windows gets the steps, never an edit.
 */
export function setUpLauncher(env: Env, runtime: string, home: string, { ask, platform = process.platform }: { ask?: Ask; platform?: NodeJS.Platform } = {}): string[] {
  const file = launcherFile(home, platform);
  const dir = launcherDir(home);
  const written = writeManaged(file, launcherText(runtime, platform));
  if (written === 'kept (yours)') {
    const lines = [`kept ${file}: it is not yokoten's launcher, so install left it as it is`];
    return isOnPath(env, runtime, platform) ? lines : [...lines, aliasLine(runtime)];
  }
  // The bytes of an edit stay, and so does its mode: a kept launcher is theirs to run or not.
  if (platform !== 'win32' && written !== 'kept (your edit)') chmodSync(file, 0o755);
  const lines = [describeWrite(written, `the launcher ${file}`)];
  if (isDirOnPath(env, dir, platform)) return lines;
  if (platform === 'win32') return [...lines, `${dir} is not on your PATH. Add it to the Path for your account (search Windows for "environment variables for your account"), then open a new terminal`];
  const profile = shellProfile(env, home);
  if (!profile) return [...lines, `${dir} is not on your PATH. Add this line to your shell profile, then open a new shell: ${PROFILE_LINE}`];
  if (hasProfileLine(profile)) return [...lines, `${profile} already adds ${dir} to the PATH; open a new shell, then run \`yokoten\``];
  const shown = (path: string): string => `~/${relative(home, path).split(sep).join('/')}`;
  if (ask && isYes(ask(`Add ${shown(dir)} to your PATH in ${shown(profile)}? [Y/n]`))) {
    const before = existsSync(profile) ? readFileSync(profile, 'utf8') : '';
    appendFileSync(profile, `${before === '' || before.endsWith('\n') ? '' : '\n'}${PROFILE_LINE}\n`);
    return [...lines, `added ${dir} to the PATH in ${profile}; open a new shell, then run \`yokoten\``];
  }
  return [...lines, `${dir} is not on your PATH. Add this line to ${profile}, then open a new shell: ${PROFILE_LINE}`];
}

/** Take back the launcher and the marked profile lines: one report line for each thing removed or kept. */
function removeLauncher(home: string, platform: NodeJS.Platform): string[] {
  const file = launcherFile(home, platform);
  const lines = [describeWrite(removeManaged(file), `the launcher ${file}`)];
  for (const name of PROFILES) {
    const profile = join(home, name);
    if (!hasProfileLine(profile)) continue;
    const text = readFileSync(profile, 'utf8');
    replaceFile(profile, text.split('\n').filter((line) => !line.trimEnd().endsWith(PROFILE_MARK)).join('\n'));
    lines.push(`removed the PATH line from ${profile}`);
  }
  return lines;
}

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
export function install(env: Env, { cwd, gh, ask, platform }: { cwd?: string; gh?: Gh; ask?: Ask; platform?: NodeJS.Platform } = {}): { ok: boolean; lines: string[] } {
  // Refuse before writing anything: with no home, every path below would be relative (#404).
  if (!homeOf(env)) return { ok: false, lines: [`${NO_HOME}. Set HOME to your home folder's full path and run install again`] };
  const target = paths(env);
  const report: string[] = [];
  let ok = true;
  const plugin = hasPlugin(env);
  // With the plugin on, a machine that uses Claude Code alone needs no copy of yokoten:
  // the plugin brings the skills, the hooks and the runtime. Another tool's hook still
  // needs the runtime, so it stays when that tool is here.
  const otherTool = codex.hasUserDir(env) || gemini.hasUserDir(env) || antigravity.hasUserDir(env) || copilot.hasUserDir(env) || grok.hasUserDir(env) || muse.hasUserDir(env) || opencode.hasUserDir(env);
  const needsRuntime = !plugin || otherTool;
  const plan = installPlan(env, target.runtime, plugin, needsRuntime);
  // Run from this copy, install keeps it (#204). The report shows the home folder as ~.
  if (needsRuntime) {
    const copied = copyRuntime(target.runtime, { withKit: true });
    report.push(copied === 'kept' ? `kept: ${target.runtime} is the copy running now` : `wrote ${target.runtime}`);
  } else {
    const had = existsSync(target.runtime);
    rmSync(target.runtime, { recursive: true, force: true });
    report.push(had ? `removed the runtime ${target.runtime}: the yokoten plugin brings its own` : 'kept out the runtime: the yokoten plugin brings its own');
  }

  // The files whose copy the user edited: install keeps them and names the new copies (0015).
  const edited = new Set<string>();
  const isKeptEdit = (result: string): boolean => result === 'kept (your edit)';
  const skills = join(KIT, 'user', 'skills');
  // The plugin brings every skill and agent, so a global copy would show each one twice
  // (#904). Install then only takes back the copies it wrote before.
  for (const name of readdirSync(skills)) {
    const [claudeFile, sharedFile] = skillFiles(env, name);
    if (plugin || name !== ENTRY_SKILL) {
      // Only what was there is named: a run on a machine with no copy says nothing per skill.
      const removedClaude = removeManaged(claudeFile, { folder: true });
      if (removedClaude !== 'not there') report.push(describeWrite(removedClaude, `skill ${name} in ${skillsDir(claudeFile)}`));
      const removedShared = removeSharedSkill(sharedFile);
      if (removedShared !== 'not there') report.push(describeWrite(removedShared, `skill ${name} in ${skillsDir(sharedFile)}`));
      continue;
    }
    const content = readFileSync(entryFile(), 'utf8');
    const written = writeManaged(claudeFile, content);
    if (isKeptEdit(written)) edited.add(`skill ${name}`);
    report.push(describeWrite(written, `skill ${name} in ${skillsDir(claudeFile)}`));
    const shared = writeSharedSkill(sharedFile, claudeFile, content, platform ?? process.platform);
    if (isKeptEdit(shared)) edited.add(`skill ${name}`);
    report.push(describeWrite(shared, `skill ${name} in ${skillsDir(sharedFile)}`));
  }
  const agents = join(KIT, 'user', 'agents');
  for (const file of readdirSync(agents)) {
    if (plugin) {
      const removed = removeManaged(agentFile(env, file));
      if (removed !== 'not there') report.push(describeWrite(removed, `agent ${file.replace(/\.md$/, '')}`));
      continue;
    }
    const result = writeManaged(agentFile(env, file), readFileSync(join(agents, file), 'utf8'));
    if (isKeptEdit(result)) edited.add(`agent ${file.replace(/\.md$/, '')}`);
    report.push(describeWrite(result, `agent ${file.replace(/\.md$/, '')}`));
  }
  if (edited.size) report.push(`your edits stay: install skipped ${[...edited].join(', ')}. The new ${edited.size === 1 ? 'copy is' : 'copies are'} in ~/.local/share/yokoten/kit/user.`);

  // The plugin brings both user hooks too, so install does not add a second copy.
  if (plugin) report.push('skipped Claude Code hooks: the yokoten plugin brings them');
  else {
    const claudeHooks = agentHooks('Claude Code', '~/.claude/settings.json', () => {
      const hooks = addUserHooks(env, USER_CLI, USER_MISSING);
      return [describeWrite(hooks.doctor, 'the SessionStart doctor'), describeWrite(hooks.guard, 'the user-level command guard')];
    });
    ok &&= claudeHooks.ok;
    report.push(...claudeHooks.lines);
  }
  // Codex and Gemini CLI get the same two hooks (#211), but only when the CLI's folder is
  // already there: install never makes ~/.codex or ~/.gemini for someone who doesn't use it.
  // A file that won't parse, or has the wrong shape, is named and skipped, never rewritten (#248).
  const otherHooks = (name: string, file: string, hooks: { doctor: Added; guard: Added }) => [describeWrite(hooks.doctor, `the ${name} SessionStart doctor in ${file}`), describeWrite(hooks.guard, `the ${name} command guard in ${file}`)];
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
  // Antigravity CLI and Copilot CLI have user-level hooks too: agy in ~/.gemini/config,
  // Copilot in ~/.copilot/hooks. Either guards a repo without yokoten (#342). Both get the
  // command guard alone: agy has no session-start event, and Copilot's file builds on
  // Claude Code's shape but no real run has shown its SessionStart. Neither gets a stop
  // check: agy's Stop has no `stop_hook_active`, and Copilot lets a timed-out hook go on.
  if (antigravity.hasUserDir(env)) {
    const file = antigravity.userHooksFile(env);
    const agyHooks = agentHooks('Antigravity CLI', file, () => [`${antigravity.addUserHooks(env, USER_CLI, USER_MISSING).guard} the Antigravity CLI command guard in ${file}`]);
    ok &&= agyHooks.ok;
    report.push(...agyHooks.lines);
  } else report.push('skipped Antigravity CLI: ~/.gemini/config not found (run `yokoten install` again after installing Antigravity CLI)');
  if (copilot.hasUserDir(env)) {
    const file = copilot.userHooksFile(env);
    const copilotHooks = agentHooks('Copilot CLI', file, () => [`${copilot.addUserHooks(env, USER_CLI, USER_MISSING).guard} the Copilot CLI command guard in ${file}`]);
    ok &&= copilotHooks.ok;
    report.push(...copilotHooks.lines);
  } else report.push('skipped Copilot CLI: ~/.copilot not found (run `yokoten install` again after installing Copilot CLI)');
  // Grok CLI gets the command guard alone: it shows a session-start hook's output only to
  // the user, never to the agent (#407).
  if (grok.hasUserDir(env)) {
    const file = grok.userHooksFile(env);
    const grokHooks = agentHooks('Grok CLI', file, () => [describeWrite(grok.addUserHooks(env, USER_CLI, USER_MISSING).guard, `the Grok CLI command guard in ${file}`)]);
    ok &&= grokHooks.ok;
    report.push(...grokHooks.lines);
  } else report.push('skipped Grok CLI: ~/.grok not found (run `yokoten install` again after installing Grok CLI)');
  // Muse Code reads a `hooks` block in its user settings in every repo (checked with 1.4.11).
  const museFile = muse.userSettingsFile(env);
  if (muse.hasUserDir(env)) {
    const museHooks = agentHooks('Muse Code', museFile, () => otherHooks('Muse Code', museFile, muse.addUserHooks(env, USER_CLI, USER_MISSING)));
    ok &&= museHooks.ok;
    report.push(...museHooks.lines);
  } else report.push(`skipped Muse Code: ${dirname(museFile)} not found (run \`yokoten install\` again after installing Muse Code)`);
  // OpenCode gets the command guard only, and only when its config folder is already there.
  if (opencode.hasUserDir(env)) {
    const file = opencode.userPluginFile(env);
    const openCodeHooks = agentHooks('OpenCode', file, () => [describeWrite(opencode.addUserPlugin(env, USER_CLI, USER_MISSING), `the OpenCode command guard in ${file}`)]);
    ok &&= openCodeHooks.ok;
    report.push(...openCodeHooks.lines);
  } else report.push(`skipped OpenCode: ${opencode.userPluginFile(env).replace(/\/plugins\/yokoten\.ts$/, '')} not found (run \`yokoten install\` again after installing OpenCode)`);

  const marks = writeNew(target.marks, MARKS_HEADER, { mode: 0o600 });
  report.push(`${marks} ${target.marks}${marks === 'wrote' ? ' (`yokoten marks add` adds one of your own)' : ''}`);
  // The obvious marks come from the machine; the rest only the owner knows (#390).
  const found = machineMarks(env, { cwd, gh });
  report.push(
    ...trySafely('the marks from this machine', () => {
      const lines = filledLines(fillMarks(env, found), target.marks);
      // One answer, as doctor gives it (#522): no marks at all, or an optional offer.
      // The next line is an example, and only install prints it (#525).
      const marks = loadMarks(env);
      const missing = missingMarkKinds(marks, found);
      if (!marks.length) lines.push(`${target.marks} has no marks yet; ${EMPTY_MARKS_FIX}`, MARK_EXAMPLE);
      else if (missing.length) lines.push(`${offerMarkKinds(missing)}; ${OFFER_MARKS_FIX}`, MARK_EXAMPLE);
      return lines;
    }),
    ...trySafely('the git mailmap', () => [setUpMailmap(env, found)]),
  );
  // Last, so the way to call `yokoten` is the line the user reads at the end.
  if (needsRuntime) report.push(...trySafely('the launcher', () => setUpLauncher(env, target.runtime, homeIn(env), { ask, platform })));
  // Nothing is kept out silently: with the plugin on, a launcher that was never there is
  // not worth a line, and one an older install left is named as removed.
  else report.push(...trySafely('the launcher', () => removeLauncher(homeIn(env), platform ?? process.platform)).filter((line) => !line.startsWith('nothing to remove:')));
  return { ok, lines: [...plan, ...report] };
}

/** The files and settings keys install will touch, printed before it writes (#904). */
function installPlan(env: Env, runtime: string, plugin: boolean, needsRuntime: boolean): string[] {
  const shown = (path: string): string => path.split(homeIn(env)).join('~');
  const plan = ['install will write these files and settings keys:'];
  plan.push(needsRuntime ? `  ${shown(runtime)}` : '  no runtime: the yokoten plugin brings its own');
  if (plugin) {
    plan.push('  no global skills or agents: the yokoten plugin brings them');
  } else {
    for (const file of skillFiles(env, ENTRY_SKILL)) plan.push(`  ${shown(file)}`);
    for (const file of readdirSync(join(KIT, 'user', 'agents'))) plan.push(`  ${shown(agentFile(env, file))}`);
    plan.push(`  ${shown(join(userDir(env), 'settings.json'))}: hooks.SessionStart, hooks.PreToolUse`);
  }
  if (codex.hasUserDir(env)) plan.push('  ~/.codex/hooks.json: hooks.SessionStart, hooks.PreToolUse');
  if (gemini.hasUserDir(env)) plan.push('  ~/.gemini/settings.json: hooks.SessionStart, hooks.BeforeTool');
  if (antigravity.hasUserDir(env)) plan.push(`  ${antigravity.userHooksFile(env)}: hooks.yokoten`);
  if (copilot.hasUserDir(env)) plan.push(`  ${copilot.userHooksFile(env)}: hooks.yokoten`);
  if (grok.hasUserDir(env)) plan.push(`  ${grok.userHooksFile(env)}: hooks.PreToolUse`);
  if (muse.hasUserDir(env)) plan.push(`  ${muse.userSettingsFile(env)}: hooks.SessionStart, hooks.PreToolUse`);
  if (opencode.hasUserDir(env)) plan.push(`  ${opencode.userPluginFile(env)}`);
  if (needsRuntime) plan.push('  ~/.local/bin/yokoten');
  plan.push(`  ${shown(paths(env).marks)}`);
  return plan;
}

const kitSkills = (): string[] => readdirSync(join(KIT, 'user', 'skills'));
const kitAgents = (): string[] => readdirSync(join(KIT, 'user', 'agents'));

/** A managed file's text: `missing` when no file is there, `yours` when the file is not ours. */
const managedFileText = (path: string): { text: string } | 'missing' | 'yours' => {
  try {
    const text = readFileSync(path, 'utf8');
    return isManagedText(text) ? { text } : 'yours';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'yours';
  }
};

/** Whether `path` is a file yokoten wrote: it carries the managed mark. */
const isManaged = (path: string): boolean => typeof managedFileText(path) === 'object';

/**
 * Take back the shared skill: a link install made is removed, never followed. A real
 * folder is removed, kept or missing, as `removeManaged` says for its skill file.
 */
function removeSharedSkill(file: string): 'removed' | 'kept (yours)' | 'kept (your edit)' | 'not there' {
  const path = dirname(file);
  try {
    readlinkSync(path);
  } catch {
    return removeManaged(file, { folder: true });
  }
  unlinkSync(path);
  return 'removed';
}

/** Remove a file yokoten owns, and its folder when that is left empty. A file without the mark is the user's, and so is a marked file the user edited. */
function removeManaged(path: string, { folder = false }: { folder?: boolean } = {}): 'removed' | 'kept (yours)' | 'kept (your edit)' | 'not there' {
  // One read decides all three: missing, ours, or the user's. A check before the read would
  // leave a gap where the file changes (CodeQL js/file-system-race).
  const found = managedFileText(path);
  if (found === 'missing') return 'not there';
  if (found === 'yours') return 'kept (yours)';
  if (isEditedManaged(found.text)) return 'kept (your edit)';
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
 * A managed file the user edited while the kit's copy has changed since (#477). `file` is
 * the user's copy; `kitFile` is the newer copy to compare it with.
 */
export type EditedKitCopy = { name: string; file: string; kitFile: string };

/** A file's text, or null when it is missing or cannot be read. */
const readTextOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** A folder's entries, or none when it is missing or cannot be read. */
const listOrNone = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The managed files the user edited whose kit copy has changed since install wrote it
 * (record 0015, #477). The hash in the mark says which version install wrote, so a
 * different hash in the kit means a newer copy is waiting. A file with no hash came from
 * an older yokoten and says nothing here.
 */
export function editedKitCopies(env: Env): EditedKitCopy[] {
  const copies: EditedKitCopy[] = [];
  const seen = new Set<string>();
  const look = (file: string, kitFile: string, name: string): void => {
    const text = readTextOrNull(file);
    const kitText = readTextOrNull(kitFile);
    if (text === null || kitText === null || !isEditedManaged(text) || !isNewerKitCopy(text, kitText)) return;
    // The shared skill may be a link to Claude Code's copy: name that copy once.
    const real = realPath(file) ?? file;
    if (seen.has(real)) return;
    seen.add(real);
    copies.push({ name, file, kitFile });
  };
  // A project copy of the kit has no kit/user folder, so this says nothing there (#77).
  for (const name of listOrNone(join(KIT, 'user', 'skills'))) {
    const [claudeFile, sharedFile] = skillFiles(env, name);
    // The entry skill comes from kit/user/entry: the adoption skill is not the copy install writes.
    const kitFile = name === ENTRY_SKILL ? entryFile() : join(KIT, 'user', 'skills', name, 'SKILL.md');
    look(claudeFile, kitFile, `skill ${name}`);
    look(sharedFile, kitFile, `skill ${name}`);
  }
  for (const file of listOrNone(join(KIT, 'user', 'agents'))) look(agentFile(env, file), join(KIT, 'user', 'agents', file), `agent ${file.replace(/\.md$/, '')}`);
  return copies;
}

/**
 * The pieces of install that are on this machine, for the doctor note when the plugin is
 * on too (#300). Empty when install never ran, or `uninstall` took them back.
 */
export function installedPieces(env: Env): string[] {
  const pieces: string[] = [];
  const hooks = [hasSessionDoctor(env) && 'the SessionStart doctor', hasUserGuard(env) && 'the command guard'].filter((hook) => hook !== false);
  if (hooks.length) pieces.push(`${hooks.join(' and ')} in ${join(userDir(env), 'settings.json')}`);
  const skillDirs = installedSkillDirs(env);
  if (skillDirs.length) pieces.push(`the skills in ${skillDirs.join(' and ')}`);
  if (kitAgents().some((file) => isManaged(agentFile(env, file)))) pieces.push(`the agents in ${join(userDir(env), 'agents')}`);
  if (existsSync(paths(env).runtime)) pieces.push(paths(env).runtime);
  return pieces;
}

/**
 * True when this machine has what install would put there: the runtime, and at least one
 * of the hooks, skills or agents. A machine with only part of it counts as missing, so
 * `yokoten` with no command installs again and repairs it (#548).
 */
export function isMachineSetUp(env: Env): boolean {
  const { runtime } = paths(env);
  if (!existsSync(join(runtime, 'bin', 'yokoten.mjs'))) return false;
  return installedPieces(env).some((piece) => !piece.includes(runtime));
}

/**
 * Take back what install wrote: the skills and agents that carry the managed mark, the two
 * user-level hooks, the runtime, and the files install made that the user never added to
 * (the private marks' header, the mailmap). A key or a mark of theirs keeps its file and
 * folder. A second run finds nothing and changes nothing.
 */
export function uninstall(env: Env, { platform = process.platform }: { platform?: NodeJS.Platform } = {}): { ok: boolean; lines: string[] } {
  // As install: with no home, every path below would be relative (#404).
  if (!homeOf(env)) return { ok: false, lines: [`${NO_HOME}. Set HOME to your home folder's full path and run uninstall again`] };
  const target = paths(env);
  const report: string[] = [];
  for (const name of kitSkills()) {
    const [claudeFile, sharedFile] = skillFiles(env, name);
    report.push(describeWrite(removeManaged(claudeFile, { folder: true }), `skill ${name} in ${skillsDir(claudeFile)}`));
    report.push(describeWrite(removeSharedSkill(sharedFile), `skill ${name} in ${skillsDir(sharedFile)}`));
  }
  for (const file of kitAgents()) report.push(describeWrite(removeManaged(agentFile(env, file)), `agent ${file.replace(/\.md$/, '')}`));

  const settings = join(userDir(env), 'settings.json');
  const hooks = removeUserHooks(env);
  if (hooks) report.push(describeWrite(hooks.doctor, 'the SessionStart doctor'), describeWrite(hooks.guard, 'the user-level command guard'));
  else report.push(`kept ${settings}: it is not JSON, so the two hooks are still in it; take them out by hand`);
  // The user-level guards outside Claude Code's settings (#342). Each is touched only
  // when its tool is on this machine; an unreadable file stays as it is.
  const extras: [string, 'removed' | 'not there' | 'kept (yours)' | null | { doctor: 'removed' | 'not there'; guard: 'removed' | 'not there' }][] = [
    ['Antigravity CLI', antigravity.hasUserDir(env) ? antigravity.removeUserHooks(env) : 'not there'],
    ['Copilot CLI', copilot.hasUserDir(env) ? copilot.removeUserHooks(env) : 'not there'],
    ['Codex CLI', codex.hasUserDir(env) ? codex.removeUserHooks(env) : 'not there'],
    ['Gemini CLI', gemini.hasUserDir(env) ? gemini.removeUserHooks(env) : 'not there'],
    ['Grok CLI', grok.hasUserDir(env) ? grok.removeUserHooks(env) : 'not there'],
    ['Muse Code', muse.hasUserDir(env) ? muse.removeUserHooks(env) : 'not there'],
    ['OpenCode', opencode.hasUserDir(env) ? opencode.removeUserPlugin(env, USER_CLI, USER_MISSING) : 'not there'],
  ];
  for (const [name, removed] of extras) {
    if (removed === null) report.push(`kept the ${name} hooks: the file is not JSON; take them out by hand`);
    else if (typeof removed === 'object') {
      if (removed.doctor === 'removed' || removed.guard === 'removed') report.push(`removed the ${name} user hooks`);
    } else if (removed === 'removed') report.push(`removed the ${name} user hook`);
  }

  report.push(...trySafely('the launcher', () => removeLauncher(homeIn(env), platform)));
  const hadRuntime = existsSync(target.runtime);
  rmSync(target.runtime, { recursive: true, force: true });
  report.push(describeWrite(hadRuntime ? 'removed' : 'not there', `the runtime ${target.runtime}`));
  // The stop log is yokoten's own, so uninstall takes it with the rest (#621).
  const stopLog = join(target.config, STOPS_FILE);
  const stopOff = join(target.config, STOPS_OFF_FILE);
  const hadStopLog = existsSync(stopLog) || existsSync(stopOff);
  rmSync(stopLog, { force: true });
  rmSync(stopOff, { force: true });
  report.push(`${hadStopLog ? 'removed' : 'not there'} the stop log`);
  // A file install wrote and the user never added to goes too, so the home folder is as
  // it was before install (#904). A mark or a mailmap line of their own keeps the file.
  const headerOnly = (file: string, header: string): boolean => {
    try {
      return readFileSync(file, 'utf8') === header;
    } catch {
      return false;
    }
  };
  if (headerOnly(target.marks, MARKS_HEADER)) {
    rmSync(target.marks, { force: true });
    report.push(`removed ${target.marks}`);
  }
  const mailmapFile = join(target.config, 'mailmap');
  const mailmapHeader = '# yokoten: git prints the owner\'s emails as a placeholder. Kept outside every repo; never commit it.\n';
  if (headerOnly(mailmapFile, mailmapHeader) && mailmapState(env) !== 'other') {
    rmSync(mailmapFile, { force: true });
    report.push(`removed ${mailmapFile}`);
  }
  if (mailmapState(env) === 'ours') readGitValue(env, ['config', '--global', '--unset', 'mailmap.file']);
  const gitConfig = env.GIT_CONFIG_GLOBAL;
  try {
    if (gitConfig && statSync(gitConfig).size === 0) rmSync(gitConfig, { force: true });
  } catch {
    // no global git config, or it holds the user's own settings: it stays
  }
  // A folder install made, and the user never put anything in, goes too. A folder with
  // anything of theirs in it stays.
  for (const dir of [
    join(homeIn(env), '.local', 'bin'),
    join(homeIn(env), '.local', 'share'),
    join(homeIn(env), '.local'),
    target.config,
    join(homeIn(env), '.agents', 'skills'),
    join(homeIn(env), '.agents'),
    join(userDir(env), 'skills'),
    join(userDir(env), 'agents'),
    userDir(env),
    join(homeIn(env), '.grok', 'hooks'),
    join(homeIn(env), '.copilot', 'hooks'),
    join(homeIn(env), '.gemini', 'config'),
    join(homeIn(env), '.config', 'opencode', 'plugins'),
    join(homeIn(env), '.config', 'muse'),
    join(homeIn(env), '.config'),
  ]) {
    try {
      rmdirSync(dir);
    } catch {
      // the folder holds something of the user's: it stays
    }
  }
  if (existsSync(target.config)) report.push(`kept ${target.config} (your keys and private marks)`);
  return { ok: true, lines: report };
}

// ---- What this machine knows about its owner (#390) ----
//
// The obvious marks are on the machine already: git's user.name and user.email, the login
// gh is signed in with, the hosts of private remotes. `install` and full `doctor` add the
// ones the private-marks file lacks, and never print a value. A machine-level mailmap makes
// `git log` and `git show` print a placeholder for the owner's emails at the source.

/** A folder in no repo, the root of the file system, for a git read of the machine's own config. */
const OUTSIDE_REPOS = parse(process.execPath).root;

/** One git read with the caller's environment (its HOME and global config), in `cwd` or outside every repo, or null. Nothing is printed. */
function readGitValue(env: Env, args: string[], cwd: string = OUTSIDE_REPOS): string | null {
  try {
    const value = execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
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
 * `cwd`, or outside every repo without one), the login gh is signed in with (only when `gh` is given: it may reach the network),
 * and the hosts of remotes in `cwd` that are not public forges.
 */
export function machineMarks(env: Env, { cwd, gh }: { cwd?: string; gh?: Gh } = {}): MachineMark[] {
  const found: MachineMark[] = [];
  // In a run (full doctor), one config list kept for the run holds all three (#453).
  const listed = (match: string | RegExp) => configEntries(cwd ?? OUTSIDE_REPOS, match, env)?.map((entry) => entry.value.trim()) ?? null;
  const lastOf = (key: string) => {
    const values = listed(key);
    return values ? values.at(-1) || null : readGitValue(env, ['config', '--get', key], cwd);
  };
  const name = lastOf('user.name');
  if (name) found.push({ kind: 'git name', value: name });
  const email = lastOf('user.email');
  // A noreply address is meant to be public; the login in it is added on its own.
  if (email && isPersonalEmail(email)) found.push({ kind: 'git email', value: email });
  const login = gh ? readLogin(gh) : null;
  if (login) found.push({ kind: 'forge login', value: login });
  const urls = listed(/^remote\..*\.url$/)?.map((value) => value.split(/\s+/)[0]) ?? (readGitValue(env, ['config', '--get-regexp', String.raw`^remote\..*\.url$`], cwd) ?? '').split('\n').map((line) => line.split(/\s+/)[1] ?? '');
  for (const host of privateRemoteHosts(urls)) found.push({ kind: 'private remote host', value: host });
  return found;
}

/** Where yokoten keeps what it read about this machine: outside every repo. Throws NO_HOME with no home. */
export const machineStateFile = (env: Env): string => join(paths(env).config, 'machine.json');

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
    file = machineStateFile(env);
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
 * The private-marks text with each block under the old plain header (before #410) split
 * by kind, or null when it has none. A value is a forge login only when it is one of
 * `logins`; an address is a git email; one of `hosts`, or a value with a dot, is a host.
 * Anything else goes under OWN_HEADER, so the check treats it as the owner's: strict.
 * The lines outside those blocks stay as they are.
 */
export function migrateMarks(text: string, { logins, hosts }: { logins: string[]; hosts: string[] }): string | null {
  const lines = text.split('\n');
  if (!lines.some((line) => line.trim() === FOUND_HEADER)) return null;
  const loginSet = new Set(logins.map((login) => login.toLowerCase()));
  const hostSet = new Set(hosts.map((host) => host.toLowerCase()));
  const kindOf = (value: string): string | null => {
    const key = value.toLowerCase();
    if (loginSet.has(key)) return 'forge login';
    if (isEmailShaped(key)) return 'git email';
    if (hostSet.has(key) || key.includes('.')) return 'private remote host';
    return null;
  };
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== FOUND_HEADER) {
      out.push(lines[index]);
      continue;
    }
    // The block runs to the next comment line.
    const values: string[] = [];
    while (index + 1 < lines.length && !lines[index + 1].trim().startsWith('#')) {
      index++;
      const value = lines[index].replace(/\r$/, '').trim();
      if (value) values.push(value);
    }
    const groups = new Map<string | null, string[]>();
    for (const value of values) groups.set(kindOf(value), [...(groups.get(kindOf(value)) ?? []), value]);
    for (const [kind, group] of groups) out.push(kind === null ? OWN_HEADER : foundHeader(kind), ...group);
  }
  const joined = out.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

/** Write a file in one step: a temp file next to it, then a rename. It keeps the file's mode. */
function replaceFile(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // a new file: 600
  }
  try {
    writeFileSync(temp, text, { mode });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Add the machine's marks that the private-marks file lacks, at its end. It makes the file
 * (mode 600) when it is missing. A block under the old plain header is first split by kind
 * (`migrateMarks`), in one atomic write. Returns the kinds it added, never a value.
 */
export function fillMarks(env: Env, found: MachineMark[]): string[] {
  const file = marksFile(env);
  const logins = found.filter((mark) => mark.kind === 'forge login').map((mark) => mark.value);
  if (existsSync(file)) {
    const hosts = found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value);
    const migrated = migrateMarks(readFileSync(file, 'utf8'), { logins: [...readLocalLogins(env), ...logins], hosts });
    if (migrated !== null) replaceFile(file, migrated);
  }
  // Known from the file it writes, so a mark only in the setting's file still goes in (#656).
  const own = writtenMarksOnly(env);
  const known = new Set(loadMarks(own));
  const off = new Set(kindsTurnedOff(env));
  // A git name that is a login is covered by the login's mark (#410, #434): the one added now, or one the file has.
  const loginSet = new Set([...(off.has('forge login') ? [] : logins.map((login) => login.toLowerCase())), ...loadMarkKinds(own).filter((mark) => mark.kind === 'forge login').map((mark) => mark.value)]);
  const added: MachineMark[] = [];
  for (const mark of found.filter((one) => !off.has(one.kind))) {
    const key = mark.value.toLowerCase();
    if (known.has(key)) continue;
    if (mark.kind === 'git name' && (!isPersonName(mark.value) || loginSet.has(key))) continue;
    known.add(key);
    added.push(mark);
  }
  if (!added.length) return [];
  if (!existsSync(file)) writeNew(file, MARKS_HEADER, { mode: 0o600 });
  const text = readFileSync(file, 'utf8');
  // One header per kind, so the check knows a forge login from a mark the owner wrote (#410).
  const kinds = [...new Set(added.map((mark) => mark.kind))];
  const blocks = kinds.map((kind) => `${foundHeader(kind)}\n${added.filter((mark) => mark.kind === kind).map((mark) => mark.value).join('\n')}\n`);
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${blocks.join('')}`);
  return kinds;
}

/**
 * Whether the private-marks files have a mark, of any kind: the ones install found count too
 * (#522). `unreadable` when one of them is there but can't be read (#656).
 */
export function marksState(env: Env): 'some' | 'none' | 'unreadable' {
  try {
    return loadMarks(env).length > 0 ? 'some' : 'none';
  } catch {
    return 'unreadable';
  }
}

/** Whether the private-marks files have a mark. False when they are missing or can't be read. */
export const hasMarks = (env: Env): boolean => marksState(env) === 'some';

/** What doctor says when a private-marks file can't be read (#656), and what to do. */
export const UNREADABLE_MARKS = "a private-marks file can't be read, so the privacy check stops every commit";
export const UNREADABLE_MARKS_FIX = 'make ~/.config/yokoten/private-marks readable, and check that YOKOTEN_PRIVATE_MARKS, if set, names a file you can read';

/** What doctor and install say to do when the private-marks file has no mark. */
export const EMPTY_MARKS_FIX = 'run `yokoten marks add` and type your name, your city or a domain; it is not shown';

/** The offer of the kinds yokoten can't find, when the file has marks: optional, never missing (#522). */
export const offerMarkKinds = (missing: string[]): string => `optional: add ${missing.join(' or ')} too; yokoten can't find them on its own`;
export const OFFER_MARKS_FIX = 'run `yokoten marks add` and type one; it is not shown';

/**
 * The lines install and doctor print after `fillMarks`: the kinds, never the values. The git
 * name has a line of its own (#434). Nothing when nothing was added: the private-marks check
 * gives the file's state, once (#522).
 */
export function filledLines(kinds: string[], file: string): string[] {
  const others = kinds.filter((kind) => kind !== 'git name');
  const lines = kinds.includes('git name') ? [GIT_NAME_ADDED] : [];
  if (others.length) lines.push(`added to ${file} from this machine: ${others.join(', ')} (the values are not shown)`);
  return lines;
}

/** What install says when it adds the git name: never the name. */
export const GIT_NAME_ADDED = 'added your git name to the private marks (not shown)';

// Names a tutorial or a template puts in user.name: they name nobody.
const PLACEHOLDER_NAMES = new Set(['your name', 'john doe', 'jane doe', 'user', 'name', 'admin', 'first last', 'firstname lastname']);

/**
 * Whether a git user.name names a person, so install adds it as a mark: 3 characters or
 * more, not an address, not a placeholder (`your name`, `john doe`), and not an account
 * name every machine of a kind has (`root`, `test`). One word counts too: it may be all
 * the name the owner uses.
 */
export function isPersonName(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return key.length >= 3 && !key.includes('@') && !PLACEHOLDER_NAMES.has(key) && !SHARED_ACCOUNTS.has(key);
}

// ---- The kinds of mark the owner can turn off (#434) ----

/** The kinds install adds by itself that `yokoten marks off` can turn off, as the command line names them. */
export const SWITCHED_KINDS: Record<string, MachineMark['kind']> = { 'git-name': 'git name', 'git-email': 'git email', 'forge-login': 'forge login' };

/** The kinds the owner turned off with `yokoten marks off`, from machine.json: install and doctor don't add them. */
export function kindsTurnedOff(env: Env): string[] {
  let file: string;
  try {
    file = machineStateFile(env);
  } catch {
    return [];
  }
  const off = readMachineState(file, REAL_USER_PROBE).marksOff;
  const known = Object.values(SWITCHED_KINDS) as string[];
  return Array.isArray(off) ? off.filter((kind): kind is string => typeof kind === 'string' && known.includes(kind)) : [];
}

/** Turn one kind off or back on in machine.json, keeping the other keys. Throws when the file can't be written. */
export function setKindOff(env: Env, kind: string, isOff: boolean): void {
  const rest = kindsTurnedOff(env).filter((one) => one !== kind);
  saveMachineState(machineStateFile(env), REAL_USER_PROBE, 'marksOff', isOff ? [...rest, kind] : rest);
}

/**
 * Add one mark the owner gives, as their own (`yokoten marks add`): at the end of the file,
 * under `# your own marks` when the last part is one yokoten added. It makes the file (mode
 * 600) when it is missing. False when the file has the mark already.
 */
export function addOwnMark(env: Env, value: string): boolean {
  const file = marksFile(env);
  if (loadMarks(writtenMarksOnly(env)).includes(value.toLowerCase())) return false;
  if (!existsSync(file)) writeNew(file, MARKS_HEADER, { mode: 0o600 });
  const text = readFileSync(file, 'utf8');
  const last = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('#')).at(-1) ?? '';
  const isFound = last === FOUND_HEADER || last.startsWith(`${FOUND_HEADER}: `);
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${isFound ? `${OWN_HEADER}\n` : ''}${value}\n`);
  return true;
}

/**
 * Take out the marks `drop` picks, and a header yokoten wrote that has no mark left under it.
 * An old plain block is split by kind first, as `fillMarks` does. The owner's comments stay.
 * Returns the marks taken out, never printed.
 */
export function removeMarks(env: Env, drop: (mark: Mark) => boolean): Mark[] {
  const file = marksFile(env);
  if (!existsSync(file)) return [];
  const before = readFileSync(file, 'utf8');
  const text = migrateMarks(before, { logins: readLocalLogins(env), hosts: [] }) ?? before;
  const lines = text.split('\n');
  const read = markLines(text);
  const removed: Mark[] = [];
  const kept = lines.filter((_, index) => {
    const mark = read[index];
    if (!mark || !drop(mark)) return true;
    removed.push(mark);
    return false;
  });
  if (!removed.length) {
    if (text !== before) replaceFile(file, text);
    return [];
  }
  // A header of yokoten's own with only blank lines or another comment after it is left empty: it goes too.
  const isOurs = (line: string) => line.trim() === FOUND_HEADER || line.trim().startsWith(`${FOUND_HEADER}: `) || line.trim() === OWN_HEADER;
  const out = kept.filter((line, index) => {
    if (!isOurs(line)) return true;
    const next = kept.slice(index + 1).find((after) => after.trim() !== '');
    return next !== undefined && !next.trim().startsWith('#');
  });
  replaceFile(file, out.join('\n'));
  return removed;
}

/** How many marks the file holds of each kind, the owner's as `by hand`. Never the values. */
export function countMarkKinds(env: Env): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mark of loadMarkKinds(env)) counts.set(mark.kind ?? 'by hand', (counts.get(mark.kind ?? 'by hand') ?? 0) + 1);
  return counts;
}

/**
 * The kinds of mark yokoten can't find on its own, which the file seems to lack, in plain
 * words. A domain has a dot; anything else not from the machine may be the city. The name
 * is not asked for: install adds the git name (#434). A guess from the shape, so doctor shows it as a note.
 */
export function missingMarkKinds(marks: string[], found: MachineMark[]): string[] {
  const fromMachine = new Set(found.map((mark) => mark.value.toLowerCase()));
  const own = marks.filter((mark) => !fromMachine.has(mark) && !mark.includes('@'));
  const missing: string[] = [];
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
  if (mailmapState(env) !== 'ours') return `skipped the git mailmap: git config could not set mailmap.file; run \`git config --global mailmap.file ${MAILMAP_SETTING}\`; a mailmap makes git print a private address in place of your email`;
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
