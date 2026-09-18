---
name: skillgate
description: Set up, run and respect a machine-checked definition of done. Use when the user mentions a definition of done, finish-line or commit/push gates, "the agent said done but it wasn't", wants to audit what a repo enforces, wire a PreToolUse or pre-commit or CI gate, verify a patch before it touches the working tree, collect evidence files, or fix drift between CLAUDE.md, AGENTS.md, Cursor and Copilot instruction files. Also use before reporting work finished in a repo that has a .skillgate/done.yaml.
---

# skillgate

Deterministic gates that decide when work is actually finished. No model judges the
result: gates are declared as data in `.skillgate/done.yaml` and evaluated by running
commands and inspecting files. Exit codes are the contract — `check` exits 1 on failure,
`gate` exits 2 to block a command.

Every command below runs with no install: `npx @reneza/skillgate <command>`. In a project
that has it as a devDependency, drop the `npx @reneza/` prefix.

## Start here

```bash
npx @reneza/skillgate audit      # read-only, no config: what would let a patch through unfinished
```

`audit` needs no `.skillgate/done.yaml`. It reports against built-in defaults and is the
right first command in an unfamiliar repo. Report its output to the user before changing
anything.

## Wire the gate in

```bash
npx @reneza/skillgate init                     # write a starter .skillgate/done.yaml
npx @reneza/skillgate install claude-code      # fail-closed PreToolUse hook in .claude/settings.json
npx @reneza/skillgate install all              # claude-code + opencode + github-actions + pre-commit
npx @reneza/skillgate doctor all               # policy + integration health check
```

`install` is idempotent and pins generated npm commands to the installed version. Prefer
it over hand-editing `.claude/settings.json`.

Layers are not equal, and the user should know which one they picked: a PreToolUse hook is
fast feedback inside the loop and the agent's own environment can undo it; pre-commit is
bypassable with `--no-verify`; CI with branch protection is the layer that actually holds.
Recommend CI as the backstop whenever the repo is shared.

## Run the gate

```bash
npx @reneza/skillgate check                    # exit 1 if any gate fails
npx @reneza/skillgate check --json             # machine-readable results
npx @reneza/skillgate check --pin              # read the spec from the base ref, not the working tree
npx @reneza/skillgate check --timeout 600000   # budget for the whole run
npx @reneza/skillgate explain --command "git push"   # why a command does or does not hit the finish line
```

**Run `check` before telling the user the work is done** in any repo that has a
`.skillgate/done.yaml`. If it fails, fix the cause and run it again.

**Never route around a failing gate.** Do not pass `--no-verify`, do not disable the hook,
do not edit `.skillgate/done.yaml` to make a failure go away, and do not use `--override`
unless the user explicitly asks for it in that message. A gate that blocks is the system
working. Report which gate failed and what it asked for.

## Verify a patch before it lands

```bash
npx @reneza/skillgate verify-patch     # evaluate the uncommitted patch in a fresh, network-off clone
npx @reneza/skillgate verify-apply     # land it, only after verify-patch passed
```

The spec is read from committed HEAD, so a patch cannot weaken the gates that judge it. A
patch that edits the definition of done never auto-applies.

## Gate types

Gates live under `gates:` in `.skillgate/done.yaml`; `finishLine:` lists the command
prefixes that trigger them (`git commit`, `git push`, `npm publish`).

| Type | Passes when |
|---|---|
| `file-exists` | every `file` path exists (`file` may be a list) |
| `file-contains` | `file` matches `pattern` (optional `flags`, e.g. `i`) |
| `absent` | `pattern` appears in no file matched by `glob` (reports `file:line`) |
| `command` | `run` exits 0 — only as deterministic as the command |
| `trivy` | Trivy finds no leaked secrets and no blocking CVEs |
| `evidence` | a named `file` exists and is non-empty |
| `not-empty` | a directory at `path` holds at least `min` entries |
| `instruction-sync` | the agent instruction files still agree with the canonical one |

Gates only see machine-observable output. For a step like "read the API docs first", have
the agent write `.skillgate/evidence/research.md` while working and gate on that file —
otherwise the step is invisible. `skillgate scaffold --template <generic|ts-lib|react|python>`
generates the evidence files, `--update-agents` writes the workflow into AGENTS.md/CLAUDE.md.

Full spec: https://github.com/renezander030/skillgate/blob/master/docs/spec-reference.md

## Keep instruction files in sync

```bash
npx @reneza/skillgate drift                 # exit 1 if CLAUDE.md, AGENTS.md, Cursor, Copilot diverged
npx @reneza/skillgate diff-instructions     # line-level diff of what changed
npx @reneza/skillgate canonical <file>      # pin the single source of truth
npx @reneza/skillgate sync                  # make AGENTS.md canonical, link the rest
```

## Reading results

- `check`: exit 0 pass, exit 1 at least one gate failed.
- `gate`: exit 0 allow, exit 2 block. Fails closed on error unless `--allow-on-error`.
- A gate that cannot start is reported as a blocking `not-run`, never as a pass.
