// Family icons traced from the REAL part meshes (use-approved). For each one52 family we pick a
// representative .3d part, orthographically project it (3/4 view), rasterize the triangle fill to an
// occupancy grid, trace the pixel boundary into closed loops, simplify (Douglas–Peucker), and emit a
// 24×24 `currentColor` SVG. A grayscale preview PNG is written alongside for visual QA.
//
//   node src/tools/family_icons.ts            # all families -> out/family-icons/*.svg + *.png
//   node src/tools/family_icons.ts tube glass  # only these
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { highLODMesh } from "../geom/oio3d.ts";

const GEO = join(import.meta.dirname, "..", "..", "..", "virtual.USM-4", "co", "packages", "hallerpackage", "representation", "geometry");
const OUT = join(import.meta.dirname, "..", "..", "out", "family-icons");
const RES = 220;        // raster resolution
const MARGIN = 0.10;    // fraction of frame kept empty around the silhouette
const VIEW = 24;        // SVG viewBox size

// family -> representative mesh + 3/4 view angles (azimuth around Y, elevation around X), in degrees.
// Angles are tuned after inspecting the preview PNGs so each silhouette reads as the real part.
interface Spec { file: string; az: number; el: number; holes?: boolean }
const FAMILIES: Record<string, Spec> = {
  tube:       { file: "rohr350.3d",          az: 28, el: 18 },
  connector:  { file: "kugel.3d",            az: 25, el: 20 },
  panel:      { file: "blech350_350.3d",     az: 32, el: 22 },
  // perfblech's mesh is a hollow frame — trace the SOLID panel silhouette and punch a hole grid instead.
  perforated: { file: "blech350_350.3d",     az: 32, el: 22, holes: true },
  glass:      { file: "glas350x350.3d",      az: 35, el: 24 },
  door:       { file: "klapptuer350x350.3d", az: 22, el: 10 },
  drawer:     { file: "ausziehtablar500x350.3d", az: 30, el: 30 },
  fitting:    { file: "glashalter.3d",       az: 30, el: 20 },
  hardware:   { file: "griff_normal.3d",     az: 80, el: 12 },
  support:    { file: "fussstuetze.3d",      az: 28, el: 18 },
};

type V3 = [number, number, number];

// family tint (mirrors FamilyPalette.rgb in the iOS app) — for the contact-sheet preview only
const COLORS: Record<string, [number, number, number]> = {
  tube: [168, 176, 191], connector: [138, 148, 166], panel: [199, 204, 214], perforated: [179, 184, 196],
  glass: [79, 209, 224], door: [255, 209, 102], drawer: [255, 209, 102], fitting: [255, 181, 84],
  hardware: [153, 163, 184], support: [122, 92, 59],
};
const SHEET: { name: string; loops01: number[][][] }[] = [];   // collected finished icons (normalized) for the preview

// orthographic 3/4 projection -> screen [x, y] (y up), depth ignored (silhouette only)
function project(p: V3, az: number, el: number): [number, number] {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  const x1 = p[0] * Math.cos(a) + p[2] * Math.sin(a);
  const z1 = -p[0] * Math.sin(a) + p[2] * Math.cos(a);
  const y2 = p[1] * Math.cos(e) - z1 * Math.sin(e);
  return [x1, y2];
}

// fill one projected triangle into the occupancy grid (scanline)
function fillTri(grid: Uint8Array, w: number, h: number, A: number[], B: number[], C: number[]) {
  const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1])));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
  const edge = (p: number[], q: number[], y: number): number | null => {
    if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) return p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]);
    return null;
  };
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (const [p, q] of [[A, B], [B, C], [C, A]] as const) { const x = edge(p, q, yc); if (x != null) xs.push(x); }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) grid[y * w + x] = 1;
    }
  }
}

