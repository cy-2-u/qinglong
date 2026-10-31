[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent   # D:\work\Qinglong project root (qinglong dir)
$parent = Split-Path $root -Parent
$ref = Join-Path $root 'reference'
New-Item -ItemType Directory -Force -Path $ref | Out-Null

$copyMap = @(
  @{ src = Join-Path $parent '2026-glados-checkin-main\checkin.py';           dst = 'glados_checkin.py' },
  @{ src = Join-Path $parent 'DNSHE-Auto-Renew-main\renew_domains.py';        dst = 'dnshe_renew_domains.py' },
  @{ src = Join-Path $parent 'DNSHE-Auto-Renew-main\LICENSE';                 dst = 'dnshe_LICENSE' },
  @{ src = Join-Path $parent 'UptimeFlare-main\worker\src\scheduler.ts';      dst = 'uptimeflare_scheduler.ts' },
  @{ src = Join-Path $parent 'UptimeFlare-main\worker\src\coordinator.ts';    dst = 'uptimeflare_coordinator.ts' }
)
foreach ($c in $copyMap) {
  Copy-Item -Path $c.src -Destination (Join-Path $ref $c.dst) -Force
  Write-Output ("COPIED " + $c.dst)
}
Write-Output '--- gh auth ---'
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) { Write-Output 'NO_GH'; exit 0 }
gh auth status 2>&1 | ForEach-Object { $_.ToString() }
Write-Output '--- git identity ---'
$n = git config --global user.name
$e = git config --global user.email
Write-Output ("name=" + $(if ($n) { $n } else { '(empty)' }))
Write-Output ("email=" + $(if ($e) { $e } else { '(empty)' }))
