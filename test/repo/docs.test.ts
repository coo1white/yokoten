// The manifesto count follows the guide's agent table (#487). The guide is only read.
// The open standard names every field the code already has (#755). A new field fails here
// until docs/standard.md and the zh-CN copy both name it. The event log is specified
// before the code writes it, so those words are listed here by hand.
import './home.ts';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { longSentences } from '../../src/rules/pr.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type ManifestoPage = {
  file: string;
  has: string[];
  lacks: string;
};

const PAGES: ManifestoPage[] = [
  {
    file: 'docs/assets/manifesto.md',
    has: ['eight agents', 'not verified end to end'],
    lacks: 'seven agents',
  },
  {
    file: 'docs/i18n/zh-CN/manifesto.md',
    has: ['八个', '还没有完整跑过'],
    lacks: '七个 agent',
  },
  {
    file: 'docs/i18n/zh-TW/manifesto.md',
    has: ['八個', '還沒有完整跑過'],
    lacks: '七個 agent',
  },
  {
    file: 'docs/i18n/ja/manifesto.md',
    has: ['八つ', '端から端まではまだ確認していません'],
    lacks: '7つの',
  },
];

/**
 * Agent names in the first table under `## Works with`. The header, the separator and
 * the catch-all row are skipped. The next table in that section is not this list.
 */
function listGuardedAgents(guide: string): string[] {
  const lines = guide.split('\n');
  const heading = lines.indexOf('## Works with');
  if (heading < 0) return [];
  const tableStart = lines.findIndex((line, index) => index > heading && line.startsWith('|'));
  if (tableStart < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(tableStart)) {
    if (!line.startsWith('|')) break;
    const name = line.split('|')[1]?.trim() ?? '';
    if (name === 'Agent' || name === 'Any other agent' || /^-+$/.test(name)) continue;
    names.push(name);
  }
  return names;
}

/** The failure text when `names` is not eight rows. Empty when the count is eight. */
function agentCountReport(names: string[]): string {
  if (names.length === 8) return '';
  return `the Works with table lists ${names.length} agents, not 8: ${names.join(', ')}`;
}

/** Phrases `text` must show, and one phrase it must not. Empty when the page agrees. */
function phraseProblems(text: string, has: readonly string[], lacks: string): string[] {
  const problems: string[] = [];
  for (const phrase of has) {
    if (!text.includes(phrase)) problems.push(`missing: ${phrase}`);
  }
  if (text.includes(lacks)) problems.push(`still says: ${lacks}`);
  return problems;
}

test('docs: manifestos match the guide list of eight agents (#487)', () => {
  const shortGuide = [
    '## Other',
    '| Agent | Note |',
    '|---|---|',
    '| Not this | no |',
    '',
    '## Works with',
    '',
    'Some prose.',
    '',
    '| Agent | Verified |',
    '|---|---|',
    '| Claude Code | yes |',
    '| Codex CLI | yes |',
    '| Any other agent | |',
    '',
    '| Agent | Trust store |',
    '|---|---|',
    '| Copilot CLI | file |',
  ].join('\n');
  const shortNames = listGuardedAgents(shortGuide);
  assert.deepEqual(shortNames, ['Claude Code', 'Codex CLI']);
  assert.equal(agentCountReport(shortNames), 'the Works with table lists 2 agents, not 8: Claude Code, Codex CLI');
  assert.equal(agentCountReport(['Claude Code', 'Copilot', 'Antigravity', 'Codex', 'Muse', 'DeepSeek', 'Grok', 'Gemini']), '');
  assert.deepEqual(phraseProblems('The same rules run in seven agents today.', ['eight agents', 'not verified end to end'], 'seven agents'), [
    'missing: eight agents',
    'missing: not verified end to end',
    'still says: seven agents',
  ]);

  const names = listGuardedAgents(readFileSync(join(ROOT, 'docs/guide.md'), 'utf8'));
  const report = agentCountReport(names);
  // A wrong count stops here. The message names the rows. The guide stays as it is.
  if (report !== '') assert.fail(report);

  for (const page of PAGES) {
    const text = readFileSync(join(ROOT, page.file), 'utf8');
    assert.deepEqual(phraseProblems(text, page.has, page.lacks), [], page.file);
  }
});

