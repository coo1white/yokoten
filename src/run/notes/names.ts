// The names rule (record 0006): whole words, at most four, and one letter only for a
// name used within 10 lines. The test holds yokoten's own code to it, and `check --pr`
// notes names that break it in the lines a pull request adds, in any project.
//
// Both must run with no dependencies: CI runs the tests without `npm ci`, and a project
// may not have TypeScript at all. TypeScript 7 also has no stable compiler API for
// JavaScript. So this is a small reader, not a parser, with Node's standard library only.
//
// It cuts the text into tokens: names, punctuation, strings, numbers and regular
// expressions. Comments are dropped. Then it finds declarations by their shape:
// - `const`, `let` and `var`, with `{...}` and `[...]` patterns;
// - parameters of functions, methods, arrow functions and `catch`;
// - function, class, interface and type names;
// - members of interfaces, object types and classes.
// It does not read object literal keys or imports: their names often come from another
// format. It does not read type parameters (`<T>`): Google's guide allows one letter.

import { type Finding, finding } from '../../rules/message.ts';

export interface Token {
  kind: 'name' | 'punct' | 'string' | 'number' | 'regex';
  text: string;
  line: number;
}

// Punctuation read as one token. `>>` and `>=` are not here: `Map<string, Set<string>>`
// closes two angle brackets.
const PUNCTUATION = ['...', '===', '!==', '=>', '?.', '??', '||', '&&', '==', '!=', '<=', '++', '--'];
// After these names a `/` starts a regular expression, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const NUMBER = /(?:0[xXbBoO][\da-fA-F_]+n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/y;
const NAME = /[A-Za-z_$#][\w$]*/y;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // What each open `{` is: a block or object, or the `${` of a template.
  const braces: ('brace' | 'template')[] = [];
  let line = 1;
  let at = text.startsWith('#!') ? text.indexOf('\n') : 0;
  const push = (kind: Token['kind'], from: number, to: number) => tokens.push({ kind, text: text.slice(from, to), line });
  const count = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (text[k] === '\n') line++;
  };
  // Reads template text from `from` (just after a backtick or a closing `}`) to the next
  // backtick or `${`.
  const template = (from: number) => {
    let end = from;
    while (end < text.length && text[end] !== '`' && !(text[end] === '$' && text[end + 1] === '{')) end += text[end] === '\\' ? 2 : 1;
    push('string', from, end);
    count(from, end);
    if (text[end] === '$') {
      braces.push('template');
      push('punct', end, end + 2);
      return end + 2;
    }
    return end + 1;
  };
  while (at > -1 && at < text.length) {
    const character = text[at];
    const next = text[at + 1];
    if (character === '\n') {
      line++;
      at++;
    } else if (/\s/.test(character)) at++;
    else if (character === '/' && next === '/') at = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
    else if (character === '/' && next === '*') {
      const end = text.indexOf('*/', at + 2);
      const stop = end === -1 ? text.length : end + 2;
      count(at, stop);
      at = stop;
    } else if (character === "'" || character === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== character && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      push('string', at, end + 1);
      at = end + 1;
    } else if (character === '`') at = template(at + 1);
    else if (character === '}' && braces.at(-1) === 'template') {
      braces.pop();
      push('punct', at, at + 1);
      at = template(at + 1);
    } else if (character === '/' && startsRegex(tokens.at(-1))) {
      let end = at + 1;
      let inClass = false;
      while (end < text.length && text[end] !== '\n' && (inClass || text[end] !== '/')) {
        if (text[end] === '[') inClass = true;
        else if (text[end] === ']') inClass = false;
        end += text[end] === '\\' ? 2 : 1;
      }
      end++;
      while (/[a-z]/.test(text[end] ?? '')) end++;
      push('regex', at, end);
      at = end;
    } else if (/\d/.test(character) || (character === '.' && /\d/.test(next ?? ''))) {
      NUMBER.lastIndex = at;
      const length = NUMBER.exec(text)?.[0].length ?? 1;
      push('number', at, at + length);
      at += length;
    } else if (/[A-Za-z_$#]/.test(character)) {
      NAME.lastIndex = at;
      const length = NAME.exec(text)?.[0].length ?? 1;
      push('name', at, at + length);
      at += length;
    } else {
      const length = PUNCTUATION.find((p) => text.startsWith(p, at))?.length ?? 1;
      if (character === '{') braces.push('brace');
      else if (character === '}') braces.pop();
      push('punct', at, at + length);
      at += length;
    }
  }
  return tokens;
}

