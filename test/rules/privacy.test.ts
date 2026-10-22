// Tests for src/rules/privacy.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLinear, assertLinearEach } from '../../scripts/linear.ts';
import { at, makeRepoTemplate, makeTempDir } from '../repo/helpers.ts';
import { DEFAULTS, type Env } from '../../src/rules/config.ts';
import { checkCommand } from '../../src/rules/guards.ts';
import { formatFinding } from '../../src/rules/message.ts';
import {
  describeMark,
  foldLine,
  foldText,
  hasMark,
  isBotProgram,
  hideHome,
  homeIn,
  loadMarkKinds,
  loadMarks,
  lonePost,
  machineAllowed,
  machineAllowFile,
  makeRedactor,
  marksFile,
  marksFiles,
  mapMarkKinds,
  normalizeRemote,
  notUtc,
  ownMarks,
  POSITIVE_CONTROL,
  privateRemoteHosts,
  readMachineAllow,
  repoKey,
  repoMarkKinds,
  scanText,
  withHome,
} from '../../src/rules/privacy.ts';

// Samples are built from pieces so this file passes its own check.
const ip = (...n: number[]) => n.join('.');

test('withHome: only the CLI entry falls back to the system home, and only when HOME is not a full path (#356)', () => {
  const system = () => '/home/someone';
  assert.deepEqual(withHome({ HOME: '/h', X: '1' }, system), { HOME: '/h', X: '1' });
  assert.deepEqual(withHome({ X: '1' }, system), { HOME: '/home/someone', X: '1' });
  assert.deepEqual(withHome({ HOME: 'relative' }, system), { HOME: '/home/someone' });
  assert.deepEqual(withHome({ HOME: '' }, () => 'also/relative'), { HOME: '' }, 'no full path anywhere: no home');
  const env: Env = { PATH: '/bin' };
  withHome(env, system);
  assert.deepEqual(env, { PATH: '/bin' }, 'the env it is given stays as it was');
  assert.equal(homeIn({ HOME: '/h' }), '/h');
  assert.throws(() => homeIn({}), /no home folder/, 'no fallback outside the CLI entry');
});

test('positive control: the known-bad sample is caught', () => {
  assert.equal(scanText(POSITIVE_CONTROL, { file: 'x' }).length, 2);
});

