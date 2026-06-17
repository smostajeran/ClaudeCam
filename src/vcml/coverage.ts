// Interpreter coverage on the REAL model expressions: which functions are called, and which
// are implemented vs part-builtins vs named-ops vs unknown. Drives interpreter build priority.
import { readFileSync } from "node:fs";
import { BUILTINS, PART_BUILTINS } from "./interp.ts";
import { loadAppcodes } from "./appcode.ts";
import { APPCODES_DIR } from "../import/paths.ts";

const NAMED_OPS = new Set(("MyBrokenConnection aztSperrstangen befestigungsSetGlasSchloss beschlagsMaterialGlasTuere blechDimension blechStatus canChangeToAusgeschnitten canChangeToBiblio canChangeToEinsatz canChangeToLochBlech canChangeToNormal canChangeToPerfBlech canChangeToPflanzenblech canChangeToVerkuerztBlech centerPart checkAkustikAssignment checkCleanUpHallerE checkConnectedKabelausschnittPosition checkDeprecatedArticles checkKabelausschnittPosition colormatch_dark colormatch_light connectedInosParts connectedPartsByDockType connectionReCalculation currentTopfFarbe directionOfLight displayHallerE extendedModeHallerE filterSchublade findStuetzprofile findTrafoFeature formatDistanceWeb getAllVolumesOfConnectionId getDefaultValue getDoorLength getGlobalColorCode getNKTcomponents getRelativeBBoxOfPartListPosition getSelectedVolumeList getTopffarbe getVolumeMountingInformation getVolumesOnSide glasHalterListe globalMaterial hasQSArticle hasURohr horizontalPart horizontalPipeVolumeFrontDockTransformation inosBoxAllowHoch inosBoxDeckelGross inosBoxDeckelklein inosBoxHoch inosBoxMaxHeight inosBoxNiedrig inosBoxRelHeight isAZTablarOverGlas isEinschubtuerBelowVerkuerztBlech isEinschubtuerUnderAZTablar isGlasUnderAZTablar isKugelLeitend isUSM joinHallerE kugelStrukturEinsatzStabilitaet leitendeRohre lichtFarbeE lichtVerbraucherFarbeE maxPlattenGGW montageEinzelrohr movedPartsHallerE partIsRohrWithDirection powerReCalculation printzonevolumelength rohrBefestigung rohrDoppelLoch rohrMaterial rohrRichtungDefault rohrRichtungValid selectedComponentType separateHallerE setChromMaterial setHallerRohrEditE setSperrstangen shelfIsMovable showPlattenGGW showVerbraucherPos sperrstangenMountStatus sperrstangenTransX stromkreisMaterial table_kelco table_sheet table_sheet_buntglas trafoTypeE validLochRohre validSchlitzRohre validUSBhallerE verbraucherHorizontalVerkleidung verbraucherLeistung verbraucherMaterial verbraucherTuere vertikalBlech volHasChildOfType volIsSelected volRefpartOfType volumeDimension volumeHallerE volumeIsRotated yDirectionGGW boxDockActive checkActiveDock").split(" "));

const STUBS = new Set(PART_BUILTINS);
const REAL = new Set(Object.keys(BUILTINS).filter((k) => !STUBS.has(k)));

const model = JSON.parse(readFileSync("out/model.json", "utf8"));

