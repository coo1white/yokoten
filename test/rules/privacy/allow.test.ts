import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLinearEach } from '../../../scripts/linear.ts';
import { at, makeRepoTemplate, makeTempDir, post } from '../../repo/helpers.ts';
import { DEFAULTS, type Env } from '../../../src/rules/config.ts';
import { checkCommand } from '../../../src/rules/guards.ts';
import { formatFinding } from '../../../src/rules/message.ts';
import { machineAllowFile, machineAllowed, normalizeRemote, readMachineAllow, repoKey, repoMarkKinds } from '../../../src/rules/privacy/allow.ts';
import { lonePost } from '../../../src/rules/privacy/post/check-post.ts';
import { loadMarks } from '../../../src/rules/privacy/home.ts';

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

/** A repo with an origin remote, or none, a marks file the setting names, and the folder of the allow file. */
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
  // The allow file is beside the default marks file, never the setting's (#656).
  mkdirSync(join(base, '.config', 'yokoten'), { recursive: true });
  const allow = (repos: unknown) => writeFileSync(machineAllowFile(env), typeof repos === 'string' ? repos : JSON.stringify({ repos }));
  return { base, repo, env, git, allow };
}

const TWO_ADDRESSES = { allow: [], unsure: 'the origin remote has more than one address' };

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

test('machineAllowed: an allow file beside the setting\'s marks file never allows a mark of the default file (#656)', () => {
  const { base, repo, env } = allowRepo('https://example.com/octo/app');
  writeFileSync(join(base, '.config', 'yokoten', 'private-marks'), 'quietvale\n');
  // The setting names an empty file in a folder that holds its own allow file.
  const agent = join(base, 'agent');
  mkdirSync(agent);
  const setting = join(agent, 'private-marks');
  writeFileSync(setting, '');
  const entries = JSON.stringify({ repos: [{ remote: 'example.com/octo/app', allow: ['quietvale'] }] });
  writeFileSync(join(agent, 'private-marks-allow.json'), entries);
  const agentEnv: Env = { ...env, YOKOTEN_PRIVATE_MARKS: setting };
  const post = () => checkCommand('gh issue create --title "check: fix a bug" --body "QuietVale ships"', { env: agentEnv, cwd: repo })?.id ?? null;
  assert.deepEqual(machineAllowed(agentEnv, repo), { allow: [], unsure: null });
  assert.equal(post(), 'private-mark', 'the mark is still caught');
  // The same entry beside the default file allows it: the repo and the entry are good.
  writeFileSync(machineAllowFile(agentEnv), entries);
  assert.equal(post(), null);
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

test('machineAllowFile: with no home folder there is no allow file, never one beside the setting\'s file (#656)', () => {
  const dir = makeTempDir();
  const marks = join(dir, 'private-marks');
  writeFileSync(marks, 'quietvale\n');
  writeFileSync(join(dir, 'private-marks-allow.json'), JSON.stringify({ skipOwnName: false, repos: [{ remote: 'example.com/octo/app', allow: ['quietvale'] }] }));
  const env: Env = { HOME: '', YOKOTEN_PRIVATE_MARKS: marks };
  assert.throws(() => machineAllowFile(env), /no home folder/);
  assert.deepEqual(readMachineAllow(env), { entries: [] });
  assert.deepEqual(loadMarks(env), ['quietvale'], 'the setting\'s marks are still read');
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

