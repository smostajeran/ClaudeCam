// Compound part geometry. A P'X5 component can render SEVERAL geometries, each with its own
// translation/rotation that may be a VCML expression of the part's dock DOF (e.g. a scissor stay's
// arms swing by the door's open angle). The engine's mesh map only takes a component's FIRST geometry
// (its base body); this module exposes the REST so the renderer can draw the full articulated assembly.
//   resolveSubGeoms(type, dof) -> [{ mesh, pos:[x,y,z] cm, rot:[x,y,z] deg }]   (parts beyond the base)
// `dof` is the relevant dock's degree-of-freedom in degrees (the door's open angle); it is substituted
// for GetDOFValue(Dock(...)) before the small arithmetic (Sin/Cos/Rad/+-*) is evaluated.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CART_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "snx2xml", "co", "packages");
const GEOMREP = join(CART_ROOT, "hallerpackage", "representation", "geometryrepresentation.xml");

export interface SubGeom { mesh: string; pos: [number, number, number]; rot: [number, number, number] }
interface RawGeom { file: string; active: string | null; hasXform: boolean; t: [string, string, string]; r: [string, string, string] }

// Evaluate one transform-component expression with the dock DOF substituted in. Trusted internal data
// (the cartridge geometry rep), so a scoped arithmetic eval is acceptable; anything unparseable -> 0.
function evalExpr(expr: string | undefined, dof: number): number {
  if (expr == null) return 0;
  let s = String(expr).replace(/;/g, "").trim();
  if (s === "") return 0;
  const n = Number(s); if (!Number.isNaN(n)) return n;                          // fast path: literal
  s = s.replace(/GetDOFValue\s*\(\s*Dock\s*\([^()]*\)\s*\)/g, "(" + dof + ")");  // the door angle
  if (/[a-rt-zA-QS-Z_]/.test(s.replace(/Sin|Cos|Tan|Rad|Deg/g, ""))) return 0;  // unknown identifier -> bail to 0
  s = s.replace(/\bSin\s*\(/g, "Math.sin(").replace(/\bCos\s*\(/g, "Math.cos(").replace(/\bTan\s*\(/g, "Math.tan(")
       .replace(/\bRad\s*\(/g, "_rad(").replace(/\bDeg\s*\(/g, "_deg(");
  try { const v = Function("_rad", "_deg", "Math", "return (" + s + ");")((d: number) => d * Math.PI / 180, (r: number) => r * 180 / Math.PI, Math); return Number.isFinite(v) ? v : 0; }
  catch { return 0; }
}

// Parse geometryrepresentation.xml once: type -> ordered list of its <geometry> entries + transforms.
let CACHE: Map<string, RawGeom[]> | null = null;
function parseGeomRep(): Map<string, RawGeom[]> {
  if (CACHE) return CACHE;
  const map = new Map<string, RawGeom[]>();
  let xml = ""; try { xml = readFileSync(GEOMREP, "utf8"); } catch { CACHE = map; return map; }
  const compRe = /<component\b[^>]*\btype="([^"]+)"[^>]*>([\s\S]*?)<\/component>/g;
  let cm: RegExpExecArray | null;
  while ((cm = compRe.exec(xml))) {
    const type = cm[1], body = cm[2];
    const geoms: RawGeom[] = [];
    // each <geometry ...> ... (self-closing OR with <translation>/<rotation> children) ... [</geometry>]
    const gRe = /<geometry\b([^>]*?)(\/>|>([\s\S]*?)<\/geometry>)/g;
    let gm: RegExpExecArray | null;
    while ((gm = gRe.exec(body))) {
      const attrs = gm[1], inner = gm[3] || "";
      const fileM = /\bfile="geometry\/([^"]+)\.3d"/.exec(attrs); if (!fileM) continue;
      const activeM = /\bactive="([^"]*)"/.exec(attrs);
      const tEl = /<translation\b[^>]*\/?>/.exec(inner), rEl = /<rotation\b[^>]*\/?>/.exec(inner);
      const axes = (m: RegExpExecArray | null): [string, string, string] => {
        if (!m) return ["0", "0", "0"]; const a = m[0];
        const g = (k: string) => { const r = new RegExp("\\b" + k + '="([^"]*)"').exec(a); return r ? r[1] : "0"; };
        return [g("x"), g("y"), g("z")];
      };
      geoms.push({ file: fileM[1], active: activeM ? activeM[1] : null, hasXform: !!(tEl || rEl), t: axes(tEl), r: axes(rEl) });
    }
    if (geoms.length) map.set(type, geoms);
  }
  CACHE = map; return map;
}

/** Sub-geometries of a component BEYOND its base (first) geometry, with transforms resolved at `dof`
 *  degrees. Returns [] for a simple single-mesh part. `active` conditions are assumed satisfied (the
 *  part is present and docked); a follow-up can gate them on real dock counts. */
export function resolveSubGeoms(type: string, dof: number): SubGeom[] {
  const geoms = parseGeomRep().get(type);
  if (!geoms || geoms.length <= 1) return [];
  // Keep only genuine positioned sub-parts: an explicit transform AND no `active` gate. That excludes
  // the LOD variants (active="EnvValue(...)"), export/electrical/acoustic conditionals (active="..."),
  // and untransformed siblings — leaving the articulated pieces like a scissor stay's arms.
  return geoms.slice(1).filter((g) => g.active == null && g.hasXform && !/_export$|^export\//.test(g.file)).map((g) => ({
    mesh: g.file,
    pos: [evalExpr(g.t[0], dof), evalExpr(g.t[1], dof), evalExpr(g.t[2], dof)] as [number, number, number],
    rot: [evalExpr(g.r[0], dof), evalExpr(g.r[1], dof), evalExpr(g.r[2], dof)] as [number, number, number],
  }));
}

if (process.argv[1]?.endsWith("subgeom.ts")) {
  const type = process.argv[2] ?? "scherengelenk_l";
  for (const dof of [0, 45, 90]) {
    console.log(`\n${type} @ DOF=${dof}°:`);
    for (const s of resolveSubGeoms(type, dof)) console.log(`  ${s.mesh.padEnd(22)} pos=[${s.pos.map((x) => +x.toFixed(2))}] rot=[${s.rot.map((x) => +x.toFixed(1))}]`);
  }
}
