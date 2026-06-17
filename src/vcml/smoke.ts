// Smoke test for the VCML interpreter skeleton (runs against the imported model).
import { readFileSync } from "node:fs";
import { evalVCML } from "./interp.ts";
import { Host } from "../engine/partgraph.ts";

const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const host = new Host(model.components, { scenario: "co", KugelResolution: "good" });

function show(label: string, src: string, locals: Record<string, any> = {}) {
  try {
    const v = evalVCML(src, host, locals);
    console.log(`  OK  ${label}\n        ${src}\n        => ${JSON.stringify(v)}`);
  } catch (e: any) {
    console.log(`  ERR ${label}\n        ${src}\n        => ${e.message}`);
  }
}

console.log("=== VCML interpreter smoke ===");
show("arithmetic + precedence", "1 + 2 * 3;");
show("string concat ++", "'rohr' ++ 350 ++ '_ms';");
show("ternary + comparison", "my w = 750; w ge 500 ? 'wide' : 'narrow';");
show("and/or/not", "not (1 eq 2) and ('a' eq 'a');");
show("list + size", "my l = List('a','b'); ListAdd(l, 'c'); Size(l);");
show("string ops", "EndsWith('inosBox-hoch', 'hoch');");
show("EnvValue from host", "EnvValue('KugelResolution', 'low');");
show("member access", "my v = Vector(1,2,3); v['y'];");
show("IsSubTypeOf (real hierarchy)", "IsSubTypeOf('kugel_std', 'haller_shelf_component');");
show("IsSubTypeOf negative", "IsSubTypeOf('kugel_std', 'glastuer');");
console.log("--- fail-loud (expected ERR) ---");
show("part builtin not wired", "Feature(part, 'f_inosBoxRotation');", { part: { id: "p1" } });
show("unknown named-op", "call inosBoxNiedrig(part);", { part: {} });
