// SP Advisor — AI 顧問（零依賴）
// 設計：程式/規則先把原始快照「壓縮成戰術意義」+ 偵測「事件/趨勢」，
// 只把「當前重要狀態 + 最近事件 + 目標 + 可採取動作 + 最近玩家命令」送給 LLM。
// 只用明面（玩家已知）資料；不臆測敵方內部資訊。支援 Anthropic 或 OpenAI。
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(__dirname, "advisor.config.json");

// ── 設定（provider / 金鑰 / 模型）──────────────────────────
export async function loadConfig() {
  let f = {};
  try { f = JSON.parse(await readFile(CFG_PATH, "utf8")); } catch {}
  const provider = (process.env.SP_ADVISOR_PROVIDER || f.provider || "anthropic").toLowerCase();
  const apiKey = provider === "openai"
    ? (process.env.OPENAI_API_KEY || f.apiKey || "")
    : (process.env.ANTHROPIC_API_KEY || f.apiKey || "");
  const model = process.env.SP_ADVISOR_MODEL || f.model || (provider === "openai" ? "gpt-4o" : "claude-sonnet-5");
  const keyFromEnv = provider === "openai" ? !!process.env.OPENAI_API_KEY : !!process.env.ANTHROPIC_API_KEY;
  return { provider, apiKey, model, keyFromEnv };
}

// 只存 provider/model（保留既有金鑰；不在此處理金鑰輸入）
export async function saveAiConfig(provider, model) {
  let f = {};
  try { f = JSON.parse(await readFile(CFG_PATH, "utf8")); } catch {}
  if (provider) f.provider = String(provider).toLowerCase();
  if (model !== undefined) f.model = String(model);
  await writeFile(CFG_PATH, JSON.stringify(f, null, 2), "utf8");
}

// ── 地理 / 向量 ──────────────────────────────────────────
const toR = Math.PI / 180;
function nm(a, b) {
  const R = 3440.065;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}
const velEN = c => ({ e: (c.speed || 0) * Math.sin((c.course || 0) * toR), n: (c.speed || 0) * Math.cos((c.course || 0) * toR) });
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// 接近率（kn，正=距離縮小）：相對徑向速度
function closingSpeed(f, t) {
  const dE = (t.lon - f.lon) * Math.cos(((f.lat + t.lat) / 2) * toR) * 60;
  const dN = (t.lat - f.lat) * 60;
  const r = Math.hypot(dE, dN); if (r < 1e-6) return 0;
  const vf = velEN(f), vt = velEN(t);
  const relE = vt.e - vf.e, relN = vt.n - vf.n;
  return -((relE * dE + relN * dN) / r);   // -d(range)/dt
}

const relName = { friendly: "友軍", allied: "盟軍", hostile: "敵方", neutral: "中立", unknown: "未知" };
const domName = { surface: "水面", air: "空中", subsurface: "水下", missile: "飛彈", torpedo: "魚雷" };
const dayName = { Day: "日間", Night: "夜間", Dawn: "拂曉", Dusk: "黃昏" };
const msName = { InProgress: "進行中", Victory: "勝利", Defeat: "失敗" };
const detName = { radar: "雷達", sonar: "聲納", visual: "目視", esm: "電磁", mad: "MAD" };
const OFFENSIVE = new Set(["missile", "torpedo", "gun", "bomb", "asroc", "rocket", "cluster", "mlrs", "depthcharge"]);
const CATLBL = { missile: "飛彈", torpedo: "魚雷", gun: "艦砲", bomb: "炸彈", asroc: "反潛火箭", rocket: "火箭" };
const tid = c => "C" + (c.num != null ? c.num : c.id);

