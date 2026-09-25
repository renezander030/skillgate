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
if ($status -ne 0 -and $status -ne 2) {
  # Any failure other than a gate block would be non-blocking; block instead.
  [Console]::Error.WriteLine("skillgate: gate could not run (exit $status); blocking (fail-closed)")
  exit 2
}
exit $status
