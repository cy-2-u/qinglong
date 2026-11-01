[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$full = 'cy-2-u/qinglong'
$headSha = gh api "repos/$full/git/ref/heads/main" --jq '.object.sha'
$baseTree = gh api "repos/$full/git/commits/$headSha" --jq '.tree.sha'
Write-Output "HEAD=$headSha BASE=$baseTree"

$msgFile = Join-Path $PSScriptRoot 'commit-msg.txt'
$msg = [System.IO.File]::ReadAllText($msgFile, [System.Text.Encoding]::UTF8)
Write-Output ('MSG_LEN=' + $msg.Length)
Write-Output ('MSG_FIRST=' + $msg.Substring(0, [Math]::Min(60, $msg.Length)).Replace("`n", '\n'))
Write-Output ('MSG_LAST=' + $msg.Substring([Math]::Max(0, $msg.Length - 60)).Replace("`n", '\n'))
Write-Output '--- try commit with visible stderr ---'
$commitSha = gh api "repos/$full/git/commits" -f message=$msg -f tree=$baseTree -f "parents[]=$headSha" --jq '.sha'
Write-Output ("EXIT=" + $LASTEXITCODE + " SHA=" + $commitSha)
