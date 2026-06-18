// Diagnostic: which conflict rule would flag part #241, and which rules are blocked from running.
import { setupHost, loadConflictExpressions } from "../engine/conflicts_eval.ts";
import { evalVCML } from "../vcml/interp.ts";

const target = process.argv[3] ?? "241";
const cfg = process.argv[2] ?? "out/third_config.px5";
const defs = loadConflictExpressions();
const host = setupHost(cfg);

function hasId(r: unknown, id: string, d = 0): boolean {
  if (r == null || d > 6) return false;
  if (Array.isArray(r)) return r.some((e) => hasId(e, id, d + 1));
  if (typeof r === "object") {
    const o = r as any;
    if (o.id != null && String(o.id) === id) return true;
    if (Array.isArray(o.parts)) return o.parts.some((p: any) => hasId(p, id, d + 1));
  }
  return false;
}

console.log(`Rules that FLAG #${target}, or are BLOCKED:`);
for (const c of defs) {
  try {
    const r = evalVCML(c.expr, host);
    if (hasId(r, target)) console.log(`  FIRES on #${target}: [${c.type}] ${c.text}`);
  } catch (e: any) {
    const m = String(e?.message ?? e).match(/'([A-Za-z_][A-Za-z0-9_]*)'/);
    console.log(`  BLOCKED [${c.type}] "${c.text}" needs: ${m ? m[1] : String(e?.message).slice(0, 50)}`);
  }
}
