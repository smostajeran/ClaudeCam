// Path P -> USM Haller frame geometry. Given discrete per-column widths, per-row heights and a depth
// (no bay/level counts, no width-packer, no snap-to-350 — the approved model), generate the ball/tube
// lattice + feet + per-cell content, in engine cm space. The customer payload layer converts to
// RealityKit + applies IP-safe labels/BOM. Render is procedural primitives (D11).
//
// SOURCE-VERIFIED: every emitted type must exist in out/model.json's component list (the two
// exceptions, kugel_std and hallerfuss, are verified to appear in real .px5 configs but are not in the
// extracted component list). `has()` enforces this — an unknown type is skipped and flagged, never
// shipped. No finishes/colours, casters, plinths, or dimensional drawers are emitted: those have no
// source-verified component (only numeric Metallfarbe codes / size-class drawers exist), so we do not
// invent them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const SQRT1_2 = Math.SQRT1_2;

export const WIDTH_VOCAB = [175, 250, 350, 395, 500, 750];
export const DEPTH_DOMAIN = [250, 350, 500];
const HEIGHT_VOCAB = WIDTH_VOCAB; // USM uses the same tube SKUs vertically as horizontally

export type CellContent = "open" | "closed" | "panel" | "shelf" | "pullout" | "door" | "glass";

export interface PathP {
  columnWidths: number[];   // mm, per column (left->right)
  rowHeights: number[];     // mm, per row (bottom->top)
  depth: number;            // mm
  cells?: { col: number; row: number; type?: CellContent }[];
  baseSupport?: "feet" | "casters" | "plinth";
  globalFinishId?: string;  // accepted but NOT applied — no source-verified finish palette exists
}

type V3 = [number, number, number];
type Q = [number, number, number, number];
// Tube quats chosen so that AFTER quatToRK (cm/Z-up -> m/Y-up conjugation) the rod (drawn along local
// Y by the renderer) lands on the correct RealityKit axis: width->X, height->Y(up), depth->Z.
const Q_WIDTH: Q = [0, SQRT1_2, 0, SQRT1_2], Q_HEIGHT: Q = [0, 0, 0, 1], Q_DEPTH: Q = [SQRT1_2, 0, 0, SQRT1_2];
// Panel face orientation quats (renderers that use quat instead of quad still get the right plane).
const Q_BACK: Q = [-SQRT1_2, 0, 0, SQRT1_2], Q_FLAT: Q = [0, 0, 0, 1], Q_LEFT: Q = [0, SQRT1_2, 0, SQRT1_2], Q_RIGHT: Q = [0, -SQRT1_2, 0, SQRT1_2];

export interface BuiltPart { id: string; type: string; pos: V3; quat: Q; quad?: V3[] }
export interface BuildResult { parts: BuiltPart[]; issues: { level: "warning" | "severe"; title: string; detail: string }[] }

// ---- source-of-truth: the real component type set ----
const CONFIG_VERIFIED = ["kugel_std", "hallerfuss"]; // present in real .px5 configs, absent from the extracted component list
let _types: Set<string> | null = null;
function componentTypes(): Set<string> {
  if (_types) return _types;
  _types = new Set(CONFIG_VERIFIED);
  try {
    const model = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "out", "model.json"), "utf8"));
    for (const c of model.components) _types.add(c.type);
  } catch { /* model not loaded -> only CONFIG_VERIFIED known */ }
  return _types;
}
const has = (t: string) => componentTypes().has(t);

// Content families and the EXACT type-name each maps to for a cell (verified against model.json:
// blech<H>_<W>, tablar<W>_<D>, ausziehtablar<W>_<D>, tuerelement<W>_<H>, glas<H>_<W>). Drawers are
// size-class only (no W×H type) so they are not offered.
const CONTENT_FAMILIES: { id: CellContent; name: string; type: (w: number, h: number, d: number) => string }[] = [
  { id: "panel", name: "Closed panel", type: (w, h) => `blech${h}_${w}` },
  { id: "shelf", name: "Shelf", type: (w, _h, d) => `tablar${w}_${d}` },
  { id: "pullout", name: "Pull-out shelf", type: (w, _h, d) => `ausziehtablar${w}_${d}` },
  { id: "door", name: "Door", type: (w, h) => `tuerelement${w}_${h}` },
  { id: "glass", name: "Glass", type: (w, h) => `glas${h}_${w}` },
];

const cum = (arr: number[]): number[] => { const o = [0]; for (const a of arr) o.push(o[o.length - 1] + a / 10); return o; }; // mm -> cm boundaries

