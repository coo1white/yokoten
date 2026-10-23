# Packaging

yokoten installs with Homebrew, Scoop and npm. The formula and the manifest come from
one command, so a release never edits a checksum by hand.

## What a release writes

`scripts/packaging.ts` reads the version from `package.json` and the sha256 of the packed
tarball. It writes one folder per repo, under `--out` (default `packaging/out`):

| Output | Goes to |
|---|---|
| `homebrew-tap/Formula/yokoten.rb` | `yokoten-labs/homebrew-tap` |
| `scoop-bucket/bucket/yokoten.json` | `yokoten-labs/scoop-bucket` |

```sh
npm pack
node scripts/packaging.ts --tarball yokoten-<version>.tgz
```

The tarball that `npm pack` writes is the one npm publishes. So its checksum is the one
the formula and the manifest need. Copy each folder into its repo; the release workflow
does the same, on the tarball it published.

## The release workflow

The workflow is lead-only, so the lead adds these steps after `npm publish`. A release
then needs no hand edit.

1. Pass the published tarball to `scripts/packaging.ts --out packaging/out`.
2. Copy `packaging/out/homebrew-tap/` into the tap.
3. Copy `packaging/out/scoop-bucket/` into the bucket.
4. Commit and push both, with a token that may write those two repos.

Step 1 needs no network: the tarball the publish job uploads is the one npm published.
The tap and the bucket need a token, kept in a protected environment.

## The two repos

The owner creates `yokoten-labs/homebrew-tap` and `yokoten-labs/scoop-bucket`. Each holds
one file: `Formula/yokoten.rb` and `bucket/yokoten.json`. Nothing else is needed.

- Homebrew: `brew install yokoten-labs/tap/yokoten`. The formula depends on `node` and
  installs the npm package into libexec. `std_npm_args` re-packs it with no scripts, so
  the `prepack` build never runs on a user's machine.
- Scoop: `scoop bucket add yokoten https://github.com/yokoten-labs/scoop-bucket`, then
  `scoop install yokoten`. Scoop installs Node, unpacks the tarball, and runs npm with
  `--ignore-scripts`. The launcher is npm's own `yokoten.cmd`.

## Windows and winget

Scoop needs no new build. winget does: it cannot run a JavaScript file, so its manifest
needs an `.exe` or an `.msi` with a checksum. That is a Windows build of yokoten (a Node
single executable, or an installer), and it is not here yet. When it is, one more render
function in `src/run/packaging.ts` writes the winget manifest set from the same version
and checksum.

## Try it before a release

`test/run/packaging.test.ts` covers the two files and the refusal of a bad version or
checksum. On a Mac, `ruby -c packaging/out/homebrew-tap/Formula/yokoten.rb` checks the
Ruby syntax. A real `brew install` and `scoop install` need a clean machine.
