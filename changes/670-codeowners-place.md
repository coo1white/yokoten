Security

`yokoten bot` no longer reads a later CODEOWNERS file when an earlier place fails or is over 64 KiB. Only a real HTTP 404 moves on to the next place. Any other failure refuses the merge (#670).
