#!/usr/bin/env bash
# skillgate — Claude Code PreToolUse hook.
# Denies structurally matched finish-line commands until `skillgate gate`
# passes. The model can propose the command; this hook decides whether it runs,
# and feeds the failing gates back into the same session. Requires Node (npx).
#
# Install: see this directory's README.md.
set -euo pipefail

payload="$(cat)"
set +e
printf '%s' "$payload" | npx --yes @reneza/skillgate@latest gate >&2
status=$?
set -e
# exit 2 = Claude Code blocks the tool call and returns stderr. Any other failure
# (npx missing, offline, registry error) would be non-blocking, so block instead.
if [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then
  echo "skillgate: gate could not run (exit $status); blocking (fail-closed)" >&2
  status=2
fi
exit "$status"
