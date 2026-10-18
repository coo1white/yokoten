// Splits test/ into one file per src module, by layer (issue #152). The big test files
// each share one import block, so parallel branches conflict there. After the split, a
// branch adds its imports to its own module's file.
//
// It reads each test file with the names reader's tokenizer (strings, templates, comments
// and regular expressions come out whole), cuts it into top-level statements, and places
// each test by the text before the first `:` of its name, with the table below. A test with
// no row stops it, with a list: there is no silent default. Each new file gets only the
// imports and declarations its tests use; a few shared ones move to test/helpers.ts. Test
// bodies are copied byte for byte. The one change: a path string on a line with
// `import.meta` gets one more `../` per folder deeper.
//
// Run it once, on a fresh main, when no branch is open on test/:
//   node scripts/split-tests.ts              rewrite test/
//   node scripts/split-tests.ts --dry-run    print the report and the new tree, write nothing
//   node scripts/split-tests.ts --out <dir>  write the new tree into <dir>, to check it
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDeclarations, type Token, tokenize } from '../src/run/names.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

// Where each test goes: target file under test/, and the "<source file>:<prefix>" keys it
// takes. The prefix is the test name up to its first `:` (the whole name if it has none).
// `<source>:*` takes every test of that file.
const MAPPING: [string, string[]][] = [
  ['rules/guards.test.ts', ['guards:*']],
  ['rules/privacy.test.ts', ['privacy:positive control', 'privacy:emails', 'privacy:IPs', 'privacy:private marks', 'privacy:private marks file', 'privacy:commit times', 'privacy:output']],
  ['rules/secrets.test.ts', ['privacy:secrets']],
  ['rules/config.test.ts', ['rules:glob', 'rules:config']],
  ['rules/layout.test.ts', ['rules:layout', 'rules:build output']],
  ['rules/message.test.ts', ['rules:messages', 'rules:docs']],
  ['rules/pr/pull-request.test.ts', ['rules:pull request', 'rules:pull request title']],
  ['rules/pr/codeowners.test.ts', ['rules:CODEOWNERS']],
  ['rules/pr/issue-title.test.ts', ['rules:issue title']],
  ['rules/pr/size.test.ts', ['rules:large pull request', 'rules:plain English']],
  ['run/changelog.test.ts', ['rules:changes', 'cli:changelog']],
  ['run/names.test.ts', ['rules:names']],
  ['run/translations.test.ts', ['rules:translations']],
  ['run/hook.test.ts', ['cli:hook', 'cli:hook --stop']],
  ['run/cli.test.ts', ['cli:exit codes', 'cli:--json']],
  ['run/check/staged.test.ts', ['cli:check --staged']],
  ['run/check/history.test.ts', ['cli:check --history']],
  ['run/check/pr.test.ts', ['cli:check --pr']],
  ['run/check/issue.test.ts', ['cli:check --issue']],
  ['run/check/actions.test.ts', ['cli:check --pr in GitHub Actions', 'cli:check in GitHub Actions', 'cli:check outside GitHub Actions']],
  ['run/learn.test.ts', ['cli:learn', 'rules:learn', 'rules:lessons']],
  ['agents/claude-code.test.ts', ['cli:plugin']],
  ['agents/codex.test.ts', ['cli:hook --agent codex']],
  ['agents/gemini.test.ts', ['cli:hook --agent gemini']],
  ['agents/llama.test.ts', ['road:adopt chat']],
  ['host/github/token.test.ts', ['bot:JWT', 'bot:token', 'bot:config', 'bot:repo', 'bot:env']],
  ['host/github/title.test.ts', ['bot:command title', 'bot:the bot is not a way around the guard', 'cli:bot']],
  ['host/github/output.test.ts', ['bot:annotations', 'bot:step summary']],
  ['setup/plan.test.ts', ['bot:planning', 'bot:milestone']],
  ['setup/road.test.ts', ['road:road']],
  ['setup/install.test.ts', ['cli:install']],
  ['setup/advice/adopt.test.ts', ['road:adopt facts', 'road:adopt answer', 'road:adopt draft', 'cli:adopt']],
  ['setup/advice/explain.test.ts', ['rules:explain']],
  ['setup/doctor/steps.test.ts', ['cli:doctor', 'rules:self-test']],
  ['setup/doctor/session.test.ts', ['cli:doctor --session']],
  ['setup/doctor/server.test.ts', ['bot:road', 'bot:server', 'bot:doctor']],
  ['setup/init/practices.test.ts', ['cli:init']],
  ['setup/init/update.test.ts', ['rules:core rules', 'cli:update']],
];
// Test files that stay where they are, unsplit (AGENTS.md and the guides name them).
const STAYS = ['architecture.test.ts'];
// Declarations that move to test/helpers.ts, from this file. Another file's declaration
// with the same code uses the helper too; one with other code stays local.
const HOIST = ['CLI', 'at', 'makeSandbox', 'ROOT'];
const HOIST_SOURCE = 'cli';
const HELPERS = 'helpers.ts';
const LAYERS = ['rules', 'run', 'agents', 'host', 'setup'];
const MAX_ENTRIES = 7;

