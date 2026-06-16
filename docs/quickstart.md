# Quickstart

skillgate is a deterministic finish-line gate: it blocks `git commit` / `git push` /
`npm publish` until your definition-of-done actually passes. No model in the loop.

## 1. Audit (zero install, read-only)

See what your agent could cut right now, with no config:

```bash
npx @reneza/skillgate@latest audit
```

This writes nothing. It scores the repo against built-in defaults (or your
`.skillgate/done.yaml` if you have one) and exits non-zero if a corner is cuttable.

## 2. Define "done"

```bash
npx @reneza/skillgate@latest init     # writes .skillgate/done.yaml
```

Edit it. Each entry under `gates:` is one deterministic check. See the
[spec reference](spec-reference.md) for every gate type, and
[`schema/done.schema.json`](../schema/done.schema.json) for editor autocomplete
(the generated file already points at it via a `# yaml-language-server:` modeline).

## 3. Check

```bash
npx @reneza/skillgate@latest check    # exit 0 = all gates pass, 1 = something unmet
```

## 4. Wire it into the finish line

Pick the path that matches how far you want the guarantee to reach — Claude Code
hook, pre-commit, CI, or a retry loop. All of them enforce the *same*
`.skillgate/done.yaml`. See [recipes](recipes.md).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | All gates passed (or, for `drift`, everything in sync) |
| `1` | At least one gate failed / drift detected — the finish line is blocked |
| `2` | Usage error: no spec found, unknown command, or a spec that failed to load |

`--json` is available on `check`, `audit`, and `drift` for machine-readable output;
the exit code is unchanged.
