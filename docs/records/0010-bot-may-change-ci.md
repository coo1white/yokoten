# 0010 The bot may change CI

Status: accepted; changes point 8 of [0001](0001-yokoten.md)
Date: 2026-10-19 (UTC)

## Context

[0001](0001-yokoten.md) point 8 says the bot is a GitHub App without the Workflows
permission. But the bot opens pull requests that change workflow files. Without the
permission, GitHub refuses those pushes, and each one needs a hand step from the owner.
On 2026-10-18 the owner chose that the bot keeps the Workflows permission.

## Decision

- The bot keeps the Workflows permission. It may push branches that change
  `.github/workflows/`.
- Other locks hold CI instead:
  - CODEOWNERS names the owner for `.github/workflows/`, so a change to CI is tier A
    and merges only after the owner reviews it.
  - npm publishing runs only in the protected `release` environment
    ([0009](0009-release-environment.md)). A workflow on a branch can't publish.
  - The tag ruleset lets only the owner create `v*` tags.
- The rest of point 8 stands: agents never use the owner's account to approve, and
  never push tags or releases.

## Options not taken

- **No Workflows permission.** Every CI change from an agent would stop for a hand
  step. Manual steps are the exception (0001 point 5).

## Consequences

- A workflow the bot pushes to a branch runs before anyone reviews it. So any secret
  or cloud trust must sit behind a protected environment, as 0009 says.
- Docs that say the bot has no Workflows permission are wrong and get fixed in place.