export interface MatrixEdge { a: V3; b: V3; mid: V3; axis: "x" | "y" | "z"; dim: number }
/** The matrix mesh: dots (nodes) at the lattice; each edge is a tube whose length EQUALS the spacing
 *  between its two dots (X = column width, Y = depth, Z = row height). `lift` raises the grid off the
 *  floor by the foot height. Verified: distance(dot,dot) === edge.dim on every axis. */
export function buildMatrix(p: PathP, lift = 0): { nodes: V3[]; edges: MatrixEdge[]; xs: number[]; ys: number[]; zs: number[] } {
  const cols = p.columnWidths?.length ? p.columnWidths : [750];
  const rows = p.rowHeights?.length ? p.rowHeights : [350];
  const depth = p.depth || 350;
  const xs = cum(cols), zs = cum(rows).map((z) => z + lift), ys = [0, depth / 10];
  const nC = cols.length, nR = rows.length;
  const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const nodes: V3[] = [];
  for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) for (let j = 0; j <= nR; j++) nodes.push([xs[i], ys[k], zs[j]]);
  const edges: MatrixEdge[] = [];
  for (let i = 0; i < nC; i++) for (let k = 0; k < 2; k++) for (let j = 0; j <= nR; j++) { const a: V3 = [xs[i], ys[k], zs[j]], b: V3 = [xs[i + 1], ys[k], zs[j]]; edges.push({ a, b, mid: mid(a, b), axis: "x", dim: cols[i] }); }
  for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) for (let j = 0; j < nR; j++) { const a: V3 = [xs[i], ys[k], zs[j]], b: V3 = [xs[i], ys[k], zs[j + 1]]; edges.push({ a, b, mid: mid(a, b), axis: "z", dim: rows[j] }); }
  for (let i = 0; i <= nC; i++) for (let j = 0; j <= nR; j++) { const a: V3 = [xs[i], ys[0], zs[j]], b: V3 = [xs[i], ys[1], zs[j]]; edges.push({ a, b, mid: mid(a, b), axis: "y", dim: depth }); }
  return { nodes, edges, xs, ys, zs };
}

export function buildFrame(p: PathP): BuildResult {
  const cols = p.columnWidths?.length ? p.columnWidths : [750];
  const rows = p.rowHeights?.length ? p.rowHeights : [350];
  const depth = p.depth || 350;
  const issues: BuildResult["issues"] = [];
  const skipped = new Set<string>();
  for (const w of cols) if (!WIDTH_VOCAB.includes(w)) issues.push({ level: "warning", title: "Unsupported column width", detail: `${w} mm is not in the approved width vocabulary (${WIDTH_VOCAB.join(", ")}).` });
  for (const h of rows) if (h <= 0) issues.push({ level: "severe", title: "Invalid row height", detail: `${h} mm` });
  if (!DEPTH_DOMAIN.includes(depth)) issues.push({ level: "warning", title: "Unsupported depth", detail: `${depth} mm is not in the approved depth domain (${DEPTH_DOMAIN.join(", ")}).` });

  // Leveling feet lift the frame off the floor: measured at exactly 3.00 cm in the real base model
  // (foot z=0, bottom ball node z=3). Without it the frame sits on the floor and the feet collide.
  const base = p.baseSupport ?? "feet";
  const FOOT_LIFT = 3;
  const lift = base === "feet" ? FOOT_LIFT : 0;
  const xs = cum(cols), zs = cum(rows).map((z) => z + lift), ys: number[] = [0, depth / 10];
  const nC = cols.length, nR = rows.length;
  const parts: BuiltPart[] = []; let n = 0;
  const id = () => String(++n);
  // every emission is guarded: an unknown component type is skipped and flagged, never shipped.
  const emit = (type: string, pos: V3, quat: Q, quad?: V3[]) => {
    if (!has(type)) { if (!skipped.has(type)) { skipped.add(type); issues.push({ level: "warning", title: "Part not available", detail: `No source-verified component for ${type}; omitted.` }); } return; }
    parts.push({ id: id(), type, pos, quat, ...(quad ? { quad } : {}) });
  };
  const quad = (type: string, q: Q, corners: V3[]) => emit(type, [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2, (corners[0][2] + corners[2][2]) / 2], q, corners);

  // lattice = the matrix mesh: a dot (ball) at every node, a tube on every edge whose length is the
  // dot-to-dot spacing (verified: distance === edge.dim). Single source of truth for the grid.
  const matrix = buildMatrix(p, lift);
  for (const nd of matrix.nodes) emit("kugel_std", nd, [0, 0, 0, 1]);
  for (const e of matrix.edges) emit("rohr" + e.dim, e.mid, e.axis === "x" ? Q_WIDTH : e.axis === "z" ? Q_HEIGHT : Q_DEPTH);

  // base support: only feet are source-verified (hallerfuss). casters/plinth have no component; glides blocked (D5).
  if (base === "feet") { for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) emit("hallerfuss", [xs[i], ys[k], 0], [0, 0, 0, 1]); }
  else if ((base as string) === "glides") issues.push({ level: "severe", title: "Glides blocked", detail: "Glide base material is blocked/conflict (D5)." });
  else issues.push({ level: "warning", title: "Base support not available", detail: `No source-verified component for "${base}" base — only levelling feet are available.` });

  // per-cell content (all type names verified against model.json; unknown -> skipped+flagged by emit)
  for (let i = 0; i < nC; i++) for (let j = 0; j < nR; j++) {
    const t = p.cells?.find((x) => x.col === i && x.row === j)?.type ?? "closed";
    if (t === "open") continue;
    const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1], y0 = ys[0], y1 = ys[1], w = cols[i], h = rows[j];
    const back: V3[] = [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    const front: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
    const horiz = (z: number): V3[] => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
    if (t === "closed") {
      quad(`blech${h}_${w}`, Q_BACK, back);
      quad(`blech${depth}_${w}`, Q_FLAT, horiz(z1));
      quad(`blech${depth}_${w}`, Q_FLAT, horiz(z0));
      quad(`blech${depth}_${h}`, Q_LEFT, [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]);
      quad(`blech${depth}_${h}`, Q_RIGHT, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
    } else if (t === "panel") quad(`blech${h}_${w}`, Q_BACK, back);
    else if (t === "shelf") quad(`tablar${w}_${depth}`, Q_FLAT, horiz(z0));
    else if (t === "pullout") quad(`ausziehtablar${w}_${depth}`, Q_FLAT, horiz((z0 + z1) / 2));
    else if (t === "door") quad(`tuerelement${w}_${h}`, Q_BACK, front);
    else if (t === "glass") quad(`glas${h}_${w}`, Q_BACK, front);
  }

  // tipping heuristic: tall + shallow on feet
  const totalWmm = cols.reduce((a, b) => a + b, 0), totalHmm = rows.reduce((a, b) => a + b, 0);
  if (base === "feet" && totalHmm > 1.8 * Math.min(totalWmm, depth))
    issues.push({ level: "warning", title: "Tipping risk", detail: `Tall, shallow unit (H ${totalHmm} vs min(W ${totalWmm}, D ${depth}) mm) — check stability / wall fixing.` });

  return { parts, issues };
}

