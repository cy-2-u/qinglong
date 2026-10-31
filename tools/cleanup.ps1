[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$parent = Split-Path $root -Parent
$ref = Join-Path $root 'reference'

# 1) verify reference copies exist before deleting sources
$must = @('glados_checkin.py', 'dnshe_renew_domains.py', 'dnshe_LICENSE', 'uptimeflare_scheduler.ts', 'uptimeflare_coordinator.ts')
foreach ($f in $must) {
  if (-not (Test-Path (Join-Path $ref $f))) { Write-Output "MISSING_REF: $f - ABORT"; exit 1 }
}
Write-Output 'REF_OK (5 files)'

# 2) delete the three legacy project folders (user-approved cleanup)
$targets = @(
  (Join-Path $parent '2026-glados-checkin-main'),
  (Join-Path $parent 'DNSHE-Auto-Renew-main'),
  (Join-Path $parent 'UptimeFlare-main')
)
foreach ($t in $targets) {
  if (Test-Path $t) {
    Remove-Item -Recurse -Force $t
    Write-Output ("DELETED " + $t)
  } else {
    Write-Output ("SKIP (not found) " + $t)
  }
}

# 3) show remaining workspace tree (top level)
Write-Output '--- workspace now ---'
Get-ChildItem $parent | ForEach-Object { Write-Output $_.Name }
