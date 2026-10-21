Added

`check --issue` also checks the issue's labels: one type label and one tier label,
when the repo has those labels. `yokoten bot` refuses a `gh issue create` without them
before it sends anything (#544).
