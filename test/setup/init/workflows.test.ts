// Tests for src/setup/init/workflows.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  makeSandbox,
  makeTempDir,
} from '../../repo/helpers.ts';
import { KIT, readWorkflowHashes, render, textHash, VERSION } from '../../../src/setup/files.ts';
import { compareWorkflow, hasIntactKitJobs } from '../../../src/setup/init/index.ts';

// ---- The kit's workflows: an old copy the project never changed is updated (#456) ----

const KIT_WORKFLOWS = join(KIT, 'project', '.github', 'workflows');

/** Commit everything in the sandbox repo, so git has the files init may replace. */
const commitAll = (sandbox: ReturnType<typeof makeSandbox>) => {
  assert.equal(sandbox.git('add', '-A').status, 0);
  assert.equal(sandbox.git('commit', '-q', '-m', 'before init').status, 0);
};

/** The kit's workflow `name` as init writes it into a project. */
const kitWorkflow = (name: string) => render(readFileSync(join(KIT_WORKFLOWS, name), 'utf8'), { cli: '.yokoten/bin/yokoten.ts', version: VERSION });

/** The kit's newest yokoten.yml with a `tests` job added the way the tests step says (#552). */
const withTestsJob = (yml: string): string =>
  yml
    .replace(/^  ci:$/m, '  tests:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - run: npm test\n  ci:')
    .replace('needs: [changes, check, lint]', 'needs: [changes, check, lint, tests]');

/** The kit's yokoten.yml before #451, rebuilt from the newest: one of the versions init wrote. */
const oldYokotenYml = () =>
  kitWorkflow('yokoten.yml')
    .replace(
      '# A newer run cancels the one still going for the same pull request or branch. On main,\n# the newest run tests everything the older ones would have, so a merge never waits\n# behind runs that no longer matter.\n',
      '# A new push to a pull request cancels the run still going for it. A push to main gets\n# a group of its own, so a run on main is never cancelled.\n',
    )
    .replace("group: ${{ github.workflow }}-${{ github.ref }}", "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}")
    // Before #572, the kit set up Node by its line alone.
    .replace("node-version: '^22.23.4'", 'node-version: 22')
    // Before #590, the kit never ran on a merge queue group.
    .replace('  # A merge queue runs the same checks as a pull request: every job below also runs\n  # on a merge group. Turn the queue on in the repo settings.\n  merge_group:\n', '')
    .replace(
      "  # Markdown can't break are skipped. A push to main is a full run, and so is a merge\n  # queue group. So is a file list that can't be read: docs_only is true only when the\n  # list was read and every file fits.\n",
      "  # Markdown can't break are skipped. A push to main is a full run. So is a file list\n  # that can't be read: docs_only is true only when the list was read and every file fits.\n",
    );

test('init: the list of kit workflow hashes ends with each workflow as it is now (#456)', () => {
  const hashes = readWorkflowHashes();
  const names = readdirSync(KIT_WORKFLOWS).sort();
  assert.deepEqual(Object.keys(hashes).sort(), names.map((name) => `.github/workflows/${name}`), 'one list for each kit workflow, no more');
  for (const name of names) {
    const list = hashes[`.github/workflows/${name}`];
    assert.equal(list.at(-1), textHash(kitWorkflow(name)), `kit/project/.github/workflows/${name} changed: add its new hash at the end of kit/workflow-hashes.json, and keep the old ones`);
    assert.equal(new Set(list).size, list.length, `${name}: each hash once`);
  }
  assert.ok(hashes['.github/workflows/yokoten.yml'].includes(textHash(oldYokotenYml())), 'the old copy the next tests use is one the kit wrote');
});

test('init: a project with no workflows gets the kit\'s, and a second run keeps them (#456)', async () => {
  const sandbox = makeSandbox();
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  for (const name of readdirSync(KIT_WORKFLOWS)) {
    assert.match(result.stdout, new RegExp(`^wrote \\.github/workflows/${name.replace('.', '\\.')}$`, 'm'));
    assert.equal(readFileSync(join(sandbox.repo, '.github/workflows', name), 'utf8'), kitWorkflow(name));
  }
  result = await sandbox.call(['init']);
  for (const name of readdirSync(KIT_WORKFLOWS)) assert.match(result.stdout, new RegExp(`^kept \\.github/workflows/${name.replace('.', '\\.')}$`, 'm'));
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/, 'nothing to say about the kit\'s own copies');
});

