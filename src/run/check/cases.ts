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
  // `test/run/check/` holds this checker's own positive controls (#697).
  return path.startsWith('test/rules/') || path.startsWith('test/run/check/') || /^test\/(?:run|commands)\/hook/.test(path);
}

/** Relative import specifiers in one module. Packages and `node:` imports are left out. */
export function readLocalImports(source: string): string[] {
  const specs: string[] = [];
  let depth = 0;
  for (let index = 0; index < source.length; ) {
    index = gap(source, index);
    if (index >= source.length) break;
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      index = read ? read.end : index + 1;
      continue;
    }
    if (depth === 0 && (namedAt(source, index, 'import') || namedAt(source, index, 'export'))) {
      const end = clauseEnd(source, index);
      const clause = source.slice(index, end);
      const from = /\bfrom\s*(['"])(\.[^'"]+)\1/.exec(clause);
      const side = /^import\s*(['"])(\.[^'"]+)\1/.exec(clause.trim());
      const spec = from?.[2] ?? side?.[2];
      if (spec) specs.push(spec);
      index = end;
      continue;
    }
    const char = source[index];
    if (char === '{' || char === '(' || char === '[') depth++;
    else if (char === '}' || char === ')' || char === ']') depth = Math.max(0, depth - 1);
    index++;
  }
  return specs;
}

function clauseEnd(source: string, at: number): number {
  let depth = 0;
  for (let index = at; index < source.length; index++) {
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return source.length;
      index = read.end - 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === '//' || pair === '/*') {
      const next = gap(source, index);
      if (next === index) return source.length;
      index = next - 1;
      continue;
    }
    const char = source[index];
    if (char === '{' || char === '(' || char === '[') depth++;
    else if ((char === '}' || char === ')' || char === ']') && depth > 0) depth--;
    else if (char === ';' && depth === 0) return index + 1;
  }
  return source.length;
}

/** True when two sources differ only by comments or whitespace. Strings are kept. */
export function logicMatches(left: string, right: string): boolean {
  return readLogic(left) === readLogic(right);
}

function readLogic(source: string): string {
  let out = '';
  for (let index = 0; index < source.length; ) {
    const pair = source.slice(index, index + 2);
    if (pair === '//') {
      const next = source.indexOf('\n', index);
      index = next < 0 ? source.length : next + 1;
      continue;
    }
    if (pair === '/*') {
      const next = source.indexOf('*/', index + 2);
      index = next < 0 ? source.length : next + 2;
      continue;
    }
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) {
        out += source[index];
        index++;
        continue;
      }
      out += source.slice(index, read.end);
      index = read.end;
      continue;
    }
    out += source[index];
    index++;
  }
  return out.replace(/\s+/g, ' ').trim();
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

function loopOf(source: string, at: number, bindings: Map<string, Value>): { name: string; value: Value; body: string; from: number; end: number } | null {
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
    return { name: name.text, value: value.value, body: source.slice(bodyAt + 1, end), from: bodyAt + 1, end: end + 1 };
  }
  const end = skipExpr(source, bodyAt);
  const stop = source[end] === ';' ? end + 1 : end;
  return { name: name.text, value: value.value, body: source.slice(bodyAt, stop), from: bodyAt, end: stop };
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

interface FnSpan {
  name: string;
  from: number;
  to: number;
}

function fillHide(hide: Uint8Array, from: number, to: number): void {
  const end = Math.min(hide.length, to);
  for (let index = Math.max(0, from); index < end; index++) hide[index] = 1;
}

function endOfExpression(body: string, at: number, limit: number): number {
  const end = skipExpr(body, at);
  return end > limit ? limit : end;
}

interface ArrowSpan {
  from: number;
  to: number;
  end: number;
}

function readArrow(body: string, arrow: number, limit: number): ArrowSpan | null {
  const start = gap(body, arrow + 2);
  if (start >= limit) return null;
  if (body[start] === '{') {
    const end = matchClose(body, start);
    if (end < 0) return null;
    return { from: start + 1, to: end, end: end + 1 };
  }
  const end = endOfExpression(body, start, limit);
  return { from: start, to: end, end };
}

/** A function value at `at`, or null when the text is not a function. */
function readFunction(body: string, at: number, limit: number): ArrowSpan | null {
  let index = gap(body, at);
  if (index >= limit) return null;
  if (body.startsWith('async ', index) || body.startsWith('async\n', index)) {
    const next = gap(body, index + 5);
    if (namedAt(body, next, 'function') || body[next] === '(' || isIdentStart(body[next])) index = next;
  }
  if (namedAt(body, index, 'function')) {
    let cursor = gap(body, index + 'function'.length);
    if (isIdentStart(body[cursor])) cursor = readIdent(body, cursor).end;
    cursor = gap(body, cursor);
    if (body[cursor] !== '(') return null;
    const close = matchClose(body, cursor);
    if (close < 0) return null;
    const brace = gap(body, close + 1);
    if (body[brace] !== '{') return null;
    const end = matchClose(body, brace);
    if (end < 0) return null;
    return { from: brace + 1, to: end, end: end + 1 };
  }
  if (body[index] === '(') {
    const close = matchClose(body, index);
    if (close < 0 || close > limit) return null;
    const arrow = gap(body, close + 1);
    if (!body.startsWith('=>', arrow)) return null;
    return readArrow(body, arrow, limit);
  }
  if (isIdentStart(body[index])) {
    const name = readIdent(body, index);
    const arrow = gap(body, name.end);
    if (!body.startsWith('=>', arrow) || arrow >= limit) return null;
    return readArrow(body, arrow, limit);
  }
  return null;
}

function functionName(body: string, at: number): string {
  let index = gap(body, at);
  if (body.startsWith('async ', index) || body.startsWith('async\n', index)) index = gap(body, index + 5);
  if (!namedAt(body, index, 'function')) return '';
  const cursor = gap(body, index + 'function'.length);
  return isIdentStart(body[cursor]) ? readIdent(body, cursor).text : '';
}

function findColon(body: string, at: number, limit: number): number {
  let depth = 0;
  let nested = 0;
  for (let index = at; index < limit; index++) {
    const pair = body.slice(index, index + 2);
    if (pair === '//' || pair === '/*' || body[index] === ' ' || body[index] === '\t' || body[index] === '\n' || body[index] === '\r') {
      const next = gap(body, index);
      if (next === index) return -1;
      index = next - 1;
      continue;
    }
    if (quoteOf(body[index])) {
      const read = scanQuote(body, index);
      if (!read) return -1;
      index = read.end - 1;
      continue;
    }
    const char = body[index];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return -1;
      depth--;
    } else if (depth === 0 && char === '?' && body[index + 1] !== '.' && body[index + 1] !== '?') nested++;
    else if (depth === 0 && char === ':' && body[index + 1] !== ':') {
      if (nested === 0) return index;
      nested--;
    }
  }
  return -1;
}

