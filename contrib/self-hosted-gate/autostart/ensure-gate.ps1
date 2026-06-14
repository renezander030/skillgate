# ensure-gate.ps1 — Windows core: make sure the self-hosted gate VM is running.
# Idempotent + safe under many concurrent callers (lockless "already up" check; a
# global mutex only when starting). Resumes a 'saved' VM after sleep.
# Config via env: SKILLGATE_VM (default skillgate-gate), SKILLGATE_GATE_DIR
# (default: parent of this script).
$ErrorActionPreference = "Stop"

$VM      = if ($env:SKILLGATE_VM) { $env:SKILLGATE_VM } else { "skillgate-gate" }
$GateDir = if ($env:SKILLGATE_GATE_DIR) { $env:SKILLGATE_GATE_DIR } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$VBox    = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$Vagrant = "C:\Program Files\Vagrant\bin\vagrant.exe"
$Log     = Join-Path $env:USERPROFILE ".skillgate\gate-keepalive.log"
New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
function Log($m) { "{0} {1}" -f (Get-Date -Format s), $m | Add-Content -Path $Log }

if (-not (Test-Path $VBox)) { Log "VBoxManage not found; skip"; exit 0 }

$running = & $VBox list runningvms 2>$null
if ($running -match [regex]::Escape($VM)) { exit 0 }   # already up (lockless hot path)

$mtx = New-Object System.Threading.Mutex($false, "Global\skillgate-gate-ensure")
$held = $false
try { $held = $mtx.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
if (-not $held) { exit 0 }
try {
  $running = & $VBox list runningvms 2>$null
  if ($running -match [regex]::Escape($VM)) { exit 0 }
  Log "VM '$VM' not running -> vagrant up"
  $env:VAGRANT_CWD = $GateDir
  if (Test-Path $Vagrant) { & $Vagrant up 2>&1 | Add-Content -Path $Log } else { & vagrant up 2>&1 | Add-Content -Path $Log }
  Log ("vagrant up exit={0}" -f $LASTEXITCODE)
} finally { try { $mtx.ReleaseMutex() } catch {}; $mtx.Dispose() }
