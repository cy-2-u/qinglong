[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$files = gh api 'repos/cy-2-u/qinglong/git/trees/main?recursive=1' --jq '.tree[].path'
$blobs = $files | Where-Object { $_ -ne '' }
Write-Output ("TOTAL_PATHS: " + @($blobs).Count)
$blobs | Sort-Object
