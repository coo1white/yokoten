Fixed

doctor's tests step now counts more test commands in a workflow: `python -m unittest`,
`python -m pytest`, `tox`, `nox`, `make test`, and `vitest` or `jest` run through `npx`,
`pnpm exec` or `yarn`. In a repo with npm workspaces or a `pnpm-workspace.yaml`,
`npm test --workspaces`, `pnpm -r test` and `yarn workspaces run test` count too, with no
root test script. When the step is not done, it names package.json only when the project
has one; a Go or Python project is told which runner to add to a workflow (#257).
