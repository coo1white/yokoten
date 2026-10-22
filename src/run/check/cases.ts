// What a guard test claims, read from its source. The loosen check compares the base
// copy with the head copy. A claim it cannot read stays opaque, and a changed opaque
// test counts as looser: a missed refusal must not look like no change.

import { type Value, evaluate, fieldObject, gap, isIdentStart, lineAt, matchClose, namedAt, quoteOf, readIdent, scanQuote, skipExpr, stringFields } from './scan.ts';

const HELPERS = new Set(['blocked', 'allowed', 'shouldBlock', 'shouldPass', 'refusedAs', 'isBlockedByList']);
const REFUSE_HELPERS = new Set(['blocked', 'shouldBlock', 'refusedAs']);
const ALLOW_HELPERS = new Set(['allowed', 'shouldPass']);
const FLAG_NAMES = new Set(['refused', 'isRefused', 'blocked', 'isBlocked']);

/** A test file whose removal or weakening can make the rules looser. */
export function isWatchedTest(path: string): boolean {
  if (!/\.(?:[cm]?ts|[cm]?js)$/.test(path)) return false;
  return path.startsWith('test/rules/') || /^test\/(?:run|commands)\/hook/.test(path);
}

/** A file only the owner may change: CI, code owners, record 0026. */
export function isHardLinePath(path: string): boolean {
  return path.startsWith('.github/workflows/') || path === '.github/CODEOWNERS' || path === 'CODEOWNERS' || path === 'docs/CODEOWNERS' || path.startsWith('docs/records/0026-');
}

export interface GuardCase {
  command: string;
  env: Record<string, string>;
  file: string;
  line: number;
}

export interface TestShape {
  name: string;
  file: string;
  line: number;
  skipped: boolean;
  /** A skip expression that is not a literal, so the test may not run. Empty when it always runs. */
  skipText: string;
  /** `command` + NUL + JSON env, for the commands the test says are refused. */
  refuses: string[];
  allows: string[];
  /** `name=true` or `name=false`, and `status=N` for a hook exit code. */
  flags: string[];
  /** True when a refusal call was there but its command could not be read. */
  opaque: boolean;
  body: string;
}

export interface HelperShape {
  name: string;
  line: number;
  text: string;
}


function envKey(env: Record<string, string>): string {
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) ordered[key] = env[key];
  return JSON.stringify(ordered);
}

/** `command` + NUL + env, so a refusal can be compared and replayed. */
export function caseKey(command: string, env: Record<string, string>): string {
  return `${command}\0${envKey(env)}`;
}

export function splitCase(key: string): { command: string; env: Record<string, string> } {
  const cut = key.indexOf('\0');
  return { command: key.slice(0, cut), env: JSON.parse(key.slice(cut + 1)) as Record<string, string> };
}


function boundEnv(bindings: Map<string, Value>, name: string): Record<string, string> | null {
  const bound = bindings.get(name);
  return bound?.kind === 'env' ? bound.env : null;
}

/** The env a call passes: a name, `{ env: name }`, `{ env: { ... } }`, or the object itself. */
function envAt(source: string, at: number, bindings: Map<string, Value>): Record<string, string> {
  const start = gap(source, at);
  if (isIdentStart(source[start])) return boundEnv(bindings, readIdent(source, start).text) ?? {};
  if (source[start] !== '{') return {};
  const close = matchClose(source, start);
  if (close < 0) return {};
  const named = envName(source, start, close);
  if (named) return boundEnv(bindings, named) ?? {};
  const nested = fieldObject(source, start, close, 'env');
  return stringFields(source, nested?.open ?? start, nested?.close ?? close);
}

function envName(source: string, open: number, close: number): string | null {
  let depth = 0;
  for (let index = open; index < close; index++) {
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return null;
      index = read.end - 1;
      continue;
    }
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    else if (depth === 1 && namedAt(source, index, 'env')) {
      const colon = gap(source, index + 3);
      if (source[colon] !== ':') continue;
      const value = gap(source, colon + 1);
      if (!isIdentStart(source[value])) return null;
      return readIdent(source, value).text;
    }
  }
  return null;
}

