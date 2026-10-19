Changed

When the GitHub `origin` remote belongs to an organization, `init` no longer writes that
organization as the CODEOWNERS owner: GitHub rejects a bare `@org`, so every line would be
an unknown owner. `init` asks `gh` once, writes the placeholder for an organization, and
says to put in a person or `@org/team`. Without `gh`, or when the call fails, the owner is
the remote account as before. Full `doctor` keeps the `codeowners` step to do while the
only owner is the organization (#313).
