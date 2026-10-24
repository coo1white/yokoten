Changed

The board starts queued work in dependency order (#709).
An issue waits until every issue on its "Depends on issue #N" line is closed.
The next ready issue comes from a priority heap: priority first, then the smallest issue number.
"Start next" starts the ready issues in that order.
The agent cap and the memory floor hold a start. The first issue that does not fit stops the list.
The queue's limits row sets the agent cap and the memory floor in MB.
The lead view shows the next ready issues, any cycle, and why a start waits.
A cycle is reported, never followed.
The longest open chain leads the timeline.
The board reads one issue past its limit, so a complete list still schedules.
DeepSeek (deepseek-v4.1-flash) made this change.
