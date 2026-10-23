// Whether a change makes the rules looser (#697, record 0026). The writer does not
// decide this. `check --pr` compares the base ref with the head ref and says which.
// A looser change, or a move of a hard line, fails the check. The owner is the one
// who may let it through. The replay runs the base's refused commands on the head's
// guard, including every file the guard imports: a command the base refuses and the
// head allows is looser, whatever the tests on the head now say. A changed import the
// replay cannot prove is stricter is looser too.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Env } from '../../rules/config.ts';
import { type Finding, finding } from '../../rules/message.ts';
import { type GuardCase, type HelperShape, type TestShape, isHardLinePath, isWatchedTest, logicMatches, parseTests, readLocalImports, refusalIds, splitCase } from './cases.ts';
import { readGit, runGit } from './inspect.ts';

export type RuleVerdict = 'looser' | 'hard-line' | 'stricter-or-neutral';
export type RuleReasonKind = 'looser' | 'hard-line' | 'stricter' | 'neutral';

export interface RuleReason {
  kind: RuleReasonKind;
  file: string;
  line: number;
  /** What changed, in plain words, with no full stop. */
  text: string;
}

export interface RuleChange {
  verdict: RuleVerdict;
  reasons: RuleReason[];
}

const REPLAY_MS = 20_000;
const MAX_REASONS = 20;

// Fixed text (#329). The guard path is the next argument. The cases arrive on stdin.
const REPLAY_SCRIPT = `
import { readFileSync } from 'node:fs';
let guard;
try {
  guard = await import(process.argv[1]);
} catch {
  process.stdout.write('{"error":"import"}');
  process.exit(0);
}
if (typeof guard.checkCommand !== 'function') {
  process.stdout.write('{"error":"no-guard"}');
  process.exit(0);
}
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = [];
for (const item of cases) {
  let refused = true;
  try {
    refused = guard.checkCommand(item.command, { env: item.env ?? {}, cwd: null }) != null;
  } catch {
    refused = true;
  }
  out.push(refused);
}
process.stdout.write(JSON.stringify(out));
`;

function textAt(root: string, ref: string, path: string, env: Env): string | null {
  const { stdout, status } = runGit(root, ['show', `${ref}:${path}`], { env, okCodes: [0, 128] });
  if (status !== 0 || stdout.includes(0)) return null;
  return stdout.toString('utf8');
}

function bytesAt(root: string, ref: string, path: string, env: Env): Buffer | null {
  const { stdout, status } = runGit(root, ['show', `${ref}:${path}`], { env, okCodes: [0, 128] });
  return status === 0 ? stdout : null;
}

function listAt(root: string, ref: string, env: Env): string[] {
  return readGit(root, ['ls-tree', '-r', '--name-only', '-z', ref], { env }).toString('utf8').split('\0').filter(Boolean);
}

interface Diff {
  status: string;
  basePath: string | null;
  headPath: string | null;
}

function diffs(root: string, base: string, head: string, env: Env): Diff[] {
  const raw = readGit(root, ['diff', '--name-status', '-z', '-M', `${base}...${head}`], { env }).toString('utf8');
  const parts = raw.split('\0').filter((part) => part !== '');
  const found: Diff[] = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    const path = parts[index++] ?? '';
    // A modified file is the same path on both sides, so the reported line is the one that differs.
    if (status.startsWith('R') || status.startsWith('C')) found.push({ status, basePath: path, headPath: parts[index++] ?? '' });
    else if (status.startsWith('D')) found.push({ status, basePath: path, headPath: null });
    else if (status.startsWith('A')) found.push({ status, basePath: null, headPath: path });
    else found.push({ status, basePath: path, headPath: path });
  }
  return found;
}

function firstDiffLine(base: string | null, head: string | null): number {
  const left = (base ?? '').split('\n');
  const right = (head ?? '').split('\n');
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++) if (left[index] !== right[index]) return index + 1;
  return 1;
}

