# AI Agent Reliability Checklist

Use this checklist before a coding agent is allowed to say a repo change is
done. The point is not a stronger prompt. The point is a finish line the model
does not control.

## The failure pattern

AI coding agents can produce a convincing final report while still leaving the
repo in a state that is unsafe to merge:

- the wrong file changed
- generated docs or projections are stale
- tests were skipped or only summarized
- a public output schema drifted
- an approval boundary is only prompt text
- a fixture, snapshot, log, or doc leaked a secret
- a public-facing change is marked complete without review

`skillgate` turns these into deterministic checks. The agent can propose the
change, but commit, push, publish, or release commands are blocked until the
configured gates pass.

## Ten checks

1. Build still passes.
2. Relevant tests pass.
3. The touched behavior has at least one explicit regression check.
4. Generated files or projections are verified by command, not manually patched.
5. No secrets appear in source, logs, fixtures, snapshots, or docs.
6. The diff is scoped to the requested behavior.
7. Output schemas remain backward compatible or include a migration note.
8. Outbound actions require a persisted approval record.
9. Public-facing or irreversible work leaves a human review artifact.
10. The final report names commands run, files changed, and residual risk.

## Quick score

Score each item:

- `0`: missing
- `1`: manual habit only
- `2`: deterministic check exists

Interpretation:

- `0-8`: demo-shaped agent workflow
- `9-15`: useful but fragile
- `16-20`: production-shaped workflow

## Repo starter

Start with [`examples/agent-definition-of-done.yaml`](../examples/agent-definition-of-done.yaml).
Copy it to `.skillgate/done.yaml`, replace the commands with the repo's real
build/test/generation commands, then wire the same spec through your agent hook,
pre-commit, and CI.
