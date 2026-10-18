// `yokoten install`: the machine layer, the same on every computer. It puts the skills
// where Claude Code and the agents that read `.agents/skills` find them in every project,
// the agents where Claude Code finds them, and adds two user-level hooks:
//
// - SessionStart runs `doctor --session`, so every session in every repo starts by
//   hearing which practices that repo is missing. Nobody has to remember to ask.
// - PreToolUse runs `hook --commands-only`: no tag pushes, no force pushes, no skipped
//   checks, in every repo, adopted or not.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { skillFile as sharedSkillFile } from '../agents/agent-skills.ts';
import { addUserHooks, agentFile, skillFile as claudeSkillFile } from '../agents/claude-code.ts';
import { copyRuntime, KIT, writeManaged, writeNew } from './files.ts';
import { marksFile } from '../rules/privacy.ts';

export const paths = (env: Env) => {
  const home = env.HOME || homedir();
  return {
    runtime: join(home, '.local', 'share', 'yokoten'),
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
