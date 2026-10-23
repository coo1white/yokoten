Security

The guard refuses `find -delete` and `find -exec rm` when a test can name `.git` (#573).
It also refuses a null-split `xargs` when one word can be `.git`.
