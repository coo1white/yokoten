// Tests for src/run/changelog.ts.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../helpers.ts';
import {
  formatChanges,
  mergeChanges,
  parseChange,
  readChanges,
  writeChanges,
} from '../../src/run/changelog.ts';

// ---- Change files (#132) ----

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- An old entry,',
  '  wrapped.',
  '',
  '### Fixed',
  '',
  '- An old fix.',
  '',
  '## [0.1.0] - 2026-10-18',
  '',
  '### Added',
  '',
  '- The first release.',
  '',
].join('\n');

/** A folder with CHANGELOG.md and the change files given, by name. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'yokoten-'));
  mkdirSync(join(root, 'changes'));
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  writeFileSync(join(root, 'changes', 'README.md'), '# Change files\n\nNot a change.\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'changes', name), content);
  return root;
}

test('changelog: previews the change files, and --write moves them into CHANGELOG.md (#132)', () => {
  const sandbox = makeSandbox();
  let result = sandbox.run(['changelog']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no change files in changes\//);
  sandbox.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-18\n\n### Added\n\n- The first release.\n');
  sandbox.write('changes/README.md', '# Change files\n');
  sandbox.write('changes/2-b.md', 'Fixed\n\nA fix.\n');
  sandbox.write('changes/1-a.md', 'Added\n\nA thing.\n');
  result = sandbox.run(['changelog']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 change\(s\); `--write` adds these under \[Unreleased\] in CHANGELOG\.md:\n\n### Added\n\n- A thing\.\n\n### Fixed\n\n- A fix\.\n$/);
  assert.ok(existsSync(join(sandbox.repo, 'changes/1-a.md')), 'a preview writes nothing');
  // A bad file stops the write, and says so on stderr.
  sandbox.write('changes/3-c.md', 'Added\n');
  result = sandbox.run(['changelog', '--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 problem\(s\); nothing was written:\n- changes\/3-c\.md:1: no entry after the section/);
  rmSync(join(sandbox.repo, 'changes/3-c.md'));
  result = sandbox.run(['changelog', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wrote 2 change\(s\) under \[Unreleased\] in CHANGELOG\.md, and deleted:\n- changes\/1-a\.md\n- changes\/2-b\.md/);
  assert.equal(readFileSync(join(sandbox.repo, 'CHANGELOG.md'), 'utf8'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n### Fixed\n\n- A fix.\n\n## [0.1.0] - 2026-10-18\n\n### Added\n\n- The first release.\n');
  assert.deepEqual(readdirSync(join(sandbox.repo, 'changes')), ['README.md']);
  assert.equal(sandbox.run(['changelog', '--wrote']).status, 1, 'an unknown option is refused');
});

test('changes: a file is a section, a blank line, then the entry; a bullet is added when missing', () => {
  assert.deepEqual(parseChange('changes/1-a.md', 'Fixed\n\nA crash,\nwhen empty.\n'), { change: { file: 'changes/1-a.md', section: 'Fixed', lines: ['- A crash,', '  when empty.'] }, problems: [] });
  assert.deepEqual(parseChange('changes/1-a.md', 'added\r\n\r\n- One.\r\n- Two.\r\n').change?.lines, ['- One.', '- Two.'], 'several bullets, CRLF, any case');
  const bad = (content: string, file = 'changes/1-a.md') => parseChange(file, content).problems.map((problem) => `${problem.line ?? '-'}: ${problem.what}`);
  assert.deepEqual(bad('Improved\n\nA thing.\n'), ['1: line 1 is not a section']);
  assert.deepEqual(bad('Added\nA thing.\n'), ['2: line 2 is not blank']);
  assert.deepEqual(bad('Added\n\n\n'), ['1: no entry after the section']);
  assert.deepEqual(bad('Added\n'), ['1: no entry after the section']);
  assert.deepEqual(bad('Added\n\nA thing.\n', 'changes/1-a.txt'), ['-: a change file is not Markdown']);
  // A heading would go into CHANGELOG.md as is, even a fake version (#281).
  assert.deepEqual(bad('Added\n\n- A thing.\n## 9.9.9\n'), ['4: line 4 is a heading']);
  assert.deepEqual(bad('Added\n\n### Fixed\n'), ['3: line 3 is a heading']);
  assert.deepEqual(bad('Added\n\nA thing,\n#281 and more.\n'), [], 'an issue number is not a heading');
  assert.equal(parseChange('changes/1-a.md', 'Improved\n\nsecret words\n').problems.every((problem) => !JSON.stringify(problem).includes('secret words')), true, 'the text is never printed back');
});

test('changes: the collector groups and orders the sections, and skips README.md', () => {
  const root = makeRepo({ '132-b.md': 'Fixed\n\nB.\n', '9-a.md': 'Internal\n\nA.\n', '10-c.md': 'Added\n\nC.\n', '200-d.md': 'Fixed\n\nD.\n' });
  const { changes, problems } = readChanges(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(changes.map((change) => change.file), ['changes/9-a.md', 'changes/10-c.md', 'changes/132-b.md', 'changes/200-d.md'], 'by issue number');
  assert.deepEqual(formatChanges(changes), ['### Added', '', '- C.', '', '### Fixed', '', '- B.', '- D.', '', '### Internal', '', '- A.']);
  assert.deepEqual(readChanges(mkdtempSync(join(tmpdir(), 'yokoten-'))), { changes: [], problems: [] }, 'no changes/ folder');
});

test('changes: a link in changes/, dangling or not, is a finding, never a crash (#281)', () => {
  const root = makeRepo({ '1-good.md': 'Added\n\nGood.\n' });
  symlinkSync(join(root, 'changes', '1-good.md'), join(root, 'changes', '2-link.md'));
  symlinkSync(join(root, 'nowhere.md'), join(root, 'changes', '3-dangling.md'));
  const { changes, problems } = readChanges(root);
  assert.deepEqual(changes.map((change) => change.file), ['changes/1-good.md']);
  assert.deepEqual(problems.map((problem) => [problem.id, problem.file]), [['change-file', 'changes/2-link.md'], ['change-file', 'changes/3-dangling.md']]);
});

test('changes: a bad file is refused, and nothing is written or deleted', () => {
  const root = makeRepo({ '1-good.md': 'Added\n\nGood.\n', '2-bad.md': 'Improved\n\nBad.\n' });
  const { changes, problems } = writeChanges(root);
  assert.deepEqual(changes, []);
  assert.deepEqual(problems.map((problem) => [problem.id, problem.file, problem.line]), [['change-file', 'changes/2-bad.md', 1]]);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), CHANGELOG);
  assert.ok(existsSync(join(root, 'changes', '1-good.md')) && existsSync(join(root, 'changes', '2-bad.md')));
  // No Unreleased heading: refused too.
  writeFileSync(join(root, 'changes', '2-bad.md'), 'Fixed\n\nNow good.\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1.0]\n');
  assert.match(writeChanges(root).problems[0]?.what ?? '', /no `## \[Unreleased\]` heading/);
  assert.ok(existsSync(join(root, 'changes', '1-good.md')));
});

test('changes: --write puts each entry after its section, deletes the files, and keeps released versions', () => {
  const root = makeRepo({ '5-a.md': 'Added\n\nNew A.\n', '6-b.md': 'Changed\n\nNew B,\nwrapped.\n', '7-c.md': 'Internal\n\nNew C.\n', '8-d.md': 'Fixed\n\nNew D.\n' });
  const { changes, problems } = writeChanges(root);
  assert.deepEqual(problems, []);
  assert.equal(changes.length, 4);
  const written = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const [unreleased, released] = written.split('## [0.1.0]');
  assert.equal(`## [0.1.0]${released}`, CHANGELOG.slice(CHANGELOG.indexOf('## [0.1.0]')), 'released versions are not touched');
  assert.equal(
    unreleased,
    ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- An old entry,', '  wrapped.', '- New A.', '', '### Changed', '', '- New B,', '  wrapped.', '', '### Fixed', '', '- An old fix.', '- New D.', '', '### Internal', '', '- New C.', '', ''].join('\n'),
  );
  assert.deepEqual(readChanges(root), { changes: [], problems: [] }, 'the used files are gone');
  assert.ok(existsSync(join(root, 'changes', 'README.md')), 'the README stays');
  // An empty Unreleased gets its first heading.
  const merged = mergeChanges('# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n', changes.slice(0, 1));
  assert.equal(merged, '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New A.\n\n## [0.1.0]\n');
  // A CRLF file stays CRLF (#281).
  const crlf = mergeChanges(CHANGELOG.replaceAll('\n', '\r\n'), changes);
  assert.equal(crlf, written.replaceAll('\n', '\r\n'));
  // One stray CRLF line: the file is still read, and its lines keep their bytes (#281).
  const [firstLine, ...otherLines] = CHANGELOG.split('\n');
  const mixed = mergeChanges([`${firstLine}\r`, ...otherLines].join('\n'), changes);
  assert.equal(typeof mixed, 'string', 'a stray CRLF line still has an Unreleased heading');
  assert.ok((mixed as string).startsWith(CHANGELOG.split('\n')[0] + '\r\n'), 'the CRLF line is kept');
});
