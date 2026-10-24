import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { realpathSync, rmSync, symlinkSync } from 'node:fs';
import { test } from 'node:test';
import { at, email, makeTempDir, post } from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { checkCommand } from '../../../src/rules/guards.ts';
import { formatFinding } from '../../../src/rules/message.ts';
import { hideHome, makeRedactor, notUtc, privateRemoteHosts, scanText } from '../../../src/rules/privacy/scan.ts';

// Samples are built from pieces so this file passes its own check.
const ip = (...n: number[]) => n.join('.');

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

test('makeRedactor: patterns only, with no marks: private emails go, noreply and team ones stay', () => {
  const redact = makeRedactor({}, { HOME: '/home/someone' });
  assert.equal(redact(`by jane${at}personal-mail.dev and 1+jane${at}users.noreply.github.com\n`), `by <email> and 1+jane${at}users.noreply.github.com\n`);
  assert.equal(redact(`git${at}github.com:o/r and git${at}build.private-host.dev:o/r`), `git${at}github.com:o/r and git${at}<host>:o/r`);
  assert.equal(redact('at /home/someone/project'), 'at ~/project');
});

test('makeRedactor: the real value of a secret-looking environment variable is hidden (#616)', () => {
  const value = ['env', 'Secret', 'Value', '1234567890'].join('');
  assert.equal(makeRedactor({}, { HOME: '/home/someone', SERVICE_TOKEN: value })(`printed ${value}`), 'printed <secret>');
  assert.equal(makeRedactor({}, { HOME: '/home/someone', SERVICE_TOKEN: 'short' })('short'), 'short', 'too short to be a key');
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


