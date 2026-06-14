#!/usr/bin/env sh
# ensure-gate.sh — make sure the self-hosted gate VM is running. Idempotent and
# safe to call concurrently (the scheduler + many agent sessions): the "already
# running" path is a lockless check, so parallel callers don't contend; only the
# "needs starting" path takes an atomic lock, so they never collide on `vagrant up`.
# After the host sleeps the VM is in 'saved' state (not in runningvms), so this
# resumes it. Portable across macOS / Linux / BSD (used by launchd, systemd, cron).
#
# Config (env overrides):
#   SKILLGATE_VM        VM name              (default: skillgate-gate)
#   SKILLGATE_GATE_DIR  dir with Vagrantfile (default: parent of this script)
#   SKILLGATE_LOG       log file             (default: ~/.skillgate/gate-keepalive.log)
set -u

VM_NAME="${SKILLGATE_VM:-skillgate-gate}"
GATE_DIR="${SKILLGATE_GATE_DIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
LOG="${SKILLGATE_LOG:-$HOME/.skillgate/gate-keepalive.log}"
LOCK="${TMPDIR:-/tmp}/skillgate-gate-ensure.lock"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

vm_running() {
  if command -v VBoxManage >/dev/null 2>&1; then
    VBoxManage list runningvms 2>/dev/null | grep -q "\"$VM_NAME\""
  else
    # provider-agnostic fallback (slower — takes Vagrant's lock)
    ( cd "$GATE_DIR" 2>/dev/null && vagrant status --machine-readable 2>/dev/null | grep -q ',state,running$' )
  fi
}

# Hot path: already up → nothing to do. Lockless, so any number of callers are fine.
if vm_running; then exit 0; fi

# Need to start/resume — serialize with an atomic mkdir lock (portable; no flock).
# A stale lock (>15 min, e.g. a killed run) is reclaimed.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -prune -mmin +15 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0   # another instance is already bringing it up
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

if vm_running; then exit 0; fi             # re-check under the lock
[ -d "$GATE_DIR" ] || { log "gate dir not found: $GATE_DIR"; exit 0; }
log "VM '$VM_NAME' not running -> vagrant up"
( cd "$GATE_DIR" && VAGRANT_CWD="$GATE_DIR" vagrant up ) >> "$LOG" 2>&1
log "vagrant up exit=$?"
