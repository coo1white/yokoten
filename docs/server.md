# Server setup (the owner's part)

The guards on your machine catch mistakes. The server is the lock: these settings hold
even when a hook is off or a command slips past the guard. Do them once per repo. All
steps are in the GitHub web UI and take about fifteen minutes.

Then run `yokoten doctor`. It reads these settings through `gh` and says which ones are
missing. It never changes a setting.

## 1. Protect `main`

Settings → Rules → Rulesets → New branch ruleset.

- Name: `main`. Enforcement: Active. Target: the default branch.
- Bypass list: empty. If you add yourself, write down why; a bypass is the one way
  around every rule below.
- Turn on:
  - **Restrict deletions**
  - **Block force pushes**
  - **Require a pull request before merging**: 1 approval, *Dismiss stale approvals
    when new commits are pushed*, *Require review from Code Owners*, *Require approval of
    the most recent reviewable push*. Allowed merge methods: **Squash** only.
  - **Require status checks to pass**: add `ci` from `yokoten.yml` and `pr` from
    `pr.yml`. `ci` waits for every other job in `yokoten.yml` and fails if one of them
    failed. Add the project's own jobs (tests, build) to that file and to the `needs`
    list of `ci`, so the required checks never change. Leave *Require branches to be up
    to date before merging* off: it makes every branch behind `main` merge it in, and
    core rule 7 merges `main` only on a real conflict. The cost is rule 9's incident:
    two pull requests, each green alone, can break `main` together. CI on `main`
    catches that after the merge. Turn it on if many pull requests run in parallel.

Then Settings → General → Pull Requests: allow squash merging only, and turn on
*Automatically delete head branches*.

Why "most recent reviewable push" and "dismiss stale approvals": an approval is for one
commit (core rule 9). A new commit after review needs a new review.

## 2. Protect release tags

Settings → Rules → Rulesets → New tag ruleset.

- Name: `releases`. Enforcement: Active. Target: tags matching `v*`.
- Bypass list: you (Repository admin role).
- Turn on: **Restrict creations**, **Restrict updates**, **Restrict deletions**.

Now only you can create, move or delete a release tag (core rule 3), whatever an
agent's token can do.

## 3. The bot: a GitHub App

The bot opens pull requests for the lead. It is an App, not a second account: it needs
no sign-up, is tied to no person, and its rights are listed one by one.

1. Create the App under the account that owns the repo. For your own repo: your avatar →
   Settings. For a repo in an organization: the organization's Settings. Then Developer
   settings → GitHub Apps → **New GitHub App**.
   - Name: `<you>-bot` (it shows as `<you>-bot[bot]` on pull requests).
   - Homepage URL: your repo.
   - Webhook: turn **Active** off.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and
     write**, **Issues: Read and write**, **Metadata: Read-only**. Leave everything
     else at No access.
   - **Workflows** is your choice. With No access, the bot can't push a change to CI,
     so you push those yourself. With Read and write, the bot can push a branch that
     changes CI, and that CI runs before anyone reviews it. yokoten's own bot has Read
     and write. The locks are then on the server: CODEOWNERS makes a CI change need
     your review (step 4), and anything that can publish waits for your approval in a
     protected `release` environment (record 0009). Also keep the repo's Actions
     setting **Allow GitHub Actions to create and approve pull requests** off.
     Otherwise a workflow the bot pushes could approve the bot's own pull request and
     meet a one-approval rule before anyone reads it.
   - Where can this App be installed: **Only on this account** (the account that owns
     the repo).
2. Create it. On the App's page, **Generate a private key**. A `.pem` file downloads.
   Move it to `~/.config/yokoten/bot.pem` and run `chmod 600` on it. Never commit it,
   never paste it into a chat.
3. **Install App** → the account that owns the repo → **Only select repositories** →
   this repo. yokoten's own bot is installed on its organization, for the yokoten repo
   only.
4. Check `.github/CODEOWNERS`. `yokoten init` writes one line `<path> @<owner>` for each
   lead-only path, where a mistake is hard to undo: `AGENTS.md`, CI, agent config, the rule
   code. Put your GitHub handle in place of `@YOUR_GITHUB_HANDLE` if init left it, or a
   person or `@org/team` if the repo belongs to an organization. A pull request that changes
   one of these paths needs your review (step 1 requires it), and is tier A.

5. Note the **App ID** (on the App's page, under About), and add it to your shell
   profile: `export YOKOTEN_BOT_APP_ID=<the App ID>`.

The lead then runs a command as the bot:

```sh
node .yokoten/bin/yokoten.ts bot -- git push -u origin my-branch
node .yokoten/bin/yokoten.ts bot -- gh pr create --fill
```

yokoten makes a one-hour token from the key and gives it to that one command. The token
is never printed, so it never lands in a transcript, and git cannot fall back to your own
login. The guard still applies: `bot -- git push --tags` is stopped like any tag push.
(Settings: `YOKOTEN_BOT_KEY` for another key path, `YOKOTEN_BOT_INSTALLATION` to skip
looking the installation up.)

## 4. The project board (only if the repo has one)

The `board` workflow fills the board's Start, Target and Status every hour, and when an
issue opens, closes or gets a milestone. It runs as the bot, so the bot needs the right
to change the board. The board belongs to the organization, so this is an organization
permission.

1. The App's page → **Permissions & events** → Organization permissions → **Projects:
   Read and write**. Save.
2. Organization settings → GitHub Apps → the bot → **Configure** → accept the request. GitHub
   asks each installation; until you accept, the old permissions stay.
3. The repo → Settings → Secrets and variables → Actions:
   - **Secrets** tab → New repository secret: name `BOT_PRIVATE_KEY`, value the whole
     text of the bot's `.pem` file.
   - **Variables** tab → New repository variable: name `BOT_CLIENT_ID`, value the
     **Client ID** from the App's page (under About). It is not a secret.
4. Actions → **board** → Run workflow. The run lists each field it set.

The workflow asks GitHub for a one-hour token with three rights only: write the
organization's projects, read issues, read pull requests.

## What you have now

| Who | Can | Cannot |
|-----|-----|--------|
| You | approve, merge, tag, change settings | merge your own unreviewed change without a bypass |
| The bot | push branches, open pull requests and issues, fill the board; with Workflows permission, push a branch that changes CI | merge without your review, push to `main`, create `v*` tags, publish without your approval in the `release` environment |
| A worker | commit in its worktree | push, or edit rules, hooks or CI (guard) |

## Without an App

A second "machine user" account with Write access works the same way: use a classic
token **without** the `workflow` scope (a fine-grained token can't reach a repo where
the account is only a collaborator). GitHub allows one free machine account per person.
Sign-ups from shared VPN addresses are often blocked; the App avoids that.

## 5. Security switches

Settings → Advanced Security. Turn on:

- **Secret scanning**, and under it **Push protection**. GitHub then stops a push that
  holds a token or key.
- **Private vulnerability reporting**. People can then report a hole in private, as
  `SECURITY.md` asks.
- **Dependabot alerts**. GitHub then says when a dependency has a known hole.

Some of these show only to a repo admin. `doctor` reports them as the
`security-settings` step.