function commandCall(source: string, at: number, bindings: Map<string, Value>): { value: Value; env: Record<string, string>; end: number } | null {
  const start = gap(source, at);
  if (!namedAt(source, start, 'checkCommand')) return null;
  const open = gap(source, start + 'checkCommand'.length);
  if (source[open] !== '(') return null;
  const close = matchClose(source, open);
  if (close < 0) return null;
  const first = evaluate(source, open + 1, bindings);
  const after = gap(source, first.end);
  const env = source[after] === ',' ? envAt(source, after + 1, bindings) : {};
  return { value: first.value, env, end: close + 1 };
}

/** What an assertion expects after a `checkCommand(...)` call: a refusal, an allow, or unreadable. */
function expectation(source: string, at: number): 'refuse' | 'allow' | 'unknown' {
  const index = gap(source, at);
  if (source.startsWith('?.', index)) return 'refuse';
  if (source.startsWith('=== null', index) || source.startsWith('== null', index) || source.startsWith('=== undefined', index) || source.startsWith('== undefined', index)) return 'allow';
  if (source.startsWith('!== null', index) || source.startsWith('!= null', index) || source.startsWith('!== undefined', index)) return 'refuse';
  if (source[index] !== ',') return 'refuse';
  const next = gap(source, index + 1);
  if (source.startsWith('null', next) || source.startsWith('undefined', next)) return 'allow';
  return 'refuse';
}

function pushCommand(bag: { refuses: string[]; allows: string[] }, kind: 'refuse' | 'allow', value: Value, env: Record<string, string>): boolean {
  const commands = value.kind === 'text' ? [value.text] : value.kind === 'list' ? value.items : null;
  if (!commands) return false;
  const list = kind === 'refuse' ? bag.refuses : bag.allows;
  for (const command of commands) list.push(caseKey(command, env));
  return true;
}

function loopOf(source: string, at: number, bindings: Map<string, Value>): { name: string; value: Value; body: string; end: number } | null {
  if (!namedAt(source, at, 'for')) return null;
  const open = gap(source, at + 3);
  if (source[open] !== '(') return null;
  const header = gap(source, open + 1);
  if (!source.startsWith('const ', header) && !source.startsWith('let ', header)) return null;
  const nameAt = gap(source, header + (source.startsWith('const ', header) ? 6 : 4));
  if (!isIdentStart(source[nameAt])) return null;
  const name = readIdent(source, nameAt);
  const ofAt = gap(source, name.end);
  if (!source.startsWith('of ', ofAt) && !source.startsWith('of\n', ofAt)) return null;
  if (source.slice(ofAt, ofAt + 2) !== 'of') return null;
  const value = evaluate(source, ofAt + 2, bindings);
  const close = gap(source, value.end);
  if (source[close] !== ')') return null;
  const bodyAt = gap(source, close + 1);
  if (source[bodyAt] === '{') {
    const end = matchClose(source, bodyAt);
    if (end < 0) return null;
    return { name: name.text, value: value.value, body: source.slice(bodyAt + 1, end), end: end + 1 };
  }
  const end = skipExpr(source, bodyAt);
  const stop = source[end] === ';' ? end + 1 : end;
  return { name: name.text, value: value.value, body: source.slice(bodyAt, stop), end: stop };
}

function usesName(body: string, callee: string, name: string): boolean {
  const pattern = new RegExp(`\\b${callee}\\s*\\(\\s*${name}\\b`);
  return pattern.test(body);
}

interface Bag {
  refuses: string[];
  allows: string[];
  flags: string[];
  opaque: boolean;
}