test('init: updates a kit workflow the project never changed, with its line ends (#456)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.github/workflows/yokoten.yml', oldYokotenYml().replace(/\n/g, '\r\n'));
  // The newest copy with Windows line ends is the same file: kept byte for byte.
  const prCrlf = kitWorkflow('pr.yml').replace(/\n/g, '\r\n');
  sandbox.write('.github/workflows/pr.yml', prCrlf);
  commitAll(sandbox);
  assert.match((await sandbox.call(['doctor'])).stdout, /note +kit-workflows: \.github\/workflows\/yokoten\.yml is an older copy of the kit's, and you never changed it; run `yokoten init` to update it/);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated \.github\/workflows\/yokoten\.yml to the kit's newest copy \(you had not changed it; `git restore --source=HEAD -- \.github\/workflows\/yokoten\.yml` brings the old one back\)$/m);
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8'), kitWorkflow('yokoten.yml').replace(/\n/g, '\r\n'), 'the newest copy, with the line ends the file had');
  assert.match(result.stdout, /^kept \.github\/workflows\/pr\.yml$/m);
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/pr.yml'), 'utf8'), prCrlf);
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});
test('init: keeps a kit workflow with the project\'s changes, and says once how to see the difference (#456)', async () => {
  const sandbox = makeSandbox();
  const mine = `${oldYokotenYml()}  # our own job goes here\n`;
  sandbox.write('.github/workflows/yokoten.yml', mine);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  const diff = 'git diff --no-index .github/workflows/yokoten.yml .yokoten/kit/project/.github/workflows/yokoten.yml';
  assert.match(result.stdout, new RegExp(`^kept \\.github/workflows/yokoten\\.yml: it has your changes\\. To see how the kit's newest copy differs: \`${diff.replaceAll('.', '\\.')}\`$`, 'm'));
  assert.equal(readFileSync(join(sandbox.repo, '.github/workflows/yokoten.yml'), 'utf8'), mine, 'kept byte for byte');
  assert.ok(existsSync(join(sandbox.repo, '.yokoten/kit/project/.github/workflows/yokoten.yml')), 'the command names a file that is there');
  assert.equal(sandbox.git(...diff.split(' ').slice(1)).status, 1, 'and it shows a difference');
  const first = (await sandbox.call(['doctor'])).stdout;
  assert.match(first, /note +kit-workflows: \.github\/workflows\/yokoten\.yml has your changes, and the kit's newest copy differs; to see how: `git diff --no-index/);
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/, 'said once for this kit version');
});

test('init: never writes through a symlinked kit workflow (#456)', async () => {
  const sandbox = makeSandbox();
  const target = join(makeTempDir(), 'yokoten.yml');
  writeFileSync(target, oldYokotenYml());
  mkdirSync(join(sandbox.repo, '.github/workflows'), { recursive: true });
  symlinkSync(target, join(sandbox.repo, '.github/workflows/yokoten.yml'));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: it is a symlink, so yokoten did not write through it$/m);
  assert.equal(readFileSync(target, 'utf8'), oldYokotenYml());
  assert.ok(lstatSync(join(sandbox.repo, '.github/workflows/yokoten.yml')).isSymbolicLink());
});

test('compareWorkflow: same, older, changed, missing; Windows line ends compare as Unix ones (#456)', () => {
  const root = makeTempDir();
  const rel = '.github/workflows/ci.yml';
  const hashes = { [rel]: [textHash('old: 1\n'), textHash('new: 2\n')] };
  assert.equal(compareWorkflow(root, rel, 'new: 2\n', hashes), 'missing');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const [text, state] of [['new: 2\r\n', 'same'], ['old: 1\r\n', 'older'], ['old: 1\r\n\r\n', 'changed'], ['old: 1\n\n', 'changed'], ['old: 1\nx: 1\r\n', 'changed'], ['old: 1\nmine: 3\n', 'changed']] as const) {
    writeFileSync(join(root, rel), text);
    assert.equal(compareWorkflow(root, rel, 'new: 2\n', hashes), state, JSON.stringify(text));
  }
  assert.equal(compareWorkflow(root, rel, 'new: 2\n', {}), 'changed', 'a file with no list is never taken for a kit copy');
});

test('compareWorkflow: a job added the way doctor says stays up to date (#552)', () => {
  const root = makeTempDir();
  const rel = '.github/workflows/yokoten.yml';
  const kit = kitWorkflow('yokoten.yml');
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, rel), withTestsJob(kit));
  assert.equal(compareWorkflow(root, rel, kit, readWorkflowHashes()), 'same');
  assert.equal(compareWorkflow(root, rel, kit, {}), 'same', 'no hash list needed');
});