const OPENERS = new Set(['(', '[', '{', '${']);
const CLOSERS = new Set([')', ']', '}']);
const STARTS = new Set(['import', 'const', 'let', 'var', 'function', 'async', 'type', 'interface', 'class', 'test']);
// Statements that end with their closing `}`, not with a `;`.
const BLOCK_STARTS = new Set(['function', 'async', 'interface', 'class']);

interface Located extends Token {
  start: number;
  end: number;
}

interface ImportName {
  local: string;
  imported: string;
  module: string;
  isType: boolean;
  isDefault: boolean;
}

interface Statement {
  kind: 'import' | 'test' | 'declaration';
  source: string;
  index: number;
  line: number;
  /** With its leading comments, without leading blank lines. */
  text: string;
  /** The comment lines above it. */
  leading: string;
  /** From its first token to its last: what two declarations are compared by. */
  code: string;
  declared: string[];
  uses: Set<string>;
  name: string;
  prefix: string;
  /** Leading comments of hoisted declarations just before it, which move here. */
  carried: string;
}

interface SourceFile {
  source: string;
  imports: ImportName[];
  statements: Statement[];
}

interface Target {
  path: string;
  depth: number;
  tests: Statement[];
  declarations: Statement[];
  imports: Map<string, ImportName>;
  helpers: Set<string>;
  text: string;
}

class SplitError extends Error {}

