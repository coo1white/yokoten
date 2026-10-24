import '../../repo/home.ts';
import { test } from 'node:test';
import { allowed } from '../../../test/repo/helpers.ts';

test('everyday commands pass', () => {
  for (const c of ['git status', 'git push', 'git push origin feature-v2', 'git commit -m "fix v1 parser"', 'npm test', 'gh pr create --fill', 'ls -la', 'gh release list']) allowed(c);
});
