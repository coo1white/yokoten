Fixed

`yokoten doctor` now reads the `v*` tag ruleset's bypass list, and the `release` environment's required reviewer and `v*` tag rule. A missing release lock is named with the place to click (#537).

A bypass counts only on a ruleset that blocks tag creation. Every `v*` ruleset that blocks creation must name Repository admin, because a push meets them all (#850). A bot on a ruleset that blocks no creation is no fault. When you cannot push and a bot can, the line names both. A `v*` branch rule next to the tag rule is caught too.
