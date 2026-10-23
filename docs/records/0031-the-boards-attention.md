# 0031 The board's attention: a consent agenda, cooling-off, two keys

Status: accepted
Date: 2026-10-23 (UTC)

## Context

[0026](0026-the-owner-is-the-board.md) made the owner the board.
[0030](0030-earned-autonomy.md) lets agents earn room from their record. What is left is
the owner's attention, the scarcest thing in the system. On 2026-10-23 he approved pull
requests one at a time through a night without sleep, and asked for them in batches
("2345 一批, 6789 一批") so CI runs and his time were not wasted.

Real boards solved this long ago. Routine items go on a **consent agenda** and pass in
one vote; any member may pull one out to discuss. Changes to the constitution take a
fixed process and time. Some acts need two keys.

Two dangers come with earned autonomy. In the xz incident (2024) an attacker built a
good record over two years, gained maintainer rights, and then hid a backdoor in the
build. A record can be farmed. And a tired person approves what a rested one would not.

Open-source maintainers carry the same load: too many pull requests, too little time,
and a slow attack hidden among good work. What protects this owner protects them.

The owner agreed on 2026-10-23.

## Decision

1. **One consent agenda a day.** The lead sends one summary. Routine items that passed
   their checks and reviews are one batch, approved with one answer. The owner may pull
   any item out. At most three items need real discussion, each with the lead's
   recommendation and the answers it takes.
2. **Silence on reversible items.** A reversible item with a deadline goes ahead on the
   lead's recommendation when the deadline passes. An item that is hard to undo never
   goes ahead on silence.
3. **Cooling-off for the constitution.** A change to the core rules, CODEOWNERS, the
   branch rules or a record takes effect 12 hours after the owner approves it, and he may
   withdraw it in that time. An emergency fix may skip the wait only when it says why.
4. **Two keys for what can't be taken back.** A release and spending money need the
   owner's yes plus a second key: a machine check that passes, or his own second yes on
   another day.
5. **No farmed trust.** A level earned in one area never counts in another. Whatever its
   level, a change always reaches the owner when it raises an agent's own rights, touches
   build, test or release infrastructure, or adds binary or generated test files.
6. **The same rules for people.** Outside contributors, human or AI, go through the same
   levels and the same checks. A project that is not yokoten can take this as its
   maintainer's board mode.

## Options not taken

- **Approve each change, but faster.** It keeps the owner as the bottleneck, and speed
  is where mistakes come from.
- **Let silence approve everything.** Silence is fine for what can be undone, never for
  what can't.
- **Trust a level everywhere once earned.** That is how the xz attack worked.

## Consequences

- Easier: the owner answers once a day for routine work; batches save CI runs; a tired
  approval of a constitution change can be taken back.
- Harder: constitution changes are slower by design; the consent agenda must be honest
  about what is routine; the area split for levels must be kept clear.
- To check: each summary lists the batch and the pulled items; each constitution merge
  shows its cooling-off; every release names its two keys.
