// Resolve a solver part TYPE to its decoded mesh and the mesh's LOCAL bounding box (cm). This mirrors
// server.ts's mesh-file resolution (kept in sync deliberately) so the PLACEMENT SOLVER can size a
// panel's quad to the real glass slab — the dock points alone can be inset from the glass edge (a
// glass door's hinges/handle sit ~14mm inboard, which otherwise renders the door pane too small).
// geometryrepresentation.xml lives under snx2xml/; the actual .3d/.obj meshes under virtual.USM-4/.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { highLODMesh } from "../geom/oio3d.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // usm-engine/
const CART_ROOT = join(ROOT, "..", "snx2xml", "co", "packages");
const GEO_DIRS = ["hallerpackage", "addonspackage", "primopackage", "hallertischpackage", "kitospackage", "displaypackage"]
  .map((p) => join(ROOT, "..", "virtual.USM-4", "co", "packages", p, "representation", "geometry"));

let GEOMMAP: Record<string, string> | null = null;
function geomMap() {
  if (GEOMMAP) return GEOMMAP;
  const out: Record<string, string> = {};
  try {
    const xml = readFileSync(join(CART_ROOT, "hallerpackage", "representation", "geometryrepresentation.xml"), "utf8");
    // `type` is not always first (e.g. `<component preload="true" type="…">`); match it anywhere, skip
    // optional <localvar>s, take the first geometry file. (Mirrors server.ts geomMap — keep in sync.)
    const re = /<component\b[^>]*\btype="([^"]+)"[^>]*>\s*(?:<localvar\b[^>]*>\s*)*<geometry\b[^>]*\bfile="geometry\/([^"]+)\.3d"/g;
    let m: RegExpExecArray | null; while ((m = re.exec(xml))) out[m[1]] = m[2];
  } catch { /* map optional — direct/heuristic candidates still resolve most parts */ }
  GEOMMAP = out; return out;
}
// candidate filenames for a solver part TYPE (direct, geometryrep mapping, and the known naming heuristics)
function meshCandidates(name: string): string[] {
  const c = [name]; const g = geomMap()[name]; if (g) c.push(g);
  if (/^co_/.test(name)) { const b = name.replace(/^co_/, ""); c.push(b); const gb = geomMap()[b]; if (gb) c.push(gb); }
  if (/^kugel/i.test(name)) c.push("Kugel", "kugel", "kugel_2");
  if (/fuss/i.test(name)) c.push("fuss", "nivellierfuss");
  if (/klemmhalter/i.test(name)) c.push("klemmhalter");
  const gm = name.match(/^glas(\d+)_(\d+)/i); if (gm) c.push(`glas${gm[1]}x${gm[2]}`);
  const gt = name.match(/^glastuer_(?:links|rechts)(\d+)_(\d+)/i); if (gt) c.push(`glas${gt[1]}x${gt[2]}`); // glass door leaf -> glass slab
  const am = name.match(/^(perfblech|biblioblech|ausziehtablar|schraegtablar|klapptuer|einschubtuer|kurzblech|lochblech)(\d+)_(\d+)/i); if (am) c.push(`${am[1]}${am[2]}x${am[3]}`);
  if (/^tuerelement/i.test(name)) { const t = name.match(/(\d+)_(\d+)/); if (t) c.push(`klapptuer${t[1]}x${t[2]}`); }
  // VCML-computed geometry names — geometryrepresentation maps these via StrReplace(GetTypeName(...)),
  // which the literal-file geomMap can't see (e.g. tablarseitenwinkel500_l -> tablarwinkel500_l.3d).
  if (/^einschubtuer\d/.test(name)) c.push("einschubtuer");   // slide-in door, single-size variant -> einschubtuer.3d
  if (/tablarseitenwinkel/.test(name)) c.push(name.replace("tablarseitenwinkel", "tablarwinkel"));
  if (/normaltrapezvorderwand/.test(name)) c.push(name.replace("normaltrapezvorderwand", "blech"));
  if (/einsatz/.test(name)) c.push(name.replace("einsatz", "buntglas"), name.replace("einsatz", "kelco"));
  return c;
}
function findOneFile(safe: string): string | null {
  for (const ext of [".obj", ".3d"]) for (const d of GEO_DIRS) { const f = join(d, safe + ext); if (existsSync(f)) return f; }
  for (const d of GEO_DIRS) { if (!existsSync(d)) continue;
    const files = readdirSync(d);
    for (const ext of [".obj", ".3d"]) for (const fn of files) if (fn.toLowerCase() === (safe + ext).toLowerCase()) return join(d, fn);
  }
  for (const d of GEO_DIRS) { if (!existsSync(d)) continue;       // recurse ONE level (e.g. geometry/inosbox/*.3d)
    for (const sub of readdirSync(d, { withFileTypes: true })) { if (!sub.isDirectory()) continue; const sd = join(d, sub.name);
      for (const ext of [".obj", ".3d"]) { const f = join(sd, safe + ext); if (existsSync(f)) return f;
        for (const fn of readdirSync(sd)) if (fn.toLowerCase() === (safe + ext).toLowerCase()) return join(sd, fn); } }
  }
  return null;
}
export function findMeshFile(name: string): string | null {
  for (const cand of meshCandidates(name)) { const f = findOneFile(cand.replace(/[^A-Za-z0-9_]/g, "")); if (f) return f; }
  return null;
}

export type Box = { min: [number, number, number]; max: [number, number, number] };
const EXT_CACHE = new Map<string, Box | null>();
// Finest-LOD mesh bounding box for a part TYPE, in the mesh's LOCAL frame, in CM. Only .3d (cm-native)
// meshes are measured — that covers the glass slabs panelQuad cares about; .obj (mm) returns null so the
// caller falls back to dock-only extent.
export function meshExtentCm(name: string): Box | null {
  if (EXT_CACHE.has(name)) return EXT_CACHE.get(name)!;
  let res: Box | null = null;
  const file = findMeshFile(name);
  if (file && file.toLowerCase().endsWith(".3d")) {
    const m = highLODMesh(file);
    if (m.positions.length) {
      const mn: [number, number, number] = [Infinity, Infinity, Infinity], mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const p of m.positions) for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
      res = { min: mn, max: mx };
    }
  }
  EXT_CACHE.set(name, res); return res;
}
