# start.ps1  本地静态服务器（无需管理员、无需 Python/Node）
# 用 TcpListener 直接说 HTTP/1.1，避免 HttpListener 的 urlacl 权限问题。
param([int]$Port = 8787, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not (Test-Path (Join-Path $root 'vendor\vision_bundle.mjs'))) {
  Write-Host ''
  Write-Host '  离线资源还没下载。请先右键运行 download-assets.ps1（需要联网一次）。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按回车退出'
  exit 1
}

# 企业微信 / Server酱 / PushPlus 都只接 TLS1.2+，PS 5.1 默认可能还在用 TLS1.0
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
} catch { }

# WinRT 投影：发 Windows 系统通知要用（PS 5.1 直接 new 也能用，但要先把类型投影加载进来）
$script:winrtOk = $true
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
} catch { $script:winrtOk = $false }

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.wasm' = 'application/wasm'
  '.task' = 'application/octet-stream'
  '.data' = 'application/octet-stream'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
}

function Send-Bytes($stream, [byte[]]$bytes) { $stream.Write($bytes, 0, $bytes.Length) }

function Send-Json($stream, [int]$code, $obj) {
  $body = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 5))
  $head = "HTTP/1.1 $code OK`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  Send-Bytes $stream ([System.Text.Encoding]::ASCII.GetBytes($head))
  Send-Bytes $stream $body
}

# 由本机服务代发 webhook：浏览器直连企业微信/Server酱会被 CORS 拦住，走这里没这问题，key 也只在本地。
function Invoke-Webhook([string]$Url, [string]$ContentType, [string]$Body) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'POST'
    $req.ContentType = $ContentType
    $req.Timeout = 8000
    $req.ReadWriteTimeout = 8000
    $req.Proxy = $null
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $req.ContentLength = $bytes.Length
    $rs = $req.GetRequestStream()
    $rs.Write($bytes, 0, $bytes.Length)
    $rs.Close()
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $text = $sr.ReadToEnd()
    $sr.Close(); $resp.Close()
    return @{ ok = $true; status = $code; resp = $text }
  } catch {
    $msg = $_.Exception.Message
    $code = 0
    if ($_.Exception.Response) {
      try {
        $code = [int]$_.Exception.Response.StatusCode
        $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $msg = $sr.ReadToEnd(); $sr.Close()
      } catch { }
    }
    return @{ ok = $false; status = $code; resp = $msg }
  }
}

# Windows 系统通知（toast）。不需要装 BurntToast：WinRT 里直接就能发。
# 通知身份借用 powershell.exe 的 AUMID（本机实测可用，且不受「Chrome 通知开关」影响）。
# 副作用：通知来源名称会显示成 “Windows PowerShell”，这是用别人 AUMID 的代价，换成自己的要注册开始菜单快捷方式。
function Show-Toast([string]$Title, [string]$Text, [string]$Scenario = 'default') {
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  if ($Scenario -notin @('default', 'alarm', 'reminder', 'urgent', 'incomingCall')) { $Scenario = 'default' }
  $t = [System.Security.SecurityElement]::Escape([string]$Title)
  $b = [System.Security.SecurityElement]::Escape([string]$Text)
  $xml = '<toast scenario="' + $Scenario + '"><visual><binding template="ToastGeneric"><text>' + $t + '</text><text>' + $b + '</text></binding></visual><audio src="ms-winsoundevent:Notification.Reminder" /></toast>'
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
}

# 语音念一句。用 SAPI 的 SpeakAsync：立刻返回，不阻塞服务器；合成器只建一次。
$script:speaker = $null
function Speak-Text([string]$Text, [int]$Rate = 0, [int]$Volume = 100) {
  if (-not $Text) { return }
  if (-not $script:speaker) {
    Add-Type -AssemblyName System.Speech
    $script:speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    # 优先挑中文音色（本机有 Microsoft Huihui Desktop）
    $zh = $script:speaker.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
    if ($zh) { $script:speaker.SelectVoice($zh.VoiceInfo.Name) }
  }
  $script:speaker.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $script:speaker.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
  $script:speaker.SpeakAsync($Text) | Out-Null
}

