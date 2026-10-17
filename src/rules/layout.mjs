// The layout rule: no folder below the root holds more than `maxEntries` entries, so the
// tree stays something a person (or an agent) can read at a glance. When a folder is
// full, the fix is a new level that names a group, not one more file.

import { posix } from 'node:path';

/** Problems for a list of file paths (relative, forward slashes), one per folder over the cap. */
export function checkLayout(files, { layout }) {
  const children = new Map();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      if (!children.has(dir)) children.set(dir, new Set());
      children.get(dir).add(parts[depth]);
    }
  }
  const exempt = new Set(layout.exempt.map((d) => posix.normalize(d).replace(/\/$/, '')));
  const problems = [];
  for (const [dir, names] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
    if (exempt.has(dir) || names.size <= layout.maxEntries) continue;
    problems.push(`${dir}/ has ${names.size} entries, over the cap of ${layout.maxEntries}: ${[...names].sort().join(', ')}. Group them into a new folder, or add ${dir} to layout.exempt in yokoten.json if it is a log.`);
  }
  return problems;
}
