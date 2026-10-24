// The finish-round controller (#761): when an agent stops beating, close its run.
//
// The beat today is the status file's `updated`, which the hooks rewrite at most every
// STATUS_EVERY_MS while an agent works. The event log will carry `yokoten.agent.heartbeat`
// (#755 writes the shape); until that code lands, one field is the whole beat and this is
// the only place that reads it. When the log lands, read the heartbeat here and nothing
// else changes.
//
// Finishing a run is safe by default (record 0014): nothing is reset or deleted. The
// worktree and its branch stay, a report that is already there is never touched, and the
// status file gets `state: done` with an `outcome`, so the board stops showing the run as
// working. The way back is named in the report: the branch to switch to.

import { lstatSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type Env, loadConfig } from '../../../rules/config.ts';
import { type Finding } from '../../../rules/message.ts';
import { hideHome } from '../../../rules/privacy.ts';
import { check } from '../../../run/check.ts';
import { AGENT_STATUS_FILE, changeAgentStatus, readStatusText, type StatusCheckout } from '../../../run/hook.ts';

/** How long an agent may say nothing before the controller calls it gone, in minutes. */
export const GONE_MINUTES = 30;

/** The status file's `outcome` for a run this controller closes. */
export const FINISH_OUTCOME = 'stopped';

/** One agent the controller may finish, as its status file and worktree describe it. */
export interface FinishTarget {
  name: string;
  vendor: string;
  model: string;
  role: string;
  /** `working`, `waiting` or `done`, as filed. Only `working` is ever finished. */
  state: string;
  /** When the agent last wrote, as filed: `2026-10-23T00:00:00Z`. */
  updated: string;
  /** The branch, or '' when detached. The issue number in its name names the report. */
  branch: string;
  checkout: StatusCheckout;
}

/** What the full check said about the work the agent left. */
export interface FinishCheck {
  ok: boolean;
  /** The findings, with their place. Text from the files is never copied into the report. */
  findings: { id: string; file: string }[];
  /** Why the check could not run, or '' when it did. */
  problem: string;
}

/** The check the controller runs, or the one a test hands in instead. */
export type FinishCheckWork = (top: string, env: Env) => FinishCheck;

/** What happened to one target. `would-finish` is a dry run: nothing was written. */
export interface FinishResult {
  kind: 'finished' | 'would-finish' | 'skipped' | 'failed';
  name: string;
  worktree: string;
  /** Why the run was or was not finished, in one line. */
  reason: string;
  /** `written`, `kept` when the agent's own report stays, or '' when no report was asked for. */
  report: 'written' | 'kept' | '';
  check: FinishCheck;
}

/** The full check over the worktree at `top`, with no file text in its findings. */
export const checkWork: FinishCheckWork = (top, env) => {
  try {
    const findings = check(top, { config: loadConfig(top), env });
    return { ok: findings.length === 0, findings: findings.map(shortFinding), problem: '' };
  } catch {
    return { ok: false, findings: [], problem: 'the check could not run here' };
  }
};

const shortFinding = (finding: Finding): { id: string; file: string } => ({ id: finding.id, file: finding.file ?? '' });

