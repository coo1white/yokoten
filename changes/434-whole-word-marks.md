Changed

A private mark made of letters and spaces, such as a name or a city, is now found as whole
words only (#434). `sam` is still found in `hi Sam`, `sam_dev` and `@sam`. It is no longer
found in `sample` or `Samsung`. So the git name that install adds doesn't stop commits that
hold a longer word. The words of a longer mark may have spaces, `-`, `_` or `.` between them.
A domain, an address, a number, or a name in a script written with no spaces is still found
anywhere.
