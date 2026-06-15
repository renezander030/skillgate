#!/bin/sh
# entrypoint.sh — container wrapper around the shared gate-install.sh. Stages the
# baked hooks + any runtime-mounted policy/key, installs the gate, then runs sshd in
# the foreground (PID 1). Idempotent: safe to restart.
set -eu

GATE_SRC=/opt/skillgate-src
export GATE_SRC

# Runtime inputs the operator may mount read-only (see docker-compose.yml):
#   /run/authorized_key.pub  -> the key you push with (REQUIRED to push)
#   /run/done.yaml           -> pin your own definition of done (else a default)
[ -f /run/authorized_key.pub ] && cp /run/authorized_key.pub /tmp/authorized_key.pub
[ -f /run/done.yaml ] && cp /run/done.yaml /tmp/done.yaml

sh "$GATE_SRC/gate-install.sh"

echo "[skillgate] gate container ready. Push to ssh://gate@<host>:<mapped-port>/srv/repos/repo.git"
# -e logs to stderr (container logs); -D keeps sshd in the foreground as PID 1.
exec /usr/sbin/sshd -D -e
