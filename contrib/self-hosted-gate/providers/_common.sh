#!/usr/bin/env sh
# _common.sh — stage skillgate onto a fresh Alpine guest and provision it. Every
# per-hypervisor recipe in this directory calls this once the VM is reachable over
# SSH (as root). It keeps the gate a single source of truth: the recipes differ
# only in how they create the VM.
#
#   sh providers/_common.sh root@192.168.122.50 [ssh_port]
#
# DOWNSTREAM REUSE: another project can reuse the per-hypervisor VM-creation
# recipes here with ITS OWN gate by exporting, before running a recipe:
#   GATE_PROVISION="sh /path/to/your/_common.sh"   # what to run once SSH is up
#   GATE_PUBKEY="/path/to/your/push_key.pub"        # key to authorize on the guest
# (e.g. MegaCooper points GATE_PROVISION at its Nim provisioner.)
set -eu

[ $# -ge 1 ] || { echo "usage: sh _common.sh root@<host> [port]"; exit 2; }
TARGET="$1"; PORT="${2:-22}"
HERE="$(cd "$(dirname "$0")" && pwd)"        # providers/
CONTRIB="$(cd "$HERE/.." && pwd)"           # self-hosted-gate/
SSHO="-o StrictHostKeyChecking=accept-new"
SCP="scp -P $PORT $SSHO"
SSH="ssh -p $PORT $SSHO"

echo "[stage] copying skillgate gate files to $TARGET:$PORT …"
$SCP "$CONTRIB/pre-receive"  "$TARGET:/tmp/pre-receive"
$SCP "$CONTRIB/post-receive" "$TARGET:/tmp/post-receive"
[ -f "$CONTRIB/done.yaml" ] && $SCP "$CONTRIB/done.yaml" "$TARGET:/tmp/done.yaml" || true
PUB="${GATE_PUBKEY:-$CONTRIB/authorized_key.pub}"
[ -f "$PUB" ] && $SCP "$PUB" "$TARGET:/tmp/authorized_key.pub" || \
  echo "[stage] WARN: no push key ($PUB) — the agent won't be able to push to the gate."
$SCP "$CONTRIB/provision.sh" "$TARGET:/tmp/provision.sh"

echo "[stage] running the provisioner on the guest …"
$SSH "$TARGET" "sh /tmp/provision.sh"

echo ""
echo "[stage] gate ready. Point your repo's gate remote at this guest:"
echo "        git remote set-url gate ssh://gate@<guest-ip-or-forward>:$PORT/srv/repos/repo.git"