// 觀測動力學 → 推測角色（明面推論，非遊戲真值；標低信心）
function probableRole(f) {
  const s = f.speed || 0;
  if (f.domain === "missile") return ["來襲飛彈", 0.9];
  if (f.domain === "torpedo") return ["魚雷", 0.9];
  if (f.domain === "subsurface") return ["潛艦", 0.6];
  if (f.domain === "air") {
    if (s > 480) return ["高速噴射機（攔截/打擊）", 0.5];
    if (s > 300) return ["噴射機", 0.5];
    if (s > 60) return ["直升機/螺旋槳巡邏機", 0.45];
    return ["空中接觸", 0.3];
  }
  if (f.domain === "surface") {
    if (s > 30) return ["高速攻擊艇", 0.5];
    if (s > 14) return ["水面艦/商船", 0.4];
    return ["商船/慢速", 0.4];
  }
  return ["未知", 0.2];
}
function threatLevel(f, closing, range) {
  if (f.domain === "missile" || f.domain === "torpedo") return "critical";
  if (f.relation === "hostile") return (range < 80 && closing > 150) ? "high" : (closing > 0 ? "medium" : "low");
  if (f.relation === "unknown") return (closing > 200 && range < 120) ? "medium" : "low";
  return "low";
}
const THREAT_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// ── 事件/趨勢偵測狀態 ────────────────────────────────────
let tracks = new Map();   // id -> 記憶狀態
let lost = new Map();     // id -> {t, name}
let events = [];          // {seq, gt, event, track, severity, details}
let cmds = [];            // 最近玩家命令
let seq = 0;
function pushEvent(sc, event, track, severity, details) { events.push({ seq: seq++, gt: sc?.env?.datetime || "", event, track, severity, details }); if (events.length > 300) events.shift(); }
export function noteCommand(cmd) { if (cmd && cmd.type) { cmds.push(cmd); if (cmds.length > 40) cmds.shift(); } }

// 每次收到快照就更新趨勢與事件（程式/規則，非 LLM）
export function ingest(sc) {
  if (!sc || !Array.isArray(sc.contacts)) return;
  const now = Date.now();
  const own = sc.contacts.filter(c => c.own && !c.destroyed);
  const cen = own.length ? { lat: own.reduce((s, c) => s + c.lat, 0) / own.length, lon: own.reduce((s, c) => s + c.lon, 0) / own.length } : null;
  const curIds = new Set();

  for (const c of sc.contacts) {
    curIds.add(c.id);
    const p = tracks.get(c.id);
    if (!c.own && !c.destroyed) {
      if (!p) {   // 新接觸 / 重新捕獲 / 武器發射
        if (c.domain === "missile" || c.domain === "torpedo")
          pushEvent(sc, "WEAPON_LAUNCH_DETECTED", tid(c), "critical", { domain: c.domain, name: c.name });
        else if (lost.has(c.id) && now - lost.get(c.id).t < 120000)
          pushEvent(sc, "CONTACT_REACQUIRED", tid(c), "info", { relation: c.relation, domain: c.domain });
        else
          pushEvent(sc, "CONTACT_CREATED", tid(c), "info", { relation: c.relation, domain: c.domain });
        lost.delete(c.id);
      } else {
        if (p.relation !== c.relation || p.identified !== c.identified || p.classified !== c.classified)
          pushEvent(sc, "TRACK_CLASSIFICATION_CHANGED", tid(c), "info", { from: relName[p.relation] || p.relation, to: relName[c.relation] || c.relation, identified: !!c.identified });
        // 加速（跟 ~5 秒前的參考比）
        if (now - (p.refT || 0) > 5000) { p.refSpeed = p.speed; p.refCourse = p.course; p.refT = now; }
        if ((c.speed - (p.refSpeed ?? c.speed)) > 60)
          pushEvent(sc, "TRACK_ACCELERATING", tid(c), "info", { from: Math.round(p.refSpeed), to: Math.round(c.speed) });
      }
      // 轉向指向編隊：新舊接觸都算 aligned（建立基準），只有 false→true 才觸發事件
      if (cen) {
        const brg = bearing(c, cen), err = angDiff(c.course, brg), aligned = err < 20;
        if (p && p.aligned === false && aligned && closingSpeed(c, cen) > 0)
          pushEvent(sc, "CONTACT_TURNED_TOWARD_FORMATION", tid(c), "warning", { new_heading: Math.round(c.course), heading_to_formation: Math.round(brg), alignment_error_deg: Math.round(err) });
        c._aligned = aligned;
      }
    }
    // 保存記憶
    tracks.set(c.id, { lat: c.lat, lon: c.lon, course: c.course, speed: c.speed, relation: c.relation, identified: c.identified, classified: c.classified, domain: c.domain, own: c.own, destroyed: c.destroyed, name: c.name, num: c.num, aligned: c._aligned !== undefined ? c._aligned : (p ? p.aligned : undefined), refT: p ? p.refT : now, refSpeed: p ? p.refSpeed : c.speed, refCourse: p ? p.refCourse : c.course });
  }
  // 消失的接觸
  for (const [id, p] of tracks) {
    if (!curIds.has(id) && !p.own && !p.destroyed) {
      pushEvent(sc, "CONTACT_LOST", tid(p), "info", {});
      lost.set(id, { t: now, name: p.name }); tracks.delete(id);
    }
  }
  // 己方門檻（帶遲滯，避免每幀重觸）
  for (const u of own) {
    const d = u.detail || {}, k = "s" + u.id, p = tracks.get(u.id) || {};
    const off = (d.ammo || []).filter(a => OFFENSIVE.has(a.cat)).reduce((s, a) => s + a.c, 0);
    if (off > 0 && off <= 2 && !p._magLow) { pushEvent(sc, "MAGAZINE_LOW", tid(u), "warning", { offensive_rounds: off }); }
    if (d.rangeKm != null && !d.unlimitedFuel && d.rangeKm < 60 && !p._fuelLow) { pushEvent(sc, "AIRCRAFT_LOW_FUEL", tid(u), "warning", { range_km: Math.round(d.rangeKm) }); }
    const st = tracks.get(u.id); if (st) { st._magLow = off <= 3; st._fuelLow = d.rangeKm != null && !d.unlimitedFuel && d.rangeKm < 90; }
  }
}

