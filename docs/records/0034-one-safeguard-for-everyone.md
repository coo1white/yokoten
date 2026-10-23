# 0034 One safeguard for everyone, on by default

Status: accepted
Date: 2026-10-23 (UTC)

## Context

The owner chose to work alongside Orca instead of competing with it. A trial on native
Windows (issue #815) showed that Orca starts Claude Code with its own permission prompts
turned off, so the yokoten hook was the only check left. It refused a force push, a
skipped commit check, a tag push and deleting `.git`. It let through a new local tag
(issue #812) and an edit to a CI file, because that repo had never run `yokoten init`.

A first proposal split people into beginners (refuse) and experts (looser rules after
`init`). The owner rejected the split and the wording: a table of file names and "ask"
versus "refuse" was not readable, by him or by a beginner. His words: "the safeguard is
the selling point" and "a default safeguard that protects beginners and experts alike."

## Decision

One safeguard, on by default, the same for every person and every agent. It holds
without `yokoten init` and without any setting. The agent cannot:

1. lose your work: no force push, no hard reset, no deleting `.git` or the history;
2. leak a secret: no keys, tokens, email addresses or home paths in a commit or a post;
3. publish for you: no tag, no release, no package publish, no making a repo public;
4. run code from the internet unread: no download piped into a shell;
5. take the safeguard apart: no turning off checks or hooks, no editing CI or the rules.

Everything else runs, and the agent saves a restore point before it changes files.
When a question is needed, it is one a beginner can answer, with the answer we
recommend. A refusal is one plain sentence: what was stopped, why, and what to do.

`yokoten init` adds project rules on top (roles, tiers, reviews). It never removes any of
the five.

## Options not taken

- Beginner and expert modes. A looser expert default protects experts less, and Orca's
  users are often experts moving fast with prompts off. One default is easier to explain
  and to sell.
- Asking instead of refusing for CI and hook edits. A person who cannot judge the
  question learns to click "allow"; the question then protects nobody.
- Guarding only projects that ran `init`. Most people open an agent in a repo and start;
  the safeguard must already be there.

## Consequences

- The guide and every refusal use plain words first; file names and rule ids come after.
- In a repo without `yokoten.json`, CI and hook edits are refused, and the message says
  how the owner makes that change. This is new and needs tests on all three systems.
- Creating a tag is refused (issue #812).
- Restore points need new work; until they exist, the five refusals ship alone.
- The pitch leads with the safeguard: the same five lines hold under Orca, Claude Code,
  Codex, Grok and OpenCode.
