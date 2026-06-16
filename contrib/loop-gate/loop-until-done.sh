#!/usr/bin/env bash
# loop-until-done — run a progress command (an agent, a formatter, codegen…)
# repeatedly until `skillgate check` says the work is actually done.
# The gate, not the model, is the stop condition.
#
# Usage:
#   ./loop-until-done.sh [--max N] -- <command to make progress>
#
# Examples:
#   ./loop-until-done.sh --max 8 -- opencode run "make the failing skillgate gates pass"
#   ./loop-until-done.sh -- claude -p "fix whatever skillgate reports, then stop"
#
# Exit 0 once every gate passes; exit 1 after --max rounds (default 10) so a
# stuck agent can't spin forever; exit 64 on bad arguments.
set -euo pipefail

MAX=10
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --max) MAX="${2:?--max needs a number}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ "${1:-}" = "--" ] && shift || { echo "usage: loop-until-done.sh [--max N] -- <command>" >&2; exit 64; }
[ $# -gt 0 ] || { echo "usage: loop-until-done.sh [--max N] -- <command>" >&2; exit 64; }

i=0
while : ; do
  if npx --yes @reneza/skillgate@latest check; then
    echo "[loop-until-done] gates pass after ${i} round(s) — done."
    exit 0
  fi
  i=$((i + 1))
  if [ "$i" -gt "$MAX" ]; then
    echo "[loop-until-done] still failing after ${MAX} rounds — stopping. The gate, not the model, decided." >&2
    exit 1
  fi
  echo "[loop-until-done] round ${i}/${MAX}: gates unmet, running progress command…"
  "$@" || true   # let the command attempt a fix; the gate decides next round
done
