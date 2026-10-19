Internal

The linear-time test check reads the small and the big input in turns. A runner that
slows down for a while then slows both sizes, not only one. Over the limit, it measures
again and fails only if that round is over too (#343).
