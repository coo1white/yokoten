Fixed

A `gh` post through `yokoten bot --` gets your project's privacy allow only from yokoten's own paths. These are a plain `yokoten`, a path such as `bin/yokoten.ts`, or one under `~/`. A path under another user's home (`~other/…`), `~+` or `~-` no longer counts, so the guard checks the post without the allow (#506).
