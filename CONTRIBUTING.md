# Contributing to skillgate

Thanks for helping make the finish-line gate sharper. skillgate is a small,
zero-runtime-dependency-by-design TypeScript CLI, so contributions stay focused and
fast to review.

## Ground rules

- **Deterministic by design.** Every gate must be a pure function over the filesystem:
  same inputs, same verdict, no model in the loop, no network. If a change introduces
  nondeterminism, it does not belong in a gate.
- **Keep the dependency surface tiny.** New runtime dependencies need a strong reason.
- **The repo gates itself.** `.skillgate/done.yaml` runs in CI — your change has to pass
  the same gate it ships.

## Development setup

```bash
git clone https://github.com/renezander030/skillgate
cd skillgate
npm ci
npm run build
npm test
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the test suite (`node --test`) |
| `npm run test:coverage` | Tests with coverage thresholds enforced |
| `node dist/src/cli.js check` | Dogfood the gate on this repo |

## Making a change

1. Branch from `master`.
2. Add or update tests. Unit tests live in `test/*.test.ts`; CLI-level behaviour goes in
   `test/e2e.test.ts`. A new gate type needs both a unit test and an e2e test.
3. `npm run build && npm run test:coverage` must pass. Coverage thresholds are enforced
   in CI, so keep them green locally.
4. Add a bullet under `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md). (The self-gate
   checks that an Unreleased section exists.)
5. Open a PR using the template. Describe the behaviour change and how you verified it.

## Adding a gate type

A gate type is a `case` in `checkGate()` in `src/core.ts` plus an interface in
`src/spec.ts`. Keep it deterministic, give it a clear failure `reason` (ideally with a
`file:line`), and document it in the README's gate table.

## Releases

Releases are tag-driven (`npm version <patch|minor|major>` → `git push --follow-tags`),
which triggers the publish workflow. Maintainers handle this.
