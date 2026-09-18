# Skillgate Claude Code PreToolUse hook for native Windows/PowerShell sessions.
$payload = [Console]::In.ReadToEnd()
$npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npx) { $npx = Get-Command npx -ErrorAction SilentlyContinue }
if (-not $npx) {
  [Console]::Error.WriteLine("skillgate: npx was not found; blocking configured hook (fail-closed)")
  exit 2
}

$payload | & $npx.Source --yes "@reneza/skillgate@latest" gate
$status = $LASTEXITCODE
if ($null -eq $status) { exit 2 }
exit $status