function skipStatement(body: string, at: number, limit: number): number {
  const start = gap(body, at);
  if (start >= limit) return start;
  if (body[start] === '{') {
    const end = matchClose(body, start);
    return end < 0 ? limit : Math.min(limit, end + 1);
  }
  if (namedAt(body, start, 'if')) return skipIf(body, start, limit);
  const end = endOfExpression(body, start, limit);
  const stop = body[end] === ';' ? end + 1 : end;
  return Math.min(limit, stop);
}

function skipIf(body: string, at: number, limit: number): number {
  const open = gap(body, at + 2);
  if (body[open] !== '(') return Math.min(limit, at + 2);
  const close = matchClose(body, open);
  if (close < 0) return limit;
  let cursor = skipStatement(body, close + 1, limit);
  const elseAt = gap(body, cursor);
  if (namedAt(body, elseAt, 'else')) cursor = skipStatement(body, gap(body, elseAt + 4), limit);
  return cursor;
}

function markAtom(body: string, at: number, limit: number, hide: Uint8Array, called: Set<string>, sure: boolean): number {
  const index = gap(body, at);
  if (index >= limit) return index;
  if (quoteOf(body[index])) {
    const read = scanQuote(body, index);
    return read ? read.end : index + 1;
  }
  if (body[index] === '(') {
    const close = matchClose(body, index);
    if (close < 0 || close > limit) return index + 1;
    const arrow = gap(body, close + 1);
    if (body.startsWith('=>', arrow)) {
      const span = readArrow(body, arrow, limit);
      if (!span) return index + 1;
      // A callback is not a direct call. A refusal inside it may not run.
      fillHide(hide, span.from, span.to);
      return span.end;
    }
    markExpression(body, index + 1, close, hide, called, sure);
    return close + 1;
  }
  if (body[index] === '[' || body[index] === '{') {
    const close = matchClose(body, index);
    if (close < 0) return index + 1;
    if (body[index] === '[') markExpression(body, index + 1, close, hide, called, sure);
    return close + 1;
  }
  if (isIdentStart(body[index])) {
    const name = readIdent(body, index);
    const after = gap(body, name.end);
    if (body.startsWith('=>', after)) {
      const span = readArrow(body, after, limit);
      if (!span) return name.end;
      fillHide(hide, span.from, span.to);
      return span.end;
    }
    const optional = body.startsWith('?.', after);
    const callAt = optional ? gap(body, after + 2) : after;
    if (body[callAt] === '(') {
      const close = matchClose(body, callAt);
      if (close < 0) return name.end;
      if (sure && !optional) {
        called.add(name.text);
        markExpression(body, callAt + 1, close, hide, called, true);
      } else fillHide(hide, callAt + 1, close);
      return close + 1;
    }
    return name.end;
  }
  return index + 1;
}

