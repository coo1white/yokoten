---
name: yokoten
description: Bring the yokoten practices into a project, new or old. Use when doctor reports missing practices, when the user starts a new project, or when they ask to adopt or set up yokoten.
---
<!-- managed by yokoten; `yokoten install` replaces this file -->

# Adopt yokoten in this project

The goal is a project that runs the practices for real, not a copy of files. An old
project has its own habits, and some of them are better than ours. So go through the
practices one at a time with the user, and decide each one.

## 1. See where the project is

Run `yokoten doctor` in the repo root. Read the project's own `AGENTS.md`, `CLAUDE.md`,
`README.md`, CI files and hooks, if there are any. Note what the project already does
that a core rule asks for, even if it does it another way.

## 2. Decide each practice with the user

Make one table and show it before changing anything. One row per practice doctor
names (rules, commit-check, tool-hook, ci, runtime, issues) and per core rule in
`AGENTS.md` that the project does not already follow:

| Practice | The project today | Decision | Why |
|----------|-------------------|----------|-----|

The decision is one of:

- **as-is**: take it as yokoten has it.
- **lighter**: take a smaller form, and say which part is left out.
- **not now**: leave it out, with the reason and *when to look again* (a date, or an
  event such as "first outside contributor" or "first release").

Ask, do not assume. A one-person script repo does not need the bot account; a repo
that ships to users does. Wait for the user's answer on every row.

## 3. Put it in

1. `yokoten init` adds what is missing. It never overwrites; it says what it kept.
2. Merge by hand where the project already had its own file: keep the project's rules
   in the "This project" section of `AGENTS.md`, and remove any that repeat a core rule.
3. Every "not now" goes into `yokoten.json` under `notNow`, so doctor stops asking:
   `"ci": "no remote yet; look again at the first push"`.
4. Write the table into `docs/records/` with the `record` skill. That record is the
   answer when someone later asks why the project skips a practice.
5. Run `yokoten check`. Fix what it reports, or ask the user.
6. List the owner's server steps (doctor prints them). Keep the list to three items
   or fewer. Open an issue for each one the owner cannot do today.

## Do not

- Copy a practice because it is there. Each row needs a reason.
- Change the project's build, test or deploy setup as part of adoption. That is its own task.
- Turn on a check that fails on the current tree and leave it red. Fix the tree first,
  or record the check as "not now".
