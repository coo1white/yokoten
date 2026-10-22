// Tests for src/run/translations.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTranslatedRepo, makeTempDir } from '../repo/helpers.ts';
import {
  DEFAULTS,
  loadConfig,
} from '../../src/rules/config.ts';
import type { Finding } from '../../src/rules/message.ts';
import { check } from '../../src/run/check/inspect.ts';
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
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md'], process.env), [], 'current: no note');
  const translated = repo.git('rev-parse', 'HEAD');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\n');
  repo.commit('en.md', '# Guide\n\nStep one.\nStep two.\nStep three.\n');
  const [note, ...rest] = translationNotes(repo.root, ['en.md', 'zh.md'], process.env);
  assert.deepEqual(rest, []);
  assert.equal(note.id, 'translation-behind');
  assert.equal(note.file, 'zh.md');
  assert.equal(note.line, 1);
  assert.equal(note.what, 'is behind en.md by 2 commits');
  assert.ok(note.fix.includes(`git diff ${translated.slice(0, 12)} HEAD -- en.md`), note.fix);
  // Brought up to date, line 1 unchanged: the note goes.
  repo.commit('zh.md', `${sourceMarker('en.md')}\n# 指南\n\n第一步。第二步。第三步。\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env), []);
  // An English edit not yet committed is behind; a translation edit with it is current.
  writeFileSync(join(repo.root, 'en.md'), '# Guide, edited\n');
  assert.equal(translationNotes(repo.root, ['zh.md'], process.env)[0]?.what, 'is behind en.md by edits not yet committed');
  writeFileSync(join(repo.root, 'zh.md'), `${sourceMarker('en.md')}\n# 指南（改）\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env), []);
});

test('translations: a missing source gives a clear note; a URL or an absolute path is not a marker (#87, #181)', () => {
  const repo = makeTranslatedRepo();
  writeFileSync(join(repo.root, 'gone.md'), `${sourceMarker('nowhere.md')}\n`);
  writeFileSync(join(repo.root, 'out.md'), `${sourceMarker('../en.md')}\n`);
  writeFileSync(join(repo.root, 'credit.md'), '<!-- source: https://example.com/post -->\n# A post\n');
  writeFileSync(join(repo.root, 'root.md'), `${sourceMarker(join(repo.root, 'en.md'))}\n`);
  const notes = translationNotes(repo.root, ['gone.md', 'out.md', 'credit.md', 'root.md'], process.env);
  assert.equal(notes.length, 2, notes.map((n) => n.file).join(', '));
  assert.match(notes[0].what, /names nowhere\.md as its English source, which is not in the repo/);
  assert.match(notes[1].what, /names \.\.\/en\.md as its English source, which is not in the repo/);
});

test('translations: a shallow clone gives one note for the run, never a note per file, never a problem (#87, #181)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  repo.commit('zh2.md', `${sourceMarker('en.md')}\n# 指南二\n`);
  const shallowClone = (depth: number) => {
    const dir = makeTempDir();
    execFileSync('git', ['clone', '-q', '--depth', String(depth), `file://${repo.root}`, dir], { stdio: 'ignore' });
    return dir;
  };
  // CI's default checkout: one commit, which seems to add every file, so neither can be told.
  // At depth 2, zh2.md was added on its own at HEAD, so it is current; zh.md still can't be told.
  for (const [depth, what] of [[1, "2 translations weren't checked: this clone is shallow"], [2, "1 translation wasn't checked: this clone is shallow"]] as const) {
    const shallow = shallowClone(depth);
    const notes = translationNotes(shallow, ['en.md', 'zh.md', 'zh2.md'], process.env);
    assert.equal(notes.length, 1, `depth ${depth}: ${notes.map((n) => n.what).join('; ')}`);
    assert.equal(notes[0].file, undefined, 'not about one file');
    assert.equal(notes[0].what, what);
    assert.match(notes[0].fix, /fetch-depth: 0/);
    // Even with "fail": a note, never a problem.
    const found: Finding[] = [];
    const problems = check(shallow, { config: { ...DEFAULTS, translations: { fail: true } }, env: {}, notes: found });
    assert.deepEqual(problems.filter((f) => f.id === 'translation-behind'), []);
    assert.deepEqual(found.map((f) => f.what), [what]);
  }
  // A translation edited in the work tree needs no history: no note.
  const shallow = shallowClone(1);
  writeFileSync(join(shallow, 'zh.md'), `${sourceMarker('en.md')}\n# 指南（改）\n`);
  assert.deepEqual(translationNotes(shallow, ['zh.md'], process.env), []);
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
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md'], process.env), [], 'both were translated: no note');
  // The English changes later, with no translation: a note, counted from history.
  repo.commit('en.md', english('Top, A.', 'Bottom, B, then C.'));
  const [note, ...rest] = translationNotes(repo.root, ['zh.md'], process.env);
  assert.deepEqual(rest, []);
  assert.equal(note.what, 'is behind en.md by 1 commit');
  assert.match(note.fix, /git diff [0-9a-f]{12} HEAD -- en\.md/);
  // The known cost, written in the guide: a typo fix to the translation counts as following.
  repo.commit('zh.md', translation('上，A。', '下，B！'));
  assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env), []);
});

