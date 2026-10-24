Fixed

`git merge` runs the commit check before git writes `MERGE_HEAD`. The check now reads the merge's other parent from the hook's env. So a worker's clean merge of main no longer counts main's lead-only edits as the worker's (#549).