/** The status file on disk as its fields, or null when it is missing, refused or not an object. */
function statusOnDisk(target: FinishTarget): Record<string, unknown> | null {
  const text = readStatusText(join(target.checkout.top, AGENT_STATUS_FILE));
  if (!text) return null;
  try {
    const status: unknown = JSON.parse(text);
    if (status === null || typeof status !== 'object' || Array.isArray(status)) return null;
    return status as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Why a status file's fields say the run must stay open, or '' when it may be finished.
 * A caller's older read never closes a run that has closed since, and a run that asks the
 * owner something is waiting, not gone (#601). The board keeps that question under
 * `blocked` or `question` until it is answered.
 */
function heldReasonIn(status: Record<string, unknown> | null): string {
  if (!status) return '';
  if (typeof status.outcome === 'object' && status.outcome !== null) return 'the status file already has an outcome';
  if (status.state === 'done') return 'the status file already says done';
  if (status.state === 'waiting') return 'the status file says waiting';
  for (const key of ['blocked', 'question']) {
    const value = status[key];
    if (typeof value === 'string' && value.trim() !== '') return `the agent is waiting for an answer (${key})`;
  }
  return '';
}

/** One `updated` field as a beat, or null when it is not a time. */
function beatTime(updated: unknown): number | null {
  if (typeof updated !== 'string') return null;
  const beat = Date.parse(updated);
  return Number.isFinite(beat) ? beat : null;
}

/** The beat a status file's fields hold, or null when they hold no readable time. */
function beatIn(status: Record<string, unknown> | null): number | null {
  return status ? beatTime(status.updated) : null;
}

/** The time of a target's filed beat, or null when it is missing or not a time. */
export function beatOf(target: FinishTarget): number | null {
  return beatTime(target.updated);
}

/** How many whole minutes since the agent last wrote, or 0 when the time is not known. */
export function quietMinutes(beat: number, now: number): number {
  return Math.max(0, Math.floor((now - beat) / 60_000));
}

/**
 * Whether the agent stopped beating (#761): it says it is working, its last beat is a real
 * time, and it is at least `goneMs` old. A beat in the future is still alive. `beat` is the
 * file's beat when the caller reads it there; it defaults to the target's filed one.
 */
export function isGone(target: FinishTarget, now: number, goneMs: number = GONE_MINUTES * 60_000, beat: number | null = beatOf(target)): boolean {
  if (target.state !== 'working') return false;
  return beat !== null && beat <= now && now - beat >= goneMs;
}

/** A status field as one line, so a value the agent wrote cannot break the report. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ').slice(0, 200);

/** The issue number a branch starts with, or '' when it names none. */
export function issueOfBranch(branch: string): string {
  return /^(\d+)-/.exec(branch)?.[1] ?? '';
}

/** Where the controller writes the report: `REPORT-<issue>.md`, or `REPORT-stopped.md`. */
export function reportPath(target: FinishTarget): string {
  const issue = issueOfBranch(target.branch);
  return join(target.checkout.top, issue ? `REPORT-${issue}.md` : 'REPORT-stopped.md');
}

/** The report for a run the controller finished, in the words a person or an agent resumes from. */
export function reportText(target: FinishTarget, result: FinishResult, now: Date, env: Env): string {
  const minutes = Date.parse(target.updated);
  const quiet = Number.isFinite(minutes) ? quietMinutes(minutes, now.getTime()) : 0;
  const who = [target.vendor, target.model].map(oneLine).filter((part) => part).join(' ');
  const lines = [
    `# Report for ${issueOfBranch(target.branch) ? `issue #${issueOfBranch(target.branch)}` : 'a stopped run'}`,
    '',
    `Finished by yokoten: the agent stopped beating. Reason: ${result.reason}. Its last status write was at ${oneLine(target.updated)} UTC, ${quiet} minutes before ${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}.`,
    '',
    `- Agent: ${oneLine(target.name)}${who ? ` (${who})` : ''}${target.role ? `, role ${oneLine(target.role)}` : ''}`,
    `- Worktree: ${hideHome(target.checkout.top, env)}`,
    `- Branch: ${oneLine(target.branch) || '(detached)'}`,
    '',
    '## What was kept',
    '',
    'The branch and its worktree are untouched. Nothing was reset, deleted or pushed.',
    '',
  ];
  if (result.check.problem) lines.push(`The full check did not run: ${result.check.problem}.`);
  else if (result.check.ok) lines.push('The full check passed on the work it left.');
  else lines.push(`The full check found ${result.check.findings.length} problem(s):`, '', ...result.check.findings.slice(0, 20).map((finding) => `- ${finding.id}${finding.file ? `: ${finding.file}` : ''}`));
  lines.push('', '## How to go on', '');
  lines.push(target.branch ? `- Read this report, then continue on the branch: \`git switch ${target.branch}\`.` : '- Read this report, then continue from the worktree above.');
  lines.push('- If the run should stay closed, leave it. The status file says `done` and keeps its outcome.', '');
  return lines.join('\n');
}

/**
 * Write the report, unless the agent wrote one. Never touch an existing report. A path
 * something other than a file holds, or a write that fails, is `failed`: the run must not
 * be closed without the report a person or an agent resumes from.
 */
function writeReport(target: FinishTarget, result: FinishResult, now: Date, env: Env): 'written' | 'kept' | 'failed' {
  const path = reportPath(target);
  try {
    const info = lstatSync(path);
    // A folder, a socket or a link to nowhere is not the agent's report we may keep.
    return info.isFile() || info.isSymbolicLink() ? 'kept' : 'failed';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'failed';
  }
  try {
    writeFileSync(path, reportText(target, result, now, env));
    return 'written';
  } catch {
    return 'failed';
  }
}

/**
 * Finish one run, or say why not (#761). The order matters: the report lands before the
 * status says `done`, so a crash in between is finished on the next run. A dry run reads
 * the check and writes nothing.
 */
export function finishTarget(
  target: FinishTarget,
  { env, now = new Date(), goneMs = GONE_MINUTES * 60_000, isDryRun = false, checkWorkHere = checkWork }: {
    env: Env;
    now?: Date;
    goneMs?: number;
    isDryRun?: boolean;
    checkWorkHere?: FinishCheckWork;
  },
): FinishResult {
  const result = (kind: FinishResult['kind'], reason: string, work: FinishCheck, report: FinishResult['report'] = ''): FinishResult =>
    ({ kind, name: target.name, worktree: target.checkout.top, reason, report, check: work });

  if (target.state !== 'working') return result('skipped', `the agent says ${target.state || 'nothing'}`, { ok: true, findings: [], problem: '' });
  const disk = statusOnDisk(target);
  const held = heldReasonIn(disk);
  if (held) return result('skipped', held, { ok: true, findings: [], problem: '' });
  // The later of the filed and the on-disk beat is the run's last one: a caller's older
  // snapshot never closes a run that has beaten since it was read, and a file that is gone
  // or unreadable leaves the snapshot.
  const filedBeat = beatOf(target);
  const diskBeat = beatIn(disk);
  const beat = diskBeat === null ? filedBeat : filedBeat === null ? diskBeat : Math.max(filedBeat, diskBeat);
  if (beat === null) return result('skipped', 'the status file has no readable time', { ok: true, findings: [], problem: '' });
  if (!isGone(target, now.getTime(), goneMs, beat)) return result('skipped', `it beat ${quietMinutes(beat, now.getTime())} minutes ago`, { ok: true, findings: [], problem: '' });
  const quiet = quietMinutes(beat, now.getTime());
  const work = checkWorkHere(target.checkout.top, env);
  // The check takes time, and a live agent beats while it runs: read the file again and
  // leave a run that came back, or one that started asking, alone.
  const after = statusOnDisk(target);
  const afterHeld = heldReasonIn(after);
  if (afterHeld) return result('skipped', afterHeld, work);
  const laterBeat = beatIn(after);
  if (laterBeat !== null && laterBeat > beat) return result('skipped', 'it beat again during the check', work);
  const filed = after && typeof after.updated === 'string' ? { ...target, updated: after.updated } : target;
  const reason = `no update for ${quiet} minutes`;
  if (isDryRun) return result('would-finish', reason, work);
  const report = writeReport(filed, result('finished', reason, work), now, env);
  if (report === 'failed') return result('failed', `the report ${basename(reportPath(filed))} could not be written, so the run stays open`, work);
  const done = changeAgentStatus(target.checkout, {
    set: {
      state: 'done',
      doing: 'stopped beating; yokoten finished the run',
      blocked: null,
      outcome: { value: FINISH_OUTCOME, reason },
    },
  }, now);
  if (!done) return result('failed', 'the status file could not be written', work, report);
  return result('finished', reason, work, report);
}
