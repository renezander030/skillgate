# Architecture

skillgate is a small, zero-runtime-dependency-by-design TypeScript CLI. The whole tool
is a pure function from (filesystem + spec) to a verdict.

## The one idea

An LLM asked "is this done?" answers differently depending on the weather and has an
incentive to say yes. A script does not. So the judge of "done" must live **outside**
the model and observe behaviour deterministically. That is the entire design. See the
README for the research basis (the Compliance Gap).

## Modules (`src/`)

| File | Responsibility |
|------|----------------|
| `cli.ts` | Argument parsing and the `audit` / `check` / `init` / `scaffold` / `drift` / `diff-instructions` / `canonical` / `sync` commands. Owns all process output and exit codes; it is the only module that talks to the terminal. |
| `spec.ts` | The spec types, `findSpecPath()` (where a `done.yaml` may live), and `loadSpec()` (parse + validate, including the optional `version` field). |
| `core.ts` | `runGates()` — the deterministic evaluator. One `case` per gate type in `checkGate()`. `isFinishLine()` decides whether a command crosses the line. **This is the pure heart; it never reads argv or writes output.** |
| `drift.ts` | Instruction-file drift detection (similarity of CLAUDE.md / AGENTS.md / Cursor / Copilot / …). Powers the `instruction-sync` gate and the `drift` / `diff-instructions` commands. Also exports `lineDiff()` and `formatDiff()` for showing line-level changes between instruction files. |
| `link.ts` | `runSync()` — makes one instruction file canonical and links the rest. Powers `sync`. |
| `scaffold.ts` | `runScaffold()` — generates `.skillgate/evidence/` directory with stack-specific evidence file templates and optionally updates agent instruction files. Powers `scaffold`. |
| `plugin.ts` | The opencode plugin entry point that denies finish-line commands until gates pass. |

## Data flow

```
spec file ──loadSpec──▶ Spec ──┐
                               ├─▶ runGates(spec, cwd) ─▶ RunResult ─▶ cli formats + exit code
working tree (cwd) ────────────┘
```

`runGates` is intentionally side-effect-free: it takes a `Spec` and a directory and
returns `{ passed, results, failed }`. Everything that touches the terminal, the
process exit code, or temp files lives in `cli.ts`. That split is what makes the core
trivially testable (`test/core.test.ts`, `test/spec.test.ts`) and lets the CLI be
covered end-to-end as a real process (`test/e2e.test.ts`).

## Adding a gate type

1. Add an interface to the `Gate` union in `src/spec.ts`.
2. Add a `case` to `checkGate()` in `src/core.ts` returning `{ id, type, ok, reason }`.
   Give a clear `reason` (ideally `file:line`).
3. Add it to the JSON Schema (`schema/done.schema.json`) and the
   [spec reference](spec-reference.md).
4. Add a unit test and an e2e test.

Keep it deterministic — a pure function over the filesystem, no network, no model.