function cmdText(o) {
  const u = o.unit;
  switch (o.type) {
    case "waypoint": return o.replace ? `移動 [${u}]（轉向）` : `加航點 [${u}]`;
    case "attack": return `交戰 [${u}]→${o.target}${o.ammo ? `（${o.ammo} x${o.salvo || 1}）` : ""}`;
    case "speed": return `[${u}] 航速 ${o.num}kn`;
    case "altitude": return `[${u}] 高度 ${o.num}ft`;
    case "emcon": return `[${u}] EMCON ${o.on ? "靜默" : "輻射"}`;
    case "sensor": return `[${u}] 感測 ${o.value} ${o.on ? "開" : "關"}`;
    case "weaponstatus": return `[${u}] 武器 ${o.value}`;
    case "relation": return `標記 ${o.target} ${o.value}`;
    case "identify": return `要求識別 ${o.target}`;
    case "clearwp": return `[${u}] 清除航點`;
    case "resume": return `[${u}] 恢復航向`;
    case "select": return null;
    default: return o.type;
  }
}

// ── 壓縮後的戰術脈絡（給 LLM）─────────────────────────────
export function buildContext(sc) {
  if (!sc || !Array.isArray(sc.contacts)) return "（目前沒有即時戰況——請確認遊戲已進任務、橋接運作中。）";
  const own = sc.contacts.filter(c => c.own && !c.destroyed);
  const foes = sc.contacts.filter(c => !c.own && !c.destroyed);
  const L = [];
  if (sc.name) L.push(`任務：${sc.name}（${msName[sc.missionStatus] || sc.missionStatus || "—"}）`);
  if (sc.env) L.push(`環境：${[sc.env.datetime, dayName[sc.env.daytime] || sc.env.daytime, sc.env.seaState != null ? "海況" + sc.env.seaState : "", sc.env.clouds].filter(Boolean).join(" ")}`);
  if (sc.objectives?.length) { L.push("任務目標："); for (const o of sc.objectives) L.push(`  - [${({ done: "完成", failed: "失敗", canceled: "取消" })[o.status] || "進行中"}]${o.main ? "（主）" : ""} ${o.text}`); }
  if (sc.briefing) L.push(`\n任務簡報（初始條件／指揮官意圖）：\n${sc.briefing.replace(/\\n/g, "\n").trim()}`);
  if (sc.forecast) L.push(`天氣預報：${sc.forecast}`);

  L.push(`\n己方（${own.length}）：`);
  for (const u of own) {
    const d = u.detail || {}, st = [];
    if (d.emcon) st.push("EMCON靜默"); if (d.weaponStatus) st.push("武器" + d.weaponStatus); if (d.disabled) st.push("失能");
    if (d.rangeKm != null) st.push(d.unlimitedFuel ? "燃料∞" : `航程${Math.round(d.rangeKm)}km`);
    const w = (d.ammo || []).filter(a => a.c > 0 && OFFENSIVE.has(a.cat)).map(a => `${CATLBL[a.cat] || a.cat}${a.dn || a.n}x${a.c}${a.rmax ? `(${Math.round(a.rmax)}nm)` : ""}`);
    L.push(`  [${u.num}] ${u.name}${u.type ? `(${u.type})` : ""} ${domName[u.domain] || u.domain} 航向${Math.round(u.course)}°/${Math.round(u.speed)}kn${st.length ? " · " + st.join("/") : ""}`);
    if (w.length) L.push(`      武器：${w.join("、")}`);
    if (d.order) L.push(`      任務：${d.order}`);
  }

  L.push(`\n威脅評估（威脅高→低；範圍/接近率為觀測推算，角色為推測）：`);
  const assessed = foes.map(f => {
    let nu = null, rng = Infinity;
    for (const u of own) { const r = nm(u, f); if (r < rng) { rng = r; nu = u; } }
    const clo = nu ? closingSpeed(f, nu) : 0;
    const [role, conf] = probableRole(f);
    return { f, nu, rng, clo, role, conf, lvl: threatLevel(f, clo, rng) };
  }).sort((a, b) => (THREAT_ORDER[a.lvl] - THREAT_ORDER[b.lvl]) || a.rng - b.rng);
  for (const a of assessed) {
    const f = a.f, ids = f.identified ? "已識別" : f.classified ? "已分類" : "未識別";
    const det = (f.det || []).map(x => detName[x] || x).join("/");
    const geo = a.nu ? `距[${a.nu.num}]${a.rng.toFixed(0)}nm/方位${Math.round(bearing(a.nu, f))}° 接近${Math.round(a.clo)}kn` : "";
    L.push(`  ${tid(f)} ${f.name}${f.type ? `(${f.type})` : ""} ${relName[f.relation] || f.relation}/${domName[f.domain] || f.domain} ${ids} · 威脅:${a.lvl} · 推測:${a.role}(${a.conf}) · 航向${Math.round(f.course)}°/${Math.round(f.speed)}kn ${geo}${det ? ` 偵測:${det}` : ""}`);
  }

  const ev = events.slice(-14).reverse();
  if (ev.length) { L.push("\n最近事件（新→舊）："); for (const e of ev) L.push(`  - [${e.gt || ""}] ${e.event} ${e.track} ${e.severity} ${JSON.stringify(e.details)}`); }
  const recent = cmds.slice(-8).map(cmdText).filter(Boolean);
  if (recent.length) { L.push("\n最近玩家命令（舊→新）："); for (const t of recent) L.push("  - " + t); }
  if (sc.intel?.length) { L.push("\n情報："); for (const i of sc.intel.slice(0, 5)) L.push(`  - ${i.time ? `[${i.time}] ` : ""}${i.text}`); }
  L.push("\n可採取動作：移動/航點、指定武器交戰(EngageWith)、改航速/高度、EMCON、開關感測器(雷達/聲納)、武器狀態(Free/Tight/Hold)、標記關係、要求識別。");
  return L.join("\n");
}

