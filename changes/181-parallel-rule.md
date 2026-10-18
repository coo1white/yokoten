Fixed

A translation is no longer called current when another pull request changed only the English: a commit that changes the English and the translation together no longer hides an English-only commit before it, and only a commit that changes only the translation counts as catching up (#181).
