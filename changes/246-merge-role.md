Fixed

A worker can now bring main into its branch. In a merge, `check --staged` runs the
lead-only and fix-task test checks only on the files the merge itself changed: those whose
staged content differs from every parent, such as a conflict resolved by a new edit. A
lead-only file or a test that main changed no longer refuses the merge. The time-zone,
privacy, layout and build output checks still read every staged file. A MERGE_HEAD with a
line that is not a commit id is ignored, and a head that HEAD already leads to (a
fast-forward, not a merge) exempts nothing; in both cases every staged file gets the role
checks (#246).
