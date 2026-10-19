Internal

The linear-time tests in `test/setup/road.test.ts` prove linear time by how the time grows from an
input of size n to 8n (at most 24x, where quadratic gives about 64x), with a 30 s ceiling
against a hang, instead of a 2 s wall-clock limit that a slow CI runner can miss (#315).
