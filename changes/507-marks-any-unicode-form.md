Fixed

The privacy check and `yokoten redact` now find a private mark written in another Unicode form: é as one character or as e plus an accent, full-width letters such as `ｓａｍ`, a zero-width space inside or between words, and the Turkish capital İ. Both fold the mark and the text the same way before they match, and redact still replaces the exact place in the original text. Every line the check stopped before is still stopped, and a long run of accents takes linear time (#507).
