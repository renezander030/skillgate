# Recipes — wiring skillgate into the finish line

Every recipe enforces the *same* `.skillgate/done.yaml`, so you define "done" once and
reuse it everywhere. Ready-to-copy adapters live in [`contrib/`](../contrib).

## Claude Code (PreToolUse hook)

Make Claude Code unable to `git commit` / `git push` / `npm publish` until the gates
pass. The hook denies the finish-line command and feeds the failing gates back into the
same session, so Claude fixes the work instead of shipping it.

- Kit: [`contrib/claude-code/`](../contrib/claude-code) — hook script, `settings.json`, starter spec.
- Setup is ~60 seconds; see its [README](../contrib/claude-code/README.md).

## pre-commit

Block local commits until gates pass.

- Config: [`contrib/pre-commit-config.yaml`](../contrib/pre-commit-config.yaml).

```yaml
# .pre-commit-config.yaml
- repo: local
  hooks:
    - id: skillgate
      name: skillgate check
      entry: npx @reneza/skillgate@latest check
      language: system
      pass_filenames: false
```

## CI (GitHub Actions)

Gate every push and pull request.

- Reference workflow: [`contrib/github-action.yml`](../contrib/github-action.yml).

```yaml
- run: npx @reneza/skillgate@latest check
```

skillgate gates its own repo this way — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Loop + gate (retry until really done)

A retry loop's natural stop condition is the *model* saying it finished — the exact
signal you cannot trust. `loop-until-done.sh` makes `skillgate check` the stop
condition instead: the loop keeps going until a script, not the model, agrees.

- Script: [`contrib/loop-gate/loop-until-done.sh`](../contrib/loop-gate/loop-until-done.sh).

## Self-hosted git server (pre-receive)

Enforce the gate server-side on a VPS, so a push is rejected at the remote if the work
is not done — no client cooperation required.

- Kit: [`contrib/self-hosted-gate/`](../contrib/self-hosted-gate) — `pre-receive` hook,
  install script, and a Vagrant box to test it.

## Anywhere else

The CLI is the contract: `skillgate check` exits `0` when done, `1` when a gate fails,
`2` on a usage error. Anything that can read an exit code can gate on it.
