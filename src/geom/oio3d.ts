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

export interface Mesh { positions: number[][]; triangles: number[]; lod: string }

const LOD_RE = /^(low|medium|high)$/i;
const lodName = (n: Node): string | null => { const s = n.fields.find((t) => t.t === "str" && LOD_RE.test((t as any).v)); return s ? (s as any).v.toLowerCase() : null; };

export function extractMeshes(file: string): Mesh[] {
  const txt = readFileSync(file, "latin1");
  const start = txt.indexOf("{"); // skip the "@!OIO CompositeThreeD polyedit.exe " banner
  const { root, byId } = parse(tokenize(txt.slice(start)));
  const vlists = new Map<number, number[][]>();
  const ilists: { vref: number; idx: number[]; lod: string }[] = [];
  (function walk(n: Node, lod: string) {
    const here = lodName(n) ?? lod;       // Polygons3D carries the LOD label
    if (n.cls === "Point3DList") { const v = vertsOf(n); if (v) vlists.set(n.id, v); }
    if (n.cls === "Point3DIndexList") { const t = trisOf(n); if (t) ilists.push({ ...t, lod: here }); }
    n.children.forEach((c) => walk(c, here));
  })(root, "");
  const meshes: Mesh[] = [];
  for (const il of ilists) {
    const verts = vlists.get(il.vref) ?? (byId.get(il.vref) ? vertsOf(byId.get(il.vref)!) : null);
    if (verts && il.idx.length % 3 === 0) meshes.push({ positions: verts, triangles: il.idx, lod: il.lod });
  }
  return meshes;
}

/** Merge the parts of the first available LOD in `order` into one mesh. */
export function pickLODMesh(file: string, order: string[]): Mesh {
  const all = extractMeshes(file);
  const lod = order.find((l) => all.some((m) => m.lod === l)) ?? "";
  const parts = all.filter((m) => m.lod === lod);
  const positions: number[][] = []; const triangles: number[] = []; let base = 0;
  for (const m of parts) { positions.push(...m.positions); for (const i of m.triangles) triangles.push(i + base); base += m.positions.length; }
  return { positions, triangles, lod };
}
/** Lightest LOD (smallest assets — e.g. for distant/preview). NOTE: some doors' 'low' LOD is a degenerate flat quad. */
export const lowLODMesh = (file: string): Mesh => pickLODMesh(file, ["low", "medium", "high", ""]);
/** Richest LOD (real solid geometry — use for parts whose 'low' is flat, e.g. klapptuer doors). */
export const highLODMesh = (file: string): Mesh => pickLODMesh(file, ["high", "medium", "low", ""]);

if (process.argv[1]?.endsWith("oio3d.ts")) {
  const f = process.argv[2]; if (!f) { console.log("usage: node src/geom/oio3d.ts <file.3d>"); process.exit(0); }
  const meshes = extractMeshes(f);
  const byLod: Record<string, { v: number; t: number; parts: number }> = {};
  for (const m of meshes) { const k = m.lod || "(none)"; (byLod[k] ??= { v: 0, t: 0, parts: 0 }); byLod[k].v += m.positions.length; byLod[k].t += m.triangles.length / 3; byLod[k].parts++; }
  console.log(`${f}: ${meshes.length} part(s) across LODs`);
  for (const [k, s] of Object.entries(byLod)) console.log(`  LOD ${k}: ${s.parts} parts, ${s.v}v ${s.t}tri`);
  const low = lowLODMesh(f);
  console.log(`  -> app mesh (LOD '${low.lod}'): ${low.positions.length}v ${low.triangles.length / 3}tri  first vert=[${low.positions[0]}]`);
}
