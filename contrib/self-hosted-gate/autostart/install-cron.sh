#!/usr/bin/env sh
# install-cron.sh — keep the gate VM up via cron. The right choice on the BSDs
# (FreeBSD / OpenBSD / NetBSD), and a portable fallback anywhere cron exists. Runs
# every minute + at @reboot; the atomic lock in ensure-gate.sh prevents overlap if a
# run is slow. Usage: sh install-cron.sh [--uninstall]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
ensure="$here/ensure-gate.sh"
tag="# skillgate-gate-keepalive"
line_boot="@reboot /bin/sh $ensure >/dev/null 2>&1 $tag"
line_min="* * * * * /bin/sh $ensure >/dev/null 2>&1 $tag"

current="$(crontab -l 2>/dev/null || true)"
cleaned="$(printf '%s\n' "$current" | grep -v -F "$tag" || true)"

if [ "${1:-}" = "--uninstall" ]; then
  printf '%s\n' "$cleaned" | grep -v '^$' | crontab - 2>/dev/null || printf '' | crontab -
  echo "Removed cron keep-alive."
  exit 0
fi

{ printf '%s\n' "$cleaned" | grep -v '^$' || true; printf '%s\n%s\n' "$line_boot" "$line_min"; } | crontab -
echo "Installed cron keep-alive (@reboot + every minute)."
echo "Note (BSD): VirtualBox is limited on the BSDs — if you use the bhyve provider"
echo "            instead, ensure-gate.sh falls back to 'vagrant status' automatically."
echo "Log: \$HOME/.skillgate/gate-keepalive.log"
echo "Uninstall: sh install-cron.sh --uninstall"