test('emails: personal ones are caught, noreply and examples are fine', () => {
  assert.equal(scanText(`me${at}gmail.com`, { file: 'a' }).length, 1);
  assert.match(formatFinding(scanText(`x\nmail me${at}mydomain.dev`, { file: 'a.md' })[0]), /^a\.md:2: an email/);
  for (const ok of [`1+me${at}users.noreply.github.com`, `noreply${at}anthropic.com`, `you${at}example.com`, `a${at}host.test`]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  assert.deepEqual(scanText(`help${at}company.com`, { file: 'a', allow: [`help${at}company.com`] }), []);
});

test('emails: the fix names privacy.allow for a project\'s own public address, and the address is still found (#380)', () => {
  const address = `support${at}myproject.dev`;
  const found = scanText(`write to ${address}`, { file: 'SECURITY.md' });
  assert.equal(found.length, 1, 'nothing is allowed on its own');
  assert.equal(found[0].id, 'email');
  const text = formatFinding(found[0]);
  assert.match(text, /noreply address, or a placeholder at example\.com\. If it is your project's own public address, such as support@ at its domain, add it to "privacy\.allow" in yokoten\.json\.\n/);
  assert.match(text, /\n {2}docs: https:\/\/github\.com\/yokoten-labs\/yokoten\/blob\/main\/docs\/guide\.md#privacy$/);
  assert.ok(!text.includes(address), 'the address itself is never printed');
  // A post names privacy.allow once, not twice.
  const home = makeTempDir('yokoten-380-');
  const posted = formatFinding(checkCommand(`gh issue create --title "check: a" --body "${address}"`, { env: { HOME: home }, config: DEFAULTS, cwd: home })!);
  assert.equal(posted.split('privacy.allow').length, 2, posted);
});

test('emails: role addresses, forge SSH remotes and .local point at no person (#11)', () => {
  for (const ok of [
    `contact support${at}github.com`,
    `security${at}gitlab.com`,
    `remote: git${at}gitlab.com:owner/repo.git`,
    `git clone git${at}github.com:owner/repo`,
    `Git${at}GitHub.com:owner/repo`,
    `conf${at}test.local`,
    `1-me${at}users.noreply.gitlab.com`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Still caught: a person at the same domains, and an SSH remote that names a private host.
  for (const bad of [`someone${at}gmail.com`, `someone${at}github.com`, `git${at}code.my-company.dev:team/app.git`, `git${at}github.com.my-company.dev:t/a`, `git${at}mygithub.com:t/a`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
});

test('IPs: real ones are caught, documentation ranges and versions are not', () => {
  for (const bad of [ip(100, 64, 1, 2), ip(10, 0, 0, 5), ip(8, 8, 8, 8), `host=${ip(203, 0, 114, 9)}:22`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
  for (const ok of [ip(127, 0, 0, 1), ip(192, 0, 2, 10), ip(198, 51, 100, 1), ip(0, 0, 0, 0), ip(999, 1, 1, 1), 'v1.2.3', '1.2.3.4.5']) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
});

test('IPs: spec section numbers and versions are not addresses (#382)', () => {
  const quad = ip(2, 3, 4, 2);
  for (const ok of [
    `§${ip(1, 2, 3, 4)}`,
    `see § ${ip(1, 2, 3, 4)}`,
    `section ${ip(4, 2, 1, 3)}`,
    `Section ${ip(4, 2, 1, 3)} says`,
    `sec. ${ip(4, 2, 1, 3)}`,
    `RFC 7230 ${ip(3, 2, 6, 1)}`,
    `RFC7230, ${ip(3, 2, 6, 1)}`,
    `v${ip(1, 2, 3, 4)}`,
    `v ${ip(1, 2, 3, 4)}`,
    `version ${ip(1, 2, 3, 4)}`,
    `${ip(1, 2, 3, 4)}-beta`,
    `${ip(1, 2, 3, 4)}+build.5`,
    `//! The decompressed dir stream, MS-OVBA ${quad}: project information,`,
    `/// The dir stream (MS-OVBA ${quad}) does not follow the format.`,
    `see [MS-XLS] ${quad}`,
    `ECMA-376 ${quad}`,
    `ISO 32000-1 ${quad}`,
    `ISO/IEC 29500 ${quad}`,
    `/// (MS-OVBA ${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 17)}). This reports what`,
    `${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 17)}`,
    `${ip(2, 3, 1, 15)} through ${ip(2, 3, 1, 17)}`,
    `MS-OVBA ${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 17)}`,
    `section ${ip(12, 3, 1, 15)} to ${ip(12, 3, 1, 70)}`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Real addresses in prose, private ranges included, are still caught.
  for (const bad of [
    `connect to ${ip(8, 8, 8, 8)}`,
    `connect to ${ip(203, 0, 114, 9)} now`,
    `host ${ip(10, 0, 0, 5)}`,
    `gateway ${ip(192, 168, 1, 1)}`,
    `server ${ip(172, 16, 0, 9)}`,
    `${ip(10, 0, 0, 5)}-${ip(10, 0, 0, 9)}`,
    `pool ${ip(10, 0, 0, 1)} to ${ip(10, 0, 0, 9)}`,
    `${ip(192, 168, 1, 100)} through ${ip(192, 168, 1, 200)}`,
    // A bare range of public addresses is caught: only small section-shaped numbers are skipped.
    `${ip(203, 0, 114, 5)} to ${ip(203, 0, 114, 9)}`,
    `${ip(10, 0, 0, 1)} to ${ip(10, 0, 0, 9)}`,
    `${ip(8, 8, 8, 8)} to ${ip(8, 8, 8, 9)}`,
    `${ip(1, 1, 1, 1)} through ${ip(1, 1, 1, 3)}`,
    `${ip(2, 3, 1, 15)} to ${ip(2, 3, 2, 17)}`,
    `${ip(2, 3, 1, 15)} to ${ip(2, 3, 1, 99)}`,
    `dev ${ip(8, 8, 8, 8)}`,
    `insect. ${ip(8, 8, 8, 8)}`,
    `${ip(8, 8, 8, 8)}:53`,
  ]) {
    assert.ok(scanText(bad, { file: 'a' }).length >= 1, bad);
  }
  // Localhost is still fine, as before.
  assert.deepEqual(scanText(`connect to ${ip(127, 0, 0, 1)}`, { file: 'a' }), []);
});

test('web strings: retina image names and user agents are not private (#245)', () => {
  const ua = `Mozilla/5.0 (Windows NT 10.0) Chrome/${ip(120, 0, 0, 0)} Safari/537.36`;
  for (const ok of [`url("img/logo${at}2x.png")`, `icons/close${at}3x.webp`, `a${at}2X.JPEG b${at}10x.avif`, ua]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // A real address on the same line is still caught.
  const email = `someone${at}gmail.com`;
  assert.deepEqual(scanText(`url("img/logo${at}2x.png") ${email}`, { file: 'a' }).map((f) => f.id), ['email']);
  assert.deepEqual(scanText(`${ua} from ${ip(10, 0, 0, 5)}`, { file: 'a' }).map((f) => f.id), ['ip']);
  // Only a browser version is skipped: a URL or a path root still names the host.
  for (const bad of [`http://${ip(10, 0, 0, 5)}`, `https://${ip(8, 8, 8, 8)}/x`, `ssh:/${ip(8, 8, 8, 8)}`, `/${ip(8, 8, 8, 8)}`, `${ua} http://${ip(100, 64, 1, 2)}:8080`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
  // An address in a path is real, even after a letter and `/`; only browser versions are skipped.
  for (const bad of [`api/${ip(8, 8, 8, 8)}`, `hosts/${ip(10, 0, 0, 5)}`, `servers/${ip(192, 168, 1, 20)}`, `chrome/${ip(8, 8, 8, 8)}`, `MyChrome/${ip(8, 8, 8, 8)}`]) {
    assert.equal(scanText(bad, { file: 'a' }).length, 1, bad);
  }
  for (const ok of [`Chrome/${ip(120, 0, 0, 0)}`, 'Edg/120.0.2210.91', `Firefox/${ip(121, 0, 1, 2)}`]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Not an image: still an email address.
  assert.equal(scanText(`me${at}2x.dev`, { file: 'a' }).length, 1);
});

test('private marks: matched without case, never echoed', () => {
  const problems = scanText('Deploy to Secret-Box tonight', { file: 'a', marks: ['secret-box'] });
  assert.equal(problems.length, 1);
  assert.ok(!/secret-box/i.test(JSON.stringify(problems)), 'the mark must not appear in the output');
});

test('private marks file: comments and blanks skipped, missing file is empty', () => {
  const dir = makeTempDir();
  const file = join(dir, 'marks');
  writeFileSync(file, '# header\n\nMyCity\n  myserver  \n');
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: file }), ['mycity', 'myserver']);
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: join(dir, 'none') }), []);
});

test('private marks file: the setting adds a second list to the default file, never replaces it (#656)', () => {
  const home = makeTempDir();
  const config = join(home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  const own = join(config, 'private-marks');
  writeFileSync(own, '# added by yokoten from this machine: forge login\nOcto-Jdoe\nMyCity');
  const extra = join(home, 'extra');
  writeFileSync(extra, 'myserver\nmycity\n');
  const empty = join(home, 'empty');
  writeFileSync(empty, '');
  assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: empty }), ['octo-jdoe', 'mycity']);
  assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), ['octo-jdoe', 'mycity', 'myserver']);
  assert.deepEqual(loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: join(home, 'none') }), ['octo-jdoe', 'mycity']);
  // A header in one file never names the kind of a line in the next.
  assert.deepEqual(loadMarkKinds({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), [
    { value: 'octo-jdoe', kind: 'forge login' },
    { value: 'mycity', kind: 'forge login' },
    { value: 'myserver', kind: null },
  ]);
  // yokoten writes to the default file, and the setting names the same file only once.
  assert.equal(marksFile({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), own);
  assert.deepEqual(marksFiles({ HOME: home, YOKOTEN_PRIVATE_MARKS: own }), [own]);
});

test('private marks file: a default file that can not be read throws, whatever the setting names (#656)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const home = makeTempDir();
  const config = join(home, '.config', 'yokoten');
  mkdirSync(config, { recursive: true });
  const own = join(config, 'private-marks');
  writeFileSync(own, 'mycity\n');
  chmodSync(own, 0o000);
  const extra = join(home, 'extra');
  writeFileSync(extra, 'myserver\n');
  try {
    assert.throws(() => loadMarks({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), { code: 'EACCES' });
    assert.throws(() => loadMarkKinds({ HOME: home, YOKOTEN_PRIVATE_MARKS: extra }), { code: 'EACCES' });
  } finally {
    chmodSync(own, 0o600);
  }
});

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

test('commit times: an ident with a non-UTC offset is caught (#40)', () => {
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 +0700`), true);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 -0500`), true);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 +0000`), false);
  assert.equal(notUtc(`A <a${at}example.com> 1760745600 -0000`), false);
  assert.equal(notUtc('no time here'), false);
});

test('output: the home folder shows as ~ (#25)', () => {
  assert.equal(hideHome('wrote /home/someone/.local/share/yokoten', { HOME: '/home/someone' }), 'wrote ~/.local/share/yokoten');
  assert.equal(hideHome('a /home/someone/ b /home/someone', { HOME: '/home/someone/' }), 'a ~/ b ~');
  assert.equal(hideHome('/x', { HOME: '/' }), '/x', 'a root home hides nothing');
  const real = makeTempDir('yokoten-home-');
  const link = `${real}-link`;
  symlinkSync(real, link);
  try {
    assert.equal(hideHome(`ran in ${realpathSync(real)}/away`, { HOME: link }), 'ran in ~/away', 'the real path of a linked home is hidden too');
  } finally {
    rmSync(link);
    rmSync(real, { recursive: true });
  }
});

test('output: a home path is hidden only where it ends (#205)', () => {
  const env = { HOME: '/data/u' };
  assert.equal(hideHome('a /data/u/x and /data/users/y', env), 'a ~/x and /data/users/y', 'a longer folder name is kept');
  assert.equal(hideHome('in /data/u. Then "/data/u", /data/u:/bin', env), 'in ~. Then "~", ~:/bin');
  assert.equal(hideHome('/data/u.bak and /data/u-old', env), '/data/u.bak and /data/u-old');
  const short = { HOME: '/h' };
  assert.equal(hideHome('see https://h.example/h and https://h/x', short), 'see https://h.example/h and https://h/x', 'a short home never garbles a URL');
  assert.equal(hideHome('/h', short), '~', 'the home alone is ~');
  assert.equal(hideHome('/x and /', { HOME: '/' }), '/x and /', 'a root home hides nothing');
});

test('output: both homes are hidden when HOME and the system home differ (#205)', () => {
  const options = { systemHome: '/home/u' };
  assert.equal(hideHome('a /tmp/x/f b /home/u/g', { HOME: '/tmp/x' }, options), 'a ~/f b ~/g');
  // Longest first: a home inside the other is replaced whole.
  assert.equal(hideHome('at /home/u/inner/f', { HOME: '/home/u/inner' }, options), 'at ~/f');
  assert.equal(hideHome('/home/u/g', { HOME: '/' }, options), '~/g', 'a root HOME still hides the system home');
});

test('output: a Windows home is hidden with either slash, any case, and in MSYS form (#205)', () => {
  const options = { platform: 'win32', systemHome: 'C:\\Users\\me' };
  assert.equal(hideHome('C:\\Users\\me\\a, c:/users/ME/b, /c/Users/me/c', {}, options), '~\\a, ~/b, ~/c');
  assert.equal(hideHome('C:\\Users\\meg\\a', {}, options), 'C:\\Users\\meg\\a');
  assert.equal(hideHome('/C/USERS/me', {}, { ...options, platform: 'linux' }), '/C/USERS/me', 'case counts off Windows');
});

test('output: a home path cut short at the end of a line is hidden (#404)', () => {
  const options = { systemHome: '/home/jonathan' };
  assert.equal(hideHome('see /home/jona\nsee /home/jonat', {}, options), 'see ~\nsee ~');
  assert.equal(hideHome('see /home/jonath\r\nnext', {}, options), 'see ~\r\nnext');
  // Fewer than 4 characters of the name, or a cut path inside a line, stays.
  assert.equal(hideHome('see /home/jon\nat /home/jona and on', {}, options), 'see /home/jon\nat /home/jona and on');
  assert.equal(hideHome('/home/jonas', {}, options), '/home/jonas', 'a longer name is another folder');
  // A cut that ends in an ellipsis or spaces is cut too.
  assert.equal(hideHome('a /home/jona…\nb /home/jonat...\nc /home/jonath  \nd /home/jon...', {}, options), 'a ~…\nb ~...\nc ~  \nd /home/jon...');
});

test('output: a home written in a URL, with %2F or %5C for its slashes, is hidden (#404)', () => {
  const options = { systemHome: '/home/jdoe' };
  assert.equal(hideHome('a %2Fhome%2Fjdoe%2Fx b %2fhome%2fjdoe', {}, options), 'a ~%2Fx b ~');
  assert.equal(hideHome('%2Fhome%2Fjdoex and x%2Fhome%2Fjdoe%2F', {}, options), '%2Fhome%2Fjdoex and x%2Fhome%2Fjdoe%2F', 'another folder stays');
});

// ---- Hiding the owner in command output (#390) ----

test('makeRedactor: patterns only, with no marks: private emails go, noreply and team ones stay', () => {
  const redact = makeRedactor({}, { HOME: '/home/someone' });
  assert.equal(redact(`by jane${at}personal-mail.dev and 1+jane${at}users.noreply.github.com\n`), `by <email> and 1+jane${at}users.noreply.github.com\n`);
  assert.equal(redact(`git${at}github.com:o/r and git${at}build.private-host.dev:o/r`), `git${at}github.com:o/r and git${at}<host>:o/r`);
  assert.equal(redact('at /home/someone/project'), 'at ~/project');
});

test('makeRedactor: owners, hosts and marks, by shape, case-insensitive, whole words only', () => {
  const redact = makeRedactor({ owners: ['Jane Example'], hosts: ['build.private-host.dev'], marks: ['jane example', 'fakeville', 'janex.dev', `me${at}janex.dev`, 'ann', 'xy', '東京'] }, {});
  assert.equal(redact('JANE EXAMPLE in Fakeville'), '<owner> in <mark>');
  assert.equal(redact('https://build.private-host.dev/x and www.janex.dev'), 'https://<host>/x and www.<host>');
  assert.equal(redact(`mail me${at}janex.dev`), 'mail <email>');
  // Inside a longer word it stays; two letters are too short to hide.
  assert.equal(redact('annual ann xy'), 'annual <mark> xy');
  assert.equal(redact('住在東京都'), '住在<mark>都');
  assert.equal(redact('line\r\nnext\n'), 'line\r\nnext\n');
});

test('makeRedactor: the home goes before the names, so /home/<name>/x becomes ~/x (#404)', () => {
  const redact = makeRedactor({ owners: ['jdoe'] }, { HOME: '/home/jdoe' });
  assert.equal(redact('at /home/jdoe/x\n'), 'at ~/x\n');
  assert.equal(redact('/mnt/c/Users/jdoe/x, C:\\Users\\jdoe\\x, "C:\\\\Users\\\\jdoe", jdoe'), '/mnt/c/Users/<owner>/x, C:\\Users\\<owner>\\x, "C:\\\\Users\\\\<owner>", <owner>');
  assert.equal(redact('jdoes and xjdoe stay'), 'jdoes and xjdoe stay', 'a longer word that holds the name is kept');
  assert.equal(redact('\\\\wsl$\\Ubuntu\\home\\jdoe\\x and /Users/jdoe/y'), '\\\\wsl$\\Ubuntu\\home\\<owner>\\x and /Users/<owner>/y');
});

test('makeRedactor: a name next to a URL-encoded slash, backslash or space is hidden (#404)', () => {
  const redact = makeRedactor({ owners: ['jdoe', 'JaneD'] }, {});
  assert.equal(redact('C:%5CUsers%5CJaneD%5Cx and c:%5cusers%5cjaned'), 'C:%5CUsers%5C<owner>%5Cx and c:%5cusers%5c<owner>');
  assert.equal(redact('%2Fsrv%2Fjdoe%2Fx, %20jdoe%20'), '%2Fsrv%2F<owner>%2Fx, %20<owner>%20');
  assert.equal(redact('vscode-remote://wsl%2Bubuntu/home/jdoe/x and vscode-remote://wsl%2Bubuntu%2Fhome%2Fjdoe%2Fx'), 'vscode-remote://wsl%2Bubuntu/home/<owner>/x and vscode-remote://wsl%2Bubuntu%2Fhome%2F<owner>%2Fx');
  assert.equal(redact('%2Fjdoes and %2Fxjdoe stay'), '%2Fjdoes and %2Fxjdoe stay');
});

test('privateRemoteHosts: hosts outside the public forges; local paths name none', () => {
  assert.deepEqual(
    privateRemoteHosts(['https://github.com/o/r.git', `git${at}gitlab.com:o/r.git`, `ssh://git${at}Build.Private-Host.dev:2222/o/r.git`, `git${at}gitea.home.dev:o/r`, `https://user${at}code.corp.dev/o/r`, '/srv/git/r.git', '../r', 'C:\\repos\\r', 'file:///srv/r', '']),
    ['build.private-host.dev', 'gitea.home.dev', 'code.corp.dev'],
  );
});

test('private marks: a name is found as a whole word, by the commit check and by redact (#390, #434)', () => {
  const hits = (text: string, mark: string) => scanText(text, { file: 'a', marks: [mark] }).length;
  assert.equal(hits('Ann wrote this', 'ann'), 1);
  assert.equal(hits('annotate the code', 'ann'), 0, 'a name inside a longer word is not the name');
  assert.equal(hits('see ann_notes', 'ann'), 1, 'but _ ends a word');
  const redact = makeRedactor({ marks: ['ann'] }, {});
  assert.equal(redact('Ann wrote this, then annotate'), '<mark> wrote this, then annotate');
});

test('makeRedactor: secrets become <secret>, a private key line by line, across pieces (#390)', () => {
  const token = `${'gh'}p_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  const redact = makeRedactor({}, {});
  assert.equal(redact(`token: ${token} ok\n`), 'token: <secret> ok\n');
  assert.equal(redact('AKIAIOSFODNN7EXAMPLE is the docs sample\n'), 'AKIAIOSFODNN7EXAMPLE is the docs sample\n');
  // A key that starts in one piece and ends in the next is hidden whole.
  assert.equal(redact(`-----BEGIN RSA ${'PRIVATE'} KEY-----\r\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn\n`), '<secret>\r\n<secret>\n');
  assert.equal(redact(`abcdEFGHijklMNOPqrst\n-----END RSA ${'PRIVATE'} KEY-----\nafter\n`), '<secret>\n<secret>\nafter\n');
  // Code that names the header is not a key.
  assert.equal(redact(`if (text.includes('-----BEGIN RSA ${'PRIVATE'} KEY-----')) x\nnext\n`), `if (text.includes('-----BEGIN RSA ${'PRIVATE'} KEY-----')) x\nnext\n`);
});

// ---- Text an agent posts (#391): the guard runs the privacy check on it ----

// A sandbox: its own HOME, a marks file, and a folder for body files. The samples are
// built from pieces so this file does not fail its own commit check.
const postDir = makeTempDir('yokoten-posts-');
const postMarks = join(postDir, 'private-marks');
writeFileSync(postMarks, '# my marks\nquietvale\n');
const postEnv: Env = { HOME: postDir, YOKOTEN_PRIVATE_MARKS: postMarks };
const email = `someone${'@'}personal-mail.com`;
const token = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;

const post = (command: string, config: typeof DEFAULTS = DEFAULTS) => checkCommand(command, { env: postEnv, config, cwd: postDir });

test('an inline --body with an email address is stopped, with the same fix as the commit check', () => {
  const f = post(`gh issue create --title "check: fix a bug" --body "write to ${email}"`);
  assert.equal(f?.id, 'email');
  assert.equal(f?.what, 'the --body text holds an email address');
  const text = formatFinding(f);
  assert.match(text, /a post is public the moment it is sent/);
  assert.match(text, /noreply address/);
  assert.match(text, /privacy\.allow/);
  assert.ok(!text.includes(email), 'the address itself is never printed');
});

test('the other text options and their forms are read', () => {
  for (const command of [
    `gh pr create --title "feat: thank ${email}" --body ok`,
    `gh pr comment 3 -b "${email}"`,
    `gh pr comment 3 -b"${email}"`,
    `gh issue edit 3 --body="${email}"`,
    `gh pr review 3 --comment --body "${email}"`,
    `gh -R o/r issue comment 3 --body "${email}"`,
    `nice gh issue create -t "check: add x" -b "${email}"`,
  ]) {
    assert.equal(post(command)?.id, 'email', command);
  }
});

test('a --body-file with a private mark is stopped, by file and line; the mark is never printed', () => {
  writeFileSync(join(postDir, 'body.md'), 'Summary\n\nTested in QuietVale.\n');
  for (const command of ['gh pr create --title "feat: add t" --body-file body.md', 'gh issue comment 3 -F body.md', `gh pr create --body-file ${join(postDir, 'body.md')}`]) {
    const f = post(command);
    assert.equal(f?.id, 'private-mark', command);
    assert.equal(f?.line, 3);
    assert.ok(!formatFinding(f).toLowerCase().includes('quietvale'));
  }
});

test('release notes are read when a release is allowed', () => {
  writeFileSync(join(postDir, 'notes.md'), `thanks ${email}\n`);
  const approved = (command: string) => checkCommand(command, { env: { ...postEnv, YOKOTEN_RELEASE_APPROVAL: '1' }, config: DEFAULTS, cwd: postDir });
  assert.equal(approved(`gh release create v1 --notes "${email}"`)?.id, 'email');
  assert.equal(approved('gh release edit v1 --notes-file notes.md')?.id, 'email');
  assert.equal(approved('gh release create v1 --notes "clean notes"'), null);
});

test('gh api fields and input files are read', () => {
  assert.equal(post(`gh api repos/o/r/issues/1/comments -f body="token ${token}"`)?.id, 'secret');
  assert.equal(post(`gh api repos/o/r/issues -F title="check: add x" -F body="${email}"`)?.id, 'email');
  assert.equal(post(`gh api repos/o/r/issues --raw-field=body=${email}`)?.id, 'email');
  writeFileSync(join(postDir, 'payload.json'), JSON.stringify({ body: email }));
  assert.equal(post('gh api repos/o/r/issues --input payload.json')?.id, 'email');
  assert.equal(post('gh api repos/o/r/issues -F body=@body.md')?.id, 'private-mark');
  assert.equal(post('gh api repos/o/r/issues -f body="all clean"'), null);
});

// The file bash hands gh, with an email; a clean decoy where the guard used to look (#470).
test('a body file under ~ is refused unless HOME is a full path (#470)', () => {
  const dir = makeTempDir('yokoten-470-');
  writeFileSync(join(dir, 'b.md'), `write to ${email}\n`);
  mkdirSync(join(dir, '~'));
  writeFileSync(join(dir, '~', 'b.md'), 'clean\n');
  const postIn = (env: Env, command: string) => checkCommand(command, { env: { YOKOTEN_PRIVATE_MARKS: postMarks, ...env }, config: DEFAULTS, cwd: dir });
  for (const env of [{}, { HOME: '' }, { HOME: 'relative' }]) {
    for (const command of ['gh issue create --title "check: a" -F ~/b.md', 'gh issue create --title "check: a" --body-file ~/b.md', 'gh issue create --title "check: a" -F ~other/b.md']) {
      const f = postIn(env, command);
      assert.equal(f?.id, 'unreadable-command', `${JSON.stringify(env)} ${command}`);
      assert.match(formatFinding(f), /full path/);
    }
  }
  assert.equal(postIn({ HOME: dir }, 'gh issue create --title "check: a" -F ~/b.md')?.id, 'email');
  assert.equal(postIn({ HOME: dir }, 'gh issue create --title "check: a" -F ~other/b.md')?.id, 'unreadable-command');
});

test('a body file with .. goes up from the real folder, as the kernel does (#470)', () => {
  const dir = makeTempDir('yokoten-470-');
  const real = join(dir, 'real');
  mkdirSync(join(real, 'sub'), { recursive: true });
  writeFileSync(join(real, 'b.md'), `write to ${email}\n`);
  writeFileSync(join(dir, 'b.md'), 'clean\n');
  const link = join(dir, 'link');
  symlinkSync(join(real, 'sub'), link);
  const postIn = (env: Env, cwd: string, command: string) => checkCommand(command, { env: { YOKOTEN_PRIVATE_MARKS: postMarks, ...env }, config: DEFAULTS, cwd });
  // The working folder is a symlink.
  assert.equal(postIn({ HOME: postDir }, link, 'gh issue create --title "check: a" -F ../b.md')?.id, 'email');
  assert.equal(postIn({ HOME: postDir }, link, 'gh issue create --title "check: a" --body-file=../b.md')?.id, 'email');
  assert.equal(postIn({ HOME: postDir, YOKOTEN_RELEASE_APPROVAL: '1' }, link, 'gh release create v1 --notes-file ../b.md')?.id, 'email');
  assert.equal(postIn({ HOME: postDir }, postDir, `gh issue create --title "check: a" -F ${link}/../b.md`)?.id, 'email');
  // HOME is a symlink.
  assert.equal(postIn({ HOME: link }, postDir, 'gh issue create --title "check: a" -F ~/../b.md')?.id, 'email');
  // Control: no symlink, and `..` still finds the file.
  assert.equal(postIn({ HOME: postDir }, join(real, 'sub'), 'gh issue create --title "check: a" -F ../b.md')?.id, 'email');
});

test('a secret is named by kind, never printed', () => {
  const f = post(`gh pr comment 1 --body "use ${token}"`);
  assert.equal(f?.id, 'secret');
  assert.ok(!formatFinding(f).includes(token));
});

test('yokoten bot -- gh is read the same way', () => {
  assert.equal(post(`yokoten bot -- gh pr create --title "feat: add t" --body "${email}"`)?.id, 'email');
  assert.equal(post(`node bin/yokoten.ts bot -- gh issue comment 3 --body "${email}"`)?.id, 'email');
  assert.equal(post('yokoten bot -- gh pr create --title "feat: add t" --body "clean"'), null);
});

test('an inline heredoc body is read, with its line', () => {
  const f = post(`gh pr create --title "feat: add t" --body "$(cat <<'EOF'\nSummary\n\nmail ${email}\nEOF\n)"`);
  assert.equal(f?.id, 'email');
  assert.match(f?.what ?? '', /line 4/);
  // A body from stdin: the heredoc fed to it is read.
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nmail ${email}\nEOF`)?.id, 'email');
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nall clean\nEOF`), null);
});

test('clean text, allowed addresses and other commands pass', () => {
  for (const command of [
    'gh pr create --title "feat: x" --body "Closes issue #3"',
    'gh issue create --title "check: add t" --body "by 12345+bot@users.noreply.github.com"',
    `gh issue create --title "check: add t" --body "ask support${'@'}example.com"`,
    'gh pr create --fill',
    `gh pr view 3 --comments`,
    `echo gh issue create --body "${email}"`,
    `gh pr list --search "${email}"`,
  ]) {
    assert.equal(post(command), null, command);
  }
});

test('privacy.allow in yokoten.json lets an address through', () => {
  const config = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: [email] } };
  assert.equal(post(`gh issue create --title "check: add t" --body "${email}"`, config), null);
});

test('API reads pass; API writes and GraphQL mutations are read (#391 review)', () => {
  assert.equal(post(`gh api graphql -f query='query { search(query: "${email}") { issueCount } }'`), null);
  assert.equal(post(`gh api graphql -f query='mutation { addComment(input: {body: "${email}"}) { clientMutationId } }'`)?.id, 'email');
  assert.equal(post(`gh api search/issues -f q="${email}"`), null);
  assert.equal(post(`gh api -X GET repos/o/r/issues -f creator="${email}"`), null);
  assert.equal(post(`gh api -X POST repos/o/r/labels -f description="${email}"`)?.id, 'email');
  assert.equal(post(`gh api --method=PATCH repos/o/r/issues/1 -f body="${email}"`)?.id, 'email');
  assert.equal(post(`gh api repos/o/r/issues/1/comments -F body=@- <<'EOF'\nmail ${email}\nEOF`)?.id, 'email');
});

test('a stdin body: only the heredoc is read, not the rest of the command (#391 review)', () => {
  assert.equal(post(`cd /srv/quietvale-site && gh pr create --title "feat: add t" --body-file - <<'EOF'\nall clean\nEOF`), null);
  assert.equal(post(`gh pr comment 3 --body-file - <<'EOF'\nfrom QuietVale\nEOF`)?.id, 'private-mark');
  assert.equal(post('gh pr comment 3 --body-file -'), null, 'stdin from another program is not seen');
});

test('a heredoc whose end word the guard does not read exactly: the rest of the text is scanned (#466)', () => {
  const head = 'gh issue create --title t -F - ';
  for (const command of [
    // bash ends the body at `E:F`; the guard reads no plain name, so it scans to the end.
    `${head}<<'E:F'\nfrom QuietVale\nE:F`,
    // bash ends the body at `EOF`, not at a line `E`: the lines after `E` are posted too.
    `${head}<<"E"OF\nclean\nE\nfrom QuietVale\nEOF`,
    `${head}<<E'OF'\nclean\nE\nfrom QuietVale\nEOF`,
    `${head}<<'E'OF\nclean\nE\nfrom QuietVale\nEOF`,
    // bash ends the body only at a line that is the word exactly: `EOF ` and `EOF\r` don't.
    `${head}<<'EOF'\nclean\nEOF \nfrom QuietVale\nEOF`,
    `${head}<<'EOF'\nclean\nEOF\r\nfrom QuietVale\nEOF`,
  ]) {
    assert.equal(post(command)?.id, 'private-mark', command);
  }
  // Plain end words, bare or quoted, with a space or a dash before them.
  for (const word of ["'EOF'", '"EOF"', 'EOF', "-'EOF'", " 'EOF'", '- EOF']) {
    assert.equal(post(`${head}<<${word}\nfrom QuietVale\nEOF`)?.id, 'private-mark', word);
    assert.equal(post(`${head}<<${word}\nall clean\nEOF`), null, word);
  }
  // A line continuation inside the end word: the whole command is refused (#439).
  assert.equal(post(`${head}<<E\\\nF\nclean\nE\nfrom QuietVale\nEF`)?.id, 'unreadable-command');
  // A here-string is not a heredoc.
  assert.equal(post(`${head}<<< 'all clean'\necho done`), null);
});

test('a relative body file follows cd; one the guard cannot place stops the command (#391 review)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  writeFileSync(join(postDir, 'sub', 'note.md'), 'Seen in QuietVale.\n');
  // `cd sub` may land anywhere through CDPATH (#559), so the folder is unknown and the
  // body file can't be placed: unreadable, as below, not read from a guessed folder.
  const placed = post('cd sub && gh issue comment 3 --body-file note.md');
  assert.equal(placed?.id, 'unreadable-command');
  assert.match(placed?.fix ?? '', /full path/);
  assert.equal(post(`cd ${join(postDir, 'sub')} && gh issue comment 3 --body-file note.md`)?.id, 'private-mark');
  for (const command of ['cd "$X" && gh issue comment 3 --body-file note.md', 'gh pr create --body-file missing.md', 'cd sub && gh pr create --body-file body.md']) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.match(f?.fix ?? '', /full path/);
  }
});

test('privacy comes before the title, and a file path in a finding hides home and marks (#391 review)', () => {
  const titled = checkCommand(`gh issue create --title "Mail ${email}" --body ok`, { env: postEnv, config: DEFAULTS, cwd: postDir, titles: true });
  assert.equal(titled?.id, 'email');
  mkdirSync(join(postDir, 'quietvale'), { recursive: true });
  writeFileSync(join(postDir, 'quietvale', 'notes.md'), `ask ${email}\n`);
  const f = post(`gh pr create --body-file ${join(postDir, 'quietvale', 'notes.md')}`);
  assert.equal(f?.id, 'email');
  assert.equal(f?.file, 'notes.md', 'the folder holds a mark, so only the name is shown');
  writeFileSync(join(postDir, 'plain.md'), `ask ${email}\n`);
  assert.equal(post(`gh pr create --body-file ${join(postDir, 'plain.md')}`)?.file, '~/plain.md');
});

test('merge, close and review text is read (#391 review)', () => {
  for (const command of [
    `gh pr merge 3 --squash --subject "feat: thank ${email}"`,
    `gh pr merge 3 --body "${email}"`,
    `gh issue close 3 --comment "${email}"`,
    `gh pr close 3 -c "${email}"`,
    `gh pr review 3 --approve --body "${email}"`,
  ]) {
    assert.equal(post(command)?.id, 'email', command);
  }
});

test('a < file or a <<< here-string feeding stdin is read (#391 review)', () => {
  assert.equal(post('gh pr create --title "feat: add t" --body-file - < body.md')?.id, 'private-mark');
  assert.equal(post('gh pr create --title "feat: add t" --body-file - <body.md')?.id, 'private-mark');
  assert.equal(post(`gh issue comment 3 -F - <<< "mail ${email}"`)?.id, 'email');
  assert.equal(post('gh issue comment 3 --body "a < b.md"'), null, 'a quoted < is text');
});

test('only regular files up to 1 MB are read; others pass unread (#391 review)', () => {
  mkdirSync(join(postDir, 'folder'), { recursive: true });
  assert.equal(post('gh pr create --body-file folder'), null);
  writeFileSync(join(postDir, 'big.md'), `${email}\n${'x'.repeat(1024 * 1024)}`);
  assert.equal(post('gh pr create --body-file big.md'), null);
});

// ---- A body file the same command writes (#439) ----
//
// Only `cat > path <<'EOF' && gh … path`, as the whole command, is followed.

const plainRefusal = (command: string) => {
  const f = post(command);
  assert.equal(f?.id, 'unreadable-command', command);
  assert.match(f?.what ?? '', /the guard runs/, command);
  assert.match(f?.fix ?? '', /write the file in one command, then post it in the next/, command);
};

test('cat > file <<EOF && gh --body-file file: the heredoc is checked (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  for (const command of [
    `cat > fresh.md <<'EOF' && gh issue create --title "check: add t" --body-file fresh.md\nAll clean.\nEOF`,
    `cat >fresh.md <<'EOF' && gh pr comment 3 -F fresh.md\nAll clean, $(not run).\nEOF\n`,
    `cat > fresh.md <<'EOF' && gh issue comment 3 --body-file=fresh.md\nAll clean.\nEOF`,
    `cat > fresh.md <<'EOF' && gh issue comment 3 -Ffresh.md\nAll clean.\nEOF`,
    `cat > ~/fresh.md <<'EOF' && gh issue comment 3 -F ~/fresh.md --repo o/r\nAll clean.\nEOF`,
  ]) {
    assert.equal(post(command), null, command);
  }
});

test('a heredoc body with a private value is stopped, by file and line (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  const marked = post(`cat > fresh.md <<'EOF' && gh issue create --title "check: add t" --body-file fresh.md\nSummary\nTested in QuietVale.\nEOF`);
  assert.equal(marked?.id, 'private-mark');
  assert.equal(marked?.line, 2);
  assert.ok(!formatFinding(marked).toLowerCase().includes('quietvale'));
  assert.equal(post(`cat > fresh.md <<'EOF' && gh pr comment 3 -F fresh.md\nmail ${email}\nEOF`)?.id, 'email');
});

test('the file on disk is checked too, in case cat cannot replace it (#439)', () => {
  writeFileSync(join(postDir, 'old.md'), 'Seen in QuietVale.\n');
  assert.equal(post(`cat > old.md <<'EOF' && gh issue comment 3 -F old.md\nAll clean.\nEOF`)?.id, 'private-mark');
  writeFileSync(join(postDir, 'old.md'), 'clean\n');
  assert.equal(post(`cat > old.md <<'EOF' && gh issue comment 3 -F old.md\nAll clean.\nEOF`), null);
  // A read-only file (chmod 444): cat can't replace it, so what is there now is checked.
  writeFileSync(join(postDir, 'ro.md'), 'Seen in QuietVale.\n');
  chmodSync(join(postDir, 'ro.md'), 0o444);
  assert.equal(post(`cat > ro.md <<'EOF' && gh issue comment 3 -F ro.md\nAll clean.\nEOF`)?.id, 'private-mark');
  chmodSync(join(postDir, 'ro.md'), 0o644);
  // A folder there: cat fails, and the guard can't tell.
  mkdirSync(join(postDir, 'adir.md'), { recursive: true });
  plainRefusal(`cat > adir.md <<'EOF' && gh issue comment 3 -F adir.md\nclean\nEOF`);
});

test('a file on disk with nothing else in the command is read as before (#439)', () => {
  writeFileSync(join(postDir, 'kept.md'), `mail ${email}\n`);
  assert.equal(post('gh issue comment 3 -F kept.md')?.id, 'email');
  assert.equal(post(`cd ${postDir} && gh issue comment 3 -F kept.md`)?.id, 'email');
  // A redirect is not plain, so beside a cd the guard can't tell (#439 round 5).
  plainRefusal(`cd ${postDir} && gh issue comment 3 -F kept.md 2>/dev/null`);
  writeFileSync(join(postDir, 'kept.md'), 'clean\n');
  assert.equal(post('gh issue comment 3 -F kept.md'), null);
});

// Every other shape is refused: these came from review, and each one gets a body past a
// more general reading of the command.
const reviewCases: [string, string][] = [
  ["backslash-newline unquoted", "cat > f.md <<EOF\nQuiet\\\nVale\nEOF\ngh issue comment 3 -F f.md"],
  ["baseline clean", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["baseline mark", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["brace expansion tee", "cat > f.md <<'EOF'\nclean\nEOF\necho QuietVale | tee {f,g}.md\ngh issue comment 3 -F f.md"],
  ["glob ? redirect", "cat > f.md <<'EOF'\nclean\nEOF\necho QuietVale > ?.md\ngh issue comment 3 -F f.md"],
  ["glob [] cp", "cat > f.md <<'EOF'\nclean\nEOF\ncp src.txt [f].md\ngh issue comment 3 -F f.md"],
  ["function cat", "cat() { printf QuietVale; }\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["function cat2", "function cat { printf QuietVale; }\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["noclobber", "set -C\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly existing (plain)", "cat > ro.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F ro.md"],
  ["CRLF delim", "cat > f.md <<'EOF'\nclean\nEOF\r\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["trailing space delim", "cat > f.md <<'EOF'\nclean\nEOF \nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["<<- tabs", "cat > f.md <<-'EOF'\n\tQuietVale\n\tEOF\ngh issue comment 3 -F f.md"],
  ["two heredocs same file", "cat > f.md <<'EOF'\nQuietVale\nEOF\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["two heredocs one cmd", "cat > f.md <<'A' <<'B'\nQuietVale\nA\nclean\nB\ngh issue comment 3 -F f.md"],
  ["var reassign", "S=/x/f.md\nS=f.md\ncat > $S <<'EOF'\nclean\nEOF\nS=g.md\ngh issue comment 3 -F $S"],
  ["S=a S=b", "S=a.md S=f.md\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["S=a S=b gh", "S=a.md S=f.md\ncat > $S <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F $S"],
  ["subshell export", "S=f.md\n(S=g.md; export S)\ncat > g.md <<'EOF'\nQuietVale\nEOF\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["eval assign", "S=f.md\neval S=g.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["eval gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\neval gh issue comment 3 -F f.md"],
  ["command gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\ncommand gh issue comment 3 -F f.md"],
  ["env gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\nenv gh issue comment 3 -F f.md"],
  ["xargs gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\necho f.md | xargs gh issue comment 3 -F"],
  ["-Ff", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -Ff.md"],
  ["--body-file=", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 --body-file=f.md"],
  ["process subst", "gh issue comment 3 -F <(echo QuietVale)"],
  ["${S:-x}", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F ${S:-g.md}"],
  ["IFS", "IFS=.\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["tilde", "cat > ~/f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F $HOME/f.md"],
  ["cd between", "cat > f.md <<'EOF'\nclean\nEOF\ncd sub\ngh issue comment 3 -F f.md"],
  ["unquoted with $(..)", "cat > f.md <<EOF\n$(echo Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["unquoted backslash-dollar", "cat > f.md <<EOF\nQuiet\\Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["case-fold", "cat > F.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["symlink other name", "cat > target.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F link.md"],
  ["writer in if", "if true; then cat > f.md <<'EOF'\nQuietVale\nEOF\nfi\ngh issue comment 3 -F f.md"],
  ["source", "cat > f.md <<'EOF'\nclean\nEOF\nsource x.sh\ngh issue comment 3 -F f.md"],
  ["mv dir", "cat > f.md <<'EOF'\nclean\nEOF\ncp -r ev/. .\ngh issue comment 3 -F f.md"],
  ["exec redirect", "cat > f.md <<'EOF'\nclean\nEOF\nexec 3>f.md\ngh issue comment 3 -F f.md"],
  ["fd write without naming", "exec 3>f.md\ncat > f.md <<'EOF'\nclean\nEOF\necho QuietVale >&3\ngh issue comment 3 -F f.md"],
  ["alias", "shopt -s expand_aliases\nalias cat='printf QuietVale'\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["trap", "trap 'echo QuietVale > f.md' DEBUG\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["background earlier", "sleep 1 && echo QuietVale > f\\.md &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["bg loop", "(sleep 0.1; cp ev/f.md .) &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["sh -c var", "S=f.md bash -c 'echo QuietVale > $S'\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["space split gh", "S='x -F f.md'\ncat > \"$S\" <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["ambiguous redirect", "S='a b.md'\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F \"$S\""],
  ["source sets var", "S=g.md\ncat > g.md <<'EOF'\nclean\nEOF\n. ./x.sh\ngh issue comment 3 -F $S"],
  ["delim \"EOF\"", "cat > f.md <<\"EOF\"\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim \\EOF", "cat > f.md <<\\EOF\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim E'O'F", "cat > f.md <<E'O'F\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim space 'EOF'", "cat > f.md << 'EOF'\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim $X", "cat > f.md <<$X\n$(printf Quiet)Vale\n$X\ngh issue comment 3 -F f.md"],
  ["two docs two cmds one line", "cat > f.md <<'A'; cat > g.md <<'B'\nclean\nA\nQuietVale\nB\ngh issue comment 3 -F f.md"],
  ["two docs two cmds swap", "cat > g.md <<'A'; cat > f.md <<'B'\nclean\nA\nQuietVale\nB\ngh issue comment 3 -F f.md"],
  ["bg gh then write", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md &\nprintf QuietVale > f.md; wait"],
  ["bg writer race", "(sleep 0.05; cp ev/f.md .) &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md; wait"],
  ["heredoc in && with gh before body", "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nQuietVale\nEOF"],
  ["line continuation in cmd", "cat > f.\\\nmd <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["unicode delim", "cat > f.md <<'EOF'\nclean\nEOF \nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["semicolon after delim", "cat > f.md <<'EOF'\nclean\nEOF;\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["nested $( heredoc", "X=$(cat <<'EOF'\nclean\nEOF\n)\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["comment hides heredoc", "cat > f.md <<'EOF' # <<'X'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["heredoc op in comment", "cat > f.md # <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["writer w/ var target null HOME", "cat > $HOME/f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  [">| target", "set -C\ncat >| f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["cat 1>", "cat 1> f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["redirect before cat", "> f.md cat <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["assign prefix cat", "LC_ALL=C cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["quoted cat", "'cat' > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["/bin/cat", "/bin/cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["./cat", "./cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["PATH cat", "PATH=./bin\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["hash -p", "hash -p ./bin/cat cat\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["enable -n", "enable -f x cat\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["ulimit", "ulimit -f 0\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["mkdir f.md first?", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly var", "S=g.md\nreadonly S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["declare -i", "declare -i S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["declare -u", "declare -l S\nS=F.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["declare -u gh", "declare -u S\nS=f.md\ncat > F.MD <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["export -n etc", "S=f.md; set -u; cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["brace in gh word", "cat > '{x,f.md}' <<'EOF'\nclean\nEOF\ngh issue comment 3 -F{x,f.md}"],
  ["PATH prepend", "PATH=$PWD/bin:$PATH\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly var disk", "S=g.md.old\nreadonly S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["IFS split", "S=f.md\nIFS=.\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ['background gh', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md &\nQuietVale\nEOF"],
  ['variable in the path', "S=f.md; cat > $S <<'EOF' && gh issue comment 3 -F $S\nclean\nEOF"],
  ['quoted path', "cat > 'f.md' <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF"],
  ['unquoted delimiter', "cat > f.md <<EOF && gh issue comment 3 -F f.md\nclean\nEOF"],
  ['other path to the same file', "cat > f.md <<'EOF' && gh issue comment 3 -F ./f.md\nclean\nEOF"],
  ['substitution in the gh line', "cat > f.md <<'EOF' && gh issue comment 3 --title \"$(date)\" -F f.md\nclean\nEOF"],
  ['a third command', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md && echo done\nclean\nEOF"],
  ['text after the delimiter', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\necho QuietVale > f.md"],
  ['gh redirect into the file', "gh issue comment 3 -F kept.md > kept.md"],
  ['env prefix', "cat > f.md <<'EOF' && env gh issue comment 3 -F f.md\nclean\nEOF"],
];

test('every other way to write a body file in the same command is refused (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  for (const onDisk of [false, true]) {
    for (const name of ['f.md', 'g.md', 'ro.md', 'F.md', 'F.MD', 'target.md', 'link.md', 'kept.md']) {
      if (onDisk) writeFileSync(join(postDir, name), 'clean\n');
      else rmSync(join(postDir, name), { force: true });
    }
    for (const [name, command] of reviewCases) {
      const f = post(command);
      assert.ok(f !== null, `${name} (file on disk: ${onDisk})`);
    }
  }
  // An unclosed heredoc swallows the gh line: gh never runs, and nothing is posted.
  assert.equal(post("cat > f.md <<'EOF'\nclean\ngh issue comment 3 -F f.md"), null);
  // Each answer that is not about the text itself gives the plain reason.
  rmSync(join(postDir, 'f.md'), { force: true });
  plainRefusal(`cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md`);
  plainRefusal('gh issue comment 3 -F "$(mktemp)"');
  plainRefusal('gh issue comment 3 -F $OUTSIDE/x.md');
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  plainRefusal(`cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md`);
  plainRefusal('echo QuietVale > f.md; gh issue comment 3 -F f.md');
  assert.match(post('gh issue comment 3 -F not-there.md')?.what ?? '', /doesn't exist yet when the guard runs/);
});

test('reading the heredoc shape stays linear (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  assertLinear(
    'a long heredoc body and a long gh line',
    (n) => `cat > fresh.md <<'EOF' && gh issue comment 3 ${'-F fresh.md '.repeat(n / 24)}--title "${'t'.repeat(n / 4)}"\n${'clean line\n'.repeat(n / 22)}EOF`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'many commands before a gh with a body file',
    (n) => `${'cd . && '.repeat(n / 16)}gh issue comment 3 -F not-there.md`,
    (command) => assert.equal(post(command)?.id, 'unreadable-command'),
  );
});

test("the lead's command with a body file on disk: commands that write no file don't stop it (#439)", () => {
  const body = join(postDir, 'lead-body.md');
  const lead = `cd ${postDir} && export NODE_USE_ENV_PROXY=1 GH_REPO=o/r; node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  writeFileSync(body, 'All clean.\n');
  assert.equal(post(lead), null);
  assert.equal(post(lead.replace('node bin/yokoten.ts bot', 'yokoten bot')), null);
  // Loading a file with . or source may run anything, so the file on disk is not trusted.
  plainRefusal(`set -a; . ~/.config/yokoten/keys.env; set +a; ${lead}`);
  // A `$` the shell fills in may run code, so the older form with $(…) is refused too.
  plainRefusal(`OWNER=$(gh pr view 1 --json assignees -q '.assignees[0].login'); ${lead} --assignee "$OWNER"`);
  for (const reads of ['git rev-parse HEAD', 'git config --get user.name', 'git remote get-url origin', 'gh issue list', 'gh pr checks 3', 'echo hi', 'true', 'test -f x', 'set -e -o pipefail', 'set +u', 'OWNER=someone', 'export GH_HOST=example.com', 'GH_REPO=o/r gh pr view 1', 'cd sub', 'yokoten bot -- gh run view 1']) {
    assert.equal(post(`${reads} && gh pr comment 3 -F ${body}`), null, reads);
  }
  writeFileSync(body, 'Tested in QuietVale.\n');
  assert.equal(post(lead)?.id, 'private-mark');
  // A command that may write the file still stops it.
  writeFileSync(body, 'All clean.\n');
  for (const writes of [
    `echo QuietVale > ${body}`,
    '. ./x.sh',
    'source ~/.config/yokoten/x.sh',
    'eval x',
    'f() { :; }',
    'git diff',
    'git status',
    'git log -1',
    'gh api repos/o/r/pulls',
    'export EDITOR=x',
    'HOME=/x',
    'set -a',
    'git log -p',
    'git log --patch',
    'git log -u',
    'git log --textconv',
    'git log --ext-diff',
    'git log --output=x',
    'gh api -X POST repos/o/r/issues',
    'gh api repos/o/r/issues -f body=x',
    'gh pr checkout 3',
    'X=$(cp a b)',
    'yokoten bot -- gh pr merge 3',
    'printf x > out.md',
    'PATH=./bin; git status',
    'export GIT_EXTERNAL_DIFF=./x; git log',
    'NODE_OPTIONS=--require=./x.js node bin/yokoten.ts bot -- gh pr view 1',
  ]) {
    plainRefusal(`${writes}; gh pr comment 3 -F ${body}`);
  }
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  plainRefusal('echo QuietVale > f.md; gh issue comment 3 -F f.md');
  plainRefusal('. ./x.sh; gh issue comment 3 -F f.md');
});

