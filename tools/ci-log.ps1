[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$runId = $args[0]
$jobs = gh api "repos/cy-2-u/qinglong/actions/runs/$runId/jobs" | ConvertFrom-Json
foreach ($job in $jobs.jobs) {
  Write-Output ("JOB: " + $job.name + " -> " + $job.conclusion)
  foreach ($s in $job.steps) {
    Write-Output ("  step: " + $s.name + " -> " + $s.conclusion)
  }
  $anns = gh api "repos/cy-2-u/qinglong/check-runs/$($job.check_run_id)/annotations" 2>$null | ConvertFrom-Json
  foreach ($a in $anns) {
    Write-Output ("  [ANNOTATION] " + $a.annotation_level + ": " + $a.message)
  }
  $log = gh run view $runId --repo cy-2-u/qinglong --job $job.id 2>$null
  $log | ForEach-Object { $_.ToString() } | Select-Object -Last 40 | ForEach-Object { Write-Output ("  | " + $_) }
}
