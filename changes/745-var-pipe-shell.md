Security

The guard refuses a download piped into a program named by a variable, or into `eval`.
`curl … | jq "$filter"` still passes, because the variable is only an argument (#745).