const ENGLISH = 'docs/standard.md';
const CHINESE = 'docs/i18n/zh-CN/standard.md';

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Quoted texts in `slice`, escapes kept as written. Comments are not strings. */
function quotedStrings(slice: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < slice.length; index++) {
    const char = slice[index];
    if (char === '/' && slice[index + 1] === '/') {
      index = slice.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (char === '/' && slice[index + 1] === '*') {
      index = slice.indexOf('*/', index + 2);
      if (index < 0) break;
      index += 1;
      continue;
    }
    if (char !== "'" && char !== '"') continue;
    let text = '';
    for (index += 1; index < slice.length; index++) {
      const next = slice[index];
      if (next === '\\') {
        text += next + (slice[index + 1] ?? '');
        index += 1;
        continue;
      }
      if (next === char) break;
      text += next;
    }
    if (text !== '' && !/^\d+$/.test(text)) found.push(text);
  }
  return found;
}

/** Index just after the `=` of `const name`, skipping a type that holds `=>`. */
function assignmentAt(source: string, name: string): number {
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\b`).exec(source);
  if (!match) return -1;
  let depth = 0;
  for (let i = match.index + match[0].length; i < source.length; i++) {
    const char = source[i];
    if (char === '<' || char === '(') depth += 1;
    else if (char === '>' || char === ')') depth = Math.max(0, depth - 1);
    else if (char === '=' && depth === 0 && source[i + 1] !== '>' && source[i - 1] !== '=') return i + 1;
  }
  return -1;
}

/** The initializer of `const name`, from `=` to the `;` at depth 0. */
function assignmentSlice(source: string, name: string): string {
  const start = assignmentAt(source, name);
  if (start < 0) throw new Error(`no const ${name}`);
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ';' && depth === 0) return source.slice(start, index);
  }
  throw new Error(`no end for const ${name}`);
}

/** The brace body of `interface name` or `function name`. */
function braceBody(source: string, kind: 'interface' | 'function', name: string): string {
  const match = new RegExp(`(?:export\\s+)?${kind}\\s+${name}\\b`).exec(source);
  if (!match) throw new Error(`no ${kind} ${name}`);
  const open = source.indexOf('{', match.index + match[0].length);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`no end for ${kind} ${name}`);
}

/** Comments removed, so a field line is only the field. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Field names of an interface, and the quoted words on those lines. */
function interfaceWords(source: string, name: string): string[] {
  const words: string[] = [];
  for (const line of stripComments(braceBody(source, 'interface', name)).split('\n')) {
    const match = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??:\s*([^;]*)/.exec(line);
    if (!match) continue;
    words.push(match[1], ...quotedStrings(match[2]));
  }
  return words;
}

/** The quoted words of `export type Name = ...`. */
function typeWords(source: string, name: string): string[] {
  const match = new RegExp(`export type ${name}\\s*=\\s*([^;]+);`).exec(source);
  if (!match) throw new Error(`no type ${name}`);
  return quotedStrings(match[1]);
}

/** Keys of a flat object initializer. */
function objectKeys(slice: string): string[] {
  const keys: string[] = [];
  for (const line of slice.split('\n')) {
    const match = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))\s*:/.exec(line);
    if (match) keys.push(match[1] ?? match[2] ?? match[3]);
  }
  return keys;
}

/** Tool names and payload fields from one runtime adapter. */
function runtimeWords(source: string): string[] {
  const words: string[] = [];
  for (const name of ['SHELL', 'EDITS', 'EDIT_TOOLS', 'READ_ONLY', 'MATCHER']) {
    if (assignmentAt(source, name) < 0) continue;
    for (const text of quotedStrings(assignmentSlice(source, name))) {
      words.push(...(text.includes('|') ? text.split('|') : [text]));
    }
  }
  for (const match of source.matchAll(/'([A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)+)'/g)) words.push(...match[1].split('|'));
  // `name === 'tool'`, not `toolCall.name === 'string'`.
  for (const match of source.matchAll(/(?<![.\w])name === '([^']+)'/g)) words.push(match[1]);
  if (!/export function readToolCall\b/.test(source)) return words;
  const body = braceBody(source, 'function', 'readToolCall');
  for (const object of ['tool', 'args', 'call', 'toolCall']) {
    for (const match of body.matchAll(new RegExp(`\\b${object}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) words.push(match[1]);
  }
  return words;
}

/** A number written `N * 1024` or `N * 60 * 1000`, as the spec should say it. */
function scaled(source: string, name: string, factor: 'kib' | 'minutes'): string {
  const pattern = factor === 'kib' ? `${name} = (\\d+) \\* 1024` : `${name} = (\\d+) \\* 60 \\* 1000`;
  const match = new RegExp(pattern).exec(source);
  if (!match) throw new Error(`no ${name}`);
  return factor === 'kib' ? `${match[1]} KiB` : `${match[1]} minutes`;
}