const RELEASE_LINE = /^\s*environment:\s*['"]?release['"]?\s*$/;

function releaseLine(base: string | null, head: string | null): number | null {
  const left = (base ?? '').split('\n');
  const right = (head ?? '').split('\n');
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++) {
    if (left[index] === right[index]) continue;
    if (RELEASE_LINE.test(left[index] ?? '') || RELEASE_LINE.test(right[index] ?? '')) return index + 1;
  }
  return null;
}

function hasRelease(text: string | null): boolean {
  return (text ?? '').split('\n').some((line) => RELEASE_LINE.test(line));
}

function hardLineText(path: string, base: string | null, head: string | null): string {
  if (path.startsWith('.github/workflows/')) {
    return hasRelease(base) || hasRelease(head) ? 'this workflow sets the release environment, a hard line only the owner may change' : 'a workflow file is a hard line only the owner may change';
  }
  if (path.startsWith('docs/records/0026-')) return 'record 0026 is a hard line only the owner may change';
  return 'this CODEOWNERS file is a hard line only the owner may change';
}

function showCommand(command: string): string {
  const short = command.length > 80 ? `${command.slice(0, 77)}...` : command;
  return `\`${short.replace(/`/g, "'")}\``;
}

function quoteName(name: string): string {
  return `"${name.replace(/"/g, "'")}"`;
}

const HELPER_NAMES = ['blocked', 'allowed', 'shouldBlock', 'shouldPass', 'refusedAs', 'isBlockedByList'];

