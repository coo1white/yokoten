Internal

The linear-time check sets how many reads it takes from the fastest of three small reads,
not one. The first read is cold, and a busy runner slows any single read (#359).
