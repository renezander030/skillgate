# Changelog

## Unreleased

### Added
- Optional `version:` field in `done.yaml` for spec-format compatibility: an older skillgate meeting a newer spec now warns instead of silently misreading gates (`SPEC_VERSION` exported from `spec.ts`).
- JSON Schema at `schema/done.schema.json`; generated and example specs carry a `# yaml-language-server:` modeline for editor autocomplete and validation. Schema ships in the npm package.
- `docs/`: quickstart, spec reference, recipes, architecture, and a compatibility/deprecation policy (including the documented exit-code contract).
- Community health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue templates, and a pull-request template.
- Tag-driven release workflow (`npm publish --provenance` + GitHub Release from the CHANGELOG section).
- `test/e2e.test.ts`: the CLI is now covered end-to-end as a real process; `test/spec.test.ts` covers spec loading and versioning.

### Changed
- CI runs a Node 18/20/22 matrix, pins all actions to commit SHAs, and enforces coverage thresholds via `npm run test:coverage`.
- Added Dependabot for npm and GitHub Actions.

## 0.3.0

### Added
- `skillgate audit` — a zero-config, read-only one-shot: run it against any repo and see which gates your agent could cut, with no `.skillgate/done.yaml` required (audits against built-in defaults without writing to the repo).
- `contrib/claude-code/` — a Claude Code definition-of-done hook kit (finish-line-aware `PreToolUse` hook + settings + starter spec).
- `contrib/loop-gate/` — `loop-until-done.sh`, a retry loop whose stop condition is `skillgate check`, not the model's own claim.

### Changed
- README leads with a one-command `audit` walkthrough; install section reworked into tiered variants (npx / npm / Docker / self-hosted VPS); the starter-spec example now matches what `init` actually writes.

## 0.2.0

### Added
- Initial release: deterministic gate evaluator (`file-exists`, `file-contains`, `absent`, `command`, `evidence`).
- `skillgate` CLI: `check`, `init`, `--json`, `--cwd`.
- opencode plugin that denies finish-line commands until gates pass.
- `contrib/` adapters for pre-commit and GitHub Actions.
- `instruction-sync` gate type + `drift` / `sync` commands: detect and end AI instruction-file drift across CLAUDE.md, AGENTS.md, Cursor, Copilot, Gemini, Cline, Windsurf and Junie. Folds in the former standalone `adrift` tool.
