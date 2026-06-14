# Keep the gate VM always-on (portable autostart + minute keep-alive)

Optional companion to the [self-hosted gate](../README.md). Keeps the gate VM
started at login, up continuously, and back within ~1 minute after the host wakes
from sleep — without parallel agent sessions stepping on each other.

The logic is one small idempotent script per platform; the OS scheduler just calls
it every minute:

- **`ensure-gate.sh`** (macOS / Linux / BSD) and **`ensure-gate.ps1`** (Windows).
  Hot path = a lockless "is it running?" check (instant, so any number of callers are
  fine); only the "needs starting" path takes a lock (atomic `mkdir` lock on Unix, a
  global mutex on Windows), so the scheduler and N sessions never collide on
  `vagrant up`. After sleep the VM is `saved` (not "running"), so it gets resumed.

Configure via env if your VM/dir differ from the defaults (`skillgate-gate`, and the
parent dir of these scripts): `SKILLGATE_VM`, `SKILLGATE_GATE_DIR`, `SKILLGATE_LOG`.
Log: `~/.skillgate/gate-keepalive.log`.

## Install per platform

### Windows — Scheduled Task
```powershell
powershell -ExecutionPolicy Bypass -File autostart\install-windows.ps1
# remove: ... install-windows.ps1 -Uninstall
```

### macOS — launchd
```sh
sh autostart/install-macos.sh
# remove: sh autostart/install-macos.sh --uninstall
```

### Linux (systemd) — RHEL/Fedora/Rocky/Alma, Debian/Ubuntu/Mint, Arch, openSUSE
```sh
sh autostart/install-systemd.sh
loginctl enable-linger "$USER"   # optional: keep running while logged out
# remove: sh autostart/install-systemd.sh --uninstall
```

### BSD (and any cron system) — FreeBSD/OpenBSD/NetBSD
```sh
sh autostart/install-cron.sh
# remove: sh autostart/install-cron.sh --uninstall
```

## Prerequisites per OS (VirtualBox + Vagrant)

| OS family | Install |
|---|---|
| Debian / Ubuntu / Mint | `sudo apt install virtualbox vagrant` |
| RHEL / Fedora / Rocky / Alma | `sudo dnf install VirtualBox vagrant` (VirtualBox via Oracle/RPM Fusion repo) |
| Arch / Manjaro | `sudo pacman -S virtualbox vagrant` |
| openSUSE | `sudo zypper install virtualbox vagrant` |
| macOS | `brew install --cask virtualbox vagrant` |
| FreeBSD | `pkg install virtualbox-ose vagrant` (or the bhyve provider — see [`../providers/`](../providers/)) |
| Windows | `winget install Oracle.VirtualBox Hashicorp.Vagrant` |

On the BSDs VirtualBox support is limited; if you run the **bhyve** provider instead,
`ensure-gate.sh` automatically falls back from `VBoxManage` to `vagrant status`.

## How single-instance + sleep are handled per scheduler

| Scheduler | Every minute | Single instance | After wake |
|---|---|---|---|
| Windows Task | logon + `RepetitionInterval 1m` | `MultipleInstances=IgnoreNew` | `StartWhenAvailable` |
| launchd | `StartInterval 60` | launchd won't relaunch while running | fires on wake |
| systemd timer | `OnCalendar=minutely` | oneshot won't re-run while active | `Persistent=true` |
| cron | `* * * * *` + `@reboot` | atomic lock in `ensure-gate.sh` | next tick after wake |

## Caveats

- **It fights a manual stop.** Within a minute the keep-alive brings the VM back. To
  actually stop it, uninstall the keep-alive first, then `vagrant halt`.
- **Uptime is not enforcement.** Keeping the VM up only makes the gate *available*; it
  bites only pushes routed through the gate, and the hard guarantee still needs the
  agent to not hold the upstream push credential (see [`../README.md`](../README.md)).