/** Every word the open standard has to name, taken from the code. */
function collectWords(): string[] {
  const hook = read('src/run/hook.ts');
  const feed = read('src/commands/advice/board/feed/steps.ts');
  const agents = read('src/commands/advice/board/agents.ts');
  // The attention box and its link live in two files since the board split (#693).
  const controls = read('src/commands/advice/board/controls.ts') + read('src/commands/advice/board/waiting.ts');
  const view = read('src/commands/advice/board/view.ts');
  const script = read('src/commands/advice/board/page/browser/script.ts');
  const pr = read('src/rules/pr.ts');
  const desk = read('src/agents/desk/desk.ts');
  const env = read('src/agents/desk/agent-env.ts');
  const proxy = read('src/agents/desk/network/proxy.ts');
  const command = read('src/commands/guard/hook.ts');
  const words: string[] = [];

  words.push(...interfaceWords(hook, 'Action'));
  words.push(...typeWords(hook, 'StatusRefusal'));
  words.push(...quotedStrings(assignmentSlice(hook, 'AGENT_STATUS_FILE')));
  const statusCap = /STATUS_TEXT_LIMIT = (\d+) \* 1024/.exec(hook);
  if (!statusCap) throw new Error('status cap changed');
  words.push(`${statusCap[1]} KiB`, String(Number(statusCap[1]) * 1024));
  const refusal = /is not a regular file, so it was left unchanged/.exec(hook);
  if (!refusal) throw new Error('status warning text changed');
  words.push(refusal[0]);

  words.push(...interfaceWords(feed, 'FeedEvent'));
  const feedLimit = /export const FEED_LIMIT = (\d+)/.exec(feed);
  if (!feedLimit) throw new Error('feed limit changed');
  words.push(feedLimit[1]);
  for (const match of feed.matchAll(/text:\s*'([^']+)'/g)) words.push(match[1]);
  const fold = /run\.length >= (\d+)/.exec(script);
  if (!fold) throw new Error('feed fold rule changed');
  words.push(fold[1]);

  words.push(...interfaceWords(agents, 'BoardAgent'));
  words.push(...typeWords(agents, 'BoardRole'));
  for (const match of agents.matchAll(/fieldText\(\s*fields\s*,\s*([\s\S]*?)\)/g)) words.push(...quotedStrings(match[1]));
  words.push(...interfaceWords(controls, 'BoardAttention'));
  for (const match of controls.matchAll(/fieldText\(\s*fields\s*,\s*([\s\S]*?)\)/g)) words.push(...quotedStrings(match[1]));
  words.push(...quotedStrings(braceBody(controls, 'function', 'boardLink')));
  const attention = controls.indexOf("kind === 'guard' ? 'blocked' : 'question'");
  const limit = /slice\(0, (\d+)\)/.exec(controls.slice(attention, attention + 220));
  if (!limit) throw new Error('attention length changed');
  words.push(limit[1]);
  words.push(...typeWords(view, 'AgentDot'));
  words.push(scaled(view, 'LIVE_WINDOW_MS', 'minutes'));

  words.push(...interfaceWords(pr, 'MadeWithAgent'), ...interfaceWords(pr, 'MadeWithRoles'));
  const role = /const role = \/\^\(([^)]+)\)/.exec(pr);
  if (!role) throw new Error('Made-with role words changed');
  words.push(...role[1].split('|'));
  const reviewed = /const REVIEWED_BY = \/\^([a-z ]+)/.exec(pr);
  if (!reviewed) throw new Error('reviewed-by words changed');
  words.push(reviewed[1].trim());
  words.push(...findingIds(braceBody(pr, 'function', 'madeWithFindings')));
  words.push(...findingIds(braceBody(pr, 'function', 'checkOwnedTier')));
  words.push(...findingIds(braceBody(pr, 'function', 'checkApprovalFreshness')));
  words.push(...findingIds(braceBody(pr, 'function', 'checkTierLabel')));
  const tierAt = pr.indexOf('const tier = bodyTier');
  words.push(...findingIds(pr.slice(tierAt, pr.indexOf('for (const name of SECTIONS)', tierAt))));
  const letters = /\^tier: \(\[([A-Z]+)\]\)/.exec(pr);
  if (!letters) throw new Error('tier line pattern changed');
  for (const letter of letters[1]) words.push(`tier: ${letter}`);

  words.push(...interfaceWords(desk, 'DeskPlan'));
  words.push(...objectKeys(assignmentSlice(desk, 'DESK_RUNTIMES')));
  words.push(...quotedStrings(assignmentSlice(desk, 'OWN_RUNTIME')));
  const deskFile = read('src/agents/desk/team/team.ts');
  words.push(...quotedStrings(assignmentSlice(deskFile, 'DESK_FILE')));
  for (const match of desk.matchAll(/\[\s*'([^']+)'\s*,\s*'(?:file|folder)'\s*\]/g)) words.push(match[1]);
  words.push(...quotedStrings(braceBody(desk, 'function', 'hiddenFolders')));
  const wanted = /const wanted = \[([\s\S]*?)\];/.exec(desk);
  if (!wanted) throw new Error('desk readable list changed');
  words.push(...quotedStrings(wanted[1]));
  const roleSet = /YOKOTEN_ROLE: '([^']+)'[\s\S]{0,120}?TZ: '([^']+)'/.exec(desk);
  if (!roleSet) throw new Error('desk role env changed');
  words.push('YOKOTEN_ROLE', roleSet[1], 'TZ', roleSet[2]);
  for (const match of desk.matchAll(/\b(YOKOTEN_[A-Z0-9_]+)\b/g)) words.push(match[1]);

  words.push(...objectKeys(assignmentSlice(command, 'READERS')));
  for (const file of readdirSync(join(ROOT, 'src/agents/runtimes'))) {
    if (!file.endsWith('.ts')) continue;
    const source = read(`src/agents/runtimes/${file}`);
    words.push(...runtimeWords(source));
    if (!/export const DESK\b/.test(source)) continue;
    const plan = assignmentSlice(source, 'DESK');
    words.push(...quotedStrings(plan));
    const state = /stateEnv:\s*\([^)]*\)\s*=>\s*\(\{([^}]*)\}/.exec(plan);
    if (!state) throw new Error(`no stateEnv in ${file}`);
    for (const key of state[1].matchAll(/\b([A-Z][A-Z0-9_]*)\s*:/g)) words.push(key[1]);
    const login = /login:\s*\[([^\]]*)\]/.exec(assignmentSlice(source, 'AGENT_ENV'));
    if (!login) throw new Error(`no login names in ${file}`);
    words.push(...quotedStrings(login[1]));
  }

  const secret = /SECRET_NAME = \/([^/]+)\//.exec(env);
  if (!secret) throw new Error('secret name pattern changed');
  words.push(...secret[1].split('|'));
  words.push(scaled(env, 'MAX_VALUE_LENGTH', 'kib'));
  const proxyEnv = braceBody(desk, 'function', 'proxyEnv');
  words.push(...quotedStrings(proxyEnv));
  for (const match of proxyEnv.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) words.push(match[1]);
  words.push(scaled(proxy, 'IDLE_TIMEOUT_MS', 'minutes'));
  const tunnels = /export const MAX_TUNNELS = (\d+)/.exec(proxy);
  const port = /const ALLOWED_PORT = (\d+)/.exec(proxy);
  if (!tunnels || !port) throw new Error('proxy limits changed');
  words.push(tunnels[1], port[1]);

  return [...new Set(words)].filter((word) => word !== '').sort();
}

