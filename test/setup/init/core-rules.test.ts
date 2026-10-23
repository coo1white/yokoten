// Tests for src/setup/init/core-rules.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  makeSandbox,
  ROOT,
} from '../../repo/helpers.ts';
import { AGENTS_BACKUP, compareCoreRules, compareVersions, demoteHeadings, moveUnderProjectHeading, readKitVersion, splitFrontMatter } from '../../../src/setup/init/index.ts';

test('update: doctor says when the core rules are behind; update previews, and --write keeps "This project" byte for byte (#120)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));
  assert.match((await sandbox.call(['doctor'])).stdout, /\n {2}ok +core-rules\n/, 'init wrote the kit, so it is up to date');
  let result: { status: number | null; stdout: string; stderr: string } = sandbox.run(['update']); // a real process: the entry point of update
  assert.deepEqual([result.status, result.stdout], [0, 'yokoten update: the core rules in AGENTS.md are up to date with yokoten 0.1.0; nothing to change\n']);

  // An older kit had no rule 12, and someone edited a line by hand. The project's own
  // part has trailing spaces and a CRLF line end, to show it is kept byte for byte.
  const own = '## This project\n\nBuild with `make`.  \n<!-- ours -->\r\n';
  const old = kitCore.replace(/^\| 12 \|.*\n/m, '').replace('Plain English, close to', 'Plain words, close to') + own;
  writeFileSync(path, old);
  const doctor = await sandbox.call(['doctor']);
  assert.match(doctor.stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind yokoten 0\.1\.0's, or were edited by hand \(2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\); run `yokoten update` to see the change/);
  assert.equal(doctor.status, 1);
  assert.match((await sandbox.call(['doctor', '--session'])).stdout, /^yokoten: the core rules in AGENTS\.md are behind/m, 'a session hears it');
  assert.ok(JSON.parse((await sandbox.call(['doctor', '--json'])).stdout).findings.some((f: { id: string }) => f.id === 'core-rules'));

  // The preview shows each line, the hand edit too, and writes nothing.
  result = await sandbox.call(['update']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^yokoten update: the core rules in AGENTS\.md differ from yokoten 0\.1\.0's: 2 line\(s\) added, 1 removed; sections changed: Core rules, Writing\n/);
  assert.match(result.stdout, /^- Plain words, close to ASD-STE100/m, 'the hand-edited line is shown as replaced');
  assert.match(result.stdout, /^\+ Plain English, close to ASD-STE100/m);
  assert.match(result.stdout, /^\+ \| 12 \| Decisions are written down once/m);
  assert.match(result.stdout, /Nothing was written\. Run `yokoten update --write` to write it\.\n$/);
  assert.equal(readFileSync(path, 'utf8'), old, 'the preview writes nothing');

  // --write replaces the core part only; a second run has nothing to do.
  result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `yokoten update: replaced the core rules in AGENTS.md with yokoten 0.1.0's: 2 line(s) added, 1 removed; sections changed: Core rules, Writing. "## This project" and below are unchanged\n`);
  assert.equal(readFileSync(path, 'utf8'), kitCore + own);
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);
  assert.match((await sandbox.call(['doctor'])).stdout, /\n {2}ok +core-rules\n/);

  // Line ends do not count: a CRLF checkout is up to date.
  writeFileSync(path, kitCore.replaceAll('\n', '\r\n') + own);
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);

  // Without the heading, doctor can't tell the core rules from the project's: a note, never a guess.
  writeFileSync(path, '# our own rules\n');
  assert.match((await sandbox.call(['doctor'])).stdout, /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: AGENTS\.md has no `## This project` heading/);
  assert.doesNotMatch((await sandbox.call(['doctor', '--session'])).stdout, /core rules/);
  result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^yokoten update: can't compare AGENTS\.md with the kit: .*Nothing was written/);
  assert.equal(readFileSync(path, 'utf8'), '# our own rules\n');

  rmSync(path);
  assert.doesNotMatch((await sandbox.call(['doctor'])).stdout, /core-rules/, 'the road asks for AGENTS.md');
  result = await sandbox.call(['update']);
  assert.deepEqual([result.status, result.stderr], [1, 'yokoten update: no AGENTS.md here; nothing was written. Run `yokoten init` to add one\n']);
  assert.equal((await sandbox.call(['update', '--force'])).status, 1, 'an unknown option is refused');
  assert.match((await sandbox.call(['explain', 'core-rules'])).stdout, /^core-rules: the core rules in AGENTS\.md/);
});