test('TZ=UTC with a post is trusted: gh sends it as the Time-Zone header (#488)', () => {
  const body = join(postDir, 'tz-body.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  for (const command of [`TZ=UTC gh pr comment 3 -F ${body}`, `export TZ=UTC && gh pr comment 3 -F ${body}`, `export TZ=UTC; ${bot}`, `TZ=UTC ${bot} 2>&1 | tail -2`]) {
    assert.equal(post(command), null, command);
  }
  // Still checked: a mark in the file stops it, through either form.
  writeFileSync(body, 'Tested in QuietVale.\n');
  assert.equal(post(`TZ=UTC gh pr comment 3 -F ${body}`)?.id, 'private-mark');
  assert.equal(post(`export TZ=UTC && gh pr comment 3 -F ${body}`)?.id, 'private-mark');
  writeFileSync(body, 'All clean.\n');
  // Any other zone, a bare `export TZ`, or any other name is still refused.
  plainRefusal(`TZ=Asia/Tokyo gh pr comment 3 -F ${body}`);
  plainRefusal(`export TZ=Asia/Tokyo; gh pr comment 3 -F ${body}`);
  plainRefusal(`export TZ; gh pr comment 3 -F ${body}`);
  plainRefusal(`EDITOR=x gh pr comment 3 -F ${body}`);
  plainRefusal(`export EDITOR=x; gh pr comment 3 -F ${body}`);
  // The refusal names what to leave out.
  const other = post(`TZ=Asia/Tokyo gh pr comment 3 -F ${body}`);
  assert.ok(other?.what.includes('a variable other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC'), other?.what);
  const exported = post(`export EDITOR=x; gh pr comment 3 -F ${body}`);
  assert.ok(exported?.what.includes('an `export` of a name other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC'), exported?.what);
  // A project allow still applies after an inline TZ=UTC, as after NODE_USE_ENV_PROXY=1 (#498).
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  assert.equal(post('TZ=UTC gh issue create --title "check: fix a bug" --body "QuietVale ships"', allowing), null);
  assert.equal(post('TZ=Asia/Tokyo gh issue create --title "check: fix a bug" --body "QuietVale ships"', allowing)?.id, 'private-mark');
  rmSync(body);
});