test('hasIntactKitJobs: own jobs and wider needs pass; a kit job behind does not (#552)', () => {
  const kit = 'name: small\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make check\n  ci:\n    if: always()\n    needs: [check]\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n';
  const plusTests = kit
    .replace('  ci:\n', '  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  ci:\n')
    .replace('needs: [check]', 'needs: [check, tests]');
  assert.ok(hasIntactKitJobs(plusTests, kit), 'an added job and a wider needs list');
  assert.ok(hasIntactKitJobs(plusTests.replace('needs: [check, tests]', 'needs:\n      - check\n      - tests'), kit), 'a block needs list');
  assert.ok(!hasIntactKitJobs(plusTests, kit.replace('on: push', 'on: pull_request')), 'words outside the jobs');
  assert.ok(!hasIntactKitJobs(plusTests.replace('      - run: make check', '      - run: make check-all'), kit), 'a changed kit job');
  assert.ok(!hasIntactKitJobs(plusTests.replace('needs: [check, tests]', 'needs: [tests]'), kit), 'a narrower needs list');
  assert.ok(!hasIntactKitJobs(kit, plusTests), 'the other way round: the kit lacks the added job');
  assert.ok(!hasIntactKitJobs('no jobs here\n', kit), 'no jobs block in the project');
  assert.ok(!hasIntactKitJobs(plusTests, 'no jobs here\n'), 'no jobs block in the kit');
});

test('init: keeps a kit workflow with only the project\'s own jobs added (#552)', async () => {
  const sandbox = makeSandbox();
  const mine = withTestsJob(kitWorkflow('yokoten.yml'));
  sandbox.write(YML, mine);
  commitAll(sandbox);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml$/m);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), mine, 'kept byte for byte');
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});

test('doctor: no kit-workflows note after adding the tests job the way doctor says (#552)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{"scripts": {"test": "node --test"}}\n');
  sandbox.write(YML, withTestsJob(kitWorkflow('yokoten.yml')));
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});

test('doctor: a kit-workflows note when the kit\'s own jobs fall behind (#552)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('package.json', '{"scripts": {"test": "node --test"}}\n');
  sandbox.write(YML, withTestsJob(kitWorkflow('yokoten.yml')).replace('node .yokoten/bin/yokoten.ts check', 'node .yokoten/bin/yokoten.ts check --stray'));
  assert.match((await sandbox.call(['doctor'])).stdout, /note +kit-workflows: \.github\/workflows\/yokoten\.yml has your changes, and the kit's newest copy differs/);
});

const YML = '.github/workflows/yokoten.yml';

test('init: keeps an old kit workflow that git cannot give back: untracked, or edited since the last commit (#456)', async () => {
  const old = oldYokotenYml();
  const keptLine = /^kept \.github\/workflows\/yokoten\.yml: it is an older kit copy that is not committed, so commit it and run init again$/m;
  // Untracked.
  let sandbox = makeSandbox();
  sandbox.write(YML, old);
  let result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, keptLine);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old);
  // Tracked, with an uncommitted edit that leaves the text a kit copy: HEAD has other text.
  sandbox = makeSandbox();
  sandbox.write(YML, `${old}# committed note\n`);
  commitAll(sandbox);
  sandbox.write(YML, old);
  result = await sandbox.call(['init']);
  assert.match(result.stdout, keptLine);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old);
  // Committed, then init, then the way back is true.
  sandbox = makeSandbox();
  sandbox.write(YML, old);
  commitAll(sandbox);
  result = await sandbox.call(['init']);
  assert.match(result.stdout, /^updated \.github\/workflows\/yokoten\.yml to the kit's newest copy/m);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), kitWorkflow('yokoten.yml'));
  assert.equal(sandbox.git('restore', '--source=HEAD', '--', YML).status, 0);
  assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), old, 'git restore gives the old text back');
});

test('init: a file that differs only in line ends or blank lines at the end is the project\'s change, and is kept (#456)', async () => {
  const old = oldYokotenYml();
  for (const [name, text] of [['one CRLF', `${old.slice(0, old.indexOf('\n'))}\r${old.slice(old.indexOf('\n'))}`], ['blank lines at the end', `${old}\n\n`]] as const) {
    const sandbox = makeSandbox();
    sandbox.write(YML, text);
    commitAll(sandbox);
    const result = await sandbox.call(['init']);
    assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: it has your changes/m, name);
    assert.equal(readFileSync(join(sandbox.repo, YML), 'utf8'), text, name);
  }
});

test('init: a folder where a kit workflow goes is kept, not a crash (#456)', async () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox.repo, YML), { recursive: true });
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept \.github\/workflows\/yokoten\.yml: it has your changes/m);
  assert.ok(lstatSync(join(sandbox.repo, YML)).isDirectory());
});

test('init --no-ci: removes a never-edited old kit workflow, and doctor is quiet about workflows when CI is off (#456)', async () => {
  const sandbox = makeSandbox();
  sandbox.write(YML, oldYokotenYml());
  commitAll(sandbox);
  const result = await sandbox.call(['init', '--no-ci']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^removed \.github\/workflows\/yokoten\.yml \(the kit's copy; CI is off\)$/m);
  assert.ok(!existsSync(join(sandbox.repo, YML)));
  // An old copy that stays (CI is off, init keeps it): no note to run init.
  sandbox.write(YML, oldYokotenYml());
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /kit-workflows/);
});
