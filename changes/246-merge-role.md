Fixed

A worker can now bring main into its branch. In a merge, `check --staged` runs the
lead-only and fix-task test checks only on the files the merge itself changed: those whose
staged content differs from every parent, such as a conflict resolved by a new edit. A
lead-only file or a test that main changed no longer refuses the merge. The time-zone,
privacy, layout and build output checks still read every staged file (#246).
