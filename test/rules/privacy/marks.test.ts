import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLinear } from '../../../scripts/linear.ts';
import { at, makeTempDir, post, postDir, WIDE } from '../../repo/helpers.ts';
import { describeMark, foldLine, foldText, hasMark, loadMarkKinds, mapMarkKinds } from '../../../src/rules/privacy/marks.ts';
import { makeRedactor, scanText } from '../../../src/rules/privacy/scan.ts';

// ---- A name mark matches whole words only (#434) ----
//
// Samples are built from pieces so this file passes its own check. All are made up.
const SHORT = ['s', 'am'].join('');
const FULL = [SHORT, ['exa', 'mple'].join('')].join(' ');
const NICK = ['ni', 'ck'].join('');
const JOINED = [SHORT, 'x'].join('');
const PAIR = [SHORT, ['sm', 'ith'].join('')].join(' ');
const DOMAIN = ['example', 'com'].join('.');

// ---- A mark is found in any Unicode form (#507) ----
//
// Made up, built from pieces. ACCENTED ends in é as one code point; DECOMPOSED is e plus U+0301.
const ACCENTED = ['vel', 'é'].join('');
const DECOMPOSED = ['vel', 'é'].join('');
// A capital dotted I, whose lowercase is i plus U+0307: two code units for one.
const DOTTED = ['İ', 'lvo'].join('');
const DOTLESS = ['ı', 'lvo'].join('');

// ---- The fold after the adversarial review (#507) ----

// A run of combining marks of mixed classes: a normalize of one long run grows with its square.
const MIXED_MARKS = (n: number) => `a${'̖́'.repeat(n / 2)}`;

test('private marks file: the kind of each added mark, by its header or, under the old header, by shape (#410)', () => {
  const dir = makeTempDir('yokoten-');
  const file = join(dir, 'marks');
  writeFileSync(file, `# mine\nMyCity\n# added by yokoten from this machine: forge login\nOcto-Jdoe\n# added by yokoten from this machine\njane${at}personal-mail.dev\nbuild.private-host.dev\nold-login\n# mine again\nmyserver\n`);
  assert.deepEqual(loadMarkKinds({ YOKOTEN_PRIVATE_MARKS: file }), [
    { value: 'mycity', kind: null },
    { value: 'octo-jdoe', kind: 'forge login' },
    { value: `jane${at}personal-mail.dev`, kind: 'git email' },
    { value: 'build.private-host.dev', kind: 'private remote host' },
    // A bare name under the old header is never taken for a login.
    { value: 'old-login', kind: null },
    { value: 'myserver', kind: null },
  ]);
});

test('private marks: an added forge login is fine only where a file names accounts (#410)', () => {
  const scan = (file: string, text: string, logins = ['octo-jdoe']) => scanText(text, { file, marks: ['octo-jdoe'], logins }).filter((f) => f.id === 'private-mark').map((f) => f.line);
  // CODEOWNERS owners and @ mentions in .github.
  assert.deepEqual(scan('CODEOWNERS', '* @octo-jdoe @octo-jdoe/team\n# octo-jdoe\n'), [2]);
  assert.deepEqual(scan('.github/ISSUE_TEMPLATE/bug.md', `cc @octo-jdoe.\nmail x${at}octo-jdoe.dev\n`), [2]);
  // Person fields of a manifest, nested ones too; not other keys, not a minified file.
  const manifest = '{\n  "author": {\n    "name": "octo-jdoe",\n    "url": "https://github.com/octo-jdoe"\n  },\n  "maintainers": ["octo-jdoe"],\n  "homepage": "https://octo-jdoe.dev"\n}\n';
  assert.deepEqual(scan('.claude-plugin/marketplace.json', manifest), [7]);
  assert.deepEqual(scan('package.json', '{"author": "octo-jdoe"}\n'), [1]);
  // The copyright line of a license, not its other lines.
  assert.deepEqual(scan('LICENSE.md', 'Copyright (c) 2026 octo-jdoe\nby octo-jdoe\n'), [2]);
  // Anywhere else, and for a mark the owner wrote, it is found.
  assert.deepEqual(scan('src/x.ts', '// @octo-jdoe\n'), [1]);
  assert.deepEqual(scan('docs/a.md', 'Copyright octo-jdoe\n'), [1]);
  assert.deepEqual(scan('CODEOWNERS', '* @octo-jdoe\n', []), [1]);
});

