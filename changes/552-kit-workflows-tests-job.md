Fixed

`yokoten doctor` no longer reports a `kit-workflows` note after you add a job to `.github/workflows/yokoten.yml` the way its tests step says. A job you add under `jobs:`, and its name in the `needs` list of `ci`, stays yours: only the kit's own jobs falling behind says so (#552).