function markExpression(body: string, at: number, limit: number, hide: Uint8Array, called: Set<string>, sure: boolean): number {
  let index = gap(body, at);
  while (index < limit) {
    index = gap(body, index);
    if (index >= limit) break;
    const char = body[index];
    if (char === ')' || char === ']' || char === '}' || char === ';' || char === ',' || char === ':') return index;
    if (body.startsWith('&&', index) || body.startsWith('||', index)) {
      const right = gap(body, index + 2);
      const end = endOfExpression(body, right, limit);
      // The right side of && or || may not run.
      fillHide(hide, right, end);
      index = end;
      continue;
    }
    if (char === '?' && body[index + 1] !== '.' && body[index + 1] !== '?') {
      const thenAt = gap(body, index + 1);
      const colon = findColon(body, thenAt, limit);
      const thenEnd = colon < 0 ? limit : colon;
      fillHide(hide, thenAt, thenEnd);
      if (colon < 0) return limit;
      const elseAt = gap(body, colon + 1);
      const elseEnd = endOfExpression(body, elseAt, limit);
      fillHide(hide, elseAt, elseEnd);
      index = elseEnd;
      continue;
    }
    if (char === '?') {
      index += 2;
      continue;
    }
    const next = markAtom(body, index, limit, hide, called, sure);
    if (next <= index) return index + 1;
    index = next;
  }
  return index;
}

function hideBranch(body: string, at: number, limit: number, hide: Uint8Array): number {
  const start = gap(body, at);
  const end = skipStatement(body, start, limit);
  fillHide(hide, start, end);
  return end;
}

/** A `process.exit` or `process.abort` call at `at`, or null. The call ends the process. */
function processCall(body: string, at: number, limit: number): { open: number; end: number } | null {
  let index = gap(body, at);
  if (index >= limit) return null;
  if (namedAt(body, index, 'void')) index = gap(body, index + 'void'.length);
  if (namedAt(body, index, 'globalThis') || namedAt(body, index, 'global')) {
    const globalName = namedAt(body, index, 'globalThis') ? 'globalThis' : 'global';
    const dot = gap(body, index + globalName.length);
    if (body[dot] !== '.') return null;
    index = gap(body, dot + 1);
  }
  const root = namedAt(body, index, 'process') ? 'process' : namedAt(body, index, 'Deno') ? 'Deno' : '';
  if (!root) return null;
  const dot = gap(body, index + root.length);
  if (body[dot] !== '.') return null;
  const method = readIdent(body, gap(body, dot + 1));
  const ends = root === 'process' ? method.text === 'exit' || method.text === 'abort' : method.text === 'exit';
  if (!ends) return null;
  const open = gap(body, method.end);
  if (open >= limit || body[open] !== '(') return null;
  const close = matchClose(body, open);
  if (close < 0 || close > limit) return null;
  return { open, end: close + 1 };
}

