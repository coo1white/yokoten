Fixed

`yokoten adopt` marks `tests` done only when the project has tests: a test folder, test files for its language, or a test script. A repo with only a project file is missing, and names the command to use once tests exist (#551).