// More inputs from review (#439). Only these write no file and run nothing: the file on disk
// is still the one gh posts.
const writesNothing = new Set(["control: nothing","control: echo","echo -e"]);
const reviewCases2: [string, string][] = [
  ["control: nothing", "gh issue comment 3 -F f.md"],
  ["control: echo", "echo hi && gh issue comment 3 -F f.md"],
  ["control: cp", "cp ev/f.md f.md; gh issue comment 3 -F f.md"],
  ["cmdsubst in echo", "echo $(cp ev/f.md f.md) && gh issue comment 3 -F f.md"],
  ["cmdsubst in dq", "echo \"$(cp ev/f.md f.md)\" && gh issue comment 3 -F f.md"],
  ["backtick", "echo `cp ev/f.md f.md` && gh issue comment 3 -F f.md"],
  ["test -e $()", "test -e $(cp ev/f.md f.md) ; gh issue comment 3 -F f.md"],
  ["export X=$()", "export X=$(cp ev/f.md f.md) && gh issue comment 3 -F f.md"],
  ["assign X=$()", "X=$(cp ev/f.md f.md) gh issue comment 3 -F f.md"],
  ["procsubst echo", "echo <(cp ev/f.md f.md) >/dev/null; sleep 0.2; gh issue comment 3 -F f.md"],
  ["procsubst >()", "echo QuietVale > >(cat > f.md); sleep 0.2; gh issue comment 3 -F f.md"],
  ["procsubst arg", "printf QuietVale >(cat > f.md) ; sleep 0.2; gh issue comment 3 -F f.md"],
  ["echo >| f", "echo QuietVale >| f.md; gh issue comment 3 -F f.md"],
  ["echo >& f", "echo QuietVale >&f.md; gh issue comment 3 -F f.md"],
  [":> f", ":> f.md; gh issue comment 3 -F f.md"],
  ["true > f", "true > f.md; gh issue comment 3 -F f.md"],
  ["printf -v", "printf -v X %s y; gh issue comment 3 -F f.md"],
  ["printf -v subscript", "printf -v 'a[$(cp ev/f.md f.md)]' %s 1; gh issue comment 3 -F f.md"],
  ["test -v subscript", "test -v 'a[$(cp ev/f.md f.md)]'; gh issue comment 3 -F f.md"],
  ["[ -v subscript", "[ -v 'a[$(cp ev/f.md f.md)]' ]; gh issue comment 3 -F f.md"],
  ["arith recursive", "X='a[$(cp ev/f.md f.md)]'; echo $((X)); gh issue comment 3 -F f.md"],
  ["arith recursive2", "X='a[$(cp ev/f.md f.md)]' && echo $((X+1)) && gh issue comment 3 -F f.md"],
  ["arith $[]", "X='a[$(cp ev/f.md f.md)]'; echo $[X]; gh issue comment 3 -F f.md"],
  ["test -eq", "X='a[$(cp ev/f.md f.md)]'; test \"$X\" -eq 0; gh issue comment 3 -F f.md"],
  ["[[ -v", "[[ -v 'a[$(cp ev/f.md f.md)]' ]]; gh issue comment 3 -F f.md"],
  ["PS4 xtrace", "export PS4='$(cp ev/f.md f.md)'; set -x; gh issue comment 3 -F f.md"],
  ["PS4 plain", "PS4='$(cp ev/f.md f.md) ' && set -x && gh issue comment 3 -F f.md"],
  ["HOME tilde", "HOME=ev; gh issue comment 3 -F ~/f.md"],
  ["set -o noclobber", "set -o noclobber; gh issue comment 3 -F f.md"],
  ["cd subdir", "cd sub && gh issue comment 3 -F f.md"],
  ["gh pr view --web", "gh pr view --web 3; gh issue comment 3 -F f.md"],
  ["gh run view --log >f", "gh run view 1 --log > f.md; gh issue comment 3 -F f.md"],
  ["git log --output", "git log --output=f.md; gh issue comment 3 -F f.md"],
  ["git log -L", "git log -L1,1:f.md; gh issue comment 3 -F f.md"],
  ["git log -c", "git log -c; gh issue comment 3 -F f.md"],
  ["git log --cc", "git log --cc; gh issue comment 3 -F f.md"],
  ["git log -S", "git log -Sx; gh issue comment 3 -F f.md"],
  ["git status", "git status; gh issue comment 3 -F f.md"],
  ["git config --get --file", "git config --get --file f.md x; gh issue comment 3 -F f.md"],
  ["gh api GET", "gh api repos/a/b --jq . ; gh issue comment 3 -F f.md"],
  ["gh api --cache", "gh api repos/a/b --cache 1h; gh issue comment 3 -F f.md"],
  ["gh api -t", "gh api repos/a/b -t x; gh issue comment 3 -F f.md"],
  ["gh api method lowercase", "gh api repos/a/b/issues/3/comments --method=post; gh issue comment 3 -F f.md"],
  ["gh api -XPOST", "gh api -XPOST repos/a/b/issues/3/comments; gh issue comment 3 -F f.md"],
  ["yokoten bot -- echo >", "yokoten bot -- echo QuietVale > f.md; gh issue comment 3 -F f.md"],
  ["yokoten bot -- cp", "yokoten bot -- cp ev/f.md f.md; gh issue comment 3 -F f.md"],
  ["echo -e", "echo -e 'x' ; gh issue comment 3 -F f.md"],
  ["set -- $()", "set -- $(cp ev/f.md f.md); gh issue comment 3 -F f.md"],
  ["cd $()", "cd $(cp ev/f.md f.md; echo .) && gh issue comment 3 -F f.md"],
  ["bash -c", "bash -c 'cp ev/f.md f.md'; gh issue comment 3 -F f.md"],
  ["export -f? func", "f() { cp ev/f.md f.md; }; f; gh issue comment 3 -F f.md"],
  ["pushd", "pushd sub >/dev/null && gh issue comment 3 -F f.md"],
  ["export BASH_FUNC", "export 'BASH_FUNC_gh%%=() { cp ev/f.md f.md; command gh \"$@\"; }'; gh issue comment 3 -F f.md"],
  ["assign BASH_FUNC env", "env 'BASH_FUNC_x%%=() { :; }' true; gh issue comment 3 -F f.md"],
  ["heredoc to echo", "echo <<'EOF' && gh issue comment 3 -F f.md\n$(cp ev/f.md f.md)\nEOF"],
  ["unquoted heredoc to :", ": <<EOF\n$(cp ev/f.md f.md)\nEOF\ngh issue comment 3 -F f.md"],
  ["heredoc shape clean + extra", "cat > g.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF"],
  ["substring offset", "X='a[$(cp ev/f.md f.md)]'; echo ${HOME:X}; gh issue comment 3 -F f.md"],
  ["subscript var", "X='a[$(cp ev/f.md f.md)]'; echo ${a[X]}; gh issue comment 3 -F f.md"],
  ["export subscript", "export 'a[$(cp ev/f.md f.md)]=1'; gh issue comment 3 -F f.md"],
  ["assign subscript", "a[X]=1 && X='b[$(cp ev/f.md f.md)]' && a[X]=2; gh issue comment 3 -F f.md"],
  ["HOME cd", "HOME=ev; cd; gh issue comment 3 -F f.md"],
  ["GH_BROWSER repo view", "export GH_BROWSER='sh -c \"cp ev/f.md f.md\" x'; gh repo view a/b --web; gh issue comment 3 -F f.md"],
  ["BROWSER", "BROWSER='sh -c \"cp ev/f.md f.md\" x' gh repo view a/b --web; gh issue comment 3 -F f.md"],
  ["test -v subscript", "test -v 'a[$(cp ev/f.md f.md)]'; gh issue comment 3 -F f.md"],
  ["printf -v subscript", "printf -v 'a[$(cp ev/f.md f.md)]' %s 1; gh issue comment 3 -F f.md"],
  ["arith $[]", "X='a[$(cp ev/f.md f.md)]'; echo $[X]; gh issue comment 3 -F f.md"],
  ["PS4 xtrace", "export PS4='$(cp ev/f.md f.md)'; set -x; gh issue comment 3 -F f.md"],
  ["HOME tilde", "HOME=ev; gh issue comment 3 -F ~/f.md"],
];

test('a command beside gh is trusted only when it surely writes no file and runs nothing (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  for (const [name, command] of reviewCases2) {
    if (writesNothing.has(name)) assert.equal(post(command), null, name);
    else assert.ok(post(command) !== null, name);
  }
});

