// Pragmatic clause/conflict matcher: evaluate the model's clause condition-trees against a loaded
// scene and report which CONFLICT clauses fire. Validated against P'X5's conflicts.xml baseline.
import { readFileSync, readdirSync } from "node:fs";
import { Host } from "./partgraph.ts";
import { loadScene } from "./scene.ts";
import type { ScenePart } from "./scene.ts";
import { loadConflictCatalog } from "./conflicts_catalog.ts";
import type { ConflictDef, Severity } from "./conflicts_catalog.ts";
import { evalConflictsVCML, loadConflictExpressions } from "./conflicts_eval.ts";

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

// Full conflict catalog (type, severity, English name/problem/solution) — the error-handler taxonomy.
const catalog = loadConflictCatalog();
const defByType = new Map<string, ConflictDef[]>();
for (const d of catalog) (defByType.get(d.type) ?? defByType.set(d.type, []).get(d.type)!).push(d);
const conflictTypes = [...new Set(catalog.map((d) => d.type))];
const needsPrintZone = (t: string) => /PrintZone/i.test(t); // print-zone/scene state not modeled yet
const evaluable = conflictTypes.filter((t) => clauseByType.has(t) && !needsPrintZone(t));
const skipped = conflictTypes.filter((t) => clauseByType.has(t) && needsPrintZone(t));

// PRIMARY detector: execute each VCML conflictexpression against the live scene — this is what
// actually fires the expression-coded conflicts. Structural clause-trees stay as a fallback for the
// (few) clause-only kinds that have no VCML expression.
const vcml = evalConflictsVCML(cfg);
const vcmlTypes = new Set(loadConflictExpressions().map((c) => c.type));
const firedKeys = new Set<string>();
const fired: ConflictDef[] = [];
const addFired = (type: string) => {
  if (firedKeys.has(type)) return; firedKeys.add(type);
  fired.push((defByType.get(type) ?? [])[0] ?? { type, severity: 0, level: "info" as Severity, category: "Installation", name: type, problem: "", solution: "", multi: false, hasExpression: false });
};
for (const c of vcml.fired) addFired(c.type);
for (const t of evaluable) { if (vcmlTypes.has(t)) continue; try { if (evalClause(t, { byId: {} })) addFired(t); } catch { /* unsupported clause node -> skip */ } }

const counts: Record<Severity, number> = { severe: 0, warning: 0, info: 0 };
for (const f of fired) counts[f.level]++;
const vcmlRan = vcml.total - vcml.errors.length;
const topBlockers = Object.entries(vcml.missingFns).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([f, n]) => ({ fn: f, blocks: n }));

// Structured output for the UI error panel (grouped by severity, mirroring P'X5's conflict list).
const report = {
  scene: scene.length, volumes: volumes.length, catalogSize: catalog.length,
  detection: "vcml+structural",
  vcmlExpressions: vcml.total, vcmlRan, vcmlErrored: vcml.errors.length, topBlockers,
  counts, fired, catalog,
};
import("node:fs").then(({ writeFileSync }) => writeFileSync("out/conflicts.json", JSON.stringify(report)));

console.log("=== ERROR HANDLER — conflicts (VCML expressions executed vs P'X5 taxonomy) ===");
console.log(`  scene parts: ${scene.length}   volumes(clusters): ${volumes.length}`);
console.log(`  CATALOG: ${catalog.length} conflict kinds — ${catalog.filter((c) => c.level === "severe").length} severe / ${catalog.filter((c) => c.level === "warning").length} warning / ${catalog.filter((c) => c.level === "info").length} info`);
console.log(`  VCML detection: ${vcmlRan}/${vcml.total} expressions executed (${vcml.errors.length} blocked by unwired functions: ${topBlockers.slice(0, 6).map((b) => b.fn).join(", ") || "none"})`);
console.log(`  FIRED on this scene: ${fired.length}  (severe ${counts.severe} / warning ${counts.warning} / info ${counts.info})`);
for (const f of fired) console.log(`     [${f.level.toUpperCase()}] (${f.category}) ${f.name}${f.problem ? " — " + f.problem.slice(0, 70) : ""}`);
console.log(`  wrote out/conflicts.json`);
