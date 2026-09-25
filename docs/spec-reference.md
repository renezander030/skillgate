# Spec reference — `.skillgate/done.yaml`

A spec is a YAML (or JSON) file. skillgate looks for it at, in order:
`.skillgate/done.yaml`, `.skillgate/done.yml`, `.skillgate.yaml`, `.skillgate.yml`,
`.skillgate.json`. A machine-readable JSON Schema lives at
[`schema/done.schema.json`](../schema/done.schema.json).

## Top-level fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `gates` | array | yes | The deterministic checks. Order is preserved in output. |
| `finishLine` | string[] | no | Command prefixes that cross the finish line, matched structurally by agent integrations. |
| `name` | string | no | A label for this definition of done. |
| `version` | integer | no | Spec format version. Omit for the current format. See [compatibility](compatibility.md). |
| `timeout` | positive integer | no | Total wall-clock budget for one run in milliseconds. Defaults to 300000. |

`finishLine` uses structural shell matching. Each unquoted command segment is
tokenized, common wrappers and executable suffixes are normalized, and the command
prefix is compared with the configured pattern. This catches `env CI=1 git push`,
`git -C repo commit`, nested `sh -c`/PowerShell commands, and Windows `.cmd`
launchers without matching quoted prose. Run `skillgate explain --command "..."`
to inspect the decision without executing gates.

Runtime loading enforces the same closed shape as the JSON Schema: unknown fields,
unsupported gate types, duplicate IDs, invalid regexes, invalid option values, and
empty gate lists are rejected before any gate runs. A configured but invalid policy
blocks agent hooks rather than being ignored.

## Gate types

