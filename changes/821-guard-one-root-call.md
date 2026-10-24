Fixed

The tool-call guard asks git for the repository root once, not twice, on an allowed command. Every guarded call is a few milliseconds faster, and the guard's 100 ms budget is unchanged (#821).
