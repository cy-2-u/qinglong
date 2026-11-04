[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$repo = 'cy-2-u/qinglong'
$headSha = gh api "repos/$repo/git/ref/heads/main" --jq '.object.sha'
$baseTree = gh api "repos/$repo/git/commits/$headSha" --jq '.tree.sha'

$set = @{}
gh api "repos/$repo/git/trees/${baseTree}?recursive=1" --jq '.tree[].path' 2>$null | ForEach-Object { $set[$_] = $true }
Write-Output "SET_COUNT=$($set.Count)"
Write-Output "CONTAINS_PROBE=$($set.ContainsKey('relay/.gitignore'))"
Write-Output "CONTAINS_MOCK=$($set.ContainsKey('public/assets/mock.js'))"
