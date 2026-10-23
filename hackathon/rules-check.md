# Rules check

Status: **not confirmed**. This desk can reach the model, not the open web. The official
contest page was not read here. Open the official page, read every row, and mark it.
Do not submit while a row says "confirm".

## The table to confirm

| Item | What to find out | Plan if the rule is strict | Mark |
|---|---|---|---|
| Video length | The maximum length, and the minimum | The full cut is 2:40. If the limit is 60 seconds, use the 42-second cut. If the limit is 3 minutes, keep the full cut | confirm |
| Required fields | Project name, short description, long description, video URL, repo URL, track, built-with list, team size, country | The write-up draft fills the long description. Keep the repo and video links public | confirm |
| New code | Must the contest code be written during the contest window? Is a project that started earlier allowed? | yokoten existed before the contest. Show the work done in the window, and say what came before. If the rule needs all-new code, stop and ask the owner | confirm |
| Open source | Must the repo be public? Which license is accepted? | The repo is public and MIT. Add a license line to the form if it asks | confirm |
| Dependencies | Are third-party libraries allowed? Must they be listed? | yokoten has no runtime dependencies. TypeScript is a development dependency | confirm |
| AI tools | Must the team disclose AI assistance? | Say that a mixed-vendor agent team built yokoten, and name the vendors | confirm |
| Eligibility | Age, country, team size, employment | The owner confirms. This desk cannot judge it | confirm |
| Judging | The published criteria and their weight | The video leads with a working guard, then the road and the lesson | confirm |
| Submission time | The time zone of the deadline | Submit by 2026-11-03 18:00 UTC, one day early | confirm |
| Public details | What the form shows publicly | No private email, home path, hostname or account name in the video or the text | confirm |

## How the plan changes

- **Short limit (60 seconds or less).** Record the 42-second cut only. It keeps the
  force push, `doctor`, the lesson, and the links.
- **All-new code.** yokoten's history is public, so this cannot be hidden. The owner
  decides whether to enter. Do not rewrite history or present old work as new.
- **No public repo.** The demo still works, but the write-up drops the repo link and
  points to the site and npm instead. The form may reject it.
- **No AI disclosure.** Keep the "built by a mixed-vendor agent team" line out of the
  form, but keep it in the video's credits. A hidden fact is worse than a listed one.
- **A shorter form.** The one-line description and the three links carry the entry.

## What is already true

These facts do not need a rule check, because they are in the repo:

- The repository is public and MIT licensed.
- `npm view yokoten version` reports 0.1.0. Confirm on the day.
- The site and the release page are linked from the README.
- The guard, the commit check and `doctor` run from one install.
- The test suite is green in CI. Record one green run for the submission.

## Wording to avoid

- "Every agent" when Gemini CLI is not verified. Say "seven agents".
- "Replaces your team" or "replaces code review". yokoten adds a safety net.
- "100% safe", "cannot be bypassed", or "guaranteed". No check can promise that.
- "New" for old work. Say when it was built.
- Any private detail. The guard's own privacy check is a good test: run
  `node bin/yokoten.ts check` on this repo before recording.

## Sign-off

| Who | What they confirm | Date (UTC) |
|---|---|---|
| Owner | Every row above is confirmed on the official page | |
| Lead | The write-up matches the repo and the release | |
