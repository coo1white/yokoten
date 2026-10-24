Changed

Private marks are kept as salted hashes in `~/.config/yokoten/private-marks`, never as
words. The check finds a mark wherever the plain check found it: inside `jane_doe`,
`janeDoe` or a run of Chinese characters, in any Unicode form, and across a missing space
(`samsmith`). Each mark line carries its word and character counts, so a damaged file stops
the check instead of hiding a mark; a comment that holds a mark's words is not copied to
the hashed file. `install` moves an old plain file to hashes once, after the hashed file is
written and read back. An email the owner wrote as a mark still reaches the mailmap at that
moment. The desk now gets the hashed file read-only, so the commit check runs there (#665).
