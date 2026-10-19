Fixed

Codex, Muse Code and Copilot CLI skip a project's hooks without a word until you trust the folder.
`doctor` now reads each agent's own trust store, read-only and offline, and notes a folder it does not trust yet.
It checks an agent only when the agent's home folder is there, so other users hear nothing.
The note names the one step that trusts it; a store doctor can't read is "can't check", never ok.
For Codex, doctor also checks that both yokoten hooks are trusted as they are now.
`init` prints the trust step for each of the three agents (#341).
