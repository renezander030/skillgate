#!/usr/bin/env sh
# install-macos.sh — keep the gate VM up via a launchd LaunchAgent (runs at login
# and every 60s; launchd won't start a second copy while one is still running, and
# fires the timer after the Mac wakes). Usage: sh install-macos.sh [--uninstall]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
ensure="$here/ensure-gate.sh"
label="com.skillgate.gatekeepalive"
plist="$HOME/Library/LaunchAgents/$label.plist"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"
  echo "Removed launchd agent $label."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.skillgate"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$ensure</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.skillgate/launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME/.skillgate/launchd.log</string>
</dict></plist>
EOF

launchctl unload "$plist" 2>/dev/null || true
launchctl load -w "$plist"
echo "Installed launchd agent $label (at login + every 60s)."
echo "Log: $HOME/.skillgate/gate-keepalive.log"
echo "Uninstall: sh install-macos.sh --uninstall"
