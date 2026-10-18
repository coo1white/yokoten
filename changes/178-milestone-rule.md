Fixed

`init --github` and `doctor` now use one milestone rule: the repo needs an open milestone. Before, `init` kept a closed "First release" and said "Nothing to change", while `doctor` still asked for a milestone. Now `init --github --yes` makes "First release" when no milestone is open. When a closed milestone already has that title, it makes "Next release". It never reopens a closed milestone. The fix that `doctor` shows names the same title (#178).
