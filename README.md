# skillgate

> **A finish-line gate your agent cannot talk its way past.** AI coding agents deviate from your process to reach "done" faster, and asking the model to check its own compliance is the deviating party grading its own paper. `skillgate` is a deterministic evaluator that lives outside the model: it blocks the commit / push / publish until your definition-of-done actually passes. Works with **opencode** (any model you plug in), Claude Code, pre-commit, and CI.

```bash
npx skillgate check
```

```
  ✓ tests-pass        `npm test` exited 0
  ✓ no-secrets        no /sk_live_|ghp_.../ in **/*
  ✗ changelog-touched CHANGELOG.md missing /unreleased/i
  ✗ no-stray-todos    src/api.ts:42 matches /TODO|FIXME/

✗ 2 of 4 gates unmet: changelog-touched, no-stray-todos
```

Exit code 1, and in an agent harness the publish command never runs.

## Why

The check is a **pure function over the filesystem**: same inputs, same verdict, in milliseconds, with no model in the loop. That is the whole point. An LLM asked "is this done?" answers differently depending on the weather and has an incentive to say yes. A script does not. Because the judge is model-independent, it works the same whatever model you have plugged into your agent.

## Install

```bash
npm i -D skillgate     # for CI / pre-commit / Claude Code
# or just use npx, no install needed
```

## Define your gates

A gate is one deterministic, machine-checkable condition. Run `skillgate init` to drop a starter `.skillgate/done.yaml`:

```yaml
name: definition-of-done

# Commands that count as crossing the finish line (substring match).
finishLine:
  - "git commit"
  - "git push"
  - "npm publish"

gates:
  - id: tests-pass
    type: command            # must exit 0
    run: "npm test --silent"

  - id: changelog-touched
    type: file-contains      # file must match a regex
    file: CHANGELOG.md
    pattern: "unreleased"
    flags: "i"

  - id: no-stray-todos
    type: absent             # regex must NOT appear
    glob: "src/**/*.{ts,js}"
    pattern: "TODO|FIXME"

  - id: no-secrets
    type: absent
    glob: "**/*.{ts,js,json,md,yaml,yml,env}"
    pattern: "ghp_[A-Za-z0-9]{20,}|sk_live_|-----BEGIN [A-Z ]*PRIVATE KEY-----"
```

### Gate types

| Type | Passes when |
|---|---|
| `file-exists` | every `file` path exists (`file` may be a list) |
| `file-contains` | `file` matches `pattern` (optional `flags`, e.g. `i`) |
| `absent` | `pattern` appears in **no** file matched by `glob` (reports `file:line`) |
| `command` | `run` exits 0 — only as deterministic as the command |
| `evidence` | a named `file` exists and is non-empty |

**The `evidence` escape hatch.** Gates only see machine-observable output. For a step like "research the API first," have the agent write `.skillgate/evidence/research.md` as it works and gate on that file. Otherwise the step is invisible and the deviation hides.

## Wire it into your agent

### opencode

opencode has no blocking session-end hook, so enforcement lives where it can actually stop the agent: `tool.execute.before`. The plugin denies finish-line commands until the gates pass. Add it to your config:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["skillgate"]
}
```

That is the whole integration. Whatever model you have configured, the gate is the same.

### Claude Code

A `PreToolUse` deny on finish-line commands, calling the CLI:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "npx skillgate check --json >/dev/null || exit 2" }]
      }
    ]
  }
}
```

### pre-commit and CI — works for any agent or model

These need no harness integration at all, which makes them the universal backstop. See [`contrib/`](contrib/) for a ready [pre-commit hook](contrib/pre-commit-config.yaml) and [GitHub Action](contrib/github-action.yml). Pair the Action with branch protection and a required status check: that layer lives server-side, outside any agent's reach.

## The honest part: layers are not equal

| Layer | Strength |
|---|---|
| opencode / Claude Code deny | **Soft** — enforced locally; a locked-down harness permission profile makes it hold |
| pre-commit | **Soft** — bypassable with `--no-verify` |
| CI + branch protection | **Hard** — runs server-side, the agent has no write access to it |

Use the harness hooks for fast feedback in the loop; rely on CI for the guarantee.

## License

MIT © Rene Zander
