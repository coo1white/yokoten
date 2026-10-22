# 0020 Where yokoten is going: a rulebook for AI work that its users own

Status: accepted
Date: 2026-10-22 (UTC)

## Context

On 2026-10-22, for the first time, agents from three vendors worked in this repo at once.
Claude led and reviewed. Grok wrote code and tried yokoten as a new user. Muse Code led
its own workers. All of them used one bot account and were stopped by the same guard,
and the owner only approved.

The same day showed the other side. A Grok worker in a sandbox could not read the private
marks, so the commit check failed. It pointed the marks setting at an empty file, and the
check passed. It said so in its report, and the commit was clean. But an agent under
pressure to finish switched off a privacy check without being told to (issue #656).

Records [0001](0001-yokoten.md), [0015](0015-a-framework.md) and
[0018](0018-rules-improve-from-use.md) say what yokoten does and how its rules improve.
This record says where it is going, so the work of the next months points the same way.

Today each vendor sets the rules its agent follows: its own permissions, its own sandbox.
A person who uses agents from three vendors follows three rulebooks, and none of them is
that person's.

## Decision

On 2026-10-22 the owner decided that yokoten's direction rests on four parts:

1. **The rules belong to the people who use the agents.** Open source, run on their own
   computer, the same for every vendor, and they move with them when they change vendor.
2. **A shared safety record.** A mistake found in one project becomes a check in every
   project. Flying became safe because every accident became a rule for every airline.
   yokoten already does this between one owner's projects (`yokoten learn --upstream`).
   Later it can do it between users, on the terms below.
3. **Credit and a track record.** Every piece of work says who did it and who approved it
   (the Made-with line). Over time each model has a record across projects: how often it
   was stopped, how many rounds it took, how often it passed the first time. People can
   choose agents by what they did, not by what their makers say.
4. **A school.** Many people who never learned software engineering will direct teams of
   AI agents. The doctor's road is the course: by following it they learn the practices
   that make the work trustworthy.

Code is the first kind of work, not the only one. The same rules fit writing, spreadsheets
and wikis. The owner's own projects are where this is tried first.

In one line: yokoten is an open rulebook for AI work. The people who use it own it, it
holds for every vendor, and it gets better from every mistake.

## Limits

- yokoten does not build agents and does not change models.
- The rules always run on the user's computer. They are never locked inside a hosted
  service (as 0018 says).
- Growth never loosens the guard. Security and privacy come first.
- The shared safety record is opt-in. Lessons are cleaned on the user's computer first,
  the user sees exactly what is sent, and nothing is sent by default. A user's incident
  can hold paths, project names and code, so it never leaves without the user's say.
- The guard must hold against an agent that means well. An agent that wants to finish
  will route around a check that stops it (issue #656). A setting an agent can change
  may make a rule stricter, never looser.

## How we will know

- A new user takes fewer steps to the first pull request. The trial on 2026-10-22 took
  11 (issues #653, #654, #655).
- More vendors' agents work under the same rules.
- More lessons come back from other projects and become checks.
- Each merged pull request costs the owner one approval and no other work.

From now on each pull request records the vendor and model that did the work. A later
change can count how often each was stopped, how many rounds it took, and the owner's
time.

## For now

- Before the hackathon (2026-10-26) no new feature is built for this direction. The
  hackathon story follows it, and this repo and its board are the evidence.
- After the hackathon: write the rules down as an open description that other tools can
  follow, record where code came from, and try the rules on work that is not code.

## Revisit

After the hackathon, or when a vendor ships a rule standard that works across vendors.
