Fixed

The check before `gh` posts now reads every line of a heredoc body, even when its end word is unusual (#466).
Before, an end word such as `'E:F'` or `"E"OF` could make it read too little, or nothing, of the text gh would post.
Now, when the end word is not a plain name, it reads everything after that line.
