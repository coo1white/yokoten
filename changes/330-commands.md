Internal

Each command now lives in its own module under `src/commands/` (#330). `bin/main.ts` keeps only the help and the dispatch. Two branches that change different commands no longer meet in one file.