test('private marks: a name is found as a whole word, by the commit check and by redact (#390, #434)', () => {
  const hits = (text: string, mark: string) => scanText(text, { file: 'a', marks: [mark] }).length;
  assert.equal(hits('Ann wrote this', 'ann'), 1);
  assert.equal(hits('annotate the code', 'ann'), 0, 'a name inside a longer word is not the name');
  assert.equal(hits('see ann_notes', 'ann'), 1, 'but _ ends a word');
  const redact = makeRedactor({ marks: ['ann'] }, {});
  assert.equal(redact('Ann wrote this, then annotate'), '<mark> wrote this, then annotate');
});

test('hasMark: a name is found as whole words; only a letter blocks it (#434)', () => {
  const found = (text: string, mark: string) => hasMark(text, mark);
  // Caught: on its own, and beside anything that is not a letter, digits included.
  for (const text of [`hi ${'S'}am`, `${SHORT}_dev`, `@${SHORT}`, `S${'am'}.`, `${SHORT}-example`, `"${SHORT}"`, SHORT, `path/${SHORT}/x`, `${SHORT}1`, `${SHORT}2`]) assert.ok(found(text, SHORT), `not found in ${text}`);
  for (const text of [`${NICK}97`, `2${NICK}`]) assert.ok(found(text, NICK), `not found in ${text}`);
  // A small letter then a capital is an edge, in the text as it is: camelCase and PascalCase.
  for (const text of [`${'N'}ickDev`, `github${'N'}ick`]) assert.ok(found(text, NICK), `not found in ${text}`);
  // Not caught: inside a longer word.
  for (const text of [`${SHORT}ple`, `${SHORT}e`, `${SHORT}sung`, `bal${SHORT}ic`, `${NICK}dev`, `${NICK.toUpperCase()}DEV`]) assert.ok(!found(text, text.includes(SHORT) ? SHORT : NICK), `found in ${text}`);
  // An escape or a URL-encoded slash, backslash or space before or after it is an edge.
  for (const [text, mark] of [[`"hi\\n${FULL}"`, FULL], [`\\t${JOINED}`, JOINED], [`c%3a%5cusers%5c${JOINED}%5cdoc`, JOINED], [`C:%5CUsers%5C${JOINED}%5CDoc`, JOINED], [`hello%20${SHORT}`, SHORT], [`a%2f${SHORT}`, SHORT], [`\\u00e9${SHORT}`, SHORT], [`\\r${SHORT}\\b`, SHORT]] as const) {
    assert.ok(found(text, mark), `not found in ${text}`);
  }
  // Words of a longer mark: any run of spaces, -, _ or ., or none.
  for (const text of [`${SHORT}-example`, `${SHORT}  Example`, `${SHORT}_example`, `${SHORT}.example!`, `by ${SHORT} example.`, `${SHORT}example`]) assert.ok(found(text, FULL), `not found in ${text}`);
  assert.ok(found(`${SHORT}smith`, PAIR) && found(`S${'am'}_Smith`, PAIR));
  for (const text of [`${SHORT} examples`, `x${SHORT} example`]) assert.ok(!found(text, FULL), `found in ${text}`);
  // Any other character keeps the part match: a domain, an address, a number.
  assert.ok(found(`mail.${DOMAIN}`, DOMAIN));
  assert.ok(found('build1234x', '1234'));
  // Unicode letters are letters.
  assert.ok(found(`é ${SHORT}`, SHORT) && !found(`é${SHORT}`, SHORT));
  // A script that joins words or particles onto a name keeps the part match.
  const han = ['张', '三'].join('');
  assert.ok(found(`今天${han}来了`, han));
  const hangul = ['김', '민수'].join('');
  assert.ok(found(`${hangul}가`, hangul));
  const hebrew = ['ד', 'וד'].join('');
  assert.ok(found(`ה${hebrew}`, hebrew));
  const arabic = ['سا', 'مي'].join('');
  assert.ok(found(`وال${arabic}`, arabic));
});

