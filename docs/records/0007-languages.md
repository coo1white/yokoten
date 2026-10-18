# 0007 Languages: develop in English, serve users in three

Status: accepted
Date: 2026-10-18 (UTC)

## Context

yokoten has two kinds of readers. Users read the website, the README, the guide and the
video. Developers and agents read the code, the commits, the issues and the records.

The website and the guide are in English and Chinese. The owner asked to add Japanese,
and asked to confirm that development stays in English.

Japanese fits yokoten. The name is a Japanese word: 横展, short for 横展開 (yokotenkai).
It comes from Toyota's shop floor, where a lesson from one line spreads to every line.

## Decision

Development is in English only:

- code, comments and names (record 0006);
- commits, pull requests, issues and reviews;
- `AGENTS.md`, records and the changelog;
- tests and CI output;
- the CLI's output, for now.

Users can read yokoten in English, Chinese and Japanese:

- the website (`/zh/`, `/ja/`);
- the README (`docs/zh-CN/README.md`, `docs/ja/README.md`);
- the guide (`docs/zh-CN/guide.md`, `docs/ja/guide.md`);
- the video's subtitles.

English is the source. A translation follows the English text and never adds to it.

Each Japanese page says it is translated and asks for corrections. It says so until a
native reader reviews it. The Japanese text uses both 横展開 and 横展.

## Options not taken

- **Translate everything, development too.** Three copies of every comment and commit
  triple the work and drift apart. Agents and most open source work read English.
- **English only.** Many beginners read English as a second language. A guide in their
  own language takes away a hard part of the road (record 0004).
- **Translate the CLI's output now.** It needs a message catalog and a test for every
  language. Its users are beginners too, so it is a fair ask, but not before the
  hackathon. We look at it again after it.
- **More languages now.** Each language needs a reader to check it. Three is what we
  can keep current.

## Consequences

- Contributors write one language. Reviews, search and agents all work on one text.
- Every change to user text needs two translations. The stale-translation check
  (issue #87) must cover Japanese.
- The Japanese work has its own parent issue (#121): the website, the README, the
  video's subtitles, then the guide.
- The translations come last, after the English text is final.
