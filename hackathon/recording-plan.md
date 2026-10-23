# Recording plan

The video must look like a real tool on a real machine. It must not show who the
owner is, where the machine is, or what else is on it.

## The demo repo

Use a small project named `cart-lab`. It is not a real employer or client project.

- One file with a rounding bug: `src/cart/import.ts`.
- One test that passes only because it asserts the rounded total:
  `test/cart/import.test.ts`.
- One issue, `#12`: "cart: CSV import rounds the sum, not each line".
- `AGENTS.md` and `.githooks/` from `npx yokoten init`.
- A local bare remote named `demo-remote.git`, so the force push is real and offline.
- A branch `fix/cart-rounding` with one commit.

The repo starts clean. The first frame is `git status` with nothing to commit, so the
viewer sees a normal project, not a prepared stage.

## The sessions

| Where | What runs | Used for |
|---|---|---|
| Terminal A | Claude Code in `cart-lab` | The force push refusal, and the test edit refusal |
| Terminal B | Muse Code or Codex in `cart-lab` | The same guard in a second vendor |
| Terminal C | Plain shell | `yokoten doctor`, `scripts/demo/loop.ts`, `git status` |
| Browser | Public site and repo | The end card, if the form allows a screen capture |

Record each terminal full screen at 1080p or larger. Do not record a desktop with
several windows. A judge should see one thing at a time.

## The clean machine

Use a new macOS user named `demo`, or a clean virtual machine. Do not record the
owner's desktop.

- Plain wallpaper. Dock hidden. Desktop icons hidden.
- Notifications off. Focus on. Calendar and mail quit.
- Menu bar: hide the clock, the battery, the Wi-Fi name, and the account menu if the
  recorder can. A visible account name is a private detail.
- Browser: a new profile with no bookmarks, no history, no extensions, and no signed-in
  accounts. Open only `yokoten.app` and the public repo.
- Terminal: dark theme, 18–20 pt font, block cursor, no transparency, no title that
  shows the full path.

## The shell prompt

The prompt is on screen in every shot. Make it carry nothing private:

```sh
export PS1='cart-lab $ '
```

Do not run `pwd`, `hostname`, `whoami`, `env`, `git config --list`, `gh auth status`,
`npm whoami`, or `ssh -v` on camera. Each one can print a home path, a hostname, an
email, a token, or an account name.

Set a neutral git identity in the demo repo only:

```sh
git config user.name "Demo"
git config user.email "demo@example.com"
```

## Privacy screen

| Risk | Check |
|---|---|
| Home path | The prompt hides it. No `pwd`, no absolute path in the terminal title, no file picker |
| Hostname | No prompt, no `hostname`, no `doctor` line that prints the machine |
| Email or name | `git log --format='%an <%ae>'` on the demo repo shows only `Demo <demo@example.com>` |
| Secrets | No `.env`, no key file, no `env`, no token in a command, no browser devtools |
| Account names | No `gh` output, no `npm whoami`, no signed-in site header |
| Other projects | Only `cart-lab` is open. No tabs with real repos |
| Private words | Run `node bin/yokoten.ts check` in this repo before the shoot |
| Subtitles | The caption file has the same checks as the picture |

Watch the rough cut at 2× and stop on every frame with text. One leaked line is enough
to disqualify a public submission.

## The recording order

1. **Cold open.** Terminal, cursor, no typing. Ten seconds of quiet.
2. **The problem.** Record the test edit and the passing test. Cut to the force push
   attempt, but stop before the refusal.
3. **The guard.** In one take, type the force push, let the refusal print, and sit on
   it. Then ask the agent to explain the fix. Do not edit the refusal text.
4. **The second vendor.** Repeat the test edit in Muse Code or Codex. Keep only the
   refusal and one sentence from the agent.
5. **Doctor.** Run `npx yokoten doctor` in the clean demo repo. Capture the whole
   output, then zoom on stage 1 and the next step.
6. **The road.** Show the five-stage table as a still, or scroll the guide. Keep it on
   screen for five seconds.
7. **The lesson.** Run `node scripts/demo/loop.ts`. Capture the full output, then slow
   the frames that show the drafted check, the ship, and project B's `doctor` note.
8. **The close.** The guard's four lines, then the end card.

Record each act as its own file. One failed take then costs one act, not the shoot.

## Reset between takes

```sh
cd cart-lab
git reset --hard demo-start
git clean -fd
git status
```

The loop script leaves nothing behind unless it runs with `--keep`. Do not use
`--keep` on camera.

## The edit

- 1080p, 30 frames per second, H.264 MP4. Check the form's size limit.
- No music, or music with a written licence. A judge may watch muted, so the captions
  and the screen carry the story.
- Hold each refusal line for at least 1.5 seconds. Hold the end card for 5 seconds.
- Cut the wait, not the reasoning. Keep the agent's short explanation after a refusal.
- Add captions in English, Chinese (Simplified and Traditional) and Japanese.
- Do not add a fake cursor, a fake terminal, or a speed-up that hides a failure.

## The sound

- Record the voice in a quiet room, close to the microphone.
- Normalise to about −16 LUFS. Keep the terminal sound out, or very low.
- If the owner does not want to be heard, use captions only and no voice. The script
  still works.
- Do not use a voice that pretends to be a person the team is not.

## Upload

- YouTube unlisted or the contest's own player, whichever the rules name.
- Title: `yokoten · Every AI agent. One set of rules.`
- Description: one sentence, the repo, the site, and the npm package.
- Thumbnail: the guard's refusal, no face, no private text.
- Watch the uploaded file on a phone, muted, before pasting the link into the form.
