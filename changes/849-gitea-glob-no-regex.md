Internal

The Gitea adapter matches branch and tag patterns by walking the strings, not by
building a regular expression from a server's pattern. Code scanning flagged the
older form, which could backtrack for a long time (#849).
