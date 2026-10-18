# download-assets.ps1
# 一次性下载离线资源（MediaPipe wasm + 模型）。下载完成后完全断网可用。
# 只在第一次运行时需要联网。

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'

$root    = $PSScriptRoot
$vendor  = Join-Path $root 'vendor'
$wasmDir = Join-Path $vendor 'wasm'
$modDir  = Join-Path $vendor 'models'

New-Item -ItemType Directory -Force -Path $wasmDir, $modDir | Out-Null

$VER = '0.10.14'
$cdn = @(
  "https://unpkg.com/@mediapipe/tasks-vision@$VER",
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$VER"
)

$jobs = @(
  @{ url = "$($cdn[0])/vision_bundle.mjs";                        out = (Join-Path $vendor 'vision_bundle.mjs');        alt = @("$($cdn[1])/vision_bundle.mjs") },
  @{ url = "$($cdn[0])/wasm/vision_wasm_internal.js";             out = (Join-Path $wasmDir 'vision_wasm_internal.js'); alt = @("$($cdn[1])/wasm/vision_wasm_internal.js") },
  @{ url = "$($cdn[0])/wasm/vision_wasm_internal.wasm";           out = (Join-Path $wasmDir 'vision_wasm_internal.wasm'); alt = @("$($cdn[1])/wasm/vision_wasm_internal.wasm") },
  @{ url = "$($cdn[0])/wasm/vision_wasm_nosimd_internal.js";      out = (Join-Path $wasmDir 'vision_wasm_nosimd_internal.js'); alt = @("$($cdn[1])/wasm/vision_wasm_nosimd_internal.js") },
  @{ url = "$($cdn[0])/wasm/vision_wasm_nosimd_internal.wasm";    out = (Join-Path $wasmDir 'vision_wasm_nosimd_internal.wasm'); alt = @("$($cdn[1])/wasm/vision_wasm_nosimd_internal.wasm") },
  @{ url = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
     out = (Join-Path $modDir 'hand_landmarker.task'); alt = @('https://cdn.jsdelivr.net/gh/google-ai-edge/mediapipe-samples@main/examples/hand_landmarker/js/hand_landmarker.task') },
  @{ url = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
     out = (Join-Path $modDir 'face_landmarker.task'); alt = @() }
)

function Get-Remote([string]$url, [string]$out) {
  $attempts = 0
  while ($attempts -lt 3) {
    $attempts++
    try {
      if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L --fail --silent --show-error --ssl-no-revoke --connect-timeout 20 --max-time 900 -o $out $url
        if ($LASTEXITCODE -ne 0) { throw "curl exit $LASTEXITCODE" }
      } else {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 900
      }
      if ((Test-Path $out) -and ((Get-Item $out).Length -gt 1024)) { return $true }
      throw 'file too small'
    } catch {
      Write-Host ("    重试 {0}/3: {1}" -f $attempts, $_.Exception.Message) -ForegroundColor DarkYellow
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

$total = 0
$ok = 0
Write-Host "下载离线资源到: $vendor" -ForegroundColor Cyan
Write-Host ""

foreach ($j in $jobs) {
  $total++
  $name = Split-Path $j.out -Leaf
  $rel  = $j.out.Substring($root.Length).TrimStart('\')

  if ((Test-Path $j.out) -and ((Get-Item $j.out).Length -gt 1024)) {
    $mb = [math]::Round((Get-Item $j.out).Length / 1MB, 1)
    Write-Host ("  [跳过] {0,-34} 已存在 ({1} MB)" -f $rel, $mb) -ForegroundColor DarkGray
    $ok++
    continue
  }

  Write-Host ("  [下载] {0}" -f $rel) -NoNewline
  $done = Get-Remote $j.url $j.out
  if (-not $done) {
    foreach ($altUrl in $j.alt) {
      Write-Host " -> 换镜像" -NoNewline
      if (Get-Remote $altUrl $j.out) { $done = $true; break }
    }
  }
  if ($done) {
    $mb = [math]::Round((Get-Item $j.out).Length / 1MB, 1)
    Write-Host ("  OK ({0} MB)" -f $mb) -ForegroundColor Green
    $ok++
  } else {
    Write-Host "  失败" -ForegroundColor Red
  }
}

Write-Host ""
if ($ok -eq $total) {
  $sum = (Get-ChildItem $vendor -Recurse -File | Measure-Object -Property Length -Sum).Sum
  Write-Host ("完成: {0}/{1} 个文件, 共 {2} MB。现在完全离线可用。" -f $ok, $total, [math]::Round($sum/1MB,1)) -ForegroundColor Green
  Write-Host "下一步: 双击 start.bat"
} else {
  Write-Host ("有 {0} 个文件没下下来。检查网络后重新运行本脚本（已下好的会跳过）。" -f ($total - $ok)) -ForegroundColor Yellow
  exit 1
}
