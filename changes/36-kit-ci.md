Internal

A test now holds every workflow that `init` writes, and this repo's own, to one
standard: each action pinned to a commit with its version in a comment, a time limit on
every job, no token kept by checkout, and one `ci` job that needs every other job. A
known-bad workflow shows that the test catches each problem (#36).
