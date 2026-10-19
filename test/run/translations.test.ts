// Tests for src/run/translations.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTranslatedRepo } from '../repo/helpers.ts';
import {
  DEFAULTS,
  loadConfig,
} from '../../src/rules/config.ts';
import type { Finding } from '../../src/rules/message.ts';
import { check } from '../../src/run/check.ts';
import {
  parseSourceMarker,
  sourceMarker,
  translationNotes,
} from '../../src/run/translations.ts';

// The older marker form (#87), with the English blob; still read (#166).
const blobMarker = (source: string, blob: string) => `<!-- source: ${source} blob ${blob} -->`;

test('translations: line 1 names the source; the older form adds a blob; other first lines are not markers (#87, #166)', () => {
  const blob = 'a'.repeat(40);
  assert.equal(sourceMarker('docs/guide.md'), '<!-- source: docs/guide.md -->');
  assert.deepEqual(parseSourceMarker(`${sourceMarker('docs/guide.md')}\n# Title`), { source: 'docs/guide.md', blob: null });
  assert.deepEqual(parseSourceMarker(`${blobMarker('docs/guide.md', blob)}\n# Title`), { source: 'docs/guide.md', blob });
  assert.equal(parseSourceMarker('# Title\n<!-- source: a.md -->'), null, 'only line 1');
  assert.equal(parseSourceMarker('<!-- source: -->'), null, 'no path');
  assert.equal(parseSourceMarker('---\nsource: a.md\n---'), null, 'front matter is not the form');
  // Only a relative path (#181): an attribution comment names a URL, and an absolute path is no repo file.
  for (const source of ['https://example.com/post', 'mailto:a@example.com', '/docs/guide.md', 'C:\\docs\\guide.md']) {
    assert.equal(parseSourceMarker(`${sourceMarker(source)}\n# Title`), null, source);
  }
});

test('translations: a note when English changed after the translation, none when it is current (#87)', () => {
  const repo = makeTranslatedRepo();
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md']), [], 'current: no note');
  const translated = repo.git('rev-parse', 'HEAD');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\n');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\nStep three.\n');
  const [note, ...rest] = translationNotes(repo.root, ['en.md', 'zh.md']);
  assert.deepEqual(rest, []);
  assert.equal(note.id, 'translation-behind');
  assert.equal(note.file, 'zh.md');
  assert.equal(note.line, 1);
  assert.equal(note.what, 'is behind en.md by 2 commits');
  assert.ok(note.fix.includes(`git diff ${translated.slice(0, 12)} HEAD -- en.md`), note.fix);
  // Brought up to date, line 1 unchanged: the note goes.
  repo.commit('zh.md', `${sourceMarker('en.md')}\n# 指南\n\n第一步。第二步。第三步。\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), []);
  // An English edit not yet committed is behind; a translation edit with it is current.
  writeFileSync(join(repo.root, 'en.md'), '# Guide, edited\n');
  assert.equal(translationNotes(repo.root, ['zh.md'])[0]?.what, 'is behind en.md by edits not yet committed');
  writeFileSync(join(repo.root, 'zh.md'), `${sourceMarker('en.md')}\n# 指南（改）\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), []);
});

test('translations: a missing source gives a clear note; a URL or an absolute path is not a marker (#87, #181)', () => {
  const repo = makeTranslatedRepo();
  writeFileSync(join(repo.root, 'gone.md'), `${sourceMarker('nowhere.md')}\n`);
  writeFileSync(join(repo.root, 'out.md'), `${sourceMarker('../en.md')}\n`);
  writeFileSync(join(repo.root, 'credit.md'), '<!-- source: https://example.com/post -->\n# A post\n');
  writeFileSync(join(repo.root, 'root.md'), `${sourceMarker(join(repo.root, 'en.md'))}\n`);
  const notes = translationNotes(repo.root, ['gone.md', 'out.md', 'credit.md', 'root.md']);
  assert.equal(notes.length, 2, notes.map((n) => n.file).join(', '));
  assert.match(notes[0].what, /names nowhere\.md as its English source, which is not in the repo/);
  assert.match(notes[1].what, /names \.\.\/en\.md as its English source, which is not in the repo/);
});

test('translations: a shallow clone gives one note for the run, never a note per file, never a problem (#87, #181)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  repo.commit('zh2.md', `${sourceMarker('en.md')}\n# 指南二\n`);
  const shallowClone = (depth: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
    execFileSync('git', ['clone', '-q', '--depth', String(depth), `file://${repo.root}`, dir], { stdio: 'ignore' });
    return dir;
  };
  // CI's default checkout: one commit, which seems to add every file. Deeper is still shallow.
  for (const depth of [1, 2]) {
    const shallow = shallowClone(depth);
    const notes = translationNotes(shallow, ['en.md', 'zh.md', 'zh2.md']);
    assert.equal(notes.length, 1, `depth ${depth}: ${notes.map((n) => n.what).join('; ')}`);
    assert.equal(notes[0].file, undefined, 'not about one file');
    assert.equal(notes[0].what, "translations weren't checked: this clone is shallow");
    assert.match(notes[0].fix, /fetch-depth: 0/);
    // Even with "fail": a note, never a problem.
    const found: Finding[] = [];
    const problems = check(shallow, { config: { ...DEFAULTS, translations: { fail: true } }, env: {}, notes: found });
    assert.deepEqual(problems.filter((f) => f.id === 'translation-behind'), []);
    assert.deepEqual(found.map((f) => f.what), ["translations weren't checked: this clone is shallow"]);
  }
  // A translation edited in the work tree needs no history: no note.
  const shallow = shallowClone(1);
  writeFileSync(join(shallow, 'zh.md'), `${sourceMarker('en.md')}\n# 指南（改）\n`);
  assert.deepEqual(translationNotes(shallow, ['zh.md']), []);
});

