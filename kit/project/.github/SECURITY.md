# Security

## Reporting a vulnerability

Please report it privately, not in a public issue. Go to this repo's **Security** tab
and choose **Report a vulnerability**. Only the maintainers see the report.

Include what you did, what happened, and what you expected. Add the version or commit
you used. Steps that show the problem help most.

## What not to put in a public issue

A public issue is open to everyone, at once. Don't put any of these in one:

- the details of a vulnerability, or how to use it;
- a password, token, key or other secret, even an old one;
- personal data about anyone.

If a secret is already public, say so in the private report. It must be revoked, not
only deleted.

## What counts

A vulnerability is a fault that lets someone do what they should not be able to do.
For example:

- run code on a machine or server that uses this project;
- read or change data they have no right to;
- get a secret, or get past a login or a permission check.

A bug that only breaks things, with no gain for an attacker, is a normal issue. Open
it in public.
