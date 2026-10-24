Fixed

`yokoten init`, `yokoten doctor` and the hooks setup no longer stop with a RangeError on a very long line of package-runner flags, such as `npx -y -y ... yokoten check`. They now read the flags one word at a time (#431).
