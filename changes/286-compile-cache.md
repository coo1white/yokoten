Fixed

The guard starts faster. yokoten now turns on Node's compile cache, in the main thread and
in the worker that reads each tool call, so a run reuses the compiled modules of the last
one. Twenty `ls` checks took a median of about 85 ms instead of about 125 ms. The cache
lives in the system temp folder, Node keys it by file content, so an edited file is never
served stale, and `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` work as Node
documents them. A cache folder that can't be written is ignored (#286).
