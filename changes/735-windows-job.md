Fixed

On Windows, a done-when check stops programs it left running after `cmd.exe` exits (#735). On Linux and macOS, a check that ends also stops a program in a new process group in its session. A program that has already started its own session, such as `setsid`, is still left running. If Windows PowerShell is missing or blocked, the check runs `cmd.exe` as before.
