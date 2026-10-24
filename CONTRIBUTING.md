# Contributing

Thank you for helping. You don't need to be an expert: yokoten is for beginners, and
so is this guide.

## Report a problem or an idea

1. Search the [issues](https://github.com/yokoten-labs/yokoten/issues) first. Someone may
   have reported it already.
2. Open a new issue and pick a form:
   - **Bug report**: yokoten did something wrong, or stopped a command it should allow.
   - **Task**: a change you want made.
3. A security problem never goes in an issue. Follow [SECURITY.md](.github/SECURITY.md).

Before you paste output, remove anything private: names, emails, paths with your user
name, tokens.

## Change the code or the docs

All the rules are in [AGENTS.md](AGENTS.md). They are the same for people and for AI
agents. The short version:

1. Every change starts as an issue. Say what you want to do there first.
   Some issues are one line of work. That issue lists its tasks in priority order,
   top first. Read it before you pick a task.
2. Work on a branch, and open a pull request that links the issue.
3. Run the checks before you push:

   ```sh
   npm ci
   node --test
   npm run typecheck
   node bin/yokoten.ts check
   ```

4. Fill in the pull request form: why, what changed, how you tested it.
5. CI must be green. The owner reviews, then squash-merges.

You need Node 22.23.4 or later (24.22.1 on Node 24, 26.12.1 on Node 26), because older
releases have the security holes that Node fixed on 2026-10-21. There are no runtime
dependencies.

## Be kind

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md). To report a problem
with someone's behavior, write to [conduct@yokoten.app](mailto:conduct@yokoten.app).

## Learn more

- [The guide](docs/guide.md): what yokoten does, and every command.
- [Decisions](docs/records/): why it is built this way.
