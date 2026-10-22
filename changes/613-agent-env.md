Security

yokoten now prepares a clean environment for the agents it will start: the names every program needs, never your tokens or keys. A runtime names its own login variable, and only its agent gets it. `yokoten worker env` (not `doctor`) lists the names an agent would get, never the values. No command starts an agent with it yet: the board's "start an agent" (#603) will be the first (#613).
