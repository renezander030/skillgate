# Changelog

## Unreleased

## 0.2.0

### Added
- Initial release: deterministic gate evaluator (`file-exists`, `file-contains`, `absent`, `command`, `evidence`).
- `skillgate` CLI: `check`, `init`, `--json`, `--cwd`.
- opencode plugin that denies finish-line commands until gates pass.
- `contrib/` adapters for pre-commit and GitHub Actions.
- `instruction-sync` gate type + `drift` / `sync` commands: detect and end AI instruction-file drift across CLAUDE.md, AGENTS.md, Cursor, Copilot, Gemini, Cline, Windsurf and Junie. Folds in the former standalone `adrift` tool.
