Fixed

`yokoten check` no longer reports your forge login where a file names accounts (#410).
These places are a CODEOWNERS owner and an `@` mention in `.github/`. They are also an
author or owner field in `package.json` or a plugin manifest, and a LICENSE copyright line.
This holds only for the login that yokoten added to your private marks. Anywhere else the
login is still found. A mark you wrote yourself is found everywhere, as before. yokoten now
writes the kind above each mark it adds, such as `# added by yokoten from this machine: forge login`.
