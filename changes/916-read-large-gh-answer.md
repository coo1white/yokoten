Fixed

`yokoten ci-health` reads an Actions run page larger than 1 MB again. The `gh` runner asked Node for 16 MB instead of its 1 MB default. A full page of 100 runs no longer fails as if the sign-in were wrong (#916).
