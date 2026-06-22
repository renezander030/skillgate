# Spec reference — `.skillgate/done.yaml`

A spec is a YAML (or JSON) file. skillgate looks for it at, in order:
`.skillgate/done.yaml`, `.skillgate/done.yml`, `.skillgate.yaml`, `.skillgate.yml`,
`.skillgate.json`. A machine-readable JSON Schema lives at
[`schema/done.schema.json`](../schema/done.schema.json).

## Top-level fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `gates` | array | yes | The deterministic checks. Order is preserved in output. |
| `finishLine` | string[] | no | Commands that count as crossing the finish line (substring match). Used by the agent integrations. |
| `name` | string | no | A label for this definition of done. |
| `version` | integer | no | Spec format version. Omit for the current format. See [compatibility](compatibility.md). |

## Gate types

Every gate has an `id` (string, shown in output) and an optional `description`.

### `file-exists`

Every listed path must exist.

```yaml
- id: docs
  type: file-exists
  file: [README.md, LICENSE]   # string or array of strings
```

### `file-contains`

A file must contain a regex match — a required section, an exact phrase, a version bump.

```yaml
- id: changelog-touched
  type: file-contains
  file: CHANGELOG.md
  pattern: "unreleased"
  flags: "i"                   # optional JS regex flags
```

### `absent`

A regex must **not** appear in any matched file. Reports the first `file:line` hit.
Ideal for stray TODOs and committed secrets.

```yaml
- id: no-secrets
  type: absent
  glob: "**/*.{ts,js,json,md,yaml,yml,env}"
  pattern: 'sk_live_[A-Za-z0-9]{16,}'
  ignore: [".skillgate/**"]    # optional extra excludes
```

`node_modules/`, `.git/`, and `dist/` are always ignored.

### `command`

A shell command must exit 0. Only as deterministic as the command itself — prefer
test/lint/build commands, not anything that hits the network.

```yaml
- id: tests-pass
  type: command
  run: "npm test --silent"
  timeout: 60000               # optional, default 30000 (30s)
```

On timeout the gate returns a deterministic `command timed out after Nms` reason.

### `evidence`

The escape hatch for steps that are not machine-observable ("research X first"): the
agent writes a named file as it works, and the gate verifies the file exists and is
non-empty.

```yaml
- id: research-recorded
  type: evidence
  file: .skillgate/evidence/research.md
```

### `not-empty`

A directory must contain at least `min` entries (files or subdirectories). Catches
agents that claim a step is done but leave an empty `evidence/`, `docs/` or `dist/`
directory.

```yaml
- id: evidence-not-empty
  type: not-empty
  path: docs/api
  min: 3                    # optional, default 1
```

### `instruction-sync`

Every AI instruction file in the repo (CLAUDE.md, AGENTS.md, `.cursor/rules`,
copilot-instructions.md, …) must still agree with the canonical one. Drift means your
agents are reading different rulebooks. Run `skillgate sync` to fix.

```yaml
- id: instructions-in-sync
  type: instruction-sync
  threshold: 0.95              # optional, 0..1, default 0.95
```

## Determinism contract

Every gate is a pure function over the filesystem: same inputs, same verdict, in
milliseconds, with no model in the loop. A `command` gate inherits the determinism of
the command you give it — keep them hermetic.
