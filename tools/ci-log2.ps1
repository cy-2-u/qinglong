[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$token = gh auth token
$tmp = Join-Path $env:TEMP 'ql_ci_logs.zip'
$dest = Join-Path $env:TEMP 'ql_ci_logs'
curl.exe -sL -H ("Authorization: Bearer " + $token) -o $tmp "https://api.github.com/repos/cy-2-u/qinglong/actions/runs/41194597204/logs"
if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 100) { Write-Output 'DOWNLOAD_FAIL'; exit 0 }
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive -Path $tmp -DestinationPath $dest -Force
Get-ChildItem -Recurse -File $dest | ForEach-Object { Write-Output ('FILE: ' + $_.Name) }
$jobLog = Get-ChildItem -Recurse -File $dest | Where-Object { $_.Name -match 'deploy' } | Select-Object -First 1
if ($jobLog) {
  Write-Output '=== TAIL ==='
  Get-Content -Encoding UTF8 $jobLog.FullName | Select-Object -Last 55
}
