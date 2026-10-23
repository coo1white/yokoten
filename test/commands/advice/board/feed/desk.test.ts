// Tests for src/commands/advice/board/feed/desk.ts.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../../../repo/helpers.ts';
import { dependsOf, firstSentence, LEAD_DESK_FILE, readLeadDesk, readLeadReply } from '../../../../../src/commands/advice/board/feed/desk.ts';
import { claudeFolder, LEAD_SESSION_FILE } from '../../../../../src/commands/advice/board/feed/logs.ts';

test('board desk: the desk file is read, and a bad file is ignored', () => {
  const sandbox = makeSandbox();
  const email = ['someone', 'personal-mail.com'].join('@');
  const file = join(sandbox.repo, '.git', LEAD_DESK_FILE);
  const ask = (question: string, answers: unknown[] = ['yes']) => ({ question, recommend: 'go', answers });
  writeFileSync(file, JSON.stringify({
    now: `Mail ${email} about ${sandbox.home}/notes`,
    decisions: [
      ask('Ship it?', ['yes', 'no', 'yes please', 'x'.repeat(25), 3]),
      ask('  '),
      { question: 'Keep the name?', recommend: `see ${email}`, answers: ['keep'] },
    ],
    updated: '2026-10-22T12:00:00Z',
  }));
  const desk = readLeadDesk(sandbox.repo, sandbox.env);
  assert.ok(desk);
  assert.equal(desk.now.includes(email), false);
  assert.match(desk.now, /<email>/);
  assert.equal(desk.now.includes(sandbox.home), false);
  assert.match(desk.now, /~\/notes/);
  assert.deepEqual(desk.decisions.map((item) => item.question), ['Ship it?', 'Keep the name?']);
  assert.deepEqual(desk.decisions[0].answers, ['yes', 'no']);
  assert.equal(desk.decisions[1].recommend.includes(email), false);
  assert.equal(desk.updated, '2026-10-22T12:00:00Z');

  writeFileSync(file, JSON.stringify({ decisions: [1, 2, 3, 4, 5].map((number) => ask(`Question ${number}`)) }));
  assert.deepEqual(readLeadDesk(sandbox.repo, sandbox.env)?.decisions.map((item) => item.question), ['Question 1', 'Question 2', 'Question 3']);

  writeFileSync(file, '{}');
  assert.deepEqual(readLeadDesk(sandbox.repo, sandbox.env), { now: '', decisions: [], updated: '' });
  writeFileSync(file, JSON.stringify({ now: 'hi', updated: 'yesterday' }));
  assert.deepEqual(readLeadDesk(sandbox.repo, sandbox.env), { now: 'hi', decisions: [], updated: '' }, 'a time that is not a time is dropped');

  for (const bad of ['{oops', '[]', JSON.stringify({ now: 1 }), JSON.stringify({ decisions: {} }), `{${' '.repeat(70_000)}}`]) {
    writeFileSync(file, bad);
    assert.equal(readLeadDesk(sandbox.repo, sandbox.env), null, 'a bad file is ignored');
  }
  const outside = join(sandbox.home, 'desk.json');
  writeFileSync(outside, JSON.stringify({ now: 'hidden by the link' }));
  unlinkSync(file);
  symlinkSync(outside, file);
  assert.equal(readLeadDesk(sandbox.repo, sandbox.env), null, 'a link is not followed');
  unlinkSync(file);
  assert.equal(readLeadDesk(sandbox.repo, sandbox.env), null, 'no file, no desk');
  assert.equal(readLeadDesk(sandbox.home, sandbox.env), null, 'outside a repo, no desk');

  assert.deepEqual(dependsOf('Hello\nDepends on issue #700.\nDepends on: #697, #698 and #697'), [700, 697, 698]);
  assert.deepEqual(dependsOf('no dependency here'), []);
});

test('board desk: the last reply is the first sentence, masked', () => {
  const sandbox = makeSandbox();
  const email = ['someone', 'personal-mail.com'].join('@');
  const home = sandbox.home;
  const said = (text: string) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
  const live = join(home, '.claude', 'projects', claudeFolder(join(home, 'parent')), 'live.jsonl');
  mkdirSync(join(live, '..'), { recursive: true });
  writeFileSync(live, said(`Mail ${email} about ${home}/notes is done. The rest stays for a click. 完了。続きです。`));
  writeFileSync(join(sandbox.repo, '.git', LEAD_SESSION_FILE), `${live}\n`, { mode: 0o600 });
  const reply = readLeadReply(sandbox.repo, 'claude-code', sandbox.env, sandbox.repo);
  assert.match(reply.reply, /^Mail <email> about ~\/notes is done\.$/);
  assert.equal(reply.reply.includes(email), false);
  assert.equal(reply.reply.includes(home), false);
  assert.match(reply.rest, /The rest stays for a click\./);
  assert.equal(readLeadReply(sandbox.repo, 'grok', sandbox.env, sandbox.repo).reply, '', 'no log for this vendor');

  assert.deepEqual(firstSentence('Ship it. The rest stays.'), { reply: 'Ship it.', rest: 'The rest stays.' });
  assert.deepEqual(firstSentence('完了。続きです。'), { reply: '完了。', rest: '続きです。' });
  assert.deepEqual(firstSentence('What now? Yes.'), { reply: 'What now?', rest: 'Yes.' });
  assert.deepEqual(firstSentence('version 3.14 is fine'), { reply: 'version 3.14 is fine', rest: '' });
  const long = 'a'.repeat(300);
  const cut = firstSentence(long);
  assert.equal(cut.reply.length, 240);
  assert.equal(cut.rest.length, 60);
});
