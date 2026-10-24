Internal

A workflow folder is now read directly, in a `try`, so a check-then-read cannot race
with a folder that goes away; an absent folder reads as no workflow file, as before
(#849). A remote's owner and name are cut from the path instead of chained replaces, and
a host named `__proto__` reads as "this host", not a key from the label table. The Gitea
adapter's test token is built at run time, so the test file holds no key-shaped string
for code scanning to flag.
