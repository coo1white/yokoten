// Tests for src/rules/message.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  makeTranslatedRepo,
  NAMED,
  makeTempDir,
} from '../repo/helpers.ts';
import {
  DEFAULTS,
  findUnknownKeys,
} from '../../src/rules/config.ts';
import {
  checkCommand,
  checkEdit,
  privateOutput,
} from '../../src/rules/guards.ts';
import {
  checkBuildOutput,
  checkLayout,
} from '../../src/rules/layout.ts';
import {
  DOCS_URL,
  finding,
  type Finding,
  formatFinding,
  notRepoFinding,
  type Rule,
  RULES,
} from '../../src/rules/message.ts';
import {
  checkIssueTitle,
  checkOwnedTier,
  checkPullRequest,
  largeDiff,
  longSentenceNote,
} from '../../src/rules/pr.ts';
import {
  POSITIVE_CONTROL,
  scanText,
} from '../../src/rules/privacy.ts';
import { SECRET_CONTROL } from '../../src/rules/secrets.ts';
import { parseChange } from '../../src/run/changelog.ts';
import {
  check,
  checkHistory,
  GitReadError,
  gitReadFinding,
  readGit,
  timeZoneNote,
} from '../../src/run/check.ts';
import { lateFinding } from '../../src/run/hook.ts';
import { nameNotes } from '../../src/run/names.ts';
import { translationNotes } from '../../src/run/translations.ts';
import {
  readIssue,
  readNumberedPullRequest,
  readPullRequest,
} from '../../src/host/github.ts';
import {
  explain,
  explainLines,
  ids,
} from '../../src/setup/advice/explain.ts';
import {
  UNSAVED_CONTROL,
  unsavedNotes,
} from '../../src/setup/advice/unsaved.ts';
import {
  agentHooks,
  agentTempDirCheck,
  coreRulesCheck,
  leftoverTempCheck,
  diskSpaceChecks,
  machineChecks,
  type MachineProbe,
  noCiNote,
  pluginAgeCheck,
  privacyNotes,
  upstreamNote,
  userAgentHooks,
} from '../../src/setup/doctor.ts';
import { workflowNotes } from '../../src/setup/init.ts';
import {
  ROAD,
  serverChecks,
  stepFinding,
} from '../../src/setup/road.ts';

// #94: a finding links to where its rule is explained. The anchors are made as GitHub
// makes them: lower case, punctuation dropped, spaces to `-`, and `-1`, `-2` for a repeat.
const guideAnchors = (markdown: string): Set<string> => {
  const anchors = new Set<string>();
  let isInFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) isInFence = !isInFence;
    const heading = isInFence ? null : line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = heading[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    let anchor = slug;
    for (let count = 1; anchors.has(anchor); count++) anchor = `${slug}-${count}`;
    anchors.add(anchor);
  }
  return anchors;
};

