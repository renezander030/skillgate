#!/bin/sh
# setup.sh — install the skillgate gate on a remote VPS (any box you have root SSH
# to). The VPS is the external evaluator: your agent runs on your machine and has
# no login to the VPS, so it can neither edit the definition of done nor read the
# upstream credential. This is the same boundary a CI server gives you, on a box
# you own, for the price of the smallest VPS.
#
#   sh setup.sh root@vps.example.com [ssh_port]
#
# Env:
#   GATE_PUBKEY  public key to authorise for pushing (default: ../authorized_key.pub)
set -eu

[ $# -ge 1 ] || { echo "usage: sh setup.sh root@<host> [ssh_port]"; exit 2; }
TARGET="$1"; PORT="${2:-22}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRIB="$(cd "$HERE/.." && pwd)"
PUB="${GATE_PUBKEY:-$CONTRIB/authorized_key.pub}"
SSHO="-o StrictHostKeyChecking=accept-new"

[ -f "$PUB" ] || { echo "Missing push key $PUB — generate one and authorise it:"; \
  echo "  ssh-keygen -t ed25519 -f ./push_key && cp push_key.pub $PUB"; exit 1; }

echo "[vps] staging gate files to $TARGET:$PORT …"
scp -P "$PORT" $SSHO "$CONTRIB/pre-receive" "$CONTRIB/post-receive" \
    "$CONTRIB/gate-install.sh" "$TARGET:/tmp/"
[ -f "$CONTRIB/done.yaml" ] && scp -P "$PORT" $SSHO "$CONTRIB/done.yaml" "$TARGET:/tmp/done.yaml" || true
scp -P "$PORT" $SSHO "$PUB" "$TARGET:/tmp/authorized_key.pub"

echo "[vps] installing deps + gate on the VPS …"
ssh -p "$PORT" $SSHO "$TARGET" 'sh -s' <<'REMOTE'
set -eu
# Install deps with whatever package manager the VPS ships.
if command -v apk >/dev/null 2>&1; then
  apk add --no-cache git openssh nodejs npm tar >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null && apt-get install -y -qq git openssh-server nodejs npm >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q git openssh-server nodejs npm >/dev/null
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q git openssh-server nodejs npm >/dev/null
else
  echo "[vps] no supported package manager (apk/apt/dnf/yum); install git, openssh, nodejs, npm and re-run gate-install.sh"; exit 1
fi
sh /tmp/gate-install.sh
# Make sure sshd is up (systemd, OpenRC, or sysv — whichever the VPS uses).
systemctl enable --now sshd 2>/dev/null || systemctl enable --now ssh 2>/dev/null \
  || { rc-update add sshd default 2>/dev/null && rc-service sshd start 2>/dev/null; } \
  || service ssh start 2>/dev/null || service sshd start 2>/dev/null || true
REMOTE

host="${TARGET#*@}"
echo "[vps] done. Point your repo at the gate:"
echo "  git remote add gate ssh://gate@$host:$PORT/srv/repos/repo.git"
echo "[vps] Then make it the only path to upstream: register the deploy key printed"
echo "      above as a WRITE deploy key, set SKILLGATE_UPSTREAM in post-receive, and"
echo "      drop your agent's direct push access."
