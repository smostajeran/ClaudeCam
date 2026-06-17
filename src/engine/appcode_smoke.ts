// Prove appcode named-ops load and run (the 36%-of-calls bucket), on a real scene.
import { readFileSync } from "node:fs";
import { loadAppcodes } from "../vcml/appcode.ts";
import { evalVCML } from "../vcml/interp.ts";
import { Host } from "./partgraph.ts";
import { loadScene, installPartFns } from "./scene.ts";
import { APPCODES_DIR, SNX } from "../import/paths.ts";

const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const ops = loadAppcodes(APPCODES_DIR);
const host = new Host(model.components, { scenario: "co" });
(host as any).namedOps = ops;

const scene = loadScene(`${SNX}/cartridge/parts/as_schublade_A4_s.xml`);
installPartFns(host, scene);
host.current = scene[0] as any;

console.log(`=== appcode named-ops loaded: ${ops.size} ===`);
console.log("  sample defs:", [...ops.keys()].filter((k) => ["setChromMaterial", "geomHQ", "inosBoxNiedrig", "rohrMaterial", "getDoorLength"].includes(k)).join(", "));

const run = (label: string, src: string) => {
  try { console.log(`  OK  ${label}  =>  ${JSON.stringify(evalVCML(src, host, { part: scene[0] }))}`); }
  catch (e: any) { console.log(`  ERR ${label}  =>  ${e.message}`); }
};
console.log("=== run loaded named-ops on a real part ===");
run("setChromMaterial(part)", "call setChromMaterial(part);");
run("geomHQ()", "call geomHQ();");
run("decision via named-op", "call setChromMaterial(part) eq '-101' ? 'chrome-101' : 'other';");
