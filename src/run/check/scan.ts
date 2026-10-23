// A small reader for the bits of a test file the loosen check needs: strings, lists,
// joins, and objects whose fields are all strings. Anything else is unknown, and the
// caller treats an unknown refusal as opaque.

export type Value = { kind: 'text'; text: string } | { kind: 'list'; items: string[] } | { kind: 'env'; env: Record<string, string> } | { kind: 'unknown' };

export const quoteOf = (char: string | undefined): boolean => char === "'" || char === '"' || char === '`';
const isIdent = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_$]/.test(char);
export const isIdentStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z_$]/.test(char);

/** The index after spaces, tabs, newlines and comments, or the end. */
export function gap(source: string, at: number): number {
  let index = at;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (source[index] === ' ' || source[index] === '\t' || source[index] === '\n' || source[index] === '\r') index++;
    else if (pair === '//') {
      const next = source.indexOf('\n', index);
      index = next < 0 ? source.length : next + 1;
    } else if (pair === '/*') {
      const next = source.indexOf('*/', index + 2);
      index = next < 0 ? source.length : next + 2;
    } else break;
  }
  return index;
}

/** A quoted string starting at `at`, or null when `at` is not a quote. An interpolated template has a null value. */
export function scanQuote(source: string, at: number): { value: string | null; end: number } | null {
  const quote = source[at];
  if (!quoteOf(quote)) return null;
  let value = '';
  let known = true;
  for (let index = at + 1; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1] ?? '';
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      index++;
      continue;
    }
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      known = false;
      const close = matchClose(source, index + 1);
      if (close < 0) return null;
      index = close;
      continue;
    }
    if (char === quote) return { value: known ? value : null, end: index + 1 };
    if (char === '\n' && quote !== '`') return null;
    value += char;
  }
  return null;
}

/** The index of the closer matching the bracket at `openAt`. */
export function matchClose(source: string, openAt: number): number {
  const open = source[openAt];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '';
  if (!close) return -1;
  let depth = 0;
  for (let index = openAt; index < source.length; index++) {
    const pair = source.slice(index, index + 2);
    if (pair === '//' || pair === '/*') {
      const next = gap(source, index);
      if (next === index) return -1;
      index = next - 1;
      continue;
    }
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return -1;
      index = read.end - 1;
      continue;
    }
    if (source[index] === open) depth++;
    else if (source[index] === close && --depth === 0) return index;
  }
  return -1;
}

/** Words that a slash may follow and still start a regex, not a division. */
const REGEX_WORDS = ['return', 'case', 'typeof', 'delete', 'void', 'new', 'in', 'of', 'yield', 'await', 'do', 'else'];

/** True when the slash at `at` starts a regex: the last code before it is an operator, a bracket, or one of `REGEX_WORDS`. */
function isRegexStart(source: string, at: number): boolean {
  for (let index = at - 1; index >= 0; index--) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue;
    if ('([{,;:!&|?=+-*%<>'.includes(char)) return true;
    if (!/[A-Za-z_$]/.test(char)) return false;
    let start = index;
    while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start--;
    return REGEX_WORDS.includes(source.slice(start, index + 1));
  }
  return true;
}

/** The index after a regex literal, or `at` when this slash is not one. A class (`[...]`) may hold a slash; a newline means it is not a regex. */
function skipRegex(source: string, at: number): number {
  let inClass = false;
  for (let index = at + 1; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '\n') return at;
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index++;
      while (index < source.length && /[A-Za-z]/.test(source[index])) index++;
      return index;
    }
  }
  return at;
}

export function skipExpr(source: string, at: number): number {
  let depth = 0;
  for (let index = at; index < source.length; index++) {
    const pair = source.slice(index, index + 2);
    if (pair === '//' || pair === '/*' || source[index] === ' ' || source[index] === '\t' || source[index] === '\n' || source[index] === '\r') {
      const next = gap(source, index);
      if (next === index) return index;
      index = next - 1;
      continue;
    }
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return source.length;
      index = read.end - 1;
      continue;
    }
    if (source[index] === '/' && isRegexStart(source, index)) {
      const end = skipRegex(source, index);
      if (end > index) {
        index = end - 1;
        continue;
      }
    }
    const char = source[index];
    if (depth === 0 && ',)]};'.includes(char)) return index;
    if (char === '(' || char === '[' || char === '{') depth++;
    else if ((char === ')' || char === ']' || char === '}') && --depth < 0) return index;
  }
  return source.length;
}

