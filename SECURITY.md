# Security Policy

## Supported versions

skillgate is pre-1.0. Security fixes land on the latest published `0.x` release on npm
(`@reneza/skillgate`). Please upgrade to the latest version before reporting.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's [private vulnerability reporting](https://github.com/renezander030/skillgate/security/advisories/new)
("Report a vulnerability" on the Security tab). If that is unavailable, email the
maintainer listed on the npm package page.

When reporting, include:

- the version (`skillgate --version`) and how you run it (npx / npm / CI / pre-commit),
- a minimal `.skillgate/done.yaml` and repo layout that reproduces the issue,
- the impact you observed.

You can expect an initial acknowledgement within a few days. Fixes are released as a
new patch version with a note in [`CHANGELOG.md`](CHANGELOG.md).

## Scope notes

skillgate runs `command`-type gates, which execute the shell command you put in your
own `done.yaml`. Treat a `done.yaml` from an untrusted source the same way you would
treat any script in that repo — review it before running `skillgate check`.