test('translations: the older marker with a blob still works, and its fix offers the line that never changes (#166)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('zh.md', `${blobMarker('en.md', repo.git('hash-object', 'en.md'))}\n# 指南\n\n第一步。\n`);
  assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env), [], 'blob is the English: current');
  // Even in a shallow clone, a blob equal to the English is current.
  const shallow = makeTempDir();
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.root}`, shallow], { stdio: 'ignore' });
  assert.deepEqual(translationNotes(shallow, ['zh.md'], process.env), []);
  // A stale blob: the history decides. Changed together, current; the English later, behind.
  writeFileSync(join(repo.root, 'en.md'), '# Guide\n\nStep one, two.\n');
  writeFileSync(join(repo.root, 'zh.md'), `${blobMarker('en.md', 'b'.repeat(40))}\n# 指南\n\n第一步，第二步。\n`);
  repo.git('add', 'en.md', 'zh.md');
  repo.git('commit', '-q', '-m', 'both');
  assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env), [], 'a blob no commit had, changed with the English: current');
  repo.commit('en.md', '# Guide\n\nStep one, two, three.\n');
  const [note] = translationNotes(repo.root, ['zh.md'], process.env);
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

test('translations: a shallow clone deep enough to tell gives the answer, never a false current or behind (#181)', () => {
  const repo = makeTranslatedRepo();
  const shallowClone = (depth: number) => {
    const dir = makeTempDir();
    execFileSync('git', ['clone', '-q', '--depth', String(depth), `file://${repo.root}`, dir], { stdio: 'ignore' });
    return dir;
  };
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  repo.commit('zh.md', `${sourceMarker('en.md')}\n# 指南\n\n第一步，改了。\n`);
  // The translation-only commit is inside the clone: current, and no note for the run.
  assert.deepEqual(translationNotes(shallowClone(2), ['en.md', 'zh.md'], process.env), []);
  // An English-only commit before the cut: behind, as far as the clone can see.
  repo.commit('en.md', '# Guide\n\nStep one, changed again.\n');
  const notes = translationNotes(shallowClone(2), ['en.md', 'zh.md'], process.env);
  assert.deepEqual(notes.map((n) => [n.file, n.what]), [['zh.md', 'is behind en.md by at least 1 commit']]);
  // The whole history counts it exactly.
  assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env).map((n) => n.what), ['is behind en.md by 1 commit']);
});