// Inputs from the fourth review (#439). The shell may fill in any `$` or backtick outside single
// quotes by running code (`${X@P}`, `${!X}`, an `a[…]` name read as a number), so each one
// makes the line unsure. So do `$'…'`, a CR, `--web` or `-w`, and `..` after a cd.
const reviewCases3: string[] = [
  "X='a[$(cp ev/f.md f.md)]'; echo \"${!X}\"; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; echo ${!X}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; cd \"${X@P}\"; gh issue comment 3 -F ~/f.md",
  "X='$(cp ev/f.md f.md)'; : ${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; test -n \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; gh pr view \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; export GH_HOST=\"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P} gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)' Y=${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; gh issue comment 3 -F f.md --title \"${X@P}\"",
  "X='$(cp ev/f.md f.md)'; gh issue comment 3 -F f.md \"${X@P}\"",
  "cd lnk; gh issue comment 3 -F ../f.md",
  "gh issue comment 3 -F f.md\r",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; echo ${!X}; gh issue comment 3 -F f.md",
  "B='['; X=\"a${B}\\$(cp ev/f.md f.md)]\"; echo \"${!X}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; echo \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='\\$(cp ev/f.md f.md)'; echo \"${X@P}\"; gh issue comment 3 -F f.md",
  "B=[; Y=-v; X=a${B}'$(cp ev/f.md f.md)]'; test \"$Y\" \"$X\"; gh issue comment 3 -F f.md",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; printf -v\"$X\" %s 1; gh issue comment 3 -F f.md",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; echo $((X)); gh issue comment 3 -F f.md",
  "cp ev/f.md f.md; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; echo ${X@P}; gh issue comment 3 -F f.md",
  "Y=-v; X='a[$(cp ev/f.md f.md)]'; test \"$Y\" \"$X\"; gh issue comment 3 -F f.md",
  "Y=-v; X='a[$(cp ev/f.md f.md)]'; [ $Y $X ]; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; printf -v\"$X\" %s 1; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; printf -v$X %s 1; gh issue comment 3 -F f.md",
  "gh pr view 3 --web=true; gh issue comment 3 -F f.md",
  "echo x 1<>f.md; gh issue comment 3 -F f.md",
  "echo x {fd}>f.md; gh issue comment 3 -F f.md",
  "echo x &>f.md; gh issue comment 3 -F f.md",
  "echo x &>>f.md; gh issue comment 3 -F f.md",
  "echo x >\\\nf.md; gh issue comment 3 -F f.md",
  "pushd sub; pushd ev; pushd +1; gh issue comment 3 -F f.md",
  "echo ${X=$(cp ev/f.md f.md)}; gh issue comment 3 -F f.md",
  "echo ${X/a/$(cp ev/f.md f.md)}; gh issue comment 3 -F f.md",
  "echo $'\\x24(cp ev/f.md f.md)'; gh issue comment 3 -F f.md",
  "true\r\ncp ev/f.md f.md\r\ngh issue comment 3 -F f.md",
  "set -eu -o pipefail -o noclobber; gh issue comment 3 -F f.md",
  "set -o pipefail -o errtrace; gh issue comment 3 -F f.md",
  "set -e -o pipefail -o xtrace; gh issue comment 3 -F f.md",
  "cd -- ev; gh issue comment 3 -F f.md",
  "cd ev; gh issue comment 3 -F ../f.md",
  "trap 'cp ev/f.md f.md' EXIT; gh issue comment 3 -F f.md",
  "echo $(</dev/null) && gh issue comment 3 -F f.md",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nQuietVale\nEOF",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\ncp ev/f.md f.md",
  "f.md=1; gh issue comment 3 -F f.md",
  "OLDPWD=ev; cd - ; gh issue comment 3 -F f.md",
  "X=ev; cd $X; gh issue comment 3 -F f.md",
  "export GH_REPO=a/b GH_HOST=$(cp ev/f.md f.md); gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P}; gh issue comment 3 -F f.md --title \"${X@P}\"",
  "gh pr view 3 -w; gh issue comment 3 -F f.md",
  "gh pr view 3 -cw; gh issue comment 3 -F f.md",
  "gh pr view 3 --web=false; gh issue comment 3 -F f.md",
  "cd sub && gh issue comment 3 -F sub/../f.md",
  "echo '$(x)' $'\\x41'; gh issue comment 3 -F f.md",
  "echo hi;\rgh issue comment 3 -F f.md"
];

// Each of these runs nothing and writes no file, so the file on disk is still what gh posts.
const writesNothing3: string[] = [
  "gh issue comment 3 -F f.md",
  "cd ev\tgh issue comment 3 -F f.md",
  "git config --get alias.x; gh issue comment 3 -F f.md",
  "git rev-parse --git-path x; gh issue comment 3 -F f.md",
  "gh pr checks 3 --watch; gh issue comment 3 -F f.md",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md -F f.md\nclean\nEOF",
  "cat >f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\n",
  "X=1 Y=2; gh issue comment 3 -F f.md",
  "cd ~; gh issue comment 3 -F f.md",
  "GH_HOST=x gh pr view 3; gh issue comment 3 -F f.md",
  "NODE_USE_ENV_PROXY=1 yokoten bot -- gh pr view 3; gh issue comment 3 -F f.md"
];

test('a `$` the shell fills in, a CR, --web or .. after a cd makes the line unsure (#439)', () => {
  for (const dir of ['sub', 'ev', 'lnk-target']) mkdirSync(join(postDir, dir), { recursive: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  writeFileSync(join(postDir, 'ev', 'f.md'), 'QuietVale\n');
  rmSync(join(postDir, 'lnk'), { force: true });
  symlinkSync(join(postDir, 'ev'), join(postDir, 'lnk'));
  for (const command of reviewCases3) assert.ok(post(command) !== null, JSON.stringify(command));
  for (const command of writesNothing3) assert.equal(post(command), null, JSON.stringify(command));
  // A `$` inside single quotes is text, not a value the shell fills in.
  assert.equal(post("echo '$(cp ev/f.md f.md)' && gh issue comment 3 -F f.md"), null);
  assert.equal(post("cat > g.md <<'EOF' && gh issue comment 3 -F g.md\n$(cp ev/f.md f.md)\nEOF"), null);
});

test('scanning a line for values the shell fills in stays linear (#439)', () => {
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  assertLinear(
    'many quotes and words before gh',
    (n) => `${"echo 'a' \"b\" c d; ".repeat(n / 24)}gh issue comment 3 -F f.md`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'an unclosed quote',
    (n) => `echo "${'x '.repeat(n / 2)}`,
    (command) => post(command),
  );
});

// Round 5 (#439): the guard no longer follows bash's grammar. Beside other commands, a body
// file on disk is trusted only when the command is one line of plain words joined by ; and &&.
// Each of these got a file change past a closer reading of heredocs, or follows a cd that
// never ran in this shell.
const payload = "X='$(printf changed > f.md)'; true \"${X@P}\"";
const reviewCases5: string[] = [
  // A backslash in an unquoted delimiter: `<<true\\` ends at a line `true\`, so the payload runs.
  `: <<true\\\\\ntrue\\\n${payload}\ngh issue comment 3 -F f.md`,
  // A here-string is not a heredoc.
  `: <<<'true'\n${payload}\ngh issue comment 3 -F f.md`,
  // A backslash-newline in an unquoted body joins two lines, so the next EOF does not end it.
  `: <<EOF\nx\\\nEOF\ntrue '\nEOF\nX="\\$(printf changed > f.md)"; true "\${X@P}" \\'\ngh issue comment 3 -F f.md`,
  // \" inside a double-quoted delimiter.
  `: <<"E\\"F"\nE"F\n${payload}\ngh issue comment 3 -F f.md`,
  // A cd in a subshell, in the background or in a pipe does not move this shell.
  '(cd sub) && gh issue comment 3 -F f.md',
  'cd sub & gh issue comment 3 -F f.md',
  'cd sub | true; gh issue comment 3 -F f.md',
  // Each refused character, outside single quotes.
  'echo hi | gh issue comment 3 -F f.md',
  'echo hi & gh issue comment 3 -F f.md',
  'true 2>/dev/null; gh issue comment 3 -F f.md',
  'echo hi\ngh issue comment 3 -F f.md',
  'echo a\\ b; gh issue comment 3 -F f.md',
  'echo a#x; gh issue comment 3 -F f.md',
  'echo *.md; gh issue comment 3 -F f.md',
  'echo ?.md; gh issue comment 3 -F f.md',
  'echo [f].md; gh issue comment 3 -F f.md',
  'echo {a,b}; gh issue comment 3 -F f.md',
  'echo a~b; gh issue comment 3 -F f.md',
  'echo ~; gh issue comment 3 -F f.md',
  "echo 'open; gh issue comment 3 -F f.md",
  // The strict shape takes only a name in single quotes.
  'cat > f.md <<"EOF" && gh issue comment 3 -F f.md\nclean\nEOF',
  "cat > f.md <<'E-F' && gh issue comment 3 -F f.md\nclean\nE-F",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md 2>/dev/null\nclean\nEOF",
];

test('beside other commands, only one line of plain words is trusted (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  for (const command of reviewCases5) assert.ok(post(command) !== null, JSON.stringify(command));
  // gh posts ./f.md, since the cd never ran in this shell; the guard must not read sub/f.md.
  writeFileSync(join(postDir, 'f.md'), 'Seen in QuietVale.\n');
  writeFileSync(join(postDir, 'sub', 'f.md'), 'clean\n');
  for (const command of ['(cd sub) && gh issue comment 3 -F f.md', 'cd sub & gh issue comment 3 -F f.md', 'cd sub | true; gh issue comment 3 -F f.md']) {
    assert.notEqual(post(command), null, command);
  }
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  // Plain quotes are fine: a title with spaces, and the lead's own command.
  const body = join(postDir, 'lead-body.md');
  writeFileSync(body, 'All clean.\n');
  for (const command of [
    `cd ${postDir} && export NODE_USE_ENV_PROXY=1 GH_REPO=o/r; node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`,
    `cd ${postDir} && gh pr create --title "fix: a plain title" --body-file ${body}`,
    `echo 'any $ text (here)'; gh pr create --title 'a, b' --body-file ${body}`,
    'cd ~ && gh issue comment 3 -F ~/f.md',
    'gh pr create --title t --body-file - < f.md',
  ]) assert.equal(post(command), null, command);
});

// Round 6 (#439): a heredoc word with a \ and a line end, a ~ word that is not $HOME, and
// "..." that holds only literal characters.
test('a \\ and a line end in a heredoc word is refused, quoted or not (#439)', () => {
  writeFileSync(join(postDir, 'body.md'), `write to ${email}\n`);
  // bash ends both bodies at EF, then runs gh.
  for (const command of [
    'cat <<"E\\\nF"\nbody\nEF\ngh issue create --title t -F body.md',
    'cat <<E\\\nF\nbody\nEF\ngh issue create --title t -F body.md',
    "cat <<'E\\\nF'\nbody\nEF\ngh issue create --title t -F body.md",
  ]) assert.equal(post(command)?.id, 'unreadable-command', JSON.stringify(command));
  rmSync(join(postDir, 'body.md'));
});

test('a ~ word after -F or cd is trusted only as ~ or ~/, unquoted (#439)', () => {
  const secret = `write to ${email}\n`;
  for (const dir of ['~', join('sub', '~-')]) mkdirSync(join(postDir, dir), { recursive: true });
  // bash reads the file with the secret; the guard, reading $HOME or the cd folder, would find a clean one.
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  writeFileSync(join(postDir, '~', 'body.md'), secret);
  writeFileSync(join(postDir, 'sub', '~-', 'body.md'), secret);
  const refused = (commands: string[]) => {
    for (const command of commands) assert.notEqual(post(command), null, JSON.stringify(command));
  };
  refused([
    "gh issue create --title t -F '~/body.md'",
    'gh issue create --title t -F "~/body.md"',
    "gh issue create --title t -F ~'/body.md'",
    "cd sub && gh issue create --title t -F '~-/body.md'",
    'gh issue create --title t -F ~+/body.md',
    'gh issue create --title t -F ~root/body.md',
    'gh issue create --title t -F ~1/body.md',
    "cd '~' && gh issue create --title t -F body.md",
  ]);
  // `~-` is the folder before the cd: bash reads ./body.md, not sub/~-/body.md.
  writeFileSync(join(postDir, 'body.md'), secret);
  writeFileSync(join(postDir, 'sub', '~-', 'body.md'), 'clean\n');
  refused(['cd sub; gh issue create --title t -F ~-/body.md']);
  // Control: a plain ~ and ~/ are $HOME, and the file there is read.
  assert.equal(post('cd ~ && gh issue create --title t -F ~/body.md')?.id, 'email');
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  assert.equal(post('cd ~ && gh issue create --title t -F ~/body.md'), null);
  for (const dir of ['~', 'sub', 'body.md']) rmSync(join(postDir, dir), { recursive: true, force: true });
});

test('inside "...", only $, backticks, \\ and ! make the line unsure (#439)', () => {
  const literal = [
    'gh issue create --title "Fix #12" -F body.md',
    'echo "a#b"; gh issue create --title t -F body.md',
    'echo "it\'s"; gh issue create --title t -F body.md',
    'echo hi; gh issue create --title "a (b) <c> {d} | e & f * ? [g] ~h" -F body.md',
  ];
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  for (const command of literal) assert.equal(post(command), null, JSON.stringify(command));
  // The file is read: a mark in it is found.
  writeFileSync(join(postDir, 'body.md'), 'Seen in QuietVale.\n');
  for (const command of literal) assert.equal(post(command)?.id, 'private-mark', JSON.stringify(command));
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  for (const command of [
    'echo "a$b"; gh issue create --title t -F body.md',
    'echo "a`b`"; gh issue create --title t -F body.md',
    'echo "a\\b"; gh issue create --title t -F body.md',
    'echo "a!b"; gh issue create --title t -F body.md',
    'true 2>/dev/null; gh issue create --title t -F body.md',
  ]) assert.equal(post(command)?.id, 'unreadable-command', JSON.stringify(command));
  rmSync(join(postDir, 'body.md'));
});

// ---- A read-only pipe after a post (#498) ----
//
// `bot -- gh … --body-file <full path> 2>&1 | tail -2` was refused, and the message named
// the file, not the pipe. A pipe at the end into a program that only reads now passes.

test('a pipe at the end into tail, head, grep, sed s/// and the like still reads the body file (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title "fix: a plain title" --body-file ${body}`;
  const passes = [
    `${bot} 2>&1 | tail -2`,
    `${bot} | tail -2`,
    `${bot} | sed "s/x/y/g"`,
    `${bot} 2>&1 | sed "s/someone/<owner>/g" | tail -2`,
    `${bot} | sed -n -e 's|a|b|gp' -e 's/c/d/'`,
    `${bot} | grep -v x | head -n 5 | cut -c1-80 | wc -l`,
    `${bot} | sort -rk2,2 | uniq -c | tr a-z A-Z`,
    `${bot} 2>&1`,
    `cd ${postDir} && ${bot} | tail -2`,
  ];
  for (const command of passes) assert.equal(post(command), null, command);
  // The file is still read: a mark in it is found through the pipe.
  writeFileSync(body, 'Seen in QuietVale.\n');
  for (const command of passes) assert.equal(post(command)?.id, 'private-mark', command);
  rmSync(body);
});

test('a pipe or a command that may change the body file is refused, by name (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  const refused: [string, string][] = [
    [`${bot} | tee ${body}`, 'a pipe to `tee`'],
    [`${bot} | sed -i s/x/y/ ${body}`, 'a `sed` with `-i`'],
    [`${bot} | sed --in-place s/x/y/ ${body}`, 'a `sed` with `-i`'],
    [`${bot} | sed 's/x/y/w ${body}'`, 'a `sed` with `-i`'],
    [`${bot} | sed 's/x/y/e'`, 'a `sed` with `-i`'],
    [`${bot} | sed -f script.sed`, 'a `sed` with `-i`'],
    [`${bot} | sort -o ${body}`, 'a `sort` with an option'],
    [`${bot} | sort "$X"`, 'a `sort` with an option'],
    [`${bot} | uniq - ${body}`, 'a `uniq` with a second file'],
    [`${bot} | tail -2 > ${body}`, 'a pipe to `tail` that does not end the line'],
    [`${bot} | tail -2; cd /tmp`, 'a pipe to `tail` that does not end the line'],
    [`${bot} | tail -2 | grep "$(id)"`, 'a pipe to `tail` that does not end the line'],
    [`${bot} | grep "\${X}"`, 'a pipe to `grep` that does not end the line'],
    [`${bot} | xargs tail`, 'a pipe to `xargs`'],
    [`${bot} | (cat > ${body})`, 'a pipe'],
    [`${bot} |& tail -2`, 'a pipe'],
    [`${bot} || tail -2`, 'a `||`'],
    [`echo x | tail -2; ${bot}`, 'a pipe to `tail` that does not end the line'],
    [`cd sub && gh pr create --title t --body-file ../piped.md | tail -2`, 'a `cd` before a path with `..`'],
    [`cd -; ${bot}`, 'a `cd` the guard can'],
    [`mv a.md ${body}; ${bot} | tail -2`, 'a `mv`'],
    [`export A=1 B=2; ${bot}`, 'an `export` of a name other than GH_REPO'],
    [`OWNER=$(gh pr view 3 -q .x); ${bot}`, 'a command substitution `$(…)`'],
    [`[ -n x ] || exit 1; ${bot}`, 'a `[ … ]` test'],
    [`${bot} > ${body}`, 'a redirect `>`'],
    [`${bot} 2>&1 > ${body}`, 'a redirect `>`'],
    [`X=1 ${bot}`, 'a variable other than GH_REPO'],
  ];
  for (const [command, saw] of refused) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.ok(f?.what.includes(`and ${saw}`), `${command}: ${f?.what}`);
    assert.ok(f?.fix.startsWith(`leave out ${saw}`), `${command}: ${f?.fix}`);
    assert.match(f?.fix ?? '', /write the file in one command, then post it in the next/);
  }
  rmSync(body);
});

