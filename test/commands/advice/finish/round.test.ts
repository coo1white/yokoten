// The finish-round controller (#761): an agent that stops beating is closed, not lost.

import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { beatOf, finishTarget, type FinishCheck, type FinishTarget, GONE_MINUTES, isGone, issueOfBranch, quietMinutes, reportPath } from '../../../../src/commands/advice/finish/round.ts';
import type { StatusCheckout } from '../../../../src/run/hook.ts';
import { makeTempDir } from '../../../repo/helpers.ts';

const NOW = new Date('2026-10-23T01:00:00Z');
const OK: FinishCheck = { ok: true, findings: [], problem: '' };

/** A throwaway checkout with a status file, as the hooks write one. */
function makeTarget(fields: Record<string, unknown> = {}, branch = '761-finish-a-run'): { target: FinishTarget; top: string } {
  const top = makeTempDir('yokoten-finish-');
  mkdirSync(join(top, '.git'), { recursive: true });
  const checkout: StatusCheckout = { top, gitDir: join(top, '.git'), common: join(top, '.git'), isMain: false, isDesk: false };
  const status = { name: 'worker-1', vendor: 'example-vendor', model: 'model-1', role: 'engineer', state: 'working', updated: '2026-10-23T00:00:00Z', ...fields };
  writeFileSync(join(top, '.yokoten-agent.json'), `${JSON.stringify(status, null, 2)}\n`);
  return { target: { name: String(status.name), vendor: String(status.vendor), model: String(status.model), role: String(status.role), state: String(status.state), updated: String(status.updated), branch, checkout }, top };
}

const readStatus = (top: string): Record<string, unknown> => JSON.parse(readFileSync(join(top, '.yokoten-agent.json'), 'utf8')) as Record<string, unknown>;

describe('isGone', () => {
  it('waits for the gone limit, and never guesses without a real beat', () => {
    const { target } = makeTarget();
    assert.equal(isGone(target, NOW.getTime()), true, 'one hour is more than the default limit');
    assert.equal(isGone(target, Date.parse('2026-10-23T00:29:59Z')), false, 'just under the limit');
    assert.equal(isGone(target, Date.parse('2026-10-23T00:30:00Z')), true, 'exactly the limit is gone');
    assert.equal(isGone({ ...target, state: 'waiting' }, NOW.getTime()), false, 'waiting for the owner is not gone');
    assert.equal(isGone({ ...target, state: 'done' }, NOW.getTime()), false, 'a done run stays done');
    assert.equal(isGone({ ...target, updated: 'not a time' }, NOW.getTime()), false, 'a broken time is not a beat');
    assert.equal(isGone({ ...target, updated: '2026-10-23T02:00:00Z' }, NOW.getTime()), false, 'a beat in the future is alive');
  });

  it('reads the beat and the quiet time', () => {
    const { target } = makeTarget();
    assert.equal(beatOf(target), Date.parse('2026-10-23T00:00:00Z'));
    assert.equal(quietMinutes(Date.parse('2026-10-23T00:00:00Z'), NOW.getTime()), 60);
    assert.equal(beatOf({ ...target, updated: '' }), null);
  });
});

describe('finishTarget', () => {
  it('writes the report, then says done with an outcome', () => {
    const { target, top } = makeTarget();
    const result = finishTarget(target, { env: {}, now: NOW, checkWorkHere: () => OK });
    assert.equal(result.kind, 'finished');
    assert.equal(result.report, 'written');
    const status = readStatus(top);
    assert.equal(status.state, 'done');
    assert.equal(status.doing, 'stopped beating; yokoten finished the run');
    assert.deepEqual(status.outcome, { value: 'stopped', reason: 'no update for 60 minutes' });
    assert.equal(status.updated, '2026-10-23T01:00:00Z');
    const report = readFileSync(reportPath(target), 'utf8');
    assert.match(report, /^# Report for issue #761/);
    assert.match(report, /no update for 60 minutes/);
    assert.match(report, /git switch 761-finish-a-run/);
    assert.match(report, /check passed/);
  });

  it('changes nothing on a dry run, and is safe to run twice', () => {
    const { target, top } = makeTarget();
    const before = readStatus(top);
    const dry = finishTarget(target, { env: {}, now: NOW, isDryRun: true, checkWorkHere: () => OK });
    assert.equal(dry.kind, 'would-finish');
    assert.deepEqual(readStatus(top), before);
    assert.equal(existsSync(reportPath(target)), false);
    assert.equal(finishTarget(target, { env: {}, now: NOW, checkWorkHere: () => OK }).kind, 'finished');
    assert.equal(finishTarget(target, { env: {}, now: NOW, checkWorkHere: () => OK }).kind, 'skipped', 'the second run leaves a done agent alone');
  });

  it('never touches a report the agent wrote, and names a check that could not run', () => {
    const { target, top } = makeTarget();
    writeFileSync(reportPath(target), 'the agent wrote this\n');
    const result = finishTarget(target, { env: {}, now: NOW, checkWorkHere: () => ({ ok: false, findings: [], problem: 'the check could not run here' }) });
    assert.equal(result.report, 'kept');
    assert.equal(readFileSync(reportPath(target), 'utf8'), 'the agent wrote this\n');
    assert.match(readFileSync(reportPath(target), 'utf8'), /^the agent wrote this/);
    assert.equal(readStatus(top).state, 'done');
    const again = finishTarget({ ...target, state: 'working', updated: '2026-10-23T00:00:00Z' }, { env: {}, now: NOW, checkWorkHere: () => OK });
    assert.equal(again.kind, 'skipped', 'a status file that already closed the run is left alone');
  });

  it('says what the check found, without copying file text', () => {
    const { target } = makeTarget();
    const check: FinishCheck = { ok: false, findings: [{ id: 'secret', file: 'src/a.ts' }, { id: 'layout', file: '' }], problem: '' };
    const result = finishTarget(target, { env: {}, now: NOW, checkWorkHere: () => check });
    assert.equal(result.kind, 'finished');
    const report = readFileSync(reportPath(target), 'utf8');
    assert.match(report, /found 2 problem\(s\)/);
    assert.match(report, /secret: src\/a\.ts/);
    assert.match(report, /layout/);
  });

  it('leaves an agent that beat recently, and one with no time, alone', () => {
    const fresh = makeTarget({ updated: '2026-10-23T00:45:00Z' });
    assert.equal(finishTarget(fresh.target, { env: {}, now: NOW, checkWorkHere: () => OK }).kind, 'skipped');
    assert.equal(readStatus(fresh.top).state, 'working');
    const broken = makeTarget({ updated: 'yesterday' });
    assert.equal(finishTarget(broken.target, { env: {}, now: NOW, checkWorkHere: () => OK }).kind, 'skipped');
  });

  it('leaves an agent that waits for an answer alone', () => {
    for (const key of ['blocked', 'question']) {
      const held = makeTarget({ [key]: 'may I run npm test?' });
      const result = finishTarget(held.target, { env: {}, now: NOW, checkWorkHere: () => OK });
      assert.equal(result.kind, 'skipped');
      assert.match(result.reason, /waiting for an answer/);
      assert.equal(readStatus(held.top).state, 'working');
    }
  });

  it('uses the issue in the branch, or a plain name without one', () => {
    assert.equal(issueOfBranch('761-finish-a-run'), '761');
    assert.equal(issueOfBranch('feat/no-issue'), '');
    const { target, top } = makeTarget({}, 'main');
    assert.equal(reportPath(target), join(top, 'REPORT-stopped.md'));
  });

  it('keeps the default limit in one place', () => {
    assert.equal(GONE_MINUTES, 30);
  });
});
