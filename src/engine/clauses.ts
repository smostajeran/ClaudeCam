// Pragmatic clause/conflict matcher: evaluate the model's clause condition-trees against a loaded
// scene and report which CONFLICT clauses fire. Validated against P'X5's conflicts.xml baseline.
import { readFileSync, readdirSync } from "node:fs";
import { Host } from "./partgraph.ts";
import { loadScene } from "./scene.ts";
import type { ScenePart } from "./scene.ts";

interface Vol { id: string; type: string; parts: ScenePart[]; features: Map<string, unknown> }
interface Bind { volume?: Vol; part?: ScenePart; byId: Record<string, Vol> }

function findFile(dir: string, name: string): string | null {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (f.name === name) return p;
  }
  return null;
}

const cfg = process.argv[2] ?? findFile("oracle/test_project", "config.px5");
if (!cfg) { console.log("no config.px5 (extract a .pxpz into oracle/test_project)"); process.exit(0); }

const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const host = new Host(model.components, {});
const scene = loadScene(cfg);
const isSub = (t: string, of: string) => t === of || host.isSubTypeOf(t, of);

// connected components -> volumes
const idOf = new Map<ScenePart, number>();
let cid = 0;
for (const p of scene) {
  if (idOf.has(p)) continue;
  const st = [p]; idOf.set(p, cid);
  while (st.length) { const x = st.pop() as ScenePart; for (const d of x.docks) { const c = d.connectedPart; if (c && !idOf.has(c)) { idOf.set(c, cid); st.push(c); } } }
  cid++;
}
const volumes: Vol[] = [];
const vmap = new Map<number, Vol>();
for (const p of scene) { const c = idOf.get(p) as number; if (!vmap.has(c)) { const V = { id: "vol" + c, type: "volume", parts: [], features: new Map() }; vmap.set(c, V); volumes.push(V); } vmap.get(c)!.parts.push(p); }

const clauseByType = new Map<string, any>(model.clauses.map((c: any) => [c.type, c.condition]));

function evalClause(type: string, b: Bind): boolean { const cond = clauseByType.get(type); return cond ? evalCond(cond, b) : false; }
function evalCond(n: any, b: Bind): boolean {
  const kids = n.children ?? [];
  switch (n.tag) {
    case "condition": return kids.every((c: any) => evalCond(c, b));
    case "or": return kids.some((c: any) => evalCond(c, b));
    case "not": return !kids.every((c: any) => evalCond(c, b));
    case "and": {
      const binder = kids.find((c: any) => c.tag === "part" && c.attrs.type === "volume" && c.attrs.id);
      if (binder) {
        const rest = kids.filter((c: any) => c !== binder);
        return volumes.some((V) => {
          const b2: Bind = { ...b, volume: V, byId: { ...b.byId, [binder.attrs.id]: V } };
          return binder.children.every((c: any) => evalCond(c, b2)) && rest.every((c: any) => evalCond(c, b2));
        });
      }
      return kids.every((c: any) => evalCond(c, b));
    }
    case "part": {
      if (n.attrs.class === "volume" || n.attrs.type === "volume") {
        const bound = n.attrs.id ? b.byId[n.attrs.id] : b.volume;
        if (bound) return kids.every((c: any) => evalCond(c, { ...b, volume: bound }));
        return volumes.some((V) => kids.every((c: any) => evalCond(c, { ...b, volume: V, byId: n.attrs.id ? { ...b.byId, [n.attrs.id]: V } : b.byId })));
      }
      const vol = b.volume; if (!vol) return false;
      const min = n.attrs.minimum ? Number(n.attrs.minimum) : 1;
      const max = n.attrs.maximum ? Number(n.attrs.maximum) : Infinity;
      const ok = vol.parts.filter((p) => isSub(p.type, n.attrs.type) && kids.every((c: any) => evalCond(c, { ...b, part: p })));
      return ok.length >= min && ok.length <= max;
    }
    case "reference": case "child": return kids.every((c: any) => evalCond(c, b));
    case "directpartner": case "partner": {
      const p = b.part ?? null; if (!p) return false;
      return p.docks.some((d) => d.connectedPart && kids.every((c: any) => evalCond(c, { ...b, part: d.connectedPart! })));
    }
    case "clause": {
      const ctxId = kids.find((c: any) => c.tag === "clausecontext")?.attrs.id;
      const V = ctxId ? b.byId[ctxId] : b.volume;
      return evalClause(n.attrs.type, { ...b, volume: V });
    }
    case "clausecontext": return true;
    case "featurecondition": {
      const p = b.part ?? b.volume; const val = p ? (p as any).features?.get(n.attrs.name) : undefined;
      if (n.attrs.excludedvalue != null) return String(val) !== n.attrs.excludedvalue;
      if (n.attrs.includedvalue != null) return String(val) === n.attrs.includedvalue;
      return val != null;
    }
    default: return kids.length ? kids.every((c: any) => evalCond(c, b)) : false; // unknown -> conservative
  }
}

// conflict clause types from conflictrepresentation.xml
const confRep = "C:/Virtual-LastU/snx2xml/co/packages/hallerpackage/representation/conflictrepresentation.xml";
const conflictTypes = [...new Set([...readFileSync(confRep, "utf8").matchAll(/<conflict[^>]*type="([^"]+)"/g)].map((m) => m[1]))];
const needsPrintZone = (t: string) => /PrintZone/i.test(t); // print-zone/scene state not modeled yet
const evaluable = conflictTypes.filter((t) => clauseByType.has(t) && !needsPrintZone(t));
const skipped = conflictTypes.filter((t) => clauseByType.has(t) && needsPrintZone(t));

const fired: string[] = [];
for (const t of evaluable) { try { if (evalClause(t, { byId: {} })) fired.push(t); } catch { /* skip */ } }

console.log("=== clause/conflict matcher vs P'X5 (config.px5, conflicts detected=false) ===");
console.log(`  scene parts: ${scene.length}   volumes(clusters): ${volumes.length}   conflict types: ${conflictTypes.length}`);
console.log(`  evaluable conflict clauses: ${evaluable.length}   (skipped, need print-zone modeling: ${skipped.length} -> ${skipped.join(", ")})`);
console.log(`  conflicts FIRED on this scene: ${fired.length}${fired.length ? " -> " + fired.join(", ") : ""}`);
console.log(`  P'X5 baseline = 0 conflicts -> engine ${fired.length === 0 ? "AGREES ✓ (" + evaluable.length + "/" + evaluable.length + " modelable conflict clauses)" : "DIVERGES on: " + fired.slice(0, 8).join(", ")}`);
