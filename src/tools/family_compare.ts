// Compare two render styles of the real part meshes, side by side:
//   (A) flat-shaded CAD look (two-sided Lambert)
//   (B) matcap "metal" look — smooth vertex normals sampled against a procedurally studio-lit metal
//       sphere, so highlights/reflections are baked in (photoreal-ish, still pure CPU — no GPU/Blender).
// Writes out/family-compare/<fam>_flat.png, <fam>_matcap.png, and _compare.png (flat | matcap per family).
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { highLODMesh } from "../geom/oio3d.ts";

const GEO = join(import.meta.dirname, "..", "..", "..", "virtual.USM-4", "co", "packages", "hallerpackage", "representation", "geometry");
const OUT = join(import.meta.dirname, "..", "..", "out", "family-compare");
const RES = 200, SS = 3, MARGIN = 0.14;
const BG: RGB = [243, 243, 246];
const MC = 256;   // matcap texture size

type V3 = [number, number, number];
type RGB = [number, number, number];
interface Spec { file: string; az: number; el: number; mat: RGB; glass?: boolean; holes?: boolean; flat?: boolean }
const M = (r: number, g: number, b: number): RGB => [r, g, b];
const FAMILIES: Record<string, Spec> = {
  tube:       { file: "rohr350.3d",              az: 26, el: 16, mat: M(150, 156, 165) },
  connector:  { file: "kugel.3d",                az: 24, el: 18, mat: M(142, 148, 158) },
  panel:      { file: "blech350_350.3d",         az: 30, el: 20, mat: M(182, 187, 195) },
  // perfblech's mesh is a hollow rim — render the SOLID panel and punch a hole grid into its face.
  perforated: { file: "blech350_350.3d",          az: 30, el: 20, mat: M(168, 173, 182), holes: true },
  glass:      { file: "glas350x350.3d",          az: 34, el: 22, mat: M(150, 205, 214), glass: true },
  door:       { file: "klapptuer350x350.3d",     az: 28, el: 16, mat: M(176, 181, 189) },
  drawer:     { file: "ausziehtablar500x350.3d", az: 28, el: 26, mat: M(170, 175, 184) },
  fitting:    { file: "glashalter.3d",           az: 30, el: 20, mat: M(196, 199, 205) },
  hardware:   { file: "griff_normal.3d",         az: 70, el: 14, mat: M(190, 194, 201), flat: true },
  support:    { file: "fussstuetze.3d",          az: 28, el: 18, mat: M(126, 132, 142) },
};

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
function rot(p: V3, az: number, el: number): V3 {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  const x1 = p[0] * Math.cos(a) + p[2] * Math.sin(a), z1 = -p[0] * Math.sin(a) + p[2] * Math.cos(a);
  return [x1, p[1] * Math.cos(e) - z1 * Math.sin(e), p[1] * Math.sin(e) + z1 * Math.cos(e)];
}

// procedural studio-lit metal matcap -> per-texel luminance L and white spec S
const matL = new Float32Array(MC * MC), matS = new Float32Array(MC * MC);
(function buildMatcap() {
  const key = norm([-0.35, 0.55, 0.78]), fill = norm([0.62, -0.15, 0.5]);
  for (let y = 0; y < MC; y++) for (let x = 0; x < MC; x++) {
    const nx = (x + 0.5) / MC * 2 - 1, ny = -((y + 0.5) / MC * 2 - 1), r2 = nx * nx + ny * ny;
    const i = y * MC + x;
    if (r2 > 1) { matL[i] = 0; matS[i] = 0; continue; }
    const nz = Math.sqrt(1 - r2); const N: V3 = [nx, ny, nz];
    const env = 0.46 + 0.42 * ny;                                  // sky-to-floor gradient
    const f = Math.max(0, dot(N, fill)) * 0.16;                    // soft fill
    const rim = Math.pow(1 - nz, 3.5) * 0.5;                       // fresnel edge
    matL[i] = clamp01(env * 0.72 + f + rim * 0.6);
    const d = Math.max(0, dot(N, key));
    matS[i] = Math.pow(d, 55) * 1.15 + Math.pow(d, 8) * 0.12;      // tight + broad highlight
  }
})();
function sampleMat(n: V3): [number, number] {
  const u = clamp01(n[0] * 0.5 + 0.5), v = clamp01(1 - (n[1] * 0.5 + 0.5));
  const i = (Math.min(MC - 1, (v * MC) | 0)) * MC + Math.min(MC - 1, (u * MC) | 0);
  return [matL[i], matS[i]];
}

