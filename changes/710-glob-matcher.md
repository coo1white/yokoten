Internal

The guard compiles a list of protected-path globs once and reads it in one pass, instead of compiling every glob on every ask (#710). The guard keeps its per-word Sets: at every list size measured, a Set beat a trie and Aho-Corasick (scripts/time/guard-words.ts).
