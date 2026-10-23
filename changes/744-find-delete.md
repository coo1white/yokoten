Security

The guard refuses a `find` that deletes when nothing keeps it out of `.git` (#744).
A prune of `.git`, an exclusion of its files, or a start folder that cannot hold it still passes.
A delete whose characters name git storage, but match no sample, is refused too.
That covers a loose object, a pack index, and a ref other than the samples.
