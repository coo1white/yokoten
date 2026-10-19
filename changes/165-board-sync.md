Internal

The `board` workflow fills the org board's Start, Target and Status every hour, on issue events and on each push to `main`, so no one runs a script by hand. It runs `scripts/board-sync.ts` as the bot (#165).
