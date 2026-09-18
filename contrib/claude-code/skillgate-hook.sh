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
exit "$status"   # exit 2 = Claude Code blocks the tool call and returns stderr