// A project written by a newer yokoten is never taken back to an older kit (#141).
test('update: init writes the kit version; a newer project is refused, an older one is updated (#141)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  assert.match(fresh, /^<!-- yokoten kit 0\.1\.0 -->\n# How work is done here\n/, 'init writes the mark on the first line');
  const own = fresh.slice(fresh.indexOf('## This project'));
  const kitCore = fresh.slice(0, fresh.indexOf('## This project'));

  // Newer: a later kit added a line. update refuses, with or without --write, and doctor
  // says to update yokoten, not the project.
  const newer = kitCore.replace('0.1.0 -->', '0.2.0 -->').replace('## Roles\n', '## Roles\n\nA rule from a later kit.\n') + own;
  writeFileSync(path, newer);
  for (const args of [['update'], ['update', '--write']]) {
    const result = await sandbox.call(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^yokoten update: AGENTS\.md was written by yokoten 0\.2\.0, newer than this yokoten 0\.1\.0\. Nothing was written/);
  }
  assert.equal(readFileSync(path, 'utf8'), newer, 'a newer project is not downgraded');
  const doctor = await sandbox.call(['doctor']);
  assert.match(doctor.stdout, /\n {2}note +core-rules: the core rules in AGENTS\.md come from yokoten 0\.2\.0, newer than this yokoten 0\.1\.0; update yokoten itself, not the project/);
  assert.doesNotMatch(doctor.stdout, /MISSING core-rules/);

  // Older: the same text with an older mark is updated, and gets the new mark.
  writeFileSync(path, newer.replace('0.2.0 -->', '0.0.9 -->'));
  assert.match((await sandbox.call(['doctor'])).stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind/);
  let result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh);

  // No mark (every project before #141): an unknown version, compared by content as before.
  const unmarked = newer.replace(/^<!-- yokoten kit .* -->\n/, '');
  writeFileSync(path, unmarked);
  result = await sandbox.call(['update', '--write']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'updated, and the mark is added');
  writeFileSync(path, fresh.replace(/^<!-- yokoten kit .* -->\n/, ''));
  assert.match((await sandbox.call(['update'])).stdout, /up to date/, 'the mark alone is no change');
});

