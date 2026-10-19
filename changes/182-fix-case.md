Fixed

`yokoten learn` drafts the fix the way it drafts the what: lower case at the start and no full stop at the end, so doctor's note `<what>; <fix>` reads as one sentence. A code span, an acronym (`CI`, `NO_PROXY`) or a word with a second capital (`GitHub`) keeps its case (#182).
