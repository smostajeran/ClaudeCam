// Parser for P'X5's OIO "CompositeThreeD" geometry (.3d) — a class-tagged object-serialization:
//   {id {classid 0 ClassName ver} field...}     object, with an inline class definition
//   {id @classid field...}                       object, class referenced by id
//   @N                                            back-reference to a previously-defined object
//   len"text"                                     length-prefixed string
// Mesh data lives in two classes:
//   Point3DList       -> a vertex (or normal) array: [..hdr.., count, count*3 floats]
//   Point3DIndexList  -> triangles: a @ref to its Point3DList, then [..count, count indices]
// We extract (vertices, triangles) pairs and emit a merged mesh. LOD names are "low"/"medium"/"high".
import { readFileSync } from "node:fs";

type Tok = { t: "{" } | { t: "}" } | { t: "ref"; id: number } | { t: "str"; v: string } | { t: "num"; v: number } | { t: "word"; v: string };

export function tokenize(s: string): Tok[] {
  const out: Tok[] = []; const n = s.length; let i = 0;
  const ws = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    const c = s[i];
    if (ws(c)) { i++; continue; }
    if (c === "{") { out.push({ t: "{" }); i++; continue; }
    if (c === "}") { out.push({ t: "}" }); i++; continue; }
    if (c === "@") { i++; let d = ""; while (i < n && s[i] >= "0" && s[i] <= "9") d += s[i++]; out.push({ t: "ref", id: +d }); continue; }
    if (c >= "0" && c <= "9") {                 // number or length-prefixed string
      let d = ""; while (i < n && s[i] >= "0" && s[i] <= "9") d += s[i++];
      if (s[i] === '"') { const len = +d; i++; const v = s.slice(i, i + len); i += len + 1; out.push({ t: "str", v }); continue; }
      let num = d; while (i < n && /[0-9.eE+\-]/.test(s[i]) && !ws(s[i]) && s[i] !== "{" && s[i] !== "}") num += s[i++];
      out.push({ t: "num", v: Number(num) }); continue;
    }
    if (c === "-" || c === "+" || c === ".") {  // signed/decimal number
      let num = ""; while (i < n && /[0-9.eE+\-]/.test(s[i]) && !ws(s[i]) && s[i] !== "{" && s[i] !== "}") num += s[i++];
      out.push({ t: "num", v: Number(num) }); continue;
    }
    let w = ""; while (i < n && !ws(s[i]) && s[i] !== "{" && s[i] !== "}") w += s[i++];   // identifier / class name
    out.push({ t: "word", v: w });
  }
  return out;
}

export interface Node { id: number; cls: string; fields: Tok[]; children: Node[] }

export function parse(toks: Tok[]): { root: Node; byId: Map<number, Node> } {
  let p = 0; const byId = new Map<number, Node>(); const classNames = new Map<number, string>();
  function obj(): Node {
    if (toks[p].t !== "{") throw new Error("expected { at " + p);
    p++;
    const id = (toks[p++] as any).v as number;
    let cls = "?";
    if (toks[p].t === "{") {                       // inline class def: {classid 0 ClassName ver}
      const cp = obj(); cls = cp.cls; // cp.cls won't be set; read its ClassName from fields
      const nameTok = cp.fields.find((t) => t.t === "word"); if (nameTok) cls = (nameTok as any).v;
      classNames.set(cp.id, cls);
    } else if (toks[p].t === "ref") { cls = classNames.get((toks[p++] as any).id) ?? "?"; }
    const node: Node = { id, cls, fields: [], children: [] };
    while (toks[p] && toks[p].t !== "}") {
      if (toks[p].t === "{") node.children.push(obj());
      else node.fields.push(toks[p++]);
    }
    p++; // consume }
    byId.set(id, node);
    return node;
  }
  const root = obj();
  return { root, byId };
}

const nums = (f: Tok[]): number[] => f.filter((t) => t.t === "num").map((t) => (t as any).v);

