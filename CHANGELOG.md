# Changelog

## Unreleased

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
