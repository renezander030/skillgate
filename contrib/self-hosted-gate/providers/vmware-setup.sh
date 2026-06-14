#!/usr/bin/env sh
# vmware-setup.sh — gate VM on VMware Workstation Pro (Windows/Linux) or Fusion Pro
# (macOS) via `vmrun`. Run from Git Bash on Windows or a shell on Linux/macOS.
#
#   sh contrib/self-hosted-gate/providers/vmware-setup.sh /path/to/alpine.vmx
#
# Easiest alternative: Vagrant + the vagrant-vmware-desktop plugin + the VMware
# Vagrant Utility → `vagrant up --provider=vmware_desktop` (the Vagrantfile here has
# a vmware_desktop block). Native path: create an Alpine VM in the VMware UI (512MB,
# NAT, sshd + root login, open-vm-tools), then pass its .vmx.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
VMX="${1:-}"
[ -n "$VMX" ] && [ -f "$VMX" ] || { echo "usage: sh vmware-setup.sh /path/to/alpine.vmx"; exit 2; }
VMRUN="${VMRUN:-vmrun}"
PROVISION="${GATE_PROVISION:-sh "$HERE/_common.sh"}"
command -v "$VMRUN" >/dev/null || {
  echo "vmrun not on PATH. Typical: Windows 'C:/Program Files (x86)/VMware/VMware Workstation/vmrun.exe',"
  echo "Linux /usr/bin/vmrun, macOS '/Applications/VMware Fusion.app/Contents/Public/vmrun'. Set VMRUN=…"; exit 1; }

echo "Powering on the VM…"
"$VMRUN" start "$VMX" nogui || "$VMRUN" start "$VMX"
echo "Waiting for the guest IP (open-vm-tools must be installed in the guest)…"
ip=""
for _ in $(seq 1 30); do
  ip="$("$VMRUN" getGuestIPAddress "$VMX" -wait 2>/dev/null || true)"
  case "$ip" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) break;; *) ip=""; sleep 2;; esac
done
[ -n "$ip" ] || { echo "No guest IP (install open-vm-tools in the guest)."; exit 1; }
echo "Guest IP: $ip"

$PROVISION "root@$ip" 22
echo "git remote set-url gate ssh://gate@$ip:22/srv/repos/repo.git"
