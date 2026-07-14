# SP Advisor — 一鍵設定 / 檢查
# 自動定位 Sea Power，並確保整套能跑：Node.js / .NET SDK / BepInEx / plugin，缺的就裝。
$ErrorActionPreference = "Continue"
$here = $PSScriptRoot   # <Sea Power>\sp-advisor

function OK($m)   { Write-Host "  [OK] $m"  -ForegroundColor Green }
function Bad($m)  { Write-Host "  [!!] $m"  -ForegroundColor Red }
function Warn($m) { Write-Host "  [?]  $m"  -ForegroundColor Yellow }
function Info($m) { Write-Host "  ...  $m"  -ForegroundColor DarkGray }

Write-Host "`nSP Advisor — 一鍵設定" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor DarkGray
$problems = 0

# ── 1. 定位 Sea Power ───────────────────────────────────
function Locate-Game {
  $rel = Join-Path $here ".."
  if (Test-Path (Join-Path $rel "Sea Power.exe")) { return (Resolve-Path $rel).Path }
  $steam = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -Name SteamPath -EA SilentlyContinue).SteamPath
  if (-not $steam) { $steam = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam" -Name InstallPath -EA SilentlyContinue).InstallPath }
  if ($steam) {
    $libs = @($steam)
    $vdf = Join-Path $steam "steamapps\libraryfolders.vdf"
    if (Test-Path $vdf) { foreach ($m in [regex]::Matches((Get-Content -Raw $vdf), '"path"\s+"([^"]+)"')) { $libs += $m.Groups[1].Value.Replace('\\','\') } }
    foreach ($lib in ($libs | Select-Object -Unique)) {
      $p = Join-Path $lib "steamapps\common\Sea Power"
      if (Test-Path (Join-Path $p "Sea Power.exe")) { return $p }
    }
  }
  return $null
}
$game = Locate-Game
if (-not $game) { Bad "找不到 Sea Power。請把本工具放在 <Sea Power>\sp-advisor\ 底下，或先在 Steam 安裝遊戲。"; Read-Host "`n按 Enter 結束"; exit 1 }
OK "Sea Power: $game"

# 安裝後把 registry 的 PATH 讀回目前視窗，讓新裝的工具立刻可用（免重開視窗）
function Refresh-Path {
  $m = [System.Environment]::GetEnvironmentVariable("Path","Machine")
  $u = [System.Environment]::GetEnvironmentVariable("Path","User")
  $env:Path = @($m,$u | Where-Object { $_ }) -join ";"
}
# .NET SDK：光有 dotnet host 不夠（可能只裝了 runtime），要真的裝了 SDK 才能 build
function Test-DotnetSdk {
  if (-not (Get-Command dotnet -EA SilentlyContinue)) { return $false }
  try { $s = & dotnet --list-sdks 2>$null; return ($LASTEXITCODE -eq 0 -and @($s).Count -ge 1) } catch { return $false }
}
# ── 通用：用 check scriptblock 判斷；缺的話 winget 裝、裝完刷新 PATH 再判斷一次 ──
function Ensure-Tool($name, $check, $wingetId, $url) {
  if (& $check) { OK "$name 已安裝"; return $true }
  Warn "$name 未安裝，嘗試用 winget 自動安裝…"
  if (-not (Get-Command winget -EA SilentlyContinue)) { Bad "找不到 winget，請手動安裝 $name：$url"; return $false }
  winget install --id $wingetId -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (& $check) { OK "$name 已安裝"; return $true }
  Warn "$name 裝好了，但目前視窗仍抓不到。請**重開視窗、再跑一次本工具**。"; return $false
}

# ── 2. Node.js（跑網頁伺服器用）────────────────────────
if (-not (Ensure-Tool "Node.js" { [bool](Get-Command node -EA SilentlyContinue) } "OpenJS.NodeJS.LTS" "https://nodejs.org/")) { $problems++ }

# ── 3. .NET SDK（編譯 plugin 用）───────────────────────
$hasDotnet = Ensure-Tool ".NET SDK" { Test-DotnetSdk } "Microsoft.DotNet.SDK.8" "https://dotnet.microsoft.com/download"
if (-not $hasDotnet) { $problems++ }

# ── 4. BepInEx（遊戲載入 plugin 用）────────────────────
if (Test-Path (Join-Path $game "BepInEx\core\BepInEx.dll")) { OK "BepInEx 已安裝" }
else {
  Warn "BepInEx 未安裝，下載並安裝中…"
  $bepUrl = "https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/BepInEx_win_x64_5.4.23.5.zip"
  try { $r = Invoke-RestMethod "https://api.github.com/repos/BepInEx/BepInEx/releases/latest" -Headers @{ "User-Agent"="sp-advisor" }
        $a = $r.assets | Where-Object { $_.name -like "BepInEx_win_x64_*.zip" } | Select-Object -First 1
        if ($a) { $bepUrl = $a.browser_download_url } } catch {}
  try {
    $tmp = Join-Path $env:TEMP "bepinex_spadvisor.zip"
    Invoke-WebRequest -Uri $bepUrl -OutFile $tmp
    Expand-Archive -Path $tmp -DestinationPath $game -Force
    Remove-Item $tmp -EA SilentlyContinue
    if (Test-Path (Join-Path $game "BepInEx\core\BepInEx.dll")) { OK "BepInEx 已安裝（下次開遊戲會產生設定檔）" }
    else { Bad "BepInEx 解壓後仍不完整"; $problems++ }
  } catch { Bad "BepInEx 下載/安裝失敗：$($_.Exception.Message)"; $problems++ }
}

# ── 5. Plugin（編譯 + 安裝到 BepInEx\plugins）──────────
$pluginDst = Join-Path $game "BepInEx\plugins\SpAdvisorBridge.dll"
$bepReady  = Test-Path (Join-Path $game "BepInEx\core\BepInEx.dll")
if ($hasDotnet -and $bepReady) {
  Info "編譯 plugin…"
  $env:SeaPowerDir = $game   # 讓 csproj 不管專案放哪都找得到遊戲 DLL
  Push-Location (Join-Path $here "plugin")
  $buildOut = dotnet build -c Release -v quiet -nologo 2>&1
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { $buildOut | Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
  $built = Join-Path $here "plugin\bin\Release\SpAdvisorBridge.dll"
  if ($code -eq 0 -and (Test-Path $built)) {
    $inUse = Get-Process "Sea Power" -EA SilentlyContinue
    if ($inUse) { Warn "遊戲執行中，無法覆蓋 plugin。請關掉 Sea Power 後重跑本工具。"; $problems++ }
    else {
      New-Item -ItemType Directory -Force (Join-Path $game "BepInEx\plugins") | Out-Null
      Copy-Item $built $pluginDst -Force
      OK "Plugin 已編譯並安裝"
    }
  } else { Bad "Plugin 編譯失敗（見上面訊息）"; $problems++ }
}
elseif (Test-Path $pluginDst) { OK "Plugin 已安裝（缺 .NET SDK 或 BepInEx，略過重新編譯）" }
else { Bad "Plugin 尚未安裝：需要 .NET SDK + BepInEx 才能編譯。裝好後重跑本工具。"; $problems++ }

# ── 結果 ───────────────────────────────────────────────
Write-Host "========================================" -ForegroundColor DarkGray
if ($problems -eq 0) {
  Write-Host "全部就緒！" -ForegroundColor Green
  Write-Host "  下一步：雙擊「啟動 SP Advisor.cmd」開網頁，再開遊戲進任務。`n"
} else {
  Write-Host "還有 $problems 項待處理（見上）。若剛裝了 Node/.NET，請重開視窗再跑一次。`n" -ForegroundColor Yellow
}
Read-Host "按 Enter 結束"