test('hasMark: linear on long input (#434)', () => {
  const inputs: [string, (n: number) => string][] = [
    ['the first word, again and again', (n) => `${SHORT} `.repeat(n / 4)],
    ['the first word, then a long break', (n) => `${SHORT}${'-'.repeat(n)}x`],
    ['joined words, again and again', (n) => `${SHORT}`.repeat(n / 3)],
    ['small letters then capitals', (n) => 'aB'.repeat(n / 2)],
    ['escapes', (n) => '\\n'.repeat(n / 2)],
    ['letters only', (n) => 's'.repeat(n)],
  ];
  for (const [name, make] of inputs) assertLinear(name, make, (text) => hasMark(text, FULL));
  for (const [name, make] of inputs) assertLinear(`camel: ${name}`, make, (text) => hasMark(text, NICK));
  // The fold (#507): full-width letters, combining marks, zero-width characters.
  const folded: [string, (n: number) => string][] = [
    ['full-width letters', (n) => 'ｓ'.repeat(n)],
    ['decomposed letters', (n) => 'é'.repeat(n / 2)],
    ['one letter, many marks', (n) => `e${'́'.repeat(n)}`],
    ['zero-width between letters', (n) => 's\u200B'.repeat(n / 2)],
  ];
  for (const [name, make] of folded) assertLinear(`fold: ${name}`, make, (text) => hasMark(text, FULL));
  for (const [name, make] of folded) assertLinear(`fold, redact: ${name}`, make, makeRedactor({ marks: [FULL] }, {}));
});

test('hasMark and scanText: a mark is found in any Unicode form (#507)', () => {
  const found = (text: string, mark: string) => hasMark(text, mark.toLowerCase()) && scanText(text, { file: 'a.md', marks: [mark.toLowerCase()] }).length === 1;
  // Composed in the mark, decomposed in the text, and the other way round.
  assert.ok(found(`by ${DECOMPOSED}.`, ACCENTED) && found(`by ${ACCENTED}.`, DECOMPOSED));
  assert.ok(found(DECOMPOSED.toUpperCase(), ACCENTED));
  assert.ok(!found(`${DECOMPOSED}x`, ACCENTED), 'still whole words');
  // Full-width Latin, in the text or in the mark, either case.
  for (const text of [`by ${WIDE(SHORT)}.`, WIDE(SHORT.toUpperCase()), `${WIDE(SHORT)}＿${WIDE('example')}`]) assert.ok(found(text, SHORT), `not found in ${text}`);
  assert.ok(found(`by ${SHORT}.`, WIDE(SHORT)));
  assert.ok(found(`${WIDE(SHORT)} example`, FULL));
  assert.ok(!found(WIDE(`${SHORT}ple`), SHORT), 'still whole words');
  // A zero-width space, joiner, non-joiner or word joiner, inside a word or between words.
  for (const zero of ['\u200B', '\u200C', '\u200D', '\u2060']) {
    assert.ok(found(`hi s${zero}am`, SHORT), `U+${zero.codePointAt(0)!.toString(16)} inside`);
    assert.ok(found(`${SHORT}${zero}example`, FULL), `U+${zero.codePointAt(0)!.toString(16)} between`);
    assert.ok(found(`${zero}${SHORT}${zero}`, SHORT), `U+${zero.codePointAt(0)!.toString(16)} around`);
  }
  // A domain, found as a part, folds too.
  assert.ok(found(`mail.${WIDE(DOMAIN)}`, DOMAIN));
  // Turkish dotted and dotless I: both sides are lowercased the same way.
  for (const text of [DOTTED, `by ${DOTTED}.`, DOTTED.toUpperCase(), `${DOTTED.toLowerCase()}!`]) assert.ok(found(text, DOTTED), `not found in ${text}`);
  assert.ok(found(`by ${DOTLESS}.`, DOTLESS));
  assert.ok(!found(`${DOTTED}x`, DOTTED), 'still whole words');
  // A line with no mark is not stopped.
  assert.ok(!found(`by ${WIDE('other')} é`, SHORT));
});

