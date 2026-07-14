// 把 land-10m.geojson 用 RDP 簡化（保留海岸輪廓、大幅減少點數）→ 高效向量底圖
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "public/vendor/land-10m.geojson";
const OUT = "public/vendor/land-simplified.geojson";
const TOL = parseFloat(process.argv[2] || "0.008"); // 容差(度)，~0.9km

// 迭代式 RDP（避免長環遞迴爆堆疊）；經緯度當平面處理即可
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [s, e] = stack.pop();
    let dmax = -1, idx = -1;
    const [x1, y1] = pts[s], [x2, y2] = pts[e];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      let d2;
      if (len2 === 0) { const ax = px - x1, ay = py - y1; d2 = ax * ax + ay * ay; }
      else {
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = x1 + t * dx, cy = y1 + t * dy, ax = px - cx, ay = py - cy;
        d2 = ax * ax + ay * ay;
      }
      if (d2 > dmax) { dmax = d2; idx = i; }
    }
    if (dmax > eps2 && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function simplifyRing(ring) {
  const r = rdp(ring, TOL);
  return r.length >= 4 ? r : ring.length >= 4 ? ring : null; // 環至少 4 點才有效
}
function simplifyGeom(geom) {
  if (geom.type === "Polygon")
    geom.coordinates = geom.coordinates.map(simplifyRing).filter(Boolean);
  else if (geom.type === "MultiPolygon")
    geom.coordinates = geom.coordinates
      .map(poly => poly.map(simplifyRing).filter(Boolean))
      .filter(poly => poly.length);
  return geom;
}

function count(c) { if (!c) return 0; if (typeof c[0] === "number") return 1; return c.reduce((s, x) => s + count(x), 0); }

const gj = JSON.parse(readFileSync(SRC, "utf8"));
let before = 0, after = 0;
for (const f of gj.features) {
  before += count(f.geometry.coordinates);
  simplifyGeom(f.geometry);
  f.properties = null;
  after += count(f.geometry.coordinates);
}
writeFileSync(OUT, JSON.stringify(gj));
const sz = readFileSync(OUT).length;
console.log(`容差 ${TOL}°  點數 ${before} → ${after} (${(100 * after / before).toFixed(1)}%)  檔案 ${(sz / 1048576).toFixed(2)} MB`);