// smooth world-space vertex normals
function vertexNormals(pos: number[][], tri: number[]): V3[] {
  const vn: V3[] = pos.map(() => [0, 0, 0]);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = pos[tri[t]] as V3, b = pos[tri[t + 1]] as V3, c = pos[tri[t + 2]] as V3;
    const fn = cross(sub(b, a), sub(c, a));
    for (const k of [tri[t], tri[t + 1], tri[t + 2]]) { vn[k][0] += fn[0]; vn[k][1] += fn[1]; vn[k][2] += fn[2]; }
  }
  return vn.map(norm);
}

const LIGHT = norm([-0.45, 0.65, 0.75]);

function render(spec: Spec, mode: "flat" | "matcap"): Uint8Array {
  const eff = spec.flat ? "flat" : mode;
  const mesh = highLODMesh(join(GEO, spec.file));
  const W = RES * SS, tri = mesh.triangles;
  const eye = mesh.positions.map((p) => rot(p as V3, spec.az, spec.el));
  const wvn = eff === "matcap" ? vertexNormals(mesh.positions, tri) : null;
  const evn = wvn ? wvn.map((n) => rot(n, spec.az, spec.el)) : null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of eye) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const span = Math.max(maxX - minX, maxY - minY) || 1, inner = W * (1 - 2 * MARGIN), pad = W * MARGIN;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = (x: number) => pad + ((x - cx) / span) * inner + inner / 2;
  const sy = (y: number) => pad - ((y - cy) / span) * inner + inner / 2;
  const col = new Float32Array(W * W * 3);
  for (let i = 0; i < W * W; i++) { col[i * 3] = BG[0]; col[i * 3 + 1] = BG[1]; col[i * 3 + 2] = BG[2]; }
  const zbuf = new Float32Array(W * W).fill(-Infinity);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const ia = tri[t], ib = tri[t + 1], ic = tri[t + 2];
    const ea = eye[ia], eb = eye[ib], ec = eye[ic]; if (!ea || !eb || !ec) continue;
    let fn = norm(cross(sub(eb, ea), sub(ec, ea))); if (fn[2] < 0) fn = [-fn[0], -fn[1], -fn[2]];
    let flatSh = 0.34 + 0.66 * Math.max(0, dot(fn, LIGHT)); flatSh += 0.18 * Math.pow(Math.max(0, dot(fn, LIGHT)), 18);
    const A = [sx(ea[0]), sy(ea[1]), ea[2]], B = [sx(eb[0]), sy(eb[1]), eb[2]], C = [sx(ec[0]), sy(ec[1]), ec[2]];
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(W - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(den) < 1e-9) continue;
    const na = evn ? evn[ia] : null, nb = evn ? evn[ib] : null, nc = evn ? evn[ic] : null;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w0 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den;
      const w1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den;
      const w2 = 1 - w0 - w1; if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const z = w0 * A[2] + w1 * B[2] + w2 * C[2], idx = y * W + x; if (z <= zbuf[idx]) continue; zbuf[idx] = z;
      let r: number, g: number, b: number;
      if (eff === "matcap" && na) {
        let n: V3 = [w0 * na[0] + w1 * nb![0] + w2 * nc![0], w0 * na[1] + w1 * nb![1] + w2 * nc![1], w0 * na[2] + w1 * nb![2] + w2 * nc![2]];
        n = norm(n); if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
        const [L, S] = sampleMat(n);
        r = spec.mat[0] * (0.28 + 0.85 * L) + 255 * S; g = spec.mat[1] * (0.28 + 0.85 * L) + 255 * S; b = spec.mat[2] * (0.28 + 0.85 * L) + 255 * S;
      } else { r = spec.mat[0] * flatSh; g = spec.mat[1] * flatSh; b = spec.mat[2] * flatSh; }
      col[idx * 3] = Math.min(255, r); col[idx * 3 + 1] = Math.min(255, g); col[idx * 3 + 2] = Math.min(255, b);
    }
  }
  if (spec.glass) for (let i = 0; i < W * W; i++) { if (zbuf[i] === -Infinity) continue; for (let k = 0; k < 3; k++) col[i * 3 + k] = col[i * 3 + k] * 0.62 + BG[k] * 0.38; }
  // perforation: darken a staggered hole grid over the rendered panel face (screen-space, clipped to foreground)
  if (spec.holes) {
    let fx0 = W, fy0 = W, fx1 = 0, fy1 = 0, any = false;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (zbuf[y * W + x] !== -Infinity) { any = true; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y; }
    if (any) {
      const cols = 7, rows = 7, bw = fx1 - fx0, bh = fy1 - fy0, r = Math.min(bw, bh) / (cols * 2.7);
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const hx = fx0 + bw * ((j + 0.5 + (i % 2 ? 0.5 : 0)) / cols), hy = fy0 + bh * ((i + 0.5) / rows);
        if (hx > fx1) continue;
        for (let y = Math.floor(hy - r); y <= Math.ceil(hy + r); y++) for (let x = Math.floor(hx - r); x <= Math.ceil(hx + r); x++) {
          if (x < 0 || y < 0 || x >= W || y >= W) continue; const idx = y * W + x; if (zbuf[idx] === -Infinity) continue;
          if ((x - hx) ** 2 + (y - hy) ** 2 <= r * r) { col[idx * 3] *= 0.4; col[idx * 3 + 1] *= 0.4; col[idx * 3 + 2] *= 0.42; }
        }
      }
    }
  }
  const tile = new Uint8Array(RES * RES * 3);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) { const s = ((y * SS + dy) * W + x * SS + dx) * 3; r += col[s]; g += col[s + 1]; b += col[s + 2]; }
    const o = (y * RES + x) * 3, k = SS * SS; tile[o] = r / k; tile[o + 1] = g / k; tile[o + 2] = b / k;
  }
  return tile;
}

