// `yokoten install`: the machine layer, the same on every computer. It puts the skills
// where Claude Code and the agents that read `.agents/skills` find them in every project,
// the agents where Claude Code finds them, and adds two user-level hooks:
//
// - SessionStart runs `doctor --session`, so every session in every repo starts by
//   hearing which practices that repo is missing. Nobody has to remember to ask.
// - PreToolUse runs `hook --commands-only`: no tag pushes, no force pushes, no skipped
//   checks, in every repo, adopted or not.
//
// `yokoten uninstall` takes back what install wrote and marked as its own, for a machine
// that moves to the Claude Code plugin (#300): the plugin brings the same pieces, and both
// at once run every hook twice and show every skill twice.

import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { skillFile as sharedSkillFile } from '../agents/agent-skills.ts';
import { addUserHooks, agentFile, hasSessionDoctor, hasUserGuard, removeUserHooks, skillFile as claudeSkillFile, userDir } from '../agents/claude-code.ts';
import { copyRuntime, KIT, MANAGED, writeManaged, writeNew } from './files.ts';
import { marksFile } from '../rules/privacy.ts';

export const paths = (env: Env) => {
  const home = env.HOME || homedir();
  return {
    runtime: join(home, '.local', 'share', 'yokoten'),
    config: join(home, '.config', 'yokoten'),
    marks: marksFile(env),
  };
};

/** Every place a skill goes: Claude Code's folder, and the shared one other agents read. */
export const skillFiles = (env: Env, name: string): string[] => [claudeSkillFile(env, name), sharedSkillFile(env, name)];

/** The skills folder a skill file is in, for the report: `~/.claude/skills`. */
export const skillsDir = (file: string): string => dirname(dirname(file));

const MARKS_HEADER = `# yokoten private marks: words that must never be published.
# One per line, matched without case. Your real name, city, domain, server names, other
# account names. This file stays on this machine; never commit it or paste it anywhere.
`;

export function install(env: Env): string[] {
  const target = paths(env);
  const report: string[] = [];
  copyRuntime(target.runtime, { withKit: true });
  report.push(`wrote ${target.runtime}`);

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

  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.ts"';
  const hooks = addUserHooks(env, cli);
  report.push(`${hooks.doctor} the SessionStart doctor`, `${hooks.guard} the user-level command guard`);

  const marks = writeNew(target.marks, MARKS_HEADER, { mode: 0o600 });
  report.push(`${marks} ${target.marks}${marks === 'wrote' ? ' (add your marks to it)' : ''}`);
  return report;
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
export function uninstall(env: Env): string[] {
  const target = paths(env);
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
  return report;
}