/** True or false when every value of the condition is the same. Null when it may vary. */
function constantTruth(body: string, from: number, limit: number): boolean | null {
  const read = readTruth(body, from, limit);
  if (!read) return null;
  if (read.end >= limit || gap(body, read.end) === limit) return read.truth;
  return null;
}

function readTruth(body: string, at: number, limit: number): { truth: boolean; end: number } | null {
  const first = readTruthAtom(body, at, limit);
  if (!first) return null;
  let truth = first.truth;
  let end = first.end;
  const opAt = gap(body, end);
  const op = body.startsWith('&&', opAt) ? '&&' : body.startsWith('||', opAt) ? '||' : '';
  if (!op) return first;
  while (gap(body, end) < limit && body.startsWith(op, gap(body, end))) {
    const atOp = gap(body, end);
    if ((op === '||' && truth) || (op === '&&' && !truth)) {
      const rest = skipExpr(body, atOp + 2);
      return { truth, end: rest > limit ? limit : rest };
    }
    const right = readTruthAtom(body, atOp + 2, limit);
    if (!right) return null;
    truth = op === '||' ? truth || right.truth : truth && right.truth;
    end = right.end;
  }
  const next = gap(body, end);
  if (next < limit && (body.startsWith('&&', next) || body.startsWith('||', next))) return null;
  return { truth, end };
}

function readTruthAtom(body: string, at: number, limit: number): { truth: boolean; end: number } | null {
  const index = gap(body, at);
  if (index >= limit) return null;
  if (body[index] === '!' && body[index + 1] !== '=') {
    const inner = readTruthAtom(body, index + 1, limit);
    if (!inner) return null;
    return { truth: !inner.truth, end: inner.end };
  }
  if (body[index] === '(') {
    const close = matchClose(body, index);
    if (close < 0 || close > limit) return null;
    const inner = readTruth(body, index + 1, close);
    if (!inner || gap(body, inner.end) !== close) return null;
    return { truth: inner.truth, end: close + 1 };
  }
  if (namedAt(body, index, 'true')) return { truth: true, end: index + 4 };
  if (namedAt(body, index, 'false')) return { truth: false, end: index + 5 };
  if (namedAt(body, index, 'null')) return { truth: false, end: index + 4 };
  if (namedAt(body, index, 'undefined')) return { truth: false, end: index + 9 };
  if (body[index] >= '0' && body[index] <= '9') {
    const match = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/.exec(body.slice(index, limit));
    const after = body[index + (match?.[0].length ?? 0)];
    if (!match || (after !== undefined && /[A-Za-z0-9_$]/.test(after))) return null;
    return { truth: Number(match[0]) !== 0, end: index + match[0].length };
  }
  const quoted = scanQuote(body, index);
  if (quoted && quoted.value !== null && quoted.end <= limit) return { truth: quoted.value.length > 0, end: quoted.end };
  return null;
}

