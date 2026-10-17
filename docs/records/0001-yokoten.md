# 0001 Why yokoten exists, and what goes in it

Status: accepted; point 6 changed by [0002](0002-typescript.md)
Date: 2026-10-18 (UTC)

## Context

The owner ran one private, self-hosted project with AI agents for about a month. Its
working method grew there: issues for every task, a lead session and worker sessions,
hooks that stop release tags and test edits in fix tasks, a three-pass review, a
privacy check, a layout rule. It worked in that project.

It did not travel. Each new project, and each old one, started without it unless the
owner remembered to ask for each piece, and whatever was forgotten was missing.

An earlier attempt to unify the setup across projects copied a stack (the same
tools, the same CI) once, then drifted. Three things went wrong: it managed the
technology instead of the practices; it copied once instead of checking all the time;
and the owner's list of manual steps grew too long to do.

## Decision

Build a small kit that carries **practices**, not a stack, and **keeps checking**:

1. **Rules with reasons.** About twelve core rules in `AGENTS.md`. Each names why it
   exists (an incident, or a risk when nothing has happened yet; incidents are never
   made up) and the check that holds it.
2. **Four layers.** Machine (`install`), project (`init`, and the `yokoten` skill for an
   old project), server (rulesets the owner sets once), rules (`AGENTS.md`).
3. **Doctor at every session start**, so a missing practice is raised by the agent, not
   remembered by the owner. Doctor tests itself first with known-bad inputs.
4. **Old projects decide row by row**: as-is, lighter, or not now with a reason and
   when to look again. "Not now" is recorded and doctor stops asking.
5. **The owner's manual steps stay at three or fewer.**
6. **Zero dependencies**, Node 22, `.mjs`. Hooks must run on a fresh machine.
7. **Privacy by check.** The public repo holds no personal email, IP, name, city,
   domain or private project detail. A private-marks list lives outside the repo.
8. **The bot is a GitHub App** without Workflows permission. Agents never use the
   owner's account to approve, and never push tags or releases.
9. **Times in files are UTC.** Decisions are kept and replaced by new records; facts
   are edited in place.

## Options not taken

- **A template repo to copy.** Copying once is the failure above.
- **Carry every practice from the source project.** Some cost more than they saved
  outside it: a commit-type-matches-files check, byte-level merge replay in the
  queue, a todo folder taxonomy, a 978-line rules file, committed release verdict
  signatures, controlled English as a hard rule.
- **A second GitHub account as the bot.** It works (and `docs/server.md` covers it),
  but sign-up was blocked from a shared network address, and an App is tied to no
  person and lists its rights one by one.

## Consequences

- A new project gets the practices in one command; an old one in one conversation.
- The guards read command text, so they catch mistakes, not attacks. The server
  rulesets are the lock, and doctor cannot check them yet (planned).
- Muse Code reads `AGENTS.md` today; its skills and hooks need an adapter (planned
  for the hackathon milestone).
- Every change to `kit/` reaches every project on its next `init` or `install`.