/** Finding ids passed to `finding` in `body`. */
function findingIds(body: string): string[] {
  return [...body.matchAll(/finding\(\s*'([^']+)'/g)].map((match) => match[1]);
}

/** Code and test paths the spec has to link. */
function holderPaths(): string[] {
  const paths = [
    'src/commands/advice/board/feed/steps.ts',
    'test/commands/advice/board/feed/steps.test.ts',
    'src/commands/advice/board/page/browser/script.ts',
    'test/commands/advice/board/page/browser/script.test.ts',
    'src/run/hook.ts',
    'test/run/hook.test.ts',
    'src/commands/guard/hook.ts',
    'test/commands/guard/hook.test.ts',
    'src/commands/advice/board/agents.ts',
    'test/commands/advice/board/agents.test.ts',
    'src/commands/advice/board/controls.ts',
    'test/commands/advice/board/controls.test.ts',
    'src/commands/advice/board/view.ts',
    'test/commands/advice/board/view.test.ts',
    'src/rules/pr.ts',
    'test/rules/pr.test.ts',
    'src/commands/bot.ts',
    'test/commands/bot.test.ts',
    'src/agents/desk/desk.ts',
    'test/agents/desk/desk.test.ts',
    'src/agents/desk/agent-env.ts',
    'test/agents/desk/agent-env.test.ts',
    'src/agents/desk/network/proxy.ts',
    'test/agents/desk/network/proxy.test.ts',
  ];
  for (const file of readdirSync(join(ROOT, 'src/agents/runtimes'))) {
    if (!file.endsWith('.ts')) continue;
    paths.push(`src/agents/runtimes/${file}`);
    const testPath = `test/agents/runtimes/${file.replace(/\.ts$/, '.test.ts')}`;
    if (existsSync(join(ROOT, testPath))) paths.push(testPath);
  }
  return paths;
}

/** Pages whose inline links this file resolves. The manifesto moved and kept old relative links. */
const LINK_PAGES = [ENGLISH, CHINESE, 'docs/assets/manifesto.md'];

/**
 * Inline links whose file is missing. `from` is the Markdown file.
 * An external link, or a link that is only an anchor, is skipped.
 */
function missingLinkTargets(page: string, from: string): string[] {
  const missing: string[] = [];
  for (const match of page.matchAll(/(?<!!)\[(?:[^\]]*)\]\(([^)\s]+)\)/g)) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
    const file = raw.split('#')[0];
    if (file === '' || existsSync(resolve(dirname(from), file))) continue;
    missing.push(raw);
  }
  return missing;
}

