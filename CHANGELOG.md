# Changelog

## Unreleased

## 0.8.0 - 2026-09-06

### Added
- Experimental `skillgate fhe-metrics` commands for adding gate pass/total counts from
  3–128 private repositories while the collector sees only ciphertext, then decrypting one
  declared fleet percentage against an expected contributor count. The optional helper uses
  a fixed, shallow Lattigo BGV circuit and requires Go 1.25+; it is not an audited service or
  an arbitrary-depth FHE engine.

## 0.7.0 - 2026-09-06

### Added
- `skillgate zk-keygen`, `zk-policy-id`, `zk-prove`, and `zk-verify` — issue and verify
  challenge-bound BBS selective-disclosure proofs that reveal only `PASS` and an approved
  policy hash while hiding the private repository snapshot, gate details, evidence, reasons,
  and count. The commands fail closed on a failing gate, wrong signer, wrong policy, replayed
  challenge, or altered proof. This is explicitly an experimental signer attestation, not a
  zkVM proof of the gate evaluator.

## 0.6.0 - 2026-07-25

### Added
- `skillgate verify-patch` — evaluate an agent's uncommitted patch in a fresh, network-off
  clone of the repo, run your definition of done against the patched tree, and block apply on
  failure. The spec is read from the committed HEAD, so a patch cannot weaken the gates that
  judge it, and a patch that modifies the definition of done never auto-applies (it requires an
  explicit `--override "<reason>"`). Checks run under a rootless pid/net namespace with hard
  timeouts, degrading to env-only network blocking where namespaces are unavailable.
- `skillgate verify-apply` — land a verified patch into the real repo, only after `verify-patch`
  passed (staleness-guarded) or with an explicit, recorded override.
- `skillgate gate` — harness-neutral entrypoint: pipe in (or pass `--command`) the command an
  agent is about to run and get back allow/block (exit 0 allow, 2 block). Reads a Claude Code
  PreToolUse hook JSON payload or a raw command from stdin; fails closed on error unless
  `--allow-on-error`.
- `--pin` / `--base <ref>` — read the spec from the base ref instead of the working tree, so a
  change under review cannot edit or delete the policy it is judged by (fails closed when no
  base or pinned spec resolves).
- Diff-aware regression gates `no-new` and `no-deleted`, which judge a change against a base ref.
- `trivy` gate type — run a Trivy scan as a gate for vulnerabilities and misconfigurations.
- Agent-reliability gate pack and `docs/agent-reliability-checklist.md`.

### Docs
- `docs/finish-line-gates-vs-push-guards.md` — positioning of finish-line gates versus push guards.

## 0.5.0 - 2026-06-27

### Added
- `skillgate scaffold` — generates `.skillgate/evidence/` directory with stack-specific
  evidence file templates (`generic`, `react`, `ts-lib`, `python`). The agent must write
  these files (test output, lint report, self-review) before crossing the finish line.
  `--template` selects the stack; `--update-agents` appends workflow instructions to
  AGENTS.md / CLAUDE.md.
- `skillgate diff-instructions` — shows line-level diff between drifted instruction
  files (CLAUDE.md, AGENTS.md, …) rather than just a similarity percentage. Makes drift
  actionable, not just visible.
- `skillgate canonical <file>` — sets which instruction file is the single source of
  truth by writing `.skillgate/canonical-instructions.txt`.
- `skillgate init` now includes the `instruction-sync` gate and a commented-out
  `evidence` gate example by default — drift detection and evidence workflow are ready
  from the first `init`.
- `lineDiff()` and `formatDiff()` in `drift.ts` — reusable diff utilities for showing
  line-level changes between instruction files.

### Changed
- `init` template modernized: `instruction-sync` is an active gate; `evidence` appears
  as a commented-out example ready to uncomment.

## 0.4.0 - 2026-06-16

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
