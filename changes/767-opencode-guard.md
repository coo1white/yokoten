Security

OpenCode now gets the same tool-call guard as the other agents (#767).
`init` writes `.opencode/plugins/yokoten.ts`.
`install` writes the user plugin when `~/.config/opencode` exists, or `$XDG_CONFIG_HOME/opencode` when that is set.
The plugin throws the guard's reason, and it refuses the call when the guard fails or times out.
`doctor` notes a project that has OpenCode and no plugin.
