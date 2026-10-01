# Secrets and Optional Code Review

## No-secrets preset

Install [TruffleHog](https://github.com/trufflesecurity/trufflehog), then initialize:

```sh
skillgate init --preset no-secrets
skillgate check
```

The preset refuses to overwrite an existing policy. For an existing policy, add:

```yaml
- id: no-secrets
  type: trufflehog
  timeout: 10000
  namesFile: .skillgate/forbidden-names.json
```

Set the local denylist to a non-empty JSON array of literal server, domain, or
tenant names. Initialization starts with `[]` and blocks until you configure it.
Remove `namesFile` for credential scanning alone. The preset ignores the private
file and scanner clone directory. Provide the denylist separately to trusted CI.
An existing policy needs these ignore entries added explicitly:

```gitignore
/.skillgate/forbidden-names.json
/.skillgate/scan-cache/
```

The name check uses case-insensitive literal matching over tracked and unignored
untracked files and the staged index. Missing, malformed, or empty configuration,
symlinks, unreadable files, and size/time limits block. Matched names are redacted.

The credential check runs `trufflehog git file://<repo> --results=verified --fail
--fail-on-scan-errors --no-update --json` with temporary clones under the ignored
scan directory. The executable is optional and never downloaded by Skillgate.
Set `trufflehog` to override its path. A missing scanner, nonzero exit, malformed
output, or timeout blocks. Raw output never enters receipts. Policies containing
this gate always re-evaluate, including with `--cache`.

Verified-only detection requires network access to credential providers. It does
not guarantee detection of fake, expired, unsupported, or unverifiable credentials.
Keep static `absent` gates where those are also forbidden. Verification responses
and scan times can change with identical files: this optional gate is not a pure
offline filesystem predicate.

TruffleHog v3.97.9 took 3.7 seconds on a small TypeScript repository. The vendor's
public AWS/URI canaries triggered exit 183 in history and when staged before
commit. Published evidence contains no credential values. Measure your repository:
ten seconds is a budget, not a universal performance guarantee.

## Optional OCR Review Adapter

A review gate consumes a trusted reviewer's report. It does not run a model or
add [Open Code Review](https://github.com/alibaba/open-code-review) as a dependency:

```yaml
- id: review
  type: review
  file: .skillgate/review.json
```

Ignore `.skillgate/review*` before taking a snapshot. Capture `skillgate
review-snapshot` **before** reviewing and retain that value in the report. The hash
covers policy, working files, and staged blob IDs. Changes require another review.
Use the same `--base`/`--pin` options for snapshot and evaluation. `--cache` never
skips this gate.

OCR v1.12.11 has two paths:

```sh
# OCR-managed model; a custom/local endpoint is also possible.
ocr review --format json --output .skillgate/review.raw.json

# Host-agent review; no separate OCR API key or model configuration.
ocr delegate preview --format json
ocr delegate rule src/core.ts src/plugin.ts --format json
```

Delegation prepares file selection and rules. The host must inspect the actual
diff and complete the review. `delegate preview` alone is not a completed review.

Wrap OCR JSON, or a delegated review using the same status/summary/comments shape,
in this envelope. Normalize absent `warnings` to an empty array:

```json
{
  "format": 1,
  "snapshot": "<value captured before review>",
  "review": {
    "status": "success",
    "summary": { "files_reviewed": 2, "comments": 0 },
    "comments": [],
    "warnings": []
  }
}
```

Missing, stale, incomplete, skipped, budget-exceeded, or malformed reports block.
Any comment or warning blocks. Resolve findings and rerun review. Comment content
is never printed by this gate.

This is a **reviewer attestation**, not independent proof that review ran or that
code is correct. An agent with report-write access can forge it. Put policy and
report production behind a trusted boundary for independent enforcement.

The no-key thin slice used [Skillgate PR #39](https://github.com/renezander030/skillgate/pull/39).
OCR selected six source/schema files and excluded documentation and tests. The
host review identified an invalid-policy path allowing non-shell publish tools
through the opencode plugin. A regression test reproduced it; the fix blocks
unknown/MCP tools on invalid policy while allowing built-in repair tools. This is
one host-reviewed case, not a model-quality comparison. Review documentation and
tests separately when OCR excludes them.
