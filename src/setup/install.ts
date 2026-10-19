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
// It ends by saying how to call `yokoten` when no `yokoten` on the PATH runs this copy
// (#208): every message says `yokoten init`, and a clone install puts nothing on the
// PATH. It prints the alias and never edits the shell profile: that file is the user's.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { skillFile as sharedSkillFile } from '../agents/agent-skills.ts';
import { addUserHooks, agentFile, skillFile as claudeSkillFile } from '../agents/claude-code.ts';
import * as codex from '../agents/codex.ts';
import * as gemini from '../agents/gemini.ts';
import { copyRuntime, HOME_DIR, KIT, writeManaged, writeNew } from './files.ts';
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

export function install(env: Env): string[] {
  const target = paths(env);
  const report: string[] = [];
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

  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.ts"';
  const missing = 'yokoten: the runtime at ~/.local/share/yokoten is missing; run the install again';
  const hooks = addUserHooks(env, cli, missing);
  report.push(`${hooks.doctor} the SessionStart doctor`, `${hooks.guard} the user-level command guard`);
  // Codex and Gemini CLI get the same two hooks (#211), whether or not they are installed.
  const codexHooks = codex.addUserHooks(env, cli, missing);
  report.push(`${codexHooks.doctor} the Codex SessionStart doctor in ~/.codex/hooks.json`, `${codexHooks.guard} the Codex command guard in ~/.codex/hooks.json`);
  const geminiHooks = gemini.addUserHooks(env, cli, missing);
  report.push(`${geminiHooks.doctor} the Gemini CLI SessionStart doctor in ~/.gemini/settings.json`, `${geminiHooks.guard} the Gemini CLI command guard in ~/.gemini/settings.json`);

  const marks = writeNew(target.marks, MARKS_HEADER, { mode: 0o600 });
  report.push(`${marks} ${target.marks}${marks === 'wrote' ? ' (add your marks to it)' : ''}`);
  if (!isOnPath(env, target.runtime)) report.push(aliasLine(target.runtime));
  return report;
}
