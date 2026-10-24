Internal

The Gitea adapter builds every read from a literal `https://` and the host it read, so
no address it asks for can be plain http. A path that would move the read to another
server is refused (#849).