// Gives each token its place in the text. The tokenizer drops comments and keeps no
// offsets, so each token is found after the one before; only blanks, comments and
// backticks may lie between.
function locate(text: string, tokens: Token[]): Located[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineStarts.push(index + 1);
  let cursor = 0;
  return tokens.map((token) => {
    const start = text.indexOf(token.text, Math.max(cursor, lineStarts[token.line - 1] ?? 0));
    const gap = start === -1 ? 'missing' : text.slice(cursor, start).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/[\s`]/g, '');
    if (gap) throw new SplitError(`cannot place the token ${JSON.stringify(token.text)} on line ${token.line}`);
    cursor = start + token.text.length;
    return { ...token, start, end: cursor };
  });
}

// The names a statement may use from outside: not a property after `.`, not a key before
// `:` (`{ test: 'node --test' }`), and not a name the statement declares itself, where
// that declaration is in scope.
function usedNames(tokens: Located[]): Set<string> {
  const locals = findDeclarations(tokens).filter((declaration) => declaration.kind !== 'property');
  return new Set(
    tokens
      .filter((token, index) => {
        const before = tokens[index - 1]?.text ?? '';
        const isKey = tokens[index + 1]?.text === ':' && ['{', ','].includes(before);
        const isLocal = locals.some((declaration) => declaration.name === token.text && declaration.at <= index && index < declaration.scopeEnd);
        return token.kind === 'name' && !['.', '?.'].includes(before) && !isKey && !isLocal;
      })
      .map((token) => token.text),
  );
}

// A quoted string's value. Template strings are not read: a test name must be plain.
function stringValue(token: Located | undefined): string | undefined {
  if (!token || token.kind !== 'string' || !/^['"]/.test(token.text)) return undefined;
  let json = '';
  const inner = token.text.slice(1, -1);
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index];
    if (character === '\\' && inner[index + 1] === "'") json += inner[++index];
    else if (character === '\\') json += character + inner[++index];
    else json += character === '"' ? '\\"' : character;
  }
  return JSON.parse(`"${json}"`);
}

function declaredNames(tokens: Located[], file: string): string[] {
  let first = tokens[0].text === 'async' ? 1 : 0;
  const keyword = tokens[first].text;
  if (keyword === 'function' && tokens[first + 1]?.text === '*') first++;
  const next = tokens[first + 1];
  if (next?.kind === 'name') return [next.text];
  if (!['const', 'let', 'var'].includes(keyword) || !['{', '['].includes(next?.text ?? '')) throw new SplitError(`${file}:${tokens[0].line}: cannot read what this declares`);
  // A `{ a, b: c }` or `[a, b]` pattern: the names followed by `,`, `}`, `]` or `=`.
  const names: string[] = [];
  let depth = 0;
  for (let index = first + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (OPENERS.has(token.text)) depth++;
    else if (CLOSERS.has(token.text)) depth--;
    if (depth === 0) break;
    if (depth === 1 && token.kind === 'name' && [',', '}', ']', '='].includes(tokens[index + 1]?.text ?? '')) names.push(token.text);
  }
  return names;
}

function readImport(tokens: Located[], file: string): ImportName[] {
  const fail = () => new SplitError(`${file}:${tokens[0].line}: cannot read this import`);
  const fromAt = tokens.findIndex((token) => token.kind === 'name' && token.text === 'from');
  const module = stringValue(tokens[fromAt + 1]);
  if (fromAt === -1 || module === undefined) throw fail();
  const isTypeAll = tokens[1].text === 'type' && tokens[2].text !== 'from' && tokens[2].text !== ',';
  const names: ImportName[] = [];
  let index = isTypeAll ? 2 : 1;
  if (tokens[index].kind === 'name') {
    names.push({ local: tokens[index].text, imported: 'default', module, isType: isTypeAll, isDefault: true });
    index++;
    if (tokens[index].text === ',') index++;
  }
  if (tokens[index].text === '{') {
    index++;
    while (tokens[index].text !== '}') {
      const isType = isTypeAll || (tokens[index].text === 'type' && tokens[index + 1].kind === 'name' && ![',', '}'].includes(tokens[index + 1].text) && tokens[index + 1].text !== 'as');
      if (isType && !isTypeAll) index++;
      const imported = tokens[index].text;
      let local = imported;
      index++;
      if (tokens[index].text === 'as') {
        local = tokens[index + 1].text;
        index += 2;
      }
      names.push({ local, imported, module, isType, isDefault: false });
      if (tokens[index].text === ',') index++;
      else if (tokens[index].text !== '}') throw fail();
    }
    index++;
  }
  if (index !== fromAt) throw fail();
  return names;
}

// A module as the repo names it: `src/run/names.ts` from `../src/run/names.ts` in test/.
function canonicalModule(module: string, file: string): string {
  if (module.startsWith('node:')) return module;
  if (module.startsWith('../src/')) return module.slice(3);
  throw new SplitError(`${file}: imports ${module}; only node: and ../src/ imports are moved`);
}

// Reads a test file into its imports and top-level statements. `isSource` is false for a
// file this script wrote, whose imports are not moved again.
function parseFile(source: string, text: string, file: string, isSource = true): SourceFile {
  const tokens = locate(text, tokenize(text));
  const ranges: [number, number][] = [];
  let depth = 0;
  let first = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (index === first) {
      const isStart = STARTS.has(token.text) && token.kind === 'name' && (token.text !== 'async' || tokens[index + 1]?.text === 'function') && (token.text !== 'test' || tokens[index + 1]?.text === '(');
      if (!isStart) throw new SplitError(`${file}:${token.line}: a top-level statement this script does not know (${JSON.stringify(token.text)}); only imports, declarations and test() calls`);
    }
    if (token.kind === 'punct' && OPENERS.has(token.text)) depth++;
    else if (token.kind === 'punct' && CLOSERS.has(token.text)) depth--;
    if (depth < 0) throw new SplitError(`${file}:${token.line}: a closing bracket with no opening one`);
    if (depth > 0 || token.kind !== 'punct') continue;
    if (token.text === ';' || (token.text === '}' && BLOCK_STARTS.has(tokens[first].text))) {
      ranges.push([first, index]);
      first = index + 1;
    }
  }
  if (first < tokens.length) throw new SplitError(`${file}:${tokens[first].line}: a statement that does not end`);

  const lineEnd = (offset: number) => (text.indexOf('\n', offset) === -1 ? text.length : text.indexOf('\n', offset));
  const imports: ImportName[] = [];
  const statements: Statement[] = [];
  let from = 0;
  ranges.forEach(([firstToken, lastToken], index) => {
    const own = tokens.slice(firstToken, lastToken + 1);
    const end = lineEnd(own.at(-1)?.end ?? 0);
    const rest = text.slice(own.at(-1)?.end, end).replace(/\/\/.*|\/\*.*?\*\//g, '').trim();
    if (from > own[0].start || rest) throw new SplitError(`${file}:${own[0].line}: two statements share a line`);
    const raw = text.slice(from, end).replace(/^(?:[ \t]*\n)+/, '');
    const lineStart = text.lastIndexOf('\n', own[0].start - 1) + 1;
    from = end + 1;
    const kind = own[0].text === 'import' ? 'import' : own[0].text === 'test' ? 'test' : 'declaration';
    const statement: Statement = { kind, source, index, line: own[0].line, text: raw, leading: raw.slice(0, raw.length - (end - lineStart)), code: text.slice(own[0].start, own.at(-1)?.end), declared: [], uses: usedNames(own), name: '', prefix: '', carried: '' };
    if (kind === 'import') {
      for (const name of readImport(own, file)) imports.push({ ...name, module: isSource ? canonicalModule(name.module, file) : name.module });
    } else if (kind === 'test') {
      const name = stringValue(own[2]);
      if (name === undefined) throw new SplitError(`${file}:${own[0].line}: a test whose name is not a plain string`);
      statement.name = name;
      statement.prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : name;
    } else statement.declared = declaredNames(own, file);
    statements.push(statement);
  });
  if (text.slice(from).trim()) throw new SplitError(`${file}: text after the last statement`);
  return { source, imports, statements };
}

// One more `../` (or one fewer, for a negative `delta`) in each path string on a line that
// uses `import.meta`. Paths elsewhere are relative to the working folder, or are data.
function shiftPaths(text: string, delta: number): { text: string; shifted: number } {
  if (delta === 0) return { text, shifted: 0 };
  const tokens = locate(text, tokenize(text));
  const metaLines = new Set(tokens.filter((token, index) => token.text === 'import' && tokens[index + 1]?.text === '.' && tokens[index + 2]?.text === 'meta').map((token) => token.line));
  let result = '';
  let cursor = 0;
  let shifted = 0;
  for (const token of tokens) {
    if (token.kind !== 'string' || !metaLines.has(token.line) || !/^(['"])\.\.(?:\/|\1)/.test(token.text)) continue;
    const parts = token.text.slice(1, -1).split('/');
    const ups = parts.findIndex((part) => part !== '..');
    const upCount = ups === -1 ? parts.length : ups;
    if (upCount + delta < 1) throw new SplitError(`cannot take ${-delta} folders off ${token.text}`);
    const path = [...Array<string>(upCount + delta).fill('..'), ...parts.slice(upCount)].join('/');
    result += text.slice(cursor, token.start) + token.text[0] + path + token.text[0];
    cursor = token.end;
    shifted++;
  }
  return { text: result + text.slice(cursor), shifted };
}

const compareNames = (left: string, right: string) => left.toLowerCase().localeCompare(right.toLowerCase()) || (left < right ? 1 : -1);

// node first, then the helpers, then src by layer, then by path.
function moduleRank(module: string): string {
  if (module.startsWith('node:')) return `0 ${module}`;
  if (module === HELPERS) return `1 ${module}`;
  const layer = LAYERS.indexOf(module.split('/')[1]);
  return `2 ${layer === -1 ? LAYERS.length : layer} ${module}`;
}

// The import lines for a file `depth` folders below test/: node first, then the helpers,
// then src by layer. Two or more names go one per line, so branches add separate lines.
function formatImports(names: ImportName[], depth: number): string {
  const byModule = new Map<string, ImportName[]>();
  for (const name of names) byModule.set(name.module, [...(byModule.get(name.module) ?? []), name]);
  const modules = [...byModule.keys()].sort((left, right) => (moduleRank(left) < moduleRank(right) ? -1 : 1));
  return modules
    .map((module) => {
      const list = byModule.get(module) ?? [];
      const path = module.startsWith('node:') ? module : module === HELPERS ? (depth === 0 ? `./${HELPERS}` : `${'../'.repeat(depth)}${HELPERS}`) : `${'../'.repeat(depth + 1)}${module}`;
      const fallback = list.find((name) => name.isDefault);
      const named = list.filter((name) => !name.isDefault).sort((left, right) => compareNames(left.local, right.local));
      const isTypeAll = named.length > 0 && named.every((name) => name.isType) && !fallback;
      const spell = (name: ImportName) => `${name.isType && !isTypeAll ? 'type ' : ''}${name.imported === name.local ? name.local : `${name.imported} as ${name.local}`}`;
      const head = `import ${isTypeAll ? 'type ' : ''}${fallback ? fallback.local : ''}${fallback && named.length ? ', ' : ''}`;
      if (!named.length) return `${head} from '${path}';`;
      if (named.length === 1) return `${head}{ ${spell(named[0])} } from '${path}';`;
      return `${head}{\n${named.map((name) => `  ${spell(name)},`).join('\n')}\n} from '${path}';`;
    })
    .join('\n');
}

// The src module a test file is for: `test/run/check/pr.test.ts` is for `src/run/check.ts`.
function moduleFor(target: string): { module: string; isPart: boolean } | undefined {
  const path = target.replace(/\.test\.ts$/, '');
  if (existsSync(join(ROOT, 'src', `${path}.ts`))) return { module: `src/${path}.ts`, isPart: false };
  if (existsSync(join(ROOT, 'src', `${dirname(path)}.ts`))) return { module: `src/${dirname(path)}.ts`, isPart: true };
  return undefined;
}

function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const outAt = args.indexOf('--out');
  const outArg = outAt === -1 ? undefined : args[outAt + 1];
  const known = args.every((arg, index) => arg === '--dry-run' || index === outAt || (outAt !== -1 && index === outAt + 1));
  if (!known || (outAt !== -1 && !outArg)) throw new SplitError('usage: node scripts/split-tests.ts [--dry-run] [--out <dir>]');

  const outDir = outArg === undefined ? undefined : resolve(outArg);
  const entries = readdirSync(TEST_DIR, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (folders.length) throw new SplitError(`test/ already has subfolders (${folders.join(', ')}): the split has run. Place new tests by hand, next to their module.`);
  const others = entries.filter((entry) => !entry.name.endsWith('.test.ts') && !STAYS.includes(entry.name)).map((entry) => entry.name);
  if (others.length) throw new SplitError(`test/ has files this script does not read: ${others.join(', ')}`);
  const sourceNames = entries.map((entry) => entry.name).filter((name) => !STAYS.includes(name)).sort();
  const files = new Map<string, SourceFile>();
  for (const name of sourceNames) {
    const source = name.replace(/\.test\.ts$/, '');
    files.set(source, parseFile(source, readFileSync(join(TEST_DIR, name), 'utf8'), `test/${name}`));
  }
  const sourceOrder = (source: string) => sourceNames.indexOf(`${source}.test.ts`);
  const byPlace = (left: Statement, right: Statement) => sourceOrder(left.source) - sourceOrder(right.source) || left.index - right.index;

  // Place every test, or stop with the ones that have no row.
  const targetOf = new Map<string, string>();
  for (const [target, keys] of MAPPING) {
    for (const key of keys) {
      if (targetOf.has(key)) throw new SplitError(`the mapping has "${key}" twice`);
      targetOf.set(key, target);
    }
  }
  const allTests = [...files.values()].flatMap((file) => file.statements.filter((statement) => statement.kind === 'test'));
  const placed = new Map<string, Statement[]>();
  const unmapped = new Map<string, Statement[]>();
  const usedKeys = new Set<string>();
  for (const test of allTests) {
    const exact = `${test.source}:${test.prefix}`;
    const key = targetOf.has(exact) ? exact : `${test.source}:*`;
    const target = targetOf.get(key);
    if (!target) {
      unmapped.set(exact, [...(unmapped.get(exact) ?? []), test]);
      continue;
    }
    usedKeys.add(key);
    placed.set(target, [...(placed.get(target) ?? []), test]);
  }
  if (unmapped.size) {
    const lines = [...unmapped].map(([key, tests]) => `  "${key}": ${tests.length} test(s), e.g. test/${tests[0].source}.test.ts:${tests[0].line} "${tests[0].name}"`);
    throw new SplitError(`tests with no row in MAPPING (scripts/split-tests.ts). Add each prefix to the target next to its src module:\n${lines.join('\n')}`);
  }

  // The helpers, and the declarations they replace in each file.
  const hoistFile = files.get(HOIST_SOURCE);
  const helperStatements = HOIST.map((name) => {
    const found = hoistFile?.statements.find((statement) => statement.kind === 'declaration' && statement.declared.includes(name));
    if (!found || found.declared.length !== 1) throw new SplitError(`test/${HOIST_SOURCE}.test.ts has no single declaration of ${name} to move to test/${HELPERS}`);
    return found;
  });
  // A declaration counts as a helper wherever a file has one with the same names and code.
  const keyOf = (statement: Statement) => `${statement.declared.join(',')}\n${statement.code}`;
  const helperKeys = new Set(helperStatements.map(keyOf));
  const isHoisted = (statement: Statement) => statement.kind === 'declaration' && helperKeys.has(keyOf(statement));
  // A hoisted declaration's leading comment moves to the next statement of its file.
  for (const file of files.values()) {
    let carried = '';
    for (const statement of file.statements) {
      if (isHoisted(statement)) carried += statement.leading;
      else if (carried) {
        statement.carried = carried;
        carried = '';
      }
    }
  }

  // Each target's declarations, imports and helpers, from the names its tests use.
  const report: string[] = [];
  const resolveAll = () =>
    [...placed]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([path, tests]) => {
        tests.sort(byPlace);
        const target: Target = { path, depth: path.split('/').length - 1, tests, declarations: [], imports: new Map(), helpers: new Set(), text: '' };
        resolveNames(target, tests, files, isHoisted, path);
        target.declarations.sort(byPlace);
        return target;
      });
  let targets = resolveAll();
  // A declaration copied into two or more files moves to the helpers, with what it uses,
  // so a later edit touches one place. Then every file is resolved again.
  const copies = new Map<Statement, number>();
  for (const target of targets) for (const statement of target.declarations) copies.set(statement, (copies.get(statement) ?? 0) + 1);
  // On a name clash the first by place moves, and the other stays a copy in each file, with
  // whatever uses it: a helper cannot use a file's own declaration.
  const kept = new Set<Statement>();
  const declarationOf = (statement: Statement, name: string) =>
    files.get(statement.source)?.statements.find((other) => other.kind === 'declaration' && other.declared.includes(name) && !other.declared.every((own) => statement.declared.includes(own)));
  let shared: Statement[] = [];
  for (let isSettled = false; !isSettled; ) {
    isSettled = true;
    shared = [...copies].filter(([statement, count]) => count > 1 && !kept.has(statement)).map(([statement]) => statement);
    for (let index = 0; index < shared.length && isSettled; index++) {
      for (const name of shared[index].uses) {
        const used = declarationOf(shared[index], name);
        if (used && kept.has(used)) {
          kept.add(shared[index]);
          isSettled = false;
          break;
        }
        if (used && !isHoisted(used) && !shared.includes(used)) shared.push(used);
      }
    }
    if (!isSettled) continue;
    const names = new Map<string, Statement>(helperStatements.flatMap((statement) => statement.declared.map((name): [string, Statement] => [name, statement])));
    for (const statement of [...shared].sort(byPlace)) {
      const clash = statement.declared.some((name) => names.has(name) && names.get(name)?.code !== statement.code);
      if (clash) {
        kept.add(statement);
        isSettled = false;
        break;
      }
      for (const name of statement.declared) names.set(name, statement);
    }
  }
  for (const statement of [...kept].sort(byPlace)) {
    if ((copies.get(statement) ?? 0) > 1) report.push(`  note: ${statement.declared.join(', ')} (test/${statement.source}.test.ts:${statement.line}) is used by ${copies.get(statement)} files but stays a copy in each: its name clashes in test/${HELPERS}, or it uses one that does`);
  }
  const stateful = shared.filter((statement) => holdsState(statement, new Set(files.get(statement.source)?.imports.map((name) => name.local))));
  if (stateful.length) throw new SplitError(`declarations used by two or more files hold module-level state, so they cannot move to test/${HELPERS}: ${stateful.map((statement) => `${statement.declared.join(', ')} (test/${statement.source}.test.ts:${statement.line})`).join('; ')}. Give each file its own, or make it a function.`);
  const uniqueShared = shared.filter((statement, index) => shared.findIndex((other) => keyOf(other) === keyOf(statement)) === index).sort(byPlace);
  for (const statement of uniqueShared) {
    helperStatements.push(statement);
    helperKeys.add(keyOf(statement));
  }
  if (uniqueShared.length) targets = resolveAll();
  const typeNames = new Set(helperStatements.filter((statement) => ['type', 'interface'].includes(statement.code.split(/\s/)[0])).flatMap((statement) => statement.declared));
  const helpers: Target = { path: HELPERS, depth: 0, tests: [], declarations: helperStatements, imports: new Map(), helpers: new Set(), text: '' };
  resolveNames(helpers, helperStatements, files, () => false, HELPERS);
  if (helpers.declarations.length !== helperStatements.length) throw new SplitError(`a helper uses a declaration that is not a helper: ${helpers.declarations.filter((statement) => !helperStatements.includes(statement)).map((statement) => statement.declared.join(', ')).join('; ')}`);

  // Write each file's text.
  const pathNotes: string[] = [];
  const copyNotes: string[] = [];
  const shift = (statement: Statement, target: Target) => {
    const result = shiftPaths(statement.carried + statement.text, target.depth);
    if (result.shifted) pathNotes.push(`  test/${target.path}: ${result.shifted} path(s) one folder deeper, from test/${statement.source}.test.ts:${statement.line}`);
    return result.text;
  };
  for (const target of targets) {
    const found = moduleFor(target.path);
    const prefixes = [...new Set(target.tests.map((test) => test.prefix))];
    const header = found ? `// Tests for ${found.module}${found.isPart ? `: ${prefixes.join(', ')}` : ''}.` : `// Tests: ${prefixes.join(', ')}.`;
    if (!found) report.push(`  note: test/${target.path} has no src module of its own`);
    const imports = [...target.imports.values(), ...[...target.helpers].map((local): ImportName => ({ local, imported: local, module: HELPERS, isType: typeNames.has(local), isDefault: false }))];
    const parts = [header, formatImports(imports, target.depth)];
    for (const statement of target.declarations) {
      parts.push(shift(statement, target));
      const lines = statement.code.split('\n').length;
      if (lines > 5) copyNotes.push(`  test/${target.path}: ${statement.declared.join(', ')} (${lines} lines, from test/${statement.source}.test.ts:${statement.line})`);
    }
    for (const test of target.tests) parts.push(shift(test, target));
    target.text = `${parts.join('\n\n')}\n`;
  }
  helpers.text = `${[
    `// Shared by the test files: the CLI's path, the repo root, a throwaway git repo to run it in,\n// and every declaration that two or more test files use. No state: each file imports it.`,
    formatImports([...helpers.imports.values()], 0),
    ...helperStatements.map((statement) => `${HOIST.includes(statement.declared[0]) && statement.source === HOIST_SOURCE ? '' : statement.leading}export ${statement.code}`),
  ].join('\n\n')}\n`;

  // Self-check: the same tests, by name and by text, and the same count.
  const before = allTests.map((test) => test.name).sort();
  const after: string[] = [];
  const expected = allTests.map((test) => test.carried + test.text).sort();
  const found: string[] = [];
  for (const target of targets) {
    const parsed = parseFile(target.path, target.text, `test/${target.path}`, false);
    for (const statement of parsed.statements.filter((item) => item.kind === 'test')) {
      after.push(statement.name);
      found.push(shiftPaths(statement.text, -target.depth).text);
    }
  }
  after.sort();
  found.sort();
  if (before.length !== after.length || before.some((name, index) => name !== after[index])) throw new SplitError(`self-check: the test names differ (${before.length} before, ${after.length} after)`);
  if (expected.some((text, index) => text !== found[index])) throw new SplitError('self-check: a test body changed in the move');

  // Every folder within the cap.
  const outputs = [...STAYS, HELPERS, ...targets.map((target) => target.path)].sort();
  const children = new Map<string, Set<string>>();
  for (const path of outputs) {
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const folder = parts.slice(0, index).join('/');
      children.set(folder, (children.get(folder) ?? new Set()).add(parts[index]));
    }
  }
  for (const [folder, names] of children) if (names.size > MAX_ENTRIES) throw new SplitError(`test/${folder} would hold ${names.size} entries, over ${MAX_ENTRIES}: ${[...names].join(', ')}`);

  // Things to look at: path strings and `import.meta` left as they were.
  const leftNotes: string[] = [];
  for (const target of targets) {
    if (target.depth === 0) continue;
    for (const statement of [...target.declarations, ...target.tests]) {
      const tokens = locate(statement.text, tokenize(statement.text));
      const metaLines = new Set(tokens.filter((token, index) => token.text === 'import' && tokens[index + 1]?.text === '.' && tokens[index + 2]?.text === 'meta').map((token) => token.line));
      for (const token of tokens) {
        const line = statement.line + token.line - tokens[0].line;
        const isPath = token.kind === 'string' && /^['"`]?\.\.(?:\/|['"`]|$)/.test(token.text);
        if (isPath && !metaLines.has(token.line)) leftNotes.push(`  test/${statement.source}.test.ts:${line}: ${token.text} left as it is (no import.meta on its line)`);
        if (token.text === 'import' && tokens[tokens.indexOf(token) + 2]?.text === 'meta' && !tokens.some((other) => other.line === token.line && other.kind === 'string' && /^['"]\.\./.test(other.text))) {
          leftNotes.push(`  test/${statement.source}.test.ts:${line}: import.meta with no path string on its line; check it by hand`);
        }
      }
    }
  }

  const stale = [...targetOf.keys()].filter((key) => !usedKeys.has(key));
  const tree = [...children.keys()].sort().map((folder) => `  test/${folder ? `${folder}/` : ''}  ${[...(children.get(folder) ?? [])].sort().join(', ')}`);
  const lines = [
    `Split ${allTests.length} tests from ${sourceNames.length} files into ${targets.length} files (+ test/${HELPERS}); ${STAYS.join(', ')} stays.`,
    '',
    'Files:',
    ...targets.map((target) => `  test/${target.path}: ${target.tests.length} tests, from ${[...new Set(target.tests.map((test) => test.source))].map((source) => `${source}.test.ts`).join(' + ')}`),
    `  test/${HELPERS}: ${HOIST.join(', ')} (from ${HOIST_SOURCE}.test.ts)`,
    ...uniqueShared.map((statement) => `  test/${HELPERS}: ${statement.declared.join(', ')} (${statement.code.split('\n').length} lines, from test/${statement.source}.test.ts:${statement.line}), used by ${copies.get(statement) ?? 0} files`),
    '',
    'Tree:',
    ...tree,
    '',
    'Paths shifted:',
    ...(pathNotes.length ? pathNotes : ['  none']),
    '',
    'To check by hand:',
    ...(leftNotes.length ? leftNotes : ['  none']),
    ...report,
    '',
    'Declarations over 5 lines copied into a file:',
    ...(copyNotes.length ? copyNotes : ['  none']),
    '',
    `Mapping rows with no test today: ${stale.length ? stale.join(', ') : 'none'}`,
    `Old files ${isDryRun ? 'to delete' : outDir ? 'left in test/' : 'deleted'}: ${sourceNames.map((name) => `test/${name}`).join(', ')}`,
  ];
  console.log(lines.join('\n'));
  if (isDryRun) return;

  const base = outDir ?? TEST_DIR;
  if (outDir) {
    if (existsSync(outDir) && readdirSync(outDir).length) throw new SplitError(`${outDir} is not empty`);
    for (const name of STAYS) {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(join(TEST_DIR, name), join(outDir, name));
    }
  }
  for (const target of [helpers, ...targets]) {
    mkdirSync(dirname(join(base, target.path)), { recursive: true });
    writeFileSync(join(base, target.path), target.text);
  }
  if (!outDir) for (const name of sourceNames) rmSync(join(TEST_DIR, name));
  console.log(`\nWrote ${targets.length + 1} files into ${outDir ?? 'test/'}.`);
}