test('translations: a pull request that changed only the English stays noted, whichever merges first (#181)', () => {
  const english = (top: string, bottom: string) => `# Guide\n\n${top}\n\nMiddle.\n\n${bottom}\n`;
  const translation = (top: string) => `${sourceMarker('en.md')}\n# 指南\n\n${top}\n\n中。\n\n下。\n`;
  // Branch a changes the top of both files; branch b changes only the bottom of the English.
  const setUp = () => {
    const repo = makeTranslatedRepo();
    const change = (files: Record<string, string>, message: string) => {
      for (const [path, text] of Object.entries(files)) writeFileSync(join(repo.root, path), text);
      repo.git('add', ...Object.keys(files));
      repo.git('commit', '-q', '-m', message);
    };
    change({ 'en.md': english('Top.', 'Bottom.'), 'zh.md': translation('上。') }, 'base');
    repo.git('checkout', '-q', '-b', 'a');
    change({ 'en.md': english('Top, A.', 'Bottom.'), 'zh.md': translation('上，A。') }, 'a');
    repo.git('checkout', '-q', '-b', 'b', 'main');
    change({ 'en.md': english('Top.', 'Bottom, B.') }, 'b');
    repo.git('checkout', '-q', 'main');
    return repo;
  };
  for (const order of [['b', 'a'], ['a', 'b']]) {
    for (const how of ['squash', 'merge']) {
      const repo = setUp();
      for (const branch of order) {
        if (how === 'squash') {
          repo.git('merge', '-q', '--squash', branch);
          repo.git('commit', '-q', '-m', `squash ${branch}`);
        } else repo.git('merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);
      }
      const label = `${how} ${order.join(' then ')}`;
      assert.equal(readFileSync(join(repo.root, 'en.md'), 'utf8'), english('Top, A.', 'Bottom, B.'), label);
      assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh.md'], process.env).map((n) => n.what), ['is behind en.md by 1 commit'], label);
      // Translated in a commit that changes only the translation: current.
      repo.commit('zh.md', `${sourceMarker('en.md')}\n# 指南\n\n上，A。\n\n中。\n\n下，B。\n`);
      assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env), [], label);
    }
  }
  // In the work tree, an edit to both files is like a commit that changes both: still behind.
  const repo = setUp();
  for (const branch of ['b', 'a']) {
    repo.git('merge', '-q', '--squash', branch);
    repo.git('commit', '-q', '-m', `squash ${branch}`);
  }
  writeFileSync(join(repo.root, 'en.md'), english('Top, A, again.', 'Bottom, B.'));
  writeFileSync(join(repo.root, 'zh.md'), translation('上，A，再改。'));
  assert.deepEqual(translationNotes(repo.root, ['zh.md'], process.env).map((n) => n.what), ['is behind en.md by 1 commit']);
});

test('translations: English-only commits before the translation was added, or moved, are not counted (#181)', () => {
  const repo = makeTranslatedRepo();
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  // Added (here, moved to a new path) in the same commit as an English change: current.
  repo.git('mv', 'zh.md', 'zh-CN.md');
  writeFileSync(join(repo.root, 'en.md'), '# Guide\n\nStep one, changed again.\n');
  writeFileSync(join(repo.root, 'zh-CN.md'), `${sourceMarker('en.md')}\n# 指南\n\n第一步，又改了。\n`);
  repo.git('add', 'en.md', 'zh-CN.md');
  repo.git('commit', '-q', '-m', 'move and translate');
  assert.deepEqual(translationNotes(repo.root, ['en.md', 'zh-CN.md'], process.env), []);
  repo.commit('en.md', '# Guide\n\nStep one, changed a third time.\n');
  assert.deepEqual(translationNotes(repo.root, ['zh-CN.md'], process.env).map((n) => n.what), ['is behind en.md by 1 commit']);
});

test('translations: git runs a fixed number of times, however many translations (#181)', { skip: process.platform === 'win32' && 'counts runs with a shell script on PATH' }, () => {
  const repo = makeTranslatedRepo();
  const files = ['en.md', 'zh.md'];
  for (let i = 0; i < 20; i += 1) {
    const file = `zh${i}.md`;
    writeFileSync(join(repo.root, file), `${sourceMarker('en.md')}\n# 指南 ${i}\n`);
    files.push(file);
  }
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'many translations');
  repo.commit('en.md', '# Guide\n\nStep one, changed.\n');
  // A git on PATH that counts its runs, then hands over to the real one.
  const bin = makeTempDir();
  const count = join(bin, 'count');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho x >> '${count}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const notes = translationNotes(repo.root, files, process.env);
    assert.equal(notes.length, 21);
  } finally {
    process.env.PATH = path;
  }
  const runs = readFileSync(count, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(runs <= 4, `${runs} git runs`);
});
