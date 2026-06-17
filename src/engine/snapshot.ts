// Emit an engine "actual" snapshot from a loaded scene: per-part type, placement, and the
// engine-COMPUTED features (evaluate each applicable property defaultExpr). This is what the
// golden harness diffs against the P'X5 "expected" snapshot.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadAppcodes } from "../vcml/appcode.ts";
import { evalVCML } from "../vcml/interp.ts";
import { Host } from "./partgraph.ts";
import { loadScene, installPartFns } from "./scene.ts";
import type { ScenePart } from "./scene.ts";
import { APPCODES_DIR, SNX } from "../import/paths.ts";
import type { Snapshot, PartSnap } from "../test/golden/schema.ts";

const D = Math.PI / 180;
function axisQ(x: number, y: number, z: number, a: number): number[] { const s = Math.sin(a / 2); return [x * s, y * s, z * s, Math.cos(a / 2)]; }
function qmul(a: number[], b: number[]): number[] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
// intrinsic XYZ Euler (degrees, source Z-up) -> quaternion [x,y,z,w]
export function eulerToQuat(rx: number, ry: number, rz: number): [number, number, number, number] {
  const q = qmul(qmul(axisQ(1, 0, 0, rx * D), axisQ(0, 1, 0, ry * D)), axisQ(0, 0, 1, rz * D));
  return [q[0], q[1], q[2], q[3]];
}

export function buildSnapshot(project: string, sceneFile: string): Snapshot {
  const model = JSON.parse(readFileSync("out/model.json", "utf8"));
  const host = new Host(model.components, { scenario: "co" });
  (host as any).namedOps = loadAppcodes(APPCODES_DIR);
  const scene = loadScene(sceneFile);
  installPartFns(host, scene);

  const isExpr = (s: unknown) => typeof s === "string" && /[A-Za-z_]\w*\s*\(|;|\bcall\b/.test(s);
  const props = model.properties.filter((p: any) => isExpr(p.defaultExpr));
  const applies = (p: any, type: string) => p.assignedTo.some((t: string) => type === t || host.isSubTypeOf(type, t));

  const parts: PartSnap[] = scene.map((part: ScenePart, i: number) => {
    host.current = part as any;
    const features: Record<string, unknown> = {};
    // stored features from the .par
    for (const [k, v] of part.features) features[k] = v;
    // engine-computed features (evaluate applicable property expressions)
    for (const p of props) {
      if (!applies(p, part.type)) continue;
      try { features[p.feature] = evalVCML(String(p.defaultExpr), host, { part }); } catch { /* leave unset */ }
    }
    return {
      id: part.id || String(i),
      type: part.type,
      pos: [part.pos.x * 10, part.pos.y * 10, part.pos.z * 10], // cm -> mm
      quat: eulerToQuat(part.rot.x, part.rot.y, part.rot.z),
    } as PartSnap & { features?: unknown };
  });
  // attach features alongside (PartSnap is the comparable core; features carried for the oracle)
  parts.forEach((p, i) => { (p as any).features = scene[i] ? collectFeatures(scene[i], host, props, applies) : {}; });

  return { project, pxVersion: "engine", articles: [], parts, conflicts: [] };
}

function collectFeatures(part: ScenePart, host: Host, props: any[], applies: (p: any, t: string) => boolean): Record<string, unknown> {
  host.current = part as any;
  const f: Record<string, unknown> = {};
  for (const p of props) if (applies(p, part.type)) { try { f[p.feature] = evalVCML(String(p.defaultExpr), host, { part }); } catch { /* skip */ } }
  return f;
}

// CLI (only when run directly, not when imported): node src/engine/snapshot.ts <project> [sceneFile]
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/snapshot.ts")) {
  const project = process.argv[2] ?? "normal_volume";
  const sceneFile = process.argv[3] ?? `${SNX}/cartridge/parts/${project}.xml`;
  if (existsSync(sceneFile)) {
    const snap = buildSnapshot(project, sceneFile);
    writeFileSync(`out/${project}.actual.json`, JSON.stringify(snap, null, 2));
    const featTotal = snap.parts.reduce((s, p) => s + Object.keys((p as any).features ?? {}).length, 0);
    console.log(`=== actual snapshot: ${project} ===`);
    console.log(`  parts: ${snap.parts.length}   computed features: ${featTotal}`);
    console.log("  sample:", JSON.stringify({ ...snap.parts[0], features: undefined }), "feat:", JSON.stringify((snap.parts[0] as any).features).slice(0, 120) + "…");
    console.log(`  -> out/${project}.actual.json`);
  } else console.log(`scene not found: ${sceneFile}`);
}
