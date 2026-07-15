// SP Advisor — 前端（Leaflet 真實地圖底圖 + NTDS 符號疊加層 + 聊天）
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const mapEl = document.getElementById("map");

let state = null;          // 從 /api/state 拿到的戰況
let selectedId = null;
let startWall = Date.now();
let live = false;          // true = 遊戲即時資料（停用本地推算）
let collapsedGroups = new Set();  // 記住被摺疊的 Fleet 資料夾
let weaponRingUnit = null;        // 只有開啟武器交戰選單時，才畫這個單位的射程環
let seenIds = new Set();          // 上一幀就存在的接觸（導引線只畫「非剛出現」的，避免閃原點）
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

// NTDS 符號（比照遊戲 minimap 圖示）：關係=形狀家族、領域=取哪一半、色=關係
//   友軍/盟軍→圓弧　敵軍→菱/折線　中立→十字　未知→方框
//   水面=全形 · 空中=上半 · 水下=下半 · 飛彈=上半+M · 魚雷=下半+T
function symFamily(rel){
  if (rel==="friendly"||rel==="allied") return "round";
  if (rel==="hostile") return "angular";
  if (rel==="neutral") return "cross";
  return "square";                       // unknown / 其他
}
function plusPath(x,y,r,a){
  ctx.moveTo(x-a,y-r); ctx.lineTo(x+a,y-r); ctx.lineTo(x+a,y-a); ctx.lineTo(x+r,y-a);
  ctx.lineTo(x+r,y+a); ctx.lineTo(x+a,y+a); ctx.lineTo(x+a,y+r); ctx.lineTo(x-a,y+r);
  ctx.lineTo(x-a,y+a); ctx.lineTo(x-r,y+a); ctx.lineTo(x-r,y-a); ctx.lineTo(x-a,y-a); ctx.closePath();
}
function drawFrame(x,y,r,fam,part){
  ctx.beginPath();
  if (fam==="round"){
    if (part==="top") ctx.arc(x,y,r,Math.PI,Math.PI*2);         // 上半圓（穹頂）
    else if (part==="bottom") ctx.arc(x,y,r,0,Math.PI);          // 下半圓（U）
    else ctx.arc(x,y,r,0,Math.PI*2);
    ctx.stroke();
  } else if (fam==="angular"){
    if (part==="top"){ ctx.moveTo(x-r,y);ctx.lineTo(x,y-r);ctx.lineTo(x+r,y); }        // ^ 上折
    else if (part==="bottom"){ ctx.moveTo(x-r,y);ctx.lineTo(x,y+r);ctx.lineTo(x+r,y); } // v 下折
    else { ctx.moveTo(x,y-r);ctx.lineTo(x+r,y);ctx.lineTo(x,y+r);ctx.lineTo(x-r,y);ctx.closePath(); } // ◇
    ctx.stroke();
  } else if (fam==="square"){
    if (part==="top"){ ctx.moveTo(x-r,y);ctx.lineTo(x-r,y-r);ctx.lineTo(x+r,y-r);ctx.lineTo(x+r,y); } // ⊓
    else if (part==="bottom"){ ctx.moveTo(x-r,y);ctx.lineTo(x-r,y+r);ctx.lineTo(x+r,y+r);ctx.lineTo(x+r,y); } // U
    else ctx.rect(x-r,y-r,2*r,2*r);
    ctx.stroke();
  } else {                                   // cross 十字（中立）— 少見的空/水下沿用全形
    plusPath(x,y,r,r*0.42); ctx.stroke();
  }
}
function drawSymbol(c) {
  const p=project(c.lat,c.lon), col=c.destroyed?css("--c-destroyed"):relColor(c.relation), r=8;
  const fam = c.destroyed ? "angular" : symFamily(c.relation);
  const dom = c.domain;
  const part = (dom==="air"||dom==="missile") ? "top"
             : (dom==="subsurface"||dom==="torpedo") ? "bottom" : "full";
  const glyph = dom==="missile" ? "M" : dom==="torpedo" ? "T" : "";
  ctx.save();
  ctx.lineWidth = c.own ? 2.2 : 1.8; ctx.strokeStyle=col; ctx.fillStyle=col;
  ctx.lineJoin="round"; ctx.lineCap="round";
  drawFrame(p.x,p.y,r,fam,part);
  if (glyph){ ctx.font=`bold ${r+5}px `+css("--font-mono"); ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText(glyph,p.x,p.y); }
  else ctx.fillRect(p.x-1.5,p.y-1.5,3,3);                       // 中心點
  if (c.destroyed){ ctx.beginPath(); ctx.moveTo(p.x-r,p.y-r); ctx.lineTo(p.x+r,p.y+r);
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
    ctx.save();                                    // 無白底：只用極淡陰影保可讀性
    ctx.shadowColor="rgba(0,0,0,0.5)"; ctx.shadowBlur=2; ctx.shadowOffsetY=0.5;
    ctx.fillStyle = col; ctx.fillText(lbl, x, y);
    ctx.restore();
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
  if (sel && sel.own) drawWaypoints(sel);
  if (weaponRingUnit) drawWeaponRings(weaponRingUnit);   // 只在武器選單開啟時顯示射程環
  drawGuidance();                                        // 導引武器 → 目標的綠線
  for (const c of state.scenario.contacts) drawSymbol(c);
  drawLabels();
}

// 導引武器（飛彈/追蹤魚雷）連到目標的綠色導引線（比照遊戲海圖）
function drawGuidance(){
  const byId=new Map(state.scenario.contacts.map(c=>[c.id,c]));
  ctx.save(); ctx.strokeStyle="rgba(0,200,80,0.85)"; ctx.lineWidth=1.3;
  for (const c of state.scenario.contacts){
    if (!c.own) continue;                          // 只畫己方武器（敵方鎖定非明面）
    if (c.tgt==null || (c.domain!=="missile" && c.domain!=="torpedo")) continue;
    if (!seenIds.has(c.id)) continue;              // 剛出現的武器先不畫線（避開原點閃現那一幀）
    const t=byId.get(c.tgt); if(!t) continue;
    const a=project(c.lat,c.lon), b=project(t.lat,t.lon);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.restore();
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
      li.onclick=()=>{ selectContact(c.id); focusInGame(c.id); const t=state.scenario.contacts.find(x=>x.id===c.id);
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
  if (c.by && c.by.length){                               // 被哪個己方單位、用什麼感測器發現
    const byUnit=new Map();
    for(const b of c.by){ if(!byUnit.has(b.u)) byUnit.set(b.u,new Set()); byUnit.get(b.u).add(detName(b.s)); }
    h+=roRow("偵測來源", [...byUnit.entries()].map(([u,s])=>`${u}（${[...s].join("/")}）`).join(" · "));
  }

  if (c.own && c.detail) {
    const d=c.detail;
    h+=roSec("狀態");
    if (d.order) h+=roRow("任務", d.order);
    const st=[]; if(d.nation)st.push(d.nation); st.push(d.emcon?"EMCON靜默":"輻射中");
    if(d.inFormation!=null)st.push(d.inFormation?(d.formationLeader?"編隊長":"編隊中"):"獨立");
    if(d.disabled)st.push(`<span class="ro-warn">失能</span>`);
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
      d.ammo.map(a=>`<div class="ro-am"><span class="ro-amn">${catLabel(a)?`<span class="ro-cat">${catLabel(a)}</span> `:""}${a.dn||a.n}</span>`+
        `<span class="ro-amc">×${a.c}${a.rmax?` · ${a.rmin>0.5?Math.round(a.rmin)+"–":""}${Math.round(a.rmax)}nm`:""}</span></div>`).join("")+`</div>`; }
  }
  el.innerHTML=h+`</div>`;
}

// ── 聊天 ────────────────────────────────────────────────────
function addMsg(text, cls){ const d=document.createElement("div"); d.className="msg "+cls;
  d.textContent=text; const log=document.getElementById("chat-log"); log.appendChild(d); log.scrollTop=log.scrollHeight; return d; }
const form=document.getElementById("chat-form"), input=document.getElementById("chat-input");
let chatHistory=[];   // {role, content} 多輪對話
let aiDebug=false;    // Debug 模式：顯示每次送出的 prompt
function fmtPrompt(p){
  let s=`供應商/模型：${p.provider} / ${p.model}\n\n===== SYSTEM =====\n${p.system}\n`;
  for (const m of p.messages) s+=`\n===== ${(m.role||"").toUpperCase()} =====\n${m.content}\n`;
  return s;
}
function showPromptDebug(p){
  const d=document.createElement("details"); d.className="msg bot dbg-prompt";
  const sum=document.createElement("summary"); sum.textContent=`查看送出的 prompt（${p.messages.length} 則訊息，${p.model}）`;
  const pre=document.createElement("pre"); pre.textContent=fmtPrompt(p);
  d.appendChild(sum); d.appendChild(pre);
  const log=document.getElementById("chat-log"); log.appendChild(d); log.scrollTop=1e9;
}
form.addEventListener("submit", async e=>{
  e.preventDefault(); const msg=input.value.trim(); if (!msg) return;
  addMsg(msg,"user"); input.value="";
  const pending=addMsg("分析中…","bot pending");
  const hist=chatHistory.slice();
  try {
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:msg, history:hist, debug:aiDebug})});
    const j=await r.json(); const reply=j.reply||"（沒有回覆）";
    pending.classList.remove("pending"); pending.textContent=reply;
    if (aiDebug && j.promptSent) showPromptDebug(j.promptSent);
    document.getElementById("chat-log").scrollTop=1e9;
    chatHistory.push({role:"user",content:msg},{role:"assistant",content:reply});
    if (chatHistory.length>12) chatHistory=chatHistory.slice(-12);
  } catch {
    pending.classList.remove("pending"); pending.classList.add("sys"); pending.textContent="（連線失敗，伺服器沒開？）";
  }
});
input.addEventListener("keydown", e=>{ if (e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); form.requestSubmit(); } });