// Module-level state, which a helper may not hold: a `let` or `var` (an importing file
// cannot assign it), or a value made at load time with `new` or a call to an imported
// function (a key pair, a temp folder, a server). Functions and plain values are fine.
function holdsState(statement: Statement, imported: Set<string>): boolean {
  const tokens = locate(statement.code, tokenize(statement.code));
  const keyword = tokens[0].text;
  if (keyword === 'let' || keyword === 'var') return true;
  if (keyword !== 'const') return false;
  const value = tokens.slice(tokens.findIndex((token) => token.text === '=') + 1);
  // A function runs nothing at load time: `function`, `async`, `x =>`, `(...) =>`.
  if (['function', 'async'].includes(value[0]?.text) || value[1]?.text === '=>') return false;
  if (value[0]?.text === '(') {
    let depth = 0;
    const close = value.findIndex((token) => (depth += token.text === '(' ? 1 : token.text === ')' ? -1 : 0) === 0);
    if (['=>', ':'].includes(value[close + 1]?.text)) return false;
  }
  return value.some((token, index) => token.text === 'new' || (imported.has(token.text) && value[index + 1]?.text === '(' && value[index - 1]?.text !== '.'));
}

// Fills a target's declarations, imports and helpers from the names `statements` use, in
// the context of each statement's own file: its declaration first, then a helper with the
// same code, then its imports. A name used but found in none is a global or a local.
function resolveNames(target: Target, statements: Statement[], files: Map<string, SourceFile>, isHoisted: (statement: Statement) => boolean, label: string) {
  const queue: [string, string][] = statements.flatMap((statement) => [...statement.uses].filter((name) => !statement.declared.includes(name)).map((name): [string, string] => [statement.source, name]));
  const seen = new Set<string>();
  const copied = new Set<Statement>(target.declarations);
  while (queue.length) {
    const [source, name] = queue.pop() as [string, string];
    if (seen.has(`${source}:${name}`)) continue;
    seen.add(`${source}:${name}`);
    const file = files.get(source);
    const declaration = file?.statements.find((statement) => statement.kind === 'declaration' && statement.declared.includes(name));
    if (declaration && isHoisted(declaration)) target.helpers.add(name);
    else if (declaration) {
      if (copied.has(declaration)) continue;
      copied.add(declaration);
      for (const use of declaration.uses) if (!declaration.declared.includes(use)) queue.push([source, use]);
    } else {
      const spec = file?.imports.find((item) => item.local === name);
      if (!spec) continue;
      const old = target.imports.get(name);
      if (old && (old.module !== spec.module || old.imported !== spec.imported)) throw new SplitError(`test/${label}: ${name} comes from ${old.module} and from ${spec.module}`);
      target.imports.set(name, { ...spec, isType: spec.isType && (old?.isType ?? true) });
    }
  }
  target.declarations = [...copied];
  // One name, one meaning in a file.
  const meaning = new Map<string, string>();
  for (const statement of target.declarations) {
    for (const name of statement.declared) {
      const old = meaning.get(name);
      if (old !== undefined && old !== statement.code) throw new SplitError(`test/${label}: two different declarations of ${name} (one from test/${statement.source}.test.ts:${statement.line})`);
      if (target.helpers.has(name) || target.imports.has(name)) throw new SplitError(`test/${label}: ${name} is declared here and also imported`);
      meaning.set(name, statement.code);
    }
  }
  const twice = [...target.helpers].filter((name) => target.imports.has(name));
  if (twice.length) throw new SplitError(`test/${label}: ${twice.join(', ')} imported from two places`);
  // Two files' copies with the same code count once.
  const byCode = new Map<string, Statement>();
  for (const statement of target.declarations) if (!byCode.has(statement.code)) byCode.set(statement.code, statement);
  target.declarations = [...byCode.values()];
}

try {
  main();
} catch (error) {
  if (!(error instanceof SplitError)) throw error;
  console.error(`split-tests: ${error.message}`);
  process.exitCode = 1;
}