/** Paths a desk refuses when they are links. The desk root is resolved, not refused. */
const DESK_LINK_PATHS = ['.git', '.git/config', '.git/hooks', '.git/yokoten-worker', 'state folder'];

/** Paths in `paths` that a symlink-refusal line does not name. Other lines name none of them. */
function unnamedLinkPaths(line: string, paths: string[]): string[] {
  if (!/symlink|符号链接/.test(line) || !/refus|拒绝/.test(line)) return [...paths];
  return paths.filter((path) => !line.includes(path));
}

/** The one symlink line in the section that starts with `heading`. */
function symlinkLine(page: string, heading: string): string {
  const section = shapeSections(page).find((part) => part.startsWith(heading));
  if (!section) throw new Error(`no ${heading} section`);
  const lines = section.split('\n').filter((line) => /symlink|符号链接/.test(line));
  if (lines.length !== 1) throw new Error(`${heading} has ${lines.length} symlink lines`);
  return lines[0];
}

/** The words in `words` that `page` does not name in backticks. */
function findMissingWords(page: string, words: string[]): string[] {
  const spans = [...page.matchAll(/`([^`]*)`/g)].map((match) => match[1]);
  return words.filter((word) => !spans.some((span) => span === word || span.split(/[/:]/).includes(word)));
}

/** Sections under `##`, each including its heading line. */
function shapeSections(page: string): string[] {
  return page.split(/^## /m).slice(1);
}

/** Separator rows of Markdown tables. */
function tableCount(section: string): number {
  return section.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('|') && trimmed.includes('-') && /^\|[\s|:-]+\|$/.test(trimmed);
  }).length;
}

const WORDS = collectWords();

/** Field names of the event log. The code does not write this log yet (#755, record 0029). */
const LOG_FIELDS = [
  'Timestamp',
  'ObservedTimestamp',
  'EventName',
  'Body',
  'timeUnixNano',
  'observedTimeUnixNano',
  'eventName',
  'body',
  'attributes',
  'ExportLogsServiceRequest',
  'resourceLogs',
  'scopeLogs',
  'logRecords',
  'service.name',
  'stringValue',
  'doubleValue',
  'gen_ai.agent.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.system',
  'gen_ai.operation.name',
  'gen_ai.tool.name',
  'execute_tool',
  'yokoten.role',
  'yokoten.issue',
  'yokoten.worktree',
  'yokoten.event.previous_hash',
  'yokoten.heartbeat.interval',
  'yokoten.outcome',
  'yokoten.agent.start',
  'yokoten.agent.heartbeat',
  'yokoten.agent.tool_call',
  'yokoten.agent.refusal',
  'yokoten.agent.report',
  'yokoten.agent.stop',
  'yokoten.agent.saved',
  'yokoten.agent.merged',
  '.git/yokoten/events.jsonl',
  '.git/yokoten/events.lock',
];

/** The two states the status view keeps apart, and the fields inside them. */
const VIEW_FIELDS = ['alive', 'stale', 'gone', 'outcome', 'done', 'failed', 'timed_out', 'refused', 'stopped', 'interval', 'beat', 'phase', 'value', 'reason'];

