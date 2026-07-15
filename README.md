# SP Advisor — Sea Power 戰術輔助工具

給 [Sea Power: Naval Combat in the Missile Age](https://store.steampowered.com/app/1286220/)（Triassic Games）用的**戰術輔助 / 顧問工具**。

在瀏覽器裡開一張**即時戰術海圖**，顯示玩家在遊戲中已知的接觸畫面（單位、敵我識別、偵測方式、武器/感測/彈藥等明面資訊），可**從網頁下指令回遊戲**（移動、交戰、感測、標記/識別…），並有一個接 Claude 的 **AI 戰術顧問**（右側聊天視窗）根據當下明面戰況給建議。

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

## AI 顧問（設定 API 金鑰）

伺服器端（`advisor.mjs`）不是把原始快照丟給模型，而是先用**程式/規則**做兩件事：
- **壓縮層**：把每個接觸轉成戰術意義——威脅等級、相對方位/距離、**接近率**（觀測推算）、推測角色（低信心）、偵測來源。
- **事件/趨勢偵測器**：比對連續快照產生事件（`CONTACT_CREATED/LOST/REACQUIRED`、`WEAPON_LAUNCH_DETECTED`、`TRACK_CLASSIFICATION_CHANGED`、`CONTACT_TURNED_TOWARD_FORMATION`、`TRACK_ACCELERATING`、`MAGAZINE_LOW`、`AIRCRAFT_LOW_FUEL`…）。

問模型時只送：**當前重要狀態 + 最近事件 + 任務目標 + 可採取動作 + 最近玩家命令**（上一次建議透過對話歷史帶入），讓模型感受到「戰局正在演化」。全程只用明面資料、不臆測未知（敵方載彈/鎖定、未偵測兵力等）。

支援 **Anthropic** 或 **OpenAI**，需要你自己的 API 金鑰（**金鑰只存在你本機，已被 `.gitignore` 排除，不會上傳**），擇一設定：

1. **環境變數**：`SP_ADVISOR_PROVIDER`（`anthropic`／`openai`）、對應的 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`、選填 `SP_ADVISOR_MODEL`。
2. **設定檔**：把 `advisor.config.example.json` 複製成 `advisor.config.json`：
   ```json
   { "provider": "anthropic", "apiKey": "sk-ant-...", "model": "claude-sonnet-5" }
   ```
   OpenAI 範例：`{ "provider": "openai", "apiKey": "sk-...", "model": "gpt-4o" }`

金鑰在**伺服器端**使用、不會傳到瀏覽器；設定檔可即時生效（不必重開伺服器）。

## 地圖資料

執行時使用 `public/vendor/land-simplified.geojson`（由 Natural Earth 10m 陸地簡化而來）。
要重新產生：下載 `ne_10m_land.geojson`（[Natural Earth](https://github.com/nvkelso/natural-earth-vector) `geojson/ne_10m_land.geojson`）放到 `public/vendor/land-10m.geojson`，執行 `node simplify-coast.mjs 0.015`。

## 致謝 / 授權

- 地圖：[Leaflet](https://leafletjs.com/)、海岸線：[Natural Earth](https://www.naturalearthdata.com/)（public domain）
- 遊戲載入：[BepInEx](https://github.com/BepInEx/BepInEx) / [Harmony](https://github.com/pardeike/Harmony)
- 與 Triassic Games 無隸屬關係。Sea Power 為其商標/財產。
