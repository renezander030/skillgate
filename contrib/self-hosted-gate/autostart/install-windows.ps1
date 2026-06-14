# install-windows.ps1 — keep the gate VM up via a Windows Scheduled Task (at logon +
# every 1 minute, single-instance, resumes after sleep). No admin required (runs as
# you, while logged on). Idempotent. Usage:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 [-Uninstall]
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ensure   = Join-Path $here "ensure-gate.ps1"
$TaskName = "SkillgateGateKeepAlive"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  return
}
if (-not (Test-Path $ensure)) { throw "ensure-gate.ps1 not found: $ensure" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`"" -f $ensure)

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed scheduled task '$TaskName' (at logon + every 1 minute)."
Write-Host "Log: $env:USERPROFILE\.skillgate\gate-keepalive.log"
Write-Host "Uninstall: install-windows.ps1 -Uninstall"