document.getElementById("day-night").onclick=e=>{
  document.body.classList.toggle("night");
  e.target.textContent=document.body.classList.contains("night")?"日間":"夜間";
};

// ── AI 顧問狀態燈 + 設定面板 ──────────────────────────────
let aiCfg={configured:false,provider:"anthropic",model:"",keyFromEnv:false};
function setAiDot(cls){ document.getElementById("ai-dot").className=cls||""; }
function renderAiStatus(){
  setAiDot(aiCfg.configured?"on":"");
  document.getElementById("ai-label").textContent=aiCfg.configured?"AI 就緒":"AI 未設定";
  const kv=document.getElementById("aip-key");
  kv.textContent=aiCfg.configured?(aiCfg.keyFromEnv?"已設定（環境變數）":"已設定（設定檔）"):"未設定";
  kv.className=aiCfg.configured?"set":"unset";
  document.getElementById("aip-provider").value=aiCfg.provider||"anthropic";
  document.getElementById("aip-model").value=aiCfg.model||"";
  document.getElementById("aip-env").textContent=aiCfg.provider==="openai"?"OPENAI_API_KEY":"ANTHROPIC_API_KEY";
}
async function pollAiStatus(){ try{ aiCfg=await (await fetch("/api/ai/status")).json(); renderAiStatus(); }catch{} }
document.getElementById("ai-status").onclick=()=>{
  const p=document.getElementById("ai-panel"); p.classList.toggle("hidden");
  if(!p.classList.contains("hidden")){ pollAiStatus(); document.getElementById("aip-msg").textContent=""; }
};
document.getElementById("aip-debug").onchange=e=>{ aiDebug=e.target.checked; };
document.getElementById("aip-provider").onchange=e=>{
  document.getElementById("aip-env").textContent=e.target.value==="openai"?"OPENAI_API_KEY":"ANTHROPIC_API_KEY";
  document.getElementById("aip-model").placeholder=e.target.value==="openai"?"gpt-4o":"claude-sonnet-5";
};
document.getElementById("aip-save").onclick=async()=>{
  const provider=document.getElementById("aip-provider").value, model=document.getElementById("aip-model").value.trim();
  const msg=document.getElementById("aip-msg"); msg.className="aip-msg"; msg.textContent="儲存中…";
  try{ aiCfg=await (await fetch("/api/ai/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider,model})})).json();
    renderAiStatus(); msg.className="aip-msg ok"; msg.textContent="已儲存"; }
  catch{ msg.className="aip-msg err"; msg.textContent="儲存失敗"; }
};
document.getElementById("aip-test").onclick=async()=>{
  const msg=document.getElementById("aip-msg"); msg.className="aip-msg"; msg.textContent="測試中…"; setAiDot("busy");
  try{ const r=await (await fetch("/api/ai/test",{method:"POST"})).json();
    if(r.ok){ msg.className="aip-msg ok"; msg.textContent="連線成功："+(r.sample||"OK"); aiCfg.configured=true; setAiDot("on"); }
    else { msg.className="aip-msg err"; msg.textContent="失敗："+(r.error||"?"); setAiDot("err"); } }
  catch{ msg.className="aip-msg err"; msg.textContent="失敗（伺服器沒開？）"; setAiDot("err"); }
};
document.addEventListener("click", ev=>{ const p=document.getElementById("ai-panel"), b=document.getElementById("ai-status");
  if(p && !p.classList.contains("hidden") && !p.contains(ev.target) && !b.contains(ev.target)) p.classList.add("hidden"); });

function esc(s){ return (s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

// ── 事件日誌：分「戰況」（遊戲真實事件 + 我方動作）與「Debug」（工具系統訊息）──
let localLog = [];          // {t, x, kind}  kind: "act"=我方動作 / "sys"=系統/連線/Debug
let showDebug = false;      // 是否顯示 Debug 訊息
function logLine(t, kind){ localLog.unshift({t:new Date().toLocaleTimeString(), x:t, kind:kind||"sys"});
  if (localLog.length>60) localLog.pop(); renderEvents(); }
function renderEvents(){
  const f=document.getElementById("msglog"); if(!f) return;
  const game=(state&&state.scenario.events)||[];
  const acts=localLog.filter(e=>e.kind==="act");
  const dbg=localLog.filter(e=>e.kind!=="act");
  let h=`<div class="ev-head">事件 <span class="ev-count">戰況 ${game.length+acts.length}</span>`+
        `<span class="ev-tog${showDebug?" on":""}" id="ev-dbg">Debug ${dbg.length}</span></div>`;
  for (const e of acts) h+=`<div class="ev act"><span class="t">${e.t}</span> » ${esc(e.x)}</div>`;
  for (const e of game) h+=`<div class="ev game"><span class="t">${esc(e.time)}</span> ${esc(e.text)}</div>`;
  if (showDebug) for (const e of dbg) h+=`<div class="ev dbg"><span class="t">${e.t}</span> · ${esc(e.x)}</div>`;
  f.innerHTML=h;
  const tog=document.getElementById("ev-dbg"); if(tog) tog.onclick=()=>{ showDebug=!showDebug; renderEvents(); };
}

// ── 環境列（頂欄）────────────────────────────────────────────
function dayLabel(s){ return ({Day:"日間",Night:"夜間",Dawn:"拂曉",Dusk:"黃昏"})[s]||s||""; }
function renderEnv(){
  const el=document.getElementById("env"); const e=state&&state.scenario.env;
  if(!e){ el.textContent=""; return; }
  const p=[];
  if(e.datetime) p.push(e.datetime);
  if(e.daytime) p.push(dayLabel(e.daytime));
  if(e.seaState!=null) p.push(`海況 ${e.seaState}`);
  if(e.clouds) p.push(e.clouds);
  el.textContent=p.join("  ·  ");
}

// ── 任務目標（左欄）──────────────────────────────────────────
function msLabel(s){ return ({InProgress:"進行中",Victory:"勝利",Defeat:"失敗"})[s]||s; }
function renderObjectives(){
  const box=document.getElementById("objectives"); if(!box) return;
  const objs=(state&&state.scenario.objectives)||[]; const ms=state&&state.scenario.missionStatus;
  const icon=s=>s==="done"?"●":s==="failed"?"×":s==="canceled"?"-":"○";
  let h="";
  if(ms && ms!=="InProgress") h+=`<div class="obj-status ${ms==="Victory"?"win":"lose"}">${msLabel(ms)}</div>`;
  if(!objs.length){ h+=`<div class="obj-empty">—</div>`; box.innerHTML=h; return; }
  for(const o of objs) h+=`<div class="obj s-${o.status}"><span class="obj-i">${icon(o.status)}</span>`+
    `<span class="obj-t ${o.main?"obj-main":""}">${esc(o.text)}</span></div>`;
  box.innerHTML=h;
}

// ── 情報 / 簡報（右欄，可摺疊）───────────────────────────────
function renderIntel(){
  const box=document.getElementById("intel-box"); if(!box) return;
  const intel=(state&&state.scenario.intel)||[]; const brief=state&&state.scenario.briefing;
  const fc=state&&state.scenario.forecast;
  if(!intel.length && !brief && !fc){ box.innerHTML=""; box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const wasCollapsed=box.classList.contains("collapsed");
  let h=`<div class="ib-head">情報 / 簡報 <span class="ib-caret">${wasCollapsed?"▸":"▾"}</span></div><div class="ib-body">`;
  if(brief) h+=`<div class="ib-brief">${esc(brief).replace(/\\n/g,"<br>")}</div>`;
  if(fc) h+=`<div class="ib-item"><div class="ib-time">天氣預報</div>${esc(fc)}</div>`;
  for(const it of intel) h+=`<div class="ib-item"><div class="ib-time">${esc(it.time)}</div>${esc(it.text)}</div>`;
  h+=`</div>`;
  box.innerHTML=h;
  box.querySelector(".ib-head").onclick=()=>box.classList.toggle("collapsed");
}

// ── 航線規劃（Web → 遊戲）────────────────────────────────
// 底部提示列（目前無模式，恆隱藏）
function updatePlanToolbar() { document.getElementById("plan-toolbar").className="hidden"; }

// ── 指令傳送（即時，無需批次送出）──────────────────────────
async function sendCmd(o){
  try{ await fetch("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});
    logLine(cmdDesc(o), "act"); }catch{ logLine("指令送出失敗（伺服器？）"); }
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
  case "attack": return `單位 ${u} 攻擊 ${o.target}${o.ammo?`（${o.ammo} ×${o.salvo||1}）`:""}`;
  case "select": return `遊戲鏡頭聚焦單位 ${u}`;
  case "relation": return o.value==="clear" ? `清除 ${o.target} 關係標記` : `標記 ${o.target} 為 ${o.value}`;
  case "identify": return `要求 ${u} 識別 ${o.target}`;
  default: return `指令 ${o.type}`; } }

// 讓遊戲畫面切到對應目標（比照遊戲點選單位 → 鏡頭跟隨）
function focusInGame(id){ sendCmd({type:"select",unit:id}); }

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
function hideContextMenu(){ document.getElementById("ctxmenu").className="hidden";
  if (weaponRingUnit){ weaponRingUnit=null; scheduleRender(); } }

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
// ── 下令（比照遊戲：右鍵敵方=選武器交戰、右鍵空海=移動）────────
function orderMove(selId, latlng, append){
  sendCmd({type:"waypoint",unit:selId,replace:!append,points:[{lat:latlng.lat,lon:latlng.lng}]}); }
// 武器類別（比照遊戲 Ammunition.Type）
const CATLBL={missile:"飛彈",torpedo:"魚雷",gun:"艦砲",bomb:"炸彈",asroc:"反潛火箭",rocket:"火箭",
  cluster:"集束彈",mlrs:"火箭炮",depthcharge:"深水炸彈",chaff:"干擾絲",noisemaker:"聲誘餌",
  sonobuoy:"聲納浮標",fueltank:"副油箱",decoy:"誘餌",paratrooper:"傘兵",other:"其他"};
const OFFENSIVE=new Set(["missile","torpedo","gun","bomb","asroc","rocket","cluster","mlrs","depthcharge"]);
function catLabel(a){
  let b=CATLBL[a.cat]||a.cat||"";
  if(a.cat==="missile"){ if(a.tt==="aaw")b="防空飛彈"; else if(a.tt==="asuw")b="反艦飛彈"; else if(a.tt==="asw")b="反潛飛彈"; }
  return b;
}
// 右鍵敵方的武器選單（比照遊戲 EngageWith）：只列「攻擊武器」中適用該目標的 + 齊射數
function weaponsFor(sel, target){
  const ammo = (sel.detail && sel.detail.ammo) || [];
  const need = target.domain==="air" ? "aaw" : (target.domain==="subsurface" ? "asw" : "asuw");
  const dist = nm(sel, target);
  const usable = ammo.filter(a => a.c>0 && OFFENSIVE.has(a.cat||"")     // 只留攻擊武器（排除干擾/浮標/油箱…）
    && (!a.tt || a.tt===need || a.tt2===need || a.cat==="gun"));
  if (!usable.length) return [{ label:"無可用於此目標的武器" }];
  return usable.map(a=>{
    const inRange = a.rmax ? (dist>=(a.rmin||0) && dist<=a.rmax) : true;
    const rng = a.rmax ? `${a.rmin>0.5?Math.round(a.rmin)+"-":""}${Math.round(a.rmax)} nm` : "";
    const salvos = [1,2,4].filter(s=>s<=a.c);
    return { label:`[${catLabel(a)}] ${a.dn||a.n} x${a.c}${rng?` · ${rng}`:""}${inRange?"":"（越界）"}`,
      sub: salvos.map(s=>({ label:`射 ${s} 發`,
        action:()=>sendCmd({type:"attack",unit:sel.id,target:target.id,ammo:a.n,salvo:s}) })) };
  });
}
// 敵/未知接觸的完整右鍵選單：交戰武器（需選己方）+ 標記關係/要求識別（免選單位）
function contactMenu(sel, target){
  const items = sel ? weaponsFor(sel, target).slice()
                    : [{label:"（左鍵選一個己方單位以交戰）"}];
  items.push({sep:true});
  items.push({label:"標記關係", sub:[      // 手動判定，不需選己方
    {label:"敵對", action:()=>sendCmd({type:"relation",target:target.id,value:"Hostile"})},
    {label:"中立", action:()=>sendCmd({type:"relation",target:target.id,value:"Neutral"})},
    {label:"友軍", action:()=>sendCmd({type:"relation",target:target.id,value:"Friendly"})},
    {label:"未知", action:()=>sendCmd({type:"relation",target:target.id,value:"Unknown"})},
    {label:"清除標記", action:()=>sendCmd({type:"relation",target:target.id,value:"clear"})},
  ]});
  if (!target.identified)
    items.push({label:"要求識別", action:()=>orderIdentify(target)});
  return items;
}
function nearestOwn(target){
  let best=null,bd=1e9;
  for(const c of state.scenario.contacts){ if(!c.own||c.destroyed) continue;
    const d=nm(c,target); if(d<bd){bd=d;best=c;} }
  return best;
}
// 要求識別：用已選己方，否則自動派最近的己方單位（免先選單位）
function orderIdentify(target){
  const u=state.scenario.contacts.find(c=>c.id===selectedId && c.own) || nearestOwn(target);
  if(!u){ logLine("沒有可派去識別的己方單位"); return; }
  sendCmd({type:"identify",unit:u.id,target:target.id});
}

// ── 即時資料（SSE 串流，狀態一到就套用；輪詢為後備）─────────────
let hadData = false;
let fitted = false;          // 是否已做過初始取景（等物件全部就定位=ready 才做）
function applyState(d) {
  const cs = (d.live && d.scenario && d.scenario.contacts) || [];
  if (cs.length) {                                   // 有任務單位 → 顯示
    live = true;
    const oldIds=new Set(state.scenario.contacts.map(c=>c.id));
    seenIds = oldIds;                                // 這批更新前就存在的接觸
    state.scenario.contacts = cs;
    if (d.scenario.name){ state.scenario.name=d.scenario.name;
      document.getElementById("mission-name").textContent=d.scenario.name; }
    Object.assign(state.scenario, {env:d.scenario.env, objectives:d.scenario.objectives,
      missionStatus:d.scenario.missionStatus, intel:d.scenario.intel, briefing:d.scenario.briefing,
      forecast:d.scenario.forecast, events:d.scenario.events});
    renderEnv(); renderObjectives(); renderIntel(); renderEvents();
    const newIds=new Set(cs.map(c=>c.id));
    let changed=oldIds.size!==newIds.size;
    if (!changed) for (const id of newIds) if (!oldIds.has(id)){ changed=true; break; }
    if (changed) buildUnitList();
    if (!hadData) logLine(`已連上遊戲即時戰況（接觸 ${cs.length}）`);
    // ready 只在「首次取景前」用來等待初始就定位；取景後就不再理它，
    // 免得任務中每次有新物件（發射的飛彈、起飛的機）短暫經過原點就跳回「初始化中」。
    if (!fitted) {
      if (d.scenario.ready===false) {
        showWaiting("任務初始化中…（單位就定位中）");
      } else {
        hideWaiting();
        fitToContacts(); const own=cs.find(c=>c.own);
        selectContact(own?own.id:cs[0].id); fitted=true;
      }
    } else {
      hideWaiting();
    }
    updateReadout();
    hadData = true;
    scheduleRender();
  } else {                                           // 無任務 → 空著
    live = false;
    if (hadData) logLine(d.live ? "任務單位已清空" : "與遊戲連線中斷");
    state.scenario.contacts = []; selectedId = null; hideContextMenu();
    Object.assign(state.scenario, {env:null, objectives:null, missionStatus:null,
      intel:null, briefing:null, forecast:null, events:null});
    renderEnv(); renderObjectives(); renderIntel(); renderEvents();
    buildUnitList(); updateReadout(); updatePlanToolbar();
    document.getElementById("mission-name").textContent = "—";
    showWaiting(d.live ? "已連線 · 等待任務單位…" : "等待遊戲連線…（請開啟 Sea Power 並進入任務）");
    hadData = false; fitted = false;
    scheduleRender();
  }
}
async function pollLive() {                       // 後備：沒有 SSE 時輪詢
  let d;
  try { d = await (await fetch("/api/state")).json(); } catch { return; }
  applyState(d);
}
function startLiveFeed() {
  if (!window.EventSource) { setInterval(pollLive, 200); return; }   // 舊瀏覽器 → 輪詢
  let es;
  try { es = new EventSource("/api/stream"); } catch { setInterval(pollLive, 200); return; }
  es.onmessage = ev => { try { applyState(JSON.parse(ev.data)); } catch {} };
  // EventSource 斷線會自動重連；伺服器心跳會在遊戲斷線時送 live:false
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
    if (best){ selectContact(best.id); buildUnitList(); focusInGame(best.id); }
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
    const sel = state.scenario.contacts.find(c=>c.id===selectedId && c.own);
    if (best && !best.own){                                                 // 敵/未知 → 交戰武器 + 標記/識別
      weaponRingUnit = sel || null; scheduleRender();                        // 有選己方才顯示射程環
      showContextMenu(e.containerPoint.x, e.containerPoint.y, contactName(best), contactMenu(sel, best));
      return; }
    if (!sel){ logLine("先左鍵選一個己方單位，再右鍵移動"); return; }         // 空海移動才需選己方
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
  addMsg("戰術顧問已就緒。開啟任務後可直接問我戰況分析、交戰建議、威脅評估等。（需先設定 Anthropic API 金鑰——見 README）","sys");

  setInterval(updateClock, 1000); updateClock();
  pollAiStatus(); setInterval(pollAiStatus, 5000);   // AI 狀態燈
  startLiveFeed();
  scheduleRender();
}
window.addEventListener("resize", sizeCanvas);
init();
