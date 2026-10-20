// Tests for src/rules/privacy.ts.

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { at } from '../repo/helpers.ts';
import { DEFAULTS, type Env } from '../../src/rules/config.ts';
import { checkCommand } from '../../src/rules/guards.ts';
import { formatFinding } from '../../src/rules/message.ts';
import {
  hideHome,
  loadMarks,
  notUtc,
  POSITIVE_CONTROL,
  scanText,
} from '../../src/rules/privacy.ts';

// Samples are built from pieces so this file passes its own check.
const ip = (...n: number[]) => n.join('.');

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

test('emails: role addresses, forge SSH remotes and .local point at no person (#11)', () => {
  for (const ok of [
    `contact support${at}github.com`,
    `security${at}gitlab.com`,
    `remote: git${at}gitlab.com:owner/repo.git`,
    `git clone git${at}github.com:owner/repo`,
    `conf${at}test.local`,
    `1-me${at}users.noreply.gitlab.com`,
  ]) {
    assert.deepEqual(scanText(ok, { file: 'a' }), [], ok);
  }
  // Still caught: a person at the same domains, and an SSH remote that names a private host.
  for (const bad of [`someone${at}gmail.com`, `someone${at}github.com`, `git${at}code.my-company.dev:team/app.git`]) {
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
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-'));
  const file = join(dir, 'marks');
  writeFileSync(file, '# header\n\nMyCity\n  myserver  \n');
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: file }), ['mycity', 'myserver']);
  assert.deepEqual(loadMarks({ YOKOTEN_PRIVATE_MARKS: join(dir, 'none') }), []);
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
  const real = mkdtempSync(join(tmpdir(), 'yokoten-home-'));
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

// ---- Text an agent posts (#391): the guard runs the privacy check on it ----

// A sandbox: its own HOME, a marks file, and a folder for body files. The samples are
// built from pieces so this file does not fail its own commit check.
const postDir = mkdtempSync(join(tmpdir(), 'yokoten-posts-'));
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
  // A body from stdin: the whole command is read, so a heredoc fed to it is too.
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nmail ${email}\nEOF`)?.id, 'email');
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nall clean\nEOF`), null);
});

test('clean text, allowed addresses and other commands pass', () => {
  for (const command of [
    'gh pr create --title "feat: x" --body "Closes issue #3"',
    'gh issue create --title "check: add t" --body "by 12345+bot@users.noreply.github.com"',
    `gh issue create --title "check: add t" --body "ask support${'@'}example.com"`,
    'gh pr create --fill',
    'gh pr create --body-file missing.md',
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
