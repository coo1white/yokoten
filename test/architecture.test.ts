// The shape of the code, checked. A rule about structure that no test holds drifts.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Lowest first. A module may import from its own layer or a lower one, never a higher.
// rules: what is allowed, as pure functions. run: the checks at work (hook, commit, CI).
// agents: one adapter per AI runtime. github: the code host's API (the bot).
// setup: writing yokoten into a machine or a project.
const LAYERS = ['rules', 'run', 'agents', 'github', 'setup'];

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
  assert.ok(seen > 0, 'no `uses:` found; the scan is broken');
});
