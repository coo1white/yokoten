Security

The guard refuses a `find` that deletes when nothing keeps it out of `.git` (#744).
A prune of `.git`, an exclusion of its files, or a start folder that cannot hold it still passes.
