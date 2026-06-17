// First end-to-end "configure": evaluate every applicable property EXPRESSION on every part
// of a real loaded shelf scene, and report how many the engine computes successfully.
import { readFileSync } from "node:fs";
import { loadAppcodes } from "../vcml/appcode.ts";
import { evalVCML } from "../vcml/interp.ts";
import { Host } from "./partgraph.ts";
import { loadScene, installPartFns } from "./scene.ts";
import { APPCODES_DIR, SNX } from "../import/paths.ts";

const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const host = new Host(model.components, { scenario: "co" });
(host as any).namedOps = loadAppcodes(APPCODES_DIR);

const scene = loadScene(`${SNX}/cartridge/parts/normal_volume.xml`);
installPartFns(host, scene);

// only real expressions (a call/operator/statement) — skip bare literal defaults.
const isExpr = (s: unknown) => typeof s === "string" && /[A-Za-z_]\w*\s*\(|;|\bcall\b/.test(s);
const props = model.properties.filter((p: any) => isExpr(p.defaultExpr));
const applies = (p: any, type: string) => p.assignedTo.some((t: string) => type === t || host.isSubTypeOf(type, t));

let attempted = 0, ok = 0;
const errs = new Map<string, number>();
const samples: string[] = [];
for (const part of scene) {
  host.current = part as any;
  for (const p of props) {
    if (!applies(p, part.type)) continue;
    attempted++;
    try {
      const v = evalVCML(String(p.defaultExpr), host, { part });
      ok++;
      if (samples.length < 10 && v != null && v !== "") samples.push(`${part.type}.${p.feature} = ${JSON.stringify(v)}`);
    } catch (e: any) {
      const k =
        e.message.match(/unknown function '([^']+)'/)?.[1] ??
        e.message.match(/builtin '([^']+)'/)?.[1] ??
        (e.message.startsWith("VCML parse") ? "parse: " + e.message.replace("VCML parse: ", "").slice(0, 34) : e.message.slice(0, 40));
      errs.set(k, (errs.get(k) ?? 0) + 1);
    }
  }
}

const partTypes = [...new Set(scene.map((p) => p.type))];
console.log(`=== scene: normal_volume — ${scene.length} parts, ${partTypes.length} distinct types ===`);
console.log(`  types: ${partTypes.slice(0, 12).join(", ")}${partTypes.length > 12 ? " …" : ""}`);
console.log(`  expression properties in model: ${props.length}`);
console.log(`  property-evaluations on this scene: ${attempted}   OK ${ok} (${attempted ? ((100 * ok) / attempted).toFixed(1) : 0}%)   ERR ${attempted - ok}`);
console.log("  sample computed features:");
for (const s of samples) console.log("     " + s);
if (errs.size) console.log("  top failures:", [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}(${n})`).join("  "));
