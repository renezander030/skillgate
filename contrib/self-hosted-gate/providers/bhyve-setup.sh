#!/bin/sh
# bhyve-setup.sh — gate VM on FreeBSD's bhyve hypervisor via vm-bhyve. A real VM →
# a genuine credential boundary.
#
#   sh contrib/self-hosted-gate/providers/bhyve-setup.sh
#
# Prereqs (once, as root):
#   pkg install -y vm-bhyve grub2-bhyve qemu-tools
#   mkdir -p /vm; sysrc vm_enable=YES vm_dir=/vm; vm init
#   vm switch create public && vm switch add public <your-nic>
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="skillgate-gate"
ISO_URL="${ISO_URL:-https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/x86_64/alpine-virt-3.19.1-x86_64.iso}"
PROVISION="${GATE_PROVISION:-sh "$HERE/_common.sh"}"

command -v vm >/dev/null || { echo "vm-bhyve not installed (pkg install vm-bhyve)."; exit 1; }

vm iso "$ISO_URL" 2>/dev/null || true
if ! vm info "$NAME" >/dev/null 2>&1; then
  vm create -t alpine -s 4G "$NAME" 2>/dev/null || vm create -s 4G "$NAME"
  echo ">> A console opens: run 'setup-alpine' (sys install), set a root password,"
  echo ">> enable sshd + PermitRootLogin, then 'poweroff'. Press Enter to continue…"; read _
  vm install "$NAME" "$(basename "$ISO_URL")"
  vm console "$NAME"
fi
vm start "$NAME" 2>/dev/null || true

printf "Enter the guest IP (from the console / DHCP leases): "; read ip
[ -n "$ip" ] || { echo "no IP"; exit 1; }
$PROVISION "root@$ip" 22
echo "git remote set-url gate ssh://gate@$ip:22/srv/repos/repo.git"
