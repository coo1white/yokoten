Added

`yokoten learn <issue>` drafts a check from an incident issue: a finding (`id`, `what`, `why`, `fix`) and a test with a positive control, for a person to review. It reads the issue through `gh`, writes nothing unless `--write`, leaves a TODO where the issue has no answer, and never lets issue text run as code in the draft or send escape codes to the terminal (#77).
