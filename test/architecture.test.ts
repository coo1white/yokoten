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
// agents: one adapter per AI runtime. setup: writing yokoten into a machine or a project.
const LAYERS = ['rules', 'run', 'agents', 'setup'];

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