// Point3DList: trailing 3*count floats; `count` is the leading int i where nums[i]*3 == nums.length-1-i.
function vertsOf(node: Node): number[][] | null {
  const ns = nums(node.fields);
  for (let i = 0; i < ns.length; i++) {
    const c = ns[i];
    if (Number.isInteger(c) && c > 0 && c * 3 === ns.length - 1 - i) {
      const flat = ns.slice(i + 1); const v: number[][] = [];
      for (let k = 0; k < flat.length; k += 3) v.push([flat[k], flat[k + 1], flat[k + 2]]);
      return v;
    }
  }
  return null;
}

// Point3DIndexList: after the @ref to its vertex list, find count K with K indices following.
function trisOf(node: Node): { vref: number; idx: number[] } | null {
  const ref = node.fields.find((t) => t.t === "ref"); if (!ref) return null;
  const after = node.fields.slice(node.fields.indexOf(ref) + 1).filter((t) => t.t === "num").map((t) => (t as any).v);
  for (let i = 0; i < after.length; i++) {
    const k = after[i];
    if (Number.isInteger(k) && k > 0 && i + 1 + k === after.length) return { vref: (ref as any).id, idx: after.slice(i + 1) };
  }
  return null;
}

export interface Mesh { positions: number[][]; triangles: number[]; lod: string; level: number }

// P'X5 packs several SizeLOD levels of the SAME object into one .3d, each Polygons3D labelled
// "Level_0" (FINEST) .. "Level_N" (coarsest). (An earlier note assumed low/medium/high strings —
// those are NOT what is on disk; the labels are Level_<n>.) Returns the level, or -1 when a node
// carries no such label (a standalone piece, or a mesh without SizeLOD).
const LOD_RE = /^Level_(\d+)$/i;
const lodLevel = (n: Node): number => { for (const t of n.fields) if (t.t === "str") { const m = LOD_RE.exec((t as any).v); if (m) return +m[1]; } return -1; };

// --- node transform (OIO spatial node) -----------------------------------------------------------
// A CompositeThreeD/SizeLOD/Polygons3D node carries a local transform in its numeric fields, laid out
// (after 3 leading ints + the "0.05"/name strings) as: translation[3] scale[3] rotation[3]° center[3].
// Most parts are identity, but the glass-door hinges put a real rotation on their SizeLOD wrapper
// (e.g. 180,0,0 or 90,0,90); ignoring it dropped the hinge on the wrong side of the corner. Euler order
// is XYZ in degrees to match the placement solver (geom.ts / solve.ts, "calibrated").
type M4 = number[]; const D2R = Math.PI / 180;
const m4mul = (a: M4, b: M4): M4 => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c]; return o; };
const m4t = (x: number, y: number, z: number): M4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const m4s = (x: number, y: number, z: number): M4 => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const m4rx = (d: number): M4 => { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; };
const m4ry = (d: number): M4 => { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; };
const m4rz = (d: number): M4 => { const c = Math.cos(d * D2R), s = Math.sin(d * D2R); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const m4apply = (m: M4, v: number[]): number[] => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3], m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7], m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11]];
// Local matrix of a spatial node, or null when it is identity (the common case — keeps non-hinge parts untouched).
function nodeLocalMat(n: Node): M4 | null {
  if (n.cls !== "CompositeThreeD" && n.cls !== "SizeLOD" && n.cls !== "Polygons3D") return null;
  const nums = n.fields.filter((f) => f.t === "num").map((f) => (f as any).v as number);
  if (nums.length < 15) return null;
  const t = nums.slice(3, 6), s = nums.slice(6, 9), r = nums.slice(9, 12), c = nums.slice(12, 15);
  if (t.every((x) => x === 0) && s.every((x) => x === 1) && r.every((x) => x === 0)) return null;   // identity (center is moot without rotation)
  if (!s.every((x) => x > 0 && isFinite(x)) || !r.every(isFinite) || !t.every(isFinite)) return null; // not a sane transform block — leave verts raw
  const R = m4mul(m4mul(m4rx(r[0]), m4ry(r[1])), m4rz(r[2]));                 // XYZ
  const rs = m4mul(R, m4s(s[0], s[1], s[2]));
  const piv = m4mul(m4mul(m4t(c[0], c[1], c[2]), rs), m4t(-c[0], -c[1], -c[2])); // rotate/scale about center
  return m4mul(m4t(t[0], t[1], t[2]), piv);
}

