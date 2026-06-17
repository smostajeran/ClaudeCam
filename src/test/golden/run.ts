// Golden-test harness runner.
// If any fixtures/<name>/expected.json exists (from P'X5 via oracle/px5_export.vcml), build the
// engine snapshot for <name> and diff. Otherwise run a self-check demo proving the diff logic.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { diffSnapshots, report, quatAngleDeg } from "./diff.ts";
import type { Snapshot } from "./schema.ts";
import { buildSnapshot, eulerToQuat } from "../../engine/snapshot.ts";
import { SNX } from "../../import/paths.ts";

const FIX = "src/test/golden/fixtures";

// expected snapshots from P'X5 may carry euler `rot` instead of `quat`; normalize.
function normalize(s: Snapshot): Snapshot {
  for (const p of s.parts) if (!p.quat && p.rot) p.quat = eulerToQuat(p.rot[0], p.rot[1], p.rot[2]);
  return s;
}

const fixtures = existsSync(FIX) ? readdirSync(FIX).filter((d) => existsSync(`${FIX}/${d}/expected.json`)) : [];

if (fixtures.length) {
  console.log("=== golden tests vs P'X5 oracle ===");
  let pass = 0;
  for (const name of fixtures) {
    const expected = normalize(JSON.parse(readFileSync(`${FIX}/${name}/expected.json`, "utf8")));
    const sceneFile = `${SNX}/cartridge/parts/${name}.xml`;
    if (!existsSync(sceneFile)) { console.log(`  SKIP ${name} (no scene parts/${name}.xml)`); continue; }
    const d = diffSnapshots(expected, buildSnapshot(name, sceneFile));
    report(name, d);
    if (d.pass) pass++;
  }
  console.log(`=== ${pass}/${fixtures.length} fixtures pass ===`);
} else {
  // ---- self-check demo (proves the diff incl. placement + features) ----
  const expected: Snapshot = {
    project: "demo", articles: [{ number: "GH-HINGE-L", qty: 2 }],
    parts: [{ id: "hingeL", type: "glasscharnier_vorne_oben_l", pos: [115.5, 117.5, 0], quat: [0.707107, 0, 0, 0.707107], features: { beschlaegematerial: "C0" } }],
    conflicts: [],
  };
  const good: Snapshot = { ...expected, parts: [{ ...expected.parts[0], pos: [115.5, 117.5, 0.3], quat: [0.7074, 0, 0, 0.70681] }] };
  const buggy: Snapshot = {
    ...expected, articles: [],
    parts: [{ id: "hingeL", type: "glasscharnier_vorne_oben_l", pos: [115.5, 117.5, 0], quat: [0, 0.707107, 0.707107, 0], features: { beschlaegematerial: "B0" } }],
    conflicts: [{ type: "hasvolume_glashaltermix", parts: ["hingeL"] }],
  };
  console.log("=== golden harness self-check (no P'X5 fixtures yet) ===");
  console.log(`  quat sanity 180deg: ${quatAngleDeg([-0.707107, 0, 0, 0.707107], [0.707107, 0, 0, 0.707107]).toFixed(1)}`);
  report("engine == oracle (within tol)", diffSnapshots(expected, good));
  report("engine has the glass-hinge bug", diffSnapshots(expected, buggy));
  console.log("\n  To activate the real oracle: run oracle/px5_export.vcml in P'X5 with a project open,");
  console.log("  save its JSON to fixtures/<name>/expected.json (name a parts/<name>.xml scene), then re-run.");
}
