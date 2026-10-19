Fixed

A shallow clone no longer notes every translation as behind: it gives one note for the run, that translations weren't checked, and that note never fails, even with `"translations": { "fail": true }`. The kit's `yokoten.yml` now checks out the whole history. A first line that names a URL or an absolute path, such as an attribution comment, is no longer read as a marker. The guide now names a known gap: a pull request that changes only the English, merged before one that changes both files, is not caught (#181).