// CI and the hooks run the copy in .yokoten/. It carries the kit's AGENTS.md, so doctor
// there compares with the kit the project vendored, not "can't compare" (#145).
test('update: the .yokoten/ copy has the kit\'s AGENTS.md, so doctor and update compare from it (#145)', async () => {
  const sandbox = makeSandbox();
  assert.equal((await sandbox.call(['init'])).status, 0);
  const vendored = (...args: string[]) => spawnSync('node', ['.yokoten/bin/yokoten.ts', ...args], { cwd: sandbox.repo, env: sandbox.env, encoding: 'utf8' });
  const kitDir = join(sandbox.repo, '.yokoten', 'kit');
  // The kit's lessons come too (#77), so doctor from the copy runs them, and the kit's
  // workflows with their hashes (#456), for the command that compares them; nothing else of the kit.
  const kitFiles = readdirSync(kitDir, { recursive: true }).map(String).sort();
  const workflows = join('project', '.github', 'workflows');
  assert.deepEqual(
    kitFiles.filter((path) => !path.startsWith('lessons')),
    ['project', join('project', '.github'), workflows, ...['issue.yml', 'pr.yml', 'yokoten.yml'].map((name) => join(workflows, name)), join('project', 'AGENTS.md'), 'workflow-hashes.json'],
    'the kit\'s AGENTS.md, workflows and their hashes, and the lessons, no more',
  );
  assert.ok(kitFiles.includes(join('lessons', 'README.md')), 'the lessons table');
  assert.match(vendored('doctor').stdout, /\n {2}ok +core-rules\n/, 'a fresh project is up to date');

  const path = join(sandbox.repo, 'AGENTS.md');
  const fresh = readFileSync(path, 'utf8');
  writeFileSync(path, fresh.replace('Plain English, close to', 'Plain words, close to'));
  assert.match(vendored('doctor').stdout, /MISSING core-rules: the core rules in AGENTS\.md are behind yokoten 0\.1\.0's, or were edited by hand/);
  const result = vendored('update', '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), fresh, 'the copy writes its own kit, the one CI checks against');

  // The control: without the kit file, the copy can't compare. init puts it back.
  rmSync(kitDir, { recursive: true });
  assert.match(vendored('doctor').stdout, /\n {2}note +core-rules: can't compare the core rules in AGENTS\.md: this copy of yokoten has no kit/);
  assert.equal((await sandbox.call(['init'])).status, 0);
  assert.ok(existsSync(join(kitDir, 'project', 'AGENTS.md')), 'init refreshes the copied kit file');
  assert.match(vendored('doctor').stdout, /\n {2}ok +core-rules\n/);
});

test('core rules: the kit version mark tells older from newer; no mark compares by content (#141)', () => {
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1, 'numbers, not text');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1, 'a pre-release is older than its release');
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('{{version}}', '0.1.0'), null, 'not a version');
  assert.equal(readKitVersion('<!-- yokoten kit 0.3.1 -->\r\n# rules\n'), '0.3.1');
  assert.equal(readKitVersion('# rules\n'), null);

  const kit = '<!-- yokoten kit 0.2.0 -->\n# rules\n\n## This project\n';
  const own = '## This project\n\nours\n';
  const newer = compareCoreRules(`<!-- yokoten kit 0.3.0 -->\n# rules, later\n\n${own}`, kit);
  assert.deepEqual(newer, { state: 'newer', version: '0.3.0', kitVersion: '0.2.0' });
  const older = compareCoreRules(`<!-- yokoten kit 0.1.0 -->\n# old rules\n\n${own}`, kit);
  assert.equal(older.state, 'behind');
  assert.equal(older.state === 'behind' && older.updated, `<!-- yokoten kit 0.2.0 -->\n# rules\n\n${own}`, 'the update writes the new mark');
  const unmarked = compareCoreRules(`# old rules\n\n${own}`, kit);
  assert.equal(unmarked.state === 'behind' && unmarked.updated, `<!-- yokoten kit 0.2.0 -->\n# rules\n\n${own}`, 'no mark: an unknown version, compared by content');
  assert.equal(compareCoreRules(`# rules\n\n${own}`, kit).state, 'same', 'the mark alone is no change');
  assert.equal(compareCoreRules(`<!-- yokoten kit 0.9.0 -->\n# rules\n\n${own}`, kit).state, 'same', 'a newer mark with the same text is up to date');
  assert.equal(compareCoreRules(`<!-- yokoten kit {{version}} -->\n# rules, later\n\n${own}`, kit).state, 'behind', 'a mark that is not a version is unknown');
});

// #377: a private repo pays for its Actions minutes. init says so and never chooses for
// the owner; `init --no-ci` keeps CI off, and the road can still be finished.

// ---- The core rules into an AGENTS.md the project already has (#378) ----

const KIT_RULES = '<!-- yokoten kit 1.0.0 -->\n# How work is done here\n\n## Core rules\n\n1. a rule\n\n## This project\n\n<!-- yours here -->\n';
const KIT_CORE = KIT_RULES.slice(0, KIT_RULES.indexOf('## This project'));

test('core rules into AGENTS.md: headings go one level down, everything else stays byte for byte (#378)', () => {
  // No headings: the text moves as it is.
  assert.deepEqual(demoteHeadings('just text\nmore\n'), { text: 'just text\nmore\n', headings: [], deepest: [] });
  // `# Title` first, and ATX headings at each level; level 6 stays; `#tag` is no heading.
  const atx = demoteHeadings('# Title\n\nText\n## Sub\n  ### Indented ###\n###### Six\n#tag\n');
  assert.equal(atx.text, '## Title\n\nText\n### Sub\n  #### Indented ###\n###### Six\n#tag\n');
  assert.deepEqual(atx.headings.map((h) => h.after), ['`## Title`', '`### Sub`', '`#### Indented ###`']);
  assert.deepEqual(atx.deepest, ['`###### Six`']);
  // Setext: `===` becomes `---`; a `---` heading becomes `###`. A rule after a blank line, a
  // list or a quote is not a heading.
  const setext = demoteHeadings('Big\n===\n\nSmall\n---\n\n---\n\n- item\n---\n> quote\nlazy\n---\n');
  assert.equal(setext.text, 'Big\n---\n\n### Small\n\n---\n\n- item\n---\n> quote\nlazy\n---\n');
  assert.equal(setext.headings.length, 2);
  // Headings inside fenced code blocks stay, with either fence and a longer closing fence.
  const fenced = '```md\n# not a heading\nTitle\n===\n```\n~~~~\n# not\n~~~\n## still not\n~~~~~\n# yes\n    # indented code\n';
  assert.equal(demoteHeadings(fenced).text, fenced.replace('# yes', '## yes'));
  // CRLF lines keep CRLF; a last line without a newline keeps none.
  assert.equal(demoteHeadings('# A\r\n\r\nB\r\n---\r\ntext').text, '## A\r\n\r\n### B\r\ntext');
  assert.equal(demoteHeadings('').text, '');
});

