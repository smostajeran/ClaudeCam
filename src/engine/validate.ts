// ORACLE VALIDATION: load a real P'X5 scene (config.px5 from a .pxpz) and compare the engine's
// COMPUTED feature values against P'X5's SAVED feature values, per part.
import { readFileSync, readdirSync } from "node:fs";
import { loadAppcodes } from "../vcml/appcode.ts";
import { evalVCML } from "../vcml/interp.ts";
import { Host } from "./partgraph.ts";
import { loadScene, installPartFns } from "./scene.ts";
import { APPCODES_DIR } from "../import/paths.ts";

function findFile(dir: string, name: string): string | null {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (f.name === name) return p;
  }
  return null;
}

const cfg = process.argv[2] ?? findFile("oracle/test_project", "config.px5");
if (!cfg) { console.log("config.px5 not found (extract a .pxpz into oracle/test_project)"); process.exit(0); }

// global features from <cartridge name="usm_haller"><globalfeaturedef><features .../>
const raw = readFileSync(cfg, "utf8");
const globals: Record<string, string> = {};
const gm = raw.match(/name="usm_haller"[\s\S]*?<features\s+([^>]*?)\/>/);
if (gm) for (const m of gm[1].matchAll(/([A-Za-z_]\w*)="([^"]*)"/g)) globals[m[1]] = m[2];

const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const host = new Host(model.components, { scenario: "co" });
(host as any).namedOps = loadAppcodes(APPCODES_DIR);
const scene = loadScene(cfg);
installPartFns(host, scene);

// Feature() falls back to the project globals when a part has no value / 'globaldef'
const baseFeature = (host as any).partFns.Feature;
(host as any).partFns.Feature = (a: any[], h: Host) => {
  const [p, k] = a.length > 1 ? [a[0], a[1]] : [h.current, a[0]];
  const v = p?.features?.get(k);
  if (v != null && v !== "globaldef") return v;
  return globals[k] ?? v ?? null;
};

const isExpr = (s: unknown) => typeof s === "string" && /[A-Za-z_]\w*\s*\(|;|\bcall\b/.test(s);
const props = model.properties.filter((p: any) => isExpr(p.defaultExpr));
const byFeature = new Map<string, any[]>();
for (const p of props) (byFeature.get(p.feature) ?? byFeature.set(p.feature, []).get(p.feature)!).push(p);
const applies = (p: any, t: string) => p.assignedTo.some((x: string) => t === x || host.isSubTypeOf(t, x));

let comparable = 0, match = 0;
const mism: string[] = [];
const glassMism: string[] = [];
for (const part of scene) {
  host.current = part as any;
  for (const [k, saved] of part.features) {
    const cands = (byFeature.get(k) ?? []).filter((p) => applies(p, part.type));
    if (!cands.length) continue; // engine doesn't compute this feature for this type
    let computed: unknown;
    try { computed = evalVCML(String(cands[0].defaultExpr), host, { part }); } catch { continue; }
    comparable++;
    if (String(computed) === String(saved)) match++;
    else {
      const line = `${part.type}.${k}: engine=${JSON.stringify(computed)} px5=${JSON.stringify(saved)}`;
      if (mism.length < 14) mism.push(line);
      if (/glas|scharnier|halter/.test(part.type) && glassMism.length < 8) glassMism.push(line);
    }
  }
}

console.log("=== ORACLE VALIDATION: engine vs P'X5 (config.px5) ===");
console.log(`  scene parts: ${scene.length}   project globals: ${JSON.stringify(globals)}`);
console.log(`  comparable computed features: ${comparable}   MATCH ${match} (${comparable ? ((100 * match) / comparable).toFixed(1) : 0}%)   MISMATCH ${comparable - match}`);
if (mism.length) { console.log("  mismatches (sample):"); for (const m of mism) console.log("     " + m); }
if (glassMism.length) { console.log("  glass-part mismatches:"); for (const m of glassMism) console.log("     " + m); }
