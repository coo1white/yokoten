Fixed

On Windows, a done-when check stops programs it left running after `cmd.exe` exits (#735). A program that starts its own session, such as `setsid`, is still left running.
