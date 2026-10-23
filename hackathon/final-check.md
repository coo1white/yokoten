# Final check before submitting

Run this on 2026-11-03, one day before the deadline. Run it again on the morning of
2026-11-04. Tick every line; a line that cannot be ticked goes in the report, not in
the form.

## 1. The rules

- [ ] Every row in [rules-check.md](rules-check.md) says confirmed.
- [ ] The video is inside the official length, and the form accepts the file or link.
- [ ] The contest window dates are written down, and the write-up matches them.
- [ ] The owner has read the "new code" row and made the call.
- [ ] The submission time is in the official time zone, with one day of slack.

## 2. The repo is live and matches

| Claim in the write-up | Where to check | Done |
|---|---|---|
| Public repo, MIT | `https://github.com/yokoten-labs/yokoten` shows the licence | |
| Version 0.1.0 on npm | `npm view yokoten version` prints `0.1.0` | |
| Site is live | `https://yokoten.app` opens on a phone | |
| Release notes exist | `.../releases/tag/v0.1.0` opens | |
| Install works from a clean folder | `npx yokoten install`, then `doctor` | |
| The guard stops a force push | a demo repo, current hook | |
| `doctor` names one next step | same demo repo | |
| Seven agents are supported | README "Works with" says the same seven | |
| The board and the desk are not in npm | the release notes say so | |

Commands, run from the repo:

```sh
node bin/yokoten.ts check
npm view yokoten version
git status --short
git log -1 --date=iso-strict --pretty='%ad %s'
```

Do not run the full test suite for this check. Run the files touched by the last
change, and read the CI run on `main`.

## 3. The video

- [ ] Length is inside the limit. The full cut is 2:40; the short cut is 0:42.
- [ ] The refusal on screen is the current hook's wording.
- [ ] No home path, hostname, email, account name, token, or private repo is visible.
- [ ] The captions have the same checks as the picture.
- [ ] The end card links work on a phone.
- [ ] The upload plays muted, and the story still makes sense.
- [ ] The video is not set to private. Unlisted is fine if the rules allow it.
- [ ] The form's video field holds the final URL, not a draft URL.

## 4. The write-up

- [ ] The first line says what it is, in words a beginner knows.
- [ ] The problem is one paragraph, not a history of the project.
- [ ] "What was built during the contest" lists only work inside the window.
- [ ] Every number matches the repo on the day: seven agents, five stages, 0.1.0.
- [ ] The limits section is still true. Remove a limit only when it is fixed.
- [ ] Links point to `main` or to `v0.1.0`, never to a branch that will move.
- [ ] No private detail in the text, including the team line.
- [ ] The track is Indie Dev, and the form says so.

## 5. The site and the README

- [ ] The README's first screen says what yokoten is, in one line.
- [ ] The README's install block works as written.
- [ ] The README's agent list matches the guide.
- [ ] The site's first screen matches the README, not an older promise.
- [ ] The site's install command and the npm version match.
- [ ] The site and the README link to each other.
- [ ] The Chinese, Traditional Chinese and Japanese READMEs still point to the live
      pages. A stale translation is better than a broken link.

## 6. The release

- [ ] `v0.1.0` is tagged, and the tag is on the commit the README describes.
- [ ] The release notes say what changed, in the same words as the changelog.
- [ ] `CHANGELOG.md` has no `[Unreleased]` line that belongs in the entry.
- [ ] The npm package installs from the registry, not from the repo.
- [ ] CI on `main` is green.
- [ ] The owner created the tag. An agent did not.

## 7. The form

- [ ] Project name: `yokoten`.
- [ ] One-line description: "Every AI agent. One set of rules."
- [ ] Long description: [write-up.md](write-up.md), trimmed to the form's limit.
- [ ] Track: Indie Dev.
- [ ] Video URL, repo URL, site URL and npm URL are pasted, not typed.
- [ ] Built-with list: Node.js, TypeScript, git hooks, GitHub Actions, the agents'
      hooks. No invented tools.
- [ ] AI disclosure, if the form asks: a mixed-vendor agent team built it.
- [ ] The draft is saved before the last edit.
- [ ] Submit at least 12 hours before the deadline.
- [ ] Save the confirmation page or email.

## If something is not live

Do not claim it. Use the fallback that is true:

| Missing | Say instead |
|---|---|
| The site is down | Link the repo and npm only |
| The release is not tagged | "on `main`, and on npm as 0.1.0" only if both are true |
| A feature is on `main` but not npm | "on `main`; the next release brings it to npm" |
| The second vendor failed | Show the one that worked, and say "seven agents are supported" only if the tests say so |
| The video is late | Submit the write-up and the repo; add the video when it is ready, if the form allows an edit |

## The last minute

1. Open the form in one tab and the repo in another.
2. Paste the links. Click each one.
3. Watch the first 20 seconds of the video on the same connection a judge will use.
4. Submit.
5. Save the confirmation. Tell the owner in the chat.

A submission that is 20 minutes early and honest beats a perfect one that misses the
deadline.
