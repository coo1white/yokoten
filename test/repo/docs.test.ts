// The manifesto count follows the guide's agent table (#487). The guide is only read.
import './home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type ManifestoPage = {
  file: string;
  has: string[];
  lacks: string;
};

const PAGES: ManifestoPage[] = [
  {
    file: 'docs/manifesto.md',
    has: ['nine agents', 'not verified end to end'],
    lacks: 'eight agents',
  },
  {
    file: 'docs/i18n/zh-CN/manifesto.md',
    has: ['九个', '还没有完整跑过'],
    lacks: '八个 agent',
  },
  {
    file: 'docs/i18n/zh-TW/manifesto.md',
    has: ['九個', '還沒有完整跑過'],
    lacks: '八個 agent',
  },
  {
    file: 'docs/i18n/ja/manifesto.md',
    has: ['九つ', '端から端まではまだ確認していません'],
    lacks: '八つの',
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

/** The failure text when `names` is not nine rows. Empty when the count is nine. */
function agentCountReport(names: string[]): string {
  if (names.length === 9) return '';
  return `the Works with table lists ${names.length} agents, not 9: ${names.join(', ')}`;
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

test('docs: manifestos match the guide list of nine agents (#487)', () => {
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
  assert.equal(agentCountReport(shortNames), 'the Works with table lists 2 agents, not 9: Claude Code, Codex CLI');
  assert.equal(agentCountReport(['Claude Code', 'Copilot', 'Antigravity', 'Codex', 'Muse', 'DeepSeek', 'Grok', 'Gemini', 'OpenCode']), '');
  assert.deepEqual(phraseProblems('The same rules run in eight agents today.', ['nine agents', 'not verified end to end'], 'eight agents'), [
    'missing: nine agents',
    'missing: not verified end to end',
    'still says: eight agents',
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
