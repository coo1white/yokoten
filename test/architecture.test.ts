// The shape of the code, checked. A rule about structure that no test holds drifts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Lowest first. A module may import from its own layer or a lower one, never a higher.
// rules: what is allowed, as pure functions. run: the checks at work (hook, commit, CI).
// agents: one adapter per AI runtime. host: one adapter per code host (the bot, a CI
// run's pull request). setup: writing yokoten into a machine or a project.
const LAYERS = ['rules', 'run', 'agents', 'host', 'setup'];

test('layers: no module imports from a layer above its own', () => {
  const found = new Set<string>();
  for (const layer of readdirSync(SRC)) {
    assert.ok(LAYERS.includes(layer), `src/${layer}/ is not in LAYERS: add it, in order`);
    for (const file of readdirSync(join(SRC, layer))) {
      const text = readFileSync(join(SRC, layer, file), 'utf8');
      for (const [, spec] of text.matchAll(/from '(\.[^']+)'/g)) {
        const target = relative(SRC, join(SRC, layer, spec)).split(/[\\/]/)[0];
        found.add(`${layer}->${target}`);
        assert.ok(LAYERS.indexOf(target) <= LAYERS.indexOf(layer), `src/${layer}/${file} imports ${spec}, from the higher layer ${target}`);
      }
    }
  }
  assert.ok(found.size > 0, 'the import scan found nothing; the pattern is broken');
});

// A step names what it needs in host-neutral words; only src/host/ talks to a host's API
// (record 0004). Then adding a host (Gitea) means one new adapter, not a change in each step.
const HOST_API = /api\.github\.com|\bgh api\b|GITHUB_EVENT_PATH/;
const namesHostApi = (files: Record<string, string>) => Object.keys(files).filter((p) => !p.startsWith('src/host/') && HOST_API.test(files[p]));

test('host: nothing outside src/host/ names a GitHub API (#33)', () => {
  assert.deepEqual(namesHostApi({ 'src/setup/a.ts': 'run gh api repos/x', 'src/rules/b.ts': 'env.GITHUB_EVENT_PATH', 'bin/c.ts': 'https://api.github.com', 'src/host/github.ts': 'https://api.github.com', 'src/run/d.ts': 'gh pr view' }), ['src/setup/a.ts', 'src/rules/b.ts', 'bin/c.ts']);
  const files: Record<string, string> = {};
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)) files[path] = readFileSync(join(ROOT, path), 'utf8');
  assert.ok(Object.keys(files).some((p) => p.startsWith('src/host/') && HOST_API.test(files[p])), 'src/host/ names no API; the scan is broken');
  assert.deepEqual(namesHostApi(files), [], 'move the host call into an adapter in src/host/');
});

test('AGENTS.md: the core rules here are the kit\'s, word for word', () => {
  const core = (path: string) => readFileSync(join(ROOT, path), 'utf8').split('\n## This project')[0];
  assert.equal(core('AGENTS.md'), core('kit/project/AGENTS.md'), 'change kit/project/AGENTS.md and copy it here, or the other way round');
});

// A tag can be moved to other code; a commit can't. Every action is pinned to a full
// commit, with the version it is in a comment for people and Dependabot. A local
// action (`./path`) is code in the repo and needs no pin.
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/;
const unpinned = (text: string) =>
  [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/gm)].map((m) => m[1]).filter((ref) => !ref.startsWith('./') && !PINNED.test(ref));

test('workflows: every action is pinned to a commit, the version in a comment', () => {
  assert.deepEqual(unpinned('      - uses: actions/checkout@v4\n        uses: a/b@main\n      - uses: ./local\n'), ['actions/checkout@v4', 'a/b@main']);
  assert.deepEqual(unpinned(`      - uses: a/b@${'0'.repeat(40)}\n`), [`a/b@${'0'.repeat(40)}`], 'a pin with no version comment');
  let seen = 0;
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      seen += [...text.matchAll(/uses:/g)].length;
      assert.deepEqual(unpinned(text), [], `${dir}/${file}: pin each action to a commit, as \`owner/repo@<40 hex> # vX.Y.Z\``);
    }
  }
  // The action other repos run (#106) pins what it uses the same way.
  const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.ok(/uses:/.test(action), 'action.yml: no `uses:` found; the scan is broken');
  assert.deepEqual(unpinned(action), [], 'action.yml: pin each action to a commit, as `owner/repo@<40 hex> # vX.Y.Z`');
  assert.ok(seen > 0, 'no `uses:` found; the scan is broken');
});

