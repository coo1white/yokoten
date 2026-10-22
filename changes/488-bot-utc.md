Fixed

`yokoten bot --` runs its command with `TZ=UTC`. Then `gh` sends `Time-Zone: UTC`, and the commits GitHub makes, such as a merge, stay on UTC. The tool-call guard trusts `TZ=UTC` next to a post, as an `export` or a prefix. Any other zone or name is still refused (#488).