test('standard: a field missing from the page is caught', () => {
  assert.deepEqual(findMissingWords('`model` is named', ['vendor', 'model']), ['vendor']);
});

test('standard: the code fields are in the spec and the zh-CN copy', () => {
  assert.ok(WORDS.includes('vendor') && WORDS.includes('command') && WORDS.length > 40, 'the field scan found too little; it is broken');
  const english = read(ENGLISH);
  const chinese = read(CHINESE);
  assert.deepEqual(findMissingWords(english, WORDS), []);
  assert.deepEqual(findMissingWords(chinese, WORDS), []);
  const missingPaths = holderPaths().filter((path) => !english.includes(path) || !chinese.includes(path));
  assert.deepEqual(missingPaths, []);
});

test('standard: each shape says who writes, who reads, how it is checked, and its version', () => {
  const english = shapeSections(read(ENGLISH));
  const chinesePage = read(CHINESE);
  const chinese = shapeSections(chinesePage);
  assert.equal(english.length, 8);
  assert.equal(chinese.length, 8);
  for (const section of english) {
    for (const line of ['Who writes', 'Who reads', 'How yokoten checks it', 'Version 1']) {
      assert.ok(section.includes(line), `missing ${line} in: ${section.split('\n')[0]}`);
    }
    assert.equal(tableCount(section), 1, `one table in: ${section.split('\n')[0]}`);
    assert.match(section, /src\//);
    assert.match(section, /test\//);
  }
  for (const section of chinese) {
    for (const line of ['谁来写', '谁来读', '怎么检查', '版本 1']) {
      assert.ok(section.includes(line), `missing ${line} in: ${section.split('\n')[0]}`);
    }
    assert.equal(tableCount(section), 1, `one table in: ${section.split('\n')[0]}`);
  }
  assert.equal(chinesePage.split('\n')[0], '<!-- source: docs/standard.md -->');
});

test('standard: a missing event-log field is caught', () => {
  const section = shapeSections(read(ENGLISH))[0];
  assert.deepEqual(findMissingWords(section, ['eventName', 'not-a-log-field']), ['not-a-log-field']);
});

test('standard: the event log is the first shape and the status file is its view', () => {
  const english = shapeSections(read(ENGLISH));
  const chinese = shapeSections(read(CHINESE));
  assert.equal(english[0].split('\n')[0], 'The event log');
  assert.equal(chinese[0].split('\n')[0], '事件日志');
  assert.equal(english[3].split('\n')[0], 'The status file');
  assert.equal(chinese[3].split('\n')[0], '状态文件');
  assert.deepEqual(findMissingWords(english[0], LOG_FIELDS), []);
  assert.deepEqual(findMissingWords(chinese[0], LOG_FIELDS), []);
  assert.deepEqual(findMissingWords(english[3], VIEW_FIELDS), []);
  assert.deepEqual(findMissingWords(chinese[3], VIEW_FIELDS), []);
  assert.ok(english[0].includes('The code does not append this log yet.'));
  assert.ok(chinese[0].includes('代码还不会写这份日志'));
  assert.ok(english[3].includes('Only the view writes this file.'));
  assert.ok(chinese[3].includes('只有这个视图写这个文件'));
});

test('standard: English sentences stay within 25 words', () => {
  assert.deepEqual(longSentences(read(ENGLISH)), []);
});

test('standard: a link to a missing file is caught', () => {
  const page = 'The [guide](guide.md#works-with) and [the web](https://example.com/a).';
  assert.deepEqual(missingLinkTargets(page, join(ROOT, 'docs/assets/manifesto.md')), ['guide.md#works-with']);
});

test('standard: links in the spec and the manifesto resolve', () => {
  const missing = LINK_PAGES.flatMap((page) => missingLinkTargets(read(page), join(ROOT, page)).map((link) => `${page} -> ${link}`));
  assert.deepEqual(missing, []);
});

test('standard: a wide desk symlink sentence is caught', () => {
  assert.deepEqual(unnamedLinkPaths('A symlink on a desk path is refused.', DESK_LINK_PATHS), [...DESK_LINK_PATHS]);
});

test('standard: the desk symlink line names the paths the code refuses', () => {
  const english = symlinkLine(read(ENGLISH), 'The desk');
  const chinese = symlinkLine(read(CHINESE), '工位');
  assert.deepEqual(unnamedLinkPaths(english, DESK_LINK_PATHS), []);
  assert.deepEqual(unnamedLinkPaths(chinese, [...DESK_LINK_PATHS.slice(0, 4), '状态文件夹']), []);
});
