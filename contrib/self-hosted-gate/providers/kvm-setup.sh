#!/usr/bin/env sh
# kvm-setup.sh — gate VM on Linux's built-in KVM (libvirt + virt-install). Uses an
# Alpine nocloud image + cloud-init to inject SSH, then runs the provisioner. A real
# VM → a genuine credential boundary (deny the agent libvirt access).
#
#   sh contrib/self-hosted-gate/providers/kvm-setup.sh
#
# Prereqs: qemu-kvm, libvirt, virt-install, cloud-localds (cloud-image-utils), wget.
# Tip: with Vagrant, `vagrant up --provider=libvirt` from this dir does the same
# (needs the vagrant-libvirt plugin).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRIB="$(cd "$HERE/.." && pwd)"
NAME="skillgate-gate"
IMGDIR="${IMGDIR:-$HOME/.local/share/skillgate-gate}"
ALPINE_URL="${ALPINE_URL:-https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/cloud/nocloud_alpine-3.19.1-x86_64-bios-cloudinit-r0.qcow2}"
PUB="${GATE_PUBKEY:-$CONTRIB/authorized_key.pub}"
PROVISION="${GATE_PROVISION:-sh "$HERE/_common.sh"}"
mkdir -p "$IMGDIR"

[ -f "$PUB" ] || { echo "Missing push key $PUB (generate one and authorize it)."; exit 1; }
base="$IMGDIR/alpine-base.qcow2"; disk="$IMGDIR/$NAME.qcow2"
[ -f "$base" ] || { echo "Downloading Alpine cloud image…"; wget -O "$base" "$ALPINE_URL"; }
[ -f "$disk" ] || qemu-img create -f qcow2 -F qcow2 -b "$base" "$disk" 4G

seed="$IMGDIR/seed.iso"; ud="$IMGDIR/user-data"; meta="$IMGDIR/meta-data"
cat > "$ud" <<EOF
#cloud-config
users:
  - name: root
    ssh_authorized_keys:
      - $(cat "$PUB")
ssh_pwauth: false
runcmd:
  - rc-update add sshd default
  - rc-service sshd start
EOF
echo "instance-id: $NAME" > "$meta"
cloud-localds "$seed" "$ud" "$meta"

if ! virsh dominfo "$NAME" >/dev/null 2>&1; then
  echo "Creating KVM domain '$NAME'…"
  virt-install --name "$NAME" --memory 512 --vcpus 1 --import \
    --disk "path=$disk,format=qcow2" --disk "path=$seed,device=cdrom" \
    --os-variant alpinelinux3.18 --network network=default --graphics none --noautoconsole
fi

echo "Waiting for the guest IP…"
ip=""
for _ in $(seq 1 30); do
  ip="$(virsh domifaddr "$NAME" 2>/dev/null | awk '/ipv4/ {sub(/\/.*/,"",$4); print $4; exit}')"
  [ -n "$ip" ] && break; sleep 2
done
[ -n "$ip" ] || { echo "Could not determine guest IP (try 'virsh domifaddr $NAME')."; exit 1; }
echo "Guest IP: $ip"

$PROVISION "root@$ip" 22
echo "git remote set-url gate ssh://gate@$ip:22/srv/repos/repo.git"
