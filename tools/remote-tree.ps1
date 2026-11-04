[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$repo = 'cy-2-u/qinglong'
gh api "repos/$repo/git/trees/main?recursive=1" --jq .tree[].path
