Changed

`yokoten install` keeps a skill or agent you edited, and says where the new copy is. `yokoten uninstall` keeps it too, and `yokoten doctor` names an edited file whose kit copy has changed, with the `diff` command to compare them (#477).

A file from an older yokoten has no hash, so the next install replaces it once, edit or not. After that it has a hash, and your edits stay.