/** Given a Path P grid, the edits the configurator can offer (Path P degrees of freedom + per-cell
 *  content whose exact component type exists in the source). */
export function gridOptions(p: PathP): any {
  const cols = p.columnWidths?.length ? p.columnWidths : [750];
  const rows = p.rowHeights?.length ? p.rowHeights : [350];
  const depth = p.depth || 350;
  const cellContent = (w: number, h: number, d: number) => {
    const out: { id: string; name: string }[] = [{ id: "open", name: "Open" }];
    if (has(`blech${h}_${w}`)) out.push({ id: "closed", name: "Closed box" });
    for (const f of CONTENT_FAMILIES) if (has(f.type(w, h, d)) && f.id !== "panel") out.push({ id: f.id, name: f.name });
    if (has(`blech${h}_${w}`)) out.push({ id: "panel", name: "Closed panel" });
    return out;
  };
  const cellAt = (i: number, j: number) => p.cells?.find((c) => c.col === i && c.row === j)?.type ?? "closed";
  return {
    structure: {
      columns: { current: cols, addWidths: WIDTH_VOCAB, removableIndices: cols.length > 1 ? cols.map((_, i) => i) : [] },
      rows: { current: rows, addHeights: HEIGHT_VOCAB, removableIndices: rows.length > 1 ? rows.map((_, j) => j) : [] },
      depth: { current: depth, options: DEPTH_DOMAIN },
      base: { current: p.baseSupport ?? "feet", options: ["feet"] }, // only feet has a source-verified component
    },
    cells: cols.flatMap((w, i) => rows.map((h, j) => ({ col: i, row: j, width: w, height: h, current: cellAt(i, j), available: cellContent(w, h, depth) }))),
  };
}

if (process.argv[1]?.endsWith("build_frame.ts")) {
  const arg = process.argv[2];
  const p: PathP = arg ? JSON.parse(arg) : { columnWidths: [750], rowHeights: [350], depth: 350 };
  const { parts, issues } = buildFrame(p);
  const by: Record<string, number> = {};
  for (const x of parts) by[x.type] = (by[x.type] ?? 0) + 1;
  console.log("Path P:", JSON.stringify(p));
  console.log("parts:", parts.length, JSON.stringify(by));
  console.log("issues:", issues.map((i) => i.level + ":" + i.title).join(" | ") || "none");
}
