// Tests for src/host/github/server.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Gh } from '../../../src/host/github/planning.ts';
import { readIncident } from '../../../src/host/github/server.ts';
import { draftLesson, type Incident } from '../../../src/run/learn.ts';

// `yokoten learn` (#77) reads an incident through gh. A fake gh stands in; GitHub is never reached.
test('incident: read through gh issue view; a bad reference or a gh failure is a reason, never a crash', () => {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    return JSON.stringify({ number: 12, title: 'check: misses a key', body: '## Fix\n\nA check.', url: 'https://example.com/issues/12', labels: [{ name: 'incident' }, { name: 'bug' }] });
  };
  assert.deepEqual(readIncident(gh, '12'), { number: 12, title: 'check: misses a key', body: '## Fix\n\nA check.', url: 'https://example.com/issues/12', labels: ['incident', 'bug'] });
  assert.deepEqual(calls, [['issue', 'view', '12', '--json', 'number,title,body,url,labels']]);
  assert.equal(typeof readIncident(gh, 'https://github.com/owner/repo/issues/12'), 'object');
  for (const bad of ['--web', '12; rm', 'https://example.com/issues/12']) assert.match(String(readIncident(gh, bad)), /is not an issue: give its number, or a URL/);
  assert.equal(calls.length, 2, 'a bad reference never reaches gh');
  const missing: Gh = () => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  };
  assert.match(String(readIncident(missing, '12')), /^gh is not installed/);
  const refused: Gh = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'GraphQL: Could not resolve to an issue\nmore' });
  };
  assert.equal(readIncident(refused, '99'), 'gh can\'t read issue 99 (GraphQL: Could not resolve to an issue): run `gh auth login`, and check the number and the repo');
  const escaping: Gh = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'bad \u001b[2K\u001b]8;;https://example.com\u0007link' });
  };
  assert.ok(!/[\u001b\u0007]/.test(String(readIncident(escaping, '99'))), 'gh\'s error text reaches the terminal with no raw escape');
});

test('incident: the number gh gives must be a whole number above 0, since it names the draft\'s folder', () => {
  const ghWith = (number: unknown): Gh => () => JSON.stringify({ number, title: 'check: misses a key', body: '', url: 'https://example.com/issues/1', labels: [] });
  for (const bad of ['1/../../x', 0, -1, 1.5, 2 ** 53, null, undefined]) {
    const result = readIncident(ghWith(bad), '1');
    assert.equal(result, 'gh gave no issue number for 1: it must be a whole number above 0', `number ${String(bad)}`);
  }
  assert.equal((readIncident(ghWith(7), '1') as { number: number }).number, 7);
});

test('incident: an odd title is a reason; an odd body or url is empty, and the draft has a TODO for the url', () => {
  const ghWith = (fields: Record<string, unknown>): Gh => () => JSON.stringify({ number: 3, title: 'check: misses a key', body: '## Fix\n\nA check.', url: 'https://example.com/issues/3', labels: [], ...fields });
  for (const odd of [null, 7, { text: 'x' }, ['x'], undefined]) {
    assert.equal(readIncident(ghWith({ title: odd }), '3'), 'gh gave no title for 3', `title ${JSON.stringify(odd)}`);
    const noBody = readIncident(ghWith({ body: odd }), '3') as Incident;
    assert.equal(noBody.body, '', `body ${JSON.stringify(odd)}`);
    assert.equal(typeof draftLesson(noBody).finding.fix, 'string');
    const noUrl = readIncident(ghWith({ url: odd }), '3') as Incident;
    assert.equal(noUrl.url, '', `url ${JSON.stringify(odd)}`);
    assert.match(draftLesson(noUrl).files[0].text, /^\/\/ TODO\(reviewer\): gh gave no URL for the issue$/m);
    assert.deepEqual((readIncident(ghWith({ labels: odd }), '3') as Incident).labels, [], `labels ${JSON.stringify(odd)}`);
  }
  // Only entries with a string name are kept.
  const mixed = [{ name: 'incident' }, null, 7, 'bug', { name: 5 }, { name: null }, {}, { name: '' }, [{ name: 'x' }], { name: 'bug' }];
  assert.deepEqual((readIncident(ghWith({ labels: mixed }), '3') as Incident).labels, ['incident', 'bug']);
});
