# 0005 Plain English: a light ASD-STE100, with a soft check

Status: accepted
Date: 2026-10-18 (UTC)

## Context

The guide lists "a controlled-English style standard as a hard rule" as left out on
purpose. The owner's earlier project used one: English at about 80% of ASD-STE100. It
took the rule from a post by Andrej Karpathy.

ASD-STE100 is Simplified Technical English. The aerospace industry wrote it for
maintenance manuals. Its reader is a mechanic who may not be a native speaker and must
not misread a step.

yokoten has the same readers. Many are beginners. Many read English as a second
language; the owner is one of them. The other reader is an agent, and short, plain
sentences are the ones it misreads least. The decision to aim yokoten at beginners
(record 0004) makes this rule pay for itself.

## Decision

yokoten writes plain English, close to ASD-STE100, in its docs, issue and pull request
bodies, code comments, and everything it prints. The kit's `AGENTS.md` asks the same of
every project.

- An instruction has at most 20 words. A description has at most 25.
- A sentence holds one instruction.
- One word for one thing. Don't switch between synonyms.
- Active voice: say who does what.
- A flow (steps, a decision, a loop) gets a diagram.

The check is soft. `check --pr` (#47) reports a sentence over 25 words in changed
Markdown as a note. It skips code blocks, tables and headings. A note never fails CI.
After we measure the false positives on this repo, a later record may make it fail.

## Options not taken

- **Full ASD-STE100.** It has a dictionary of approved words, and each word has one
  meaning. Checking that needs the specification and a word list per project. That is
  too heavy for a beginner and for a general kit.
- **A hard check now.** A sentence counter gets lists, quotes and names wrong. A
  beginner blocked by prose style on day one may give up.
- **No rule.** The readers above are the reason it exists. Without a rule, prose gets
  longer one pull request at a time.

## Consequences

- The guide's "left out on purpose" line now points here. The hard rule stays out; a
  light rule comes in.
- yokoten's own messages follow it (#42), and so do its docs over time.
- Chinese docs are not under this rule. They follow their own rule: plain Chinese, not
  word-for-word translation.
