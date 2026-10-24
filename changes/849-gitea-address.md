Internal

The Gitea adapter's doctor test reads the host it checks from the host under test, not
from a URL literal. Code scanning read the literal in `includes` as a URL check and
raised `js/incomplete-url-substring-sanitization`; the assertion still says the same
thing (#849).
