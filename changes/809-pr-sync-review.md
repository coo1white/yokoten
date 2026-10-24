Fixed

`yokoten pr sync` verifies every merge before it pushes and keeps the names each side added to an import list. It leaves a checked-out branch clean when it stops. It runs as UTC, names the base branch it merged, and says when the open list stops at 100 pull requests (#809).
