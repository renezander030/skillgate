<!-- Thanks for contributing to skillgate. Keep PRs focused and deterministic. -->

## What changed

<!-- One or two sentences on the behaviour change. -->

## Why

<!-- The problem this solves. Link an issue if there is one: Closes #123 -->

## How I verified it

<!-- Commands you ran and what you observed. -->

```
npm run build && npm run test:coverage
```

## Checklist

- [ ] Tests added/updated (unit in `test/*.test.ts`, CLI behaviour in `test/e2e.test.ts`)
- [ ] `npm run test:coverage` passes locally (coverage thresholds are enforced in CI)
- [ ] New/changed gate behaviour is documented in the README gate table
- [ ] Added a bullet under `## Unreleased` in `CHANGELOG.md`
- [ ] Change stays deterministic (pure function over the filesystem, no network, no model)