function startsRegex(before: Token | undefined): boolean {
  if (!before) return true;
  if (before.kind === 'name') return BEFORE_REGEX.has(before.text);
  if (before.kind === 'punct') return ![')', ']', '}'].includes(before.text);
  return false;
}

export type DeclarationKind = 'variable' | 'parameter' | 'function' | 'type' | 'property';

export interface Declaration {
  name: string;
  line: number;
  kind: DeclarationKind;
  /** The token that names it. */
  at: number;
  /** The token after the last one where the name can be used. */
  scopeEnd: number;
  isExported: boolean;
  /** Inside a function or block, not at the top of the file. */
  isNested: boolean;
}

const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}']);
const MODIFIERS = new Set(['static', 'readonly', 'public', 'private', 'protected', 'declare', 'async', 'get', 'set', 'accessor', 'override', 'abstract', '*']);
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'await', 'new']);

export function findDeclarations(tokens: Token[]): Declaration[] {
  const count = tokens.length;
  // For each opener, its closer; for each token, the opener it sits inside.
  const closerOf: number[] = new Array(count).fill(-1);
  const parentOf: number[] = new Array(count).fill(-1);
  const stack: number[] = [];
  tokens.forEach((token, index) => {
    parentOf[index] = stack.at(-1) ?? -1;
    if (token.kind !== 'punct') return;
    if (OPENERS.has(token.text)) stack.push(index);
    else if (CLOSERS.has(token.text) && stack.length) closerOf[stack.pop() as number] = index;
  });
  const textAt = (index: number) => tokens[index]?.text;
  const isPunct = (index: number, ...values: string[]) => tokens[index]?.kind === 'punct' && values.includes(tokens[index].text);
  const isName = (index: number) => tokens[index]?.kind === 'name';
  const after = (index: number) => (closerOf[index] === -1 ? count : closerOf[index] + 1);
  const blockEnd = (index: number) => (parentOf[index] === -1 ? count : after(parentOf[index]));

  const exportedNames = new Set<string>();
  const found = new Map<number, Declaration>();
  const declare = (at: number, kind: DeclarationKind, scopeEnd: number, isExported = false) => {
    if (!isName(at) || found.has(at)) return;
    const name = textAt(at).replace(/^#/, '');
    found.set(at, { name, line: tokens[at].line, kind, at, scopeEnd, isExported, isNested: parentOf[at] !== -1 });
  };

  // Skips a type, from `from` to the `,`, `=`, `;` or closer that ends it. Angle brackets
  // count here, and only here: in a type, `<` always opens.
  const skipType = (from: number, end: number, stops: string[]) => {
    let angles = 0;
    let index = from;
    while (index < end) {
      if (angles === 0 && isPunct(index, ...stops)) break;
      if (isPunct(index, '<')) angles++;
      else if (isPunct(index, '>') && angles > 0) angles--;
      if (isPunct(index, '{') && isPunct(index - 1, ':', '|', '&', '<', ',', '=', '(', '[')) readMembers(index);
      index = isPunct(index, ...OPENERS) ? after(index) : index + 1;
    }
    return index;
  };
  // Skips a value, from `from` to the next `,` or `;` (or `end`).
  const skipValue = (from: number, end: number) => {
    let index = from;
    while (index < end && !isPunct(index, ',', ';')) index = isPunct(index, ...OPENERS) ? after(index) : index + 1;
    return index;
  };
  // The token after a return type that starts at `from`: a body `{`, a `=>`, or the end
  // of a signature. A `{` right after `:`, `|` or `&` opens an object type, not the body.
  const skipReturnType = (from: number) => {
    let angles = 0;
    let index = from;
    while (index < count) {
      if (angles === 0 && isPunct(index, '=>', ';', ',', '=', ')', ']', '}')) return index;
      if (angles === 0 && isPunct(index, '{') && (isName(index - 1) || isPunct(index - 1, '>', ')', ']', '}'))) return index;
      if (isPunct(index, '<')) angles++;
      else if (isPunct(index, '>') && angles > 0) angles--;
      else if (isPunct(index, '{')) readMembers(index);
      index = isPunct(index, ...OPENERS) ? after(index) : index + 1;
    }
    return index;
  };

  // A binding: a name, or a `{...}` or `[...]` pattern. Returns the token after it.
  const readBinding = (at: number, kind: DeclarationKind, scopeEnd: number, isExported: boolean): number => {
    if (isName(at)) {
      declare(at, kind, scopeEnd, isExported);
      return at + 1;
    }
    if (!isPunct(at, '{', '[')) return at + 1;
    const end = closerOf[at] === -1 ? count : closerOf[at];
    const isObject = textAt(at) === '{';
    let index = at + 1;
    while (index < end) {
      const start = index;
      if (isPunct(index, ',')) {
        index++;
        continue;
      }
      if (isPunct(index, '...')) index = readBinding(index + 1, kind, scopeEnd, isExported);
      else if (isObject) {
        const key = index;
        index = isPunct(index, '[') ? after(index) : index + 1;
        if (isPunct(index, ':')) index = readBinding(index + 1, kind, scopeEnd, isExported);
        else declare(key, kind, scopeEnd, isExported);
      } else index = readBinding(index, kind, scopeEnd, isExported);
      if (isPunct(index, '=')) index = skipValue(index + 1, end);
      if (index <= start) index = start + 1;
    }
    return end + 1;
  };

  // A parameter list at `open`, with the token after the scope its names live in.
  const readParameters = (open: number, scopeEnd: number) => {
    const end = closerOf[open] === -1 ? count : closerOf[open];
    let index = open + 1;
    while (index < end) {
      const start = index;
      while (isName(index) && MODIFIERS.has(textAt(index)) && !isPunct(index + 1, ',', ':', '=', ')', '?')) index++;
      if (isPunct(index, '...')) index++;
      if (textAt(index) === 'this') index++;
      else index = readBinding(index, 'parameter', scopeEnd, false);
      if (isPunct(index, '?')) index++;
      if (isPunct(index, ':')) index = skipType(index + 1, end, [',', '=']);
      if (isPunct(index, '=')) index = skipValue(index + 1, end);
      if (isPunct(index, ',')) index++;
      if (index <= start) index = start + 1;
    }
  };
  // A function's parameters at `open`, and its body after them. Returns the token after
  // the body, or -1 when no body follows (an overload or a signature).
  const readFunction = (open: number) => {
    let index = after(open);
    if (isPunct(index, ':')) index = skipReturnType(index + 1);
    if (isPunct(index, '=>')) {
      const body = index + 1;
      const end = isPunct(body, '{') ? after(body) : skipValue(body, blockEnd(open) - 1);
      readParameters(open, end);
      return end;
    }
    if (!isPunct(index, '{')) return -1;
    readParameters(open, after(index));
    return after(index);
  };

  // The members of an interface, an object type or a class body, at `open`.
  const readMembers = (open: number) => {
    const end = closerOf[open] === -1 ? count : closerOf[open];
    let index = open + 1;
    while (index < end) {
      const start = index;
      while (isName(index) && MODIFIERS.has(textAt(index)) && !isPunct(index + 1, ',', ':', '=', ';', '(', '?', '!')) index++;
      if (isPunct(index, '*')) index++;
      if (isName(index)) {
        declare(index, 'property', count);
        index++;
        if (isPunct(index, '?', '!')) index++;
        if (isPunct(index, '<')) index = skipType(index + 1, end, ['>']) + 1;
        if (isPunct(index, '(')) {
          // A method. Its parameters are read where the main loop meets it.
          index = after(index);
          if (isPunct(index, ':')) index = skipReturnType(index + 1);
          if (isPunct(index, '{')) {
            index = after(index);
            continue;
          }
        } else if (isPunct(index, ':')) index = skipType(index + 1, end, [';', ',', '=']);
      } else if (isPunct(index, '[')) index = after(index);
      while (index < end && !isPunct(index, ';', ',')) index = isPunct(index, ...OPENERS) ? after(index) : index + 1;
      index++;
      if (index <= start) index = start + 1;
    }
  };

  // `export { a, b as c }` exports `a` and `b`.
  for (let index = 0; index < count; index++) {
    if (textAt(index) !== 'export' || !isPunct(index + 1, '{')) continue;
    for (let inner = index + 2; inner < closerOf[index + 1]; inner++) if (isName(inner) && textAt(inner) !== 'as' && textAt(inner - 1) !== 'as') exportedNames.add(textAt(inner));
  }

  // A function with a body or an arrow at `open`: read its parameters.
  const readArrow = (open: number) => {
    let next = after(open);
    if (isPunct(next, ':')) next = skipReturnType(next + 1);
    if (isPunct(next, '=>')) readFunction(open);
  };

  for (let index = 0; index < count; index++) {
    const token = tokens[index];
    const before = textAt(index - 1);
    if (isPunct(index - 1, '.', '?.')) continue;
    const isExported = before === 'export' || (['default', 'async', 'declare'].includes(before) && textAt(index - 2) === 'export');
    const isWord = token.kind === 'name';
    if (isWord && ['const', 'let', 'var'].includes(token.text) && (isName(index + 1) || isPunct(index + 1, '{', '['))) {
      // In `for (const x of xs)`, the name lives in the loop.
      let scopeEnd = blockEnd(index);
      if (isPunct(index - 1, '(') && (textAt(index - 2) === 'for' || textAt(index - 3) === 'for')) {
        const body = after(index - 1);
        scopeEnd = isPunct(body, '{') ? after(body) : skipValue(body, count);
      }
      const next = readBinding(index + 1, 'variable', scopeEnd, isExported);
      if (isPunct(next, ':')) skipType(next + 1, count, ['=', ';', ',']);
    } else if (isWord && token.text === 'function') {
      let at = index + 1;
      if (isPunct(at, '*')) at++;
      const name = isName(at) ? at++ : -1;
      if (isPunct(at, '<')) at = skipType(at + 1, count, ['>']) + 1;
      if (!isPunct(at, '(')) continue;
      readFunction(at);
      if (name !== -1) declare(name, 'function', blockEnd(index), isExported);
    } else if (isWord && token.text === 'catch' && isPunct(index + 1, '(')) {
      readBinding(index + 2, 'parameter', after(after(index + 1)), false);
    } else if (isWord && ['class', 'interface'].includes(token.text) && isName(index + 1)) {
      declare(index + 1, 'type', count, isExported);
      let open = index + 2;
      while (open < count && !isPunct(open, '{')) open = isPunct(open, '<') ? skipType(open + 1, count, ['>']) + 1 : open + 1;
      readMembers(open);
    } else if (isWord && token.text === 'type' && isName(index + 1) && isPunct(index + 2, '=', '<')) {
      declare(index + 1, 'type', count, isExported);
      let equals = index + 2;
      if (isPunct(equals, '<')) equals = skipType(equals + 1, count, ['>']) + 1;
      if (isPunct(equals, '=')) skipType(equals + 1, count, [';']);
    } else if (isPunct(index, '(') && (!isName(index - 1) || BEFORE_REGEX.has(before) || before === 'async')) {
      // An arrow function: `(a, b) =>`, or `(a): T =>`.
      readArrow(index);
    } else if (isPunct(index, '<') && (isPunct(index - 1, '=', '(', ',', ':') || before === 'async') && isName(index + 1)) {
      // A generic arrow function: `<T>(a: T) =>`.
      const open = skipType(index + 1, count, ['>']) + 1;
      if (isPunct(open, '(')) readArrow(open);
    } else if (isWord && isPunct(index + 1, '=>') && (index === 0 || isPunct(index - 1, '(', ',', '=', '[', '{', '?', '||', '&&', '??', '=>') || ['return', 'async'].includes(before))) {
      // An arrow function with one bare parameter: `x => ...`.
      const body = index + 2;
      declare(index, 'parameter', isPunct(body, '{') ? after(body) : skipValue(body, blockEnd(index) - 1));
    } else if (isWord && !NOT_METHODS.has(token.text) && isPunct(index + 1, '(') && (isPunct(index - 1, '{', ';', '}', ',', '*') || MODIFIERS.has(before))) {
      // A method in an object or a class: `name(a) {`.
      if (readFunction(index + 1) !== -1) declare(index, 'function', count);
    }
  }
  for (const declaration of found.values()) if (exportedNames.has(declaration.name) && !declaration.isNested) declaration.isExported = true;
  // Names are found in any order (a function's name after its parameters); sort by place.
  return [...found.values()].sort((a, b) => a.at - b.at);
}

// The words in a name: camelCase, PascalCase and CONSTANT_CASE alike. An acronym is one
// word (`loadHTTPUrl` is load, HTTP, Url), and digits stay with the word before them.
export const splitWords = (name: string) => name.replace(/^[_$]+|[_$]+$/g, '').split(/[_$]+/).flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+\d*|[A-Z]+\d*|\d+/g) ?? []);
const isConstantCase = (name: string) => /^[A-Z][A-Z\d]*(?:_[A-Z\d]+)*$/.test(name) && name.length > 1;

