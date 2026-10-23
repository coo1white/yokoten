Fixed

`yokoten board` shows the local agents at once, instead of "Loading" for 5 to 9 seconds after each refresh. gh now reads the pull requests and issues in the background, one read at a time, and the page shows the last lists it read. Until the first read ends, they say "Reading GitHub…". A failed read keeps the last lists and says when they were read. The board also asks GitHub for less: the open pull requests and the last 10 merged, with checks only for the open ones (#688).
