#!/bin/sh
# provision.sh — turn a fresh Alpine box into a skillgate hard gate. Run as root
# (the Vagrantfile does this for you). Idempotent enough to re-run.
#
# Expects these files staged in /tmp (the Vagrantfile copies them):
#   /tmp/pre-receive  /tmp/post-receive  /tmp/done.yaml (your definition of done)
set -eu
echo "[skillgate] provisioning self-hosted gate…"

apk add --no-cache git openssh nodejs npm tar >/dev/null

# Authoritative definition of done — lives here, not in the pushed tree.
mkdir -p /opt/skillgate/.skillgate
if [ -f /tmp/done.yaml ]; then
  cp /tmp/done.yaml /opt/skillgate/.skillgate/done.yaml
elif [ ! -f /opt/skillgate/.skillgate/done.yaml ]; then
  npx -y @reneza/skillgate init >/dev/null 2>&1 || true
  [ -f .skillgate/done.yaml ] && cp .skillgate/done.yaml /opt/skillgate/.skillgate/done.yaml
fi

# Gated bare repo.
mkdir -p /srv/repos
[ -d /srv/repos/repo.git ] || git init --bare -q /srv/repos/repo.git
cp /tmp/pre-receive  /srv/repos/repo.git/hooks/pre-receive
cp /tmp/post-receive /srv/repos/repo.git/hooks/post-receive
chmod +x /srv/repos/repo.git/hooks/pre-receive /srv/repos/repo.git/hooks/post-receive

# Push-only user (git-shell = no interactive login).
adduser -D -s /usr/bin/git-shell gate 2>/dev/null || true
# adduser -D leaves the account password-LOCKED ('!'); sshd refuses even valid
# pubkey auth for a locked account ("account is locked"). Unlock to '*' (no usable
# password, but not locked) so key-based git push works.
sed -i '/^gate:/ s/:!:/:*:/' /etc/shadow 2>/dev/null || true
mkdir -p /home/gate/.ssh && chmod 700 /home/gate/.ssh
[ -f /tmp/authorized_key.pub ] && { cp /tmp/authorized_key.pub /home/gate/.ssh/authorized_keys; chmod 600 /home/gate/.ssh/authorized_keys; }

# Deploy key for the optional upstream mirror (stays on this box).
[ -f /home/gate/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -C "skillgate-gate" -f /home/gate/.ssh/id_ed25519 >/dev/null

chown -R gate:gate /srv/repos /opt/skillgate /home/gate/.ssh
rc-update add sshd default >/dev/null 2>&1 || true
rc-service sshd restart >/dev/null 2>&1 || rc-service sshd start >/dev/null 2>&1 || true

echo "[skillgate] gate ready. Push target: ssh://gate@<box>:22/srv/repos/repo.git"
echo "[skillgate] upstream-mirror deploy key (add as a WRITE deploy key, then set"
echo "[skillgate] SKILLGATE_UPSTREAM in the post-receive env):"
cat /home/gate/.ssh/id_ed25519.pub
