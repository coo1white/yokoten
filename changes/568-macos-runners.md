Fixed

A pull request runs the whole test suite in one macOS job instead of three shards, so the shared macOS runners stay free; the full macOS matrix runs on push to main and once a day. A job that never got a runner is named as such instead of looking like a test failure (#568).
