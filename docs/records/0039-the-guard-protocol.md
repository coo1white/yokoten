# 0039 The guard protocol, version 1

Status: accepted
Date: 2026-10-24 (UTC)

## Context

The guard reached an agent only through an adapter yokoten wrote, one per runtime. A tool
with no adapter fell back to the sandbox, the commit check and CI. The owner decided to
make the guard callable by any tool on its own: one published protocol, so a toolkit adds
the hook itself and yokoten writes nothing for it.

This record is also the spec. It holds the decision and the version-1 shape, so a tool
reads one page. The shared data shapes keep their page, [standard.md](../standard.md).

## Decision

1. **One fixed call.** The tool runs `yokoten hook --protocol` and sends one JSON object:
   the action (`tool`, `command`, `commands`, `paths`, `cwd`), the claimed `role`, and the
   absolute `project` folder. The shape is version 1, named `yokoten-guard/1`.
2. **One fixed answer.** yokoten sends one JSON object with `allow`, `refuse` or `ask`.
   A refusal or a question carries a reason with the rule id, the four-part text, why, fix
   and docs. `allow` and `ask` exit 0; `refuse` exits 2.
3. **The version is in every message.** yokoten refuses a version it does not read, and
   ignores a field it does not know, so a later version stays compatible.
4. **The guard is unchanged.** The protocol adds a doorway, not a rule. It calls the same
   `judge`, with the same config and the same deadline.
5. **One adapter goes first.** The OpenCode plugin sends the protocol end to end: its
   event becomes an action, the answer's decision and text reach the agent. The other
   adapters keep their own shapes until a later change.
6. **The test is published.** `CONFORMANCE_CASES` and `checkGuardIntegration` in
   [src/run/protocol.ts](../../src/run/protocol.ts) are the cases any toolkit runs against
   its integration. They need no repo, no home folder and no network.

## The call

The tool runs `yokoten hook --protocol` and writes one JSON object on stdin. The name and
version are `yokoten-guard/1`.

| Field | Type | Meaning |
| --- | --- | --- |
| `protocol` | string | Always `yokoten-guard/1`. |
| `action.tool` | string, optional | The tool's own name, such as `shell` or `edit`. Kept for the stop log. |
| `action.command` | string, optional | One shell command, as the agent wrote it. |
| `action.commands` | string list, optional | Every command on one call. The guard refuses when any entry is refused. |
| `action.paths` | string list, optional | The files an edit touches, from `project`. |
| `action.cwd` | string, optional | The folder the action runs in. Defaults to `project`. |
| `role` | `lead` or `worker` | The role the tool claims. yokoten still reads a worker mark itself. |
| `project` | string | The project's folder, absolute: the repo root, or the folder outside a repo. |

A call needs a command, a list of commands, or a list of paths. yokoten ignores a field it
does not know, so a later version can add one. yokoten refuses a call with another version,
and never guesses what it means.

```json
{
  "protocol": "yokoten-guard/1",
  "action": { "tool": "shell", "command": "git push --force origin main" },
  "role": "lead",
  "project": "/srv/example/project"
}
```

## The answer

yokoten writes one JSON object on stdout. The version is the same one it read.

| Decision | What the tool does | Exit code |
| --- | --- | --- |
| `allow` | Run the action. | 0 |
| `refuse` | Do not run it. Show `reason.message` to the agent. | 2 |
| `ask` | Ask the owner. The guard does not refuse. A tool with no question may run it. | 0 |

`reason` is there when the decision is `refuse` or `ask`:

| Field | Meaning |
| --- | --- |
| `id` | The rule id, as `yokoten explain` knows it. |
| `message` | The answer as one text, ready to show. It has the four parts: title, why, fix, more. |
| `why` | Why it matters, as one sentence. |
| `fix` | The safe way, as one sentence. |
| `docs` | Where the rule is explained in full. |

A call yokoten cannot read is refused with the id `unreadable-protocol`. The tool asked
for the guard by name, so silence is never an allow.

## How a tool sends it

1. Start one process for one action. Run the yokoten the project installed
   (`.yokoten/bin/yokoten.mjs`) or the one on `PATH`.
2. Write the call on stdin and close it. Read stdout to its end.
3. Read the decision from the JSON. Do not read stderr: it holds warnings only.
4. A crash, a signal, a timeout, or another version means refuse.

A tool that cannot ask the owner treats `ask` as `allow`, and shows `reason.message`. The
answer is still the truth; the owner decides when the tool can ask.

## The conformance test

Every integration runs the same four cases. They need no repo, no home folder and no
network.

| Case | Expected |
| --- | --- |
| `git status` | `allow` |
| `git push --force origin main` | `refuse`, id `force-push` |
| `git push origin --tags` | `refuse`, id `release` |
| `git commit --no-verify -m x` | `refuse`, id `skip-check` |

```ts
// Any language, the same loop: send each call above, and compare the decision and the id.
for (const item of cases) {
  const answer = await myGuardCall(item.input);
  if (answer.decision !== item.decision) failures.push(item.name);
}
```

In this repo, `checkGuardIntegration` in [src/run/protocol.ts](../../src/run/protocol.ts)
takes that function. It returns one line per failure, so an empty list means the
integration conforms.

yokoten's own test is [test/run/protocol.test.ts](../../test/run/protocol.test.ts). It
runs the cases through the command line, and through the OpenCode plugin as one end-to-end
example. Run it with:

```
nice node --test --test-concurrency=4 test/run/protocol.test.ts
```

## Not in version 1

- **No rewrite.** A tool either runs the action as written or refuses it.
- **No end of turn.** The stop check has its own flag and shape.
- **No runtime name.** A refusal names no agent, so the release fix is the general one.
- **No session id.** The repeat-stop breaker counts only for the adapter hooks.

## Options not taken

- **A new command, `yokoten guard`.** The hook already reads one tool call, starts its
  worker early and exits 2 on a refusal. A flag keeps one entry point, one help page and
  one fast path.
- **A vendor field.** The issue names the action, the role and the project. A vendor name
  would bring the release fix back, and the first version is simpler without it.
- **A separate spec page.** The conformance test counts the shapes on that page
  and keeps its Chinese copy in step. This record is shorter to read and to version.
- **Converting every adapter now.** That is a large change with no new rule to show for
  it. One adapter proves the protocol end to end, and the test guides the rest.

## Consequences

- A new tool adds a hook without a change in yokoten, if it can send JSON and read JSON.
- The OpenCode plugin now sends a role, because the protocol has no process environment.
  A worker mark still wins, so a marked worktree stays a worker.
- Version 1 does not rewrite a command and does not see the end of a turn. A tool that
  needs redaction gets a refusal, not a wrapped command.
- The repeat-stop breaker counts only for adapter hooks, because version 1 has no session
  id.
- `src/run` was full at seven entries, so its two note modules moved together into
  `src/run/notes/` to make room for the protocol module.
