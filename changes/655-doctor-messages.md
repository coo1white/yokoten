Fixed

`doctor` now gives a new project one order: make the repo, add the remote, push, then set the CODEOWNERS handle and the labels. The `remote` step counts only branches under `origin`. Its commit advice includes a message and says what `.yokoten/` is. The mailmap note says to run `yokoten install`, which writes the file and points git at it. A new lesson that passes says "a new check ran: ok" (#655).
