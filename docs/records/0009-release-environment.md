# 0009 Publish to npm only from the `release` environment

Status: accepted; adds to [0008](0008-npm-package.md): how the owner publishes
Date: 2026-10-19 (UTC)

## Context

[0008](0008-npm-package.md) says the owner publishes the package. It does not say how.
The owner chose to let yokoten-bot push workflows (#131). So a workflow pushed to any
branch runs before anyone reviews it. Today that costs little: the repo has no secrets
and no OIDC trust. npm trusted publishing adds one. npm then accepts a short-lived
token from a named workflow file, with no npm token stored anywhere. Without a lock, a
stray copy of that workflow on a branch could publish to npm.

## Decision

- `.github/workflows/release.yml` runs on a pushed `v*` tag. Only the owner can create
  one (the tag ruleset).
- Its `verify` job checks that the tag matches `package.json`, and runs the tests,
  `typecheck`, `check` and `npm run check-package`. Then it packs the tarball.
- Its `publish` job uses `environment: release`, with `id-token: write` and
  `contents: read`. It publishes the tarball from `verify` with
  `npm publish --provenance --access public`. It runs no install and no build.
- The `release` environment has one required reviewer, the owner. It accepts only
  `v*` tags. So the publish job waits until the owner approves it.
- The trusted publisher on npmjs.com names this repo, `release.yml` and the `release`
  environment. A token from any other workflow or environment is refused.
- After trusted publishing works, the package refuses token publishing.
- Any secret or cloud OIDC trust added later, such as the Worker in #107, is tied to an
  environment in the same way.

### The first release is published by hand

npm can't add a trusted publisher to a package that is not on the registry yet. The
`npm trust` docs say: "The package you're configuring must already exist on the npm
registry" (<https://docs.npmjs.com/cli/v11/commands/npm-trust/>). The npm team left a
first publish over OIDC out on purpose, and the request is still open
(<https://github.com/npm/cli/issues/8544>). The trusted publishers page sets up the
publisher from "your package settings on npmjs.com", which exist only after a publish
(<https://docs.npmjs.com/trusted-publishers>).

So for `v0.1.0`, the owner pushes the tag and lets `verify` pass. Then the owner
publishes by hand, from a clean clone of the tag, with two-factor authentication. The
owner rejects the waiting `publish` job and turns off token publishing. Just before the
next release, the owner adds the trusted publisher. Every later release goes through
the workflow.

### How npm requires the environment

The GitHub Actions form of a trusted publisher has an optional "Environment name"
field, "if using GitHub environments for deployment protection"
(<https://docs.npmjs.com/trusted-publishers>). When it is set, npm accepts only a token
whose claims name that environment. All fields are case-sensitive. `npm trust github`
sets the same field with `--env`
(<https://docs.npmjs.com/cli/v11/commands/npm-trust/>).

GitHub explains required reviewers and deployment tag rules in
<https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>.

## Options not taken

- **An npm token as a repository secret.** Any workflow on any branch can read a
  repository secret. A long-lived token is what trusted publishing removes.
- **A short-lived token in the `release` environment, for the first publish only.** It
  would give `v0.1.0` provenance. But a token can't be limited to a package that does
  not exist yet, so it could write every package of the account. And the workflow would
  keep a token path for good. One publish by hand costs less.
- **A placeholder package to reserve the name and set up trust first.** It puts a
  version on npm that is not yokoten.
- **"Prevent self-review" on the environment.** The owner pushes the tag and is the only
  reviewer, so the owner could never approve.

## Consequences

- The `release` environment must exist before the first `v*` tag. A job that names an
  environment that does not exist creates it, with no protection rules
  (<https://docs.github.com/en/actions/using-jobs/using-environments-for-jobs>).
- A release needs two steps from the owner: push the tag, then approve the `publish`
  job on the run page.
- The published package has a provenance statement that links it to the release run.
- Trusted publishing needs npm 11.5.1 or later and Node 22.14.0 or later
  (<https://docs.npmjs.com/trusted-publishers>). The publish job uses Node 24 and
  installs a pinned npm.
- `package.json` `repository.url` must stay
  `git+https://github.com/yokoten-labs/yokoten.git`. npm checks it against the repo.
- A new trusted publisher must publish once within 2 days, or it expires and must be
  made again (<https://docs.npmjs.com/trusted-publishers>). So the owner adds it just
  before the second release, not right after the first.
- Environments in a private repo need a paid plan. yokoten is public.

## The owner's one-time settings

1. GitHub, the repo's **Settings** > **Environments** > **New environment**. Name it
   `release`, then **Configure environment**.
2. Tick **Required reviewers** and add yourself. Leave **Prevent self-review** off.
   **Save protection rules**.
3. Under **Deployment branches and tags**, choose **Selected branches and tags**. Click
   **Add deployment branch or tag rule**, choose **Tag**, enter `v*`, and **Add rule**.
4. Push the tag `v0.1.0` and wait for the `verify` job to pass. Publish by hand from a
   clean clone of the tag, logged in to npm with two-factor authentication:
   `git clone --branch v0.1.0 https://github.com/yokoten-labs/yokoten`, then in it
   `npm ci` and `npm publish --access public`. Reject the waiting `publish` job on the
   run page.
5. On npmjs.com, open the `yokoten` package > **Settings**. Under **Publishing
   access**, choose "Require two-factor authentication and disallow bypass 2fa tokens",
   then **Update Package Settings**.
6. Just before the next release (the 2-day limit), on the same page, under **Trusted
   Publisher**, choose **GitHub Actions**. Enter organization `yokoten-labs`,
   repository `yokoten`, workflow filename `release.yml`, environment name `release`.
   Save.
