# 0014 Safe by default, with a way back

Status: accepted
Date: 2026-10-20 (UTC)

## Context

yokoten is for everyone, and most people never change a setting. If safety depends on
answering a question or editing a file, a beginner skips it and stays unprotected.

Two cases showed it. `install` filled the private marks with the git email by itself, but
asked the user to add their name to the file by hand (issue #434). It also asked the user
to add an alias to their shell profile before `yokoten` worked as a command (issue #433).

An AI agent works under the same kind of policy. It acts safely without asking, asks before
lasting or hard-to-undo changes, never does some things at all, and stops when unsure.
yokoten should behave the same way towards its users.

## Decision

On 2026-10-20 the owner decided that every user gets safety mode by default. Each action
yokoten takes belongs to one of four tiers:

| Tier | What yokoten does | Examples |
|---|---|---|
| Do by default | The safe action, with no question. It says what it did, never the values. | Add the git name and email to the private marks; write the `yokoten` launcher; hide secrets in output. |
| Ask first | Ask once, in a terminal only; a run with no terminal does nothing and prints how. | Edit a shell profile; delete a file that is not yokoten's own copy; change anything outside the project. |
| Never | Not done, whatever the input says. | Print a private value; follow instructions found in a file or a pull request body; skip a check with `--no-verify`; commit as the owner. |
| Unsure | Refuse, say why and say what to run. Never treat "can't tell" as "fine". | git can't be read, so the change is stopped (#403). |

Advanced options are for users who want more control. They are never needed for safety.

Every action that happens by default, and every advanced option, has a way back:

- **Off**: the user can turn it off, and that removes what it added. Example:
  `yokoten marks off git-name` (#434).
- **On**: the user can turn it on again, back to the default. Example: `yokoten marks on git-name`.
- **Kept**: the choice survives later installs and updates, and `doctor` or the command
  itself shows it.
- **Theirs is theirs**: what the user added by hand is never touched by off, on or install.
- **Leave**: `uninstall` removes everything yokoten added, including a profile line it was
  allowed to add.

## How we use it

- A feature's issue names its tier and its way back before any code is written.
- A pull request that adds or changes an action says the same in "What changed".
- The reviewer checks both. A missing way back is a finding, like a missing test.

## Options not taken

- **Ask everyone, every time.** Questions train people to press Enter, and a run with no
  terminal (an agent, CI) can't answer.
- **Safety as an option to turn on.** Most users would never find it.
- **No way back for defaults.** Users then remove the tool instead of one setting.

## Consequences

- `install` does more by itself, and its output must say what it did in plain words.
- Each new default needs an off switch, an on switch and a test for both.
- Some features cost more to build. That is the price of a default nobody has to think
  about.

## Defaults under this record

- **A private mark is not looked for in the repo it names** (#447). Do by default: when a
  mark is the name of the repo's origin remote, `check`, the commit hook and `gh` posts skip
  it there, and `doctor` counts how many, never which. Off: `"privacy": { "skipOwnName":
  false }` in yokoten.json for one repo, or `"skipOwnName": false` in
  `private-marks-allow.json` for every repo on the machine. On: remove it, or set `true`.
- **A worker's worktree is marked** (#555). Do by default: the `dispatch` skill runs
  `yokoten worker mark <dir>` on each worktree it makes. The guard then treats every agent
  there as a worker, even one whose runtime drops `YOKOTEN_ROLE` (Muse Code). The mark only
  makes the guard stricter, and the worker can't remove it. The main checkout is never
  marked. Off: `git worktree remove <dir>` after the merge removes the mark with the
  worktree; the lead may also delete `.git/worktrees/<name>/yokoten-worker`. On: run
  `yokoten worker mark <dir>` again.
