# Hypervisor options for the self-hosted gate

The gate guest is identical on every hypervisor — only VM creation differs. Each
recipe ends by running the gate provisioner (`../provision.sh`) through
[`_common.sh`](_common.sh), so the gate is one source of truth; the per-hypervisor
scripts only stand up the Alpine VM.

> Generate a push key first and save its public half as `../authorized_key.pub`
> (or point `GATE_PUBKEY` at it). It's installed into the guest so you can push.

## Pick your hypervisor

| Hypervisor | OS | Recipe | Boundary |
|---|---|---|---|
| **VirtualBox** | Win/Lin/mac | `vagrant up` (default Vagrantfile) | Hard |
| **KVM** (built-in) | Linux | `vagrant up --provider=libvirt`, or [`kvm-setup.sh`](kvm-setup.sh) | Hard |
| **Hyper-V** (built-in) | Win Pro | `vagrant up --provider=hyperv` (elevated) | Hard |
| **VMware Workstation Pro** | Win/Lin | `vagrant up --provider=vmware_desktop`, or [`vmware-setup.sh`](vmware-setup.sh) | Hard |
| **VMware Fusion Pro** | macOS | `vagrant up --provider=vmware_desktop`, or [`vmware-setup.sh`](vmware-setup.sh) | Hard |
| **ESXi / vSphere VVF / Essentials Plus / VCF** | server | [`vsphere-setup.sh`](vsphere-setup.sh) (`govc`) | Hard |
| **XCP-ng** (Xen) | server | [`xcpng-setup.sh`](xcpng-setup.sh) (`xe`) | Hard |
| **bhyve** | FreeBSD | [`bhyve-setup.sh`](bhyve-setup.sh) (`vm-bhyve`) | Hard |
| **WSL2** | Windows | [`wsl2-setup.ps1`](wsl2-setup.ps1) | **Soft** ⚠ |

All four VMware server tiers share the same ESXi/vCenter API, so the single
`vsphere-setup.sh` (`govc`) recipe covers them — set `GOVC_DATACENTER`/`GOVC_DATASTORE`/
etc. as your environment needs.

## The WSL2 caveat (why it's "Soft")

WSL2 is a real VM, but `wsl.exe` opens a shell into the distro with no separate auth,
so it is **not a credential boundary against a host-side agent** — an agent running as
your user could reach in and weaken the gate. Use WSL2 for fast feedback; use a
**Hard** row when you need the guarantee that the agent can't tamper with the gate.

## What "Hard" requires (all rows)

A separate VM is the boundary, but it's only fully agent-proof if the agent **does
not hold the upstream push credential** — else it bypasses the box by pushing to the
upstream directly. Put the upstream deploy key only on the box and let `post-receive`
mirror accepted pushes (see [`../README.md`](../README.md)). Without that, every row
is "strong-soft".

## Reusing these recipes with your own gate (downstream)

The per-hypervisor scripts only create the VM; the provisioning step is
configurable. To run your OWN gate (different language/spec) on the same VMs, export:

```sh
GATE_PROVISION="sh /path/to/your/_common.sh"   # run once the guest SSH is up
GATE_PUBKEY="/path/to/your/push_key.pub"         # key to authorize on the guest
sh kvm-setup.sh                                  # (or any recipe here)
```

For example, MegaCooper points `GATE_PROVISION` at its Nim-based provisioner so the
same KVM/bhyve/vSphere/XCP-ng/WSL2 recipes stand up its gate instead of the Node one.

## Honest status

These recipes are syntax-checked and built on the shared provisioner, but the
per-hypervisor VM creation is environment/license-specific (image URLs, datastore/
network names, guest-agent availability) — expect to set a few env vars. The Vagrant
paths are the most turnkey.