// The last line on which a name is used: tokens with its text inside its scope, not after
// a `.`, and not inside a nested declaration of the same name.
function findLastUse(tokens: Token[], declaration: Declaration, all: Declaration[]): number {
  const shadows = new Map(all.filter((d) => d.name === declaration.name && d !== declaration).map((d) => [d.at, d.scopeEnd]));
  let last = declaration.line;
  for (let index = declaration.at + 1; index < declaration.scopeEnd && index < tokens.length; index++) {
    const shadowEnd = shadows.get(index);
    if (shadowEnd !== undefined) {
      index = Math.max(index, shadowEnd - 1);
      continue;
    }
    const token = tokens[index];
    if (token.kind === 'name' && token.text === declaration.name && !['.', '?.'].includes(tokens[index - 1]?.text)) last = token.line;
  }
  return last;
}


/** What breaks the rule: a long-lived one-letter name, too many words, a stray `_`, CONSTANT_CASE in a function. */
export type NameProblemKind = 'one-letter' | 'too-many-words' | 'underscore' | 'constant-case';

/** A name that breaks the rule, with what, why and the fix (as in a Finding). */
export interface NameProblem {
  kind: NameProblemKind;
  line: number;
  name: string;
  what: string;
  why: string;
  fix: string;
}

const MAX_WORDS = 4;
const MAX_ONE_LETTER_LINES = 10;
// A whole word for the letters people use most, for the fix.
const LETTER_WORDS: Record<string, string> = { a: 'args', c: 'character', e: 'error', f: 'file', i: 'index', k: 'key', l: 'label', n: 'count', p: 'path', r: 'result', s: 'text', t: 'text', v: 'value' };
const toCamelCase = (name: string) => name.toLowerCase().replace(/_([a-z\d])/g, (_, letter: string) => letter.toUpperCase());

