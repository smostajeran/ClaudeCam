// Path P -> USM Haller frame geometry. Given discrete per-column widths, per-row heights and a depth
// (no bay/level counts, no width-packer, no snap-to-350 — the approved model), generate the ball/tube
// lattice + feet + per-cell panels, in engine cm space. The customer payload layer converts to
// RealityKit + applies the IP-safe labels/BOM. Render is procedural primitives (D11).
//
// Lattice: balls at every (column-boundary x, depth-plane y, row-boundary z); width tubes along X,
// height tubes along Z (vertical), depth tubes along Y (front<->back). One depth tube per node = the
// two planes USM uses. Default closed-box cell = 5 panels (back/top/bottom/left/right, no front).
const SQRT1_2 = Math.SQRT1_2;

export const WIDTH_VOCAB = [175, 250, 350, 395, 500, 750];
export const DEPTH_DOMAIN = [250, 350, 500];

export interface PathP {
  columnWidths: number[];   // mm, per column (left->right)
  rowHeights: number[];     // mm, per row (bottom->top)
  depth: number;            // mm
  cells?: { col: number; row: number; type?: "closed" | "open" }[];
  baseSupport?: "feet" | "casters" | "plinth";
  globalFinishId?: string;
}

type V3 = [number, number, number];
type Q = [number, number, number, number];
const Q_DEPTH: Q = [0, 0, 0, 1];                         // tube along Y (local Y = world Y)
const Q_WIDTH: Q = [0, 0, -SQRT1_2, SQRT1_2];            // local Y -> world X (RotZ -90)
const Q_HEIGHT: Q = [SQRT1_2, 0, 0, SQRT1_2];            // local Y -> world Z (RotX +90)

export interface BuiltPart { id: string; type: string; pos: V3; quat: Q; quad?: V3[] }
export interface BuildResult { parts: BuiltPart[]; issues: { level: "warning" | "severe"; title: string; detail: string }[] }

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

  if ((p.baseSupport ?? "feet") === "feet") for (let i = 0; i <= nC; i++) for (let k = 0; k < 2; k++) parts.push({ id: id(), type: "hallerfuss", pos: [xs[i], ys[k], 0], quat: [0, 0, 0, 1] });

  // panels per cell (default closed-box: back/top/bottom/left/right)
  const cellType = (c: number, r: number) => p.cells?.find((x) => x.col === c && x.row === r)?.type ?? "closed";
  const quad = (type: string, corners: V3[]) => parts.push({ id: id(), type, pos: [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2, (corners[0][2] + corners[2][2]) / 2], quat: [0, 0, 0, 1], quad: corners });
  for (let i = 0; i < nC; i++) for (let j = 0; j < nR; j++) {
    if (cellType(i, j) === "open") continue;
    const x0 = xs[i], x1 = xs[i + 1], z0 = zs[j], z1 = zs[j + 1], y0 = ys[0], y1 = ys[1];
    const w = cols[i], h = rows[j];
    quad(`blech${h}_${w}`, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);   // back
    quad(`blech${depth}_${w}`, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]); // top
    quad(`blech${depth}_${w}`, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]); // bottom
    quad(`blech${h}_${depth}`, [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]); // left
    quad(`blech${h}_${depth}`, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]); // right
  }
  return { parts, issues };
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