// gather every expression string in the model
const exprs: string[] = [];
const push = (v: unknown) => { if (typeof v === "string" && /[A-Za-z]\(|\bcall\b/.test(v)) exprs.push(v); };
for (const p of model.properties) push(p.defaultExpr);
for (const g of model.geomReps) { push(g.material); push(g.transformationExpr); }
for (const c of model.components) for (const d of c.docks) { push(d.activeExpr); if (d.dof?.domain) { push(d.dof.domain.from); push(d.dof.domain.to); } }
// clause/rule condition trees carry expressions in attrs (active/dynamicpartexpression/featurecondition)
function scanNode(n: any): void {
  if (!n) return;
  for (const v of Object.values(n.attrs ?? {})) push(v);
  for (const c of n.children ?? []) scanNode(c);
}
for (const cl of model.clauses) scanNode(cl.condition);
for (const r of [...model.assemblyRules, ...model.articles]) { scanNode(r.condition); for (const m of r.morphologies ?? []) push(m.activeExpr); }

// control-flow / operator keywords are not functions (but their presence is noted separately)
const KW = new Set(["if", "for", "foreach", "while", "else", "and", "or", "not", "my", "call", "return", "eq", "ne", "lt", "gt", "le", "ge", "true", "false", "null"]);
const ctrl = new Map<string, number>();
// extract called function names
const calls = new Map<string, number>();
for (const e of exprs) {
  for (const m of e.matchAll(/\bcall\s+([A-Za-z_]\w*)/g)) calls.set(m[1], (calls.get(m[1]) ?? 0) + 1);
  for (const m of e.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (KW.has(m[1])) { ctrl.set(m[1], (ctrl.get(m[1]) ?? 0) + 1); continue; }
    calls.set(m[1], (calls.get(m[1]) ?? 0) + 1);
  }
}
const ctrlTop = [...ctrl.entries()].sort((a, b) => b[1] - a[1]);

const cls = (fn: string) => REAL.has(fn) ? "real" : STUBS.has(fn) ? "stub" : NAMED_OPS.has(fn) ? "namedop" : "unknown";
const buckets: Record<string, [string, number][]> = { real: [], stub: [], namedop: [], unknown: [] };
let totalCalls = 0;
for (const [fn, n] of calls) { buckets[cls(fn)].push([fn, n]); totalCalls += n; }
for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => b[1] - a[1]);

const callsIn = (k: string) => buckets[k].reduce((s, [, n]) => s + n, 0);
console.log("=== interpreter coverage on real model expressions ===");
console.log(`  expressions scanned: ${exprs.length}   distinct functions: ${calls.size}   total calls: ${totalCalls}`);
const pct = (n: number) => ((100 * n) / totalCalls).toFixed(1) + "%";
console.log(`  by call volume:  real=${pct(callsIn("real"))}  stub/part=${pct(callsIn("stub"))}  namedop=${pct(callsIn("namedop"))}  unknown=${pct(callsIn("unknown"))}`);
console.log(`  distinct:  real=${buckets.real.length}  stub/part=${buckets.stub.length}  namedop=${buckets.namedop.length}  unknown=${buckets.unknown.length}`);
const top = (k: string, n: number) => console.log(`  top ${k}:`, buckets[k].slice(0, n).map(([f, c]) => `${f}(${c})`).join("  "));
top("real", 8);
top("stub", 12);
top("namedop", 12);
if (buckets.unknown.length) top("unknown", 20);
console.log("  control-flow keywords in exprs (parser must support):", ctrlTop.map(([f, c]) => `${f}(${c})`).join("  "));

// how many named-ops now have a loaded appcode def?
const loadedOps = loadAppcodes(APPCODES_DIR);
const nLoaded = buckets.namedop.filter(([f]) => loadedOps.has(f));
const nMissing = buckets.namedop.filter(([f]) => !loadedOps.has(f));
const loadedCalls = nLoaded.reduce((s, [, n]) => s + n, 0);
const realCalls = callsIn("real") + callsIn("stub"); // stub = wired against PartGraph
console.log("=== with appcode named-ops loaded ===");
console.log(`  appcode defs available: ${loadedOps.size}`);
console.log(`  named-ops with a loaded def: ${nLoaded.length}/${buckets.namedop.length}  (calls ${loadedCalls}/${callsIn("namedop")} = ${pct(loadedCalls)})`);
console.log(`  => total resolvable calls (impl builtins + part-builtins + loaded named-ops): ${pct(callsIn("real") + callsIn("stub") + loadedCalls)}`);
if (nMissing.length) console.log("  named-ops still missing a def:", nMissing.slice(0, 12).map(([f, c]) => `${f}(${c})`).join("  "));
