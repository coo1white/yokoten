# 0021 AI checks AI: no agent writes, reviews and merges its own work

Status: accepted
Date: 2026-10-23 (UTC)

## Context

Three records now say what yokoten is, one layer each:

1. [0015](0015-a-framework.md): **how**. A framework that gives anyone the whole method,
   free to change, still updated.
2. [0020](0020-rules-the-employer-owns.md): **whose**. The rules belong to the people who
   use the agents, and hold for every vendor.
3. This record: **what holds it together** when agents from many vendors work on one
   project.

On 2026-10-23 one day of work showed why a third layer is needed:

- A Claude worker reviewed a DeepSeek commit for issue #616 and found four problems. One
  was a privacy hole: an inline ignore comment in a `gh` post let an email address
  through. The commit also left four tests failing that had never been run.
- A Grok worker, in its own report for issue #650, said that the guard let every `gh`
  command through when its GitHub rules had not loaded. The lead made the guard refuse
  instead.
- On the Mac, the desk for issue #637 stopped `git commit` in a way no Linux test could
  show. A second machine found it.

Each of these was caught by someone other than the one who made it. A model that reviews
its own work shares its own blind spots. A 2026 study of code vulnerability detection
found that a verifier from a different model family raised precision compared with
checking by the same model (arXiv 2604.21282).

Others who run many agents report the same shape. Cursor found that agents of equal rank
sharing a file with locks slowed twenty agents to the output of two or three, and that
planners, workers and a judge worked better. Its single integrator agent became a
bottleneck. Gas Town lets no worker push to main. Every change goes through a merge
queue that runs the checks first.

The owner cannot read every line that twenty agents write. Oversight has to come from
how the work is split, not from more reading.

## Decision

On 2026-10-23 the owner set yokoten's north star: **separation of powers between AIs.**
No agent writes, reviews and merges its own work, and a person decides.

1. **Three hands on every change.** One agent writes. An agent from another vendor
   reviews. The bot merges only when every check is green and the owner has approved
   where the tier asks for it. No agent approves.
2. **Reviews cross vendors.** Where a project uses three or more vendors, the first and
   second review come from two vendors, neither of them the writer's. With fewer vendors,
   yokoten says on the pull request that the review stayed within one vendor.
3. **Security work gets the strongest reviewer.** A change to security, privacy or the
   guard is reviewed by the strongest model on hand, today Claude Opus. This rule does not
   rotate.
4. **Every role is on the record.** A pull request names the vendor and model that wrote
   it and the ones that reviewed it. The track record in 0020 then counts each model by
   role: how often its work passed review, and how much its reviews found.
5. **Work goes by record, not by quota.** Once the record exists, a task goes to the
   model whose record fits it best, within the owner's spending limits.
6. **Paid on green, later.** Where agents are paid for work (issue #640), the money is
   released only when the checks pass and the review approves.

In one line: yokoten lets agents from different makers check each other, so a person can
trust work they did not read.

## Options not taken

- **One vendor does everything.** Simplest. Its blind spots go unchecked, and the user is
  tied to that vendor, which is what 0020 rules out.
- **Agents of equal rank coordinate on their own.** Cursor's results above: slow, and the
  hard tasks go undone.
- **One integrator agent that reviews and merges everything.** A bottleneck, and one
  model's blind spots again.
- **The owner reviews every change.** It does not scale past a few agents.

## Limits

- This does not solve alignment. It is a working layer of oversight that can be used
  today.
- Each vendor's terms of service decide whether its agent may direct or review another's.
  They are checked before a vendor joins a team.
- Cross-vendor review costs more tokens. The spending limits come first.

## How we will know

- Findings per review: a review from another vendor finds more real problems than one
  from the same vendor.
- Guard stops: how many real risky actions the guard stopped, and from which model.
- The owner's time per merged pull request stays at one approval.

## For now

- Before the hackathon (2026-10-26) no new feature is built for this. The demo shows
  vendors catching each other's mistakes, with the real cases above.
- After the hackathon: rules for claiming a task, a merge queue, review roles in the
  Made-with line, and routing by record.

## Revisit

After the hackathon, with the first counts from "How we will know".
