Fixed

`yokoten check` no longer notes a translation as behind after parallel squash merges. A committed translation is current when the last commit that changed its line 1 is the same as, or later than, the last commit that changed its English source, in first-parent history. The blob on line 1 still decides before a commit, and still says how far behind (#155).
