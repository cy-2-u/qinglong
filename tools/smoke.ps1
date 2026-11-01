[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tmp = Join-Path $env:TEMP 'ql_smoke_tmp'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# 1) scheduler math + builtin script tests
node (Join-Path $PSScriptRoot 'test-nextrun.mjs')
if ($LASTEXITCODE -ne 0) { Write-Output 'TEST_FAIL: nextrun'; exit 1 }
node (Join-Path $PSScriptRoot 'test-dnshe.mjs')
if ($LASTEXITCODE -ne 0) { Write-Output 'TEST_FAIL: dnshe'; exit 1 }
node (Join-Path $PSScriptRoot 'test-glados.mjs')
if ($LASTEXITCODE -ne 0) { Write-Output 'TEST_FAIL: glados'; exit 1 }

# 2) panel scripts (plain check)
$panel = @('app.js', 'api.js', 'mock.js')
foreach ($f in $panel) {
  $p = Join-Path $root 'public\assets'
  $p = Join-Path $p $f
  node --check $p
  if ($LASTEXITCODE -ne 0) { Write-Output "SYNTAX_FAIL: $f"; exit 1 }
}

# 3) backend ESM -> copy as .mjs then check
$esm = @('index.js', 'runner.js', 'scheduler.js', 'seed.js', 'nextrun.js', 'notify.js', 'coordinator.js')
foreach ($f in $esm) {
  $p = Join-Path $root 'src'
  $p = Join-Path $p $f
  $d = Join-Path $tmp ($f.Replace('.js', '.mjs'))
  Copy-Item $p $d -Force
  node --check $d
  if ($LASTEXITCODE -ne 0) { Write-Output "SYNTAX_FAIL: src/$f"; exit 1 }
}

  # 4) builtin task modules -> copy as .mjs then check
  $tasks = @('glados-checkin.js', 'dnshe-renew.js')
  foreach ($f in $tasks) {
    $p = Join-Path $root 'src\tasks'
    $p = Join-Path $p $f
    $d = Join-Path $tmp $f
    Copy-Item $p $d -Force
    node --check $d
    if ($LASTEXITCODE -ne 0) { Write-Output "SYNTAX_FAIL: tasks/$f"; exit 1 }
  }

Remove-Item -Recurse -Force $tmp
Write-Output 'SMOKE_OK'