// trace the boundary unit-edges of the occupancy grid into closed corner loops (interior on a
// consistent side). Even-odd fill handles holes (e.g. perforation) automatically.
function traceLoops(grid: Uint8Array, w: number, h: number): number[][][] {
  const occ = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && grid[y * w + x] === 1;
  const key = (x: number, y: number) => x * (h + 2) + y;
  const next = new Map<number, [number, number]>();   // corner -> corner (directed boundary edge)
  const add = (ax: number, ay: number, bx: number, by: number) => next.set(key(ax, ay), [bx, by]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!occ(x, y)) continue;
    if (!occ(x, y - 1)) add(x, y, x + 1, y);           // top    (CW, image y-down)
    if (!occ(x + 1, y)) add(x + 1, y, x + 1, y + 1);   // right
    if (!occ(x, y + 1)) add(x + 1, y + 1, x, y + 1);   // bottom
    if (!occ(x - 1, y)) add(x, y + 1, x, y);           // left
  }
  const loops: number[][][] = [];
  const seen = new Set<number>();
  for (const [start] of next) {
    if (seen.has(start)) continue;
    const loop: number[][] = [];
    let cur = start, guard = 0;
    while (guard++ < w * h * 4) {
      seen.add(cur);
      const sx = Math.floor(cur / (h + 2)), sy = cur % (h + 2);
      loop.push([sx, sy]);
      const nx = next.get(cur); if (!nx) break;
      const nk = key(nx[0], nx[1]);
      if (nk === start) break;
      cur = nk;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// Douglas–Peucker on a closed loop
function simplify(pts: number[][], eps: number): number[][] {
  if (pts.length < 4) return pts;
  const d2 = (p: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1e-9;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L;
    const cx = a[0] + t * dx, cy = a[1] + t * dy;
    return (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
  };
  const rec = (s: number, e: number, keep: boolean[]) => {
    let idx = -1, max = eps * eps;
    for (let i = s + 1; i < e; i++) { const d = d2(pts[i], pts[s], pts[e]); if (d > max) { max = d; idx = i; } }
    if (idx >= 0) { keep[idx] = true; rec(s, idx, keep); rec(idx, e, keep); }
  };
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  rec(0, pts.length - 1, keep);
  return pts.filter((_, i) => keep[i]);
}

// ---- minimal grayscale PNG (for QA preview) ----
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function grayPNG(grid: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = grid[y * w + x] ? 235 : 28; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function rgbPNG(buf: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = buf[y * w * 3 + x]; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// even-odd scanline fill of normalized [0..1] loops into a tile of `buf` at (ox,oy), tinted `rgb`
function fillTile(buf: Uint8Array, W: number, ox: number, oy: number, size: number, pad: number, loops01: number[][][], rgb: number[]) {
  const draw = size - 2 * pad;
  const polys = loops01.map((l) => l.map(([x, y]) => [pad + x * draw, pad + y * draw]));
  for (let py = 0; py < size; py++) {
    const yc = py + 0.5;
    const xs: number[] = [];
    for (const poly of polys) for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(size - 1, Math.floor(xs[k + 1]));
      for (let px = x0; px <= x1; px++) { const o = ((oy + py) * W + ox + px) * 3; buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; }
    }
  }
}
// lay every finished icon on a dark card grid (the app canvas tone) and write one preview PNG
function renderSheet() {
  if (!SHEET.length) return;
  const cols = 5, rows = Math.ceil(SHEET.length / cols), tile = 190, gap = 16, pad = 30;
  const W = cols * tile + (cols + 1) * gap, H = rows * tile + (rows + 1) * gap;
  const buf = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) buf[i] = 244;                                   // light page
  SHEET.forEach((it, k) => {
    const cx = k % cols, cy = (k / cols) | 0;
    const ox = gap + cx * (tile + gap), oy = gap + cy * (tile + gap);
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {                    // white card + grey frame
      const edge = x < 2 || y < 2 || x >= tile - 2 || y >= tile - 2;
      const o = ((oy + y) * W + ox + x) * 3; const v = edge ? 200 : 255; buf[o] = v; buf[o + 1] = v; buf[o + 2] = v;
    }
    fillTile(buf, W, ox, oy, tile, pad, it.loops01, [32, 32, 36]);                     // dark silhouette (shape clarity)
  });
  writeFileSync(join(OUT, "_contact-sheet.png"), rgbPNG(buf, W, H));
  console.log(`\ncontact sheet -> out/family-icons/_contact-sheet.png  (order: ${SHEET.map((s) => s.name).join(", ")})`);
}

function makeIcon(name: string, spec: Spec) {
  const mesh = highLODMesh(join(GEO, spec.file));
  if (!mesh.positions.length || !mesh.triangles.length) { console.log(`  ${name}: EMPTY mesh (${spec.file})`); return; }
  const scr = mesh.positions.map((p) => project(p as V3, spec.az, spec.el));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of scr) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const inner = RES * (1 - 2 * MARGIN), off = RES * MARGIN;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // map world -> pixel; flip Y so the icon is upright (screen y-up -> image y-down)
  const toPx = (p: [number, number]): [number, number] => [
    off + ((p[0] - cx) / span) * inner + inner / 2,
    off - ((p[1] - cy) / span) * inner + inner / 2,
  ];
  const grid = new Uint8Array(RES * RES);
  const px = scr.map(toPx);
  for (let i = 0; i + 2 < mesh.triangles.length; i += 3) {
    const a = px[mesh.triangles[i]], b = px[mesh.triangles[i + 1]], c = px[mesh.triangles[i + 2]];
    if (a && b && c) fillTri(grid, RES, RES, a, b, c);
  }
  // perforation: punch a staggered hole grid into the solid silhouette (even-odd renders them as holes)
  if (spec.holes) {
    const occAt = (x: number, y: number) => x >= 0 && y >= 0 && x < RES && y < RES && grid[y * RES + x] === 1;
    const cols = 4, rows = 4, r = inner / 26;
    const x0 = off, y0 = off, w = inner, h = inner;
    for (let r0 = 0; r0 < rows; r0++) for (let c0 = 0; c0 < cols; c0++) {
      const hx = x0 + w * ((c0 + 0.5 + (r0 % 2 ? 0.5 : 0)) / cols);
      const hy = y0 + h * ((r0 + 0.5) / rows);
      if (hx + r > x0 + w) continue;
      for (let y = Math.floor(hy - r); y <= Math.ceil(hy + r); y++) for (let x = Math.floor(hx - r); x <= Math.ceil(hx + r); x++)
        if (occAt(x, y) && (x - hx) ** 2 + (y - hy) ** 2 <= r * r) grid[y * RES + x] = 0;
    }
  }
  const occN = grid.reduce((s, v) => s + v, 0);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name + ".png"), grayPNG(grid, RES, RES));

  const loops = traceLoops(grid, RES, RES)
    .map((l) => simplify(l, 1.4))
    .filter((l) => l.length >= 3);
  SHEET.push({ name, loops01: loops.map((l) => l.map(([x, y]) => [x / RES, y / RES])) });
  const s = VIEW / RES;
  const d = loops.map((loop) =>
    "M" + loop.map(([x, y]) => `${(x * s).toFixed(2)},${(y * s).toFixed(2)}`).join("L") + "Z"
  ).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" fill="none">\n  <path d="${d}" fill="currentColor" fill-rule="evenodd"/>\n</svg>\n`;
  writeFileSync(join(OUT, name + ".svg"), svg);
  console.log(`  ${name.padEnd(11)} ${spec.file.padEnd(22)} ${mesh.positions.length}v ${mesh.triangles.length / 3 | 0}tri  fill=${(100 * occN / (RES * RES)).toFixed(0)}%  loops=${loops.length}`);
}

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(FAMILIES);
console.log(`tracing ${names.length} family icon(s) -> ${OUT}`);
for (const n of names) { const spec = FAMILIES[n]; if (!spec) { console.log(`  ${n}: no spec`); continue; } try { makeIcon(n, spec); } catch (e: any) { console.log(`  ${n}: ERROR ${e?.message ?? e}`); } }
renderSheet();