test('translations: two branches that each change both files never edit the same line, and merge in turn with no note (#166)', () => {
  const repo = makeTranslatedRepo();
  const english = (top: string, bottom: string) => `# Guide\n\n${top}\n\nMiddle.\n\n${bottom}\n`;
  const translation = (top: string, bottom: string) => `${sourceMarker('en.md')}\n# 指南\n\n${top}\n\n中。\n\n${bottom}\n`;
  const change = (englishText: string, translationText: string, message: string) => {
    writeFileSync(join(repo.root, 'en.md'), englishText);
    writeFileSync(join(repo.root, 'zh.md'), translationText);
    repo.git('add', 'en.md', 'zh.md');
    repo.git('commit', '-q', '-m', message);
  };
  change(english('Top.', 'Bottom.'), translation('上。', '下。'), 'base');
  // Branches A and B both start here. A changes the top, B the bottom; each updates zh.md.
  repo.git('checkout', '-q', '-b', 'a');
  change(english('Top, A.', 'Bottom.'), translation('上，A。', '下。'), 'a');
  repo.git('checkout', '-q', '-b', 'b', 'main');
  change(english('Top.', 'Bottom, B.'), translation('上。', '下，B。'), 'b');
  // The lines each branch changes in zh.md: none in common, and never line 1.
  const changedLines = (branch: string) => repo.git('diff', '-U0', 'main', branch, '--', 'zh.md').split('\n').filter((line) => line.startsWith('@@')).map((line) => line.split(' ')[1]);
  const [linesA, linesB] = [changedLines('a'), changedLines('b')];
  assert.ok(linesA.length > 0 && linesB.length > 0, 'both branches change the translation');
  assert.deepEqual(linesA.filter((line) => linesB.includes(line)), [], `A ${linesA}, B ${linesB}`);
  assert.ok(![...linesA, ...linesB].some((line) => line === '-1' || line.startsWith('-1,')), 'line 1 is never edited');
  // Squash-merged in turn: git merges B after A with no conflict (it throws on one).
  repo.git('checkout', '-q', 'main');
  for (const branch of ['a', 'b']) {
    repo.git('merge', '-q', '--squash', branch);
    repo.git('commit', '-q', '-m', `squash ${branch}`);
  }
  assert.equal(readFileSync(join(repo.root, 'zh.md'), 'utf8'), translation('上，A。', '下，B。'));
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md']), [], 'both were translated: no note');
  // The English changes later, with no translation: a note, counted from history.
  repo.commit('en.md', english('Top, A.', 'Bottom, B, then C.'));
  const [note, ...rest] = translationNotes(repo.root, ['zh.md']);
  assert.deepEqual(rest, []);
  assert.equal(note.what, 'is behind en.md by 1 commit');
  assert.match(note.fix, /git diff [0-9a-f]{12} HEAD -- en\.md/);
  // The known cost, written in the guide: a typo fix to the translation counts as following.
  repo.commit('zh.md', translation('上，A。', '下，B！'));
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), []);
});

test('translations: the older marker with a blob still works, and its fix offers the line that never changes (#166)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('zh.md', `${blobMarker('en.md', repo.git('hash-object', 'en.md'))}\n# 指南\n\n第一步。\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), [], 'blob is the English: current');
  // Even in a shallow clone, a blob equal to the English is current.
  const shallow = mkdtempSync(join(tmpdir(), 'yokoten-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.root}`, shallow], { stdio: 'ignore' });
  assert.deepEqual(translationNotes(shallow, ['zh.md']), []);
  // A stale blob: the history decides. Changed together, current; the English later, behind.
  writeFileSync(join(repo.root, 'en.md'), '# Guide\n\nStep one, two.\n');
  writeFileSync(join(repo.root, 'zh.md'), `${blobMarker('en.md', 'b'.repeat(40))}\n# 指南\n\n第一步，第二步。\n`);
  repo.git('add', 'en.md', 'zh.md');
  repo.git('commit', '-q', '-m', 'both');
  assert.deepEqual(translationNotes(repo.root, ['zh.md']), [], 'a blob no commit had, changed with the English: current');
  repo.commit('en.md', '# Guide\n\nStep one, two, three.\n');
  const [note] = translationNotes(repo.root, ['zh.md']);
  assert.equal(note.what, 'is behind en.md by 1 commit');
  assert.ok(note.fix.includes(sourceMarker('en.md')), note.fix);
});

test('translations: check gives a note, and yokoten.json "translations": { "fail": true } a problem (#87)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  const notes: Finding[] = [];
  const problems = check(repo.root, { config: DEFAULTS, env: {}, notes });
  assert.deepEqual(problems, []);
  assert.deepEqual(notes.map((f) => f.id), ['translation-behind']);
  const strict = { ...DEFAULTS, translations: { fail: true } };
  assert.deepEqual(check(repo.root, { config: strict, env: {} }).map((f) => f.id), ['translation-behind']);
  writeFileSync(join(repo.root, 'yokoten.json'), '{ "translations": { "fail": true } }');
  assert.equal(loadConfig(repo.root).translations.fail, true);
});