// ---- PNG ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (ty: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
function rgbPNG(buf: Uint8Array, w: number, h: number) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = buf[y * w * 3 + x]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const blit = (dst: Uint8Array, DW: number, tile: Uint8Array, ox: number, oy: number) => {
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) { const s = (y * RES + x) * 3, d = ((oy + y) * DW + ox + x) * 3; dst[d] = tile[s]; dst[d + 1] = tile[s + 1]; dst[d + 2] = tile[s + 2]; }
};

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const names = argv.filter((a) => !a.startsWith("--")).length ? argv.filter((a) => !a.startsWith("--")) : Object.keys(FAMILIES);
mkdirSync(OUT, { recursive: true });
console.log(`flat vs matcap for ${names.length} families -> ${OUT}`);
const rows: { name: string; flat: Uint8Array; mat: Uint8Array }[] = [];
for (const n of names) {
  const spec = FAMILIES[n]; if (!spec) continue;
  const flat = render(spec, "flat"), mat = render(spec, "matcap");
  writeFileSync(join(OUT, n + "_flat.png"), rgbPNG(flat, RES, RES));
  writeFileSync(join(OUT, n + "_matcap.png"), rgbPNG(mat, RES, RES));
  rows.push({ name: n, flat, mat }); console.log(`  ${n}`);
}
// comparison sheet: 2 families per row, each as [flat | matcap]
const perRow = 2, gap = 10, group = 6;
const cols = perRow * 2, sheetRows = Math.ceil(rows.length / perRow);
const SW = cols * RES + (perRow + 1) * gap + perRow * group, SH = sheetRows * RES + (sheetRows + 1) * gap;
const sheet = new Uint8Array(SW * SH * 3).fill(255);
rows.forEach((it, k) => {
  const r = (k / perRow) | 0, cIn = k % perRow;
  const oy = gap + r * (RES + gap);
  const ox = gap + cIn * (2 * RES + group + gap);
  blit(sheet, SW, it.flat, ox, oy); blit(sheet, SW, it.mat, ox + RES + group, oy);
});
writeFileSync(join(OUT, "_compare.png"), rgbPNG(sheet, SW, SH));
console.log(`\ncompare sheet -> out/family-compare/_compare.png  (each pair: FLAT | MATCAP; order ${rows.map((r) => r.name).join(", ")})`);

