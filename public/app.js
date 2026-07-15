// SP Advisor — 前端（Leaflet 真實地圖底圖 + NTDS 符號疊加層 + 聊天）
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const mapEl = document.getElementById("map");

let state = null;          // 從 /api/state 拿到的戰況
let selectedId = null;
let startWall = Date.now();
let live = false;          // true = 遊戲即時資料（停用本地推算）
let collapsedGroups = new Set();  // 記住被摺疊的 Fleet 資料夾
let map = null;
let dpr = Math.min(window.devicePixelRatio || 1, 2);

function css(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }
function relColor(rel) {
  return { friendly:css("--c-friendly"), allied:css("--c-allied"), hostile:css("--c-hostile"),
           neutral:css("--c-neutral"), unknown:css("--c-unknown"), destroyed:css("--c-destroyed") }[rel] || css("--ink");
}

// 經緯 → 螢幕像素（交給 Leaflet）
function project(lat, lon) { const p = map.latLngToContainerPoint([lat, lon]); return { x:p.x, y:p.y }; }

// 接觸標籤：編號 + 艦名（未識別則顯示領域通稱）
function domainName(d){ return {air:"空中接觸",surface:"水面接觸",subsurface:"水下接觸",missile:"飛彈",torpedo:"魚雷"}[d]||"接觸"; }
function detName(d){ return {visual:"目視",radar:"雷達",sonar:"聲納",esm:"電磁",mad:"磁探"}[d]||d; }
function relName(r){ return {friendly:"友軍",allied:"友盟",hostile:"敵軍",neutral:"中立",unknown:"未知"}[r]||r; }
function contactNo(c){ return (c.num!=null && c.num>=0) ? c.num+" " : ""; }
function contactName(c){ return contactNo(c) + (c.name || domainName(c.domain)); }        // 清單/詳情用
function mapLabelFull(c){ return contactNo(c) + (c.type?"("+c.type+") ":"") + (c.name||domainName(c.domain)); }
function mapLabelShort(c){ const t=c.type?" ("+c.type+")":""; return (contactNo(c).trim()||"") + t; } // 只有編號+類型
// 海圖標籤：選中→完整；飛彈→不標（避免雜亂）；其他→簡短
function mapLabel(c){
  const sel = c.id===selectedId;
  if (sel) return mapLabelFull(c);
  if (c.domain==="missile" || c.domain==="torpedo") return "";
  return mapLabelShort(c);
}

// 把 GeoJSON 經度平移 ±360，用來渲染相鄰世界副本（左右無限輪迴）
function shiftGeoJSON(gj, dLng){
  const off = c => (typeof c[0]==="number") ? [c[0]+dLng, c[1]] : c.map(off);
  return { type:"FeatureCollection", features: gj.features.map(f=>({
    type:"Feature", properties:null,
    geometry:{ type:f.geometry.type, coordinates: off(f.geometry.coordinates) } })) };
}

