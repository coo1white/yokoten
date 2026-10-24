Added

The board shows what each agent used and what it would cost on the vendor's API, read from the session logs already on this machine (#611). Each row is an agent, model and day, with input, cached and output tokens, filtered by role or vendor. A model with no price, or a log without token counts, says "partial". `yokoten board --text` prints the same rows.