const SYSTEM =
`你是《Sea Power》即時海戰的戰術顧問。輸入是已由程式壓縮好的「明面戰況 + 事件/趨勢」。
規則：
- 一律繁體中文，專業精簡，盡量條列可執行建議。
- 只依據提供的資料推論；未識別接觸的真實身分、敵方武器鎖定與載彈、未偵測兵力等一律未知，不可臆測。標為「推測」的角色/威脅是觀測推論，請如實當作不確定。
- 善用「最近事件/趨勢」判斷戰局演化（例如接觸轉向編隊、加速、武器發射、彈藥/燃料告警）。
- 交戰建議要具體：用哪個單位[編號]、哪種武器、是否在射程內、時機與風險。
- 若剛下過命令（見最近玩家命令），據此接續建議、避免重複。`;

// 統一發送：把網路層錯誤（fetch failed）的底層原因也帶出來，方便診斷
async function apiFetch(url, opt, label) {
  let res;
  try {
    res = await fetch(url, opt);
  } catch (e) {
    const c = (e && e.cause) || e;
    const detail = [c && c.code, c && (c.message || c.reason), e && e.message].filter(Boolean).join(" ");
    throw new Error(`${label} 連線失敗：${detail || "fetch failed"}（通常是沒網路／防火牆／需要代理／TLS 憑證問題）`);
  }
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function callAnthropic(system, msgs, cfg) {
  const d = await apiFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, max_tokens: 1500, system, messages: msgs }),
  }, "Anthropic");
  return (d.content && d.content[0] && d.content[0].text) || "（沒有回覆內容）";
}
async function callOpenAI(system, msgs, cfg) {
  const d = await apiFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, max_tokens: 1500, messages: [{ role: "system", content: system }, ...msgs] }),
  }, "OpenAI");
  return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "（沒有回覆內容）";
}

export async function askAdvisor({ message, history, scenario, cfg }) {
  const ctx = buildContext(scenario);
  const messages = (Array.isArray(history) ? history.slice(-6) : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .concat([{ role: "user", content: `【壓縮戰況】\n${ctx}\n\n【我的問題】${message}` }]);
  const reply = cfg.provider === "openai" ? await callOpenAI(SYSTEM, messages, cfg) : await callAnthropic(SYSTEM, messages, cfg);
  return { reply, prompt: { provider: cfg.provider, model: cfg.model, system: SYSTEM, messages } };
}
