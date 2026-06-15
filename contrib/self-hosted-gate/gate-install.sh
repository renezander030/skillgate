#!/bin/sh
# gate-install.sh — the substrate-independent CORE of the skillgate gate.
#
# It turns an already-provisioned box (git, node/npm, openssh, git-shell present)
# into the gate: a bare repo whose pre-receive hook runs `skillgate check` against
# a definition of done that lives HERE, not in the pushed tree. Every substrate
# wraps this same script so the VM, the container, and the VPS set the gate up
# identically — only "install the OS packages" and "start sshd" differ, and those
# live in each wrapper (Vagrant provision.sh / docker entrypoint.sh / vps setup.sh).
#
# Run as root. Inputs:
#   GATE_SRC          dir holding pre-receive + post-receive (default: /tmp)
#   SKILLGATE_DIR     where the authoritative .skillgate/ lives (default: /opt/skillgate)
#   GATE_REPO         the bare repo path (default: /srv/repos/repo.git)
#   SKILLGATE_VERSION pinned skillgate package version (default: 0.1.0)
# Optional runtime files (staged in /tmp by the wrapper):
#   /tmp/done.yaml            your definition of done (else a default is initialised)
#   /tmp/authorized_key.pub   the public key you will push with
set -eu

GATE_SRC="${GATE_SRC:-/tmp}"
SKILLGATE_DIR="${SKILLGATE_DIR:-/opt/skillgate}"
GATE_REPO="${GATE_REPO:-/srv/repos/repo.git}"
SKILLGATE_VERSION="${SKILLGATE_VERSION:-0.1.0}"

# 1. Authoritative definition of done — lives on the box, not in the pushed tree.
mkdir -p "$SKILLGATE_DIR/.skillgate"
if [ -f /tmp/done.yaml ]; then
  cp /tmp/done.yaml "$SKILLGATE_DIR/.skillgate/done.yaml"
elif [ ! -f "$SKILLGATE_DIR/.skillgate/done.yaml" ]; then
  ( cd "$SKILLGATE_DIR" && npx -y "@reneza/skillgate@$SKILLGATE_VERSION" init >/dev/null 2>&1 ) || true
fi

# 2. The gated bare repo + hooks (the hooks are the gate logic; copied from GATE_SRC).
mkdir -p "$(dirname "$GATE_REPO")"
[ -d "$GATE_REPO" ] || git init --bare -q "$GATE_REPO"
for h in pre-receive post-receive; do
  if [ -f "$GATE_SRC/$h" ]; then
    cp "$GATE_SRC/$h" "$GATE_REPO/hooks/$h"
    chmod +x "$GATE_REPO/hooks/$h"
  fi
done

# 3. Push-only gate user: git-shell means it can run git-receive-pack but cannot get
#    an interactive login. Portable across busybox/Alpine (adduser) and
#    Debian/Ubuntu/Fedora (useradd).
GITSHELL="$(command -v git-shell 2>/dev/null || echo /usr/bin/git-shell)"
if ! id gate >/dev/null 2>&1; then
  adduser -D -s "$GITSHELL" gate 2>/dev/null \
    || useradd -m -r -s "$GITSHELL" gate 2>/dev/null \
    || useradd -m -s "$GITSHELL" gate
fi
# A locked password ('!' or '!!') makes sshd refuse even valid pubkey auth
# ("account is locked"). Unlock to '*' (no usable password, still not a login).
sed -i '/^gate:/ s/:!!\{0,1\}:/:*:/' /etc/shadow 2>/dev/null || true

GATE_HOME="$(getent passwd gate 2>/dev/null | cut -d: -f6)"; GATE_HOME="${GATE_HOME:-/home/gate}"
mkdir -p "$GATE_HOME/.ssh" && chmod 700 "$GATE_HOME/.ssh"
if [ -f /tmp/authorized_key.pub ]; then
  cp /tmp/authorized_key.pub "$GATE_HOME/.ssh/authorized_keys"
  chmod 600 "$GATE_HOME/.ssh/authorized_keys"
else
  echo "[skillgate] WARN: no /tmp/authorized_key.pub staged — nobody can push to the gate yet."
fi

# 4. Deploy key for the OPTIONAL upstream mirror. It is generated here and never
#    leaves the box; that is what keeps the upstream credential off the agent.
[ -f "$GATE_HOME/.ssh/id_ed25519" ] \
  || ssh-keygen -t ed25519 -N "" -C "skillgate-gate" -f "$GATE_HOME/.ssh/id_ed25519" >/dev/null

chown -R gate:gate "$GATE_REPO" "$SKILLGATE_DIR" "$GATE_HOME/.ssh" 2>/dev/null \
  || chown -R gate "$GATE_REPO" "$SKILLGATE_DIR" "$GATE_HOME/.ssh" 2>/dev/null || true

echo "[skillgate] gate installed."
echo "[skillgate]   repo: $GATE_REPO"
echo "[skillgate]   spec: $SKILLGATE_DIR/.skillgate/done.yaml"
echo "[skillgate] upstream-mirror deploy key (add as a WRITE deploy key, then set"
echo "[skillgate] SKILLGATE_UPSTREAM in the post-receive env to enable mirroring):"
cat "$GATE_HOME/.ssh/id_ed25519.pub" 2>/dev/null || true
