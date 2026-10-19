Fixed

`doctor` now counts a workflow that uses the yokoten Action, as the guide shows it: the
`ci` step is done, and the `titles` step too when the workflow runs on pull requests and
the step doesn't set `pr-check: false`. A workflow that runs `npx yokoten check` (or
`bunx`, `pnpm dlx`) counts as well. Before, a repo that followed the guide stayed on
stage 2, and `init` kept the existing workflow, so the advice went round in a circle (#298).
