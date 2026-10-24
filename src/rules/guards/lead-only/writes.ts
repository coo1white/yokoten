import { isAbsolute, join } from 'node:path';
import { finding, type Finding } from '../../message.ts';
import { type Env } from '../../config.ts';
import { stripWorktreeRoot, LEAD_ONLY_FIX, isLeadOnly, isGranted } from './edit.ts';
import { base } from '../bash/read/words.ts';
import { UNSURE_FOLDER_FIX, writeTargets, commitTargets, type WriteTarget, type FileRules } from './targets.ts';

function isUnsureTarget(target: WriteTarget, env: Env): boolean {
  if (target.from !== null || target.path === '' || target.path === '-') return false;
  const expanded = /^~(?=\/|$)/.test(target.path) && env.HOME ? join(env.HOME, target.path.slice(1)) : target.path;
  return !isAbsolute(expanded);
}

export function checkLeadOnlyWrites(words: string[], { env, rules, folder }: { env: Env; rules: FileRules; folder: string | null }): Finding | null {
  // A folder counts when a lead-only file may be in it: `rm -r .github`.
  // A file in a worker worktree matches from that worktree (#571), as an edit does; the message keeps the full path.
  const stopped = (target: WriteTarget): string | null => {
    const ruled = rules.ruled(target, env);
    if (!ruled) return null;
    const inWorktree = stripWorktreeRoot(ruled.path);
    const matches = (path: string) => isLeadOnly(path, ruled.leadOnly);
    return (matches(inWorktree) || matches(`${inWorktree}/-`)) && !isGranted(inWorktree, env) ? ruled.path : null;
  };
  for (const target of writeTargets(words, folder, rules.rootOf)) {
    if (target.isUnread) {
      if (target.from === null && target.path !== '' && target.path !== '-') {
        return finding('lead-only', `this command applies ${target.path}, and yokoten can't tell which files it changes from an unknown folder`, UNSURE_FOLDER_FIX);
      }
      if (target.from !== null && rules.isRuled(target.from)) {
        return finding('lead-only', `this command applies ${base(target.path)}, and yokoten can't read which files it changes`, `apply a patch file under 1 MB, so the guard can read it, or ${LEAD_ONLY_FIX}`);
      }
      continue;
    }
    if (isUnsureTarget(target, env)) {
      return finding('lead-only', `this command writes ${target.path}, and yokoten can't tell which file that is from an unknown folder`, UNSURE_FOLDER_FIX);
    }
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this command writes ${path}, which is lead-only (yokoten.json "leadOnly")`, LEAD_ONLY_FIX);
  }
  for (const target of commitTargets(words, folder, rules.rootOf, env)) {
    if (isUnsureTarget(target, env)) {
      return finding('lead-only', `this commit changes ${target.path}, and yokoten can't tell which file that is from an unknown folder`, UNSURE_FOLDER_FIX);
    }
    const path = stopped(target);
    if (path !== null) return finding('lead-only', `this commit changes ${path}, which is lead-only (yokoten.json "leadOnly")`, `unstage it with \`git restore --staged ${path}\`, then ${LEAD_ONLY_FIX}`);
  }
  return null;
}