/** True when a return, a throw, or a process exit runs on every path. */
function stops(body: string, from: number, limit: number): boolean {
  let index = from;
  while (index < limit) {
    index = gap(body, index);
    if (index >= limit) break;
    if (quoteOf(body[index])) {
      const read = scanQuote(body, index);
      index = read ? read.end : index + 1;
      continue;
    }
    if (namedAt(body, index, 'return') || namedAt(body, index, 'throw')) return true;
    if (processCall(body, index, limit)) return true;
    if (namedAt(body, index, 'if')) {
      const open = gap(body, index + 2);
      const close = body[open] === '(' ? matchClose(body, open) : -1;
      if (close < 0 || close > limit) return false;
      const truth = constantTruth(body, open + 1, close);
      const thenStart = gap(body, close + 1);
      const thenEnd = skipStatement(body, thenStart, limit);
      const elseAt = gap(body, thenEnd);
      const hasElse = namedAt(body, elseAt, 'else');
      const elseStart = hasElse ? gap(body, elseAt + 4) : -1;
      const elseEnd = hasElse ? skipStatement(body, elseStart, limit) : thenEnd;
      const thenStops = stops(body, thenStart, thenEnd);
      const elseStops = hasElse ? stops(body, elseStart, elseEnd) : false;
      const branchStops = truth === true ? thenStops : truth === false ? elseStops : thenStops && elseStops;
      if (branchStops) return true;
      index = hasElse ? elseEnd : thenEnd;
      if (index <= close) return false;
      continue;
    }
    if (body[index] === '{') {
      const close = matchClose(body, index);
      if (close < 0 || close > limit) return false;
      if (stops(body, index + 1, close)) return true;
      index = close + 1;
      continue;
    }
    if (namedAt(body, index, 'function') || body.startsWith('async ', index) || body.startsWith('async\n', index)) {
      const span = readFunction(body, index, limit);
      if (span) {
        index = span.end;
        continue;
      }
    }
    const end = skipStatement(body, index, limit);
    if (end <= index) return false;
    index = end;
  }
  return false;
}