test('a `$` anywhere in a sed after the post is refused: bash fills it in before sed reads the script (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  for (const command of [
    `${bot} 2>&1 | sed "s/$OWNER/<owner>/g" | tail -2`,
    `${bot} | sed "s/x/$NAME/"`,
    `${bot} | sed -e "s/x/y/$FLAGS"`,
    `${bot} | sed "$S"`,
    `${bot} | sed s/x/y/ "$F"`,
    `${bot} | sed 's/x$/y/'`,
    `${bot} | sed "s/$(id)/x/"`,
    `${bot} | sed "s/\${X}/x/"`,
  ]) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.ok(f?.what.includes('and a `$` value in a `sed` command in this command'), `${command}: ${f?.what}`);
    assert.equal(f?.fix, 'type the value into the sed script in place of the `$`, or leave out the pipe, or write the file in one command, then post it in the next, and give its full path');
  }
  // grep may take a value: it writes no file whatever the value holds.
  assert.equal(post(`${bot} | grep -v "$OWNER"`), null);
  rmSync(body);
});

test('a refusal never names a program that holds a private mark (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  const named = [
    [`${bot} | quietvale-tool x`, 'a pipe'],
    [`${bot} | /opt/QuietVale/bin/send`, 'a pipe to `send`'],
    [`quietvale-tool x; ${bot}`, 'a command'],
    [`QuietVale x; ${bot}`, 'a command'],
  ];
  for (const [command, saw] of named) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.ok(f?.what.includes(`and ${saw} in this command`), `${command}: ${f?.what}`);
    assert.ok(!/quietvale/i.test(formatFinding(f)), `${command}: the mark is never printed`);
  }
  // Control: a program with no mark in it is named.
  assert.ok(post(`${bot} | tee x`)?.what.includes('a pipe to `tee`'));
  assert.ok(post(`othertool x; ${bot}`)?.what.includes('a `othertool`'));
  rmSync(body);
});

test('a project allow still applies through a read-only pipe, and not through any other (#498)', () => {
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const command = 'gh issue create --title "check: fix a bug" --body "QuietVale ships"';
  assert.equal(post(`${command} 2>&1 | tail -2`, allowing), null);
  assert.equal(post(`${command} | sed "s/someone/<owner>/g"`, allowing), null);
  assert.equal(post(`${command} | grep -v "$OWNER"`, allowing), null);
  // A `$` in a sed, in any quotes, is not a read-only pipe: no allow, as on the body-file path.
  for (const sed of ['sed "s/$OWNER/<owner>/g"', "sed 's/x$/y/'", 'tail -2 | sed -e "s/x/$Y/"']) {
    assert.equal(post(`${command} | ${sed}`, allowing)?.id, 'private-mark', sed);
  }
  assert.equal(post(`${command} | tee out.txt`, allowing)?.id, 'private-mark');
  assert.equal(post(`${command} | tail -2; true`, allowing)?.id, 'private-mark');
});

test('a ~/ path to yokoten and the allowed variables before it still read the body file (#498)', () => {
  const body = join(postDir, 'c-505.md');
  writeFileSync(body, 'All clean.\n');
  const comment = `bot -- gh issue comment 505 --body-file ${body}`;
  const passes = [
    `NODE_USE_ENV_PROXY=1 GH_REPO=o/r node ~/x/yokoten/bin/yokoten.ts ${comment}`,
    `node ~/x/yokoten/bin/yokoten.ts ${comment}`,
    `node ~/yokoten.mjs ${comment} | tail -2`,
    `~/x/bin/yokoten ${comment}`,
    `NODE_USE_ENV_PROXY=1 GH_REPO=o/r node bin/yokoten.ts ${comment}`,
    `node /opt/x/bin/yokoten.ts ${comment}`,
  ];
  for (const command of passes) assert.equal(post(command), null, command);
  writeFileSync(body, 'Seen in QuietVale.\n');
  for (const command of passes) assert.equal(post(command)?.id, 'private-mark', command);
  writeFileSync(body, 'All clean.\n');
  // A ~ elsewhere, a quoted ~, a ~ that is not $HOME, or another program stays refused.
  for (const command of [
    `node ~/x/bin/other.ts ${comment}`,
    `node '~/x/bin/yokoten.ts' ${comment}`,
    `node ~root/bin/yokoten.ts ${comment}`,
    `node ~/x/bin/yokoten.ts ~/y ${comment}`,
    `echo ~/x/bin/yokoten.ts bot -- x; gh issue comment 505 --body-file ${body}`,
  ]) assert.equal(post(command)?.id, 'unreadable-command', command);
  // `~root` is another user's home: the guard can't tell which yokoten runs there, so it says so.
  const root = post(`node ~root/bin/yokoten.ts ${comment}`);
  assert.ok(root?.what.includes('and a `~` that may not be your home folder in this command'), root?.what);
  // A variable outside GH_REPO, GH_HOST and NODE_USE_ENV_PROXY reaches node and gh: refused, by name.
  const other = post(`A=1 node bin/yokoten.ts ${comment}`);
  assert.ok(other?.what.includes('a variable other than GH_REPO'), other?.what);
  rmSync(body);
});

test('a project allow still applies after NODE_USE_ENV_PROXY=1 and a ~/ yokoten (#498)', () => {
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const comment = 'bot -- gh issue create --title "check: fix a bug" --body "QuietVale ships"';
  assert.equal(post(`NODE_USE_ENV_PROXY=1 node ~/x/bin/yokoten.ts ${comment}`, allowing), null);
  assert.equal(post(`NODE_USE_ENV_PROXY=1 node bin/yokoten.ts ${comment} 2>&1 | tail -2`, allowing), null);
  // GH_REPO names another target, and any other variable is not trusted: no allow.
  assert.equal(post(`GH_REPO=o/r node bin/yokoten.ts ${comment}`, allowing)?.id, 'private-mark');
  assert.equal(post(`GH_HOST=example.com node bin/yokoten.ts ${comment}`, allowing)?.id, 'private-mark');
  assert.equal(post(`NODE_USE_ENV_PROXY=1 GH_HOST=example.com node ~/x/bin/yokoten.ts ${comment}`, allowing)?.id, 'private-mark');
  assert.equal(post(`A=1 node bin/yokoten.ts ${comment}`, allowing)?.id, 'private-mark');
  assert.equal(post(`NODE_USE_ENV_PROXY=$X node bin/yokoten.ts ${comment}`, allowing)?.id, 'private-mark');
});

test('a lone post trusts the same yokoten paths as the body-file path (#506)', () => {
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const comment = 'bot -- gh issue create --title "check: fix a bug" --body "QuietVale ships"';
  for (const program of ['yokoten', 'node bin/yokoten.ts', 'node ./bin/yokoten.mjs', 'node ~/x/bin/yokoten.ts', '~/x/bin/yokoten', 'node ~/yokoten.mjs', 'node /opt/x/bin/yokoten.ts']) {
    assert.ok(lonePost(`${program} ${comment}`), program);
    assert.equal(post(`${program} ${comment}`, allowing), null, program);
  }
  // `~other`, `~+` and `~-` are not your home: no lone post, so no allow.
  for (const program of ['node ~other/bin/yokoten.ts', '~other/x/yokoten', 'node ~+/bin/yokoten.ts', 'node ~-/bin/yokoten.ts', 'node ~/x/bin/yokoten.js']) {
    assert.equal(lonePost(`${program} ${comment}`), null, program);
    assert.equal(post(`${program} ${comment}`, allowing)?.id, 'private-mark', program);
  }
});

test('reading a pipe at the end stays linear (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  assertLinear(
    'many read-only pipes',
    (n) => `gh pr create --title t --body-file ${body}${' | tail -2'.repeat(n / 10)}`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'blanks before 2>&1',
    (n) => `gh pr create --title t --body-file ${body}${' '.repeat(n)}2>&1${' '.repeat(n)}`,
    (command) => assert.equal(post(command), null),
  );
  rmSync(body);
});

// ---- A project allows its own name (#424) ----

test('ownMarks and scanText: a mark the project allows, same string case aside, is not reported (#424)', () => {
  const marks = ['quietvale', 'quietvale labs', 'vale'];
  assert.deepEqual(ownMarks(marks, ['QuietVale']), ['quietvale']);
  const hits = (text: string, allow: string[]) => scanText(text, { file: 'a', marks: ['quietvale'], allow }).length;
  assert.equal(hits('QuietVale ships', ['QUIETVALE']), 0, 'case does not matter');
  assert.equal(hits('QuietVale ships', []), 1, 'with no allow, it is stopped');
  // Near misses: a part, a longer string, or spaces around it allow nothing.
  for (const allow of [['quiet'], ['quietvale2'], ['quietvale labs'], [' quietvale'], ['quietval'], ['xquietvale']]) {
    assert.equal(hits('QuietVale ships', allow), 1, JSON.stringify(allow));
  }
  // Allowing one mark leaves the longer and shorter marks that hold it.
  const all = (text: string) => scanText(text, { file: 'a', marks, allow: ['quietvale'] }).length;
  assert.equal(all('QuietVale ships from the vale'), 1, 'the shorter mark vale still matches');
  assert.equal(all('QuietVale Labs ships'), 2, 'quietvale labs still matches, and so does vale after a small letter (#434)');
  const finding = scanText('QuietVale Labs', { file: 'a', marks, allow: ['quietvale'] }).map((f) => formatFinding(f)).join('\n');
  assert.ok(!/quietvale|vale/i.test(finding), 'no mark is printed');
});

test('checkPost: the project that allows the mark posts; another project with the same marks file is stopped (#424)', () => {
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const command = 'gh issue create --title "check: fix a bug" --body "QuietVale ships"';
  assert.equal(post(command, allowing), null);
  const stopped = post(command);
  assert.equal(stopped?.id, 'private-mark');
  assert.ok(!/quietvale/i.test(formatFinding(stopped)), 'the mark is never printed');
  // A near miss in privacy.allow allows nothing.
  assert.equal(post(command, { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVal'] } })?.id, 'private-mark');
});

// ---- The machine allows a mark in one repo (#447) ----

test('normalizeRemote: host and path, with no scheme, user info, default port or .git; the host case aside (#447)', () => {
  for (const url of [
    'https://example.com/octo/app',
    'https://someone:secret@Example.COM:443/octo/app.git',
    'ssh://git@EXAMPLE.com:22/octo/app.git/',
    'git@example.com:octo/app.git',
    'example.com:octo/app',
    '  git://example.com/octo/app/  ',
  ]) {
    assert.equal(normalizeRemote(url), 'example.com/octo/app', url);
  }
  assert.equal(normalizeRemote('https://example.com:8443/octo/app.git'), 'example.com:8443/octo/app', 'another port is another server');
  assert.equal(normalizeRemote('ssh://git@example.com:2222/octo/app'), 'example.com:2222/octo/app');
  assert.equal(normalizeRemote('https://example.com/Octo/App'), 'example.com/Octo/App', 'the path keeps its case');
  // A local path is the folder itself: absolute, and a relative one against the repo's top folder.
  const base = makeTempDir('yokoten-remote-');
  mkdirSync(join(base, 'one'));
  mkdirSync(join(base, 'two'));
  assert.equal(normalizeRemote('/srv/git/app.git'), '/srv/git/app.git');
  assert.equal(normalizeRemote('file:///srv/git/app.git'), '/srv/git/app.git');
  assert.equal(normalizeRemote('../up.git', join(base, 'one')), join(realpathSync(base), 'up.git'));
  // Through a link to a folder, for a path that doesn't exist yet: one key, as on macOS's /var.
  symlinkSync(join(base, 'one'), join(base, 'link'));
  assert.equal(normalizeRemote(join(base, 'link', 'gone', 'up.git')), join(realpathSync(base), 'one', 'gone', 'up.git'));
  assert.notEqual(normalizeRemote('../x', join(base, 'one', 'a')), normalizeRemote('../x', join(base, 'two', 'a')), 'the same relative path from another folder is another repo');
  assert.equal(normalizeRemote('../x'), null, 'a relative path with no base is unread');
  assert.ok(!normalizeRemote('C:/git/app.git', base)?.startsWith('c/'), 'a Windows drive is not a host');
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote('https://example.com'), null, 'a host with no path names no repo');
});

test('normalizeRemote: linear on long input (#447)', () => {
  const inputs: [string, (n: number) => string][] = [
    ['trailing slashes', (n) => `example.com:a${'/'.repeat(n)}x`],
    ['slashes only', (n) => `https://example.com/${'/'.repeat(n)}`],
    ['at signs', (n) => `${'a@'.repeat(n / 2)}:x`],
    ['colons', (n) => `${'a:'.repeat(n / 2)}`],
    ['no colon', (n) => 'a'.repeat(n)],
  ];
  // One call for every shape: a noisy first round grows to a 20 ms base (#594).
  assertLinearEach(inputs.map(([name, make]) => ({ name, make, read: (text: string) => normalizeRemote(text, '/base') })), 1 << 16);
});

/** git in `repo`, with `base` as its home and no global config. */
const allowGit = (base: string, repo: string) => (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), TZ: 'UTC' }, stdio: 'ignore' });

// The repo before its remote, built once per test process (#475).
const copyAllowRepo = makeRepoTemplate((repo) => {
  const git = allowGit(repo, repo);
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', `1+test${at}users.noreply.github.com`);
});

/** A repo with an origin remote, or none, and a marks file and an allow file beside it. */
function allowRepo(remote: string | null) {
  const base = makeTempDir('yokoten-allow-');
  const repo = join(base, 'repo');
  mkdirSync(repo);
  copyAllowRepo(repo);
  const git = allowGit(base, repo);
  if (remote) git('remote', 'add', 'origin', remote);
  const marks = join(base, 'private-marks');
  writeFileSync(marks, 'quietvale\nquietvale labs\n');
  const env: Env = { HOME: base, YOKOTEN_PRIVATE_MARKS: marks };
  const allow = (repos: unknown) => writeFileSync(machineAllowFile(env), typeof repos === 'string' ? repos : JSON.stringify({ repos }));
  return { base, repo, env, git, allow };
}

const TWO_ADDRESSES = { allow: [], unsure: 'the origin remote has more than one address' };

test('machineAllowed: the entry for this remote allows its marks; another remote, two entries or a bad file allow nothing (#447)', () => {
  const { repo, env, git, allow } = allowRepo('https://someone@Example.com/octo/app.git');
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: null }, 'no file: nothing, and not unsure');
  allow([{ remote: 'example.com/octo/app', allow: ['QuietVale'] }]);
  assert.deepEqual(machineAllowed(env, repo), { allow: ['quietvale'], unsure: null });
  assert.deepEqual(repoMarkKinds(env, repo).map((mark) => mark.value), ['quietvale labs'], 'the longer mark is still looked for');
  allow([{ remote: 'example.com/octo/app', folder: repo, allow: ['quietvale'] }]);
  assert.equal(machineAllowed(env, repo).unsure, "this machine's allow file is not in the shape yokoten writes", 'an old folder entry is refused');
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }, { remote: 'EXAMPLE.com/octo/app', allow: ['quietvale'] }]);
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: "two entries in this machine's allow file match this repo" });
  allow('{"repos": [quietvale');
  const bad = machineAllowed(env, repo);
  assert.deepEqual(bad.allow, []);
  assert.ok(bad.unsure && !/quietvale/i.test(bad.unsure), 'a broken file is unsure, and never quoted');
  allow([{ remote: 'example.com/octo/app', allow: 'quietvale' }]);
  assert.equal(machineAllowed(env, repo).unsure, "this machine's allow file is not in the shape yokoten writes");
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  assert.deepEqual(machineAllowed(env, null).allow, [], 'a guard that cannot tell where it runs allows nothing');
  git('remote', 'set-url', 'origin', 'https://example.com/octo/renamed.git');
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: null }, 'a renamed remote is no longer allowed');
});

