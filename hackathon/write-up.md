# yokoten · a safety net for a team of one

Meta Global AI Developer Hackathon · Indie Dev track · 2026-11-04

## Short description (for the form)

yokoten gives every AI coding agent the same rules, stops a risky action before it
runs, and carries a lesson from one project to the next. One command installs it. It
works with the agents you already use.

## The problem

One person can now run a team of AI agents. The agents are fast. The habits of a team
are not included.

A team catches a test that was edited until it passed. It catches a force push that
erased a commit. It writes down why a rule exists, and it tells the next project. A
person alone, with eight agents and a deadline, may not.

The result is a new kind of accident: the code looks finished, the checks are green,
and the reason nobody caught the mistake is that nobody was there to catch it.

## What yokoten is

yokoten is a safety net for that person. It adds three things on top of the agents you
already use, and it does not replace them:

1. **One set of rules for every agent.** A guard checks each command and edit before
   it runs. It stops a force push, a release tag, a skipped commit check, a test edited
   in a fix task, and a secret or private detail in what an agent posts. It tells the
   agent why, and what to do instead.
2. **A road with one next step.** `yokoten doctor` reads the project and names the one
   thing to do next. The road has five stages: safety net, issues and pull requests,
   release, a team of agents, and going public. A session hears the stage and one step
   at its start, so the agent brings the habit up for you.
3. **A lesson that spreads.** When one project learns something the hard way, an
   incident becomes a check. A person reviews the check, ships it to the kit, and the
   next project's `doctor` already knows it. That is *yokoten* (横展): what one line
   learns, every line gets.

## Why it is different

- **It is cross-vendor.** The guard runs in Claude Code, Codex CLI, GitHub Copilot
  CLI, Antigravity CLI, Muse Code, DeepSeek Harness and Grok CLI. Each agent keeps its
  own sandbox and settings; yokoten adds the rules on top.
- **It uses the agent's own hooks.** No proxy, no wrapper, no new editor. If the agent
  can run a command, yokoten can check it first.
- **Every rule has a reason and a check.** A rule without a check is a wish. The
  reasons are public, and so are the tests that hold them.
- **The guard is on from the first command.** There is no setup question and no
  per-project policy to write before the first protection works. The safe action is
  the default; every setting has a way back.
- **It is open.** MIT licence, no runtime dependencies, and the whole history is in
  the repo.

## How it works

1. `npx yokoten install` adds the user-level hooks once per computer.
2. `npx yokoten init` writes the project rules, the commit check, and the settings for
   each agent the machine has.
3. Before every tool call, the guard reads the command or edit. It allows it, asks, or
   refuses it and prints four lines: what was stopped, why, the fix, and the rule id.
4. Before every commit, the same rules run again. CI runs them a third time, so a
   commit made without the hook still stops.
5. `yokoten doctor` reads the files each time and shows the road. A step you mark "not
   now" is skipped, with your reason.

The guard is the part a person can trust on day one. The board and the desk are on
`main` and come to npm with the next release.

## What was built during the contest

yokoten began before the contest. The public history shows the date of every change.
The contest work turned the code into a product a beginner can start:

- **Release 0.1.0, on 2026-10-21.** The first release: one install, five protections,
  the commit check, `doctor`, and the five-stage road.
- **The README and the site.** The first screen says what yokoten is, shows the guard,
  and gives the install commands.
- **The safeguard as the MVP.** Record 0035 sets the order: the smallest excellent
  safeguard first, tested under different agents.
- **This submission kit.** The demo script, the recording plan, the write-up, and the
  final check.

The board and the desk were built earlier and are on `main`. They come to npm with the
next release. Nothing here is presented as new if it is older; the history is public.

The owner confirms the official window before submitting. If a rule counts only work
inside the window, move an item to the "before" list. Do not move it the other way.

## What is next

- Make the first protection excellent: one install, five protections, a refusal a
  beginner understands, and a test under each agent (issue #816).
- Bring the board and the desk to npm.
- Translate the CLI output, after the hackathon.
- Grow the lesson network: a lesson one project ships reaches every project that runs
  that yokoten.
- Add spending caps and a record a team can audit.

## Try it

```sh
npx yokoten install      # once per computer
cd your-project
npx yokoten init         # once per project
npx yokoten doctor       # where you are, and the one next step
```

No account. No runtime dependency. Node 22.23.4 or later.

## Links

- Repo: <https://github.com/yokoten-labs/yokoten>
- Site: <https://yokoten.app>
- npm: <https://www.npmjs.com/package/yokoten>
- Release notes: <https://github.com/yokoten-labs/yokoten/releases/tag/v0.1.0>
- Guide: <https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md>
- The why, in records: <https://github.com/yokoten-labs/yokoten/tree/main/docs/records>

## Limits, said plainly

- yokoten is not a sandbox and not a model. It uses the sandbox the agent already has.
- It cannot see what a package script does. When a script is not on the list, it asks.
- Gemini CLI is listed but not verified end to end. The other seven agents are.
- The board and the desk are on `main`, not in the npm release.
- A guard lowers the chance of an accident. It does not make one impossible.

## Team

Built by the owner and a mixed-vendor agent team: Claude, Codex, DeepSeek, Grok, Muse
and Qwen. The owner decides what ships. Agents write, review and test; a person signs
the release.

Read more: the [manifesto](https://github.com/yokoten-labs/yokoten/blob/main/docs/assets/manifesto.md)
and the [guide](https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md).
