# 0037 The owner reviews only what can loosen the safeguard

Status: proposed
Date: 2026-10-23 (UTC)

## Context

Record 0004 made the tier follow the paths in CODEOWNERS. CODEOWNERS listed the rule
code, the commands, the kit, the records, all CI, agent config and the bot code. Of
the last 60 merged pull requests, 44 were tier A. The paths that made them tier A were
mostly `src/rules/` (18), the records (15), `src/run/` (10) and `src/commands/` (9).
Most of those changes added a protection, fixed a bug, or changed a message.

So the owner approved almost every pull request one at a time. With many small
releases (record 0036), that does not scale. On 2026-10-23 the owner chose to keep
for himself only the changes that can turn the safeguard off, publish, or reach a
secret, and to hand the rest to the lead.

## Decision

1. **Tier A, the owner approves**, only for:
   - a change that makes a rule looser: a check removed or weakened, a test of a
     check removed, a wider allow list (issue #697 detects this by machine);
   - CI that publishes, holds a secret, or has write permissions
     (`release.yml`, `board.yml`, `outside-prs.yml`);
   - the core rules: `AGENTS.md` and `kit/project/AGENTS.md`;
   - `CODEOWNERS` itself;
   - the bot's token code and the tier A approval check;
   - config that can turn a guard off (`yokoten.json`, `.githooks/`,
     `.claude/settings.json`, `.muse/hooks.json`) and `package.json`.
2. **Everything else is tier B or C.** An agent from another vendor than the writer
   reviews the head commit. The lead approves, and the merge script merges when every
   check is green and the review names the head commit.
3. **Until issue #697 ships**, the lead finds a loosening by reading the diff, and the
   reviewer brief asks for it too. A loosening change gets `tier: A` by hand, even when
   it touches no owned path. `check --pr` already accepts tier A on any path.
4. Issue #697 moves to the front of v0.1.1. The work is issue #839.

## Options not taken

- **Keep the old CODEOWNERS.** About 75% of pull requests wait for the owner. The owner
  said this does not scale.
- **Drop tier A.** The owner must still decide on loosening, release, secrets and the
  rules. One wrong merge there is hard to take back.
- **Wait for issue #697 before narrowing.** The owner asked for relief now. The lead's
  reading plus a cross-vendor review covers the gap until then.

## Consequences

- The owner sees a few pull requests in a hundred instead of most of them.
- The rule code (`src/rules/`, `src/run/`) is tier B. A looser rule there is caught by
  the lead and the reviewer, not by CODEOWNERS, until issue #697 ships. That is the
  main risk of this record, and the reason issue #697 comes first.
- The main branch ruleset already asks for zero approvals outside CODEOWNERS paths, so
  no setting changes. A reviewer GitHub App, so the lead's approval is a real GitHub
  review, can come later.
