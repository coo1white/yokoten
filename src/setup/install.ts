// `yokoten install`: the machine layer, the same on every computer. It puts the skills and
// agents where Claude Code finds them in every project, and adds two user-level hooks:
//
// - SessionStart runs `doctor --session`, so every session in every repo starts by
//   hearing which practices that repo is missing. Nobody has to remember to ask.
// - PreToolUse runs `hook --commands-only`: no tag pushes, no force pushes, no skipped
//   checks, in every repo, adopted or not.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../rules/config.ts';
import { addHook, copyRuntime, KIT, writeManaged, writeNew } from './files.ts';
import { marksFile } from '../rules/privacy.ts';

export const paths = (env: Env) => {
  const home = env.HOME || homedir();
  return {
    runtime: join(home, '.local', 'share', 'yokoten'),
    claude: join(home, '.claude'),
    marks: marksFile(env),
  };
};

const MARKS_HEADER = `# yokoten private marks: words that must never be published.
# One per line, matched without case. Your real name, city, domain, server names, other
# account names. This file stays on this machine; never commit it or paste it anywhere.
`;

export function install(env: Env): string[] {
  const p = paths(env);
  const report: string[] = [];
  copyRuntime(p.runtime, { withKit: true });
  report.push(`wrote ${p.runtime}`);

  const skills = join(KIT, 'user', 'skills');
  for (const name of readdirSync(skills)) {
    const result = writeManaged(join(p.claude, 'skills', name, 'SKILL.md'), readFileSync(join(skills, name, 'SKILL.md'), 'utf8'));
    report.push(`${result} skill ${name}`);
  }
  const agents = join(KIT, 'user', 'agents');
  for (const file of readdirSync(agents)) {
    const result = writeManaged(join(p.claude, 'agents', file), readFileSync(join(agents, file), 'utf8'));
    report.push(`${result} agent ${file.replace(/\.md$/, '')}`);
  }

  const cli = '"$HOME/.local/share/yokoten/bin/yokoten.ts"';
  const settings = join(p.claude, 'settings.json');
  report.push(`${addHook(settings, 'SessionStart', undefined, `node ${cli} doctor --session`)} the SessionStart doctor`);
  report.push(`${addHook(settings, 'PreToolUse', 'Bash', `node ${cli} hook --commands-only`)} the user-level command guard`);

  const marks = writeNew(p.marks, MARKS_HEADER, { mode: 0o600 });
  report.push(`${marks} ${p.marks}${marks === 'wrote' ? ' (add your marks to it)' : ''}`);
  return report;
}
