[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
# Usage: ci-log.ps1 [run-id]   (no id = latest run)
$ErrorActionPreference = 'Continue'
$repo = 'cy-2-u/qinglong'
if ($args.Count -ge 1) {
  $runId = $args[0]
} else {
  $runId = gh run list --repo $repo --limit 1 --json databaseId --jq '.[0].databaseId'
}
Write-Output "RUN: $runId"

# run-level conclusion + job/steps overview
$jobs = gh api "repos/$repo/actions/runs/$runId/jobs" | ConvertFrom-Json
foreach ($job in $jobs.jobs) {
  Write-Output ("JOB: " + $job.name + " -> " + $job.conclusion)
  foreach ($s in $job.steps) {
    Write-Output ("  step: " + $s.name + " -> " + $s.conclusion)
  }
}

# download logs and print the tail of the deploy job log
$token = gh auth token
$tmp = Join-Path $env:TEMP 'ql_ci_logs.zip'
$dest = Join-Path $env:TEMP 'ql_ci_logs'
curl.exe -sL -H ("Authorization: Bearer " + $token) -o $tmp ("https://api.github.com/repos/" + $repo + "/actions/runs/" + $runId + "/logs")
if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 100) { Write-Output 'LOGS_DOWNLOAD_FAIL'; exit 0 }
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive -Path $tmp -DestinationPath $dest -Force
$jobLog = Get-ChildItem -Recurse -File $dest | Where-Object { $_.Name -match 'deploy' } | Select-Object -First 1
if ($jobLog) {
  Write-Output '=== DEPLOY LOG TAIL ==='
  Get-Content -Encoding UTF8 $jobLog.FullName | Select-Object -Last 60
}