Every gate has an `id` (string, shown in output), an optional `description`, and
an optional [`when`](#conditional-gates-when) block.

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

A glob that matches no files fails the gate: a typo'd glob would otherwise pass
forever as a no-op. Set `allowEmpty: true` when an empty match is expected. The
same rule applies to `no-new`, `no-fewer` and `no-deleted`.

Pattern gates (`file-contains`, `absent`, `no-new`, `no-fewer`) read at most
`maxBytes` per file (default 10 MiB). A larger file fails the gate with its size
rather than being skipped. Exclude it with `ignore` or raise `maxBytes`. They also
stop at the run's `timeout` and report how many files they scanned.

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

### `trivy`

Run Trivy as a first-class security gate. By default this blocks on any leaked
secret, any `CRITICAL` vulnerability, or failure to generate a CycloneDX SBOM.

```yaml
- id: trivy-clean
  type: trivy
  target: "."                 # optional, default "."
  scanners: ["vuln", "secret"] # optional, default shown
  severity: ["CRITICAL"]       # optional, vulnerability scan only
  sbom: true                   # optional, default true
  timeout: 120000              # optional, per Trivy invocation
```

The secret scan runs separately from the vulnerability scan, so CVE severity
filtering does not hide leaked credentials. Set `trivy` when the binary is not on
`PATH`, or `ignoreUnfixed: true` when the vulnerability policy should ignore
unfixed CVEs.

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
agents are reading different rulebooks. Run `skillgate sync` to fix, or
`skillgate diff-instructions` to see exactly what changed.

```yaml
- id: instructions-in-sync
  type: instruction-sync
  threshold: 0.95              # optional, 0..1, default 0.95
```

### `no-new`, `no-fewer`, `no-deleted` (diff-aware)

These gates compare the working tree with the commit the change forked from
(`--base <ref>`, `SKILLGATE_BASE`, or origin's default branch). Without a resolvable
base they fail closed. The one exception is a repository with no commits at all: its
first commit is judged against the empty tree.

```yaml
- id: no-new-skips               # count must not increase
  type: no-new
  glob: "**/*.test.ts"
  pattern: '\.(skip|only)\('

- id: tests-kept                 # count must not decrease
  type: no-fewer
  glob: "**/*.test.ts"
  pattern: '^\s*(it|test)\('

- id: tests-not-deleted          # every file at the base must still exist
  type: no-deleted
  glob: "test/**"
```

`no-fewer` catches a suite made green by deleting test cases inside files that
still exist, which `no-deleted` (whole files) and `no-new` (added skips) miss.

### `deps-locked`

Every dependency declared in a manifest must be present in its lockfile. A
package that never resolved from a registry, such as a hallucinated name, cannot
be in the lockfile, so this catches it offline and deterministically.

```yaml
- id: deps-locked
  type: deps-locked
  manifest: package.json        # optional; default: every supported manifest at the root
```

Supported: `package.json` with `package-lock.json`, `npm-shrinkwrap.json`,
`pnpm-lock.yaml`, `yarn.lock` or `bun.lock` (dependencies, devDependencies and
optionalDependencies; `file:`/`link:` specs are skipped), and `pyproject.toml`
(`[project]` dependencies, optional dependencies and Poetry tables) with `uv.lock`,
`poetry.lock` or `pdm.lock`. No manifest or no lockfile fails the gate.

## Conditional gates (`when`)

`when` limits where a gate applies. Every listed condition must hold. Within a
list, any entry may match. A gate whose condition does not hold is reported as
`skipped` and never blocks.

```yaml
- id: full-suite
  type: command
  run: npm run test:all
  when:
    command: ["git push", "npm publish"]  # required for push/publish, not every commit
    changed: ["src/**", "package.json"]   # only if one of these changed vs the base
    branch: ["main", "release/*"]         # only on these branches
```

- `command` is matched structurally like `finishLine`. `skillgate gate` judges the
  agent's command. `skillgate check --command "git push"` evaluates as if for that
  command. A plain `check` has no command, so every gate applies.
- `changed` compares committed, staged, unstaged and untracked files against the
  base ref.
- `branch` uses `SKILLGATE_BRANCH`, else the checked-out branch, else the CI branch
  (`GITHUB_HEAD_REF`, `GITHUB_REF_NAME`).

A condition skillgate cannot decide (no base ref, no branch) runs the gate. An
unknown never skips enforcement. Pin the policy with `--pin` so a change cannot
add a `when` that exempts itself.

### `skillgate init` now defaults

Starting with v0.5.0, `skillgate init` generates a template that includes the
`instruction-sync` gate and a commented-out `evidence` gate example. Every new
project starts with drift detection enabled and an evidence workflow ready to
activate — no opt-in required.

## Scaffold templates (`skillgate scaffold`)

The `skillgate scaffold` command generates `.skillgate/evidence/` with expected
files for the agent to write before crossing the finish line. It also creates a
README explaining the evidence workflow.

```bash
skillgate scaffold                          # generic evidence files
skillgate scaffold --template react         # React / Next.js stack
skillgate scaffold --template ts-lib        # TypeScript library
skillgate scaffold --template python        # Python application
skillgate scaffold --update-agents          # also update AGENTS.md/CLAUDE.md
```

Each template generates:
- `test-output.txt` — save test runner output here
- `lint-report.txt` — save linter output here
- `diff-review.md` — self-review of changes
- `README.md` — explains the evidence workflow to the agent

Stack-specific templates add files like `typecheck-output.txt` (ts-lib, react, python)
or `coverage-summary.txt` (ts-lib).

### `--update-agents`

When passed, `skillgate scaffold` also appends (or creates) workflow instructions in
AGENTS.md (or CLAUDE.md if AGENTS.md is absent) that tell the agent to:
1. Run checks and save output to the evidence files
2. Write a self-review of changes
3. Run `npx skillgate check` before crossing the finish line

## Determinism contract

Every gate is a pure function over the filesystem: same inputs, same verdict, in
milliseconds, with no model in the loop. A `command` gate inherits the determinism of
the command you give it — keep them hermetic.

Policy discovery starts in the requested directory and walks upward only to the
current Git worktree root. Gates run relative to the directory that owns the policy,
so calling `skillgate check` from a nested package cannot accidentally use paths from
the main checkout or a parent repository.

The run budget applies across all gates. A per-command `timeout` is capped by the
remaining total budget, and a timed-out command's supervised process tree is
terminated. Any gates that could not start are returned as blocking `not-run`
results, preserving one result per configured gate.

`skillgate check --receipt <file>` writes a versioned JSON receipt with the workspace
snapshot, per-gate status/reason/duration, and total budget. `--cache` stores a passing
receipt outside the working tree and reuses it only for the same parsed policy,
runtime, base commit, and repository snapshot. Failing results are never cached.
