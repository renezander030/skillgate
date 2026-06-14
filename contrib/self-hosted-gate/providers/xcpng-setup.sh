#!/usr/bin/env sh
# xcpng-setup.sh — gate VM on XCP-ng (Xen) via the `xe` CLI. Run on the host, or
# remotely with XE='xe -s <host> -u root -pw <pw>'.
#
#   sh contrib/self-hosted-gate/providers/xcpng-setup.sh
#   XE='xe -s xcpng.local -u root -pw PASS' sh .../xcpng-setup.sh
#
# XCP-ng has no turnkey unattended Alpine, so this scripts the deterministic xe
# steps and pauses for the one manual install (setup-alpine in the console), then
# runs the provisioner.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="skillgate-gate"
XE="${XE:-xe}"
PROVISION="${GATE_PROVISION:-sh "$HERE/_common.sh"}"

command -v xe >/dev/null 2>&1 || [ -n "${XE:-}" ] || { echo "xe CLI not found."; exit 1; }

if ! $XE vm-list name-label="$NAME" --minimal | grep -q .; then
  tmpl="$($XE template-list name-label='Other install media' --minimal | cut -d, -f1)"
  [ -n "$tmpl" ] || { echo "No 'Other install media' template found."; exit 1; }
  vm="$($XE vm-install template="$tmpl" new-name-label="$NAME")"
  $XE vm-memory-limits-set uuid="$vm" static-min=512MiB static-max=512MiB dynamic-min=512MiB dynamic-max=512MiB
  $XE vm-param-set uuid="$vm" VCPUs-max=1 VCPUs-at-startup=1
  echo ">> Attach your Alpine ISO (xe vm-cd-insert) + a network, start the VM, open the"
  echo ">> console, run 'setup-alpine' (sys install), enable sshd + root login."
  echo ">> Press Enter when the guest is installed and reachable…"; read _
fi
$XE vm-start name-label="$NAME" 2>/dev/null || true

vmuuid="$($XE vm-list name-label="$NAME" --minimal | cut -d, -f1)"
ip="$($XE vm-list uuid="$vmuuid" params=networks --minimal 2>/dev/null | sed -n 's/.*0\/ip: \([0-9.]*\).*/\1/p' | head -n1)"
[ -n "$ip" ] || { printf "Could not auto-read IP; enter it: "; read ip; }
[ -n "$ip" ] || { echo "no IP"; exit 1; }
echo "Guest IP: $ip"

$PROVISION "root@$ip" 22
echo "git remote set-url gate ssh://gate@$ip:22/srv/repos/repo.git"