test('machineAllowed: every fetch and push address of origin, as git rewrites them, must name the same repo (#447)', () => {
  const { repo, env, git, allow } = allowRepo('https://example.com/octo/app');
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  // A second fetch address of the same repo, in another form, is fine; of another repo, unsure.
  git('remote', 'set-url', '--add', 'origin', 'git@example.com:octo/app.git');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale']);
  git('remote', 'set-url', '--add', 'origin', 'https://example.com/octo/public');
  assert.deepEqual(machineAllowed(env, repo), TWO_ADDRESSES);
  git('remote', 'set-url', '--delete', 'origin', 'octo/public');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale']);
  // A push address elsewhere: a push goes there, so unsure.
  git('remote', 'set-url', '--push', 'origin', 'https://example.com/octo/public');
  assert.deepEqual(machineAllowed(env, repo), TWO_ADDRESSES);
  git('config', '--unset-all', 'remote.origin.pushurl');
  // insteadOf is applied, as git applies it: the short name reads as the repo it stands for.
  git('config', 'url.https://example.com/.insteadOf', 'ex:');
  git('config', '--unset-all', 'remote.origin.url');
  git('config', 'remote.origin.url', 'ex:octo/app');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale'], 'insteadOf names the allowed repo');
  git('config', 'url.https://example.com/octo/public.insteadOf', 'ex:octo/app');
  assert.deepEqual(machineAllowed(env, repo).allow, [], 'insteadOf to another repo is that repo');
  git('config', '--unset-all', 'url.https://example.com/octo/public.insteadOf');
  git('config', 'url.https://example.com/octo/public.pushInsteadOf', 'ex:octo/app');
  assert.deepEqual(machineAllowed(env, repo), TWO_ADDRESSES, 'pushInsteadOf to another repo is unsure');
});

test('machineAllowed: origin must be the only remote, with no gh default and no push elsewhere (#447)', () => {
  const { repo, env, git, allow } = allowRepo('https://example.com/octo/app');
  allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale']);
  const unsure = (why: string, label: string) => assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: why }, label);
  git('remote', 'add', 'upstream', 'https://example.com/octo/app');
  unsure('this repo has a remote other than origin', 'a second remote, even to the same repo: gh may pick it');
  git('remote', 'remove', 'upstream');
  git('config', 'remote.origin.gh-resolved', 'base');
  unsure('gh is set to a repo of its own (gh repo set-default)', 'gh-resolved');
  git('config', '--unset', 'remote.origin.gh-resolved');
  git('config', 'remote.pushDefault', 'origin');
  unsure('a push may go to another remote (remote.pushDefault or branch.*.pushRemote)', 'remote.pushDefault');
  git('config', '--unset', 'remote.pushDefault');
  git('config', 'branch.main.pushRemote', 'origin');
  unsure('a push may go to another remote (remote.pushDefault or branch.*.pushRemote)', 'branch.*.pushRemote');
  git('config', '--unset', 'branch.main.pushRemote');
  assert.deepEqual(machineAllowed(env, repo).allow, ['quietvale'], 'back to one plain origin');
  git('remote', 'remove', 'origin');
  assert.deepEqual(machineAllowed(env, repo), { allow: [], unsure: null }, 'no origin: no machine allow, and nothing unsure');
  git('remote', 'add', 'other', 'https://example.com/octo/app');
  unsure('this repo has a remote other than origin', 'only a remote with another name');
});

test('checkPost: the allow applies only to a post to the repo the command runs in (#447)', () => {
  const own = allowRepo('https://example.com/octo/app');
  const other = allowRepo('https://example.com/octo/other');
  own.allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  // The other repo reads the same allow file.
  const env = own.env;
  const body = '--title "check: fix a bug" --body "QuietVale ships"';
  const post = (command: string, cwd: string, { config, extra = {} }: { config?: typeof DEFAULTS; extra?: Env } = {}) => checkCommand(command, { env: { ...env, ...extra }, config, cwd });
  assert.equal(post(`gh issue create ${body}`, own.repo), null, 'with no yokoten.json, the guard lets it through');
  const stopped = post(`gh issue create ${body}`, other.repo);
  assert.equal(stopped?.id, 'private-mark');
  assert.ok(!/quietvale/i.test(formatFinding(stopped)), 'the mark is never printed');
  assert.equal(post(`gh issue create ${body.replace('QuietVale', 'QuietVale Labs')}`, own.repo)?.id, 'private-mark', 'the longer mark is still stopped');
  // A post that names another target gets no allow, from the machine or from yokoten.json (#424).
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const targets: [string, Env?][] = [
    [`gh issue create -R octo/public ${body}`],
    [`gh issue create --repo=octo/public ${body}`],
    [`gh -R octo/public issue comment 1 ${body}`],
    [`GH_REPO=octo/public gh issue create ${body}`],
    [`env GH_HOST=example.org gh issue create ${body}`],
    [`gh issue create ${body}`, { GH_REPO: 'octo/public' }],
    [`gh issue comment https://example.com/octo/public/issues/1 ${body}`],
    ['gh api repos/octo/app/issues -f body="QuietVale ships"'],
    [`cd ${own.repo} && gh issue comment 1 -R octo/public ${body}`],
    // Anything else on the line could change where gh posts before it runs (record 0014).
    [`gh repo set-default octo/public && gh issue create ${body}`],
    [`git remote set-url origin https://example.com/octo/public && gh issue create ${body}`],
    [`git remote add upstream https://example.com/octo/public; gh issue create ${body}`],
    [`git push upstream main && gh pr create ${body}`],
    [`git push -u origin main && gh pr create ${body}`],
    [`env -C ${other.repo} gh issue create ${body}`],
    [`GIT_COMMON_DIR=${other.repo}/.git gh issue create ${body}`],
    [`printf '[remote "origin"]\\n\\turl = https://example.com/octo/public\\n' >> .git/config && gh issue create ${body}`],
    [`sed -i s/app/public/ .git/config && gh issue create ${body}`],
    [`cp ${other.repo}/.git/config .git/config; gh issue create ${body}`],
    [`g=git; $g remote set-url origin https://example.com/octo/public && gh issue create ${body}`],
    [`$(echo git) remote set-url origin https://example.com/octo/public && gh issue create ${body}`],
    [`echo origin | xargs git remote remove && gh issue create ${body}`],
    [`sudo gh issue create ${body}`],
    [`(gh issue create ${body})`],
    [`gh issue create ${body} | cat`],
    [`gh issue create --title "x $(git remote remove origin)" --body "QuietVale ships"`],
    [`gh issue create --title x --body-file - <<EOF\nQuietVale ships $(git remote remove origin)\nEOF`],
    [`gh issue create --title x --body-file - <<'EOF'\nQuietVale ships\nEOF\ngit remote remove origin`],
    [`cd ${other.repo} && gh issue create ${body}`],
  ];
  for (const [command, extra] of targets) {
    assert.equal(post(command, own.repo, { extra })?.id, 'private-mark', `machine: ${command}`);
    assert.equal(post(command, own.repo, { config: allowing, extra })?.id, 'private-mark', `privacy.allow: ${command}`);
  }
  // The lone post keeps both allows, and so does a cd within the same repo, the bot's form and a quoted heredoc.
  for (const repo of [own.repo, other.repo]) mkdirSync(join(repo, 'sub'), { recursive: true });
  for (const command of [
    `gh issue create ${body}`,
    `cd ./sub && gh issue create ${body}`,
    `yokoten bot -- gh issue create ${body}`,
    `gh issue create --title x --body-file - <<'EOF'\nQuietVale ships\nEOF`,
  ]) {
    assert.equal(post(command, own.repo), null, `machine: ${command}`);
    assert.equal(post(command, other.repo, { config: allowing }), null, `privacy.allow: ${command}`);
  }
  assert.equal(post(`cd ${own.repo} && gh issue create ${body}`, other.repo)?.id, 'private-mark', 'a cd into another repo gets no allow');
});

test('lonePost: linear on long input (#447)', () => {
  const inputs: [string, (n: number) => string][] = [
    ['quotes', (n) => `gh issue create --body "${'a'.repeat(n)}`],
    ['escapes', (n) => `gh issue create ${'\\'.repeat(n)}`],
    ['heredoc lines', (n) => `gh issue create --body-file - <<'EOF'\n${'x\n'.repeat(n / 2)}`],
    ['a long cd', (n) => `cd ${'a'.repeat(n)} gh`],
    ['a long bot path', (n) => `${'a/'.repeat(n / 2)}yokoten bot -- x`],
  ];
  for (const [name, make] of inputs) assertLinear(name, make, (text) => lonePost(text));
});

test('lonePost: refuses what bash reads differently from the guard (#447)', () => {
  // ANSI-C quoting: bash reads $'\'' as one quote, so `echo PWNED` runs.
  assert.equal(lonePost(`gh issue comment 1 -b $'\\'' ; echo PWNED ; echo '`), null, "$'…'");
  assert.equal(lonePost('gh issue comment 1 -b $"x"'), null, '$"…"');
  // A redirect writes a file.
  assert.equal(lonePost('gh issue comment 1 -b hi > ~/.config/gh/hosts.yml'), null, '>');
  for (const redirect of ['>> f', '>| f', '&> f', '2> f']) assert.equal(lonePost(`gh issue comment 1 -b hi ${redirect}`), null, redirect);
  // The plain forms stay allowed: quoted text, a quoted > and a quoted heredoc.
  assert.deepEqual(lonePost('gh issue comment 1 -b "a > b; c" --title \'x | y $HOME\''), { cd: false });
  assert.deepEqual(lonePost("gh issue create --title x --body-file - <<'EOF'\na > b\nEOF"), { cd: false });
  assert.deepEqual(lonePost('gh issue comment 1 -b "hello world"'), { cd: false });
});

test('checkPost: a bare relative cd is unsure because of CDPATH, so no allow applies (#447)', () => {
  const own = allowRepo('https://example.com/octo/app');
  own.allow([{ remote: 'example.com/octo/app', allow: ['quietvale'] }]);
  mkdirSync(join(own.repo, 'sub'), { recursive: true });
  const body = '--title "check: fix a bug" --body "QuietVale ships"';
  const post = (command: string, extra: Env) => checkCommand(command, { env: { ...own.env, ...extra }, cwd: own.repo });
  assert.equal(post(`cd sub && gh issue create ${body}`, {})?.id, 'private-mark', 'no CDPATH in env: still refused, the shell may set it');
  assert.equal(post(`cd sub && gh issue create ${body}`, { CDPATH: '' })?.id, 'private-mark', 'empty CDPATH: refused');
  assert.equal(post(`cd sub && gh issue create ${body}`, { CDPATH: '/elsewhere' })?.id, 'private-mark', 'CDPATH set: refused');
  assert.equal(post(`cd ./sub && gh issue create ${body}`, { CDPATH: '/elsewhere' }), null, './ is not searched');
  assert.equal(post(`cd ${join(own.repo, 'sub')} && gh issue create ${body}`, { CDPATH: '/elsewhere' }), null, 'absolute is not searched');
});

// ---- A mark never blocks the repo it names, with no setup (#447) ----

test('a mark that is the repo name is skipped there by default, in a post and in the commit check (#447)', () => {
  const marksOf = (remote: string | null) => {
    const r = allowRepo(remote);
    writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\nsecondmark\n');
    return r;
  };
  const body = '--title "check: fix a bug" --body "Quiet Vale ships"';
  const both = '--title "check: fix a bug" --body "Quiet Vale and SecondMark ship"';
  const post = (r: ReturnType<typeof allowRepo>, command: string, extra: Env = {}, cwd = r.repo) => checkCommand(command, { env: { ...r.env, ...extra }, cwd });
  const kept = (r: ReturnType<typeof allowRepo>, privacy?: { skipOwnName: boolean }) => repoMarkKinds(r.env, r.repo, privacy).map((mark) => mark.value);

  const named = marksOf('https://example.com/x/quiet-vale.git');
  assert.equal(post(named, `gh issue create ${body}`), null, 'a post in the repo the mark names passes');
  const second = post(named, `gh issue create ${both}`);
  assert.equal(second?.id, 'private-mark', 'a second mark is still refused');
  assert.ok(!/quiet vale|secondmark/i.test(formatFinding(second)), 'no mark is printed');
  assert.deepEqual(kept(named), ['secondmark'], 'the commit check skips only that mark');

  for (const remote of ['https://example.com/x/other', 'https://example.com/x/quiet-vale-docs', 'https://example.com/quiet-vale/other']) {
    const r = marksOf(remote);
    assert.equal(post(r, `gh issue create ${body}`)?.id, 'private-mark', `post in ${remote}`);
    assert.deepEqual(kept(r), ['quiet vale', 'secondmark'], `commit check in ${remote}`);
  }
  // Case, - _ . and spaces do not matter; the whole name does.
  assert.equal(post(marksOf('git@example.com:x/QUIET_vale.git'), `gh issue create ${body}`), null);
  assert.equal(post(marksOf('https://example.com/x/quiet.vale'), `gh issue create ${body}`), null);

  // Unsure targets skip nothing.
  const two = marksOf('https://example.com/x/quiet-vale');
  two.git('remote', 'add', 'upstream', 'https://example.com/x/quiet-vale');
  assert.equal(post(two, `gh issue create ${body}`)?.id, 'private-mark', 'two remotes');
  assert.deepEqual(kept(two), ['quiet vale', 'secondmark'], 'two remotes, commit check');
  const none = marksOf(null);
  assert.equal(post(none, `gh issue create ${body}`)?.id, 'private-mark', 'no origin');
  assert.equal(post(named, `gh issue create ${body}`, { GH_REPO: 'x/other' })?.id, 'private-mark', 'GH_REPO elsewhere');
  assert.equal(post(named, `gh issue create -R x/other ${body}`)?.id, 'private-mark', '-R elsewhere');
  const elsewhere = marksOf('https://example.com/x/other');
  assert.equal(post(named, `cd ${elsewhere.repo} && gh issue create ${body}`)?.id, 'private-mark', 'cd into another repo');
  assert.equal(post(elsewhere, `cd ${named.repo} && gh issue create ${body}`)?.id, 'private-mark', 'cd out of the repo');

  // Only origin names the repo: CI's GITHUB_REPOSITORY is not read, so it can't be faked (#447).
  const stranger = marksOf('https://github.com/stranger/other');
  const ci = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'x/quiet-vale' };
  assert.deepEqual(repoMarkKinds({ ...stranger.env, ...ci }, stranger.repo).map((mark) => mark.value), ['quiet vale', 'secondmark'], 'a faked CI repo skips nothing');
  assert.equal(post(stranger, `gh issue create ${body}`, ci)?.id, 'private-mark', 'a faked CI repo, in a post');
  assert.deepEqual(kept(none), ['quiet vale', 'secondmark'], 'no origin, no CI fallback');
});

test('the same-name match keeps word breaks: Li Na is not lina (#447)', () => {
  const repoFor = (remote: string, marks: string) => {
    const r = allowRepo(remote);
    writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, marks);
    return r;
  };
  const names = (r: ReturnType<typeof allowRepo>) => repoMarkKinds(r.env, r.repo).map((mark) => mark.value);
  for (const remote of ['https://example.com/x/quiet-vale', 'https://example.com/x/Quiet_Vale', 'https://example.com/x/quiet.vale', 'https://example.com/x/QUIET-VALE.git']) {
    assert.deepEqual(names(repoFor(remote, 'Quiet Vale\n')), [], `Quiet Vale names ${remote}`);
  }
  assert.deepEqual(names(repoFor('https://example.com/x/lina', 'Li Na\n')), ['li na'], 'a separator is never taken out');
  assert.deepEqual(names(repoFor('https://example.com/x/li-na', 'Li Na\n')), [], 'Li Na names li-na');
  assert.deepEqual(names(repoFor('https://example.com/x/li-na', 'LiNa\n')), ['lina'], 'LiNa is not li-na');
  assert.deepEqual(names(repoFor('https://example.com/x/quietvale', 'quiet vale\n')), ['quiet vale']);
  const r = repoFor('https://example.com/x/lina', 'li na\n');
  assert.equal(checkCommand('gh issue create --title "check: fix" --body "Li Na ships"', { env: r.env, cwd: r.repo })?.id, 'private-mark', 'in a post too');
});

