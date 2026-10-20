Fixed

A check stops when git can't answer it (#403). Before, `check --pr` read a file git could not show as deleted.
It also read a CODEOWNERS that git could not show as missing, which lowered the tier.
Now the commit check, `check`, `check --history` and `check --pr` each report one `git-read` finding and fail.
The finding names the git command and why it gave no answer: an error, a stop, or output over the buffer.