test('core rules into AGENTS.md: the kit core on top, then `## This project`, then the text (#378)', () => {
  const moved = moveUnderProjectHeading('# Ours\n\nBuild with make.\n', KIT_RULES);
  assert.equal(moved.text, `${KIT_CORE}## This project\n\n## Ours\n\nBuild with make.\n`);
  assert.equal(moved.lines, 3);
  assert.equal(compareCoreRules(moved.text, KIT_RULES).state, 'same', 'doctor finds the core rules up to date');
  // CRLF: the new lines take CRLF too, so update compares it as the same.
  const crlf = moveUnderProjectHeading('# Ours\r\n\r\nrule\r\n', KIT_RULES);
  assert.equal(crlf.text, `${KIT_CORE.replaceAll('\n', '\r\n')}## This project\r\n\r\n## Ours\r\n\r\nrule\r\n`);
  assert.equal(compareCoreRules(crlf.text, KIT_RULES).state, 'same');
  // A byte order mark is dropped, so the kit version line comes first.
  const bom = moveUnderProjectHeading('\uFEFF# Ours\n', KIT_RULES);
  assert.ok(bom.hadBom);
  assert.ok(bom.text.startsWith('<!-- yokoten kit 1.0.0 -->\n'));
  assert.equal(readKitVersion(bom.text), '1.0.0');
  // An empty file, or one with blank lines only, gets the kit's file.
  for (const empty of ['', '\n\n', '\uFEFF']) assert.deepEqual(moveUnderProjectHeading(empty, KIT_RULES), { text: KIT_RULES, lines: 0, headings: [], deepest: [], hadBom: empty === '\uFEFF', frontMatter: false });
});

test('init: an AGENTS.md without `## This project` gets the core rules on top, and a copy of the old file (#378)', async () => {
  const sandbox = makeSandbox();
  const old = '# Our rules\n\nRun `make test`.\n\n## Style\n\nTabs.\n';
  sandbox.write('AGENTS.md', old);
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated AGENTS\.md: the core rules are on top, and your 7 line\(s\) moved under `## This project`; only their heading levels changed \(kept the old file as AGENTS\.md\.before-yokoten;/m);
  assert.match(result.stdout, /^ {2}heading one level down: `# Our rules` is now `## Our rules`$/m);
  assert.match(result.stdout, /^ {2}heading one level down: `## Style` is now `### Style`$/m);
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  const kit = readFileSync(join(ROOT, 'kit', 'project', 'AGENTS.md'), 'utf8');
  const kitCore = kit.slice(0, kit.search(/^## This project$/m)).replace('{{version}}', JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(text, `${kitCore}## This project\n\n## Our rules\n\nRun \`make test\`.\n\n### Style\n\nTabs.\n`);
  assert.equal(readFileSync(join(sandbox.repo, AGENTS_BACKUP), 'utf8'), old, 'the old file, byte for byte');
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);
  // A second run finds the heading and leaves the file to `update`.
  const again = await sandbox.call(['init']);
  assert.match(again.stdout, /^kept AGENTS\.md \(`yokoten update` brings its core rules up to date\)$/m);
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), text);
});

test('init: a committed AGENTS.md with CRLF and a BOM moves with no copy; git gives the old one back (#378)', async () => {
  const sandbox = makeSandbox();
  const old = '\uFEFFRules\r\n=====\r\n\r\n```sh\r\n# a comment, not a heading\r\n```\r\n';
  sandbox.write('AGENTS.md', old);
  sandbox.git('add', 'AGENTS.md');
  sandbox.git('commit', '-q', '-m', 'rules');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /to get the old file back: `git checkout HEAD -- AGENTS\.md`/);
  assert.match(result.stdout, /^ {2}heading one level down: `Rules` \(underlined with =\) is now `Rules` \(underlined with -\)$/m);
  assert.match(result.stdout, /^ {2}dropped the byte order mark/m);
  assert.ok(!existsSync(join(sandbox.repo, AGENTS_BACKUP)), 'git has the old file');
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('<!-- yokoten kit '));
  assert.ok(text.endsWith('## This project\r\n\r\nRules\r\n-----\r\n\r\n```sh\r\n# a comment, not a heading\r\n```\r\n'), text.slice(-120));
  assert.ok(!/(?<!\r)\n/.test(text), 'every line ends in CRLF');
  sandbox.git('checkout', 'HEAD', '--', 'AGENTS.md');
  assert.equal(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), old, 'the command it prints gives the old file back');
});

