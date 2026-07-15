// SP Advisor — AI 顧問（零依賴；用 Node 內建 fetch 呼叫 Anthropic Messages API）
// 只把「明面已知」的即時戰況摘要 + 玩家問題送給 Claude，回傳戰術建議。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_URL = "https://api.anthropic.com/v1/messages";

// 金鑰/模型：優先環境變數，其次本機 advisor.config.json（不進 git）
export async function loadConfig() {
  const cfg = { apiKey: process.env.ANTHROPIC_API_KEY || "", model: process.env.SP_ADVISOR_MODEL || "" };
  try {
    const j = JSON.parse(await readFile(join(__dirname, "advisor.config.json"), "utf8"));
    if (!cfg.apiKey && j.apiKey) cfg.apiKey = j.apiKey;
    if (!cfg.model && j.model) cfg.model = j.model;
  } catch {}
  if (!cfg.model) cfg.model = "claude-sonnet-5";
  return cfg;
}

// ── 地理小工具 ────────────────────────────────────────────
function nm(a, b) {
  const R = 3440.065, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const la1 = a.lat * toR, la2 = b.lat * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const toR = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const relName = { friendly: "友軍", allied: "盟軍", hostile: "敵方", neutral: "中立", unknown: "未知" };
const domName = { surface: "水面", air: "空中", subsurface: "水下", missile: "飛彈", torpedo: "魚雷" };
const dayName = { Day: "日間", Night: "夜間", Dawn: "拂曉", Dusk: "黃昏" };
const msName = { InProgress: "進行中", Victory: "勝利", Defeat: "失敗" };
const detName = { radar: "雷達", sonar: "聲納", visual: "目視", esm: "電磁", mad: "MAD" };
const OFFENSIVE = new Set(["missile", "torpedo", "gun", "bomb", "asroc", "rocket", "cluster", "mlrs", "depthcharge"]);
const CATLBL = { missile: "飛彈", torpedo: "魚雷", gun: "艦砲", bomb: "炸彈", asroc: "反潛火箭", rocket: "火箭" };

// 從即時快照組出精簡的明面戰況摘要（繁中）
export function buildSituation(sc) {
  if (!sc || !Array.isArray(sc.contacts)) return "（目前沒有即時戰況資料——請確認遊戲已進任務，且橋接模組運作中。）";
  const cs = sc.contacts;
  const own = cs.filter(c => c.own && !c.destroyed);
  const foes = cs.filter(c => !c.own && !c.destroyed);
  const L = [];
  if (sc.name) L.push(`任務：${sc.name}（${msName[sc.missionStatus] || sc.missionStatus || "—"}）`);
  if (sc.env) { const e = sc.env; L.push(`環境：${[e.datetime, dayName[e.daytime] || e.daytime, e.seaState != null ? "海況" + e.seaState : "", e.clouds].filter(Boolean).join(" ")}`); }
  if (sc.objectives && sc.objectives.length) {
    L.push("任務目標：");
    for (const o of sc.objectives) L.push(`  - [${({ done: "完成", failed: "失敗", canceled: "取消" })[o.status] || "進行中"}]${o.main ? "（主）" : ""} ${o.text}`);
  }
  L.push(`\n己方單位（${own.length}）：`);
  for (const u of own) {
    const d = u.detail || {};
    const st = []; if (d.emcon) st.push("EMCON靜默"); if (d.weaponStatus) st.push("武器" + d.weaponStatus); if (d.disabled) st.push("失能");
    L.push(`  [${u.num}] ${u.name}${u.type ? `(${u.type})` : ""} ${domName[u.domain] || u.domain} 航向${Math.round(u.course)}°/${Math.round(u.speed)}kn${u.altitude ? ` 高度${Math.round(u.altitude)}ft` : ""}${st.length ? " · " + st.join("/") : ""}`);
    const wpns = (d.ammo || []).filter(a => a.c > 0 && OFFENSIVE.has(a.cat || "")).map(a => `${CATLBL[a.cat] || a.cat}${a.dn || a.n}x${a.c}${a.rmax ? `(${Math.round(a.rmax)}nm)` : ""}`);
    if (wpns.length) L.push(`      武器：${wpns.join("、")}`);
    if (d.order) L.push(`      任務：${d.order}`);
  }
  L.push(`\n接觸（${foes.length}）：`);
  for (const f of foes) {
    let rel = "";
    if (own.length) { let nu = own[0], bd = nm(own[0], f); for (const u of own) { const dd = nm(u, f); if (dd < bd) { bd = dd; nu = u; } } rel = ` 距[${nu.num}]${bd.toFixed(0)}nm/方位${Math.round(bearing(nu, f))}°`; }
    const ids = f.identified ? "已識別" : f.classified ? "已分類" : "未識別";
    const det = (f.det || []).map(x => detName[x] || x).join("/");
    L.push(`  ${f.name}${f.type ? `(${f.type})` : ""} ${relName[f.relation] || f.relation}/${domName[f.domain] || f.domain} ${ids} 航向${Math.round(f.course)}°/${Math.round(f.speed)}kn${rel}${det ? ` 偵測:${det}` : ""}`);
  }
  if (sc.intel && sc.intel.length) { L.push("\n情報："); for (const i of sc.intel.slice(0, 6)) L.push(`  - ${i.time ? `[${i.time}] ` : ""}${i.text}`); }
  if (sc.events && sc.events.length) { L.push("\n近期事件："); for (const e of sc.events.slice(0, 8)) L.push(`  - [${e.time || ""}] ${e.text}`); }
  return L.join("\n");
}

const SYSTEM =
`你是《Sea Power》即時海戰的戰術顧問。你只會看到玩家「明面已知」的情報（不含未偵測目標或敵方內部資料）。
規則：
- 一律用繁體中文，語氣專業、精簡，盡量條列出可執行的建議。
- 只依據提供的即時戰況推論；資料不足就明說，不要編造未知資訊（未識別接觸的真實身分、敵方武器鎖定對象、未偵測到的兵力等一律視為未知）。
- 交戰建議要具體：用哪個單位[編號]、哪種武器、是否在射程內、風險與時機。
- 適時引用單位編號、方位與距離，方便玩家對照海圖。`;

// 呼叫 Claude；回傳建議文字。失敗會 throw。
export async function askAdvisor({ message, history, scenario, cfg }) {
  const situation = buildSituation(scenario);
  const msgs = (Array.isArray(history) ? history.slice(-6) : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .concat([{ role: "user", content: `【即時戰況】\n${situation}\n\n【我的問題】${message}` }]);
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, max_tokens: 1500, system: SYSTEM, messages: msgs }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || "（沒有回覆內容）";
}
