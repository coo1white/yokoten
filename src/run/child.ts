// The environment for a child process that may run tests (#168).
//
// `node --test` sets NODE_TEST_CONTEXT for the test files it starts. A `node --test` that
// inherits it reports to that parent run instead, and exits 0 even when a test fails.
import type { Env } from '../rules/config.ts';

/** A copy of `env` that a child `node --test` cannot mistake for a parent test run's. */
export function cleanChildEnv(env: Env): Env {
  const clean = { ...env };
  delete clean.NODE_TEST_CONTEXT;
  return clean;
}
