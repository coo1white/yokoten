Added

A worker in a desk can commit in its own clone (#736, Grok 4.7). The desk gets salted hashes of the private marks. The commit check matches hashed word windows and says so in one note. It never prints a mark. With no hash file, a worker's commit says the check waits for the lead's push. A push from that desk stops. The lead's push still reads the marks file, so a mark the hash check misses is still refused. Codex may write this clone's `.git`, and no other clone's.
