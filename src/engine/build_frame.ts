// Path P -> USM Haller frame geometry. Given discrete per-column widths, per-row heights and a depth
// (no bay/level counts, no width-packer, no snap-to-350 — the approved model), generate the ball/tube
// lattice + feet + per-cell panels, in engine cm space. The customer payload layer converts to
// RealityKit + applies the IP-safe labels/BOM. Render is procedural primitives (D11).
//
// Lattice: balls at every (column-boundary x, depth-plane y, row-boundary z); width tubes along X,
// height tubes along Z (vertical), depth tubes along Y (front<->back). One depth tube per node = the
// two planes USM uses. Default closed-box cell = 5 panels (back/top/bottom/left/right, no front).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const SQRT1_2 = Math.SQRT1_2;

export const WIDTH_VOCAB = [175, 250, 350, 395, 500, 750];
export const DEPTH_DOMAIN = [250, 350, 500];

// one52 generic finish palette (neutral descriptive names + RGB). NOT the licensed USM colour feed —
// flagged as placeholder pending owner approval, same spirit as D6 for pricing.
export const FINISHES = [
  { id: "white", name: "White", rgb: [0.95, 0.95, 0.93] },
  { id: "light-grey", name: "Light grey", rgb: [0.74, 0.75, 0.76] },
  { id: "silver", name: "Silver", rgb: [0.66, 0.68, 0.70] },
  { id: "olive", name: "Olive green", rgb: [0.42, 0.45, 0.30] },
  { id: "blue", name: "Steel blue", rgb: [0.27, 0.40, 0.55] },
  { id: "anthracite", name: "Anthracite", rgb: [0.24, 0.25, 0.27] },
  { id: "black", name: "Graphite black", rgb: [0.11, 0.11, 0.12] },
];
function resolveFinish(id?: string) { return FINISHES.find((f) => f.id === id) ?? FINISHES[1]; }

export type CellContent = "open" | "closed" | "panel" | "shelf" | "pullout" | "drawer" | "door" | "glass";

export interface PathP {
  columnWidths: number[];   // mm, per column (left->right)
  rowHeights: number[];     // mm, per row (bottom->top)
  depth: number;            // mm
  cells?: { col: number; row: number; type?: CellContent }[];
  baseSupport?: "feet" | "casters" | "plinth";
  globalFinishId?: string;
}

type V3 = [number, number, number];
type Q = [number, number, number, number];
const Q_DEPTH: Q = [0, 0, 0, 1];                         // tube along Y (local Y = world Y)
const Q_WIDTH: Q = [0, 0, -SQRT1_2, SQRT1_2];            // local Y -> world X (RotZ -90)
const Q_HEIGHT: Q = [SQRT1_2, 0, 0, SQRT1_2];            // local Y -> world Z (RotX +90)

export interface BuiltPart { id: string; type: string; pos: V3; quat: Q; quad?: V3[] }
export interface BuildResult { parts: BuiltPart[]; issues: { level: "warning" | "severe"; title: string; detail: string }[]; finish: { id: string; name: string; rgb: number[] } }

const cum = (arr: number[]): number[] => { const o = [0]; for (const a of arr) o.push(o[o.length - 1] + a / 10); return o; }; // mm -> cm boundaries

