# SP Advisor — Sea Power 戰術輔助工具

給 [Sea Power: Naval Combat in the Missile Age](https://store.steampowered.com/app/1286220/)（Triassic Games）用的**戰術輔助 / 顧問工具**。

在瀏覽器裡開一張**即時戰術海圖**，顯示玩家在遊戲中已知的接觸畫面（單位、敵我識別、偵測方式、武器/感測/彈藥等明面資訊），並可**從網頁規劃航線下指令回遊戲**。之後會加上 AI 戰況分析（聊天視窗）。

> ⚠️ 這是非官方社群工具，只讀取/使用玩家在遊戲中本來就看得到的資訊。

## 架構

```
遊戲行程 (Unity/Mono)
 └─ BepInEx plugin (C#)  ── 每秒讀玩家戰術畫面 ─┐
                          ◄─ 拉取待執行指令 ──┐ │
                                              │ │ localhost (HTTP)
本機 Node Web Server ─────────────────────────┘ │
 └─ 瀏覽器：Leaflet 海圖 + 單位清單 + 詳情 + 規劃 ┘
```

- **plugin/**：BepInEx plugin（C#）。跑在遊戲行程內，讀 `TaskforceManager`/`PlottingTable` 等，把玩家已知戰況 POST 到本機伺服器；並拉取網頁下的指令（航線等）在主執行緒執行。
- **server.mjs**：零依賴 Node HTTP 伺服器。轉發戰況與指令、提供網頁。
- **public/**：前端。Leaflet 向量海岸線底圖 + NTDS 風格符號 + 卡片式詳情 + 航線規劃。
- **simplify-coast.mjs**：把 Natural Earth 10m 海岸線用 RDP 簡化成輕量向量底圖。

## 需求

- [Sea Power](https://store.steampowered.com/app/1286220/)（本專案需放在遊戲目錄下，plugin 的 `.csproj` 以相對路徑參照遊戲 DLL）
- [BepInEx 5.x (win-x64, Mono)](https://github.com/BepInEx/BepInEx/releases) — 自行安裝到遊戲根目錄（**未包含在本 repo**）
- [Node.js](https://nodejs.org/) 18+
- [.NET SDK](https://dotnet.microsoft.com/)（編譯 plugin 用）

## 安裝 / 使用

把本專案放到遊戲目錄下（即 `<Sea Power>/sp-advisor/`），然後：

### 快速安裝（推薦）
雙擊 **`一鍵設定.cmd`**（＝ `setup.ps1`）。它會自動：
1. 定位 Sea Power（本工具位置 / Steam 登錄檔 + library）
2. 檢查並用 winget 安裝缺少的 **Node.js** 與 **.NET SDK**
3. 若缺 **BepInEx** 就下載安裝到遊戲根目錄
4. 編譯 plugin 並安裝到 `BepInEx/plugins/`

完成後雙擊 **`啟動 SP Advisor.cmd`** 開網頁（`http://localhost:8765`），再開遊戲進任務即可。

### 手動安裝
1. 安裝 [BepInEx 5.x (win-x64, Mono)](https://github.com/BepInEx/BepInEx/releases) 到遊戲根目錄，先執行一次遊戲產生 `BepInEx/`。
2. 編譯 plugin：`cd plugin && dotnet build -c Release`（或 `plugin/build.cmd`，會自動複製到 `BepInEx/plugins/`）。缺遊戲/BepInEx 時建置會給清楚錯誤提示。
3. `node server.mjs`（或雙擊 `啟動 SP Advisor.cmd`）→ 開遊戲進任務。

> plugin 的 `.csproj` 以相對路徑自動找到遊戲 DLL，不管 Steam 裝在哪台哪個磁碟都行。若專案放在遊戲目錄外，設環境變數 `SeaPowerDir` 指向遊戲安裝資料夾即可。

## 地圖資料

執行時使用 `public/vendor/land-simplified.geojson`（由 Natural Earth 10m 陸地簡化而來）。
要重新產生：下載 `ne_10m_land.geojson`（[Natural Earth](https://github.com/nvkelso/natural-earth-vector) `geojson/ne_10m_land.geojson`）放到 `public/vendor/land-10m.geojson`，執行 `node simplify-coast.mjs 0.015`。

## 致謝 / 授權

- 地圖：[Leaflet](https://leafletjs.com/)、海岸線：[Natural Earth](https://www.naturalearthdata.com/)（public domain）
- 遊戲載入：[BepInEx](https://github.com/BepInEx/BepInEx) / [Harmony](https://github.com/pardeike/Harmony)
- 與 Triassic Games 無隸屬關係。Sea Power 為其商標/財產。
