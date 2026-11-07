[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Start-Sleep -Seconds 10
$base = 'http://127.0.0.1:8787'
# 1) migration: seeded tasks still fine
$h = Invoke-RestMethod "$base/health" -TimeoutSec 10
Write-Output ("HEALTHY=" + $h.healthy + " TASKS=" + $h.taskCount)
# 2) create daily 9:03 task via API
$body = '{"password":"dev123456"}'
$req = [System.Net.HttpWebRequest]::Create("$base/api/login")
$req.Method = 'POST'; $req.ContentType = 'application/json'
$b = [System.Text.Encoding]::UTF8.GetBytes($body); $req.ContentLength = $b.Length
$s = $req.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close()
$resp = $req.GetResponse(); $ck = $resp.Headers['Set-Cookie'].Split(';')[0]; $resp.Close()

$body = '{"name":"min-check","script_key":"glados-checkin","params":{"cookie":"x"},"interval_unit":"d","interval_amount":1,"run_hour":9,"run_minute":3,"enabled":true}'
$req = [System.Net.HttpWebRequest]::Create("$base/api/tasks")
$req.Method = 'POST'; $req.ContentType = 'application/json'; $req.Headers.Add('Cookie', $ck)
$b = [System.Text.Encoding]::UTF8.GetBytes($body); $req.ContentLength = $b.Length
$s = $req.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close()
$resp = $req.GetResponse()
$sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
$task = ($sr.ReadToEnd() | ConvertFrom-Json).task; $sr.Close(); $resp.Close()
$bj = [DateTimeOffset]::FromUnixTimeSeconds([long]$task.next_run_at).ToOffset([TimeSpan]::FromHours(8)).ToString('MM-dd HH:mm:ss')
Write-Output ("DAILY_903_NEXT_BJ=" + $bj + " RUN_MINUTE=" + $task.run_minute)

# 3) hourly 63-minute task
$body = '{"name":"h63","script_key":"glados-checkin","params":{"cookie":"x"},"interval_unit":"h","interval_amount":63,"run_hour":0,"run_minute":0,"enabled":true}'
$req = [System.Net.HttpWebRequest]::Create("$base/api/tasks")
$req.Method = 'POST'; $req.ContentType = 'application/json'; $req.Headers.Add('Cookie', $ck)
$b = [System.Text.Encoding]::UTF8.GetBytes($body); $req.ContentLength = $b.Length
$s = $req.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close()
$resp = $req.GetResponse()
$sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
$t2 = ($sr.ReadToEnd() | ConvertFrom-Json).task; $sr.Close(); $resp.Close()
$bj2 = [DateTimeOffset]::FromUnixTimeSeconds([long]$t2.next_run_at).ToOffset([TimeSpan]::FromHours(8)).ToString('MM-dd HH:mm:ss')
Write-Output ("H63_NEXT_BJ=" + $bj2)

# 4) cleanup
foreach ($id in @($task.id, $t2.id)) {
  $req = [System.Net.HttpWebRequest]::Create("$base/api/tasks/$id")
  $req.Method = 'DELETE'; $req.Headers.Add('Cookie', $ck)
  $req.GetResponse().Close()
}
Write-Output 'CLEANED'
