#!/usr/bin/env sh
# vsphere-setup.sh — gate VM on VMware ESXi / vCenter via `govc` (free CLI). One
# recipe covers every vSphere-based entitlement — standalone ESXi, vSphere
# Foundation (VVF), vSphere Essentials Plus, and Cloud Foundation (VCF) — they all
# expose the same ESXi/vCenter API.
#
#   GOVC_URL='https://root:PASS@esxi.local' GOVC_INSECURE=1 \
#     sh contrib/self-hosted-gate/providers/vsphere-setup.sh
#
# Prereqs: govc (https://github.com/vmware/govmomi/releases). For vCenter/VCF also
# set GOVC_DATACENTER / GOVC_DATASTORE / GOVC_RESOURCE_POOL / GOVC_NETWORK. Uses an
# Alpine OVA so deployment is unattended.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="skillgate-gate"
OVA_URL="${OVA_URL:-https://github.com/mcandre/alpine-ova/releases/download/v3.19.0/alpine-3.19.0.ova}"
PROVISION="${GATE_PROVISION:-sh "$HERE/_common.sh"}"

command -v govc >/dev/null || { echo "govc not on PATH — get it from vmware/govmomi releases."; exit 1; }
[ -n "${GOVC_URL:-}" ] || { echo "Set GOVC_URL (e.g. https://root:PASS@esxi.local)."; exit 1; }

if ! govc vm.info "$NAME" >/dev/null 2>&1; then
  echo "Importing the Alpine OVA as '$NAME' (a few minutes)…"
  cache="${TMPDIR:-/tmp}/alpine-gate.ova"
  [ -f "$cache" ] || curl -fL "$OVA_URL" -o "$cache"
  govc import.ova -name "$NAME" "$cache"
  govc vm.change -vm "$NAME" -m 512 -c 1
fi
govc vm.power -on "$NAME" 2>/dev/null || true

echo "Waiting for the guest IP (needs open-vm-tools in the OVA)…"
ip="$(govc vm.ip "$NAME" 2>/dev/null || true)"
[ -n "$ip" ] || { echo "No IP from VMware tools. Read it from the console, then run providers/_common.sh root@<ip>."; exit 1; }
echo "Guest IP: $ip"

# If the OVA's root SSH isn't enabled, set it in the console once and re-run.
$PROVISION "root@$ip" 22
echo "git remote set-url gate ssh://gate@$ip:22/srv/repos/repo.git"