function Send-Error($stream, [int]$code, [string]$text) {
  $body = [System.Text.Encoding]::UTF8.GetBytes("$code $text")
  $head = "HTTP/1.1 $code $text`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
  Send-Bytes $stream ([System.Text.Encoding]::ASCII.GetBytes($head))
  Send-Bytes $stream $body
}

$listener = $null
for ($p = $Port; $p -lt ($Port + 20); $p++) {
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $listener.Start()
    $Port = $p
    break
  } catch {
    $listener = $null
  }
}
if (-not $listener) { Write-Host "端口 $Port 起不来" -ForegroundColor Red; exit 1 }

$url = "http://127.0.0.1:$Port/"
Write-Host ''
Write-Host '  鼻部习惯检测器' -ForegroundColor Cyan
Write-Host "  服务已启动: $url" -ForegroundColor Green
Write-Host '  浏览器会自动打开。用完直接关掉这个窗口即可。' -ForegroundColor DarkGray
Write-Host ''
# 用专用 Chrome 实例打开（带关闭后台限速的启动参数 + 独立配置目录，不动你平时用的 Chrome）
# 说明：参数对已运行的 Chrome 实例无效，所以必须独立 user-data-dir。
function Open-App([string]$TargetUrl) {
  $profileDir = Join-Path $env:LOCALAPPDATA 'NoseHabit\chrome-profile'
  if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
  $flags = @(
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check',
    "--user-data-dir=$profileDir",
    $TargetUrl
  )
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
  )
  foreach ($exe in $candidates) {
    if ($exe -and (Test-Path $exe)) {
      Write-Host "  打开: $([System.IO.Path]::GetFileName($exe)) 专用窗口（后台不限速）" -ForegroundColor DarkGray
      Start-Process -FilePath $exe -ArgumentList $flags
      return
    }
  }
  Write-Host '  没找到 Chrome / Edge，用默认浏览器打开（后台会被限速到 ~1 帧/秒）' -ForegroundColor Yellow
  Start-Process $TargetUrl
}

