# The open standard

[简体中文](i18n/zh-CN/standard.md)

This page names the shapes a vendor agent follows to join a yokoten team.
yokoten is a neutral trust layer between any agent and the code.
This page is version 1, dated 2026-10-23 (UTC).
The shapes themselves have no version field.
When a shape is already in the code, and this page disagrees, the code wins.
The event log is specified here first.
The code does not write that log yet.
Examples use placeholders such as `example-vendor`, `model-1` and `https://example.com/change`.

## The event log

One repo has one append-only log.
The path is `.git/yokoten/events.jsonl` under the common git directory.
A linked worktree appends to that same file.
The file is not committed, because it lives under the git directory.
The file is UTF-8, and a line has no `\r`.
Each line is one OTLP/JSON `ExportLogsServiceRequest`, and the line ends with `\n`.
The request has one `resourceLogs` entry, one `scopeLogs` entry and one `logRecords` entry.
The line holds one log record.
The resource attribute `service.name` is `yokoten`.
Resource attributes use the same key and value form.
The scope is named `yokoten`.
A writer does not delete a line.
This shape does not say how the file rotates.

The data model calls the time `Timestamp`.
The file uses the OTLP/JSON name `timeUnixNano`.
`timeUnixNano` is a string of digits, not a JSON number.
The instant is UTC.
The data model calls the observed time `ObservedTimestamp`.
The file uses the OTLP/JSON name `observedTimeUnixNano`.
`observedTimeUnixNano` is a string of digits too.
It equals `timeUnixNano`, because yokoten is the source.
The data model calls the kind `EventName`.
The file uses the OTLP/JSON name `eventName`.
The data model calls the reason `Body`.
The file uses `body`.
`body` uses `stringValue` when the event has a reason, and it is omitted otherwise.

OpenTelemetry has no name for this work, so `eventName` starts with `yokoten.agent`.
The eight names are `yokoten.agent.start`, `yokoten.agent.heartbeat`, `yokoten.agent.tool_call` and `yokoten.agent.refusal`.
They are also `yokoten.agent.report`, `yokoten.agent.stop`, `yokoten.agent.saved` and `yokoten.agent.merged`.
An attribute is an OTLP key and value.
A text value uses `stringValue`.
The interval uses `doubleValue`.
The `attributes` array is present on every event.
Text attributes are present even when the text is empty.
The provider key is `gen_ai.provider.name`.
The old key `gen_ai.system` is not used.
The model key is `gen_ai.request.model`.
A `yokoten.agent.start` and a `yokoten.agent.heartbeat` must include `yokoten.heartbeat.interval`, and the number must be positive.
Any other interval fails the check.
A `yokoten.agent.refusal` sets `yokoten.outcome` to `refused`.
A `yokoten.agent.stop` sets `yokoten.outcome` to `done`, `failed`, `timed_out` or `stopped`.
A `yokoten.agent.tool_call` sets `gen_ai.operation.name` to `execute_tool`, and sets `gen_ai.tool.name` when the tool has a name.
A field the table does not name may be present.
The check ignores it.

The hash covers the raw line.
A tool that reformats the JSON breaks the chain.
The first line's `yokoten.event.previous_hash` is 64 zeros.
It is not a hash of an earlier line.
Every later line stores the lowercase hex SHA-256 of the previous line's bytes, without the newline.
The hashed bytes do not include the `\n` at the end of the line.

Keys in the table are attribute keys, except `timeUnixNano`, `observedTimeUnixNano`, `eventName` and `body`.

| Field | Required on | What it holds |
| --- | --- | --- |
| `timeUnixNano` | every event | Digits. Nanoseconds since the Unix epoch. UTC. |
| `observedTimeUnixNano` | every event | The same digits as `timeUnixNano`. |
| `eventName` | every event | One of the eight names above. |
| `body` | when there is a reason | OTLP `stringValue`. The outcome reason, when this event sets one. |
| `gen_ai.agent.name` | every event | The agent name. |
| `gen_ai.provider.name` | every event | The vendor. |
| `gen_ai.request.model` | every event | The model. |
| `yokoten.role` | every event | The role word, as declared. |
| `yokoten.issue` | every event | The issue number as text, with no `#`, or empty. |
| `yokoten.worktree` | every event | The worktree folder name. The status view groups on this. |
| `yokoten.event.previous_hash` | every event | 64 lowercase hex characters. |
| `yokoten.heartbeat.interval` | `yokoten.agent.start` and `yokoten.agent.heartbeat` | Seconds, a positive number, as `doubleValue`. |
| `yokoten.outcome` | `yokoten.agent.stop` and `yokoten.agent.refusal` | `done`, `failed`, `timed_out`, `stopped`, or `refused` on a refusal. |
| `gen_ai.operation.name` | `yokoten.agent.tool_call` | `execute_tool`. |
| `gen_ai.tool.name` | `yokoten.agent.tool_call`, when the tool has a name | The tool name. |