export function readIdent(source: string, at: number): { text: string; end: number } {
  let index = at + 1;
  while (isIdent(source[index])) index++;
  return { text: source.slice(at, index), end: index };
}

export function namedAt(source: string, at: number, name: string): boolean {
  if (!source.startsWith(name, at)) return false;
  if (isIdent(source[at - 1]) || source[at - 1] === '.') return false;
  return !isIdent(source[at + name.length]);
}

/** String fields of an object, or null when a field is not a string. An empty object is an empty env. */
function fieldsOf(source: string, open: number, close: number): Record<string, string> | null {
  const fields: Record<string, string> = {};
  let index = open + 1;
  while (index < close) {
    index = gap(source, index);
    if (index >= close) break;
    if (source[index] === ',') {
      index++;
      continue;
    }
    let key = '';
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read?.value) return null;
      key = read.value;
      index = read.end;
    } else if (isIdentStart(source[index])) {
      const name = readIdent(source, index);
      key = name.text;
      index = name.end;
    } else return null;
    index = gap(source, index);
    if (source[index] !== ':') return null;
    index = gap(source, index + 1);
    const quoted = scanQuote(source, index);
    if (!quoted || quoted.value === null) return null;
    fields[key] = quoted.value;
    index = gap(source, quoted.end);
    if (source[index] === ',') index++;
  }
  return fields;
}

function readPrimary(source: string, at: number, bindings: Map<string, Value>): { value: Value; end: number } {
  const start = gap(source, at);
  const quoted = scanQuote(source, start);
  if (quoted) return { value: quoted.value === null ? { kind: 'unknown' } : { kind: 'text', text: quoted.value }, end: quoted.end };
  if (source[start] === '[') return readList(source, start, bindings);
  if (source[start] === '{') {
    const close = matchClose(source, start);
    if (close < 0) return { value: { kind: 'unknown' }, end: source.length };
    const env = fieldsOf(source, start, close);
    return { value: env ? { kind: 'env', env } : { kind: 'unknown' }, end: close + 1 };
  }
  if (source[start] === '(') {
    const close = matchClose(source, start);
    if (close < 0) return { value: { kind: 'unknown' }, end: source.length };
    const inner = evaluate(source, start + 1, bindings);
    if (gap(source, inner.end) === close) return { value: inner.value, end: close + 1 };
    return { value: { kind: 'unknown' }, end: close + 1 };
  }
  if (isIdentStart(source[start])) {
    const name = readIdent(source, start);
    return { value: bindings.get(name.text) ?? { kind: 'unknown' }, end: name.end };
  }
  return { value: { kind: 'unknown' }, end: skipExpr(source, start) };
}

function readList(source: string, at: number, bindings: Map<string, Value>): { value: Value; end: number } {
  const close = matchClose(source, at);
  if (close < 0) return { value: { kind: 'unknown' }, end: source.length };
  const items: string[] = [];
  let unknown = false;
  let index = at + 1;
  while (index < close) {
    index = gap(source, index);
    if (index >= close) break;
    if (source[index] === ',') {
      index++;
      continue;
    }
    const spread = source.startsWith('...', index);
    if (spread) index += 3;
    const part = evaluate(source, index, bindings);
    index = gap(source, part.end);
    if (part.value.kind === 'text') items.push(part.value.text);
    else if (part.value.kind === 'list' && spread) items.push(...part.value.items);
    else unknown = true;
    if (source[index] === ',') index++;
  }
  return { value: unknown ? { kind: 'unknown' } : { kind: 'list', items }, end: close + 1 };
}

