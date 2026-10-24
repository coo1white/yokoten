// The GitHub adapter. Everything yokoten knows about GitHub's API lives in src/host/
// (record 0004); a rule or a step names what it needs in host-neutral words.
//
// This module keeps the adapter's public names in one place, so callers change only
// their import path when the parts move:
// - the bot, and the title a `gh issue` or `gh pr` command sets;
// - the pull request and the issue of a CI run, and the CODEOWNERS file;
// - the findings of a check on the pull request page;
// - labels and milestones (the planning setup);
// - the server settings, read only;
// - the pull requests on the board.

export * from './approval.ts';
export * from './board-pulls.ts';
export * from './bot.ts';
export * from './planning.ts';
export * from './pull-request.ts';
export * from './server.ts';
