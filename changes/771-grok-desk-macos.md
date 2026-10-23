Fixed

`yokoten desk grok` now starts Grok on macOS as its own installer leaves it. The desk shows the real file the `grok` on PATH points to, such as `~/.grok/downloads/grok-<version>-macos-aarch64`, while the rest of `~/.grok` stays hidden. The sandbox may also look in `/etc/grok`, so a missing `requirements.toml` reads as missing instead of "Operation not permitted" (#771).
