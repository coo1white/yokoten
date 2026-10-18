Fixed

doctor's tests step now counts more test commands in a workflow: `python -m unittest`,
`python -m pytest`, `tox`, `nox`, `make test`, and `vitest` or `jest` run through `npx`,
`npm exec`, `pnpm` or `yarn`, with `uv run`, `poetry run`, `pipenv run` or
`coverage run -m` before a Python runner. It reads only the commands in `run:` steps, so a
job named `jest`, a matrix item, `make test-deps` or `npx jest --version` is not a test run,
and a big workflow no longer makes doctor hang. In a repo with npm workspaces or a
`pnpm-workspace.yaml` and no root test script, a command that runs each package's tests
counts (`npm test --workspaces`, `pnpm -r test`, `yarn workspaces run test`), and plain
`npm test` does not. When the step is not done, it names package.json only when the project
has one; a Go or Python project is told which test command a workflow should run, and a
workspaces root to run each package's tests (#257).
