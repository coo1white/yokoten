Fixed

The guard's worker starts with a dynamic `import('node:module')` instead of `require`, so a guarded call works on Node 26.12.1, which runs that code as an ES module (#707).