// #42: every message has the same shape. Each check and guard gets a known-bad input,
// and each message must say what, why and the fix, in text and in JSON.
test('messages: every check and guard says what, why and the fix, in text and JSON (#42)', () => {
  const found: Finding[] = [];
  const add = (f: Finding | null | undefined) => {
    assert.ok(f, 'a known-bad input must be caught');
    found.push(f);
  };
  const env = { YOKOTEN_FIX_TASK: '1', YOKOTEN_ROLE: 'worker' };
  for (const c of ['git push --tags', 'git push origin v1.0.0', 'git -c push.followTags=true push', 'gh release create v1', 'npm publish', 'git push --force', 'git commit --no-verify -m x', 'git commit -nm x', 'git config core.hooksPath /dev/null']) add(checkCommand(c, { env: {} }));
  add(checkCommand('python3 --version', { env: {}, config: { commands: { block: { python3: 'this project is TypeScript only' } } } }));
  add(checkCommand(`bash -c "${':;'.repeat(300000)}"`, { env: {} })); // too many commands to read
  add(checkEdit('test/a.test.ts', { config: DEFAULTS, env }));
  add(checkEdit('AGENTS.md', { config: DEFAULTS, env }));
  add(lateFinding({ command: 'ls', paths: [], worker: false }, 5000));
  found.push(...scanText(`${POSITIVE_CONTROL}\n${SECRET_CONTROL}\nhome town`, { file: 'a.md', marks: ['home town'] }));
  found.push(...checkLayout(Array.from({ length: 8 }, (_, i) => `d/${i}`), DEFAULTS));
  found.push(...checkBuildOutput([{ path: 'dist/a.js', binary: false }, { path: 'a.bin', binary: true }], DEFAULTS));
  found.push(...checkPullRequest({ title: `Bad title (#1) ${'x'.repeat(70)}.`, body: '## Why\n\n', files: ['src/a.ts', 'kit/x'], labels: [], milestone: null }, DEFAULTS));
  add(checkOwnedTier({ body: 'tier: B\n', files: ['kit/x'] }, { text: '/kit/ @owner\n', from: 'the base branch' }));
  found.push(...checkIssueTitle('Bad title (#1) that runs on well past the sixty character limit.', {}));
  add(largeDiff(500));
  add(longSentenceNote('a.md', { line: 3, words: 30 }));
  found.push(...nameNotes('a.ts', NAMED, new Set([1, 2])));
  add(timeZoneNote(2));
  const translated = makeTranslatedRepo();
  translated.commit('en.md', '# Guide\n\nStep one, changed.\n');
  add(translationNotes(translated.root, ['zh.md'])[0]);
  // `check --history` in a shallow clone (#266).
  const shallow = makeTempDir();
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${translated.root}`, shallow], { stdio: 'ignore' });
  found.push(...checkHistory(shallow, { config: DEFAULTS, env: {} }));
  found.push(...parseChange('changes/1-a.md', 'Improved\n\nA thing.\n').problems);
  translated.git('update-index', '--add', '--info-only', '--cacheinfo', `100644,${'1'.repeat(40)},ghost.md`);
  add(check(translated.root, { config: DEFAULTS, env: {}, staged: true }).find((f) => f.id === 'missing-blob'));
  // A git read a gate depends on, which git can't answer (#403).
  assert.throws(() => readGit(translated.root, ['rev-parse', '--verify', 'no-such-ref']), (err: Error) => {
    add(err instanceof GitReadError ? gitReadFinding(err) : null);
    return true;
  });
  // A CI event that can't be read, and a pull request whose commits are not here (#267).
  const unreadable = (read: unknown) => (read && typeof read === 'object' && 'problem' in read ? (read.problem as Finding) : null);
  add(unreadable(readIssue({ GITHUB_EVENT_PATH: join(translated.root, 'no-event.json') })));
  const event = join(translated.root, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: 'f'.repeat(40) }, head: { sha: translated.git('rev-parse', 'HEAD') } } }));
  add(unreadable(readPullRequest(translated.root, { GITHUB_EVENT_PATH: event })));
  // The road and the machine, from an empty folder and an empty home.
  const dir = makeTempDir();
  for (const step of ROAD) add(stepFinding(step, dir, { HOME: dir }));
  add(notRepoFinding(dir));
  writeFileSync(join(dir, 'yokoten.json'), '{ "colour": "blue" }');
  add(findUnknownKeys(dir)[0]);
  rmSync(join(dir, 'yokoten.json'));
  // A sandbox home, never the real one: Copilot CLI's line shows only when ~/.copilot is there.
  mkdirSync(join(dir, '.copilot'));
  for (const c of [...agentHooks(dir, { HOME: dir }), ...machineChecks({ HOME: dir, YOKOTEN_PRIVATE_MARKS: join(dir, 'none') })]) add(c.finding);
  // The machine notes (record 0012), from a fake machine: a full disk, and a temp folder root owns.
  const fullMachine: MachineProbe = {
    readDiskSpace: () => ({ free: 0, size: 2 ** 38 }),
    readOwner: () => 0,
    runProgram: () => {
      throw new Error('no programs here');
    },
    readText: () => null,
    writeText: () => {},
    uid: 1000,
    now: () => new Date(0),
  };
  for (const c of diskSpaceChecks(dir, { HOME: dir }, fullMachine, false)) add(c.finding);
  add(agentTempDirCheck({}, fullMachine)?.finding);
  // An old test folder in the temp folder (#400): seen from two days on.
  const temp = makeTempDir();
  mkdirSync(join(temp, 'yokoten-old'));
  add(leftoverTempCheck({ YOKOTEN_TEMP_DIRS: temp }, { ...fullMachine, now: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) })?.finding);
  // The Codex and Gemini CLI user hooks (#211): only once their folders exist.
  for (const folder of ['.codex', '.gemini', '.grok']) mkdirSync(join(dir, folder));
  for (const c of userAgentHooks({ HOME: dir })) add(c.finding);
  // Command output (#390): the mailmap note, and the refusal for an agent that can't rewrite.
  for (const c of privacyNotes({ HOME: dir, GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }, null)) add(c.finding);
  add(privateOutput('`git log` prints author names and emails', 'set -o pipefail; (\ngit log\n) 2>&1 | yokoten redact'));
  // The plugin (#198): enabled, and installed at a version older than this yokoten.
  const pluginHome = makeTempDir();
  const pluginFolder = join(pluginHome, 'plugin');
  mkdirSync(join(pluginHome, '.claude', 'plugins'), { recursive: true });
  mkdirSync(pluginFolder);
  writeFileSync(join(pluginHome, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
  writeFileSync(join(pluginHome, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'yokoten@yokoten': [{ scope: 'user', installPath: pluginFolder }] } }));
  writeFileSync(join(pluginFolder, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  add(pluginAgeCheck(null, { HOME: pluginHome }));
  // Lessons from other projects, in a folder that looks like yokoten's own repo (#392).
  mkdirSync(join(pluginHome, '.config', 'yokoten', 'upstream'), { recursive: true });
  writeFileSync(join(pluginHome, '.config', 'yokoten', 'upstream', '20261020-120000-abcd.md'), 'what: x\n');
  writeFileSync(join(pluginFolder, 'package.json'), JSON.stringify({ name: 'yokoten', version: '0.0.1' }));
  mkdirSync(join(pluginFolder, 'bin'));
  writeFileSync(join(pluginFolder, 'bin', 'yokoten.ts'), '');
  add(upstreamNote(pluginFolder, { HOME: pluginHome }));
  // A repo that keeps CI off (#377): the note, and a pull request read by number that fails.
  add(noCiNote({ ci: 'private repo' }, 5, undefined));
  const numbered = readNumberedPullRequest(dir, () => { throw new Error('no gh here'); }, '12');
  add('problem' in numbered ? numbered.problem : undefined);
  // The core rules (#120): behind the kit, and with no heading to compare by.
  for (const rules of ['# old rules\n\n## This project\n', '# rules\n']) {
    writeFileSync(join(dir, 'AGENTS.md'), rules);
    add(coreRulesCheck(dir)?.finding);
  }
  // A kit workflow with the project's changes (#456).
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'yokoten.yml'), 'on: push\n');
  for (const { note } of workflowNotes(dir)) add(note);
  // The server, with every setting off, and with nothing readable.
  const off = { pullRequest: false, codeOwnerReview: false, mergeMethods: [], requiredChecks: [], noForcePush: false, noDeletion: false, approvals: 0 };
  const security = { secretScanning: false, pushProtection: false, privateReporting: false, dependabotAlerts: false };
  const server = { repo: 'octo/demo', defaultBranch: 'main', isPrivate: false, actionsCanApprove: false, mergeMethods: ['merge', 'squash'], deleteBranchOnMerge: false, branch: off, tags: false, security, forgotten: ['old'] };
  // Work only on this machine (#365): one case of each, as facts, so no git runs here.
  found.push(...unsavedNotes(UNSAVED_CONTROL, { home: undefined, now: 1 }));
  for (const c of [...serverChecks(server), ...serverChecks({ unread: 'gh is not installed', fix: 'get it' })]) add(c.finding);

  const known = new Set(ids());
  for (const f of found) {
    const text = formatFinding(f);
    for (const field of ['what', 'why', 'fix'] as const) {
      assert.ok(f[field].trim().length > 3, `${f.id}: ${field} is empty`);
      assert.ok(!/[.]$/.test(f[field]), `${f.id}: ${field} ends with a full stop; the text form adds it: "${f[field]}"`);
      assert.ok(text.toLowerCase().includes(f[field].toLowerCase()), `${f.id}: the text form leaves out the ${field}`);
    }
    assert.ok(known.has(f.id), `${f.id}: yokoten explain does not know this id`);
    const json = JSON.parse(JSON.stringify(f));
    assert.deepEqual(Object.keys(json).filter((k) => !['id', 'what', 'why', 'fix', 'docs', 'file', 'line'].includes(k)), [], `${f.id}: only the stable fields`);
    assert.ok(json.id && json.what && json.why && json.fix, `${f.id}: JSON has id, what, why and fix`);
  }
  // Every rule and every step was reached, so none is left without the shape. The self-test
  // finding needs a broken check, which the CLI test cannot make either.
  const reached = new Set(found.map((f) => f.id));
  assert.deepEqual([...known].filter((id) => !reached.has(id) && id !== 'self-test'), []);
  // Never a private value: the mark, the secret and the sample address are not in any field.
  const all = JSON.stringify(found);
  for (const secret of ['home town', 'personal-mail', `${'gh'}p_`, 'MIIE']) assert.ok(!all.includes(secret), secret);
});

test('docs: every link goes to a heading of docs/guide.md, so a renamed heading fails (#94)', () => {
  const anchors = guideAnchors(readFileSync(new URL('../../docs/guide.md', import.meta.url), 'utf8'));
  assert.ok(anchors.has('naming') && anchors.has('what-it-doesnt-do'), 'GitHub drops punctuation');
  assert.ok(!anchors.has('githubworkflowsyokotenyml'), 'a `#` line in a code block is not a heading');
  const linked = Object.entries(RULES as Record<string, Rule>).filter(([, rule]) => rule.docs !== undefined);
  assert.ok(linked.length >= 30, `most rules have a link; ${linked.length} do`);
  for (const [id, rule] of linked) {
    const [base, anchor, ...rest] = (rule.docs ?? '').split('#');
    assert.equal(base, DOCS_URL, `${id}: the link starts with DOCS_URL, so the site can replace it in one place`);
    assert.deepEqual(rest, [], `${id}: one anchor`);
    assert.ok(anchors.has(anchor), `${id}: docs/guide.md has no heading for #${anchor}`);
  }
});

test('docs: a finding carries its rule\'s link, in text, JSON and explain (#94)', () => {
  const link = `${DOCS_URL}#the-core-rules`;
  const found = finding('skip-check', 'it skips the check', 'run it again');
  assert.equal(found.docs, link);
  assert.equal(formatFinding(found), `it skips the check. The commit check is the inspection step, and a skipped check makes a broken commit look reviewed. Run it again.\n  docs: ${link}`);
  assert.equal(JSON.parse(JSON.stringify(found)).docs, link);
  const plain = finding('large-diff', 'big', 'split it');
  assert.equal(plain.docs, undefined, 'no section fits: no link');
  assert.ok(!formatFinding(plain).includes('docs:'));
  const explained = explain('skip-check');
  assert.equal(explained?.docs, link);
  assert.equal(explained && explainLines(explained).at(-1), `Docs: ${link}`);
  const step = explain('commit-check');
  assert.ok(step && step.docs === undefined && !explainLines(step).some((line) => line.startsWith('Docs:')), 'a step has no link yet');
});
