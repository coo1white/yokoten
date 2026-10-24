Internal

`src/setup/init.ts` is now a folder of topic modules. Public names are unchanged; callers import `src/setup/init/index.ts` (#628). The split was merged with the newer `init.ts` on `main`, so each module also holds the changes `main` made while the split was open.