export function evaluate(source: string, at: number, bindings: Map<string, Value>): { value: Value; end: number } {
  let current = readPrimary(source, at, bindings);
  for (;;) {
    const index = gap(source, current.end);
    const method = source[index] === '.' ? methodAt(source, index) : '';
    if (method === 'join' || method === 'replace' || method === 'concat') {
      const open = gap(source, index + 1 + method.length);
      if (source[open] !== '(') return { value: { kind: 'unknown' }, end: skipExpr(source, index) };
      const close = matchClose(source, open);
      if (close < 0) return { value: { kind: 'unknown' }, end: source.length };
      current = { value: applyMethod(method, current.value, argValues(source, open + 1, close, bindings)), end: close + 1 };
      continue;
    }
    if (source[index] === '+' && source[index + 1] !== '+' && source[index + 1] !== '=') {
      const right = readPrimary(source, index + 1, bindings);
      const leftText = current.value.kind === 'text' ? current.value.text : null;
      const rightText = right.value.kind === 'text' ? right.value.text : null;
      current = { value: leftText !== null && rightText !== null ? { kind: 'text', text: leftText + rightText } : { kind: 'unknown' }, end: right.end };
      continue;
    }
    return current;
  }
}

function methodAt(source: string, dot: number): string {
  if (!isIdentStart(source[dot + 1])) return '';
  const name = readIdent(source, dot + 1);
  return name.text === 'join' || name.text === 'replace' || name.text === 'concat' ? name.text : '';
}

function argValues(source: string, from: number, to: number, bindings: Map<string, Value>): Value[] {
  const values: Value[] = [];
  let index = from;
  while (index < to) {
    index = gap(source, index);
    if (index >= to) break;
    const part = evaluate(source, index, bindings);
    values.push(part.value);
    index = gap(source, part.end);
    if (source[index] === ',') index++;
  }
  return values;
}

function applyMethod(method: string, value: Value, args: Value[]): Value {
  const text = (item: Value | undefined): string | null => (item?.kind === 'text' ? item.text : null);
  if (method === 'join' && value.kind === 'list' && text(args[0]) !== null) return { kind: 'text', text: value.items.join(text(args[0]) ?? '') };
  if (method === 'replace' && value.kind === 'text' && text(args[0]) !== null && text(args[1]) !== null) {
    return { kind: 'text', text: value.text.replace(text(args[0]) ?? '', text(args[1]) ?? '') };
  }
  if (method === 'concat' && value.kind === 'list' && args[0]?.kind === 'list') return { kind: 'list', items: [...value.items, ...args[0].items] };
  if (method === 'concat' && value.kind === 'text' && text(args[0]) !== null) return { kind: 'text', text: value.text + (text(args[0]) ?? '') };
  return { kind: 'unknown' };
}

/** The `field` object inside the object from `open` to `close`, when its value is an object. */
export function fieldObject(source: string, open: number, close: number, field: string): { open: number; close: number } | null {
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
    else if (depth === 1 && namedAt(source, index, field)) {
      const colon = gap(source, index + field.length);
      if (source[colon] !== ':') continue;
      const value = gap(source, colon + 1);
      if (source[value] !== '{') return null;
      const end = matchClose(source, value);
      return end < 0 ? null : { open: value, close: end };
    }
  }
  return null;
}

/** String fields one level inside the object, ignoring fields whose value is not a string. */
export function stringFields(source: string, open: number, close: number): Record<string, string> {
  const fields: Record<string, string> = {};
  let depth = 0;
  for (let index = open; index < close; index++) {
    if (quoteOf(source[index])) {
      const read = scanQuote(source, index);
      if (!read) return fields;
      if (depth === 1) {
        const key = read.value ?? '';
        const colon = gap(source, read.end);
        if (key && source[colon] === ':') {
          const quoted = scanQuote(source, gap(source, colon + 1));
          if (quoted?.value !== null && quoted) fields[key] = quoted.value;
        }
      }
      index = read.end - 1;
      continue;
    }
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
    else if (depth === 1 && isIdentStart(source[index])) {
      const name = readIdent(source, index);
      const colon = gap(source, name.end);
      if (source[colon] === ':') {
        const quoted = scanQuote(source, gap(source, colon + 1));
        if (quoted?.value !== null && quoted) fields[name.text] = quoted.value;
      }
      index = name.end - 1;
    }
  }
  return fields;
}

export function lineAt(source: string, index: number): number {
  let line = 1;
  for (let at = 0; at < index && at < source.length; at++) if (source[at] === '\n') line++;
  return line;
}