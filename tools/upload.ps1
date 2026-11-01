[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) { Write-Output 'NO_GH'; exit 1 }

$login = gh api user --jq '.login'
if ($LASTEXITCODE -ne 0) { Write-Output 'GH_AUTH_FAIL'; exit 1 }
Write-Output "GH_USER: $login"
$full = "$login/qinglong"

# ---------- 1) ensure repo exists (create if missing; token lacks delete_repo, reuse when present) ----------
$probe = gh repo view $full --json name 2>$null
if (-not $probe) {
  gh repo create qinglong --private 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Output 'CREATE_FAIL'; exit 1 }
  Write-Output 'REPO_CREATED'
} else {
  Write-Output 'REPO_EXISTS_REUSE'
}
gh repo edit $full --description "QingLong-style scheduled task panel on Cloudflare Workers (D1 + Durable Object)" 2>&1 | Out-Null

# ---------- 2) bootstrap empty repo: Contents API creates the first commit on main ----------
$headSha = gh api "repos/$full/git/ref/heads/main" --jq '.object.sha' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $headSha) {
  Write-Output 'BOOTSTRAP: empty repo, creating first commit via Contents API'
  $initBody = @{ message = 'chore: init'; content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('init')) } | ConvertTo-Json
  $jsonInit = Join-Path $env:TEMP 'ql_init.json'
  [System.IO.File]::WriteAllText($jsonInit, $initBody, (New-Object System.Text.UTF8Encoding($false)))
  gh api -X PUT "repos/$full/contents/README.md" --input $jsonInit 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Output 'BOOTSTRAP_FAIL'; exit 1 }
  $headSha = gh api "repos/$full/git/ref/heads/main" --jq '.object.sha' 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $headSha) { Write-Output 'HEAD_FAIL'; exit 1 }
}
Write-Output "HEAD: $headSha"

$baseTree = gh api "repos/$full/git/commits/$headSha" --jq '.tree.sha' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $baseTree) { Write-Output 'BASETREE_FAIL'; exit 1 }

# ---------- 3) collect files ----------
$excludeDirs = @('node_modules', '.wrangler', '.git')
$files = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length + 1)
  $parts = $rel.Split('\')
  if ($parts | Where-Object { $excludeDirs -contains $_ }) { return $false }
  if ($rel -eq '.dev.vars') { return $false }
  return $true
}
Write-Output ("FILES: " + $files.Count)

$entries = @()
foreach ($f in $files) {
  $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
  $content = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
  $entries += [PSCustomObject]@{ path = $rel; mode = '100644'; type = 'blob'; content = $content }
}

# paths listed in delete-list.txt are removed from the repo (sha=null deletes the entry);
# skip paths already absent from the base tree (GitHub rejects deleting nonexistent entries)
$deleteListFile = Join-Path $PSScriptRoot 'delete-list.txt'
if (Test-Path $deleteListFile) {
  $basePathSet = @{}
  gh api "repos/$full/git/trees/$baseTree?recursive=1" --jq '.tree[].path' 2>$null | ForEach-Object { $basePathSet[$_] = $true }
  Get-Content $deleteListFile -Encoding UTF8 | ForEach-Object {
    $p = $_.Trim()
    if ($p -and -not $p.StartsWith('#')) {
      if ($basePathSet.ContainsKey($p.Replace('\', '/'))) {
        $entries += [PSCustomObject]@{ path = $p.Replace('\', '/'); mode = '100644'; type = 'blob'; sha = $null }
        Write-Output ("DELETE_REMOTE: " + $p)
      } else {
        Write-Output ("DELETE_SKIP (not in base tree): " + $p)
      }
    }
  }
}

$treeObj = @{ base_tree = $baseTree; tree = $entries }
$treeBody = $treeObj | ConvertTo-Json -Depth 4
$jsonTree = Join-Path $env:TEMP 'ql_tree.json'
[System.IO.File]::WriteAllText($jsonTree, $treeBody, (New-Object System.Text.UTF8Encoding($false)))

# ---------- 4) tree -> commit -> update main ----------
$treeSha = gh api "repos/$full/git/trees" --input $jsonTree --jq '.sha' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $treeSha) { Write-Output 'TREE_FAIL'; exit 1 }
Write-Output "TREE: $treeSha"

$msgFile = Join-Path $PSScriptRoot 'commit-msg.txt'
$msg = [System.IO.File]::ReadAllText($msgFile, [System.Text.Encoding]::UTF8)
# commit body via --input JSON: multiline -f args get mangled by PS 5.1 native arg passing
$commitBody = @{ message = $msg; tree = $treeSha; parents = @($headSha) } | ConvertTo-Json
$jsonCommit = Join-Path $env:TEMP 'ql_commit.json'
[System.IO.File]::WriteAllText($jsonCommit, $commitBody, (New-Object System.Text.UTF8Encoding($false)))
$commitSha = gh api "repos/$full/git/commits" --input $jsonCommit --jq '.sha' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $commitSha) { Write-Output 'COMMIT_FAIL'; exit 1 }
Write-Output "COMMIT: $commitSha"

$patchBody = @{ sha = $commitSha; force = $false } | ConvertTo-Json
$jsonPatch = Join-Path $env:TEMP 'ql_ref.json'
[System.IO.File]::WriteAllText($jsonPatch, $patchBody, (New-Object System.Text.UTF8Encoding($false)))
gh api -X PATCH "repos/$full/git/refs/heads/main" --input $jsonPatch --jq '.object.sha' 2>$null
if ($LASTEXITCODE -ne 0) { Write-Output 'REF_FAIL'; exit 1 }

# ---------- 5) verify ----------
$count = gh api "repos/$full/git/trees/main?recursive=1" --jq '.tree | length' 2>$null
Write-Output "TREE_FILES: $count"
Write-Output "DONE: https://github.com/$full"