/** The names declared in a TypeScript or JavaScript text that break the rule, in order. */
export function findNameProblems(text: string): NameProblem[] {
  const tokens = tokenize(text);
  const declarations = findDeclarations(tokens);
  const problems: NameProblem[] = [];
  for (const declaration of declarations) {
    const { name, line, kind } = declaration;
    const add = (problemKind: NameProblemKind, what: string, why: string, fix: string) => problems.push({ kind: problemKind, line, name, what, why, fix });
    const wordCount = splitWords(name).length;
    if (wordCount > MAX_WORDS) {
      add('too-many-words', `"${name}" has ${wordCount} words, over ${MAX_WORDS}`, 'a long name is slow to read, and the words that matter get lost', 'keep the words a reader needs; the file and the type say the rest, e.g. "processTheUserInputDataNow" becomes "parseInput"');
    }
    if (name === '_') {
      if (kind !== 'parameter') add('underscore', `"_" names something that is not a parameter`, 'a lone `_` says "not used", and only a parameter can go unused', 'leave a hole in the pattern, e.g. `const [, second] = pair`');
    } else if (/^_|_$/.test(name)) {
      add('underscore', `"${name}" starts or ends with "_"`, 'the `_` tells a reader nothing', `call it "${name.replace(/^_+|_+$/g, '')}"; for a parameter you do not use, write \`_\``);
    }
    if (name.length === 1 && name !== '_') {
      const fix = `name what it is, e.g. ${Object.hasOwn(LETTER_WORDS, name) ? `"${LETTER_WORDS[name]}"` : '"total" for a sum'}`;
      if (declaration.isExported) add('one-letter', `"${name}" is one letter, and exported`, 'other files read it far from where it is declared', fix);
      else if (kind === 'property') add('one-letter', `"${name}" is one letter, and a property`, 'code reads it far from where it is declared', fix);
      else {
        const span = findLastUse(tokens, declaration, declarations) - line;
        if (span > MAX_ONE_LETTER_LINES) add('one-letter', `"${name}" is used for ${span} lines`, 'a reader must scroll back to learn what it holds', fix);
      }
    }
    const isInFunction = kind === 'parameter' || (kind === 'variable' && declaration.isNested);
    if (isInFunction && isConstantCase(name)) {
      add('constant-case', `"${name}" is CONSTANT_CASE inside a function`, 'CONSTANT_CASE says the value is fixed for the whole file', `move it to the top of the file, or call it "${toCamelCase(name)}"`);
    }
  }
  return problems;
}

/** A TypeScript or JavaScript file, by its extension: the files `check --pr` reads names in. */
export const isCodeFile = (path: string): boolean => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);

/**
 * Notes for hard-to-read names declared on the `added` lines of a file: a one-letter name
 * that lives long (name-short) and a name of more than 4 words (name-long). Notes, never
 * failures. Old lines are left alone, so a project is not noted all at once.
 */
export function nameNotes(file: string, text: string, added: ReadonlySet<number>): Finding[] {
  const notes: Finding[] = [];
  for (const problem of findNameProblems(text)) {
    if (!added.has(problem.line)) continue;
    const { what, why, fix, line } = problem;
    if (problem.kind === 'one-letter') notes.push(finding('name-short', what, fix, { file, line, why }));
    else if (problem.kind === 'too-many-words') notes.push(finding('name-long', what, fix, { file, line, why }));
  }
  return notes;
}
