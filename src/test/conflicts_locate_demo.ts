// Demo: inject faults into a CLEAN config and show, for each newly-fired conflict, the parts it
// locates (id/type/world-pos). Proves the error->mesh mapping is computed for many conflict kinds,
// not just the one that happens to fire on the saved config. Pass a clean config path.
import { existsSync } from "node:fs";
import { setupHost, loadConflictExpressions } from "../engine/conflicts_eval.ts";
import { evalVCML } from "../vcml/interp.ts";

const cfg = process.argv[2] ?? (existsSync("out/second_config.px5") ? "out/second_config.px5" : "out/third_config.px5");
console.log("CLEAN config:", cfg);
const defs = loadConflictExpressions();
const isF = (r: unknown) => Array.isArray(r) ? r.length > 0 : !(r == null || r === false || r === 0 || r === "");

function loci(r: unknown, out: Map<string, string>, d = 0): void {
  if (r == null || d > 5) return;
  if (Array.isArray(r)) { for (const e of r) loci(e, out, d + 1); return; }
  if (typeof r === "object") {
    const o = r as any;
    if (o.id != null && o.pos && typeof o.pos.x === "number") {
      const id = String(o.id);
      if (!out.has(id)) out.set(id, `${o.type}#${id}@[${[o.pos.x, o.pos.y, o.pos.z].map((x: number) => x.toFixed(0))}]`);
    }
    if (Array.isArray(o.parts)) for (const p of o.parts) loci(p, out, d + 1);
  }
}
const firedWithLoci = (host: any) => {
  const res: { type: string; text: string; parts: string[] }[] = [];
  for (const c of defs) { try { const r = evalVCML(c.expr, host); if (isF(r)) { const m = new Map<string, string>(); loci(r, m); res.push({ type: c.type, text: c.text, parts: [...m.values()] }); } } catch { /* unwired */ } }
  return res;
};
const baseTypes = new Set(firedWithLoci(setupHost(cfg)).map((x) => x.type));
const newOnes = (host: any) => firedWithLoci(host).filter((x) => !baseTypes.has(x.type));
const show = (label: string, host: any) => {
  console.log("\n" + label);
  const n = newOnes(host);
  if (!n.length) { console.log("   (no NEW conflict fired — rule may need an unwired builtin)"); return; }
  for (const f of n) console.log(`   FIRES [${f.type}] ${f.text}\n        located -> ${f.parts.join(", ") || "<expression returned a non-part value>"}`);
};

{ const h = setupHost(cfg); const panels = evalVCML("return GetComponentListOfType('normalblech');", h) as any[];
  for (const p of panels) { const c = (p.docks || []).filter((d: any) => d.type === "blech2rohr" && d.connectedPart); if (c.length >= 4) { c[0].connectedPart = null; break; } }
  show("FAULT A — removed 1 of 4 tubes from a panel:", h); }

{ const h = setupHost(cfg); const tubes = evalVCML("return GetComponentListOfType('rohr');", h) as any[]; if (tubes[0]) tubes[0].type = "fraesrohr350_1_4";
  show("FAULT B — turned one tube into a milled fraesrohr:", h); }

{ const h = setupHost(cfg); const tubes = evalVCML("return GetComponentListOfType('rohr');", h) as any[];
  for (const t of tubes) { const b = (t.docks || []).filter((d: any) => d.type === "rohr2kugel" && d.connectedPart); if (b.length >= 2 && Math.abs((b[0].connectedPart.pos?.z ?? 0) - (b[1].connectedPart.pos?.z ?? 0)) > 1) { b[0].connectedPart.pos.z += 10; break; } }
  show("FAULT C — moved a ball 10cm so a vertical tube no longer fits:", h); }
