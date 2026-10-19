Fixed

`yokoten bot -- <command>` no longer passes `NODE_TEST_CONTEXT` to the command. A
`node --test` that inherits it from a parent test run exits 0 even when a test fails
(#168).
