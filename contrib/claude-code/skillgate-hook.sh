#!/usr/bin/env bash
# skillgate — Claude Code PreToolUse hook.
# Denies finish-line commands (commit / push / publish) until `skillgate check`
# passes. The model can propose the command; this hook decides whether it runs,
# and feeds the failing gates back into the same session. Requires Node (npx).
#
# Install: see this directory's README.md.
set -euo pipefail

payload="$(cat)"

# Extract the bash command from the PreToolUse payload (.tool_input.command),
# robustly (commands can contain quotes), using the Node that npx already needs.
cmd="$(printf '%s' "$payload" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const j=JSON.parse(s); process.stdout.write((j.tool_input && j.tool_input.command) || ""); }
    catch { process.stdout.write(""); }
  });')"

case "$cmd" in
  *"git commit"*|*"git push"*|*"npm publish"*|*"pnpm publish"*|*"yarn publish"*)
    if ! npx --yes @reneza/skillgate@latest check >&2; then
      echo "" >&2
      echo "skillgate: definition of done not met — blocked: ${cmd}" >&2
      echo "Fix the failing gates above, then run the command again." >&2
      exit 2   # exit 2 = Claude Code blocks the tool call and returns stderr to the model
    fi
    ;;
esac
exit 0
