Added

`yokoten check` refuses a file in `src/borrowed/` whose header lacks its source URL, upstream commit, license or copyright notice. It also refuses a license outside MIT, BSD-2-Clause, BSD-3-Clause, ISC and Apache-2.0. The source must be a GitHub file link, because the watch reads only GitHub. The new `yokoten borrowed` command compares each wheel with upstream's default branch. It opens one issue per changed source, and calls out a security fix. A commit missing from the upstream list is compared by date, so a snapshot opens no false issue (#676).