function groupTests(tests: TestShape[]): Map<string, TestShape[]> {
  const grouped = new Map<string, TestShape[]>();
  for (const item of tests) {
    const key = `${item.file}\0${item.name}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }
  return grouped;
}

function helpersDiffer(was: TestShape, now: TestShape, baseHelpers: Map<string, HelperShape>, headHelpers: Map<string, HelperShape>): boolean {
  const body = `${was.body}\n${now.body}`;
  for (const name of HELPER_NAMES) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
    const left = baseHelpers.get(`${was.file}\0${name}`)?.text;
    const right = headHelpers.get(`${now.file}\0${name}`)?.text;
    if (left !== right) return true;
  }
  return false;
}

function findMove(name: string, was: TestShape, head: Map<string, TestShape[]>, base: Map<string, TestShape[]>, used: Set<string>, baseHelpers: Map<string, HelperShape>, headHelpers: Map<string, HelperShape>): { key: string; list: TestShape[] } | null {
  const found: { key: string; list: TestShape[] }[] = [];
  for (const [key, list] of head) {
    if (used.has(key) || base.has(key)) continue;
    const item = activeOf(list)[0];
    if (!item || item.name !== name) continue;
    found.push({ key, list });
  }
  return found.find((item) => !helpersDiffer(was, activeOf(item.list)[0], baseHelpers, headHelpers)) ?? found[0] ?? null;
}

function activeOf(list: TestShape[] | undefined): TestShape[] {
  return (list ?? []).filter((item) => !item.skipped);
}

function union(list: TestShape[], field: 'refuses' | 'allows' | 'flags'): Set<string> {
  return new Set(list.flatMap((item) => item[field]));
}

function compareTests(baseTests: TestShape[], headTests: TestShape[], baseHelpers: Map<string, HelperShape>, headHelpers: Map<string, HelperShape>): RuleReason[] {
  const reasons: RuleReason[] = [];
  const base = groupTests(baseTests);
  const head = groupTests(headTests);
  const used = new Set<string>();
  for (const [key, list] of base) {
    const was = activeOf(list);
    if (!was.length) continue;
    const place = was[0];
    const name = place.name;
    let nowList = head.get(key) ?? [];
    let now = activeOf(nowList);
    if (!now.length) {
      const moved = findMove(name, place, head, base, used, baseHelpers, headHelpers);
      if (moved) {
        used.add(moved.key);
        const dest = activeOf(moved.list)[0];
        if (helpersDiffer(place, dest, baseHelpers, headHelpers)) {
          reasons.push({ kind: 'looser', file: dest.file, line: dest.line, text: `test ${quoteName(name)} moved to another file with a changed helper` });
          continue;
        }
        nowList = moved.list;
        now = activeOf(moved.list);
      }
    }
    if (!now.length) {
      const skipped = nowList[0];
      reasons.push({
        kind: 'looser',
        file: skipped?.file ?? place.file,
        line: skipped?.line ?? place.line,
        text: skipped ? `test ${quoteName(name)} is skipped, so it no longer refuses anything` : `test ${quoteName(name)} was removed`,
      });
      continue;
    }
    for (const key of union(was, 'refuses')) {
      if (union(now, 'refuses').has(key)) continue;
      const item = splitCase(key);
      const became = union(now, 'allows').has(key);
      reasons.push({
        kind: 'looser',
        file: place.file,
        line: place.line,
        text: became ? `test ${quoteName(name)} now allows ${showCommand(item.command)}` : `test ${quoteName(name)} no longer refuses ${showCommand(item.command)}`,
      });
    }
    for (const flag of union(was, 'flags')) {
      if (!flag.endsWith('=true') && !flag.startsWith('status=2') && !flag.startsWith('status=1')) continue;
      if (union(now, 'flags').has(flag)) continue;
      reasons.push({ kind: 'looser', file: place.file, line: place.line, text: `test ${quoteName(name)} no longer expects ${flag.slice(0, flag.indexOf('='))} to be refused` });
    }
    const previousSkips = new Set(was.map((item) => item.skipText).filter(Boolean));
    for (const item of now) {
      if (!item.skipText || previousSkips.has(item.skipText)) continue;
      reasons.push({ kind: 'looser', file: item.file, line: item.line, text: `test ${quoteName(name)} may be skipped, so a refusal in it may not run` });
      break;
    }
    if (was.some((item) => item.opaque) && !now.some((item) => was.some((old) => old.body === item.body))) {
      reasons.push({ kind: 'looser', file: place.file, line: place.line, text: `test ${quoteName(name)} changed a refusal that could not be read on its own` });
    }
    for (const key of union(now, 'refuses')) {
      if (union(was, 'refuses').has(key)) continue;
      reasons.push({ kind: 'stricter', file: now[0].file, line: now[0].line, text: `test ${quoteName(name)} now refuses ${showCommand(splitCase(key).command)}` });
    }
  }
  for (const [key, list] of head) {
    if (used.has(key) || base.has(key) || !activeOf(list).length) continue;
    const added = activeOf(list)[0];
    reasons.push({ kind: 'stricter', file: added.file, line: added.line, text: `test ${quoteName(added.name)} was added` });
  }
  return reasons;
}

function compareHelpers(base: Map<string, HelperShape>, head: Map<string, HelperShape>): RuleReason[] {
  const reasons: RuleReason[] = [];
  const headTexts = new Set([...head.values()].map((helper) => `${helper.name}\0${helper.text}`));
  for (const [key, helper] of base) {
    const next = head.get(key);
    if (next?.text === helper.text) continue;
    // A move inside the watched folders keeps the helper. A change in place does not.
    if (!next && headTexts.has(`${helper.name}\0${helper.text}`)) continue;
    const file = key.slice(0, key.indexOf('\0'));
    reasons.push({
      kind: 'looser',
      file,
      line: next?.line ?? helper.line,
      text: next ? `the helper ${helper.name} changed, so a test that calls it may no longer refuse` : `the helper ${helper.name} was removed`,
    });
  }
  return reasons;
}

function helperMap(files: Map<string, string>): Map<string, HelperShape> {
  const map = new Map<string, HelperShape>();
  for (const [file, source] of files) {
    if (!isWatchedTest(file)) continue;
    for (const helper of parseTests(file, source).helpers) map.set(`${file}\0${helper.name}`, helper);
  }
  return map;
}

function testsIn(files: Map<string, string>): TestShape[] {
  const tests: TestShape[] = [];
  for (const [file, source] of files) if (isWatchedTest(file)) tests.push(...parseTests(file, source).tests);
  return tests;
}

function loadSide(root: string, ref: string, paths: string[], env: Env): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of paths) {
    if (!isWatchedTest(path) && path !== 'src/rules/message.ts') continue;
    const text = textAt(root, ref, path, env);
    if (text !== null) files.set(path, text);
  }
  return files;
}

function casesOf(tests: TestShape[]): GuardCase[] {
  const seen = new Set<string>();
  const cases: GuardCase[] = [];
  for (const item of tests) {
    if (item.skipped) continue;
    for (const key of item.refuses) {
      if (seen.has(key)) continue;
      seen.add(key);
      const split = splitCase(key);
      cases.push({ command: split.command, env: split.env, file: item.file, line: item.line });
    }
  }
  return cases;
}

const GUARD_ROOTS = ['src/rules/guards.ts', 'src/rules/message.ts'];

function resolveImport(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const folder = file.slice(0, file.lastIndexOf('/') + 1);
  const stack: string[] = [];
  for (const part of `${folder}${spec}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  let path = stack.join('/');
  if (path.endsWith('.js')) path = `${path.slice(0, -3)}.ts`;
  else if (!path.endsWith('.ts')) path = `${path}.ts`;
  return path;
}

/** Files reached by imports from the guard and the refusal list, on one ref. */
function readClosure(root: string, ref: string, env: Env): Map<string, string> {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [...GUARD_ROOTS];
  while (queue.length) {
    const path = queue.pop();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const text = textAt(root, ref, path, env);
    if (text === null) continue;
    files.set(path, text);
    for (const spec of readLocalImports(text)) {
      const next = resolveImport(path, spec);
      if (next) queue.push(next);
    }
  }
  return files;
}

function compareImports(base: Map<string, string>, head: Map<string, string>): RuleReason[] {
  const reasons: RuleReason[] = [];
  const own = new Set(GUARD_ROOTS);
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    if (own.has(path)) continue;
    const left = base.get(path);
    const right = head.get(path);
    if (left !== undefined && right !== undefined && logicMatches(left, right)) continue;
    const removed = right === undefined;
    const added = left === undefined;
    reasons.push({
      kind: 'looser',
      file: path,
      line: firstDiffLine(left ?? null, right ?? null),
      text: removed
        ? 'a file the guard imports was removed, so a refusal it feeds may no longer hold'
        : added
          ? 'a file the guard imports was added, so a refusal it feeds may no longer hold'
          : 'a file the guard imports changed, so a refusal it feeds may no longer hold',
    });
  }
  return reasons;
}

