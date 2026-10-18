Added

`init --github` also adds one label per area in `yokoten.json` "areas", in one neutral grey,
when there are at most 8 areas. It never changes or deletes an area label. The new `--board`
flag makes a board linked to the repo, with the Status options Todo, In progress, In review and
Done; without the gh token's `project` scope it says to run `gh auth refresh -s project`.
Both are safe to run twice. When a board is linked, `doctor` lists what to set by hand: the
views and the built-in workflows (#156).
