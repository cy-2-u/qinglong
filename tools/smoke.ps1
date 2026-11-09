[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# 1) unit + mock e2e tests
foreach ($t in @('test-nextrun.mjs', 'test-dnshe.mjs', 'test-glados.mjs', 'test-notify.mjs', 'test-runner.mjs')) {
  node (Join-Path $PSScriptRoot $t)
  if ($LASTEXITCODE -ne 0) { Write-Output "TEST_FAIL: $t"; exit 1 }
}

# 2) syntax check everything (package.json type:module => node --check parses .js as ESM,
#    no copy-as-.mjs dance needed)
$files = @(
  'src/index.js', 'src/auth.js', 'src/runner.js', 'src/scheduler.js',
  'src/seed.js', 'src/nextrun.js', 'src/notify.js', 'src/builtins.js',
  'src/tasks/glados-checkin.js', 'src/tasks/dnshe-renew.js',
  'public/assets/api.js', 'public/assets/components.js', 'public/assets/app.js'
)
foreach ($f in $files) {
  node --check (Join-Path $root $f)
  if ($LASTEXITCODE -ne 0) { Write-Output "SYNTAX_FAIL: $f"; exit 1 }
}

Write-Output 'SMOKE_OK'
