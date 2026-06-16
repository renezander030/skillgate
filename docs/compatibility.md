# Compatibility & deprecation policy

skillgate's public contract is three things: the **CLI** (commands, flags, exit codes),
the **`done.yaml` spec format**, and the **library exports** (`@reneza/skillgate` and
`@reneza/skillgate/core`). This is how they change.

## Versioning

The package follows [SemVer](https://semver.org). While pre-1.0, breaking changes may
land in a minor (`0.x`) release, but they are always called out in
[`CHANGELOG.md`](../CHANGELOG.md) under a **Breaking** heading with a migration note.

## Spec format version

`done.yaml` may declare an integer `version:`. It is optional and backward-compatible —
an omitted version means "the current format". The field exists so that:

- a spec can opt into a future format explicitly, and
- an **older** skillgate that meets a **newer** spec degrades loudly: it prints a
  warning (`spec declares version N but this build understands up to M`) instead of
  silently misreading gates.

The format version this build understands is exported as `SPEC_VERSION` from
`src/spec.ts`. It is bumped only on a breaking change to the schema, not for additive
ones (a new gate type is additive — old specs keep working).

## Exit-code contract

These are stable; tools may rely on them.

| Code | Meaning |
|------|---------|
| `0` | All gates passed (or `drift`: everything in sync) |
| `1` | A gate failed / drift detected — the finish line is blocked |
| `2` | Usage error: no spec found, unknown command, spec failed to load |

## How deprecations happen

1. **Deprecate before removing.** A gate field or flag that is going away is first
   marked deprecated in the docs and continues to work, with a warning where practical.
2. **Document the migration.** Every breaking change ships with a `CHANGELOG.md` entry
   describing the before/after and the upgrade step.
3. **Additive by default.** New gate types and optional fields are added without
   breaking existing specs.

If you depend on behaviour that is not documented here or in the
[spec reference](spec-reference.md), please open an issue so it can be made explicit.
