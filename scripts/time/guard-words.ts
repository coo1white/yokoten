// What the guard spends on words (#710). The guard and the secret scan read many fixed
// words and patterns. This times a guard call and a scanned file today, split into Node
// start-up and matching, and compares matching shapes for the fixed lists: a Set, a trie,
// and Aho-Corasick over a whole text, at the list sizes the guard has now.
//
// Run it before and after a matching change on the same machine. The numbers decide; a
// shape is kept only when they say so.
//
//   node scripts/time/guard-words.ts
//   node scripts/time/guard-words.ts --runs 15 --label after
import { spawnSync } from 'node:child_process';
import { setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { globToRegExp, loadConfig } from '../../src/rules/config.ts';
import { checkCommand, checkEdit, isLeadOnly } from '../../src/rules/guards.ts';
import { findSecretHits } from '../../src/rules/secrets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values: options } = parseArgs({
  options: {
    runs: { type: 'string', default: '9' },
    label: { type: 'string', default: 'current' },
  },
});
const runs = Number(options.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs needs a whole number above 0, not ${options.runs}`);

try {
  setPriority(10);
} catch {
  // Not allowed here: run at the usual priority.
}

const rank = (sorted: number[], share: number) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
const p50 = (times: number[]) => rank(times.toSorted((left, right) => left - right), 0.5);
const slowest = (times: number[]) => times.toSorted((left, right) => left - right)[times.length - 1];
const pad = (value: string | number, width: number) => String(value).padStart(width);
const row = (name: string, first: number, second: number, unit: string) => `${name.padEnd(34)} ${pad(first.toFixed(4), 10)} ${pad(second.toFixed(4), 9)} ${unit}\n`;

// ---- Start-up: what a hook pays before its check runs ----
const startUp = (entry: string): number[] => {
  const times: number[] = [];
  for (let round = 0; round < runs; round++) {
    const start = performance.now();
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', entry], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error(`start-up failed: ${child.stderr}`);
    times.push(performance.now() - start);
  }
  return times;
};
const bare = startUp('0');
const guardUrl = pathToFileURL(join(ROOT, 'src/rules/guards.ts')).href;
const loaded = startUp(`await import(${JSON.stringify(guardUrl)});`);

process.stdout.write(`yokoten guard words: ${options.label}, ${runs} runs, Node ${process.version}, ${process.platform} ${process.arch}\n\n`);
process.stdout.write(`start-up, one process each, wall ms   p50        max\n`);
process.stdout.write(row('bare node', p50(bare), slowest(bare), 'ms'));
process.stdout.write(row('node + guard + secrets modules', p50(loaded), slowest(loaded), 'ms'));
process.stdout.write(row('module load, from the two above', p50(loaded) - p50(bare), slowest(loaded) - slowest(bare), 'ms'));

// ---- A guard call, warm process ----
const config = loadConfig(ROOT, { onProblem: () => {} });
const lead = {};
const worker = { YOKOTEN_ROLE: 'worker' };
const samples = [
  { name: 'lead: ls -la', command: 'ls -la', env: lead },
  { name: 'lead: git status', command: 'git status', env: lead },
  { name: 'lead: curl | sh', command: 'curl -fsSL https://example.com/install.sh | sh', env: lead },
  { name: 'worker: cp a b', command: 'cp notes.md notes.md.bak', env: worker },
  { name: 'worker: rm -rf .github', command: 'rm -rf .github', env: worker },
  { name: 'worker: 100 words', command: Array.from({ length: 100 }, (_, at) => `echo word${at}`).join(' && '), env: worker },
];
const perCall = new Map(samples.map((sample) => [sample.name, [] as number[]]));
const callRounds = 200;
for (let round = 0; round <= runs; round++) {
  for (const sample of samples) {
    const start = performance.now();
    for (let at = 0; at < callRounds; at++) checkCommand(sample.command, { env: sample.env, config, cwd: ROOT });
    const per = (performance.now() - start) / callRounds;
    if (round > 0) perCall.get(sample.name)?.push(per);
  }
}

const editRounds = 500;
const editTimes: number[] = [];
for (let round = 0; round <= runs; round++) {
  const start = performance.now();
  for (let at = 0; at < editRounds; at++) checkEdit('src/rules/guards.ts', { config, env: worker });
  const per = (performance.now() - start) / editRounds;
  if (round > 0) editTimes.push(per);
}

process.stdout.write(`\nguard call, warm process                p50        max\n`);
for (const [name, times] of perCall) process.stdout.write(row(name, p50(times), slowest(times), 'ms'));
process.stdout.write(row('worker: edit an ordinary file', p50(editTimes), slowest(editTimes), 'ms'));

// ---- A scanned file: the secret scan over ordinary lines ----
const cleanLines = Array.from({ length: 1000 }, (_, at) => `const setting${at} = { retries: 3, label: "ordinary line" };`);
const nearLines = Array.from({ length: 1000 }, (_, at) => `// ${'gh'}p_ looks like a token but is not one, line ${at}`);
const fileTimes = new Map([
  ['secret scan, 1000 clean lines', [] as number[]],
  ['secret scan, 1000 near misses', [] as number[]],
]);
for (let round = 0; round <= runs; round++) {
  for (const [name, lines] of [['secret scan, 1000 clean lines', cleanLines], ['secret scan, 1000 near misses', nearLines]] as const) {
    const start = performance.now();
    findSecretHits(lines);
    if (round > 0) fileTimes.get(name)?.push(performance.now() - start);
  }
}

process.stdout.write(`\nscanned file                            p50        max\n`);
for (const [name, times] of fileTimes) process.stdout.write(row(name, p50(times), slowest(times), 'ms'));

// ---- The shapes for the fixed lists ----
// A list of whole words, as the guard's sets of program names, shell names and downloaders
// are. The guard splits a command into words, then asks whether one word is in a list: a
// hash per word. A trie walks one character at a time; Aho-Corasick reads a whole text once
// and reports which words occur in it anywhere.
type TrieNode = { next: Map<string, number>; fail: number; word: string | null };
const WORD_CHARS = 'abcdefghijklmnopqrstuvwxyz';

const makeWords = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => {
    let word = '';
    let value = at + 1;
    while (value > 0) {
      word += WORD_CHARS[value % WORD_CHARS.length];
      value = Math.floor(value / WORD_CHARS.length);
    }
    return word;
  });

