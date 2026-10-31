[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$paths = @(
  'C:\Program Files\Git\cmd\git.exe',
  'C:\Program Files\Git\bin\git.exe',
  "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe",
  'C:\Git\cmd\git.exe'
)
$found = $null
foreach ($p in $paths) { if (Test-Path $p) { $found = $p; Write-Output "FOUND: $p" } }
if (-not $found) {
  $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($cmd) { $found = $cmd.Source; Write-Output "FOUND: $($cmd.Source)" }
}
if (-not $found) { Write-Output 'GIT_NOT_FOUND' } else { Write-Output 'GIT_OK' }
$wg = Get-Command winget -ErrorAction SilentlyContinue
if ($wg) { Write-Output 'WINGET_OK' } else { Write-Output 'NO_WINGET' }
# scoop / portable common spots
foreach ($d in @("$env:USERPROFILE\scoop\apps\git\current\cmd", 'D:\Git\cmd', 'D:\Program Files\Git\cmd')) {
  if (Test-Path (Join-Path $d 'git.exe')) { Write-Output "FOUND: $d\git.exe" }
}
