Internal

The linear-time control test no longer fails on a busy machine. Its slow spell was 34 reads, sized for 34 reads a round.
A round's read count comes from one timed read, and a busy machine slows that read. Then the spell filled both rounds.
The control now takes 7 ms a read, so every round has exactly 3 reads, and the spell is those 3.
