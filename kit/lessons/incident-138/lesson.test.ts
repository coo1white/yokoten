import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { findProblems, lesson } from './lesson.ts';

/** A throwaway repo with these files, by path. It is removed after the tests. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lesson-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

// The test in incident #138, cut down: a fake API on 127.0.0.1, called through fetch.
const FAKE_API = [
  "await new Promise((done) => server.listen(0, '127.0.0.1', done));",
  'const api = `http://127.0.0.1:${server.address().port}`;',
  'const token = await readToken({ api });',
  '',
].join('\n');
const SETS_NO_PROXY = "process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';\n";

// Positive control: the check must catch a known-bad case from the incident. This test
// fails until findProblems is written, so the draft never passes by itself.
test('incident-138: catches the known-bad case', () => {
  const knownBad = makeRepo({ 'test/bot.test.ts': FAKE_API });
  const found = findProblems(knownBad);
  assert.deepEqual(found.map((problem) => problem.id), [lesson.id]);
  assert.equal(found[0].what, `test/bot.test.ts: ${lesson.what}`, 'the finding names the file');
  // Other shapes of the same gap: a direct fetch to localhost, a helper in a test folder.
  const others = makeRepo({ 'src/api.spec.js': "await fetch('http://localhost:3000/health');\n", 'tests/helpers/server.mjs': "app.listen(8080, 'localhost');\n" });
  assert.deepEqual(findProblems(others).map((problem) => problem.what.split(':')[0]).sort(), ['src/api.spec.js', 'tests/helpers/server.mjs']);
});

test('incident-138: passes a good case', () => {
  const knownGood = makeRepo({
    // The fix from the incident: the test sets both spellings.
    'test/bot.test.ts': SETS_NO_PROXY + FAKE_API,
    // Not a test, others' code, a hidden folder, or a host that only starts with localhost.
    'src/client.ts': FAKE_API,
    'node_modules/some-package/test/a.test.js': FAKE_API,
    '.cache/b.test.js': FAKE_API,
    'test/c.test.ts': "await fetch('https://localhost.example.com/');\n",
  });
  assert.deepEqual(findProblems(knownGood), []);
  assert.deepEqual(findProblems(join(knownGood, 'no such folder')), [], 'a folder it can\'t read is not a problem');
});