export function buildFrame(p: PathP): BuildResult {
  const cols = p.columnWidths?.length ? p.columnWidths : [750];
  const rows = p.rowHeights?.length ? p.rowHeights : [350];
  const depth = p.depth || 350;
  const issues: BuildResult["issues"] = [];
  for (const w of cols) if (!WIDTH_VOCAB.includes(w)) issues.push({ level: "warning", title: "Unsupported column width", detail: `${w} mm is not in the approved width vocabulary (${WIDTH_VOCAB.join(", ")}).` });
  for (const h of rows) if (h <= 0) issues.push({ level: "severe", title: "Invalid row height", detail: `${h} mm` });
  if (!DEPTH_DOMAIN.includes(depth)) issues.push({ level: "warning", title: "Unsupported depth", detail: `${depth} mm is not in the approved depth domain (${DEPTH_DOMAIN.join(", ")}).` });

  const xs = cum(cols), zs = cum(rows), ys: number[] = [0, depth / 10]; // cm boundaries
  const nC = cols.length, nR = rows.length;
  const parts: BuiltPart[] = []; let n = 0;
  const id = () => String(++n);
  const ball = (x: number, y: number, z: number) => parts.push({ id: id(), type: "kugel_std", pos: [x, y, z], quat: [0, 0, 0, 1] });
  const tube = (mm: number, c: V3, q: Q) => parts.push({ id: id(), type: "rohr" + mm, pos: c, quat: q });

  for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) for (let j = 0; j <= nR; j++) ball(xs[i], ys[k], zs[j]);
  for (let i = 0; i < nC; i++) for (let k = 0; k < 2; k++) for (let j = 0; j <= nR; j++) tube(cols[i], [(xs[i] + xs[i + 1]) / 2, ys[k], zs[j]], Q_WIDTH);   // width (X)
  for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) for (let j = 0; j < nR; j++) tube(rows[j], [xs[i], ys[k], (zs[j] + zs[j + 1]) / 2], Q_HEIGHT); // height (Z)
  for (let i = 0; i <= nC; i++) for (let j = 0; j <= nR; j++) tube(depth, [xs[i], depth / 20, zs[j]], Q_DEPTH);                                          // depth (Y)

  const base = p.baseSupport ?? "feet";
  const totalW = xs[nC];
  if (base === "glides") {
    issues.push({ level: "severe", title: "Glides blocked", detail: "Glide base material is blocked/conflict (D5)." });
  } else if (base === "casters") {
    for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) parts.push({ id: id(), type: "rolle", pos: [xs[i], ys[k], 0], quat: [0, 0, 0, 1] });
    issues.push({ level: "warning", title: "Casters are a placeholder", detail: "Caster geometry is a placeholder primitive — not source-verified (pending an approved component / owner approval)." });
  } else if (base === "plinth") {
    parts.push({ id: id(), type: "co_plinth", pos: [totalW / 2, ys[0], 2.5], quat: [-SQRT1_2, 0, 0, SQRT1_2], quad: [[0, ys[0], 0], [totalW, ys[0], 0], [totalW, ys[0], 5], [0, ys[0], 5]] });
    issues.push({ level: "warning", title: "Plinth is a placeholder", detail: "Plinth geometry is a placeholder — not source-verified (pending owner approval)." });
  } else { // feet (default)
    for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) parts.push({ id: id(), type: "hallerfuss", pos: [xs[i], ys[k], 0], quat: [0, 0, 0, 1] });
  }

  // panels per cell (default closed-box: back/top/bottom/left/right)
  // Default blech lies in XY with normal +Z. Orient each face's normal: back->+Y (RotX -90),
  // top/bottom stay +Z, sides->±X (RotY ±90). Both the quad corners AND the quat encode orientation,
  // so renderers that use either path draw the panel in the correct plane.
  const Q_BACK: Q = [-SQRT1_2, 0, 0, SQRT1_2], Q_FLAT: Q = [0, 0, 0, 1], Q_LEFT: Q = [0, SQRT1_2, 0, SQRT1_2], Q_RIGHT: Q = [0, -SQRT1_2, 0, SQRT1_2];
  const cellType = (c: number, r: number): CellContent => p.cells?.find((x) => x.col === c && x.row === r)?.type ?? "closed";
  const quad = (type: string, q: Q, corners: V3[]) => parts.push({ id: id(), type, pos: [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2, (corners[0][2] + corners[2][2]) / 2], quat: q, quad: corners });
  for (let i = 0; i < nC; i++) for (let j = 0; j < nR; j++) {
    const t = cellType(i, j);
    if (t === "open") continue;
    const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1], y0 = ys[0], y1 = ys[1];
    const w = cols[i], h = rows[j], zm = (z0 + z1) / 2;
    const back: V3[] = [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    const front: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]];
    const horiz = (z: number): V3[] => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
    switch (t) {
      case "closed": // full metal box: back/top/bottom/left/right
        quad(`blech${h}_${w}`, Q_BACK, back);
        quad(`blech${depth}_${w}`, Q_FLAT, horiz(z1));
        quad(`blech${depth}_${w}`, Q_FLAT, horiz(z0));
        quad(`blech${depth}_${h}`, Q_LEFT, [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]);
        quad(`blech${depth}_${h}`, Q_RIGHT, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
        break;
      case "panel": quad(`blech${h}_${w}`, Q_BACK, back); break;                       // single back panel
      case "shelf": quad(`tablar${w}_${depth}`, Q_FLAT, horiz(z0)); break;              // horizontal shelf
      case "pullout": quad(`ausziehtablar${w}_${depth}`, Q_FLAT, horiz(zm)); break;     // pull-out tray
      case "drawer": quad(`schublade${h}_${w}`, Q_BACK, front); quad(`tablar${w}_${depth}`, Q_FLAT, horiz(z0)); break; // front + tray
      case "door": quad(`tuerelement${h}_${w}`, Q_BACK, front); break;                 // door on front opening
      case "glass": quad(`glasblech${h}_${w}`, Q_BACK, front); break;                  // glass on front opening
    }
  }
  // structural validation: content must fit its cell; tall+narrow on point supports -> tipping
  const inv = contentInventory();
  const famOf: Record<string, string> = { shelf: "shelf", pullout: "pullout", drawer: "drawer", door: "door", glass: "glass" };
  for (const c of p.cells ?? []) {
    const w = cols[c.col], h = rows[c.row], fam = c.type ? famOf[c.type] : undefined;
    if (w && h && fam && !(inv[fam] ?? []).some(([a, b]) => [w, h, depth].includes(a) && [w, h, depth].includes(b)))
      issues.push({ level: "warning", title: "Content doesn't fit", detail: `${c.type} does not fit a ${w}×${h} cell at depth ${depth} mm.` });
  }
  const totalWmm = cols.reduce((a, b) => a + b, 0), totalHmm = rows.reduce((a, b) => a + b, 0);
  if ((base === "feet" || base === "casters") && totalHmm > 1.8 * Math.min(totalWmm, depth))
    issues.push({ level: "warning", title: "Tipping risk", detail: `Tall, narrow unit (H ${totalHmm} vs min(W ${totalWmm}, D ${depth}) mm) — check stability / wall fixing.` });

  return { parts, issues, finish: resolveFinish(p.globalFinishId) };
}