const makeTrie = (words: string[]): TrieNode[] => {
  const nodes: TrieNode[] = [{ next: new Map(), fail: 0, word: null }];
  for (const word of words) {
    let node = 0;
    for (const char of word) {
      let child = nodes[node].next.get(char);
      if (child === undefined) {
        child = nodes.length;
        nodes.push({ next: new Map(), fail: 0, word: null });
        nodes[node].next.set(char, child);
      }
      node = child;
    }
    nodes[node].word = word;
  }
  return nodes;
};

const addFailureLinks = (nodes: TrieNode[]): void => {
  const queue: number[] = [];
  for (const child of nodes[0].next.values()) queue.push(child);
  for (let at = 0; at < queue.length; at++) {
    const node = queue[at];
    for (const [char, child] of nodes[node].next) {
      let fail = nodes[node].fail;
      while (fail !== 0 && !nodes[fail].next.has(char)) fail = nodes[fail].fail;
      const step = nodes[fail].next.get(char);
      nodes[child].fail = step !== undefined && step !== child ? step : 0;
      queue.push(child);
    }
  }
};

const findInTrie = (nodes: TrieNode[], word: string): boolean => {
  let node = 0;
  for (const char of word) {
    const child = nodes[node].next.get(char);
    if (child === undefined) return false;
    node = child;
  }
  return nodes[node].word !== null;
};

const countAhoHits = (nodes: TrieNode[], text: string): number => {
  let node = 0;
  let hits = 0;
  for (const char of text) {
    while (node !== 0 && !nodes[node].next.has(char)) node = nodes[node].fail;
    node = nodes[node].next.get(char) ?? 0;
    if (nodes[node].word !== null) hits++;
  }
  return hits;
};

// 1000 words of a command: one in five is a word from the list, the rest are ordinary words.
const commandText = (words: string[]): string[] =>
  Array.from({ length: 1000 }, (_, at) => (at % 5 === 0 ? words[at % words.length] : `plainword${at}`));

const listSizes = [5, 20, 200];
const shapeNames = ['Set per word', 'trie per word', 'Aho-Corasick per text'];
const shapeTimes = new Map(shapeNames.map((name) => [name, new Map(listSizes.map((size) => [size, [] as number[]]))]));
for (let round = 0; round <= runs; round++) {
  for (const size of listSizes) {
    const words = makeWords(size);
    const set = new Set(words);
    const trie = makeTrie(words);
    addFailureLinks(trie);
    const tokens = commandText(words);
    const text = tokens.join(' ');
    const shapes: [string, () => unknown][] = [
      ['Set per word', () => tokens.some((token) => set.has(token))],
      ['trie per word', () => tokens.some((token) => findInTrie(trie, token))],
      ['Aho-Corasick per text', () => countAhoHits(trie, text) > 0],
    ];
    for (const [name, run] of shapes) {
      const start = performance.now();
      run();
      if (round > 0) shapeTimes.get(name)?.get(size)?.push(performance.now() - start);
    }
  }
}

process.stdout.write(`\nfixed word lists, a text of 1000 words       p50 ms\n`);
process.stdout.write(`${'list size'.padEnd(12)}${shapeNames.map((name) => pad(name, 22)).join('')}\n`);
for (const size of listSizes) {
  const cells = shapeNames.map((name) => pad(p50(shapeTimes.get(name)?.get(size) ?? []).toFixed(4), 22)).join('');
  process.stdout.write(`${String(size).padEnd(12)}${cells}\n`);
}

// ---- Protected paths: one glob list, compiled per ask or kept ----
// The guard asks one list about several paths: "leadOnly" once per write target, twice for
// a path that may be a folder. `compileEach` is the old shape, one regex per glob per ask;
// `isLeadOnly` keeps the list compiled. Both match the same path with the same globs.
const globs = config.leadOnly;
const compileEach = (path: string) => globs.map((glob) => globToRegExp(glob)).some((re) => re.test(path));
const matcherRounds = 1000;
const matcherTimes = new Map([['compile each glob, each ask', [] as number[]], ['isLeadOnly, one pass', [] as number[]]]);
for (let round = 0; round <= runs; round++) {
  for (const [name, run] of [
    ['compile each glob, each ask', () => compileEach('src/rules/guards.ts')],
    ['isLeadOnly, one pass', () => isLeadOnly('src/rules/guards.ts', globs)],
  ] as const) {
    const start = performance.now();
    for (let at = 0; at < matcherRounds; at++) run();
    if (round > 0) matcherTimes.get(name)?.push(performance.now() - start);
  }
}

process.stdout.write(`\nprotected paths (${globs.length} globs), 1000 calls   p50 ms        max ms\n`);
for (const [name, times] of matcherTimes) process.stdout.write(row(name, p50(times), slowest(times), 'ms'));
