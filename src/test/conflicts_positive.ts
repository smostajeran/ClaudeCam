// Positive validation: take a config P'X5 considers clean (fires 0), inject specific faults in memory,
// and confirm exactly the matching conflict fires. Proves detection catches real problems (not just
// that it stays quiet). Needs a local clean config (proprietary, not in the repo): pass its path.
import { existsSync } from "node:fs";
import { setupHost, loadConflictExpressions } from "../engine/conflicts_eval.ts";
import { evalVCML } from "../vcml/interp.ts";

const cfg = process.argv[2] ?? "out/second_config.px5";
if (!existsSync(cfg)) { console.log("positive test needs a clean config: node src/test/conflicts_positive.ts <clean.px5> (skipped — none found)"); process.exit(0); }
const defs = loadConflictExpressions();
const firedSet = (host: any) => {
  const f = new Set<string>();
  for (const c of defs) { try { const r = evalVCML(c.expr, host); const isF = Array.isArray(r) ? r.length > 0 : !(r == null || r === false || r === 0); if (isF) f.add(c.type); } catch { /* unwired */ } }
  return f;
};
const newOnly = (a: Set<string>, base: Set<string>) => [...a].filter((t) => !base.has(t));

// --- baseline ---
const base = firedSet(setupHost(cfg));
console.log("BASELINE (clean):", base.size ? [...base].join(", ") : "0 conflicts ✓");

// --- FAULT 1: disconnect one corner of a fully-connected panel -> partial panel ---
{
  const host = setupHost(cfg);
  const panels = evalVCML("return GetComponentListOfType('normalblech');", host) as any[];
  let hit = null;
  for (const p of panels) { const c = (p.docks || []).filter((d: any) => d.type === "blech2rohr" && d.connectedPart); if (c.length >= 4) { c[0].connectedPart = null; hit = p; break; } }
  const nw = newOnly(firedSet(host), base);
  console.log(`FAULT 1 (panel ${hit?.type}: removed 1 of 4 tubes) -> new conflicts:`, nw.length ? nw.join(", ") : "NONE (detector missed it!)");
}

// --- FAULT 2: change a tube's type to a milled tube (fraesrohr) -> contains_fraesrohr ---
{
  const host = setupHost(cfg);
  const tubes = evalVCML("return GetComponentListOfType('rohr');", host) as any[];
  if (tubes[0]) tubes[0].type = "fraesrohr350_1_4";
  const nw = newOnly(firedSet(host), base);
  console.log(`FAULT 2 (one tube -> fraesrohr) -> new conflicts:`, nw.length ? nw.join(", ") : "NONE");
}

// --- FAULT 3: disconnect a vertical tube from one ball -> dangling tube ---
{
  const host = setupHost(cfg);
  const tubes = evalVCML("return GetComponentListOfType('rohr');", host) as any[];
  let hit = null;
  for (const t of tubes) {
    const balls = (t.docks || []).filter((d: any) => d.type === "rohr2kugel" && d.connectedPart);
    if (balls.length >= 2 && Math.abs((balls[0].connectedPart.pos?.z ?? 0) - (balls[1].connectedPart.pos?.z ?? 0)) > 1) { balls[0].connectedPart.pos.z += 10; hit = t; break; } // shift a ball so the tube length no longer matches
  }
  const nw = newOnly(firedSet(host), base);
  console.log(`FAULT 3 (moved a ball 10cm so a vertical tube no longer fits) -> new conflicts:`, nw.length ? nw.join(", ") : "NONE");
}
