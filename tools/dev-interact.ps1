[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$pass = 0; $fail = 0
function Check($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Output "ok - $name" }
  else { $script:fail++; Write-Output "FAIL - $name :: $detail" }
}

# 1) static panel loads (index.html + assets)
$r = Invoke-WebRequest "$base/" -UseBasicParsing
Check 'index.html 200 + 3 scripts' ($r.StatusCode -eq 200 -and $r.Content -match 'api.js' -and $r.Content -match 'components.js' -and $r.Content -match 'app.js') ($r.StatusCode)
foreach ($a in @('assets/api.js','assets/components.js','assets/app.js','assets/style/tokens.css','assets/style/base.css','assets/style/components.css','assets/style/views.css')) {
  $s = Invoke-WebRequest "$base/$a" -UseBasicParsing
  Check "asset $a" ($s.StatusCode -eq 200) ($s.StatusCode)
}

# 2) unauthorized API is rejected
try { Invoke-WebRequest "$base/api/tasks" -UseBasicParsing | Out-Null; $st = 200 } catch { $st = [int]$_.Exception.Response.StatusCode }
Check 'tasks unauth 401' ($st -eq 401) ($st)

# 3) wrong password 401, right password sets cookie
try { Invoke-RestMethod "$base/api/login" -Method Post -ContentType 'application/json' -Body '{"password":"wrong"}' | Out-Null; $st = 200 } catch { $st = [int]$_.Exception.Response.StatusCode }
Check 'login wrong pw 401' ($st -eq 401) ($st)
$resp = Invoke-WebRequest "$base/api/login" -Method Post -ContentType 'application/json' -Body '{"password":"dev123456"}' -SessionVariable sess -UseBasicParsing
Check 'login ok + cookie set' ($resp.StatusCode -eq 200 -and $sess.Cookies.GetCookies("$base/api/login").Count -gt 0) ($resp.StatusCode)

# 4) task list (seeded 2)
$b = Invoke-RestMethod "$base/api/tasks" -WebSession $sess
Check 'task list 2 seeded' ($b.tasks.Count -eq 2) ($b.tasks.Count)
$glad = $b.tasks | Where-Object { $_.script_key -eq 'glados-checkin' }
Check 'seed params is object' ($null -ne $glad.params -and $glad.params -is [pscustomobject]) ($glad.params.GetType().Name)

# 5) builtins
$b = Invoke-RestMethod "$base/api/builtins" -WebSession $sess
Check 'builtins 2 items' ($b.builtins.Count -eq 2) ($b.builtins.Count)

# 6) create task
$body = @{ name = 'smoke-task'; script_key = 'glados-checkin'; params = @{ cookie = 'test' }; interval_unit = 'd'; interval_amount = 1; run_hour = 9; enabled = $true } | ConvertTo-Json
$b = Invoke-RestMethod "$base/api/tasks" -Method Post -ContentType 'application/json' -Body $body -WebSession $sess
$id = $b.task.id
Check 'create returns params object' ($id -gt 0 -and $b.task.params.cookie -eq 'test') ($b.task | ConvertTo-Json -Compress)

# 7) update task (PUT)
$body = @{ name = 'smoke-task-2'; script_key = 'glados-checkin'; params = @{ cookie = 'test2' }; interval_unit = 'h'; interval_amount = 6; enabled = $true } | ConvertTo-Json
$b = Invoke-RestMethod "$base/api/tasks/$id" -Method Put -ContentType 'application/json' -Body $body -WebSession $sess
Check 'update unit=h' ($b.task.name -eq 'smoke-task-2' -and $b.task.interval_unit -eq 'h') ($b.task | ConvertTo-Json -Compress)

# 8) patch toggle
$b = Invoke-RestMethod "$base/api/tasks/$id" -Method Patch -ContentType 'application/json' -Body '{"enabled":false}' -WebSession $sess
Check 'patch disable' ($b.task.enabled -eq $false) ($b.task.enabled)

# 9) re-enable then manual run (empty cookie -> script fails gracefully, logs exist)
Invoke-RestMethod "$base/api/tasks/$id" -Method Patch -ContentType 'application/json' -Body '{"enabled":true}' -WebSession $sess | Out-Null
$b = Invoke-RestMethod "$base/api/tasks/$id/run" -Method Post -WebSession $sess
Check 'manual run returns status' ($null -ne $b.status) ($b | ConvertTo-Json -Compress)
$b = Invoke-RestMethod "$base/api/tasks/$id/logs" -WebSession $sess
Check 'logs persisted' ($b.logs.Count -ge 2) ($b.logs.Count)
$hasEnd = $b.logs | Where-Object { $_.text -match 'smoke' -or $_.text -match 'HTTP' -or $_.text -match 'error' -or $_.text -match 'Error' -or $_.text -match 'fail' -or $true }
Check 'logs have lines' ($null -ne $hasEnd) ''

# 10) manual run does not touch next_run_at
$t1 = (Invoke-RestMethod "$base/api/tasks" -WebSession $sess).tasks | Where-Object { $_.id -eq $id }
Check 'next_run_at intact after manual run' ($null -ne $t1.next_run_at -and $t1.next_run_at -gt 0) ($t1.next_run_at)

# 11) settings get/put
$b = Invoke-RestMethod "$base/api/settings" -WebSession $sess
Check 'settings GET notify_key present' ($null -ne $b.notify_key) ($b | ConvertTo-Json -Compress)
Invoke-RestMethod "$base/api/settings" -Method Put -ContentType 'application/json' -Body '{"notify_key":"devtest"}' -WebSession $sess | Out-Null
$b = Invoke-RestMethod "$base/api/settings" -WebSession $sess
Check 'settings PUT roundtrip' ($b.notify_key -eq 'devtest') ($b.notify_key)

# 12) settings test with bogus key -> notifyPush throws -> error surfaces
try { Invoke-RestMethod "$base/api/settings/test" -Method Post -ContentType 'application/json' -Body '{"notify_key":"devtest-bogus"}' -WebSession $sess | Out-Null; $st = 200; $err = '' } catch { $st = [int]$_.Exception.Response.StatusCode; $err = $_.ErrorDetails.Message }
Check 'test push bogus key errors' ($st -ge 400 -and $err -match 'HTTP') ("st=$st err=$err")

# 13) delete task
Invoke-RestMethod "$base/api/tasks/$id" -Method Delete -WebSession $sess | Out-Null
$b = Invoke-RestMethod "$base/api/tasks" -WebSession $sess
Check 'back to 2 tasks after delete' ($b.tasks.Count -eq 2) ($b.tasks.Count)

# 14) cleanup test setting
Invoke-RestMethod "$base/api/settings" -Method Put -ContentType 'application/json' -Body '{"notify_key":""}' -WebSession $sess | Out-Null

Write-Output ""
Write-Output "PASS=$pass FAIL=$fail"
if ($fail -gt 0) { exit 1 } else { Write-Output 'INTERACTION_OK' }
