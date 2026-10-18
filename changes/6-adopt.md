Added

`yokoten adopt` drafts the adoption table for an old project. It reads files to find
what the project does today for each step (done, missing or partial), with no model.
Then Meta's model API (OpenAI-compatible, `muse-spark-1.3`) proposes as-is, lighter or
not now, with a reason. Only those short facts are sent, and only after the privacy
check passes. With no `LLAMA_API_KEY` or `MODEL_API_KEY`, a failed call or a bad answer,
rules draft it instead. `--json` prints the rows. It writes nothing; the user decides
every row. Kit change: the `yokoten` skill now runs `yokoten adopt` first (#6).