function markBlock(body: string, from: number, limit: number, hide: Uint8Array, functions: FnSpan[], called: Set<string>): boolean {
  let index = from;
  while (index < limit) {
    const start = index;
    index = gap(body, index);
    if (index >= limit) break;
    if (quoteOf(body[index])) {
      const read = scanQuote(body, index);
      index = read ? read.end : index + 1;
      continue;
    }
    if (namedAt(body, index, 'return') || namedAt(body, index, 'throw')) {
      const word = namedAt(body, index, 'return') ? 6 : 5;
      const exprAt = gap(body, index + word);
      if (exprAt < limit && body[exprAt] !== ';') {
        const end = markExpression(body, exprAt, limit, hide, called, true);
        fillHide(hide, end, limit);
      } else fillHide(hide, exprAt, limit);
      return true;
    }
    if (namedAt(body, index, 'if')) {
      const open = gap(body, index + 2);
      const close = body[open] === '(' ? matchClose(body, open) : -1;
      if (close < 0) {
        index += 1;
        continue;
      }
      markExpression(body, open + 1, close, hide, called, true);
      const truth = constantTruth(body, open + 1, close);
      const thenStart = gap(body, close + 1);
      const thenEnd = skipStatement(body, thenStart, limit);
      fillHide(hide, thenStart, thenEnd);
      let cursor = thenEnd;
      let elseStart = -1;
      let elseEnd = -1;
      const elseAt = gap(body, cursor);
      if (namedAt(body, elseAt, 'else')) {
        elseStart = gap(body, elseAt + 4);
        elseEnd = skipStatement(body, elseStart, limit);
        fillHide(hide, elseStart, elseEnd);
        cursor = elseEnd;
      }
      const thenStops = stops(body, thenStart, thenEnd);
      const elseStops = elseStart >= 0 && stops(body, elseStart, elseEnd);
      const branchStops = truth === true ? thenStops : truth === false ? elseStops : thenStops && elseStops;
      if (branchStops) {
        fillHide(hide, cursor, limit);
        return true;
      }
      index = cursor;
      continue;
    }
    if (namedAt(body, index, 'while') || namedAt(body, index, 'switch') || namedAt(body, index, 'for')) {
      const loop = namedAt(body, index, 'for') ? loopOf(body, index, new Map()) : null;
      if (loop && loop.end <= limit) {
        markBlock(body, loop.from, loop.from + loop.body.length, hide, functions, called);
        index = loop.end;
        continue;
      }
      const open = gap(body, index + (namedAt(body, index, 'for') ? 3 : namedAt(body, index, 'while') ? 5 : 6));
      const close = body[open] === '(' ? matchClose(body, open) : -1;
      if (close >= 0 && namedAt(body, index, 'while')) markExpression(body, open + 1, close, hide, called, true);
      index = close < 0 ? index + 1 : hideBranch(body, close + 1, limit, hide);
      continue;
    }
    if (namedAt(body, index, 'do')) {
      index = hideBranch(body, index + 2, limit, hide);
      const whileAt = gap(body, index);
      if (namedAt(body, whileAt, 'while')) {
        const open = gap(body, whileAt + 5);
        const close = body[open] === '(' ? matchClose(body, open) : -1;
        index = close < 0 ? whileAt + 5 : close + 1;
      }
      continue;
    }
    if (namedAt(body, index, 'try')) {
      const brace = gap(body, index + 3);
      if (body[brace] !== '{') {
        index = brace + 1;
        continue;
      }
      const close = matchClose(body, brace);
      if (close < 0) return false;
      const stopped = markBlock(body, brace + 1, close, hide, functions, called);
      index = close + 1;
      const catchAt = gap(body, index);
      if (namedAt(body, catchAt, 'catch')) {
        let cursor = gap(body, catchAt + 5);
        if (body[cursor] === '(') {
          const end = matchClose(body, cursor);
          cursor = end < 0 ? cursor + 1 : end + 1;
        }
        index = hideBranch(body, cursor, limit, hide);
      }
      const finallyAt = gap(body, index);
      let finalStops = false;
      if (namedAt(body, finallyAt, 'finally')) {
        const finalBrace = gap(body, finallyAt + 7);
        if (body[finalBrace] === '{') {
          const end = matchClose(body, finalBrace);
          if (end >= 0) {
            finalStops = markBlock(body, finalBrace + 1, end, hide, functions, called);
            index = end + 1;
          }
        }
      }
      if (stopped || finalStops) {
        fillHide(hide, index, limit);
        return true;
      }
      continue;
    }
    if (body[index] === '{') {
      const close = matchClose(body, index);
      if (close < 0) return false;
      const stopped = markBlock(body, index + 1, close, hide, functions, called);
      index = close + 1;
      if (stopped) {
        fillHide(hide, index, limit);
        return true;
      }
      continue;
    }
    const fnAt = body.startsWith('async ', index) || body.startsWith('async\n', index) ? index : namedAt(body, index, 'function') ? index : -1;
    if (fnAt >= 0 && (namedAt(body, index, 'function') || namedAt(body, gap(body, index + 5), 'function'))) {
      const span = readFunction(body, index, limit);
      if (span) {
        const name = functionName(body, index);
        if (name) functions.push({ name, from: span.from, to: span.to });
        else fillHide(hide, span.from, span.to);
        index = span.end;
        continue;
      }
    }
    if ((body.startsWith('const ', index) || body.startsWith('let ', index)) && isIdentStart(body[gap(body, index + 5)])) {
      const name = readIdent(body, gap(body, index + (body.startsWith('const ', index) ? 6 : 4)));
      const eq = gap(body, name.end);
      if (body[eq] === '=') {
        const valueAt = gap(body, eq + 1);
        const span = readFunction(body, valueAt, limit);
        if (span) {
          functions.push({ name: name.text, from: span.from, to: span.to });
          index = body[span.end] === ';' ? span.end + 1 : span.end;
          continue;
        }
        const end = markExpression(body, valueAt, limit, hide, called, true);
        index = body[end] === ';' ? end + 1 : end;
        continue;
      }
    }
    const call = processCall(body, index, limit);
    if (call) {
      markExpression(body, call.open + 1, call.end - 1, hide, called, true);
      let after = call.end;
      if (body[after] === ';') after++;
      fillHide(hide, after, limit);
      return true;
    }
    const end = markExpression(body, index, limit, hide, called, true);
    index = body[end] === ';' ? end + 1 : end;
    if (index <= start) index = start + 1;
  }
  return false;
}