// ---- grid-aware suggestions: what the user can add/remove given the current grid ----
const HEIGHT_VOCAB = WIDTH_VOCAB; // USM uses the same tube SKUs vertically as horizontally
const CONTENT: Record<string, { name: string; re: RegExp }> = {
  panel:   { name: "Closed panel", re: /^(blech|kurzblech|lochblech)/ },
  shelf:   { name: "Shelf",        re: /^tablar/ },
  pullout: { name: "Pull-out shelf", re: /^ausziehtablar/ },
  drawer:  { name: "Drawer",       re: /^(schublade|azschublade)/ },
  door:    { name: "Door",         re: /^(tuerelement|klapptuer|einschubtuer)/ },
  glass:   { name: "Glass",        re: /^(glasblech|glastuer)/ },
};
let _inv: Record<string, number[][]> | null = null;
function contentInventory(): Record<string, number[][]> {
  if (_inv) return _inv;
  _inv = {}; for (const f in CONTENT) _inv[f] = [];
  try {
    const model = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "out", "model.json"), "utf8"));
    for (const c of model.components) for (const f in CONTENT) {
      if (CONTENT[f].re.test(c.type)) { const m = c.type.match(/(\d{2,4})[_x](\d{2,4})/); if (m) _inv[f].push([+m[1], +m[2]]); }
    }
  } catch { /* model not loaded -> empty inventory, only open/closed offered */ }
  return _inv;
}

/** Given a Path P grid, the edits the configurator can offer (Path P degrees of freedom + per-cell content that fits). */
export function gridOptions(p: PathP): any {
  const cols = p.columnWidths?.length ? p.columnWidths : [750];
  const rows = p.rowHeights?.length ? p.rowHeights : [350];
  const depth = p.depth || 350;
  const inv = contentInventory();
  const cellContent = (W: number, H: number, D: number) => {
    const dims = [W, H, D]; const out = [{ id: "open", name: "Open" }, { id: "closed", name: "Closed box" }];
    for (const f in CONTENT) if (inv[f].some(([a, b]) => dims.includes(a) && dims.includes(b))) out.push({ id: f, name: CONTENT[f].name });
    return out;
  };
  const cellAt = (i: number, j: number) => p.cells?.find((c) => c.col === i && c.row === j)?.type ?? "closed";
  return {
    structure: {
      columns: { current: cols, addWidths: WIDTH_VOCAB, removableIndices: cols.length > 1 ? cols.map((_, i) => i) : [] },
      rows: { current: rows, addHeights: HEIGHT_VOCAB, removableIndices: rows.length > 1 ? rows.map((_, j) => j) : [] },
      depth: { current: depth, options: DEPTH_DOMAIN },
      base: { current: p.baseSupport ?? "feet", options: ["feet", "casters", "plinth"] },
      finish: { current: p.globalFinishId ?? FINISHES[1].id, options: FINISHES.map((f) => ({ id: f.id, name: f.name })) },
    },
    cells: cols.flatMap((w, i) => rows.map((h, j) => ({ col: i, row: j, width: w, height: h, current: cellAt(i, j), available: cellContent(w, h, depth) }))),
  };
}

if (process.argv[1]?.endsWith("build_frame.ts")) {
  const arg = process.argv[2];
  const p: PathP = arg ? JSON.parse(arg) : { columnWidths: [750], rowHeights: [350], depth: 350 };
  const { parts, issues } = buildFrame(p);
  const by: Record<string, number> = {};
  for (const x of parts) { const fam = /^kugel/.test(x.type) ? "ball" : /^rohr/.test(x.type) ? "tube" : /^blech/.test(x.type) ? "panel" : /fuss/.test(x.type) ? "foot" : "other"; by[fam] = (by[fam] ?? 0) + 1; }
  console.log("Path P:", JSON.stringify(p));
  console.log("parts:", parts.length, JSON.stringify(by), "issues:", issues.length);
}
