Internal

`assertLinear` times each size by its fastest read, and takes 0.5 ms as the smallest base: a
total over many reads grew past 24x from GC alone, and a linear read under 0.5 ms showed 27x
from cache effects alone (#321, #324, #326).