/** Blank a refusal the test may skip, so the reader does not count it as sure. */
function hideUnreadable(body: string): string {
  const hide = new Uint8Array(body.length);
  const functions: FnSpan[] = [];
  const called = new Set<string>();
  markBlock(body, 0, body.length, hide, functions, called);
  const kept = new Set<string>();
  let pending = true;
  while (pending) {
    pending = false;
    for (const name of [...called]) {
      for (const span of functions) {
        if (span.name !== name) continue;
        const key = `${span.from}:${span.to}`;
        if (kept.has(key)) continue;
        kept.add(key);
        pending = true;
        markBlock(body, span.from, span.to, hide, functions, called);
      }
    }
  }
  for (const span of functions) if (!kept.has(`${span.from}:${span.to}`)) fillHide(hide, span.from, span.to);
  let out = '';
  for (let index = 0; index < body.length; index++) out += hide[index] ? (body[index] === '\n' ? '\n' : ' ') : body[index];
  return out;
}

function collect(body: string, bindings: Map<string, Value>): Bag {
  // Blank refusals that may not run, then read what is left. A blanked call is still
  // in the original text, so the test stays opaque: the reader could not count it.
  const bag = collectVisible(hideUnreadable(body), bindings);
  if (/\b(?:const|let)\s+(?:blocked|allowed|shouldBlock|shouldPass|refusedAs|isBlockedByList)\s*=/.test(body)) bag.opaque = true;
  const plain = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const calls = plain.match(/\b(?:checkCommand|blocked|allowed|refusedAs|shouldBlock|shouldPass)\s*\(/g);
  if ((calls?.length ?? 0) > bag.refuses.length + bag.allows.length) bag.opaque = true;
  return bag;
}

function collectVisible(body: string, bindings: Map<string, Value>): Bag {
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

function flatText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function bindingName(source: string, at: number): string {
  const start = gap(source, at);
  if (source[start] === '{' || source[start] === '[') {
    const close = matchClose(source, start);
    return close < 0 ? 'binding' : flatText(source.slice(start, close + 1));
  }
  return isIdentStart(source[start]) ? readIdent(source, start).text : 'binding';
}

/** The end of a `const`, `let` or `var` statement. Commas join several names. */
function bindingEnd(source: string, nameAt: number): number {
  let cursor = gap(source, nameAt);
  while (cursor < source.length) {
    const end = skipExpr(source, cursor);
    if (source[end] === ',') {
      cursor = gap(source, end + 1);
      continue;
    }
    return source[end] === ';' ? end + 1 : end;
  }
  return source.length;
}

interface Declaration {
  name: string;
  line: number;
  text: string;
  end: number;
  /** Where the first name starts, or -1 when the value is not a binding. */
  bindAt: number;
}

function importEnd(source: string, at: number): number {
  let depth = 0;
  let seenSpecifier = false;
  for (let index = at; index < source.length; index++) {
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return source.length;
      if (depth === 0 && read.value !== null) seenSpecifier = true;
      index = read.end - 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === '//' || pair === '/*') {
      const next = gap(source, index);
      if (next === index) return source.length;
      index = next - 1;
      continue;
    }
    const char = source[index];
    if (char === '{' || char === '(' || char === '[') depth++;
    else if ((char === '}' || char === ')' || char === ']') && depth > 0) depth--;
    else if (char === ';' && depth === 0) return index + 1;
    else if (char === '\n' && depth === 0 && seenSpecifier) return index + 1;
  }
  return source.length;
}

function importName(text: string): string {
  const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(text);
  if (from) return `import ${from[2]}`;
  const side = /^import\s*(['"])([^'"]+)\1/.exec(text);
  return side ? `import ${side[2]}` : 'import';
}

/** The end of a class, including `extends`. Null when the body is missing. */
function classEnd(source: string, at: number): number | null {
  let depth = 0;
  for (let index = at; index < source.length; index++) {
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return null;
      index = read.end - 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === '//' || pair === '/*') {
      const next = gap(source, index);
      if (next === index) return null;
      index = next - 1;
      continue;
    }
    const char = source[index];
    if (char === '(' || char === '[' || char === '<') depth++;
    else if ((char === ')' || char === ']' || char === '>') && depth > 0) depth--;
    else if (char === '{' && depth === 0) {
      const end = matchClose(source, index);
      if (end < 0) return null;
      return source[end + 1] === ';' ? end + 2 : end + 1;
    }
  }
  return null;
}

/** One top-level value declaration, or null when `at` is not one. Type-only forms are skipped. */
function readDeclaration(source: string, at: number): Declaration | null {
  let index = at;
  if (source.startsWith('export ', index) || source.startsWith('export\n', index)) {
    const next = gap(source, index + 6);
    if (namedAt(source, next, 'type') || namedAt(source, next, 'interface')) return null;
    if (source[next] === '{' || source[next] === '*') {
      const end = clauseEnd(source, index);
      const text = flatText(source.slice(index, end));
      return { name: text, line: lineAt(source, index), text, end, bindAt: -1 };
    }
    if (namedAt(source, next, 'default')) {
      const exprAt = gap(source, next + 7);
      const fn = readFunction(source, exprAt, source.length);
      if (fn) {
        const name = functionName(source, exprAt) || 'default';
        return { name, line: lineAt(source, at), text: flatText(source.slice(at, fn.end)), end: fn.end, bindAt: -1 };
      }
      if (namedAt(source, exprAt, 'class')) {
        const end = classEnd(source, exprAt);
        if (end === null) return null;
        return { name: 'default', line: lineAt(source, at), text: flatText(source.slice(at, end)), end, bindAt: -1 };
      }
      const end = bindingEnd(source, exprAt);
      return { name: 'default', line: lineAt(source, at), text: flatText(source.slice(at, end)), end, bindAt: -1 };
    }
    index = next;
  }
  if (index === at && namedAt(source, index, 'import')) {
    const next = gap(source, index + 6);
    if (namedAt(source, next, 'type')) return null;
    const end = importEnd(source, index);
    const text = flatText(source.slice(index, end));
    return { name: importName(text), line: lineAt(source, index), text, end, bindAt: -1 };
  }
  if (namedAt(source, index, 'const') || namedAt(source, index, 'let') || namedAt(source, index, 'var')) {
    const keyword = namedAt(source, index, 'const') ? 'const'.length : namedAt(source, index, 'var') ? 'var'.length : 'let'.length;
    const nameAt = gap(source, index + keyword);
    const end = bindingEnd(source, nameAt);
    return { name: bindingName(source, nameAt), line: lineAt(source, at), text: flatText(source.slice(at, end)), end, bindAt: nameAt };
  }
  if (namedAt(source, index, 'function') || source.startsWith('async ', index) || source.startsWith('async\n', index)) {
    if (namedAt(source, index, 'function') || namedAt(source, gap(source, index + 5), 'function')) {
      const span = readFunction(source, index, source.length);
      if (!span) return null;
      const name = functionName(source, index) || 'function';
      return { name, line: lineAt(source, at), text: flatText(source.slice(at, span.end)), end: span.end, bindAt: -1 };
    }
  }
  if (namedAt(source, index, 'class')) {
    const end = classEnd(source, index);
    if (end === null) return null;
    const nameAt = gap(source, index + 5);
    const name = isIdentStart(source[nameAt]) ? readIdent(source, nameAt).text : 'class';
    return { name, line: lineAt(source, at), text: flatText(source.slice(at, end)), end, bindAt: -1 };
  }
  return null;
}

/** Remember string and object bindings a later refusal may read. */
function bindDeclarators(source: string, nameAt: number, end: number, bindings: Map<string, Value>): void {
  let cursor = gap(source, nameAt);
  while (cursor < end) {
    if (!isIdentStart(source[cursor])) return;
    const name = readIdent(source, cursor);
    const eq = gap(source, name.end);
    if (source[eq] !== '=') return;
    const value = evaluate(source, eq + 1, bindings);
    if (value.value.kind !== 'unknown') bindings.set(name.text, value.value);
    cursor = gap(source, value.end);
    if (source[cursor] !== ',') return;
    cursor = gap(source, cursor + 1);
  }
}

/** The tests and the top-level declarations in one test file. */
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
    if (depth === 0) {
      const declaration = readDeclaration(source, index);
      if (declaration) {
        if (declaration.name) helpers.push({ name: declaration.name, line: declaration.line, text: declaration.text });
        if (declaration.bindAt >= 0) bindDeclarators(source, declaration.bindAt, declaration.end, bindings);
        index = declaration.end > index ? declaration.end : index + 1;
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