if (-not $NoBrowser) { Open-App $url }

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 5000
    $client.SendTimeout    = 60000
    $stream = $client.GetStream()

    # 读请求（头 + 可能一起到达的 body），按 Content-Length 补齐
    $buf = New-Object byte[] 8192
    $acc = New-Object System.IO.MemoryStream
    $headerEnd = -1
    $guard = 0
    while ($guard -lt 128) {
      $guard++
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $acc.Write($buf, 0, $n)
      $arr = $acc.GetBuffer()
      $len = [int]$acc.Length
      for ($i = 3; $i -lt $len; $i++) {
        if ($arr[$i] -eq 10 -and $arr[$i - 1] -eq 13 -and $arr[$i - 2] -eq 10 -and $arr[$i - 3] -eq 13) { $headerEnd = $i + 1; break }
      }
      if ($headerEnd -ge 0) { break }
      if ($len -gt 262144) { break }
    }
    if ($headerEnd -lt 0) { $client.Close(); continue }

    $reqText = [System.Text.Encoding]::UTF8.GetString($acc.GetBuffer(), 0, $headerEnd)
    if ([string]::IsNullOrWhiteSpace($reqText)) { $client.Close(); continue }
    $bodyBytes = New-Object byte[] 0
    $headLen = $acc.Length - $headerEnd
    $clen = 0
    $m = [regex]::Match($reqText, '(?im)^Content-Length:\s*(\d+)')
    if ($m.Success) { $clen = [int]$m.Groups[1].Value }
    if ($clen -gt 0) {
      $bodyAll = New-Object System.IO.MemoryStream
      if ($headLen -gt 0) { $bodyAll.Write($acc.GetBuffer(), $headerEnd, [int]$headLen) }
      while ($bodyAll.Length -lt $clen) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $bodyAll.Write($buf, 0, $n)
      }
      $bodyBytes = $bodyAll.ToArray()
    }
    $acc.Dispose()

    $firstLine = ($reqText -split "`r`n")[0]
    $parts = $firstLine -split ' '
    if ($parts.Length -lt 2) { Send-Error $stream 400 'Bad Request'; $client.Close(); continue }

    $method = $parts[0].ToUpper()
    $rawPath = $parts[1]
    $q = $rawPath.IndexOf('?')
    if ($q -ge 0) { $rawPath = $rawPath.Substring(0, $q) }

    # 通知转发接口
    if ($rawPath -eq '/api/notify') {
      if ($method -ne 'POST') { Send-Error $stream 405 'Method Not Allowed'; $client.Close(); continue }
      try {
        $payload = [System.Text.Encoding]::UTF8.GetString($bodyBytes) | ConvertFrom-Json
      } catch {
        Send-Json $stream 400 @{ ok = $false; error = 'bad json' }; $client.Close(); continue
      }
      if (-not $payload.url -or ($payload.url -notmatch '^https?://')) {
        Send-Json $stream 400 @{ ok = $false; error = 'bad url' }; $client.Close(); continue
      }
      $ct = if ($payload.contentType) { [string]$payload.contentType } else { 'application/json; charset=utf-8' }
      $bd = if ($null -ne $payload.body) { [string]$payload.body } else { '' }
      $r = Invoke-Webhook ([string]$payload.url) $ct $bd
      Send-Json $stream 200 $r
      $client.Close(); continue
    }

    # 系统提醒接口：/api/toast（Windows 通知中心）、/api/voice（SAPI 语音）
    if ($rawPath -eq '/api/toast' -or $rawPath -eq '/api/voice') {
      if ($method -ne 'POST') { Send-Error $stream 405 'Method Not Allowed'; $client.Close(); continue }
      $pl = $null
      try { $pl = [System.Text.Encoding]::UTF8.GetString($bodyBytes) | ConvertFrom-Json } catch { }
      if (-not $pl) { Send-Json $stream 400 @{ ok = $false; error = 'bad json' }; $client.Close(); continue }
      try {
        if ($rawPath -eq '/api/toast') {
          if (-not $script:winrtOk) { Send-Json $stream 200 @{ ok = $false; error = 'winrt unavailable' }; $client.Close(); continue }
          $tt = if ($pl.title) { [string]$pl.title } else { '鼻部提醒' }
          $tx = if ($pl.text) { [string]$pl.text } else { '' }
          $sc = if ($pl.scenario) { [string]$pl.scenario } else { 'default' }
          Show-Toast $tt $tx $sc
        } else {
          Speak-Text ([string]$pl.text) ([int]$pl.rate) ([int]$pl.volume)
        }
        Send-Json $stream 200 @{ ok = $true }
      } catch {
        Send-Json $stream 200 @{ ok = $false; error = $_.Exception.Message }
      }
      $client.Close(); continue
    }

    if ($method -ne 'GET' -and $method -ne 'HEAD') {
      Send-Error $stream 405 'Method Not Allowed'; $client.Close(); continue
    }
    $rel = [System.Uri]::UnescapeDataString($rawPath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }

    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    $rootFull = [System.IO.Path]::GetFullPath($root)
    if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-Error $stream 403 'Forbidden'; $client.Close(); continue
    }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Send-Error $stream 404 'Not Found'; $client.Close(); continue
    }

    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    $ctype = $mime[$ext]
    if (-not $ctype) { $ctype = 'application/octet-stream' }
    $len = (Get-Item -LiteralPath $full).Length

    $head = "HTTP/1.1 200 OK`r`nContent-Type: $ctype`r`nContent-Length: $len`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
    Send-Bytes $stream ([System.Text.Encoding]::ASCII.GetBytes($head))

    if ($method -eq 'GET' -and $len -gt 0) {
      $fs = [System.IO.File]::Open($full, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
      try {
        $chunk = New-Object byte[] 65536
        while (($r = $fs.Read($chunk, 0, $chunk.Length)) -gt 0) {
          $stream.Write($chunk, 0, $r)
        }
      } finally { $fs.Dispose() }
    }
    $stream.Flush()
  } catch {
    # 单个请求失败不影响服务
  } finally {
    try { $client.Close() } catch {}
  }
}
