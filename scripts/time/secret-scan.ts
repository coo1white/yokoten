// How long the secret scan takes on a large clean text, a large near miss, and one token
// near the end of a large text. It prints p50 and max times for the scanner alone, without
// a CI threshold. Run it before and after a scanner change on the same machine.
//
//   node scripts/time/secret-scan.ts
//   node scripts/time/secret-scan.ts --runs 15 --label after
import assert from 'node:assert/strict';
import { setPriority } from 'node:os';
import { parseArgs } from 'node:util';
import { findSecretHits } from '../../src/rules/secrets.ts';

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

const run = (chars: string, count: number) => chars.repeat(Math.ceil(count / chars.length)).slice(0, count);
const alnum = (count: number) => run('a1B2c3D4e5F6g7H8', count);

const cleanLine = 'export const settings = { retries: 3, timeout: 4000, label: "ordinary sample line" };';
const nearMissLine = [
  `const note = "${'gh'}p_${alnum(20)} ${'npm'}_${alnum(30)} ${'AK'}IA${run('Q7W3R9T2Y5', 15)}`,
  `${'xo'}xb-not-a-token ${'sk'}_live_short ${'AI'}za${alnum(20)} ${'LL'}M_${'12345'}_${alnum(40)}";`,
].join(' ');
const tokenLine = `const token = "${'gh'}p_${alnum(36)}";`;
const lineCount = 16_384;

const cleanText = `${cleanLine}\n`.repeat(lineCount);
const nearMissText = `${nearMissLine}\n`.repeat(lineCount);
const tokenText = `${cleanText}${tokenLine}\n`;

const samples = [
  { name: 'clean text', text: cleanText, expected: 0 },
  { name: 'near-miss text', text: nearMissText, expected: 0 },
  { name: 'token near end', text: tokenText, expected: 1 },
].map((sample) => ({ ...sample, lines: sample.text.split('\n') }));

const rank = (sorted: number[], share: number) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
const times = new Map(samples.map((sample) => [sample.name, [] as number[]]));

for (const sample of samples) assert.equal(findSecretHits(sample.lines).length, sample.expected, sample.name);
for (let round = 0; round <= runs; round++) {
  for (const sample of samples) {
    const start = performance.now();
    findSecretHits(sample.lines);
    if (round > 0) times.get(sample.name)?.push(performance.now() - start);
  }
}

process.stdout.write(`yokoten secret scan: ${options.label}, ${runs} runs each, Node ${process.version}, ${process.platform}\n`);
process.stdout.write(`${'sample'.padEnd(16)} ${'chars'.padStart(9)} ${'lines'.padStart(7)} ${'p50 ms'.padStart(8)} ${'max ms'.padStart(8)}\n`);
for (const sample of samples) {
  const sorted = (times.get(sample.name) ?? []).toSorted((left, right) => left - right);
  const p50 = rank(sorted, 0.5);
  const max = sorted[sorted.length - 1];
  process.stdout.write(`${sample.name.padEnd(16)} ${String(sample.text.length).padStart(9)} ${String(sample.lines.length).padStart(7)} ${p50.toFixed(2).padStart(8)} ${max.toFixed(2).padStart(8)}\n`);
}
