Added

A desk reads the model and provider an agent's config names, so the session starts with
one line saying who the agent really is when the model is not the harness's own vendor,
and the board shows the real model rather than the harness default (#748). A Codex desk
on a DeepSeek model now tells its agent that Codex is the tool, not its maker.

`check --pr` also notes a `Made with` line whose worker model is not the one the worker's
status file on that branch names, so a wrong signature is seen before the pull request
merges. This note needs the worker's desk, so it runs on the worker's machine, not in CI.
A desk command's `--model` wins over the config's model, and the team roster and
`YOKOTEN_MODEL` name the same one.