export function extractMeshes(file: string): Mesh[] {
  const txt = readFileSync(file, "latin1");
  const start = txt.indexOf("{"); // skip the "@!OIO CompositeThreeD polyedit.exe " banner
  const { root, byId } = parse(tokenize(txt.slice(start)));
  const vlists = new Map<number, number[][]>();
  const ilists: { vref: number; idx: number[]; level: number }[] = [];
  const IDENT: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  (function walk(n: Node, level: number, mat: M4) {
    const lv = lodLevel(n); const here = lv >= 0 ? lv : level;   // Polygons3D carries the "Level_<n>" label
    const lm = nodeLocalMat(n); const m = lm ? m4mul(mat, lm) : mat;   // accumulate this node's local transform
    if (n.cls === "Point3DList") { const v = vertsOf(n); if (v) vlists.set(n.id, m === IDENT ? v : v.map((p) => m4apply(m, p))); }  // bake ancestor transforms into vertices
    if (n.cls === "Point3DIndexList") { const t = trisOf(n); if (t) ilists.push({ ...t, level: here }); }
    n.children.forEach((c) => walk(c, here, m));
  })(root, -1, IDENT);
  const meshes: Mesh[] = [];
  for (const il of ilists) {
    const verts = vlists.get(il.vref) ?? (byId.get(il.vref) ? vertsOf(byId.get(il.vref)!) : null);
    if (verts && il.idx.length % 3 === 0) meshes.push({ positions: verts, triangles: il.idx, lod: il.level < 0 ? "" : "Level_" + il.level, level: il.level });
  }
  return meshes;
}

/** Keep ONE SizeLOD level — never overlay levels (that overlay was the old "fan/comb" + the coarse
 *  copy poking through the unit). `want` "fine" keeps every piece's finest level (Level_0), "coarse"
 *  the coarsest. Unlabelled parts (standalone pieces / single-mesh files) are always kept. */
export function pickLODMesh(file: string, want: "fine" | "coarse"): Mesh {
  const all = extractMeshes(file);
  const levels = all.filter((m) => m.level >= 0).map((m) => m.level);
  const target = levels.length ? (want === "fine" ? Math.min(...levels) : Math.max(...levels)) : -1;
  const parts = all.filter((m) => m.level < 0 || m.level === target);
  const positions: number[][] = []; const triangles: number[] = []; let base = 0;
  for (const m of parts) { positions.push(...m.positions); for (const i of m.triangles) triangles.push(i + base); base += m.positions.length; }
  return { positions, triangles, lod: want, level: target };
}
/** Lightest LOD (coarsest single level) — smaller asset for distant/preview. Pass ?lod=low to request it. */
export const lowLODMesh = (file: string): Mesh => pickLODMesh(file, "coarse");
/** Finest single LOD (real solid geometry) — the viewer/app default; the correct shape with no LOD overlay. */
export const highLODMesh = (file: string): Mesh => pickLODMesh(file, "fine");

if (process.argv[1]?.endsWith("oio3d.ts")) {
  const f = process.argv[2]; if (!f) { console.log("usage: node src/geom/oio3d.ts <file.3d>"); process.exit(0); }
  const meshes = extractMeshes(f);
  const byLod: Record<string, { v: number; t: number; parts: number }> = {};
  for (const m of meshes) { const k = m.lod || "(none)"; (byLod[k] ??= { v: 0, t: 0, parts: 0 }); byLod[k].v += m.positions.length; byLod[k].t += m.triangles.length / 3; byLod[k].parts++; }
  console.log(`${f}: ${meshes.length} part(s) across LODs`);
  for (const [k, s] of Object.entries(byLod)) console.log(`  LOD ${k}: ${s.parts} parts, ${s.v}v ${s.t}tri`);
  const fine = highLODMesh(f), coarse = lowLODMesh(f);
  console.log(`  -> viewer mesh (finest, Level_${fine.level === -1 ? "?" : fine.level}): ${fine.positions.length}v ${fine.triangles.length / 3}tri  first vert=[${fine.positions[0]}]`);
  console.log(`  -> coarse mesh (Level_${coarse.level === -1 ? "?" : coarse.level}): ${coarse.positions.length}v ${coarse.triangles.length / 3}tri`);
}