function snapshot(root: string, ref: string, dest: string, closure: Map<string, string>, env: Env): string | null {
  const rules = readGit(root, ['ls-tree', '-r', '--name-only', '-z', ref, 'src/rules'], { env }).toString('utf8').split('\0').filter(Boolean);
  if (!rules.includes('src/rules/guards.ts') && !closure.has('src/rules/guards.ts')) return null;
  writeFileSync(join(dest, 'package.json'), '{ "type": "module" }\n');
  const paths = new Set<string>([...rules, ...closure.keys()]);
  for (const path of paths) {
    const bytes = bytesAt(root, ref, path, env);
    if (!bytes) continue;
    const full = join(dest, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  return join(dest, 'src/rules/guards.ts');
}

function childEnv(env: Env, home: string): Env {
  return { PATH: env.PATH ?? '', HOME: home, TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_COUNT: '0', NO_COLOR: '1' };
}

/** True when the guard refuses each case, or why the guard could not be run. */
function replay(root: string, ref: string, cases: GuardCase[], closure: Map<string, string>, env: Env): boolean[] | 'missing' | 'failed' {
  if (!cases.length) return [];
  const dir = mkdtempSync(join(tmpdir(), 'yokoten-loosen-'));
  try {
    const file = snapshot(root, ref, dir, closure, env);
    if (!file) return 'missing';
    writeFileSync(join(dir, 'gitconfig'), '');
    const result = spawnSync('node', ['--input-type=module', '-e', REPLAY_SCRIPT, pathToFileURL(file).href], {
      cwd: dir,
      input: JSON.stringify(cases.map((item) => ({ command: item.command, env: item.env }))),
      encoding: 'utf8',
      timeout: REPLAY_MS,
      maxBuffer: 8 << 20,
      env: childEnv(env, dir),
    });
    if (result.error || result.status !== 0) return 'failed';
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return 'failed';
    }
    if (!Array.isArray(parsed)) return parsed && typeof parsed === 'object' && 'error' in parsed && (parsed as { error: string }).error === 'no-guard' ? 'missing' : 'failed';
    return parsed.every((item) => typeof item === 'boolean') ? (parsed as boolean[]) : 'failed';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cap<T>(items: T[]): { kept: T[]; rest: number } {
  return { kept: items.slice(0, MAX_REASONS), rest: Math.max(0, items.length - MAX_REASONS) };
}

function verdictOf(reasons: RuleReason[]): RuleVerdict {
  if (reasons.some((reason) => reason.kind === 'looser')) return 'looser';
  if (reasons.some((reason) => reason.kind === 'hard-line')) return 'hard-line';
  return 'stricter-or-neutral';
}

/**
 * How the rules change between two refs in `root`. `looser` when a watched test, a
 * refusal id, or the guard lets something through that the base refused. `hard-line`
 * when CI, CODEOWNERS, the release environment or record 0026 changes. Otherwise
 * `stricter-or-neutral`.
 */
export function ruleChange(root: string, baseRef: string, headRef: string, env: Env): RuleChange {
  const changed = diffs(root, baseRef, headRef, env);
  const reasons: RuleReason[] = [];
  const seen = new Set<string>();
  for (const diff of changed) {
    for (const path of [diff.basePath, diff.headPath]) {
      if (!path || seen.has(path)) continue;
      const baseText = diff.basePath ? textAt(root, baseRef, diff.basePath, env) : null;
      const headText = diff.headPath ? textAt(root, headRef, diff.headPath, env) : null;
      if (isHardLinePath(path)) {
        seen.add(path);
        reasons.push({ kind: 'hard-line', file: diff.headPath ?? path, line: firstDiffLine(path === diff.basePath ? baseText : headText, path === diff.headPath ? headText : baseText), text: hardLineText(path, baseText, headText) });
        continue;
      }
      const line = releaseLine(path === diff.headPath ? baseText : null, path === diff.headPath ? headText : null);
      if (path === diff.headPath && line !== null) {
        seen.add(path);
        reasons.push({ kind: 'hard-line', file: path, line, text: 'the release environment is a hard line only the owner may change' });
      }
    }
  }
  const basePaths = listAt(root, baseRef, env);
  const headPaths = listAt(root, headRef, env);
  const baseFiles = loadSide(root, baseRef, basePaths, env);
  const headFiles = loadSide(root, headRef, headPaths, env);
  const baseTests = testsIn(baseFiles);
  const headTests = testsIn(headFiles);
  const baseHelpers = helperMap(baseFiles);
  const headHelpers = helperMap(headFiles);
  reasons.push(...compareTests(baseTests, headTests, baseHelpers, headHelpers));
  reasons.push(...compareHelpers(baseHelpers, headHelpers));
  const baseClosure = readClosure(root, baseRef, env);
  const headClosure = readClosure(root, headRef, env);
  reasons.push(...compareImports(baseClosure, headClosure));
  const baseIds = refusalIds(baseFiles.get('src/rules/message.ts') ?? '');
  const headIds = refusalIds(headFiles.get('src/rules/message.ts') ?? '');
  if (baseIds.size && !headFiles.has('src/rules/message.ts') && baseFiles.has('src/rules/message.ts')) {
    reasons.push({ kind: 'looser', file: 'src/rules/message.ts', line: 1, text: 'the refusal list was removed' });
  } else {
    for (const [id, line] of baseIds) if (!headIds.has(id)) reasons.push({ kind: 'looser', file: 'src/rules/message.ts', line, text: `refusal id ${id} was removed` });
    for (const [id, line] of headIds) if (!baseIds.has(id)) reasons.push({ kind: 'stricter', file: 'src/rules/message.ts', line, text: `refusal id ${id} was added` });
  }
  const cases = casesOf(baseTests);
  if (cases.length && textAt(root, baseRef, 'src/rules/guards.ts', env) !== null) {
    const baseReplay = replay(root, baseRef, cases, baseClosure, env);
    const headReplay = replay(root, headRef, cases, headClosure, env);
    if (baseReplay === 'failed' || headReplay === 'failed') {
      reasons.push({ kind: 'looser', file: 'src/rules/guards.ts', line: 1, text: 'the guard replay did not finish, so the change is treated as looser' });
    } else if (headReplay === 'missing' && baseReplay !== 'missing') {
      reasons.push({ kind: 'looser', file: 'src/rules/guards.ts', line: 1, text: 'the guard was removed, so commands the base refuses are no longer checked' });
    } else if (Array.isArray(baseReplay) && Array.isArray(headReplay)) {
      const opened: RuleReason[] = [];
      for (let index = 0; index < cases.length; index++) {
        if (baseReplay[index] && headReplay[index] === false) {
          const item = cases[index];
          opened.push({ kind: 'looser', file: item.file, line: item.line, text: `${showCommand(item.command)} is refused on the base and allowed on the head` });
        }
      }
      const limited = cap(opened);
      reasons.push(...limited.kept);
      if (limited.rest) reasons.push({ kind: 'looser', file: 'src/rules/guards.ts', line: 1, text: `${limited.rest} more commands are refused on the base and allowed on the head` });
    }
  }
  const ranked = reasons.some((reason) => reason.kind !== 'stricter');
  if (!reasons.length || !ranked) {
    const sample = changed.find((diff) => diff.headPath)?.headPath ?? changed.find((diff) => diff.basePath)?.basePath ?? '';
    if (!reasons.some((reason) => reason.kind === 'stricter')) {
      reasons.push({
        kind: 'neutral',
        file: sample || 'README.md',
        line: sample ? firstDiffLine(sample && changed.some((diff) => diff.basePath === sample) ? textAt(root, baseRef, sample, env) : null, textAt(root, headRef, sample, env)) : 1,
        text: changed.length ? 'this change does not make the rules looser' : 'the base and the head are the same',
      });
    }
  }
  const looser = cap(reasons.filter((reason) => reason.kind === 'looser'));
  const rest = reasons.filter((reason) => reason.kind !== 'looser');
  const kept = [...looser.kept, ...rest];
  if (looser.rest) kept.push({ kind: 'looser', file: 'src/rules/guards.ts', line: 1, text: `${looser.rest} more changes make the rules looser` });
  return { verdict: verdictOf(kept), reasons: kept };
}

function reasonFinding(reason: RuleReason): Finding {
  const hard = reason.kind === 'hard-line';
  return finding('rules-looser', hard ? `this change moves a hard line: ${reason.text}` : `this change makes the rules looser: ${reason.text}`, hard ? 'ask the owner to approve it, or take the hard-line edit out' : 'keep the refusal, or ask the owner to approve it', {
    file: reason.file,
    line: reason.line,
    why: hard ? 'a hard line can turn the checks off, so only the owner may move it' : 'an area lead may approve a stricter change; a looser one waits for the owner',
  });
}

/** Findings for `check --pr`. A looser change or a hard line fails. A stricter change is a note. Neutral adds nothing. */
export function ruleChangeFindings(change: RuleChange): Finding[] {
  if (change.verdict === 'looser' || change.verdict === 'hard-line') return change.reasons.filter((reason) => reason.kind === 'looser' || reason.kind === 'hard-line').map(reasonFinding);
  const added = change.reasons.filter((reason) => reason.kind === 'stricter');
  if (!added.length) return [];
  const first = added[0];
  const more = added.length > 1 ? `, and ${added.length - 1} more` : '';
  return [finding('rules-looser', `the rules got stricter: ${first.text}${more}`, 'no change is required', { file: first.file, line: first.line, why: 'a stricter change does not wait for the owner' })];
}
