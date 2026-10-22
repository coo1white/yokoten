Fixed

The linear-time tests no longer fail when a busy test runner pauses them. They now judge how the CPU time of a read grows, not its wall-clock time, and still catch a quadratic read (#648).
