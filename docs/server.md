# Server setup (the owner's part)

The guards on your machine catch mistakes. The server is the lock: these settings hold
even when a hook is off or a command slips past the guard. Do them once per repo. All
steps are in the GitHub web UI and take about fifteen minutes.

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
  - **Require status checks to pass**: add the CI jobs by name (`check` from
    `yokoten.yml`, plus the project's own test job). Leave *Require branches to be up
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

1. Your avatar → Settings → Developer settings → GitHub Apps → **New GitHub App**.
   - Name: `<you>-bot` (it shows as `<you>-bot[bot]` on pull requests).
   - Homepage URL: your repo.
   - Webhook: turn **Active** off.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and
     write**, **Issues: Read and write**, **Metadata: Read-only**. Leave everything
     else at No access. In particular **Workflows: No access**, so the bot cannot
     change the CI that checks it (core rule 5).
   - Where can this App be installed: **Only on this account**.
2. Create it. On the App's page, **Generate a private key**. A `.pem` file downloads.
   Move it to `~/.config/yokoten/bot.pem` and run `chmod 600` on it. Never commit it,
   never paste it into a chat.
3. **Install App** → only select repositories → this repo.
4. Add a `.github/CODEOWNERS` file with `* @<you>`, so every pull request needs your
   review (step 1 requires it).

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

## What you have now

| Who | Can | Cannot |
|-----|-----|--------|
| You | approve, merge, tag, change settings | merge your own unreviewed change without a bypass |
| The bot | push branches, open pull requests and issues | merge without your review, push to `main`, touch CI, create `v*` tags |
| A worker | commit in its worktree | push, or edit rules, hooks or CI (guard) |

## Without an App

A second "machine user" account with Write access works the same way: use a classic
token **without** the `workflow` scope (a fine-grained token can't reach a repo where
the account is only a collaborator). GitHub allows one free machine account per person.
Sign-ups from shared VPN addresses are often blocked; the App avoids that.
