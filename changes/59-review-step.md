Added

The road's stage 4 has a `review` step: full `doctor` reads whether a merge to the default branch needs at least one approving review, from its ruleset or branch protection, and is not done while GitHub Actions may approve pull requests. The bot opens the pull requests, so the owner can approve them. On a private repo without rulesets the step waits for stage 5; a session shows "can't check" (#59).
