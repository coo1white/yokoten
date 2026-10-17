# 0003 Docs live in the repo; no wiki

Status: accepted
Date: 2026-10-18 (UTC)

## Context

GitHub offers a wiki next to the repo. The plan was to open one when the repo goes
public, for guides and lessons.

## Decision

All docs live in the repo, and the wiki is turned off.

- Guides: `README.md` for a first look, `docs/` for the rest.
- Decisions: `docs/records/`, one file each, kept; a changed decision gets a new record.
- Lessons (what went wrong, why, and the check that now holds it): an issue labelled
  `incident`, and the rule's "why" in `AGENTS.md` names it.

## Why

- A wiki edit skips pull requests and review. Here every change is reviewed (core
  rule 2), and the docs are what the agents follow, so they need it most.
- Agents read files in the checkout. They do not read a wiki.
- A doc that changes in the same pull request as the code stays true.

## Consequences

- Nothing to set up or keep in sync after going public.
- Someone who wants to fix a typo opens a pull request, like any other change.
