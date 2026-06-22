// Realistic family thumbnails: a software-shaded 3D render of each REAL part mesh (use-approved).
// Per family we load a representative .3d, transform into eye space (3/4 view), z-buffer rasterize with
// two-sided Lambert shading + a per-family material, supersample for clean edges, and write a PNG. A
// contact sheet is composed for QA. No GPU — a tiny CPU rasterizer.
//
//   node src/tools/family_renders.ts            # all -> out/family-renders/*.png + _sheet.png
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { highLODMesh } from "../geom/oio3d.ts";

const GEO = join(import.meta.dirname, "..", "..", "..", "virtual.USM-4", "co", "packages", "hallerpackage", "representation", "geometry");
const OUT = join(import.meta.dirname, "..", "..", "out", "family-renders");
const RES = 200, SS = 3, MARGIN = 0.14;       // tile px, supersample, empty frame fraction
const BG: RGB = [243, 243, 246];

type V3 = [number, number, number];
type RGB = [number, number, number];
interface Spec { file: string; az: number; el: number; mat: RGB; glass?: boolean }

const M = (r: number, g: number, b: number): RGB => [r, g, b];
const FAMILIES: Record<string, Spec> = {
  tube:       { file: "rohr350.3d",              az: 26, el: 16, mat: M(150, 156, 165) },
  connector:  { file: "kugel.3d",                az: 24, el: 18, mat: M(142, 148, 158) },
  panel:      { file: "blech350_350.3d",         az: 30, el: 20, mat: M(182, 187, 195) },
  perforated: { file: "perfblech350x350.3d",     az: 30, el: 20, mat: M(168, 173, 182) },
  glass:      { file: "glas350x350.3d",          az: 34, el: 22, mat: M(120, 200, 212), glass: true },
  door:       { file: "klapptuer350x350.3d",     az: 28, el: 16, mat: M(176, 181, 189) },
  drawer:     { file: "ausziehtablar500x350.3d", az: 28, el: 26, mat: M(170, 175, 184) },
  fitting:    { file: "glashalter.3d",           az: 30, el: 20, mat: M(196, 199, 205) },
  hardware:   { file: "griff_normal.3d",         az: 70, el: 14, mat: M(190, 194, 201) },
  support:    { file: "fussstuetze.3d",          az: 28, el: 18, mat: M(126, 132, 142) },
};

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// rotate world -> eye (camera at +Z looking toward -Z): Ry(az) then Rx(el)
function toEye(p: V3, az: number, el: number): V3 {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  const x1 = p[0] * Math.cos(a) + p[2] * Math.sin(a);
  const z1 = -p[0] * Math.sin(a) + p[2] * Math.cos(a);
  const y2 = p[1] * Math.cos(e) - z1 * Math.sin(e);
  const z2 = p[1] * Math.sin(e) + z1 * Math.cos(e);
  return [x1, y2, z2];
}

const LIGHT = norm([-0.45, 0.65, 0.75]);

