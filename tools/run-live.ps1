[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$env:QL_PARAMS_FILE = $args[0]
node (Join-Path $PSScriptRoot 'live-run.mjs') $args[1]
