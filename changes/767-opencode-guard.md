Security

OpenCode now gets the same tool-call guard as the other agents (#767).
`init` writes `.opencode/plugins/yokoten.ts`.
`install` writes the user plugin when `~/.config/opencode` exists, or `$XDG_CONFIG_HOME/opencode` when that is set.
OpenCode 2 denies the call in the permission hook, and throws from the shell hook as a backup.
OpenCode 1 still throws from `tool.execute.before`.
The plugin refuses the call when the guard fails or times out.
It also refuses a call that is not read-only when it cannot read a command or a path.
`doctor` notes a project that has OpenCode and no plugin.