function loopEnv(body: string, bindings: Map<string, Value>): Record<string, string> {
  if (/YOKOTEN_ROLE\s*:\s*(['"])worker\1/.test(body)) return { YOKOTEN_ROLE: 'worker' };
  const named = /\benv\s*:\s*([A-Za-z_$][\w$]*)/.exec(body);
  if (named) return boundEnv(bindings, named[1]) ?? {};
  return {};
}

function addLoop(bag: Bag, loop: { name: string; value: Value; body: string }, bindings: Map<string, Value>): void {
  const callsCheck = usesName(loop.body, 'checkCommand', loop.name);
  const hasId = /\?\.id/.test(loop.body);
  const refuses = usesName(loop.body, 'blocked', loop.name) || usesName(loop.body, 'refusedAs', loop.name) || usesName(loop.body, 'shouldBlock', loop.name) || (callsCheck && (/assert\.ok\s*\(|assert\.notEqual\s*\(/.test(loop.body) || hasId));
  const allows = usesName(loop.body, 'allowed', loop.name) || usesName(loop.body, 'shouldPass', loop.name) || (callsCheck && /assert\.equal\s*\(/.test(loop.body) && /null/.test(loop.body) && !hasId);
  if (!refuses && !allows) return;
  if (loop.value.kind !== 'list' && loop.value.kind !== 'text') {
    bag.opaque = true;
    return;
  }
  const env = loopEnv(loop.body, bindings);
  if (refuses && !pushCommand(bag, 'refuse', loop.value, env)) bag.opaque = true;
  if (allows && !pushCommand(bag, 'allow', loop.value, env)) bag.opaque = true;
}

function collect(body: string, bindings: Map<string, Value>): Bag {
  const bag: Bag = { refuses: [], allows: [], flags: [], opaque: false };
  if (/\b(?:const|let)\s+(?:blocked|allowed|shouldBlock|shouldPass|refusedAs|isBlockedByList)\s*=/.test(body)) bag.opaque = true;
  const local = new Map(bindings);
  for (let index = 0; index < body.length; ) {
    index = gap(body, index);
    if (index >= body.length) break;
    if (quoteOf(body[index])) {
      const read = scanQuote(body, index);
      index = read ? read.end : index + 1;
      continue;
    }
    if ((body.startsWith('const ', index) || body.startsWith('let ', index)) && isIdentStart(body[gap(body, index + 5)])) {
      const name = readIdent(body, gap(body, index + (body.startsWith('const ', index) ? 6 : 4)));
      const eq = gap(body, name.end);
      if (body[eq] === '=') {
        const value = evaluate(body, eq + 1, local);
        if (value.value.kind !== 'unknown') local.set(name.text, value.value);
        index = value.end;
        continue;
      }
    }
    const loop = loopOf(body, index, local);
    if (loop) {
      addLoop(bag, loop, local);
      index = loop.end;
      continue;
    }
    const helper = [...HELPERS].find((name) => namedAt(body, index, name));
    if (helper) {
      const open = gap(body, index + helper.length);
      if (body[open] === '(') {
        const first = evaluate(body, open + 1, local);
        const after = gap(body, first.end);
        const env = body[after] === ',' ? envAt(body, after + 1, local) : {};
        const kind = REFUSE_HELPERS.has(helper) ? 'refuse' : ALLOW_HELPERS.has(helper) ? 'allow' : null;
        if (kind && !pushCommand(bag, kind, first.value.kind === 'text' ? first.value : first.value, env)) bag.opaque = true;
        const close = matchClose(body, open);
        index = close < 0 ? open + 1 : close + 1;
        continue;
      }
    }
    if (namedAt(body, index, 'assert')) {
      const read = readAssert(body, index, local, bag);
      if (read >= 0) {
        index = read;
        continue;
      }
    }
    index++;
  }
  // A call we did not read still counts: a later edit of that test is looser, not neutral.
  const plain = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const calls = plain.match(/\b(?:checkCommand|blocked|allowed|refusedAs|shouldBlock|shouldPass)\s*\(/g);
  if ((calls?.length ?? 0) > bag.refuses.length + bag.allows.length) bag.opaque = true;
  return bag;
}

function readAssert(body: string, at: number, bindings: Map<string, Value>, bag: Bag): number {
  const dot = gap(body, at + 'assert'.length);
  if (body[dot] !== '.') return -1;
  const method = readIdent(body, dot + 1);
  if (method.text !== 'ok' && method.text !== 'equal' && method.text !== 'notEqual') return -1;
  const open = gap(body, method.end);
  if (body[open] !== '(') return -1;
  const close = matchClose(body, open);
  if (close < 0) return -1;
  const call = commandCall(body, open + 1, bindings);
  if (call) {
    const kind = method.text === 'notEqual' ? 'refuse' : expectation(body, call.end);
    const decided = method.text === 'ok' && kind === 'refuse' ? 'refuse' : kind === 'unknown' ? 'refuse' : kind;
    if (!pushCommand(bag, decided === 'allow' ? 'allow' : 'refuse', call.value, call.env)) bag.opaque = true;
    return close + 1;
  }
  const start = gap(body, open + 1);
  if (method.text === 'equal' && isIdentStart(body[start])) {
    const name = readIdent(body, start);
    const comma = gap(body, name.end);
    if (body[comma] === ',' && FLAG_NAMES.has(name.text)) {
      const value = gap(body, comma + 1);
      if (body.startsWith('true', value) || body.startsWith('false', value)) bag.flags.push(`${name.text}=${body.startsWith('true', value)}`);
    }
    if (body.startsWith('.status', name.end)) {
      const commaAt = gap(body, name.end + '.status'.length);
      if (body[commaAt] === ',') {
        const number = /^[0-9]+/.exec(body.slice(gap(body, commaAt + 1)));
        if (number) bag.flags.push(`status=${number[0]}`);
      }
    }
  }
  return close + 1;
}

/** `true` or a string skips the test. `false` does not. Any other expression may skip it. */
function readSkip(source: string, open: number): { hard: boolean; text: string } {
  const close = matchClose(source, open);
  if (close < 0) return { hard: false, text: '' };
  let hard = false;
  let text = '';
  let depth = 0;
  for (let index = open; index < close; index++) {
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return { hard, text };
      index = read.end - 1;
      continue;
    }
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    else if (depth === 1 && (namedAt(source, index, 'skip') || namedAt(source, index, 'todo'))) {
      const field = namedAt(source, index, 'skip') ? 'skip' : 'todo';
      const colon = gap(source, index + field.length);
      if (source[colon] !== ':') continue;
      const value = gap(source, colon + 1);
      if (source.startsWith('true', value) || quoteOf(source[value])) hard = true;
      else if (!source.startsWith('false', value)) text = source.slice(value, skipExpr(source, value)).replace(/\s+/g, ' ').trim();
      index = value;
    }
  }
  return { hard, text };
}

function testBody(source: string, from: number, to: number): { body: string; end: number } {
  const arrow = source.indexOf('=>', from);
  if (arrow >= 0 && arrow < to) {
    const start = gap(source, arrow + 2);
    if (source[start] === '{') {
      const end = matchClose(source, start);
      if (end >= 0) return { body: source.slice(start + 1, end), end: end + 1 };
    }
    return { body: source.slice(start, to), end: to };
  }
  const brace = source.indexOf('{', from);
  if (brace >= 0 && brace < to) {
    const end = matchClose(source, brace);
    if (end >= 0) return { body: source.slice(brace + 1, end), end: end + 1 };
  }
  return { body: source.slice(from, to), end: to };
}

function addTest(source: string, at: number, file: string, bindings: Map<string, Value>, tests: TestShape[]): number {
  let skipped = false;
  let skipText = '';
  let nameAt = at;
  if (source[gap(source, at + (namedAt(source, at, 'test') ? 4 : 2))] === '.') {
    const dot = gap(source, at + (namedAt(source, at, 'test') ? 4 : 2));
    const flag = readIdent(source, dot + 1);
    if (flag.text === 'skip' || flag.text === 'todo') skipped = true;
    nameAt = flag.end;
  } else nameAt = at + (namedAt(source, at, 'test') ? 4 : 2);
  const open = gap(source, nameAt);
  if (source[open] !== '(') return at + 1;
  const close = matchClose(source, open);
  if (close < 0) return at + 1;
  const title = evaluate(source, open + 1, bindings);
  const name = title.value.kind === 'text' ? title.value.text : '';
  if (!name) return close + 1;
  let cursor = gap(source, title.end);
  if (source[cursor] === ',') cursor = gap(source, cursor + 1);
  if (source[cursor] === '{') {
    const read = readSkip(source, cursor);
    if (read.hard) skipped = true;
    else skipText = read.text;
  }
  const body = testBody(source, open + 1, close);
  const claims = skipped ? { refuses: [], allows: [], flags: [], opaque: false } : collect(body.body, bindings);
  tests.push({
    name,
    file,
    line: lineAt(source, at),
    skipped,
    skipText,
    refuses: claims.refuses,
    allows: claims.allows,
    flags: claims.flags,
    opaque: claims.opaque,
    body: body.body.replace(/\s+/g, ' ').trim(),
  });
  return close + 1;
}

/** The tests and the refusal helpers in one test file. */
export function parseTests(file: string, source: string): { tests: TestShape[]; helpers: HelperShape[] } {
  const bindings = new Map<string, Value>();
  const helpers: HelperShape[] = [];
  const tests: TestShape[] = [];
  let depth = 0;
  for (let index = 0; index < source.length; ) {
    index = gap(source, index);
    if (index >= source.length) break;
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      index = read ? read.end : index + 1;
      continue;
    }
    if (depth === 0 && (source.startsWith('const ', index) || source.startsWith('let ', index))) {
      const name = readIdent(source, gap(source, index + (source.startsWith('const ', index) ? 6 : 4)));
      const eq = gap(source, name.end);
      if (HELPERS.has(name.text) && source[eq] === '=') {
        const end = skipExpr(source, eq + 1);
        helpers.push({ name: name.text, line: lineAt(source, index), text: source.slice(index, source[end] === ';' ? end + 1 : end).replace(/\s+/g, ' ').trim() });
        index = source[end] === ';' ? end + 1 : end;
        continue;
      }
      if (source[eq] === '=') {
        const value = evaluate(source, eq + 1, bindings);
        if (value.value.kind !== 'unknown') bindings.set(name.text, value.value);
        index = value.end;
        continue;
      }
    }
    if ((namedAt(source, index, 'test') || namedAt(source, index, 'it')) && depth === 0) {
      index = addTest(source, index, file, bindings, tests);
      continue;
    }
    const char = source[index];
    if (char === '{' || char === '(' || char === '[') depth++;
    else if (char === '}' || char === ')' || char === ']') depth = Math.max(0, depth - 1);
    index++;
  }
  return { tests, helpers };
}

/** Refusal ids in `export const RULES`, with the line each key is on. */
export function refusalIds(source: string): Map<string, number> {
  const ids = new Map<string, number>();
  const marker = source.indexOf('export const RULES');
  if (marker < 0) return ids;
  const open = source.indexOf('{', marker);
  if (open < 0) return ids;
  const close = matchClose(source, open);
  if (close < 0) return ids;
  let depth = 0;
  for (let index = open; index < close; index++) {
    if (quoteOf(source[index])) {
      const key = scanQuote(source, index);
      if (!key) break;
      if (depth === 1 && key.value) {
        const colon = gap(source, key.end);
        if (source[colon] === ':') ids.set(key.value, lineAt(source, index));
      }
      index = key.end - 1;
      continue;
    }
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    else if (depth === 1 && isIdentStart(source[index])) {
      const name = readIdent(source, index);
      const colon = gap(source, name.end);
      if (source[colon] === ':' && !['rule', 'why', 'check', 'docs'].includes(name.text)) ids.set(name.text, lineAt(source, index));
      index = name.end - 1;
    }
  }
  return ids;
}
