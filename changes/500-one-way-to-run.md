Fixed

Doctor now names one way to run yokoten in every line. When no `yokoten` command on the PATH runs the installed copy, or yokoten started with `npx`, every command reads `npx yokoten ...`. Otherwise it reads `yokoten ...`. The note about the missing launcher gives the one line that fixes the PATH. It says that `npx yokoten` works meanwhile. It no longer tells you to type the path of the runtime (#500).
