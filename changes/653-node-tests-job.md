Added

`yokoten init` writes a tests job for a Node project that has a test script. The install and the test command follow its lockfile: npm, pnpm, Yarn or Bun. With no lockfile, the job runs `npm install`. `yokoten doctor` shows the job as YAML you can paste. When the workflow file is missing, doctor says to run `yokoten init` (#653).