A first `yokoten.agent.start` looks like this.
The sample `timeUnixNano` is `2026-10-23T00:00:00Z`.
The sample is broken across lines so a person can read it.
The file keeps that object on one line.

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "yokoten" } }
        ]
      },
      "scopeLogs": [
        {
          "scope": { "name": "yokoten" },
          "logRecords": [
            {
              "timeUnixNano": "1792713600000000000",
              "observedTimeUnixNano": "1792713600000000000",
              "eventName": "yokoten.agent.start",
              "attributes": [
                { "key": "gen_ai.agent.name", "value": { "stringValue": "example-agent" } },
                { "key": "gen_ai.provider.name", "value": { "stringValue": "example-vendor" } },
                { "key": "gen_ai.request.model", "value": { "stringValue": "model-1" } },
                { "key": "yokoten.role", "value": { "stringValue": "engineer" } },
                { "key": "yokoten.issue", "value": { "stringValue": "1" } },
                { "key": "yokoten.worktree", "value": { "stringValue": "example-worktree" } },
                { "key": "yokoten.heartbeat.interval", "value": { "doubleValue": 60 } },
                { "key": "yokoten.event.previous_hash", "value": { "stringValue": "0000000000000000000000000000000000000000000000000000000000000000" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Who writes. Hooks, runners and controllers append one line.
A writer holds `.git/yokoten/events.lock`, appends that line, and releases the lock.
A writer does not change an earlier line.
The lock file is not a log line.
A controller does not write the status file.
Who reads. The status view reads the log.
The board, the timeline, the daily counts and provenance read it too.
The view reads the log and does not append to it.
How yokoten checks it. Each line must be one JSON object.
The first line's `yokoten.event.previous_hash` is 64 zeros.
Every later line stores the lowercase hex SHA-256 of the previous line's bytes, without the newline.
A mismatch means the history changed.
A missing required field fails the check.
An unknown `eventName` fails the check.
The code does not append this log yet.
`yokoten check --anchor` reads an existing log and its daily anchors in Rekor (#768).
Version 1. The log has no version field.

The hook that will append is [src/run/hook.ts](../src/run/hook.ts), and its test is [test/run/hook.test.ts](../test/run/hook.test.ts).

## The board feed

The board keeps a short list of what each agent just did.
This list is not a vendor transcript.
A vendor does not write it, and does not map a stream onto it.
The board builds the list in memory while `yokoten board` runs.
A restart starts from empty.

Each event has `kind`, `text` and `time`.
The board keeps at most `50` events for one agent.
The page folds a run of `step` or `pass` when that run has at least `3` events.
`wait`, `fail` and `done` stay as their own rows.
The newest event in a folded run still shows on its own.
The first sight of `waiting` or `done` adds no event.
An agent that leaves drops its feed.

| Kind | Text | When the board adds it |
| --- | --- | --- |
| `step` | the new `doing` | `doing` changed |
| `pass` | `Checks passed` | `checks` became `passing` |
| `fail` | `Checks failed` | `checks` became `failing` |
| `wait` | `Waiting for you` | the dot became `waiting` after the agent was already shown |
| `done` | `Finished` | the dot became `done` after the agent was already shown |

Who writes. The board process, while `yokoten board` runs.
Who reads. The board page, and `/data` through `feedsJson`.
How yokoten checks it. `recordFeed` compares the last view with the new one.
Version 1. The event has no version field.

Code: [src/commands/advice/board/feed/steps.ts](../src/commands/advice/board/feed/steps.ts) and [src/commands/advice/board/page/browser/script.ts](../src/commands/advice/board/page/browser/script.ts).
Tests: [test/commands/advice/board/feed/steps.test.ts](../test/commands/advice/board/feed/steps.test.ts) and [test/commands/advice/board/page/browser/script.test.ts](../test/commands/advice/board/page/browser/script.test.ts).

## A tool call

Every vendor sends a tool call in its own shape.
An adapter maps that call to one `Action`.
There is no shared list of tool names.
An `Action` has `command`, `commands`, `paths`, `cwd` and `worker`.
`command` is the shell text, when the call is a shell.
`commands` holds several shell texts, when one call carries more than one; the guard checks each on its own.
`paths` lists the files an edit would touch.
`cwd` is the folder, when the event names one.
`worker` is true when the call comes from a worker.
A record asked for one transcript for every vendor.
The code has no such mapper yet.
What the adapters share today is `Action`.

| Runtime | Names the hook watches | How a call becomes an Action | Fields the reader uses |
| --- | --- | --- | --- |
| `claude-code` | `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | The reader ignores the tool name. A `command` is a shell. A path is an edit. Copilot uses this reader. | `command`, `file_path`, `path`, `notebook_path`, `cwd`, `agent_type`, `tool_input` |
| `codex` | `Bash`, `apply_patch` | `Bash` is a shell. `apply_patch` is an edit. A shell that contains a patch is an edit too. | `command`, `tool_name`, `cwd`, `agent_type`, `tool_input` |
| `gemini` | `run_shell_command`, `write_file`, `replace` | The shell name is a shell. The edit names are edits. No desk runtime. | `command`, `file_path`, `tool_name`, `cwd`, `tool_input` |
| `antigravity` | `run_command`, `write_to_file`, `replace_file_content`, `multi_replace_file_content` | The shell name is a shell. The edit names are edits. No desk runtime. | `CommandLine`, `Cwd`, `TargetFile`, `name`, `args`, `toolCall`, `workspacePaths` |
| `muse` | `bash`, `write_file`, `edit_file`, `apply_patch` | The shell name is a shell. The edit names are edits. | `command`, `workdir`, `path`, `tool_name`, `cwd`, `tool_input` |
| `deepseek-harness` | `bash`, `pwsh`, `edit`, `write` | The reader is the Claude Code function. The matcher uses these names. | `command`, `file_path`, `path`, `notebook_path`, `cwd` |
| `grok` | `run_terminal_command`, `run_terminal_cmd`, `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `EditNotebook`, `search_replace`, `write`, `write_file` | Read-only names are neither: `read_file`, `grep`, `list_dir`, `web_search`, `web_fetch`, `todo_write`, `spawn_subagent`, `task`. Any other name with a file path is an edit, unless the name contains `__`. | `command`, `cwd`, `file_path`, `path`, `notebook_path`, `toolName`, `tool_name`, `toolInput`, `tool_input`, `subagentType` |
| `opencode` | every tool, through the plugin | A `command` or `code` is a shell. `filePath`, `path` or `file_path` is an edit. An action that is not read-only (`read`, `glob`, `grep`, `list`, `search`) and names no command and no path is refused. | `action`, `resources`, `metadata`, `tool`, `args`, `command`, `code`, `filePath`, `path`, `file_path` |

Who writes. The vendor agent, in its own event shape.
Who reads. The tool-call hook, after the adapter builds an `Action`.
How yokoten checks it. The guard checks `command` and `paths` before the tool runs.
Version 1. `Action` has no version field.

- [src/run/hook.ts](../src/run/hook.ts) and [test/run/hook.test.ts](../test/run/hook.test.ts).
- [src/commands/hook.ts](../src/commands/hook.ts) and [test/commands/hook.test.ts](../test/commands/hook.test.ts).
- [src/agents/runtimes/claude-code.ts](../src/agents/runtimes/claude-code.ts) and [test/agents/runtimes/claude-code.test.ts](../test/agents/runtimes/claude-code.test.ts).
- [src/agents/runtimes/codex.ts](../src/agents/runtimes/codex.ts) and [test/agents/runtimes/codex.test.ts](../test/agents/runtimes/codex.test.ts).
- [src/agents/runtimes/gemini.ts](../src/agents/runtimes/gemini.ts) and [test/agents/runtimes/gemini.test.ts](../test/agents/runtimes/gemini.test.ts).
- [src/agents/runtimes/small/antigravity.ts](../src/agents/runtimes/small/antigravity.ts) and [test/agents/runtimes/small/antigravity.test.ts](../test/agents/runtimes/small/antigravity.test.ts).
- [src/agents/runtimes/muse.ts](../src/agents/runtimes/muse.ts) and [test/agents/runtimes/muse.test.ts](../test/agents/runtimes/muse.test.ts).
- [src/agents/runtimes/small/deepseek-harness.ts](../src/agents/runtimes/small/deepseek-harness.ts) and [test/agents/runtimes/small/deepseek-harness.test.ts](../test/agents/runtimes/small/deepseek-harness.test.ts).
- [src/agents/runtimes/grok.ts](../src/agents/runtimes/grok.ts) and [test/agents/runtimes/grok.test.ts](../test/agents/runtimes/grok.test.ts).
- [src/agents/runtimes/small/opencode.ts](../src/agents/runtimes/small/opencode.ts) and [test/agents/runtimes/small/opencode.test.ts](../test/agents/runtimes/small/opencode.test.ts).

## The status file

The status file is a cache of one view of the event log.
There is one file per worktree, at that worktree's root.
The file name is `.yokoten-agent.json`.
`init` adds that name to `.gitignore`.
The file is not committed.
The log uses OpenTelemetry names.
The view's own states are `alive` and `outcome`.
The two states stay apart.
A `stale` agent can have no `outcome`.
An agent with an `outcome` can still be `alive`.
Only the view writes this file.
The code does not do that yet.
A missing log does not make the view create the file.
The view reads events whose `yokoten.worktree` is this worktree's folder name.
Events for another worktree do not change this file.
Each filled field uses the latest event that carries it.
A later timestamp in an earlier line does not win.

`alive` is absent when the agent has no `yokoten.agent.heartbeat`.
When it is present, it has `interval`, `beat` and `phase`.
`interval` is the `yokoten.heartbeat.interval` of the latest `yokoten.agent.heartbeat`, in seconds.
If that event has no interval, the view uses the interval from the latest `yokoten.agent.start`.
The view leaves `phase` absent when `interval` is missing or not positive.
The view writes `beat` as UTC text with no fractional seconds.
The form is the same as `updated`, such as `2026-10-23T00:00:00Z`.
`beat` is not `updated`.
`phase` is `alive` when the time since `beat` is at most twice `interval`.
`phase` is `stale` when the time since `beat` is more than twice `interval`.
A `beat` later than now is still `alive`.
`phase` is `gone` only when a controller sets a longer limit and the time since `beat` passes it.
This page does not set that limit.
Until a controller sets it, the view does not use `gone`.

`outcome` is absent when no event carries `yokoten.outcome`.
When it is present, it has `value` and `reason`.
`value` is that latest `yokoten.outcome`.
`reason` is that event's `body` string.
An empty body leaves `reason` empty.
`state` is not `alive`, and it is not `outcome`.

Until the code moves, the agent and the stop hook write the file as the rows below say.
After the move, only the view writes it.
The view then fills `alive`, `outcome`, `name`, `vendor`, `model`, `role` and `worktree` from the log.
An empty `gen_ai.agent.name` uses the worktree folder's name.
It then applies the `role` rule in the table.
It leaves `effort`, `task`, `doing`, `state`, `checks`, `blocked`, `question`, `link` and `updated` as the last writer left them.

A value that is not text becomes empty, except `alive` and `outcome`, which are objects or absent.
The board skips a file that is not a JSON object.

| Field | Who writes it | What is kept |
| --- | --- | --- |
| `alive` | the view, from `yokoten.agent.heartbeat` | A JSON object, or absent. `interval` is seconds. `beat` is UTC text. `phase` is `alive`, `stale` or `gone`. |
| `outcome` | the view, from `yokoten.outcome` | A JSON object, or absent. `value` is `done`, `failed`, `timed_out`, `refused` or `stopped`. `reason` is text. |
| `name` | the agent | text. A missing name becomes the worktree folder's name. |
| `vendor` | the agent | text |
| `model` | the agent | text |
| `effort` | the agent | text |
| `task` | the agent | text |
| `worktree` | the agent | text |
| `doing` | the agent | text |
| `log` | the agent | text. An absolute path to a plain text log inside the worktree or a runtime's log folder. The board reads it when it finds no session log. |
| `updated` | the agent, and the stop hook | text. The hook writes UTC time with no milliseconds, such as `2026-10-23T00:00:00Z`. |
| `started` | the agent | text, the same form as `updated`: when this work started. The board falls back to the file's birth time, then to `updated`. |
| `role` | the agent | `lead`, `engineer`, `reviewer`, `verifier` or `helper`. Any other word, including `worker`, becomes empty. |
| `state` | the agent | `working`, `waiting` or `done` |
| `checks` | the stop hook | `passing` or `failing` |
| `blocked` | the agent | text. The board keeps the first line, at most `140` characters, as kind `guard`. |
| `question` | the agent | text. The board keeps the first line, at most `140` characters, as kind `question`. |
| `link` | the agent | only `http://` or `https://`. Anything else is dropped. |

The board row also keeps `kind` and `why`.
`why` is that first line.
The dot beside an agent is `working`, `waiting`, `failing`, `idle` or `done`.
`done` and `waiting` come from `state`.
`failing` comes from `checks`.
Any other `updated` time within `15 minutes` shows `working`.
A missing or invalid `updated` time shows `idle`.
Quiet for `15 minutes` shows `idle` only when `state` is not `done` or `waiting`, and `checks` is not `failing`.
These dot rules are what the board does today.
The dot does not read `alive` or `outcome` yet.

The stop hook writes `checks` and `updated` only in a linked worktree.
The main checkout is left unchanged.
There, `.git` is a directory.
Other fields stay when the file is a JSON object.
A file that is not JSON, and is small enough to read, is replaced by `checks` and `updated` only.

The hook reads at most `64 KiB` (`65536` bytes).
A bigger file is `too large`, and is left unchanged.
A symlink gets the warning `is not a regular file, so it was left unchanged`.
A file that cannot be opened is `cannot be read`, and is left unchanged.
A file that changes during the read is `changed while it was read`, and is left unchanged.
The warning is one line on stderr.
It never includes the file text.
The hook writes by a temp file and a rename, so a new symlink is replaced and not followed.

The board's own read follows a symlink.
That read has no size cap.

Who writes. Only the view writes this file.
The code does not do that yet.
Today the agent writes the file, and deletes it to leave.
The stop hook writes `checks` and `updated` in a linked worktree.
A controller does not write this file.
Who reads. The lead, and the board.
How yokoten checks it. The view is rebuilt from the log.
A broken hash leaves the file unchanged.
The hook, today, refuses a non-file, a file over the cap, a file it cannot read, and a file that changes while it is read.
The board skips a missing, broken or non-object file.
Version 1. The file has no version field.

- [src/run/hook.ts](../src/run/hook.ts) and [test/run/hook.test.ts](../test/run/hook.test.ts).
- [src/commands/hook.ts](../src/commands/hook.ts) and [test/commands/hook.test.ts](../test/commands/hook.test.ts).
- [src/commands/advice/board/agents.ts](../src/commands/advice/board/agents.ts) and [test/commands/advice/board/agents.test.ts](../test/commands/advice/board/agents.test.ts).
- [src/commands/advice/board/controls.ts](../src/commands/advice/board/controls.ts) and [test/commands/advice/board/controls.test.ts](../test/commands/advice/board/controls.test.ts).
- [src/commands/advice/board/view.ts](../src/commands/advice/board/view.ts) and [test/commands/advice/board/view.test.ts](../test/commands/advice/board/view.test.ts).

## The Made-with line

The last non-blank line of a pull request body is the Made-with line.
HTML comments and code fences are blanked first.
An unclosed comment hides the rest of the body.
The line starts with `Made with`, after an optional robot mark.
Parts are separated by commas.
Role words ignore case.
Extra spaces count as one.
A pair is one `vendor` and one `model`, written as `example-vendor (model-1)`.
`worker (model-1)` has no vendor, so both words land in `others`.
The same is true of `lead (model-1)`.
At most two reviewers are kept.
A bad `reviewed by` part fails even when another part is also bad.
Text after the line fails the check.
Two workers on different models are both kept.

| Part | Lands in |
| --- | --- |
| `worker example-vendor (model-1)` | `writers` |
| `reviewed by example-vendor (model-1)` | `reviewers` |
| `reviewed by example-vendor (model-1) and example-vendor (model-2)` | `reviewers`, two at most |
| `lead example-vendor (model-1)` | `leads` |
| `example-vendor (model-1)` | `others` |

`worker` and `lead` are the role words.
The reviewer words are `reviewed by`.

`gh pr create` and `gh pr edit` check the whole body, including this line.
A comment, a review with a body, and a new issue check this line only.
`gh issue edit` is not checked here.
`--attach` on those notes is refused, because the upload would land after the line.
Dependabot gets a note for a bad line, not a failure.
The finding id is `pr-made-with`.

Who writes. The author of the body.
Who reads. The pull request check, and `yokoten bot`.
How yokoten checks it. `parseMadeWith` reads the last line. `madeWithFindings` reports `pr-made-with` when the line is missing or the reviewers are wrong.
Version 1. The line has no version field.

- [src/rules/pr.ts](../src/rules/pr.ts) and [test/rules/pr.test.ts](../test/rules/pr.test.ts).
- [src/commands/merge/bot.ts](../src/commands/merge/bot.ts) and [test/commands/merge/bot.test.ts](../test/commands/merge/bot.test.ts).

## Provenance

The Made-with line is the first form of provenance.
It names who wrote and who reviewed.
Provenance also reads the event log.
The code does not read the log yet.
It is not a full bill of materials.
The approver is not a field on the line.

| Role | Where yokoten reads it |
| --- | --- |
| Writer | `writers`, from `worker` plus a `vendor` and a `model` |
| Reviewer | `reviewers`, at most two, from `reviewed by` |
| Approver | the owner's Approve on the host. Not on the line. Tier A only. |
| Lead | `leads`, from `lead` plus a vendor and a model. A lead is not the approver. |
| Other | `others`, a pair with no role word |

Who writes. The pull request author writes the line. The owner writes the Approve on the host.
Who reads. The pull request check, and a person reading the body.
How yokoten checks it. The Made-with check names writers and reviewers. For tier A, `checkApprovalFreshness` requires an owner Approve on the head, or only base merges after it with the same own diff. The finding id is `pr-approve`. Tier B and tier C are not gated there.
Version 1. This is the first form. It has no version field.

- [src/rules/pr.ts](../src/rules/pr.ts) and [test/rules/pr.test.ts](../test/rules/pr.test.ts).

## The risk tier

The first non-blank line of a pull request body is one tier line.
The letter is a capital.
Nothing else is on that line.

| Line | What the finding text says it means |
| --- | --- |
| `tier: A` | secrets, data, install, releases, and files CODEOWNERS owns |
| `tier: B` | other code |
| `tier: C` | docs and wording |

A label may be written `tier A`, `tier: A` or `tier:A`, in any case.
Exactly one tier label must match the line.
That check's id is `pr-labels`.
A missing line is `pr-tier`.

CODEOWNERS sets a floor of A only.
`tier: B` or `tier: C` fails when a changed file has owners.
That finding is `pr-owned`.
The author may raise the line to `tier: A`.
The check does not reject `tier: C` on source code that CODEOWNERS does not own.
No CODEOWNERS file means this floor is not applied.
In CI, CODEOWNERS is read from the base branch.
On a local run, it is read from the working tree.

The tier used for the Approve gate is A when the body or any tier label says A.
Otherwise it is the body line, then the first tier label.
An issue needs a tier label only when the repo already has tier labels.

Who writes. The pull request author.
Who reads. The pull request check, the bot, and the board.
How yokoten checks it. `checkPullRequestBody` requires the line. `checkTierLabel` requires one matching label. `checkOwnedTier` requires A when a changed file has owners. `checkApprovalFreshness` gates a merge of tier A.
Version 1. The line has no version field.

- [src/rules/pr.ts](../src/rules/pr.ts) and [test/rules/pr.test.ts](../test/rules/pr.test.ts).

## The desk

A desk is the worker's own clone, plus a fence around the agent.
Child processes and pipes work.
The desk runs the command the lead gives.
It does not add flags of its own.
A symlink is refused on `.git`, `.git/config`, `.git/hooks`, `.git/yokoten-worker` and the state folders.
On a team, the team folder is read-only, and only that agent's outbox is writable.

| Field | What the agent gets |
| --- | --- |
| `desk` | The clone is writable, including `.git`. It must be a git clone, not a worktree. |
| `state` | The state folder next to the desk is writable. Only the login file is copied in. The lead's state stays hidden. |
| `readable` | Shown again, read-only: Node, the agent program, `bin`, `src`, `kit`, `dist`, `package.json`, `.gitconfig` and `.config/git`. `--read` adds paths. `--marks` shows the private marks file. |
| `hidden` | When they exist: `/home`, `/root`, `/mnt`, `/media`, `/run`, plus home and the desk's parent. On `darwin`: `/Users`, `/Volumes`, plus home and the parent. |
| `locked` | `.git/config`, `.git/hooks` and `.git/yokoten-worker` stay read-only. On a team, `.git/yokoten-desk.json` is locked too. |
| `hosts` | API hosts only, through a proxy that runs outside. CONNECT only. Port `443`, unless the host entry names a port. At most `64` tunnels. A quiet tunnel closes after `10 minutes`. The proxy does not read the tunnel. |
| `env` | `YOKOTEN_ROLE` is `worker`. `TZ` is `UTC`. A team also sets `YOKOTEN_DESK` and `YOKOTEN_TEAM`. |
| `command` | The command the lead passed. |

`/run` is hidden because sockets there can start programs outside the fence.

A desk starts `claude-code`, `codex`, `grok` or `muse`.
DeepSeek runs through `codex`.
The runtime id `deepseek-harness` has no desk of its own.
`gemini` and `antigravity` have no desk runtime.
An unknown runtime is refused.

- `claude-code` may reach `api.anthropic.com` and `platform.claude.com`.
- The login file copied in is `.credentials.json`.
- `CLAUDE_CONFIG_DIR` points at the desk state.
- A new state writes `.claude.json` as `{"hasCompletedOnboarding": true}\n`.
- The lead folders `.claude` and `.claude.json` stay hidden.
- The login names `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are passed.
- `codex` may reach `api.openai.com` and `api.deepseek.com`.
- The login file copied in is `auth.json`.
- `CODEX_HOME` points at the desk state.
- The lead folder `.codex` stays hidden.
- The login names `OPENAI_API_KEY` and `CODEX_API_KEY` are passed.
- `chatgpt.com` and `auth.openai.com` are not default hosts.
- The lead adds them with `--host` when a ChatGPT login needs them.
- `grok` may reach `api.x.ai`.
- The login file copied in is `auth.json`.
- `GROK_HOME` points at the desk state.
- The lead folder `.grok` stays hidden, except the read-only program folder `.grok/bin`.
- The login names `XAI_API_KEY` and `GROK_API_KEY` are passed.
- `muse` may reach `api.meta.ai`.
- The copy target from the state root is `config/muse/auth.json`.
- Under `XDG_CONFIG_HOME` that same file is `muse/auth.json`.
- `XDG_CONFIG_HOME` points at the state's `config` folder.
- `XDG_DATA_HOME` points at the state's `data` folder.
- The lead data folder `.local/share/muse` stays hidden.
- The login name `MODEL_API_KEY` is passed.

A runtime's own login names skip the secret filters.
Any other name is dropped when it contains `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD`, `AUTH`, `CREDENTIAL` or `PRIVATE`.
A value longer than `32 KiB` is dropped.
A value shaped like a token is dropped.

The backend sets `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY`.
It sets the same three names in lower case.
It sets `NODE_USE_ENV_PROXY`.
`NO_PROXY` and `no_proxy` are set empty.

Linux and WSL2 use `bwrap`.
macOS uses `sandbox-exec`, and the profile denies by default.
Native Windows has no desk backend.

Who writes. `planDesk` builds the plan. The agent writes only inside the writable folders.
Who reads. The desk backend. The agent sees the fence, not the plan object.
How yokoten checks it. `planDesk` throws for an unknown runtime, a folder that is not a clone, or a path that would open a hidden folder. The proxy refuses anything that is not CONNECT to an allowed host.
Version 1. `DeskPlan` has no version field.

- [src/agents/desk/desk.ts](../src/agents/desk/desk.ts) and [test/agents/desk/desk.test.ts](../test/agents/desk/desk.test.ts).
- [src/agents/desk/agent-env.ts](../src/agents/desk/agent-env.ts) and [test/agents/desk/agent-env.test.ts](../test/agents/desk/agent-env.test.ts).
- [src/agents/desk/network/proxy.ts](../src/agents/desk/network/proxy.ts) and [test/agents/desk/network/proxy.test.ts](../test/agents/desk/network/proxy.test.ts).
