Added

`init` writes DeepSeek Harness's tool-call guard into `.dsh/hooks.json`, and a launch patch into `.dsh/yokoten.patch.yml`.
It prints the two `dsh plugin add` commands each profile needs, and installs nothing.
`doctor` notes them as `deepseek-harness-hook`, and looks for the bridge in the dsh profiles.
A worker may not edit `.dsh/` by default (#334).
On Windows dsh runs hooks in PowerShell, so it is not guarded yet; `doctor` and `init` say so (#332).
