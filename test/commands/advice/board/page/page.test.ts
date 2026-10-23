// Tests for src/commands/advice/board/page/page.ts.

import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardManifest, boardPage, boardScript } from '../../../../../src/commands/advice/board/page/page.ts';

/** Text that would end or hide the inline script early. */
function findScriptBreaks(source: string): string[] {
  return [/<\/script/i, /<!--/, /<script/i].filter((breaker) => breaker.test(source)).map(String);
}

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
  for (const id of ['pinned', 'agents', 'center', 'bar', 'toast', 'live', 'theme', 'repo', 'needs', 'needs-count', 'needs-menu']) assert.ok(page.includes(`id="${id}"`), `region ${id}`);
  assert.equal(page.includes('id="right"'), false, 'the right column is gone');
  assert.ok((page.match(/grid-template-columns:[^;}]+/g) ?? []).every((rule) => !rule.includes('360px')), 'the stream takes the old right width');
  assert.match(page, /\.needs-panel\{[^}]*overflow:auto/, 'a long list scrolls');
  assert.ok(page.includes('.badge.pulse{animation:none}'), 'reduced motion stops the pulse');
  assert.match(page, /#pinned\{display:none\}/, 'a phone hides the left column');
  assert.equal(page.split('<script').length - 1, 1, 'one script');
  assert.ok(page.includes('<script nonce="bm9uY2U=">'), 'the script carries the nonce');
  assert.deepEqual(page.match(/<link\b[^>]*>/g), ['<link rel="manifest" href="/manifest.webmanifest">'], 'the only link is the install manifest');
  assert.ok(page.includes('<meta name="theme-color" content="#b4532a" media="(prefers-color-scheme: light)">'), 'light uses the brand colour');
  assert.ok(page.includes('<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">'), 'dark uses the page background');
  assert.equal(page.includes('serviceWorker'), false, 'install needs no service worker');
  assert.ok(!/\bsrc="|@import|url\(/i.test(page), 'nothing loads from outside, so the board works offline');
  const addresses = page.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  assert.deepEqual([...new Set(addresses)], ['http://www.w3.org/2000/svg'], 'the only address is the SVG namespace');
  assert.ok(page.includes('@media (max-width:700px)') && page.includes('@media (max-width:1100px)'), 'a phone and a tablet layout');
  assert.ok(page.includes('prefers-color-scheme:dark'), 'dark follows the system');
});

test('board page: the script parses, uses no HTML or code sink, and starts the page', () => {
  const script = boardScript();
  assert.doesNotThrow(() => new Function(script), 'the serialized functions are plain JavaScript');
  assert.deepEqual(findUnsafeSinks(script), []);
  assert.deepEqual(findScriptBreaks(script), [], 'no word or setting can close the script tag');
  assert.match(script, /"refreshMs":15000/, 'refreshes every 15 seconds');
  assert.match(script, /"agentFile":"\.yokoten-agent\.json"/);
  assert.match(script, /startPage\(state\);$/);
  assert.equal(script.includes('location.search'), false, 'the page does not read the token from the address');
});

// #603: the page's controls post to the board's change endpoints. The cookie goes
// with the request. Nothing here approves or merges.
test('board page: the controls post to /agents/* and leave the token out', () => {
  const script = boardScript();
  for (const path of ['agents/start', 'agents/stop', 'agents/limits']) assert.ok(script.includes(`'${path}'`), `posts to ${path}`);
  assert.equal(script.includes('?t=') || script.includes('state.token') || script.includes('"token"'), false, 'the token stays out of the page');
  assert.ok(script.includes("method: 'POST'") && script.includes('application/x-www-form-urlencoded'), 'posts the fields as a form');
  for (const missing of ['agents/approve', 'agents/merge']) assert.ok(!script.includes(missing), `no ${missing} endpoint`);
  for (const name of ['renderStart', 'renderLimits', 'renderRuns', 'renderOutput', 'postForm']) {
    assert.ok(script.includes(`function ${name}`), `${name} runs in the page`);
  }
});

