// SP Advisor — 第一階段 Web server（零依賴，Node 內建 http）
// 目前用假資料 (mock)。之後遊戲內橋接模組會把真實戰況 POST 到 /api/ingest，
// 前端改從 /api/state 讀到的就是真資料。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import dns from "node:dns";
import { loadConfig, saveAiConfig, askAdvisor, ingest as tacticsIngest, noteCommand } from "./advisor.mjs";

// IPv6 半殘的網路：Node 預設會先試 AAAA(IPv6)，連不上要等逾時。優先用 IPv4 避免卡住。
try { dns.setDefaultResultOrder("ipv4first"); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = process.env.SP_ADVISOR_PORT || 8765;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ── 假戰況：Bab al-Mandab 海峽（對應「紅海突破 1988」）───────────────
// domain: surface | air | subsurface | missile | torpedo
// relation: friendly | allied | hostile | neutral | unknown
// course 度(0=北), speed 節, altitude 呎(空中單位)
let liveState = null;   // 遊戲推入的真實戰況（有就優先於 mock）
let liveAt = 0;
let commandQueue = [];  // Web 下的指令，等 plugin 來拉取執行
const sseClients = new Set();  // SSE 串流連線（狀態一有更新立即推播，免輪詢）

function sseSend(payload) { for (const c of sseClients) { try { c.write(payload); } catch {} } }

const scenario = {
  name: "Bab al-Mandab — 強行突破",
  center: { lat: 12.66, lon: 43.35 },
  contacts: [
    { id: 1, name: "CG-48 YORKTOWN", type: "巡洋艦", domain: "surface", relation: "friendly", lat: 12.86, lon: 43.30, course: 200, speed: 26, own: true },
    { id: 2, name: "FFG-36 UNDERWOOD", type: "巡防艦", domain: "surface", relation: "friendly", lat: 12.90, lon: 43.34, course: 200, speed: 26 },
    { id: 3, name: "SH-60B 701", type: "反潛直升機", domain: "air", relation: "friendly", lat: 12.78, lon: 43.28, course: 160, speed: 110, altitude: 1500 },
    { id: 10, name: "SKUNK ALFA", type: "水面接觸", domain: "surface", relation: "unknown", lat: 12.60, lon: 43.55, course: 310, speed: 34 },
    { id: 11, name: "SKUNK BRAVO", type: "水面接觸", domain: "surface", relation: "unknown", lat: 12.55, lon: 43.50, course: 300, speed: 32 },
    { id: 12, name: "RAID X1", type: "MiG-21 ?", domain: "air", relation: "hostile", lat: 13.05, lon: 43.62, course: 230, speed: 480, altitude: 8000 },
    { id: 13, name: "SAM SITE", type: "岸基飛彈", domain: "surface", relation: "hostile", lat: 12.72, lon: 43.48, course: 0, speed: 0 },
    { id: 20, name: "MV DESERT STAR", type: "商船", domain: "surface", relation: "neutral", lat: 12.70, lon: 43.36, course: 20, speed: 12 },
  ],
  // 簡化海岸線（僅為第一階段外觀，非精確地理）
  land: [
    { name: "非洲側 (Djibouti)", poly: [[12.40,43.05],[12.95,43.10],[13.20,43.18],[13.20,42.90],[12.30,42.90]] },
    { name: "阿拉伯側 (Yemen)", poly: [[12.60,43.62],[13.00,43.72],[13.25,43.75],[13.25,44.10],[12.40,44.10],[12.45,43.72]] },
    { name: "Perim Is.", poly: [[12.63,43.40],[12.68,43.42],[12.66,43.46],[12.61,43.44]] },
  ],
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 真實戰況（由遊戲橋接推入）；沒有即時資料就回空（不再回退 mock）
  // Demo 數據移到 /api/state?demo=1 給開發除錯用
  if (url.pathname === "/api/state") {
    const fresh = liveState && (Date.now() - liveAt < 5000);
    if (fresh) {
      return send(res, 200, JSON.stringify({ time: Date.now(), live: true, scenario: liveState }), MIME[".json"]);
    }
    if (url.searchParams.get("demo") === "1") {
      return send(res, 200, JSON.stringify({ time: Date.now(), live: false, demo: true, scenario }), MIME[".json"]);
    }
    return send(res, 200, JSON.stringify({ time: Date.now(), live: false }), MIME[".json"]);
  }

  // AI 顧問狀態（不回傳金鑰本身）
  if (url.pathname === "/api/ai/status") {
    const cfg = await loadConfig();
    return send(res, 200, JSON.stringify({ configured: !!cfg.apiKey, provider: cfg.provider, model: cfg.model, keyFromEnv: cfg.keyFromEnv }), MIME[".json"]);
  }
  // 儲存 provider/model（不碰金鑰）
  if (url.pathname === "/api/ai/config" && req.method === "POST") {
    let raw = ""; req.on("data", c => raw += c);
    req.on("end", async () => {
      let b = {}; try { b = JSON.parse(raw); } catch {}
      try {
        await saveAiConfig(b.provider, b.model);
        const cfg = await loadConfig();
        send(res, 200, JSON.stringify({ ok: true, configured: !!cfg.apiKey, provider: cfg.provider, model: cfg.model, keyFromEnv: cfg.keyFromEnv }), MIME[".json"]);
      } catch (e) { send(res, 200, JSON.stringify({ ok: false, error: String(e.message || e) }), MIME[".json"]); }
    });
    return;
  }
  // 測試連線（實際打一次很短的請求驗證金鑰可用）
  if (url.pathname === "/api/ai/test" && req.method === "POST") {
    req.on("data", () => {});
    req.on("end", async () => {
      const cfg = await loadConfig();
      if (!cfg.apiKey) return send(res, 200, JSON.stringify({ ok: false, error: "尚未設定金鑰" }), MIME[".json"]);
      try {
        const r = await askAdvisor({ message: "只回覆兩個字：就緒", history: [], scenario: null, cfg });
        send(res, 200, JSON.stringify({ ok: true, sample: (r.reply || "").slice(0, 40) }), MIME[".json"]);
      } catch (e) { send(res, 200, JSON.stringify({ ok: false, error: String(e.message || e) }), MIME[".json"]); }
    });
    return;
  }

  // SSE 串流：狀態一更新就立即推給瀏覽器（取代 100ms 輪詢，降延遲）
  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    });
    res.write("retry: 2000\n\n");
    const fresh = liveState && (Date.now() - liveAt < 5000);
    res.write(`data: ${JSON.stringify(fresh ? { time: Date.now(), live: true, scenario: liveState } : { time: Date.now(), live: false })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Web → 下指令（排入佇列，等 plugin 拉取）
  if (url.pathname === "/api/command" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const cmd = JSON.parse(raw);
        commandQueue.push(cmd);
        try { noteCommand(cmd); } catch {}   // 記錄玩家命令供顧問參考
        console.log(`[command] 收到指令 ${cmd.type} → 單位 ${cmd.unit}（佇列 ${commandQueue.length}）`);
        send(res, 200, JSON.stringify({ ok: true, queued: commandQueue.length }), MIME[".json"]);
      } catch (e) {
        send(res, 400, JSON.stringify({ ok: false, error: String(e) }), MIME[".json"]);
      }
    });
    return;
  }

  // plugin → 拉取待執行指令（拉走即清空）
  if (url.pathname === "/api/commands") {
    const cmds = commandQueue;
    commandQueue = [];
    return send(res, 200, JSON.stringify({ commands: cmds }), MIME[".json"]);
  }

  // 遊戲橋接把即時戰況 POST 到這裡
  if (url.pathname === "/api/ingest" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        liveState = JSON.parse(raw);
        liveAt = Date.now();
        try { tacticsIngest(liveState); } catch (e) { console.error("[tactics]", e.message); }  // 更新事件/趨勢
        sseSend(`data: ${JSON.stringify({ time: liveAt, live: true, scenario: liveState })}\n\n`); // 立即推給所有瀏覽器
        send(res, 200, JSON.stringify({ ok: true }), MIME[".json"]);
      } catch (e) {
        send(res, 400, JSON.stringify({ ok: false, error: String(e) }), MIME[".json"]);
      }
    });
    return;
  }

  // 聊天佔位：之後接上 LLM / 規則引擎
  if (url.pathname === "/api/chat" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const message = (body.message || "").toString();
      const cfg = await loadConfig();   // 每次讀，讓使用者不用重開就能填金鑰
      if (!cfg.apiKey) {
        const envVar = cfg.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
        return send(res, 200, JSON.stringify({ reply:
          `尚未設定 ${cfg.provider} 的 API 金鑰，顧問無法分析。請擇一設定：\n` +
          `1) 設環境變數 ${envVar}（設好重開伺服器），或\n` +
          "2) 在 sp-advisor 資料夾建立 advisor.config.json：\n" +
          `   {"provider":"${cfg.provider}","apiKey":"...","model":"${cfg.model}"}\n` +
          "（金鑰只存在你本機、已被 .gitignore 排除、不會上傳。）" }), MIME[".json"]);
      }
      const fresh = liveState && (Date.now() - liveAt < 8000);
      try {
        const r = await askAdvisor({ message, history: body.history, scenario: fresh ? liveState : null, cfg });
        send(res, 200, JSON.stringify({ reply: r.reply, ...(body.debug ? { promptSent: r.prompt } : {}) }), MIME[".json"]);
      } catch (e) {
        console.error("[chat] 顧問失敗:", e.message || e);
        send(res, 200, JSON.stringify({ reply: "（顧問呼叫失敗）" + String(e.message || e) }), MIME[".json"]);
      }
    });
    return;
  }

  // 靜態檔
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(PUBLIC, p));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, "forbidden");
  try {
    const data = await readFile(filePath);
    send(res, 200, data, MIME[extname(filePath)] || "application/octet-stream");
  } catch {
    send(res, 404, "not found");
  }
});

// 心跳：資料過期時通知瀏覽器（顯示等待），新鮮時送註解保活
setInterval(() => {
  if (sseClients.size === 0) return;
  const fresh = liveState && (Date.now() - liveAt < 3000);
  sseSend(fresh ? ": ping\n\n" : `data: ${JSON.stringify({ time: Date.now(), live: false })}\n\n`);
}, 1000);

server.listen(PORT, () => {
  console.log(`SP Advisor 已啟動 → http://localhost:${PORT}`);
});
