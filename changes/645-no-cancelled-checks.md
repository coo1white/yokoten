Fixed

The `pr` check now shows the true result for a pull request as it is now, whatever order its runs start in. In `pr.yml`, `check --pr` reads the title, body, labels and milestone from GitHub when it runs, not from the event. So a run that starts late judges the labels added since, and a rerun judges the pull request again. No pull request run is cancelled or skipped, so a cancelled run no longer shows as a failure, and a skipped run can't hide one. A draft is checked like any pull request. If the read fails, the check fails (#645).
