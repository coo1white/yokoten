Added

`yokoten check --anchor` checks each past day of the event log against its hash in Sigstore Rekor, and names the day when the log no longer matches (record 0029, #768).
Only the day's 64 hex characters leave the machine; the anchor workflow signs them with its own OIDC identity, and there is no new runtime dependency.
