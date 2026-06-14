# wsl2-setup.ps1 — stand up the gate inside a dedicated Alpine WSL2 distro (Windows).
# Convenience path, for those who already have WSL2 working.
#
#   powershell -ExecutionPolicy Bypass -File contrib\self-hosted-gate\providers\wsl2-setup.ps1
#
# SECURITY NOTE: WSL2 is NOT a credential boundary against a host agent — `wsl.exe`
# opens a shell into the distro with no separate auth, so a host-side agent could
# weaken the gate. Use it for fast feedback; use a real VM (VirtualBox/KVM/VMware/
# ESXi/XCP-ng/bhyve) for the HARD guarantee.
$ErrorActionPreference = "Stop"

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path     # providers
$contrib = (Get-Item $here).Parent.FullName                   # self-hosted-gate
$distro  = "skillgate-gate"
$rootfsUrl = "https://dl-cdn.alpinelinux.org/alpine/v3.19/releases/x86_64/alpine-minirootfs-3.19.1-x86_64.tar.gz"
$store   = Join-Path $env:LOCALAPPDATA "skillgate-gate-wsl"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw "WSL not installed." }

if (-not ((wsl.exe -l -q) -contains $distro)) {
  New-Item -ItemType Directory -Force -Path $store | Out-Null
  $tar = Join-Path $env:TEMP "alpine-rootfs.tar.gz"
  Write-Host "Downloading Alpine minirootfs…"
  Invoke-WebRequest -Uri $rootfsUrl -OutFile $tar
  Write-Host "Importing WSL2 distro '$distro'…"
  wsl.exe --import $distro $store $tar --version 2
} else {
  Write-Host "WSL2 distro '$distro' already present."
}

function WslPath($winPath) { (wsl.exe -d $distro wslpath ("'" + $winPath + "'")).Trim() }
$contribW = WslPath $contrib

$script = @"
set -eu
mkdir -p /tmp
cp '$contribW/pre-receive'  /tmp/pre-receive
cp '$contribW/post-receive' /tmp/post-receive
[ -f '$contribW/done.yaml' ] && cp '$contribW/done.yaml' /tmp/done.yaml || true
[ -f '$contribW/authorized_key.pub' ] && cp '$contribW/authorized_key.pub' /tmp/authorized_key.pub || true
sh '$contribW/provision.sh'
# WSL2 forwards localhost, so the gate is reachable at 127.0.0.1:22 from Windows.
"@
$script = $script -replace "`r`n", "`n"
wsl.exe -d $distro -u root -- sh -c $script

Write-Host ""
Write-Host "Gate ready in WSL2. Point your repo at it:"
Write-Host "  git remote set-url gate ssh://gate@127.0.0.1:22/srv/repos/repo.git"