test('init: an empty AGENTS.md gets the kit file; a different copy already there stops the move (#378)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '');
  const result = await sandbox.call(['init']);
  assert.match(result.stdout, /^wrote AGENTS\.md: it had no text, so it now has the core rules and an empty `## This project` section/m);
  assert.match(readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8'), /^## This project$/m);

  const other = makeSandbox();
  other.write('AGENTS.md', '# mine\n');
  other.write(AGENTS_BACKUP, '# an older copy\n');
  const stopped = await other.call(['init']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /^kept AGENTS\.md: it has no `## This project` heading, and AGENTS\.md\.before-yokoten is there already/m);
  assert.equal(readFileSync(join(other.repo, 'AGENTS.md'), 'utf8'), '# mine\n');
  assert.equal(readFileSync(join(other.repo, AGENTS_BACKUP), 'utf8'), '# an older copy\n');
});

test('init: an AGENTS.md that is a link is kept, so init never writes through it into CLAUDE.md (#378)', { skip: process.platform === 'win32' && 'a link needs admin rights on Windows' }, async () => {
  const sandbox = makeSandbox();
  sandbox.write('CLAUDE.md', '# our rules\n');
  symlinkSync('CLAUDE.md', join(sandbox.repo, 'AGENTS.md'));
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^kept AGENTS\.md: it is a link to CLAUDE\.md/m);
  assert.doesNotMatch(readFileSync(join(sandbox.repo, 'CLAUDE.md'), 'utf8'), /Core rules/);
});

test('core rules into AGENTS.md: YAML front matter stays at the very top, as it was (#378)', () => {
  // `---` or `...` closes it; nothing inside is demoted, not even a `# comment` line.
  for (const close of ['---', '...']) {
    const front = `---\ntitle: Rules\n# a YAML comment\n${close}\n`;
    const moved = moveUnderProjectHeading(`${front}# Ours\n`, KIT_RULES);
    assert.ok(moved.frontMatter);
    assert.equal(moved.text, `${front}${KIT_CORE}## This project\n\n## Ours\n`);
    assert.deepEqual(moved.headings.map((h) => h.after), ['`## Ours`']);
    // doctor and update read past it: the core rules are the same, and an update keeps it.
    assert.equal(compareCoreRules(moved.text, KIT_RULES).state, 'same');
    const behind = compareCoreRules(moved.text.replace('1. a rule', '1. an old rule'), KIT_RULES);
    assert.ok(behind.state === 'behind' && behind.updated === moved.text, 'update --write keeps the front matter');
  }
  // CRLF, a BOM, and a closing line at the very end of the file.
  assert.equal(moveUnderProjectHeading('\uFEFF---\r\na: 1\r\n---\r\nText\r\n', KIT_RULES).text, `---\r\na: 1\r\n---\r\n${KIT_CORE.replaceAll('\n', '\r\n')}## This project\r\n\r\nText\r\n`);
  assert.equal(moveUnderProjectHeading('---\na: 1\n---', KIT_RULES).text, `---\na: 1\n---\n${KIT_RULES}`);
  // A first line `---` with no closing line is plain text: a rule, then a heading under it.
  assert.deepEqual(splitFrontMatter('---\n# Rules\n'), { front: '', rest: '---\n# Rules\n' });
  const plain = moveUnderProjectHeading('---\n# Rules\nText\n', KIT_RULES);
  assert.ok(!plain.frontMatter);
  assert.equal(plain.text, `${KIT_CORE}## This project\n\n---\n## Rules\nText\n`);
});

test('init: an AGENTS.md with front matter keeps it on top and says so (#378)', async () => {
  const sandbox = makeSandbox();
  sandbox.write('AGENTS.md', '---\ndescription: our rules\n---\n# Ours\n');
  const result = await sandbox.call(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}kept the front matter at the very top, as it was$/m);
  const text = readFileSync(join(sandbox.repo, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('---\ndescription: our rules\n---\n<!-- yokoten kit '), text.slice(0, 80));
  assert.ok(text.endsWith('## This project\n\n## Ours\n'));
  assert.match((await sandbox.call(['update'])).stdout, /up to date/);
});
