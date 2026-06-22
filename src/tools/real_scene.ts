// Off-device proof: render the solved scene with the REAL part meshes (not primitives), placed at the
// payload's RealityKit transforms. Joins out/placement.json (internal type per id) with the customer
// payload (id -> pos/quat/family, metres), pulls each mesh from the running engine's /api/mesh, scales
// mm->m, applies the same quat the app uses, and z-buffer renders. Shows what the app looks like once
// SceneBuilder loads real meshes instead of boxes/spheres.
//
//   (engine server must be running on :5152)
//   node src/tools/real_scene.ts [payload.json] [az] [el]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

type V3 = [number, number, number];
type RGB = [number, number, number];
const OUT = join(import.meta.dirname, "..", "..", "out", "scene-preview");
const RES = 1000, SS = 2, MARGIN = 0.06;
const BG: RGB = [244, 244, 247];
const FAM: Record<string, RGB> = {
  connector: [150, 156, 165], tube: [168, 176, 191], panel: [188, 192, 200], support: [120, 96, 60],
  hardware: [150, 160, 180], glass: [120, 200, 212], door: [210, 180, 90], drawer: [205, 178, 96],
  fitting: [188, 192, 200], other: [150, 160, 180],
};
const colorOf = (f: string) => FAM[f] ?? [150, 160, 180];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function qrot(q: number[], v: V3): V3 {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const file = process.argv[2] ?? join(import.meta.dirname, "..", "..", "out", "sess_probe.json");
const az = Number(process.argv[3] ?? 35), el = Number(process.argv[4] ?? 18);
const payload = JSON.parse(readFileSync(file, "utf8"));
const placement = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "out", "placement.json"), "utf8"));
const typeById = new Map<string, string>(placement.parts.map((p: any) => [String(p.id), p.type]));

interface Tri { a: V3; b: V3; c: V3; col: RGB }
const tris: Tri[] = [];
const meshCache = new Map<string, { positions: number[][]; triangles: number[] } | null>();

async function meshFor(type: string) {
  if (meshCache.has(type)) return meshCache.get(type);
  let m: any = null;
  try { const r = await fetch(`http://localhost:5152/api/mesh?name=${encodeURIComponent(type)}`); const j = await r.json(); if (j.positions && j.triangles) m = j; } catch {}
  meshCache.set(type, m); return m;
}

const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = payload.parts;
let placedReal = 0, fallback = 0;
for (const p of list) {
  const type = typeById.get(String(p.id)); const col = colorOf(p.family);
  const mesh = type ? await meshFor(type) : null;
  const pos = p.pos as V3, q = p.quat ?? [0, 0, 0, 1];
  // per-asset meshCorrection: rohr's native long-axis is Y, but the quat assumes Z — rotate +90° about
  // X (y->z) so the tube aligns. (This is the calibration PART_MANIFEST flags per asset.)
  const fixRohr = /^rohr/.test(type ?? "");
  if (mesh && mesh.positions.length) {
    placedReal++;
    const W = mesh.positions.map((v: number[]) => {
      let lv: V3 = [v[0] * 0.001, v[1] * 0.001, v[2] * 0.001];
      if (fixRohr) lv = [lv[0], -lv[2], lv[1]];
      const r = qrot(q, lv); return [r[0] + pos[0], r[1] + pos[1], r[2] + pos[2]] as V3;
    });
    const t = mesh.triangles;
    for (let i = 0; i + 2 < t.length; i += 3) { const a = W[t[i]], b = W[t[i + 1]], c = W[t[i + 2]]; if (a && b && c) tris.push({ a, b, c, col }); }
  } else { fallback++; }
}

// ---- render (orbit eye space, z-buffer, flat Lambert, supersample) — same as scene_preview ----
function rotEye(p: V3): V3 {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  const x1 = p[0] * Math.cos(a) + p[2] * Math.sin(a), z1 = -p[0] * Math.sin(a) + p[2] * Math.cos(a);
  return [x1, p[1] * Math.cos(e) - z1 * Math.sin(e), p[1] * Math.sin(e) + z1 * Math.cos(e)];
}
const LIGHT = norm([-0.4, 0.7, 0.6]);
function render(): Uint8Array {
  const W = RES * SS;
  const E = tris.map((t) => ({ a: rotEye(t.a), b: rotEye(t.b), c: rotEye(t.c), col: t.col }));
  let lo = [1e9, 1e9], hi = [-1e9, -1e9];
  for (const t of E) for (const v of [t.a, t.b, t.c]) { lo[0] = Math.min(lo[0], v[0]); lo[1] = Math.min(lo[1], v[1]); hi[0] = Math.max(hi[0], v[0]); hi[1] = Math.max(hi[1], v[1]); }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) || 1, inner = W * (1 - 2 * MARGIN), pad = W * MARGIN;
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  const sx = (x: number) => pad + ((x - cx) / span) * inner + inner / 2, sy = (y: number) => pad - ((y - cy) / span) * inner + inner / 2;
  const col = new Float32Array(W * W * 3); for (let i = 0; i < W * W; i++) { col[i * 3] = BG[0]; col[i * 3 + 1] = BG[1]; col[i * 3 + 2] = BG[2]; }
  const zb = new Float32Array(W * W).fill(-Infinity);
  for (const t of E) {
    let n = norm(cross(sub(t.b, t.a), sub(t.c, t.a))); if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
    const sh = 0.36 + 0.64 * Math.max(0, dot(n, LIGHT));
    const A = [sx(t.a[0]), sy(t.a[1]), t.a[2]], B = [sx(t.b[0]), sy(t.b[1]), t.b[2]], C = [sx(t.c[0]), sy(t.c[1]), t.c[2]];
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(W - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(den) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w0 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den, w1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den, w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const z = w0 * A[2] + w1 * B[2] + w2 * C[2], idx = y * W + x; if (z <= zb[idx]) continue; zb[idx] = z;
      col[idx * 3] = Math.min(255, t.col[0] * sh); col[idx * 3 + 1] = Math.min(255, t.col[1] * sh); col[idx * 3 + 2] = Math.min(255, t.col[2] * sh);
    }
  }
  const out = new Uint8Array(RES * RES * 3);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    let r = 0, g = 0, b = 0; for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) { const s = ((y * SS + dy) * W + x * SS + dx) * 3; r += col[s]; g += col[s + 1]; b += col[s + 2]; }
    const o = (y * RES + x) * 3, k = SS * SS; out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k;
  }
  return out;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (ty: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
function png(buf: Uint8Array, w: number, h: number) { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = buf[y * w * 3 + x]; } const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }

mkdirSync(OUT, { recursive: true });
console.log(`real-mesh scene: ${list.length} parts, ${placedReal} with real mesh, ${fallback} no-mesh -> ${tris.length} tris`);
writeFileSync(join(OUT, "real.png"), png(render(), RES, RES));
console.log(`-> out/scene-preview/real.png  (az=${az} el=${el})`);