// #693: Chrome and Edge read this manifest and offer Install. The icon is inline.
test('board page: the manifest installs the board as its own window', () => {
  const raw = boardManifest();
  const manifest = JSON.parse(raw) as { name: string; display: string; start_url: string; scope: string; background_color: string; theme_color: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };
  assert.equal(manifest.name, 'yokoten board');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.background_color, '#ffffff', 'the page background');
  assert.equal(manifest.theme_color, '#b4532a', 'the page brand colour');
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['any', '512x512']);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/svg+xml');
    assert.equal(icon.purpose, 'any');
    assert.match(icon.src, /^data:image\/svg\+xml,/);
    const svg = decodeURIComponent(icon.src.slice('data:image/svg+xml,'.length));
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal(svg.includes('<script'), false, 'the icon is a picture');
  }
  assert.equal(raw.includes('token'), false, 'the manifest holds no token');
  assert.equal(raw.includes('serviceWorker'), false, 'no service worker');
});

// A positive control: the sink check catches each sink.
test('board page: the sink check catches each sink', () => {
  for (const bad of ['row.innerHTML = name', 'x.outerHTML=y', "box.insertAdjacentHTML('beforeend', s)", 'document.write(s)', 'eval(s)', "new Function('a')", "setTimeout('go()', 1)"]) {
    assert.equal(findUnsafeSinks(bad).length, 1, bad);
  }
  assert.deepEqual(findUnsafeSinks('node.textContent = name; setTimeout(() => go(), 1)'), []);
});

// #701: the desk and the timeline use the light colours, the dark colours, and one column on a phone.
test('board page: the desk and the timeline fit light, dark and a phone', () => {
  const page = boardPage('bm9uY2U=');
  const light = page.slice(0, page.indexOf('@media (prefers-color-scheme:dark)'));
  assert.match(light, /:root\{color-scheme:light;[^}]*--bg:#fff/);
  assert.match(light, /--track:#ececec/);
  assert.match(page, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{[^}]*--bg:#0a0a0a/);
  assert.match(page, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{[^}]*--track:#2a2a2a/);
  assert.match(page, /:root\[data-theme=dark\]\{[^}]*--bg:#0a0a0a/);
  assert.match(page, /:root\[data-theme=dark\]\{[^}]*--track:#2a2a2a/);
  const deskAt = page.indexOf('.lead-desk{');
  assert.ok(deskAt > page.indexOf('prefers-color-scheme:dark'), 'the desk is in the base sheet, so light uses it too');
  assert.ok(page.indexOf('.gantt{') > deskAt);
  assert.match(page, /@keyframes desk-breathe/);
  assert.match(page, /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.gantt-bar\.live\{animation:none\}/);
  const phone = page.slice(page.indexOf('@media (max-width:700px)'), page.indexOf('</style>'));
  assert.match(phone, /\.gantt\{padding:8px\}/);
  assert.match(phone, /\.gantt-row\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(phone, /\.lead-desk \.ans\{min-height:40px/);
  assert.match(phone, /#pinned\{display:none\}/, 'a phone still hides the lead column');
  assert.ok(page.indexOf('.phone-desk{display:none}') < page.indexOf('@media (max-width:700px)'), 'a wide screen hides the bell copy of the desk');
  assert.match(phone, /\.phone-desk\{display:block/, 'a phone shows the desk under the bell');
});

// A positive control: the break check catches each way out of the script tag.
test('board page: the break check catches a closing tag and a comment', () => {
  assert.equal(findScriptBreaks('const a = "</SCRIPT><!--";').length, 2);
  assert.deepEqual(findScriptBreaks(JSON.stringify({ a: '</script>' }).replace(/</g, '\\u003c')), [], 'the escape the page uses');
});
