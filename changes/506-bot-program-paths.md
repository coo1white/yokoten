Fixed

A `gh` post through `yokoten bot --` gets your project's privacy allow only from yokoten's own paths. These are a plain `yokoten`, a path such as `bin/yokoten.ts`, or one under `~/`. A path under another user's home (`~other/…`), `~+` or `~-` no longer counts, and neither does a word with `=` or `,`, such as `GH_REPO=x/yokoten`. The guard then checks the post without the allow (#506).