test('the fold: a long run of mixed combining marks stays linear (#507)', () => {
  const redact = makeRedactor({ marks: [FULL] }, {});
  assertLinear('hasMark', MIXED_MARKS, (text) => hasMark(text, FULL), 1 << 12);
  assertLinear('scanText', MIXED_MARKS, (text) => scanText(text, { file: 'a.md', marks: [FULL] }), 1 << 12);
  assertLinear('redact', MIXED_MARKS, redact, 1 << 12);
  // The reviewer's input, through the guard: 240k characters, then the mark.
  const body = join(postDir, 'marks-run.md');
  writeFileSync(body, `${MIXED_MARKS(240_000)}\nQuietVale\n`);
  const start = performance.now();
  assert.equal(post(`gh issue create --title t --body-file ${body}`)?.id, 'private-mark');
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms for 240k characters`);
  rmSync(body);
});

test('the fold: the fast fold of the check gives the same text as the fold of redact (#507)', () => {
  const pieces = ['a', 'é', '̖', '́', '\u200B', 'ｓ', 'ᄀ', 'ᅡ', 'ᆫ', 'ｶ', '\uFF9E', '你', '，', 'İ', '𝅥', 'x', ' '];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let round = 0; round < 500; round++) {
    let text = '';
    for (let i = next() % 80; i > 0; i--) text += pieces[next() % pieces.length];
    assert.equal(foldLine(text).text, foldText(text).text, JSON.stringify(text));
  }
  for (const text of [MIXED_MARKS(100), `x${'́'.repeat(31)}y`, '́'.repeat(62)]) assert.equal(foldLine(text).text, foldText(text).text);
});

test('the fold: what the check found before the fold, it still finds (#507)', () => {
  const part = `${SHORT}_1a`;
  const hangul = String.fromCharCode(0xc11c, 0xc544);
  const cases: [string, string][] = [
    // A zero-width character next to a name is an edge, as before.
    [`x\u200B${SHORT} y`, SHORT],
    [`ab\u200B${FULL}`, FULL],
    [`${SHORT}\u200B́`, SHORT],
    // An accent or a final consonant on the last letter of a mark found as a part.
    [`${part}́`, part],
    [`user ${part}á x`, part],
    [`${hangul}ᆫ`, hangul],
    [String.fromCharCode(0xc11c, 0xc548), hangul],
  ];
  for (const [text, mark] of cases) {
    assert.ok(hasMark(text, mark), `hasMark: ${JSON.stringify(text)}`);
    assert.equal(scanText(text, { file: 'a.md', marks: [mark] }).length, 1, `scanText: ${JSON.stringify(text)}`);
    assert.notEqual(makeRedactor({ marks: [mark] }, {})(text), text, `redact: ${JSON.stringify(text)}`);
  }
  // Still whole words: a letter with an accent after a name blocks it.
  assert.ok(!hasMark(`${SHORT.slice(0, 2)}ḿ`, SHORT));
});

test('the fold: a mark of only zero-width characters is no mark, and the longest folded mark goes first (#507)', () => {
  assert.equal(hasMark('nothing here', '\u200B'), false);
  assert.deepEqual(scanText('nothing here', { file: 'a.md', marks: ['\u200B\u200D'] }), []);
  assert.equal(makeRedactor({ marks: ['\u200B\u200B\u200B', DOMAIN] }, {})(`by me at ${DOMAIN} ok`), 'by me at <host> ok');
  assert.equal(makeRedactor({ marks: [`${SHORT}${'\u200B'.repeat(5)}`, FULL] }, {})(`by ${FULL} ok`), 'by <mark> ok');
});

test('scanText: a private-mark finding names the kind of mark, never the value (#523)', () => {
  const name = ['Rue', 'Sample'].join(' ');
  const email = `ruex${at}personal-mail.dev`;
  const text = [`by ${name}`, `mail ${email}`, 'ask @octo-ruex', 'see build.rue-host.dev', 'from QuietVale'].join('\n');
  const marks = [
    { value: name.toLowerCase(), kind: 'git name' },
    { value: email, kind: 'git email' },
    { value: 'octo-ruex', kind: 'forge login' },
    { value: 'build.rue-host.dev', kind: 'private remote host' },
    { value: 'quietvale', kind: null },
  ];
  const found = scanText(text, { file: 'a.md', marks: marks.map((mark) => mark.value), kinds: mapMarkKinds(marks) }).filter((hit) => hit.id === 'private-mark');
  assert.deepEqual(
    found.map((hit) => [hit.line, hit.what]),
    [
      [1, 'matches your git name (a private mark yokoten added by itself)'],
      [2, 'matches your git email (a private mark yokoten added by itself)'],
      [3, 'matches your forge login (a private mark yokoten added by itself)'],
      [4, 'matches the name of a private server in your git remotes (a private mark yokoten added by itself)'],
      [5, 'matches a word you added to your private marks'],
    ],
  );
  // The fix says how to change it: turn a kind off, take the mark out, or allow it here.
  assert.match(found[0].fix, /`yokoten marks off git-name`/);
  assert.match(found[1].fix, /`yokoten marks off git-email`/);
  assert.match(found[2].fix, /`yokoten marks off forge-login`/);
  assert.match(found[3].fix, /`yokoten marks allow <mark> --here`/);
  assert.match(found[4].fix, /`yokoten marks allow <mark> --here`[^]*`yokoten marks remove`/);
  const said = JSON.stringify(found).toLowerCase();
  for (const mark of marks) assert.ok(!said.includes(mark.value), 'a finding holds a mark');
  for (const part of ['sample', 'personal-mail', 'octo-ruex', 'rue-host', 'quietvale']) assert.ok(!said.includes(part), `a finding holds ${part.length} letters of a mark`);
  // With no kinds, as before: the line of the file.
  assert.equal(scanText('from QuietVale', { file: 'a.md', marks: ['quietvale'] })[0].what, 'matches a line of your private-marks file');
  assert.equal(describeMark('some new kind').what, 'matches your some new kind (a private mark yokoten added by itself)');
});

test('scanText: a name mark stops a line with the word, not one with a longer word (#434)', () => {
  const ids = (text: string) => scanText(text, { file: 'a.md', marks: [SHORT, FULL] }).map((f) => f.line);
  // Line 5 holds both marks, so it is found once for each.
  assert.deepEqual(ids(`a ${SHORT}ple\nthe ${SHORT}e\nhi ${SHORT}\n${SHORT}_dev\nby ${SHORT}--example\n`), [3, 4, 5, 5]);
});

test('makeRedactor: hides a name by the same rules as the check (#434)', () => {
  const redact = makeRedactor({ owners: [FULL], marks: [JOINED] }, {});
  for (const text of [`S${'am'}_Example`, `${SHORT}.example`, `S${'am'}Example`]) assert.equal(redact(`by ${text}.`), 'by <owner>.', text);
  assert.equal(redact(`S${'am'}X97`), '<mark>97');
  assert.equal(redact(`C:%5C${JOINED}`), 'C:%5C<mark>');
  // A longer word stays, as in the check.
  assert.equal(redact(`${JOINED}ylophone`), `${JOINED}ylophone`);
  for (const text of [`by ${'S'}am_Example`, `S${'am'}X97`, `%5C${JOINED}`, `${JOINED}ylophone`]) {
    assert.equal(redact(text) === text, !scanText(text, { file: 'a', marks: [FULL, JOINED] }).length, `redact and the check disagree on ${text}`);
  }
});

test('makeRedactor: hides a mark in any Unicode form, and keeps the rest of the line as it was (#507)', () => {
  const redact = makeRedactor({ owners: [FULL], marks: [ACCENTED, DOTTED.toLowerCase(), SHORT] }, {});
  // The lowercase of each İ before a mark is two code units: the place to cut must still be right.
  assert.equal(redact(`İİ ${DOTTED}, ${DOTTED.toUpperCase()} and ${DOTTED}\n`), 'İİ <mark>, <mark> and <mark>\n');
  assert.equal(redact(`café by ${DECOMPOSED}, é ${ACCENTED}.`), 'café by <mark>, é <mark>.');
  assert.equal(redact(`！ by ${WIDE(SHORT)} ！`), '！ by <mark> ！');
  assert.equal(redact(`！ ${WIDE(SHORT)}\u200B${WIDE('example')}!`), '！ <owner>!');
  assert.equal(redact(`by s\u200Bam, \u200B and s\u200Dam.`), 'by <mark>, \u200B and <mark>.');
  assert.equal(redact(`${WIDE(SHORT)}ple é`), `${WIDE(SHORT)}ple é`, 'a longer word stays');
  // The check and redact agree.
  for (const text of [`by ${DECOMPOSED}`, WIDE(SHORT), `s\u200Bam`, DOTTED.toUpperCase(), `${WIDE(SHORT)}ple`, `${DOTTED}x`]) {
    assert.equal(redact(text) === text, !scanText(text, { file: 'a', marks: [FULL, ACCENTED, DOTTED.toLowerCase(), SHORT] }).length, `redact and the check disagree on ${text}`);
  }
});