// render one family into an RES×RES RGB tile (supersampled internally)
function render(spec: Spec): Uint8Array {
  const mesh = highLODMesh(join(GEO, spec.file));
  const W = RES * SS;
  const eye = mesh.positions.map((p) => toEye(p as V3, spec.az, spec.el));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of eye) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const inner = W * (1 - 2 * MARGIN), pad = W * MARGIN;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = (x: number) => pad + ((x - cx) / span) * inner + inner / 2;
  const sy = (y: number) => pad - ((y - cy) / span) * inner + inner / 2;   // flip Y (upright)

  const col = new Float32Array(W * W * 3);
  for (let i = 0; i < W * W; i++) { col[i * 3] = BG[0]; col[i * 3 + 1] = BG[1]; col[i * 3 + 2] = BG[2]; }
  const zbuf = new Float32Array(W * W).fill(-Infinity);
  const tri = mesh.triangles;
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const ea = eye[tri[t]], eb = eye[tri[t + 1]], ec = eye[tri[t + 2]];
    if (!ea || !eb || !ec) continue;
    let n = norm(cross(sub(eb, ea), sub(ec, ea)));
    if (n[2] < 0) n = [-n[0], -n[1], -n[2]];                 // two-sided
    const lambert = Math.max(0, dot(n, LIGHT));
    let sh = 0.34 + 0.66 * lambert;                          // ambient + diffuse
    sh += 0.18 * Math.pow(lambert, 18);                      // soft highlight
    const A = [sx(ea[0]), sy(ea[1]), ea[2]], B = [sx(eb[0]), sy(eb[1]), eb[2]], C = [sx(ec[0]), sy(ec[1]), ec[2]];
    // bbox + barycentric fill with z-interpolation
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(W - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(den) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w0 = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den;
      const w1 = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
      const idx = y * W + x;
      if (z <= zbuf[idx]) continue;
      zbuf[idx] = z;
      col[idx * 3] = Math.min(255, spec.mat[0] * sh);
      col[idx * 3 + 1] = Math.min(255, spec.mat[1] * sh);
      col[idx * 3 + 2] = Math.min(255, spec.mat[2] * sh);
    }
  }
  // glass: lighten toward background for a translucent read
  if (spec.glass) for (let i = 0; i < W * W; i++) { if (zbuf[i] === -Infinity) continue; for (let k = 0; k < 3; k++) col[i * 3 + k] = col[i * 3 + k] * 0.6 + BG[k] * 0.4; }

  // downsample SS×SS box filter -> RES tile
  const tile = new Uint8Array(RES * RES * 3);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) { const s = ((y * SS + dy) * W + x * SS + dx) * 3; r += col[s]; g += col[s + 1]; b += col[s + 2]; }
    const o = (y * RES + x) * 3, k = SS * SS; tile[o] = r / k; tile[o + 1] = g / k; tile[o + 2] = b / k;
  }
  return tile;
}

// ---- PNG ----
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function rgbPNG(buf: Uint8Array, w: number, h: number) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = buf[y * w * 3 + x]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(FAMILIES);
mkdirSync(OUT, { recursive: true });
console.log(`rendering ${names.length} family thumbnail(s) -> ${OUT}`);
const tiles: { name: string; tile: Uint8Array }[] = [];
for (const n of names) {
  const spec = FAMILIES[n]; if (!spec) { console.log(`  ${n}: no spec`); continue; }
  try { const tile = render(spec); writeFileSync(join(OUT, n + ".png"), rgbPNG(tile, RES, RES)); tiles.push({ name: n, tile }); console.log(`  ${n.padEnd(11)} ${spec.file}`); }
  catch (e: any) { console.log(`  ${n}: ERROR ${e?.message ?? e}`); }
}
// contact sheet
const cols = 5, rows = Math.ceil(tiles.length / cols), gap = 12;
const SW = cols * RES + (cols + 1) * gap, SH = rows * RES + (rows + 1) * gap;
const sheet = new Uint8Array(SW * SH * 3);
for (let i = 0; i < SW * SH; i++) { sheet[i * 3] = 255; sheet[i * 3 + 1] = 255; sheet[i * 3 + 2] = 255; }
tiles.forEach((it, k) => {
  const ox = gap + (k % cols) * (RES + gap), oy = gap + ((k / cols) | 0) * (RES + gap);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) { const s = (y * RES + x) * 3, d = ((oy + y) * SW + ox + x) * 3; sheet[d] = it.tile[s]; sheet[d + 1] = it.tile[s + 1]; sheet[d + 2] = it.tile[s + 2]; }
});
writeFileSync(join(OUT, "_sheet.png"), rgbPNG(sheet, SW, SH));
console.log(`\nsheet -> out/family-renders/_sheet.png  (order: ${tiles.map((t) => t.name).join(", ")})`);
