#!/usr/bin/env sh
# install-systemd.sh — keep the gate VM up via a systemd --user timer. Works on any
# systemd distro: RHEL/Fedora/Rocky/Alma (dnf), Debian/Ubuntu/Mint (apt), Arch
# (pacman), openSUSE (zypper). Runs every minute, single-instance (a oneshot service
# won't re-run while active), and Persistent=true catches up after resume from sleep.
# Usage: sh install-systemd.sh [--uninstall]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
ensure="$here/ensure-gate.sh"
unitdir="$HOME/.config/systemd/user"
svc="skillgate-gate.service"
tmr="skillgate-gate.timer"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$tmr" 2>/dev/null || true
  rm -f "$unitdir/$svc" "$unitdir/$tmr"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed $tmr / $svc."
  exit 0
fi

mkdir -p "$unitdir"
cat > "$unitdir/$svc" <<EOF
[Unit]
Description=Ensure the skillgate gate VM is running
[Service]
Type=oneshot
ExecStart=/bin/sh $ensure
EOF
cat > "$unitdir/$tmr" <<EOF
[Unit]
Description=Keep the skillgate gate VM up (every minute)
[Timer]
OnCalendar=minutely
Persistent=true
AccuracySec=10s
[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$tmr"
echo "Installed systemd user timer $tmr (every minute)."
echo "To keep it running while logged out:  loginctl enable-linger \"$USER\""
echo "Log: \$HOME/.skillgate/gate-keepalive.log"
echo "Uninstall: sh install-systemd.sh --uninstall"
