Fixed

The suite's time budget gives a busy CI runner 50% more time for the same work, so a shared runner no longer fails a green suite. The slowest tests are still named, and a new child process per test still fails the child cap (#783).
