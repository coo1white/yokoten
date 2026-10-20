Changed

A newer CI run on main now cancels the one still going, as on a pull request (#442).
The newest run tests everything the older ones would have, so a merge no longer waits
behind runs that no longer matter. Projects get this on their next `init`.
