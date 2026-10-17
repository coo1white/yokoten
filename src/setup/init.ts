// `yokoten init`: put the practices into a project. It only adds: a file that is already
// there is kept, and the report says so. Deciding what to do with a project's own rules
// (keep, merge, or say not now) is the yokoten skill's job, not this command's.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { addProjectHook, setProjectEnv } from '../agents/claude-code.ts';
import * as codex from '../agents/codex.ts';
import * as gemini from '../agents/gemini.ts';
import { copyRuntime, HOME_DIR, KIT, render, writeNew } from './files.ts';

/** yokoten's own repo runs its own bin; every other project runs a vendored copy. */
export const isSelf = (root: string): boolean => {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'yokoten' && existsSync(join(root, 'bin', 'yokoten.ts'));
  } catch {
    return false;
  }
};

export const cliPath = (root: string): string => (isSelf(root) ? 'bin/yokoten.ts' : '.yokoten/bin/yokoten.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Returns one line per thing done or kept. */
export function init(root: string): string[] {
  const report: string[] = [];
  const cli = cliPath(root);
  if (!isSelf(root) && root !== HOME_DIR) {
    copyRuntime(join(root, '.yokoten'));
    report.push('wrote .yokoten/ (the runtime the hooks run; commit it)');
  }
  const kit = join(KIT, 'project');
  for (const file of walk(kit)) {
    const rel = relative(kit, file).split('\\').join('/');
    const result = writeNew(join(root, rel), render(readFileSync(file, 'utf8'), { cli }));
    report.push(`${result} ${rel}`);
  }
  chmodSync(join(root, '.githooks', 'pre-commit'), 0o755);
  const hook = addProjectHook(root, cli);
  report.push(`${hook} the tool-call hook in .claude/settings.json`);
  // Codex and Gemini CLI get the same guard, whether or not they are installed here: two
  // small files are easier to predict than a guess about which agents someone uses.
  report.push(`${codex.addProjectHook(root, cli)} the Codex tool-call hook in .codex/hooks.json (Codex asks you to trust it once, in /hooks)`);
  report.push(`${gemini.addProjectHook(root, cli)} the Gemini CLI tool-call hook in .gemini/settings.json`);
  report.push(`${setProjectEnv(root, 'TZ', 'UTC')} TZ=UTC for agent sessions in .claude/settings.json (commit times carry no time zone)`);
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
    report.push('set git core.hooksPath to .githooks (the commit check)');
  } catch {
    report.push('not a git repo: run `git init`, then `git config core.hooksPath .githooks`');
  }
  return report;
}
