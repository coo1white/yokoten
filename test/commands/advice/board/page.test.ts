// Tests for src/commands/advice/board/page.ts.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardPage, boardScript } from '../../../../src/commands/advice/board/page.ts';

/** The ways a page script can turn text into HTML or code. Agents write the board's text, so none may appear. */
function findUnsafeSinks(source: string): string[] {
  const sinks = [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bsetTimeout\s*\(\s*['"`]/, /\bsetInterval\s*\(\s*['"`]/];
  return sinks.filter((sink) => sink.test(source)).map(String);
}

test('board page: one page with its regions, the nonce on its only script, nothing from outside', () => {
  const page = boardPage('bm9uY2U=');
  assert.match(page, /^<!DOCTYPE html>/);
  assert.match(page, /<title>yokoten board<\/title>/);
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/, 'a phone sizes it');
  for (const id of ['pinned', 'agents', 'center', 'right', 'bar', 'toast', 'live', 'theme', 'repo']) assert.ok(page.includes(`id="${id}"`), `region ${id}`);
  assert.equal(page.split('<script').length - 1, 1, 'one script');
  assert.ok(page.includes('<script nonce="bm9uY2U=">'), 'the script carries the nonce');
  assert.ok(!/<link\b|\bsrc="|@import|url\(/i.test(page), 'nothing loads from outside, so the board works offline');
  const addresses = page.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  assert.deepEqual([...new Set(addresses)], ['http://www.w3.org/2000/svg'], 'the only address is the SVG namespace');
  assert.ok(page.includes('@media (max-width:700px)') && page.includes('@media (max-width:1100px)'), 'a phone and a tablet layout');
  assert.ok(page.includes('prefers-color-scheme:dark'), 'dark follows the system');
});

test('board page: the script parses, uses no HTML or code sink, and starts the page', () => {
  const script = boardScript();
  assert.doesNotThrow(() => new Function(script), 'the serialized functions are plain JavaScript');
  assert.deepEqual(findUnsafeSinks(script), []);
  assert.match(script, /"refreshMs":15000/, 'refreshes every 15 seconds');
  assert.match(script, /"agentFile":"\.yokoten-agent\.json"/);
  assert.match(script, /startPage\(state\);$/);
  assert.ok(script.includes("new URLSearchParams(location.search).get('t')"), 'the token comes from the link');
});

// A positive control: the sink check catches each sink.
test('board page: the sink check catches each sink', () => {
  for (const bad of ['row.innerHTML = name', 'x.outerHTML=y', "box.insertAdjacentHTML('beforeend', s)", 'document.write(s)', 'eval(s)', "new Function('a')", "setTimeout('go()', 1)"]) {
    assert.equal(findUnsafeSinks(bad).length, 1, bad);
  }
  assert.deepEqual(findUnsafeSinks('node.textContent = name; setTimeout(() => go(), 1)'), []);
});
