[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if ($args.Count -lt 2) { throw 'Usage: pwsh -File tools/upload.ps1 owner/repo "reason" [-Publish]' }
$repo, $message = $args[0], $args[1]
if ($repo -notmatch '^[\w.-]+/[\w.-]+$' -or $message -match '[\r\n]' -or -not $message.Trim()) { throw 'Invalid repository or single-line message' }
$publish = $args.Count -eq 3 -and $args[2] -eq '-Publish'
if ($args.Count -gt 2 -and -not $publish) { throw 'Unknown argument' }
$paths = @('.github/workflows/deploy.yml','.gitignore','.dev.vars.example','LICENSE','README.md','package.json','package-lock.json','wrangler.toml')
foreach ($directory in @('src','public','tools')) {
  $paths += Get-ChildItem -LiteralPath (Join-Path $root $directory) -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($root,$_.FullName).Replace([char]92,'/') }
}
$paths = @($paths | Sort-Object -Unique)
foreach ($path in $paths) { if (-not (Test-Path -LiteralPath (Join-Path $root $path) -PathType Leaf)) { throw "Missing file: $path" } }
$paths | Write-Output
if (-not $publish) { Write-Output 'Preview only. -Publish replaces the remote tree with these files and triggers CI.'; exit 0 }
function Api([string]$endpoint, $body) {
  if ($null -eq $body) { $result = gh api $endpoint }
  else {
    $file = Join-Path $env:TEMP ("qinglong-" + [guid]::NewGuid() + '.json')
    try {
      $body | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $file -Encoding UTF8
      $result = gh api $endpoint --input $file
    } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
  }
  if ($LASTEXITCODE -ne 0) { throw "GitHub API failed: $endpoint" }
  return ($result | ConvertFrom-Json)
}
$head = (Api "repos/$repo/git/ref/heads/main" $null).object.sha
$entries = foreach ($path in $paths) { @{path=$path; mode='100644'; type='blob'; content=Get-Content -LiteralPath (Join-Path $root $path) -Raw -Encoding UTF8} }
$tree = Api "repos/$repo/git/trees" @{tree=@($entries)}
$current = Api "repos/$repo/git/commits/$head" $null
if ($tree.sha -eq $current.tree.sha) { Write-Output 'No changes'; exit 0 }
$commit = Api "repos/$repo/git/commits" @{message=$message; tree=$tree.sha; parents=@($head)}
$file = Join-Path $env:TEMP ("qinglong-" + [guid]::NewGuid() + '.json')
try {
  @{sha=$commit.sha; force=$false} | ConvertTo-Json | Set-Content -LiteralPath $file -Encoding UTF8
  gh api -X PATCH "repos/$repo/git/refs/heads/main" --input $file --jq '.object.sha'
  if ($LASTEXITCODE -ne 0) { throw 'Branch update failed; remote may have changed' }
} finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
