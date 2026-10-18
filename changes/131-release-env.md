Added

The npm package publishes only from a `release` environment that the owner approves. A
`v*` tag runs the checks, then the publish job waits for the owner. It uses npm trusted
publishing with provenance, so no npm token is stored. The first release is published
by hand, because npm can't trust a workflow for a package it does not have yet. The
`release` skill tells the owner to approve the publish job (#131).
