// Prove the part-dependent builtins work on a REAL loaded prototype scene.
import { readFileSync } from "node:fs";
import { loadScene, installPartFns } from "./scene.ts";
import { Host } from "./partgraph.ts";
import { evalVCML } from "../vcml/interp.ts";

const SNX = "C:/Virtual-LastU/snx2xml/co/packages/hallerpackage/cartridge/parts";
const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const host = new Host(model.components, { scenario: "co" });

const scene = loadScene(`${SNX}/as_schublade_A4_s.xml`);
installPartFns(host, scene);
console.log("=== loaded scene: as_schublade_A4_s ===");
for (const p of scene) console.log(`  part ${p.id} ${p.type}  features={${[...p.features.keys()].join(",")}}  docks=[${p.docks.map((d) => d.type + "->" + (d.connectedPart?.type ?? "·")).join(", ")}]`);

const lock = scene.find((p) => p.type === "schublade_schloss_num")!;
host.current = lock as any;
const run = (src: string) => {
  try { console.log(`  OK  ${src}  =>  ${JSON.stringify(evalVCML(src, host, { part: lock }))}`); }
  catch (e: any) { console.log(`  ERR ${src}  =>  ${e.message}`); }
};
console.log("=== part-builtins on real parts (part = the lock) ===");
run("GetTypeName(part);");
run("Feature(part, 'Griff');");
run("Feature('Mounted');");                                   // 1-arg form -> host.current
run("IsSubTypeOf(GetTypeName(part), 'haller_shelf_component');");
run("GetTypeName(DockGetConnectedPart(Dock(part, 'schloss2schublade')));"); // follow the dock link
run("Size(GetComponentListOfType('schublade_schloss_num'));");
run("Feature(part,'Griff') eq 'schublade_schloss_num' ? 'is-lock' : 'other';");