// final chosen style: matcap-only contact sheet, 5 per row
const fc = 5, fr = Math.ceil(rows.length / fc), fg = 12;
const FW = fc * RES + (fc + 1) * fg, FH = fr * RES + (fr + 1) * fg;
const fin = new Uint8Array(FW * FH * 3).fill(255);
rows.forEach((it, k) => blit(fin, FW, it.mat, fg + (k % fc) * (RES + fg), fg + ((k / fc) | 0) * (RES + fg)));
writeFileSync(join(OUT, "_final.png"), rgbPNG(fin, FW, FH));
console.log(`final (matcap) -> out/family-compare/_final.png  (order ${rows.map((r) => r.name).join(", ")})`);

// ---- transparent RGBA export at icon sizes, straight into the iOS asset catalog ----
function renderRGBA(spec: Spec, TR: number): Uint8Array {
  const eff = spec.flat ? "flat" : "matcap";
  const mesh = highLODMesh(join(GEO, spec.file)); const W = TR * SS, tri = mesh.triangles;
  const eye = mesh.positions.map((p) => rot(p as V3, spec.az, spec.el));
  const evn = eff === "matcap" ? vertexNormals(mesh.positions, tri).map((n) => rot(n, spec.az, spec.el)) : null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of eye) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const span = Math.max(maxX - minX, maxY - minY) || 1, inner = W * (1 - 2 * MARGIN), pad = W * MARGIN;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = (x: number) => pad + ((x - cx) / span) * inner + inner / 2, sy = (y: number) => pad - ((y - cy) / span) * inner + inner / 2;
  const col = new Float32Array(W * W * 3), cov = new Uint8Array(W * W), zbuf = new Float32Array(W * W).fill(-Infinity);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const ia = tri[t], ib = tri[t + 1], ic = tri[t + 2], ea = eye[ia], eb = eye[ib], ec = eye[ic]; if (!ea || !eb || !ec) continue;
    let fn = norm(cross(sub(eb, ea), sub(ec, ea))); if (fn[2] < 0) fn = [-fn[0], -fn[1], -fn[2]];
    const fl = 0.34 + 0.66 * Math.max(0, dot(fn, LIGHT)) + 0.18 * Math.pow(Math.max(0, dot(fn, LIGHT)), 18);
    const A = [sx(ea[0]), sy(ea[1]), ea[2]], B = [sx(eb[0]), sy(eb[1]), eb[2]], C = [sx(ec[0]), sy(ec[1]), ec[2]];
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(W - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(den) < 1e-9) continue;
    const na = evn ? evn[ia] : null, nb = evn ? evn[ib] : null, nc = evn ? evn[ic] : null;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w0 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den, w1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den, w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const z = w0 * A[2] + w1 * B[2] + w2 * C[2], idx = y * W + x; if (z <= zbuf[idx]) continue; zbuf[idx] = z; cov[idx] = 1;
      let r: number, g: number, b: number;
      if (eff === "matcap" && na) {
        let n: V3 = norm([w0 * na[0] + w1 * nb![0] + w2 * nc![0], w0 * na[1] + w1 * nb![1] + w2 * nc![1], w0 * na[2] + w1 * nb![2] + w2 * nc![2]]);
        if (n[2] < 0) n = [-n[0], -n[1], -n[2]]; const [L, S] = sampleMat(n);
        r = spec.mat[0] * (0.28 + 0.85 * L) + 255 * S; g = spec.mat[1] * (0.28 + 0.85 * L) + 255 * S; b = spec.mat[2] * (0.28 + 0.85 * L) + 255 * S;
      } else { r = spec.mat[0] * fl; g = spec.mat[1] * fl; b = spec.mat[2] * fl; }
      col[idx * 3] = Math.min(255, r); col[idx * 3 + 1] = Math.min(255, g); col[idx * 3 + 2] = Math.min(255, b);
    }
  }
  if (spec.holes) {
    let fx0 = W, fy0 = W, fx1 = 0, fy1 = 0, any = false;
    for (let i = 0; i < W * W; i++) if (cov[i]) { any = true; const x = i % W, y = (i / W) | 0; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y; }
    if (any) { const cc = 7, rr = 7, bw = fx1 - fx0, bh = fy1 - fy0, r = Math.min(bw, bh) / (cc * 2.7);
      for (let i = 0; i < rr; i++) for (let j = 0; j < cc; j++) { const hx = fx0 + bw * ((j + 0.5 + (i % 2 ? 0.5 : 0)) / cc), hy = fy0 + bh * ((i + 0.5) / rr); if (hx > fx1) continue;
        for (let y = Math.floor(hy - r); y <= Math.ceil(hy + r); y++) for (let x = Math.floor(hx - r); x <= Math.ceil(hx + r); x++) { if (x < 0 || y < 0 || x >= W || y >= W) continue; const idx = y * W + x; if (!cov[idx]) continue; if ((x - hx) ** 2 + (y - hy) ** 2 <= r * r) { col[idx * 3] *= 0.4; col[idx * 3 + 1] *= 0.4; col[idx * 3 + 2] *= 0.42; } } } }
  }
  const out = new Uint8Array(TR * TR * 4), k = SS * SS, ga = spec.glass ? 0.8 : 1;
  for (let y = 0; y < TR; y++) for (let x = 0; x < TR; x++) {
    let r = 0, g = 0, b = 0, c = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) { const si = (y * SS + dy) * W + x * SS + dx; if (!cov[si]) continue; c++; r += col[si * 3]; g += col[si * 3 + 1]; b += col[si * 3 + 2]; }
    const o = (y * TR + x) * 4;
    if (c) { out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c; out[o + 3] = Math.round((c / k) * 255 * ga); } else { out[o + 3] = 0; }
  }
  return out;
}
function rgbaPNG(buf: Uint8Array, w: number, h: number) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = buf[y * w * 4 + x]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
if (flags.includes("--export")) {
  const XC = join(import.meta.dirname, "..", "..", "..", "usm-configurator-ios", "Resources", "Assets.xcassets");
  mkdirSync(XC, { recursive: true });
  writeFileSync(join(XC, "Contents.json"), JSON.stringify({ info: { version: 1, author: "xcode" } }, null, 2));
  const base = 36;   // 1x = 36pt → 36/72/108 px
  for (const name of names) {
    const spec = FAMILIES[name]; if (!spec) continue;
    const dir = join(XC, `family-${name}.imageset`); mkdirSync(dir, { recursive: true });
    [1, 2, 3].forEach((s) => writeFileSync(join(dir, `icon${s === 1 ? "" : "@" + s + "x"}.png`), rgbaPNG(renderRGBA(spec, base * s), base * s, base * s)));
    writeFileSync(join(dir, "Contents.json"), JSON.stringify({
      images: [1, 2, 3].map((s) => ({ idiom: "universal", filename: `icon${s === 1 ? "" : "@" + s + "x"}.png`, scale: `${s}x` })),
      info: { version: 1, author: "xcode" }, properties: { "template-rendering-intent": "original" },
    }, null, 2));
    console.log(`  exported family-${name}.imageset`);
  }
  console.log(`\nassets -> usm-configurator-ios/Resources/Assets.xcassets/family-*.imageset`);
}