// Node runs .ts as it is, so no other code file is needed; one appearing means someone
// reached for a build-era habit (AGENTS.md, "This project").
const strayCode = (paths: string[]) => paths.filter((p) => /^(bin|src|test)\//.test(p) && /\.(js|mjs|cjs|jsx|tsx|mts|cts)$/.test(p));

test('code is .ts only: no .js, .mjs, .cjs or .tsx under bin, src or test (#43)', () => {
  assert.deepEqual(strayCode(['src/a.ts', 'src/b.mjs', 'test/c.tsx', 'bin/d.js', 'kit/e.js', 'docs/f.md']), ['src/b.mjs', 'test/c.tsx', 'bin/d.js']);
  const files = execFileSync('git', ['ls-files', 'bin', 'src', 'test'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(files.some((f) => f.endsWith('.ts')), 'no .ts found; the scan is broken');
  assert.deepEqual(strayCode(files), [], 'write it as .ts: Node runs it with no build');
});

// The ruleset on main names one check, `ci`. So `ci` must wait for every other job in
// its workflow, and run even when one of them failed. Then a red job turns `ci` red (#36).
// The jobs are read from the text: a job is a key two spaces in under `jobs:`.
const jobs = (text: string) => {
  const body = text.split(/^jobs:\n/m)[1] ?? '';
  return body.split(/^ {2}(?=[\w-]+:\n)/m).slice(1).map((block) => ({
    name: block.slice(0, block.indexOf(':')),
    block,
  }));
};
const ciProblems = (text: string) => {
  const all = jobs(text);
  const ci = all.find((j) => j.name === 'ci');
  if (!ci) return ['no `ci` job'];
  const problems: string[] = [];
  if (!/^ {4}if: always\(\)$/m.test(ci.block)) problems.push('`ci` has no `if: always()`');
  const needs = (ci.block.match(/^ {4}needs: \[(.*)\]$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const j of all) if (j.name !== 'ci' && !needs.includes(j.name)) problems.push(`\`ci\` does not need \`${j.name}\``);
  for (const j of all) if (!/^ {4}timeout-minutes: \d+$/m.test(j.block)) problems.push(`\`${j.name}\` has no time limit`);
  if (!/^permissions: \{\}$/m.test(text)) problems.push('the workflow does not start from no permissions');
  return problems;
};

test('workflows: the one required check, `ci`, waits for every job (#36)', () => {
  const good = 'permissions: {}\njobs:\n  a:\n    timeout-minutes: 10\n  ci:\n    if: always()\n    needs: [a]\n    timeout-minutes: 10\n';
  assert.deepEqual(ciProblems(good), []);
  assert.deepEqual(ciProblems(good.replace('jobs:\n', 'jobs:\n  b:\n    timeout-minutes: 5\n')), ['`ci` does not need `b`']);
  assert.deepEqual(ciProblems(good.replace('    if: always()\n', '')), ['`ci` has no `if: always()`']);
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    const text = readFileSync(join(ROOT, dir, 'yokoten.yml'), 'utf8');
    assert.ok(jobs(text).length > 1, `${dir}/yokoten.yml: no jobs found; the scan is broken`);
    assert.deepEqual(ciProblems(text), [], `${dir}/yokoten.yml`);
  }
});

test('workflows: checkout keeps no token (#36)', () => {
  for (const dir of ['.github/workflows', 'kit/project/.github/workflows']) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      const checkouts = [...text.matchAll(/uses: actions\/checkout@.*\n((?: {8,}.*\n)*)/g)];
      for (const c of checkouts) assert.match(c[1], /persist-credentials: false/, `${dir}/${file}: add \`persist-credentials: false\` to checkout`);
    }
  }
});

// ---- Names (#109, record 0006) ----
//
// The names we declare in src/ and bin/ follow the rule in AGENTS.md. This reads them
// from the code. CI runs the tests without `npm ci`, so the TypeScript compiler is not
// there. TypeScript 7 also has no stable compiler API for JavaScript. So this is a small
// reader, not a parser, with Node's standard library only.
//
// It cuts the text into tokens: names, punctuation, strings, numbers and regular
// expressions. Comments are dropped. Then it finds declarations by their shape:
// - `const`, `let` and `var`, with `{...}` and `[...]` patterns;
// - parameters of functions, methods, arrow functions and `catch`;
// - function, class, interface and type names;
// - members of interfaces, object types and classes.
// It does not read object literal keys or imports: their names often come from another
// format. It does not read type parameters (`<T>`): Google's guide allows one letter.
// It does not read test/: a test may keep a short name inside one `test()`.

interface Token {
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

function tokenize(text: string): Token[] {
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

type DeclarationKind = 'variable' | 'parameter' | 'function' | 'type' | 'property';

interface Declaration {
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

function findDeclarations(tokens: Token[]): Declaration[] {
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
const splitWords = (name: string) => name.replace(/^[_$]+|[_$]+$/g, '').split(/[_$]+/).flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+\d*|[A-Z]+\d*|\d+/g) ?? []);
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

interface NameProblem {
  line: number;
  name: string;
  reason: string;
  fix: string;
}

const MAX_WORDS = 4;
const MAX_ONE_LETTER_LINES = 10;
// A whole word for the letters people use most, for the fix.
const LETTER_WORDS: Record<string, string> = { a: 'args', c: 'character', e: 'error', f: 'file', i: 'index', k: 'key', l: 'label', n: 'count', p: 'path', r: 'result', s: 'text', t: 'text', v: 'value' };
const toCamelCase = (name: string) => name.toLowerCase().replace(/_([a-z\d])/g, (_, letter: string) => letter.toUpperCase());

function findNameProblems(text: string): NameProblem[] {
  const tokens = tokenize(text);
  const declarations = findDeclarations(tokens);
  const problems: NameProblem[] = [];
  for (const declaration of declarations) {
    const { name, line, kind } = declaration;
    const add = (reason: string, fix: string) => problems.push({ line, name, reason, fix });
    const wordCount = splitWords(name).length;
    const example = Object.hasOwn(LETTER_WORDS, name) ? `, e.g. "${LETTER_WORDS[name]}"` : '';
    if (wordCount > MAX_WORDS) add(`${wordCount} words, over ${MAX_WORDS}`, 'keep the words a reader needs; the file and the type say the rest, e.g. "processTheUserInputDataNow" becomes "parseInput"');
    if (name === '_') {
      if (kind !== 'parameter') add('`_` is only for a parameter you do not use', 'leave a hole in the pattern, e.g. `const [, second] = pair`');
    } else if (/^_|_$/.test(name)) add('it starts or ends with `_`', `call it "${name.replace(/^_+|_+$/g, '')}"; for a parameter you do not use, write \`_\``);
    if (name.length === 1 && name !== '_') {
      if (declaration.isExported) add('one letter, and exported', `other files read it far from here: name what it is${example}`);
      else if (kind === 'property') add('one letter, and a property', `code reads it far from here: name what it is${example}`);
      else {
        const span = findLastUse(tokens, declaration, declarations) - line;
        if (span > MAX_ONE_LETTER_LINES) add(`one letter, used ${span} lines on`, `a reader must scroll back to learn what it holds: name what it is${example}`);
      }
    }
    const isInFunction = kind === 'parameter' || (kind === 'variable' && declaration.isNested);
    if (isInFunction && isConstantCase(name)) add('CONSTANT_CASE inside a function', `CONSTANT_CASE is for a fixed value at the top of a file: move it there, or call it "${toCamelCase(name)}"`);
  }
  return problems;
}

test('names: words are counted from camelCase, PascalCase and CONSTANT_CASE (#109)', () => {
  assert.deepEqual(splitWords('loadHttpUrl'), ['load', 'Http', 'Url']);
  assert.deepEqual(splitWords('loadHTTPUrl'), ['load', 'HTTP', 'Url']);
  assert.deepEqual(splitWords('CODEOWNERS_PLACES'), ['CODEOWNERS', 'PLACES']);
  assert.deepEqual(splitWords('sha256Hex'), ['sha256', 'Hex']);
  assert.deepEqual(splitWords('_'), []);
});

test('names: the reader catches each kind of bad name (#109)', () => {
  const bad = [
    'export const x = 1;',
    'function load(_unused: string, value_: number, _: boolean) {',
    '  const MAX_TRIES = 3;',
    '  let i = 0;',
    ...Array(10).fill('  i++;'),
    '  return MAX_TRIES + i;',
    '}',
    'const processTheUserInputDataNow = () => 1;',
    'interface Shape { q: number; size: number }',
    'const [_, second] = pair;',
  ].join('\n');
  assert.deepEqual(findNameProblems(bad).map((problem) => `${problem.line}: ${problem.name}: ${problem.reason}`), [
    '1: x: one letter, and exported',
    '2: _unused: it starts or ends with `_`',
    '2: value_: it starts or ends with `_`',
    '3: MAX_TRIES: CONSTANT_CASE inside a function',
    '4: i: one letter, used 11 lines on',
    '17: processTheUserInputDataNow: 6 words, over 4',
    '18: q: one letter, and a property',
    '19: _: `_` is only for a parameter you do not use',
  ]);
  const fixes = findNameProblems(bad).map((problem) => problem.fix);
  assert.match(fixes[3], /"maxTries"/);
  assert.match(fixes[4], /"index"/);
});

test('names: strings, comments, templates and regular expressions are not read as code (#109)', () => {
  const good = [
    "const text = 'const _bad = 1; let VERY_LONG_NAME_IS_BAD';",
    'const shown = `${ { _key: 1 }._key } and ${`nested ${text}`} let _x`;',
    'const pattern = /const _x = [/]+/g; // const _comment',
    '/* let _block = 2; */',
    'const half = shown.length / 2 / 1;',
    'export function sum(list: number[]): number {',
    '  let total = 0;',
    '  for (const n of list) total += n;',
    '  return list.reduce((a, b) => a + b, total);',
    '}',
    'const ROOT_DIR = "x";',
    'const handler = { run(value: string) { return value; } };',
    'const ignore = (_: unknown, item: string) => item;',
  ].join('\n');
  assert.deepEqual(findNameProblems(good), []);
  const names = findDeclarations(tokenize(good)).map((declaration) => declaration.name);
  assert.deepEqual(names, ['text', 'shown', 'pattern', 'half', 'sum', 'list', 'total', 'n', 'a', 'b', 'ROOT_DIR', 'handler', 'run', 'value', 'ignore', '_', 'item']);
});

test('names: src/ and bin/ use whole, short names (#109)', () => {
  const found: string[] = [];
  const kinds = new Set<string>();
  let declared = 0;
  for (const path of execFileSync('git', ['ls-files', 'bin', 'src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((file) => file.endsWith('.ts'))) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const declarations = findDeclarations(tokenize(text));
    declared += declarations.length;
    for (const declaration of declarations) kinds.add(declaration.kind);
    for (const problem of findNameProblems(text)) found.push(`${path}:${problem.line}: ${problem.name} — ${problem.reason} — ${problem.fix}`);
  }
  assert.ok(declared > 500, `only ${declared} names found in src/ and bin/; the reader is broken`);
  assert.deepEqual([...kinds].sort(), ['function', 'parameter', 'property', 'type', 'variable'], 'a kind of declaration was not found; the reader is broken');
  assert.deepEqual(found, [], 'rename each one; the rule and its reasons are in AGENTS.md ("Names") and docs/records/0006-names.md');
});
