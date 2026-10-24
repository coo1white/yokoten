Added

Three release channels for the Claude Code plugin and npm (#632). Stable installs the latest release tag and npm `latest`; Beta installs the latest pre-release tag and npm `next`; Dev installs the default branch. `doctor` now names the channel and version it runs, and the release workflow sends a pre-release to npm `next`, never `latest`.
