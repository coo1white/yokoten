Fixed

The title limits, 72 for a pull request and 60 for an issue, now count the characters you
see, not UTF-16 code units. An emoji, a flag or a family emoji counts as one, and a Chinese
or Japanese character as one, so a title with emoji is no longer refused as far over the
limit when it is not. The message gives the same count, so you can tell how much to cut.
The bot's title check uses the same rule, so it counts the same way (#268).
