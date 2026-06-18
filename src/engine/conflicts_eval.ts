// VCML conflict evaluator: execute each conflict's `conflictexpression` against a scene-backed Host.
// A conflictexpression returns the list of offending parts (empty => no conflict). This is what makes
// the 52 VCML-coded conflict kinds actually FIRE (vs the structural clause-evaluator that can't).
import { readFileSync } from "node:fs";
import { parseXmlFile, tagOf, attr, kids } from "../xml/parse.ts";
import { Host } from "./partgraph.ts";
import { loadScene, installPartFns } from "./scene.ts";
import { loadAppcodes } from "../vcml/appcode.ts";
import { evalVCML } from "../vcml/interp.ts";
import { APPCODES_DIR, FILES } from "../import/paths.ts";

export interface VcmlConflict { type: string; text: string; severity: number; expr: string }

export function loadConflictExpressions(file = FILES.conflictrepresentation): VcmlConflict[] {
  const root = parseXmlFile(file);
  const out: VcmlConflict[] = [];
  (function w(ns: any[]) { for (const n of ns) { if (tagOf(n) === "conflict") { const e = attr(n, "conflictexpression"); if (e && e.trim()) out.push({ type: attr(n, "type") ?? "", text: attr(n, "text") ?? "", severity: Number(attr(n, "severity") ?? 0) || 0, expr: e }); } const k = kids(n); if (k.length) w(k); } })(root);
  return out;
}

/** Build a Host with the live scene + part functions + appcode named-ops (same wiring solve.ts uses). */
export function setupHost(cfg: string): Host {
  const model = JSON.parse(readFileSync("out/model.json", "utf8"));
  const host = new Host(model.components, { scenario: "co" });
  (host as any).namedOps = loadAppcodes(APPCODES_DIR);
  const scene = loadScene(cfg);
  installPartFns(host, scene);
  return host;
}

const fired = (r: unknown): boolean => Array.isArray(r) ? r.length > 0 : !(r === false || r == null || r === 0 || r === "" || r === "false");

export interface EvalResult {
  total: number;
  fired: VcmlConflict[];
  cleanCount: number;
  errors: { type: string; err: string }[];
  missingFns: Record<string, number>; // function name -> how many conflicts blocked by it
}

export function evalConflictsVCML(cfg: string, defs = loadConflictExpressions()): EvalResult {
  const host = setupHost(cfg);
  const out: EvalResult = { total: defs.length, fired: [], cleanCount: 0, errors: [], missingFns: {} };
  for (const c of defs) {
    try {
      if (fired(evalVCML(c.expr, host))) out.fired.push(c); else out.cleanCount++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      out.errors.push({ type: c.type, err: msg });
      const m = msg.match(/'([A-Za-z_][A-Za-z0-9_]*)'/); // capture the unknown/unwired function name
      if (m) out.missingFns[m[1]] = (out.missingFns[m[1]] ?? 0) + 1;
    }
  }
  return out;
}

if (process.argv[1]?.endsWith("conflicts_eval.ts")) {
  const cfg = process.argv[2];
  if (!cfg) { console.log("usage: node src/engine/conflicts_eval.ts <config.px5>"); process.exit(0); }
  const r = evalConflictsVCML(cfg);
  const ranOk = r.cleanCount + r.fired.length;
  console.log(`=== VCML CONFLICT EVALUATION — ${cfg} ===`);
  console.log(`  conflictexpressions: ${r.total}   ran OK: ${ranOk}   errored: ${r.errors.length}`);
  console.log(`  FIRED: ${r.fired.length}${r.fired.length ? " -> " + r.fired.map((f) => f.type).join(", ") : ""}`);
  const miss = Object.entries(r.missingFns).sort((a, b) => b[1] - a[1]);
  console.log(`  top blockers (unwired functions): ${miss.slice(0, 15).map(([f, n]) => `${f}×${n}`).join(", ") || "none"}`);
}