test('an origin address that may hide the repo skips nothing and allows nothing (#447)', () => {
  const body = '--title "check: fix a bug" --body "Quiet Vale ships"';
  for (const remote of ['https://github.com/o/r?x=/quiet-vale', 'https://github.com/o/r#/quiet-vale', 'git@github.com:o/r/quiet-vale', 'https://github.com/o/r/quiet-vale.git', 'ssh://git@github.com/o/r/quiet-vale', 'https://github.com/o/quiet-vale/']) {
    const r = allowRepo(remote);
    writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
    assert.deepEqual(repoMarkKinds(r.env, r.repo).map((mark) => mark.value), ['quiet vale'], `commit check, ${remote}`);
    assert.equal(checkCommand(`gh issue create ${body}`, { env: r.env, cwd: r.repo })?.id, 'private-mark', `post, ${remote}`);
    r.allow([{ remote: normalizeRemote(remote), allow: ['quiet vale'] }]);
    const machine = machineAllowed(r.env, r.repo);
    assert.deepEqual(machine.allow, [], `machine allow, ${remote}`);
    assert.ok(machine.unsure, `unsure, ${remote}`);
  }
  // The plain forms still name the repo.
  for (const remote of ['https://github.com/o/quiet-vale', 'https://github.com/o/quiet-vale.git', 'git@github.com:o/quiet-vale.git', 'ssh://git@github.com:22/o/quiet-vale']) {
    const r = allowRepo(remote);
    writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
    assert.deepEqual(repoMarkKinds(r.env, r.repo).map((mark) => mark.value), [], `skipped, ${remote}`);
  }
  // A local folder as origin: no same-name skip, but the machine allow still works.
  const mirror = makeTempDir('yokoten-mirror-');
  const bare = join(mirror, 'quiet-vale');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', HOME: mirror }, stdio: 'ignore' });
  const local = allowRepo(bare);
  writeFileSync(local.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
  assert.deepEqual(repoMarkKinds(local.env, local.repo).map((mark) => mark.value), ['quiet vale'], 'a local folder named like the mark is not skipped');
  assert.equal(checkCommand(`gh issue create ${body}`, { env: local.env, cwd: local.repo })?.id, 'private-mark');
  local.allow([{ remote: realpathSync(bare), allow: ['quiet vale'] }]);
  assert.deepEqual(machineAllowed(local.env, local.repo), { allow: ['quiet vale'], unsure: null }, 'the machine allow keeps working for a local origin');
});

test('the same-name skip has a way back: privacy.skipOwnName in yokoten.json, and skipOwnName in the machine allow file (#447, record 0014)', () => {
  const own = allowRepo('https://example.com/x/quiet-vale');
  writeFileSync(own.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
  const body = '--title "check: fix a bug" --body "Quiet Vale ships"';
  const names = (privacy?: { skipOwnName: boolean }) => repoMarkKinds(own.env, own.repo, privacy).map((mark) => mark.value);
  const post = (config = DEFAULTS) => checkCommand(`gh issue create ${body}`, { env: own.env, cwd: own.repo, config })?.id ?? null;
  const off = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, skipOwnName: false } };
  const on = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, skipOwnName: true } };
  assert.equal(DEFAULTS.privacy.skipOwnName, true, 'on by default');
  assert.deepEqual(names(), [], 'on: skipped');
  assert.equal(post(), null, 'on: the post passes');
  assert.deepEqual(names({ skipOwnName: false }), ['quiet vale'], 'off in yokoten.json: looked for');
  assert.equal(post(off), 'private-mark', 'off in yokoten.json: the post is stopped');
  assert.deepEqual(names({ skipOwnName: true }), [], 'on again');
  assert.equal(post(on), null);
  // The machine's own switch, for every repo here.
  writeFileSync(machineAllowFile(own.env), JSON.stringify({ skipOwnName: false, repos: [] }));
  assert.deepEqual(names(), ['quiet vale'], 'off on this machine');
  assert.equal(post(on), 'private-mark', 'off on this machine wins over yokoten.json');
  writeFileSync(machineAllowFile(own.env), JSON.stringify({ skipOwnName: true, repos: [] }));
  assert.deepEqual(names(), [], 'on again on this machine');
  writeFileSync(machineAllowFile(own.env), JSON.stringify({ skipOwnName: 'no', repos: [] }));
  assert.deepEqual(names(), ['quiet vale'], 'an allow file yokoten cannot read skips nothing');
  assert.equal(machineAllowed(own.env, own.repo).unsure, "this machine's allow file is not in the shape yokoten writes");
});

test('checkPost: a quoted ~ in cd is not your home, so no allow applies (#447)', () => {
  const r = allowRepo('https://example.com/x/quiet-vale');
  writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
  const body = '--title "check: fix a bug" --body "Quiet Vale ships"';
  const post = (command: string) => checkCommand(command, { env: r.env, cwd: r.repo })?.id ?? null;
  // The repo is ~/repo here: the unquoted form names it, and the post passes.
  assert.equal(post(`cd ~/repo && gh issue create ${body}`), null, 'unquoted ~/');
  for (const target of ['"~/repo"', "'~/repo'", '"~"', '~repo']) {
    assert.equal(post(`cd ${target} && gh issue create ${body}`), 'private-mark', `cd ${target}`);
  }
  assert.equal(post(`cd "~/quiet-vale" && gh issue create ${body}`), 'private-mark', 'the reviewer\'s input');
  assert.equal(post(`cd "./" && gh issue create ${body}`), null, 'a quoted ./ still names a folder here');
});

test('lonePost: refuses ${ wherever bash expands it (#447)', () => {
  for (const command of [
    'gh issue create --title "${ cd ../other; }" --body x',
    'gh issue create --title "${| cd ../other; }" --body x',
    'gh issue create --title "${HOME}" --body x',
    'gh issue create --title ${x} --body x',
    'gh issue create --body x <<<"${ cd ..; }"',
    'gh issue create --title x --body-file - <<EOF\n${ cd ../other; }\nEOF',
  ]) assert.equal(lonePost(command), null, command);
  // Single quotes and a quoted heredoc keep it as text.
  assert.deepEqual(lonePost("gh issue create --title '${ cd ../other; }' --body x"), { cd: false });
  assert.deepEqual(lonePost("gh issue create --title x --body-file - <<'EOF'\n${ cd ../other; }\nEOF"), { cd: false });
  assert.equal(lonePost('gh issue create --title "\\${x}" --body x'), null, 'a backslash in double quotes is refused too');
  const r = allowRepo('https://example.com/x/quiet-vale');
  writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
  assert.equal(checkCommand('gh issue create --title "${ cd ../other; }" --body "Quiet Vale ships"', { env: r.env, cwd: r.repo })?.id, 'private-mark');
  assert.equal(checkCommand("gh issue create --title '${ cd ../other; }' --body \"Quiet Vale ships\"", { env: r.env, cwd: r.repo }), null, 'the control: single quotes pass');
});

test('lonePost: trusts only plain characters outside quotes, so no shell feature can hide a target (#447)', () => {
  for (const command of [
    'gh issue comment 1 {--repo,stranger/public} --body "Quiet Vale"', // brace expansion: bash reads --repo stranger/public
    'gh issue comment 1 --body x{a..b}',
    'gh issue comment 1 --body-file note*.md',
    'gh issue comment 1 --body-file note?.md',
    'gh issue comment 1 --body-file [n]ote.md',
    'gh issue comment 1 $R --body x',
    'gh issue comment 1 --body "$R"',
    'gh issue comment 1 --body "a`b`"',
    'gh issue comment 1 --body "a\\"b"',
    'gh issue comment 1 \\--repo x/y --body x',
    'gh issue comment 1 --body x \\\n--repo x/y',
    'gh issue comment 1 --body ~stranger',
    'gh issue comment 1 --body !x',
    'gh issue comment 1 --body x # --repo',
    'gh issue comment 1 --body x\r',
    'gh issue comment 1 --body x < note.md',
    'gh issue comment 1 --body x & gh issue comment 2',
    'cd ~/a~b && gh issue comment 1 --body x',
    'cd {a,b} && gh issue comment 1 --body x',
  ]) assert.equal(lonePost(command), null, JSON.stringify(command));
  // The control: a plain post with quoted text, a ~ cd target, a here-string and a heredoc still pass.
  assert.deepEqual(lonePost('gh issue comment 1 --body "Quiet Vale ships {a,b} *.md !x #1" --title \'$R {x}\''), { cd: false });
  assert.deepEqual(lonePost('cd ~/repo && gh issue comment 1 --body "ok"'), { cd: true, target: '~/repo' });
  assert.deepEqual(lonePost('gh issue comment 1 -F - <<< "ok"'), { cd: false });
  assert.equal(lonePost('gh issue create --title x --body-file - <<-EOF\n\tbody $HOME\n\tEOF'), null, 'an unquoted heredoc end word');
  assert.deepEqual(lonePost("gh issue create --title x --body-file - <<-'EOF'\n\tbody $HOME\n\tEOF"), { cd: false });
  // In a post: the brace form gets no allow, the plain one does.
  const r = allowRepo('https://example.com/x/quiet-vale');
  writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
  assert.equal(checkCommand('gh issue comment 1 {--repo,stranger/public} --body "Quiet Vale"', { env: r.env, cwd: r.repo })?.id, 'private-mark');
  assert.equal(checkCommand('gh issue comment 1 --body "Quiet Vale"', { env: r.env, cwd: r.repo }), null, 'the control: a plain quoted post passes');
});

test('lonePost: trusts a heredoc only when its end word is a name in single quotes (#447)', () => {
  const after = 'builtin cd ~T/other && gh issue create --title x --body "Quiet Vale"';
  const refused = [
    // bash ends the body at E:F, so the line after it runs as a command
    `gh issue create --title t -F - <<E:F\nQuiet Vale ships\nE:F\n${after}\nE`,
    `gh issue create --title t -F - <<"E"OF\nQuiet Vale ships\nEOF\n${after}\nE`,
    `gh issue create --title t -F - <<E'OF'\nQuiet Vale ships\nEOF\n${after}\nE`,
    `gh issue create --title t -F - <<'E'OF\nQuiet Vale ships\nEOF\n${after}\nE`,
    `gh issue create --title "Quiet Vale" -F - <<'E:F'\nQuiet Vale ships\nE:F`,
    // an unquoted body: $\ then a newline then (cmd) is $(cmd) to bash
    'gh issue create --title t -F - <<EOF\nQuiet Vale ships $\\\n(cd ~T/other)\nEOF',
    'gh issue create --title t -F - <<EOF\nQuiet Vale ships\nEOF',
    // only spaces and tabs may follow the end word
    "gh issue create --title t -F - <<'EOF'\nQuiet Vale ships\nEOF\n\r",
    "gh issue create --title t -F - <<'EOF'\nQuiet Vale ships\nEOF\n\f",
  ];
  const own = allowRepo('https://example.com/x/quiet-vale');
  writeFileSync(own.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
  for (const command of refused) {
    assert.equal(lonePost(command), null, JSON.stringify(command));
    assert.equal(checkCommand(command, { env: own.env, cwd: own.repo })?.id, 'private-mark', JSON.stringify(command));
  }
  // The controls: a quoted name keeps $HOME, backquotes and $\ as text.
  for (const command of [
    "gh issue create --title t -F - <<'EOF'\nQuiet Vale ships $HOME `id` $\\\n(x)\nEOF",
    "gh issue create --title t -F - <<-'EOF'\n\tQuiet Vale ships $HOME `id` $\\\n\t(x)\n\tEOF\n \t\n",
  ]) {
    assert.deepEqual(lonePost(command), { cd: false }, JSON.stringify(command));
    assert.equal(checkCommand(command, { env: own.env, cwd: own.repo }), null, JSON.stringify(command));
  }
});

test('an origin that runs a remote helper (transport::address) is unsure: no skip, no allow (#447)', () => {
  for (const remote of ['ext::ssh -o ProxyCommand=x example.com %S x/quiet-vale', 'gcrypt::https://example.com/x/quiet-vale', 'Custom+v2.x-y::example.com/x/quiet-vale']) {
    const r = allowRepo(remote);
    writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
    assert.equal(normalizeRemote(remote), null, `no key, ${remote}`);
    assert.match((repoKey(r.repo, process.env) as { unsure: string }).unsure, /remote helper/, `unsure, ${remote}`);
    assert.deepEqual(repoMarkKinds(r.env, r.repo).map((mark) => mark.value), ['quiet vale'], `no skip, ${remote}`);
    r.allow([{ remote: 'example.com/x/quiet-vale', allow: ['quiet vale'] }]);
    assert.deepEqual(machineAllowed(r.env, r.repo).allow, [], `no allow, ${remote}`);
  }
});

test('an origin on this machine by host (localhost, 127.x.x.x, ::1) counts as local: no same-name skip (#447)', () => {
  for (const remote of ['https://localhost/x/quiet-vale', 'https://LOCALHOST:8443/x/quiet-vale.git', 'ssh://git@127.0.0.1:2222/x/quiet-vale', 'git@127.1.2.3:x/quiet-vale', 'ssh://[::1]/x/quiet-vale', 'git@[::1]:x/quiet-vale', 'ssh://::1/x/quiet-vale']) {
    const r = allowRepo(remote);
    writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
    assert.equal((repoKey(r.repo, process.env) as { local?: boolean }).local, true, `local, ${remote}`);
    assert.deepEqual(repoMarkKinds(r.env, r.repo).map((mark) => mark.value), ['quiet vale'], `no skip, ${remote}`);
  }
  assert.equal(normalizeRemote('git@[::1]:x/quiet-vale'), '[::1]/x/quiet-vale', 'a bracketed host keeps its brackets in the key');
  // The control: a host that only starts with localhost is a host.
  const r = allowRepo('https://localhost.example.com/x/quiet-vale');
  writeFileSync(r.env.YOKOTEN_PRIVATE_MARKS as string, 'quiet vale\n');
  assert.deepEqual(repoMarkKinds(r.env, r.repo).map((mark) => mark.value), [], 'skipped on a real host');
});

test('readMachineAllow: a file with just the switch reads as no repos; a file that is not an object is refused (#447)', () => {
  const r = allowRepo('https://example.com/x/app');
  r.allow(JSON.stringify({ skipOwnName: false }));
  assert.deepEqual(readMachineAllow(r.env), { entries: [], skipOwnName: false });
  assert.deepEqual(machineAllowed(r.env, r.repo), { allow: [], unsure: null });
  for (const text of ['[]', 'null', '"x"', '{"repos": null}', '{"repos": {}}']) assert.ok('unsure' in readMachineAllow((r.allow(text), r.env)), text);
});

// ---- A name mark matches whole words only (#434) ----
//
// Samples are built from pieces so this file passes its own check. All are made up.
const SHORT = ['s', 'am'].join('');
const FULL = [SHORT, ['exa', 'mple'].join('')].join(' ');
const NICK = ['ni', 'ck'].join('');
const JOINED = [SHORT, 'x'].join('');
const PAIR = [SHORT, ['sm', 'ith'].join('')].join(' ');
const DOMAIN = ['example', 'com'].join('.');

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

// ---- A mark is found in any Unicode form (#507) ----
//
// Made up, built from pieces. ACCENTED ends in é as one code point; DECOMPOSED is e plus U+0301.
const ACCENTED = ['vel', 'é'].join('');
const DECOMPOSED = ['vel', 'é'].join('');
const WIDE = (text: string) => [...text].map((char) => String.fromCodePoint(char.codePointAt(0)! + 0xfee0)).join('');
// A capital dotted I, whose lowercase is i plus U+0307: two code units for one.
const DOTTED = ['İ', 'lvo'].join('');
const DOTLESS = ['ı', 'lvo'].join('');

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

// ---- The fold after the adversarial review (#507) ----

// A run of combining marks of mixed classes: a normalize of one long run grows with its square.
const MIXED_MARKS = (n: number) => `a${'̖́'.repeat(n / 2)}`;

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

test('a refusal folds the marks before it names a program (#507)', () => {
  const dir = makeTempDir('yokoten-wide-marks-');
  const marks = join(dir, 'private-marks');
  writeFileSync(marks, `${WIDE('quietvale')}\n`);
  const body = join(dir, 'body.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  const run = (command: string) => checkCommand(command, { env: { HOME: dir, YOKOTEN_PRIVATE_MARKS: marks }, config: DEFAULTS, cwd: dir });
  assert.ok(run(`${bot} | quietvale-tool x`)?.what.includes('and a pipe in this command'));
  assert.ok(run(`quietvale-tool x; ${bot}`)?.what.includes('and a command in this command'));
  rmSync(dir, { recursive: true });
});

test('the bot program is never a variable: no `=` or `,` in its path (#506)', () => {
  for (const program of ['GH_REPO=evil/yokoten', 'LD_PRELOAD=x/yokoten', 'PATH=/tmp/x/yokoten', 'a,b/yokoten']) {
    assert.equal(isBotProgram(program), false, program);
    const command = `${program} bot -- gh issue create --title t --body "QuietVale ships"`;
    assert.equal(lonePost(command), null, program);
  }
});

// #523: a stopped line names the kind of mark, never its value, and how to change it.
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
