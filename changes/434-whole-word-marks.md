Changed

A private mark made of letters and spaces, such as a name or a city, is now found as whole
words only (#434). Only a letter next to it hides it. `sam` is still found in `hi Sam`,
`sam_dev`, `@sam`, `sam97`, `githubSam` and after `\n` or `%5C`. It is no longer found in
`sample` or `Samsung`. So the git name that install adds doesn't stop commits that hold a
longer word. The words of a longer mark may have spaces, `-`, `_` or `.` between them, or
nothing. `redact` hides a mark by the same rules. A domain, an address or a number is still
found anywhere. So is a name in a script that joins words onto names, such as Korean.