function fmtLat(l){ return Math.abs(l).toFixed(3)+"°"+(l>=0?"N":"S"); }
function fmtLon(l){ return Math.abs(l).toFixed(3)+"°"+(l>=0?"E":"W"); }
function nm(a, b) {
  const R = 3440.065, toR = Math.PI/180;
  const dLat=(b.lat-a.lat)*toR, dLon=(b.lon-a.lon)*toR, la1=a.lat*toR, la2=b.lat*toR;
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const toR=Math.PI/180;
  const y=Math.sin((b.lon-a.lon)*toR)*Math.cos(b.lat*toR);
  const x=Math.cos(a.lat*toR)*Math.sin(b.lat*toR)-Math.sin(a.lat*toR)*Math.cos(b.lat*toR)*Math.cos((b.lon-a.lon)*toR);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

// ── canvas 疊加層尺寸同步地圖容器 ───────────────────────────
function sizeCanvas() {
  const w = mapEl.clientWidth, h = mapEl.clientHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w*dpr; canvas.height = h*dpr;
  canvas.style.width = w+"px"; canvas.style.height = h+"px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
}

// ── 繪製 ────────────────────────────────────────────────────
function drawRangeRings() {
  const own = state?.scenario.contacts.find(c=>c.own && !c.destroyed);
  if (!own || !map) return;
  const o=project(own.lat, own.lon);
  // 用 Leaflet 的比例把海里換成像素
  const p10 = map.latLngToContainerPoint([own.lat + 10/60, own.lon]);
  const pxPerNm = Math.abs(o.y - p10.y) / 10;
  ctx.strokeStyle="rgba(20,60,100,0.45)"; ctx.setLineDash([4,4]); ctx.lineWidth=1;
  ctx.font="10px "+css("--font-mono"); ctx.fillStyle="rgba(15,45,75,0.85)";
  for (const r of [10,25,50]) {
    const rpx=r*pxPerNm; if (rpx<12||rpx>2000) continue;
    ctx.beginPath(); ctx.arc(o.x,o.y,rpx,0,Math.PI*2); ctx.stroke();
    ctx.fillText(r+" nm", o.x+2, o.y-rpx+11);
  }
  ctx.setLineDash([]);
}

// NTDS 風格符號：顏色=關係，形狀=領域
function drawSymbol(c) {
  const p=project(c.lat,c.lon), col=c.destroyed?css("--c-destroyed"):relColor(c.relation), r=8;
  ctx.save();
  ctx.lineWidth = c.own ? 2.4 : 1.8; ctx.strokeStyle=col; ctx.fillStyle=col;
  ctx.beginPath();
  switch (c.domain) {
    case "air": ctx.arc(p.x,p.y,r,Math.PI,0); ctx.stroke(); break;
    case "subsurface": ctx.arc(p.x,p.y,r,0,Math.PI); ctx.stroke(); break;
    case "missile":
      ctx.moveTo(p.x,p.y-r); ctx.lineTo(p.x+r*0.7,p.y); ctx.lineTo(p.x,p.y+r);
      ctx.lineTo(p.x-r*0.7,p.y); ctx.closePath(); ctx.fill(); break;
    case "torpedo":
      ctx.moveTo(p.x,p.y-r); ctx.lineTo(p.x+r*0.8,p.y+r*0.7); ctx.lineTo(p.x-r*0.8,p.y+r*0.7);
      ctx.closePath(); ctx.fill(); break;
    default: ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.stroke();
  }
  if (c.own) { ctx.beginPath(); ctx.arc(p.x,p.y,r+3,0,Math.PI*2); ctx.stroke(); }
  if (c.destroyed) { ctx.beginPath(); ctx.moveTo(p.x-r,p.y-r); ctx.lineTo(p.x+r,p.y+r);
    ctx.moveTo(p.x+r,p.y-r); ctx.lineTo(p.x-r,p.y+r); ctx.stroke(); }

  if (c.speed>0 && !c.destroyed) {
    const len=Math.min(6+c.speed*0.35,55), a=(c.course-90)*Math.PI/180;
    ctx.beginPath(); ctx.moveTo(p.x,p.y);
    ctx.lineTo(p.x+Math.cos(a)*len, p.y+Math.sin(a)*len); ctx.stroke();
  }
  if (c.id===selectedId) {
    ctx.strokeStyle=css("--accent"); ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
    ctx.strokeRect(p.x-r-6,p.y-r-6,(r+6)*2,(r+6)*2); ctx.setLineDash([]);
  }
  ctx.restore();
}

// 標籤獨立一輪：字大、白色柔邊（非黑框）、碰撞避讓（重疊就略過，選中一定顯示）
function drawLabels() {
  const drawn = [];
  ctx.font = "bold 14px "+css("--font-mono");
  ctx.textBaseline = "middle";
  const prio = c => (c.id===selectedId?0 : c.own?1 : c.relation==="hostile"?2 : 3);
  const list = [...state.scenario.contacts].sort((a,b)=>prio(a)-prio(b));
  for (const c of list) {
    const lbl = mapLabel(c); if (!lbl) continue;
    const p = project(c.lat,c.lon);
    const x = p.x+13, y = p.y, w = ctx.measureText(lbl).width;
    const rect = { x, y:y-9, w, h:18 };
    let hit = false;
    for (const r of drawn) if (rect.x<r.x+r.w && rect.x+rect.w>r.x && rect.y<r.y+r.h && rect.y+rect.h>r.y){ hit=true; break; }
    if (hit && c.id!==selectedId) continue;   // 選中必顯示，其餘重疊則略過
    drawn.push(rect);
    const col = c.destroyed?css("--c-destroyed"):relColor(c.relation);
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.strokeText(lbl, x, y);
    ctx.fillStyle = col; ctx.fillText(lbl, x, y);
  }
}

// 選中己方單位：每種武器各自的射程環（依 rmax 分組、去重、逐環標名）
const RING_COLORS=["rgba(200,40,40,0.55)","rgba(210,120,20,0.55)","rgba(150,60,170,0.55)","rgba(30,120,170,0.55)","rgba(20,150,90,0.55)"];
function drawWeaponRings(c) {
  const ammo = c.detail && c.detail.ammo;
  if (!ammo || !map) return;
  const o=project(c.lat,c.lon);
  const p1=map.latLngToContainerPoint([c.lat+1/60, c.lon]);
  const pxPerNm=Math.abs(o.y-p1.y);
  const rings=new Map();  // rmax(取整) → [武器名...]
  for (const a of ammo){ if(!a.rmax||a.rmax<=0) continue;
    const key=Math.round(a.rmax); if(!rings.has(key)) rings.set(key,[]);
    rings.get(key).push(a.dn||a.n); }
  if (!rings.size) return;
  ctx.save(); ctx.font="10px "+css("--font-mono"); ctx.textAlign="left";
  let i=0;
  for (const nm of [...rings.keys()].sort((a,b)=>a-b)) {
    const rpx=nm*pxPerNm; if(rpx<8||rpx>4000){i++;continue;}
    const col=RING_COLORS[i%RING_COLORS.length];
    ctx.strokeStyle=col; ctx.setLineDash([6,4]); ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.arc(o.x,o.y,rpx,0,Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
    const names=rings.get(nm), label=`${names.slice(0,2).join(", ")}${names.length>2?"…":""} ${nm}nm`;
    ctx.lineWidth=3; ctx.strokeStyle="rgba(255,255,255,0.8)"; ctx.strokeText(label, o.x+4, o.y-rpx+11);
    ctx.fillStyle=col.replace("0.55","1"); ctx.fillText(label, o.x+4, o.y-rpx+11);
    i++;
  }
  ctx.restore();
}

// 我方航線（選中時高亮，攻擊航點紅點）
function drawWaypoints(c) {
  const wps = c.detail && c.detail.waypoints;
  if (!wps || !wps.length) return;
  const sel = c.id===selectedId;
  ctx.save();
  ctx.strokeStyle = sel ? "#0a66c2" : "rgba(20,70,130,0.6)";
  ctx.lineWidth = sel ? 2 : 1; ctx.setLineDash(sel?[]:[5,5]);
  ctx.beginPath();
  const s=project(c.lat,c.lon); ctx.moveTo(s.x,s.y);
  for (const w of wps){ const p=project(w.lat,w.lon); ctx.lineTo(p.x,p.y); }
  ctx.stroke(); ctx.setLineDash([]);
  for (const w of wps){ const p=project(w.lat,w.lon);
    ctx.fillStyle = w.atk ? css("--c-hostile") : (sel?"#0a66c2":"rgba(20,70,130,0.85)");
    ctx.beginPath(); ctx.arc(p.x,p.y, w.atk?4.5:3, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function render() {
  ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
  if (!state || !map) return;
  // 只有選中的己方單位才顯示：各武器射程環 + 航線（避免一多就亂）
  const sel = state.scenario.contacts.find(c=>c.id===selectedId);
  if (sel && sel.own) { drawWeaponRings(sel); drawWaypoints(sel); }
  for (const c of state.scenario.contacts) drawSymbol(c);
  drawLabels();
}

// ── 假資料推算（mock 模式讓接觸移動）──────────────────────────
function advance(dtSec) {
  if (!state) return;
  for (const c of state.scenario.contacts) {
    if (!c.speed) continue;
    const distNm = c.speed * dtSec/3600;
    c.lat += distNm/60 * Math.cos(c.course*Math.PI/180);
    c.lon += distNm/60 * Math.sin(c.course*Math.PI/180) / Math.cos(c.lat*Math.PI/180);
  }
}

// 按需重畫（rAF 合併，避免重複）——取代每幀重畫，省 CPU
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}
function showWaiting(t){ const el=document.getElementById("waiting"); el.textContent=t; el.classList.remove("hidden"); }
function hideWaiting(){ document.getElementById("waiting").classList.add("hidden"); }

function updateClock() {
  const s=Math.floor((Date.now()-startWall)/1000);
  const hh=String(Math.floor(s/3600)).padStart(2,"0");
  const mm=String(Math.floor(s/60)%60).padStart(2,"0");
  const ss=String(s%60).padStart(2,"0");
  document.getElementById("clock").textContent=`T + ${hh}:${mm}:${ss}`;
}

// 自動取景：把所有接觸框進地圖
function fitToContacts() {
  const cs=(state&&state.scenario&&state.scenario.contacts)||[];
  if (!cs.length || !map) return;
  const b=L.latLngBounds(cs.map(c=>[c.lat,c.lon]));
  map.fitBounds(b, { padding:[50,50], maxZoom:12 });
}

// ── 單位清單 ────────────────────────────────────────────────
function buildUnitList() {
  const ul=document.getElementById("unit-list"); ul.innerHTML="";
  // 分組：己方按 Fleet(編隊)，其餘按關係
  const relOrder={friendly:0,allied:1,neutral:5,unknown:6,hostile:7};
  const groups=new Map();
  for (const c of state.scenario.contacts) {
    let key,label,order;
    if (c.own){ label=c.group||"我方編隊"; key="own:"+label; order=0; }
    else { label=relName(c.relation); key="rel:"+c.relation; order=(relOrder[c.relation]??8); }
    if (!groups.has(key)) groups.set(key,{label,order,items:[]});
    groups.get(key).items.push(c);
  }
  const inner={friendly:0,allied:1,neutral:2,unknown:3,hostile:4};
  const sorted=[...groups.values()].sort((a,b)=>a.order-b.order||a.label.localeCompare(b.label));
  for (const g of sorted) {
    const collapsed=collapsedGroups.has(g.label);
    const hdr=document.createElement("li"); hdr.className="u-folder"+(collapsed?" collapsed":"");
    hdr.innerHTML=`<span class="u-caret">${collapsed?"▸":"▾"}</span>`+
      `<span class="u-fold-name">${g.label}</span><span class="u-fold-count">${g.items.length}</span>`;
    hdr.onclick=()=>{ collapsed?collapsedGroups.delete(g.label):collapsedGroups.add(g.label); buildUnitList(); };
    ul.appendChild(hdr);
    if (collapsed) continue;
    for (const c of [...g.items].sort((a,b)=>(inner[a.relation]-inner[b.relation]))) {
      const li=document.createElement("li"); li.className="u-item"; li.dataset.id=c.id;
      li.innerHTML=`<span class="dot" style="background:${relColor(c.relation)}"></span>
        <span class="u-name">${contactName(c)}<div class="u-sub">${c.type||domainName(c.domain)} · ${Math.round(c.speed)}kn</div></span>`;
      li.onclick=()=>{ selectContact(c.id); const t=state.scenario.contacts.find(x=>x.id===c.id);
        if (t&&map) map.panTo([t.lat,t.lon]); };
      if (c.id===selectedId) li.classList.add("sel");
      ul.appendChild(li);
    }
  }
}
function selectContact(id) {
  selectedId=id;
  document.querySelectorAll("#unit-list li").forEach(li=>li.classList.toggle("sel",+li.dataset.id===id));
  updateReadout(); updatePlanToolbar(); scheduleRender();
}
const roRow=(k,v)=>`<div class="ro-row"><span class="ro-k">${k}</span><span class="ro-v">${v}</span></div>`;
const roSec=t=>`<div class="ro-sec">${t}</div>`;
function updateReadout() {
  const el=document.getElementById("readout");
  const c=state?.scenario.contacts.find(x=>x.id===selectedId);
  const own=state?.scenario.contacts.find(x=>x.own);
  if (!c) { el.innerHTML=""; el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const col=relColor(c.relation);
  const r=x=>(x&&x>0)?Math.round(x):"—";
  const status = c.own ? "" : (c.identified?"已識別":c.classified?"已分類":"未識別")+(c.dormant?" · 休眠":"");
  let h=`<div class="ro-head"><span class="ro-num" style="color:${col}">${contactNo(c).trim()||"—"}</span>`+
        `<span class="ro-nm" style="color:${col}">${c.name||domainName(c.domain)}</span>`+
        `<div class="ro-sub">${c.type?"("+c.type+") ":""}${relName(c.relation)}${status?" · "+status:""}`+
        `${c.class&&c.class!==c.name?" · "+c.class:""}</div></div><div class="ro-body">`;
  h+=roRow("位置", `${fmtLat(c.lat)} ${fmtLon(c.lon)}`);
  let k=`${Math.round(c.course)}° · ${Math.round(c.speed)} kn`; if (c.altitude) k+=` · ${Math.round(c.altitude)} ft`;
  h+=roRow("航向/速", k);
  if (own && !c.own) h+=roRow("距/方位", `${nm(own,c).toFixed(1)} nm · ${Math.round(bearing(own,c))}°`);
  if (c.det && c.det.length) h+=roRow("偵測", c.det.map(detName).join(" · "));

  if (c.own && c.detail) {
    const d=c.detail;
    h+=roSec("狀態");
    if (d.order) h+=roRow("任務", d.order);
    const st=[]; if(d.nation)st.push(d.nation); st.push(d.emcon?"EMCON靜默":"輻射中");
    if(d.inFormation!=null)st.push(d.inFormation?(d.formationLeader?"編隊長":"編隊中"):"獨立");
    if(d.disabled)st.push(`<span class="ro-warn">⚠失能</span>`);
    h+=roRow("狀態", st.join(" · "));
    h+=roRow("航程/武器", `${d.unlimitedFuel?"∞":r(d.rangeKm)+" km"} · ${d.weaponStatus||"—"}`);
    if (d.engage) { h+=roSec("火力");
      h+=roRow("交戰", `防空 ${r(d.engage.aaw)} · 反艦 ${r(d.engage.asuw)} · 反潛 ${r(d.engage.asw)}`); }
    if (d.sensors) { const s=d.sensors,sp=[];
      if(s.airRadar)sp.push(`空搜×${s.airRadar}`); if(s.surfRadar)sp.push(`平搜×${s.surfRadar}`);
      if(s.targRadar)sp.push(`射控×${s.targRadar}`); if(s.sonar)sp.push(`聲納×${s.sonar}`);
      if(s.towed)sp.push(`拖曳×${s.towed}`); if(s.visual)sp.push(`目視×${s.visual}`);
      if(sp.length) h+=roSec("感測")+roRow("裝備", sp.join("  ")); }
    if (d.aircraft && d.aircraft.length) h+=roSec("艦載機")+roRow("機隊", d.aircraft.map(a=>`${a.n}×${a.c}`).join("  "));
    if (d.ammo && d.ammo.length) { h+=roSec("彈藥")+`<div class="ro-ammo">`+
      d.ammo.map(a=>`<div class="ro-am"><span class="ro-amn">${a.dn||a.n}</span>`+
        `<span class="ro-amc">×${a.c}${a.rmax?` · ${a.rmin>0.5?Math.round(a.rmin)+"–":""}${Math.round(a.rmax)}nm`:""}</span></div>`).join("")+`</div>`; }
  }
  el.innerHTML=h+`</div>`;
}

// ── 聊天 ────────────────────────────────────────────────────
function addMsg(text, cls){ const d=document.createElement("div"); d.className="msg "+cls;
  d.textContent=text; const log=document.getElementById("chat-log"); log.appendChild(d); log.scrollTop=log.scrollHeight; }
const form=document.getElementById("chat-form"), input=document.getElementById("chat-input");
form.addEventListener("submit", async e=>{
  e.preventDefault(); const msg=input.value.trim(); if (!msg) return;
  addMsg(msg,"user"); input.value="";
  try {
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});
    addMsg((await r.json()).reply,"bot");
  } catch { addMsg("（連線失敗，伺服器沒開？）","sys"); }
});
input.addEventListener("keydown", e=>{ if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); form.requestSubmit(); } });

document.getElementById("day-night").onclick=e=>{
  document.body.classList.toggle("night");
  e.target.textContent=document.body.classList.contains("night")?"☀ 日間":"☾ 夜間";
};

function logLine(t){ const f=document.getElementById("msglog");
  const now=new Date().toLocaleTimeString();
  f.innerHTML=`<span class="t">${now}</span> ${t}<br>`+f.innerHTML; }

// ── 航線規劃（Web → 遊戲）────────────────────────────────
// 底部提示列（目前無模式，恆隱藏）
function updatePlanToolbar() { document.getElementById("plan-toolbar").className="hidden"; }

// ── 指令傳送（即時，無需批次送出）──────────────────────────
async function sendCmd(o){
  try{ await fetch("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});
    logLine(cmdDesc(o)); }catch{ logLine("指令送出失敗（伺服器？）"); }
}
function cmdDesc(o){ const u=o.unit; switch(o.type){
  case "waypoint": return o.replace ? `單位 ${u} 移動（轉向新航向）` : `單位 ${u} 加入航點`;
  case "clearwp": return `單位 ${u} 清除航點`;
  case "resume": return `單位 ${u} 恢復航向`;
  case "emcon": return `單位 ${u} EMCON ${o.on?"靜默":"輻射"}`;
  case "speed": return `單位 ${u} 航速 ${o.num} kn`;
  case "altitude": return `單位 ${u} 高度 ${o.num} ft`;
  case "weaponstatus": return `單位 ${u} 武器 ${o.value}`;
  case "sensor": return `單位 ${u} 感測 ${o.value} ${o.on?"開":"關"}`;
  case "attack": return `單位 ${u} 攻擊 ${o.target}`;
  default: return `指令 ${o.type}`; } }

// ── 右鍵情境選單 ────────────────────────────────────────
function buildMenu(items, container){
  for(const it of items){
    if(it.sep){ const s=document.createElement("div"); s.className="ctx-sep"; container.appendChild(s); continue; }
    const el=document.createElement("div"); el.className="ctx-item"+(it.danger?" danger":"");
    const lab=document.createElement("span"); lab.textContent=it.label; el.appendChild(lab);
    if(it.sub){ el.classList.add("has-sub");
      const c=document.createElement("span"); c.className="ctx-caret"; c.textContent="▸"; el.appendChild(c);
      const sub=document.createElement("div"); sub.className="ctx-sub"; buildMenu(it.sub, sub); el.appendChild(sub);
    } else if(it.action){ el.onclick=(ev)=>{ ev.stopPropagation(); hideContextMenu(); it.action(); }; }
    container.appendChild(el);
  }
}
function showContextMenu(x,y,title,items){
  const m=document.getElementById("ctxmenu"); m.innerHTML="";
  if(title){ const h=document.createElement("div"); h.className="ctx-hd"; h.textContent=title; m.appendChild(h); }
  buildMenu(items, m); m.className=""; m.style.left="0px"; m.style.top="0px";
  const r=m.getBoundingClientRect(), w=document.getElementById("chart-wrap").getBoundingClientRect();
  let px=x, py=y;
  if(px+r.width>w.width) px=Math.max(4,x-r.width);
  if(py+r.height>w.height) py=Math.max(4,w.height-r.height-4);
  m.style.left=px+"px"; m.style.top=py+"px";
}
function hideContextMenu(){ document.getElementById("ctxmenu").className="hidden"; }

// 己方單位的右鍵選單（比照遊戲）
function unitMenu(c){
  const u=c.id, d=c.detail||{};
  const nav=[
    {label:"改變航速", sub:[0,5,10,15,20,25,30].map(s=>({label:s===0?"停俥":s+" kn",action:()=>sendCmd({type:"speed",unit:u,num:s})}))},
    {label:"清除航點", action:()=>sendCmd({type:"clearwp",unit:u})},
    {label:"恢復航向", action:()=>sendCmd({type:"resume",unit:u})},
  ];
  if(c.domain==="air") nav.push({label:"設定高度", sub:[500,1000,5000,10000,20000,30000].map(a=>({label:a+" ft",action:()=>sendCmd({type:"altitude",unit:u,num:a})}))});
  const sensorSub=(v)=>[{label:"開",action:()=>sendCmd({type:"sensor",unit:u,value:v,on:true})},{label:"關",action:()=>sendCmd({type:"sensor",unit:u,value:v,on:false})}];
  return [
    {label:"航行", sub:nav},
    {label:"感測器", sub:[
      {label:"空搜雷達", sub:sensorSub("air")},
      {label:"平搜雷達", sub:sensorSub("surf")},
      {label:"主動聲納", sub:sensorSub("sonar")},
    ]},
    {label:"武器狀態", sub:[
      {label:"Free 自由", action:()=>sendCmd({type:"weaponstatus",unit:u,value:"Free"})},
      {label:"Tight 限制", action:()=>sendCmd({type:"weaponstatus",unit:u,value:"Tight"})},
      {label:"Hold 暫停", action:()=>sendCmd({type:"weaponstatus",unit:u,value:"Hold"})},
    ]},
    {label: d.emcon?"EMCON：解除靜默":"EMCON：靜默", action:()=>sendCmd({type:"emcon",unit:u,on:!d.emcon})},
  ];
}
// ── 下令（比照遊戲：右鍵敵方=攻擊、右鍵空海=移動）────────────
function orderAttack(selId, targetId){
  const c=state.scenario.contacts.find(x=>x.id===targetId); if(!c||c.own) return;
  sendCmd({type:"attack",unit:selId,target:targetId}); }
function orderMove(selId, latlng, append){
  sendCmd({type:"waypoint",unit:selId,replace:!append,points:[{lat:latlng.lat,lon:latlng.lng}]}); }

// ── 即時輪詢 ────────────────────────────────────────────────
let hadData = false;
async function pollLive() {
  let d;
  try { d = await (await fetch("/api/state")).json(); } catch { return; }
  const cs = (d.live && d.scenario && d.scenario.contacts) || [];
  if (cs.length) {                                   // 有任務單位 → 顯示
    live = true; hideWaiting();
    const oldIds=new Set(state.scenario.contacts.map(c=>c.id));
    state.scenario.contacts = cs;
    if (d.scenario.name){ state.scenario.name=d.scenario.name;
      document.getElementById("mission-name").textContent=d.scenario.name; }
    const newIds=new Set(cs.map(c=>c.id));
    let changed=oldIds.size!==newIds.size;
    if (!changed) for (const id of newIds) if (!oldIds.has(id)){ changed=true; break; }
    if (changed) buildUnitList();
    if (!hadData){ fitToContacts(); const own=cs.find(c=>c.own);
      selectContact(own?own.id:cs[0].id); logLine(`已連上遊戲即時戰況（接觸 ${cs.length}）`); }
    updateReadout();
    hadData = true;
    scheduleRender();
  } else {                                           // 無任務 → 空著
    live = false;
    if (hadData) logLine(d.live ? "任務單位已清空" : "與遊戲連線中斷");
    state.scenario.contacts = []; selectedId = null; hideContextMenu();
    buildUnitList(); updateReadout(); updatePlanToolbar();
    document.getElementById("mission-name").textContent = "—";
    showWaiting(d.live ? "已連線 · 等待任務單位…" : "等待遊戲連線…（請開啟 Sea Power 並進入任務）");
    hadData = false;
    scheduleRender();
  }
}

// ── 啟動 ────────────────────────────────────────────────────
async function init() {
  map = L.map("map", { zoomControl:true, attributionControl:true,
                       preferCanvas:true, maxZoom:16, zoomAnimation:false, fadeAnimation:false })
        .setView([25,45], 4);
  // 純向量海岸線底圖（無地圖磚、完全離線；海面 = #map 淺藍背景，陸地向量任何倍率都銳利）
  fetch("/vendor/land-simplified.geojson").then(r=>r.json()).then(gj=>{
    L.geoJSON(gj, { renderer:L.canvas({ padding:0.3 }), smoothFactor:1, interactive:false,
      style:{ color:"#8f9a82", weight:0.8, fillColor:"#d9d3c4", fillOpacity:1 } }).addTo(map);
    map.attributionControl.addAttribution("Coastlines: Natural Earth");
    scheduleRender();
  }).catch(()=>{});
  map.on("load", scheduleRender);

  sizeCanvas();
  map.on("resize", ()=>{ sizeCanvas(); scheduleRender(); });
  map.on("move zoom viewreset zoomend moveend", scheduleRender);
  map.on("mousemove", e=>{ document.getElementById("chart-hint").textContent =
    `${fmtLat(e.latlng.lat)}  ${fmtLon(e.latlng.lng)}`; });
  map.on("dblclick", ()=>{ fitToContacts(); });   // 雙擊置中
  map.doubleClickZoom.disable();
  const hitContact = px => { let best=null, bestD=18;
    for (const c of state.scenario.contacts){ const p=project(c.lat,c.lon);
      const d=Math.hypot(p.x-px.x,p.y-px.y); if (d<bestD){bestD=d;best=c;} } return best; };
  // 左鍵：僅選取單位（比照遊戲）
  map.on("click", e=>{
    hideContextMenu();
    if (!state) return;
    const best = hitContact(e.containerPoint);
    if (best){ selectContact(best.id); buildUnitList(); }
  });
  // 右鍵：對「已選的己方單位」下令（比照遊戲 UnitSelectedState）
  //   右鍵己方 → 指令選單 · 右鍵敵方 → 攻擊 · 右鍵空海 → 移動(轉向) · Shift+右鍵空海 → 加航點
  map.on("contextmenu", e=>{
    if (e.originalEvent) e.originalEvent.preventDefault();
    hideContextMenu();
    if (!state) return;
    const best = hitContact(e.containerPoint);
    if (best && best.own){                      // 己方單位 → 選單
      selectContact(best.id); buildUnitList();
      showContextMenu(e.containerPoint.x, e.containerPoint.y, contactName(best), unitMenu(best));
      return;
    }
    const sel = state.scenario.contacts.find(c=>c.id===selectedId);
    if (!sel || !sel.own){ logLine("先左鍵選一個己方單位，再右鍵下令"); return; }
    if (best && !best.own){ orderAttack(sel.id, best.id); return; }        // 敵方 → 攻擊
    orderMove(sel.id, e.latlng, e.originalEvent && e.originalEvent.shiftKey); // 空海 → 移動 / Shift 加航點
  });
  document.addEventListener("click", ev=>{ if (!ev.target.closest("#ctxmenu")) hideContextMenu(); });
  map.on("movestart zoomstart", hideContextMenu);
  window.addEventListener("keydown", e=>{
    if (e.key==="Escape") hideContextMenu();
    if ((e.key==="f"||e.key==="F") && document.activeElement!==input) fitToContacts();
  });

  // 空狀態起手：等待遊戲即時資料
  state = { scenario: { name:"", center:null, contacts:[] } };
  document.getElementById("mission-name").textContent = "—";
  buildUnitList();
  showWaiting("等待遊戲連線…（請開啟 Sea Power 並進入任務）");
  addMsg("戰術顧問待命。開啟遊戲任務後，海圖會顯示即時戰況；聊天引擎將於下一階段接上。","sys");

  setInterval(updateClock, 1000); updateClock();
  setInterval(pollLive, 250);
  pollLive();
  scheduleRender();
}
window.addEventListener("resize", sizeCanvas);
init();
