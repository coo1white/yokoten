# Demo video script

Target: 2:40. Hard ceiling: 3:00. If the contest allows 60 seconds or less, record
the 42-second cut at the end of this file.

The existing 42-second tour is the short terminal sequence: a force push is stopped,
then `doctor` shows stage 1 of 5. This script keeps those two beats in the same order
and builds the lesson and the close around them. If the recorded tour lives outside
this repo, its shots replace Act 2 and Act 4; keep the order.

## The promise to the viewer

One person can now run a team of AI agents. yokoten gives that team the habits it
would have if a whole company were watching: one set of rules, a guard that stops a
risky action, a road with one next step, and lessons that spread.

## Script

### Act 1 · The problem (0:00–0:35)

**Picture.** A dark terminal, a cursor. Cut to a diff where a test changes and passes.

**Voice.**
> One person can now run a team of AI agents. What is harder to add is a team's habits.
>
> At 1 a.m., an agent fixes a failing test by editing the test. It passes. The bug stays.
> Another agent force-pushes `main`. Nobody sees the commit it erased.
>
> A team catches these. A person alone, with eight agents, may not.

**On screen.** `1 a.m. · one person · eight agents` then `the test passes · the bug stays`.

### Act 2 · The guard (0:35–1:05)

**Picture.** Claude Code session in `cart-lab`. The agent types
`git push --force origin main`. The hook refuses before the command runs. Hold on the
four lines for two seconds each.

**Voice.**
> yokoten runs before the command. This one is a force push.
>
> The guard stops it. It says what happened, why it is dangerous, and what to do
> instead: use `--force-with-lease`.
>
> The agent reads the rule, not just the refusal, and keeps working.

**On screen.**
```
yokoten: git push --force forces the push.
Why: a plain force push can throw away work that someone else pushed.
Fix: use --force-with-lease, which stops when the remote has work you have not seen.
Rule: no plain force push (core rule 7)
```

The exact output comes from the real hook. Do not stage a message the hook would not
print. If the wording has changed, record the current wording.

### Act 3 · The same rules, every agent (1:05–1:30)

**Picture.** Split screen or a fast cut: Claude Code, then Muse Code or Codex doing an
edit in a fix task. The second agent is refused when it tries to change the test.

**Voice.**
> The same rule runs in Claude Code, Codex, Copilot, Antigravity, Muse, DeepSeek and
> Grok. Seven agents, each in its own sandbox.
>
> yokoten does not replace the agent. It adds the habits the agent did not bring.

**On screen.** A row of agent names, then `one set of rules`. Do not say "every agent":
Gemini CLI is listed but not verified end to end.

### Act 4 · Doctor and the road (1:30–1:55)

**Picture.** Plain shell. Run `npx yokoten doctor`. The screen shows stage 1 of 5 and
one next step. Then a clean table of the five stages.

**Voice.**
> Then `yokoten doctor` shows where the project stands: stage one of five, the safety net.
>
> It names one next step, not twenty: the one thing this project needs next.
>
> The stages are the habits of a good team: safety, issues and pull requests, release,
> a team of agents, going public.
>
> A beginner walks the road. An agent reads the same road at the start of every session.

**On screen.**

| Stage | What it adds |
|---|---|
| 1 · Safety net | rules, guard, commit check, tests |
| 2 · Issues and pull requests | one issue per task, a template, labels |
| 3 · Release | changelog, pull request titles |
| 4 · A team of agents | sandbox, bot, review |
| 5 · Going public | security files, branch and tag rules |

### Act 5 · The lesson spreads (1:55–2:20)

**Picture.** `node scripts/demo/loop.ts` in a wide terminal, slowed in the edit. It
shows one incident, a drafted check, a reviewer, the ship, and `doctor` in a second
project with the new note.

**Voice.**
> Here is the part I care about. One project learns something the hard way. yokoten
> turns the incident into a check, a person reviews it, and the check ships to the kit.
>
> The next project runs `doctor`, and the lesson is already there. That is yokoten:
> 横展. What one line learns, every line gets.

**On screen.** `one incident → one check → every project`, then 横展.

The loop script runs in about a second. Record it, then slow the useful frames in the
edit. Do not fake a terminal that scrolls too fast to read.

### Act 6 · Close (2:20–2:40)

**Picture.** Back to the guard's four lines, then the site and the repo on screen.

**Voice.**
> One person, with a company's discipline. The guard is on from the first command, and
> the road is free and open.
>
> `npx yokoten install`. The link is below.

**End card.**

```
yokoten · 横展
Every AI agent. One set of rules.
yokoten.app
github.com/yokoten-labs/yokoten
npm i yokoten
```

## The 42-second cut

Use this when the limit is 60 seconds or less, or as the social cut.

| Time | Picture | Voice |
|---|---|---|
| 0:00–0:06 | Terminal, cursor | One person can now run a team of AI agents. What is missing is the team's habits. |
| 0:06–0:18 | `git push --force` refused | The guard stops the force push, says why, and gives the fix: `--force-with-lease`. |
| 0:18–0:28 | `yokoten doctor` | `doctor` shows stage 1 of 5 and names one next step. |
| 0:28–0:36 | `loop.ts`, then project B | One project's lesson becomes a check every project gets. That is yokoten. |
| 0:36–0:42 | End card | `npx yokoten install`. The link is below. |

## Words to use and words to avoid

Use: guard, rule, why, fix, one next step, five stages, lesson, every project, open,
free, MIT.

Avoid: "revolutionary", "seamless", "AI-powered", "10x", "replaces your team",
"guaranteed", "every agent", "100% safe". The video shows a real refusal, not a
promise.

## Captions

Write the English captions first. Then Chinese (Simplified and Traditional) and
Japanese, because the README and the guide already have those languages. A judge who
watches muted must still follow the story. Check the captions for private details as
carefully as the picture.

## Checks before the edit is called done

- The force push is a real refusal from the current hook, not a mock.
- The command on screen is the command in the caption.
- `doctor` output is from a clean demo repo, with no home path or hostname.
- The five stage names match the guide.
- The loop shows a real check, a real ship, and a real `doctor` note.
- Every number (seven agents, five stages, two minutes) is true on the day.
- The end card links work.
