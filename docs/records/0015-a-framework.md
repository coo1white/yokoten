# 0015 A framework: the whole method by default, free to change, still updated

Status: accepted
Date: 2026-10-21 (UTC), accepted 2026-10-22

## Context

[0001](0001-yokoten.md) says yokoten carries practices, not a stack, and keeps checking.
The aim behind it, in the owner's words on 2026-10-21: anyone who uses yokoten, even a
beginner, can organize and manage code like a professional developer, and run the work
like a technical program manager (plan, track, review, decide what ships and when). So a
newcomer gets the whole way this repo is run, not only the guard.

The owner is the first such user. The method he built up while making yokoten should
come with him to his next project, so he reuses it instead of working it out again.

On 2026-10-21 the owner set up a second project with yokoten as a new user would. Three
things showed up:

- **This repo outgrew the kit.** Since 2026-10-18 it added practices that `init` does not
  give: the bot does every write and the owner only approves, risk tiers on every pull
  request, every issue with a milestone, type, tier, assignee and GitHub project item, an hourly
  project sync, a full CODEOWNERS map, a merge order when several pull requests wait, and
  work split between workers by difficulty. Some live only in this repo's files. Some
  live only in the lead session's notes, together with working rules the owner taught
  it: automate by default and treat a manual step as the exception, fix the cause the
  second time a problem shows up, merge only when every check is green, write titles
  for people, discuss before changing files, say what you think instead of agreeing.
  A session in a new project may not have those notes. That is the failure 0001 was
  written to stop: what is not carried is missing.
- **0001 has no rule for changes a user makes.** A user can say "as-is", "lighter" or
  "not now" to a step. But a user who edits a skill that `install` manages loses the edit
  on the next install. That breaks "theirs is theirs" in [0014](0014-safe-by-default.md).
- **The bot takes about five manual steps** in the browser. 0001 allows three.

We compared how other tools give a default setup and still update it:

| Way | Example | Free to change | Gets updates |
|---|---|---|---|
| Copy once | template repos, cookiecutter | yes | no |
| Copy, then merge updates | copier, cruft | yes | yes, with conflicts to fix by hand |
| Generate every file | projen | only through its options | yes |
| Defaults upstream, user overrides a few keys | Renovate and ESLint presets | keys only | yes, by itself |
| Track the files it wrote by hash | GitHub Spec Kit | yes | only files the user did not change |

None does all three alone. The good ones combine ways. yokoten already uses three: keys
in `yokoten.json`, workflows tracked by hash, and `AGENTS.md` split into a core part and
`## This project`.

## Decision

yokoten works like a framework. A user with a blank repo runs a few commands and, with at
most three steps in the browser, gets the whole method this repo uses. Every part can be
changed. A change never stops updates to the parts the user did not change.

1. **This repo runs only on what yokoten ships.** Each practice this repo uses is either
   in the kit, or listed in `yokoten.json` as specific to yokoten the product (npm
   release, the site, translations, the plugin marketplace). Nothing lives only in a
   session's notes: a working rule that any project could use becomes a core rule or a
   skill in the kit. What is personal (one person's private marks, the language of
   their reports) becomes a key, never a default.
2. **Four ways to change a part**, from light to heavy:
   - **Keys** in `yokoten.json` for choices (which stages, the project sync on or off, the
     language of reports, how many workers).
   - **Files yokoten tracks by hash.** An untouched file is replaced on update. A changed
     file is kept, and `doctor` says a newer version exists and how to compare.
   - **Split files.** Where both sides write (like `AGENTS.md`), yokoten owns one part and
     the user the other.
   - **A place to replace a part.** A user's own skill, agent or template with the same
     name wins, and the kit's copy keeps updating underneath.
3. **Hard lines stay.** The guard and the commit check can be added to, never turned off
   (0014's "Never" tier).
4. **The five stages still pace it.** A user meets one stage at a time; nothing is
   locked ([0004](0004-the-road.md)).
5. **Lessons flow back.** The method goes down to every project through the kit. What a
   project learns comes back up: a gap, a guard that missed, a manual step, or a
   better way of working is noted with `yokoten learn --upstream`, becomes a yokoten
   issue, and once it lands, reaches every project on the next update. That is
   *yokoten*: what one project learns, every project gets.
   A lesson that makes a rule stricter follows the normal path. One that removes a rule or
   makes it allow more needs the owner's approval ([0018](0018-rules-improve-from-use.md)).
6. **Built on the agents, not beside them.** yokoten adds one rule set for every vendor,
   its translation into each agent, and the team board. Everything else comes from the
   agents themselves, and no part needs a yokoten server
   ([0018](0018-rules-improve-from-use.md)).

## How we check it

- CI runs `init` on this repo. Apart from the files listed as specific to the product,
  it must change nothing. It starts as a report, and becomes a failure once the gaps
  are closed.
- A pull request that adds a practice to this repo adds it to the kit in the same pull
  request, or lists it as specific to the product and says why.

## Options not taken

- **A hosted App that every user installs.** The App's key would sit with us and could
  write to every user's code. It needs a server and the users' trust. For an MIT project
  at this stage, the user's own App, made in one step, fits better.
- **Copy, then merge updates.** Merge conflicts stop a beginner.
- **Generate every file.** Too rigid; it is the opposite of free to change.
- **Keep the gap and document it.** Docs about practices are what 0001 found does not
  travel.

## Consequences

- Several practices move from this repo and the lead's notes into the kit: the project
  sync, the CODEOWNERS map, issue fields, risk tiers, the merge order and how work is
  split.
- `install` stops overwriting a managed skill the user changed.
- Making the bot needs to become one step.
- Each new default needs a key to change it and a test, as 0014 already asks.
- The order of the work, and what lands before v0.1.0, is decided in the issues that
  follow this record.
