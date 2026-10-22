Fixed

Two linear-time tests no longer fail on a busy runner. The 100k-words guard test and the `normalizeRemote` test now share one call per test. A noisy first round then grows to a steady 20 ms base. A quadratic read still fails (#594).
