Changed

Secret and privacy findings show a sure, likely or unknown grade. An ignore must name the rule and give a reason, and an ignored finding stays in the output. The check also finds the real values of secret-looking environment variables (#616).

A sure secret or a private-mark hit can be ignored only in `.yokotenignore`, which is now lead-only, never in a comment on its line. `check --pr` shows each ignore a pull request adds as a notice for the reviewer (#616).
