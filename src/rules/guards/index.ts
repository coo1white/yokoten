// The rules an agent works under. Each check returns null to let the action go on, or a
// finding: what it stops, why, and what the agent does instead.
//
// `env` is the guard's own environment, which the session sets and the agent cannot change.
// The command text is never read for it: `YOKOTEN_FIX_TASK=0 git commit` inside a command
// changes nothing. A session is the lead unless whoever started it set YOKOTEN_ROLE=worker
// (the dispatch skill does, for each worker it starts), or the lead marked its worktree (#555).
//
// This is a guard against mistakes and drift, not a lock. It reads command text, so a
// command built up in pieces gets past it. The lock is on the server: branch protection,
// CODEOWNERS, and a release token the agents do not hold.

export { isPlainCommand } from './bash/body.ts';
export { commandWords } from './bash/read/read.ts';
export { withoutShellRedirects, realPath, findProgramPlaces, findHeavyJob } from './bash/read/words.ts';
export { ACCOUNT_PRINTERS, REDACT_MARKER, isRedacted, printsAccount, hardenRead, privateOutput, wrapForRedact } from './commands/accounts.ts';
export { checkCommand, releaseFix } from './commands/check.ts';
export type { RuledRepo } from './commands/check.ts';
export { hookFile, runsCheck } from './hooks/read.ts';
export { checkEdit, stripWorktreeRoot, isLeadOnly, isGranted } from './lead-only/edit.ts';
export { plainArgs } from './lead-only/targets.ts';
export { checkWorkerMarkEdit, checkTeamEdit, useHostCommands } from './worker/config-command.ts';
export type { HostCommands } from './worker/config-command.ts';
export { configFolder, STOPS_FILE, STOPS_OFF_FILE, stopsFile, stopsOffFile } from './worker/config.ts';
export { workersFile, loadWorkerPaths, listedWorker, addWorkerPath, removeWorkerPath } from './worker/list.ts';
export { WORKER_MARK, DONE_WHEN_FILE, gitLinkAbove, workerMarkAt, hasWorkerMark, workerRole, withWorkerMark, markNote } from './worker/mark.ts';
export type { GitLink } from './worker/mark.ts';
