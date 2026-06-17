// Golden-test harness runner.
// Real flow (once P'X5 export exists): load fixtures/<name>/expected.json (from P'X5) and
// out/<name>.actual.json (from the engine), diff, gate CI on any mismatch.
// Until the engine produces placements, this demonstrates the diff logic with crafted snapshots
// so the harness is provably correct from day one.
import { diffSnapshots, report, quatAngleDeg } from "./diff.ts";
import type { Snapshot } from "./schema.ts";

// --- demo: a near-perfect engine output (within tolerance) ---
const expected: Snapshot = {
  project: "haller_glassdoor_L_350x350",
  pxVersion: "5.4.18",
  articles: [{ number: "GH-DOOR-350", qty: 1 }, { number: "GH-HINGE-L", qty: 2 }],
  parts: [
    { id: "door1", type: "glastuer_links350_350", pos: [0, 0, 0], quat: [0, 0, 0, 1] },
    { id: "hingeL", type: "glasscharnier_vorne_oben_l", pos: [11.55, 11.75, 0], quat: [0.707107, 0, 0, 0.707107] },
  ],
  conflicts: [],
};
const engineGood: Snapshot = {
  ...expected,
  parts: [
    { id: "door1", type: "glastuer_links350_350", pos: [0, 0, 0.0003], quat: [0, 0, 0, 1] }, // 0.3mm < 0.5mm
    { id: "hingeL", type: "glasscharnier_vorne_oben_l", pos: [11.55, 11.75, 0], quat: [0.7074, 0, 0, 0.70681] }, // ~0.03deg
  ],
};
// --- the bug we chased: hinge flipped about Z instead of X (180deg off-axis) ---
const engineBuggy: Snapshot = {
  ...expected,
  articles: [{ number: "GH-DOOR-350", qty: 1 }], // also dropped the hinge article
  parts: [
    { id: "door1", type: "glastuer_links350_350", pos: [0, 0, 0], quat: [0, 0, 0, 1] },
    { id: "hingeL", type: "glasscharnier_vorne_oben_l", pos: [11.55, 11.75, 0], quat: [0, 0.707107, 0.707107, 0] }, // wrong-axis flip
  ],
  conflicts: [{ type: "hasvolume_glashaltermix", parts: ["hingeL"] }],
};

console.log("=== golden harness self-check ===");
console.log(`  quat sanity: angle([-.707,0,0,.707] vs [.707,0,0,.707]) = ${quatAngleDeg([-0.707107,0,0,0.707107],[0.707107,0,0,0.707107]).toFixed(1)} deg (expect 180)`);
report("engine == oracle (within tol)", diffSnapshots(expected, engineGood));
report("engine has the glass-hinge bug", diffSnapshots(expected, engineBuggy));
console.log("\n  (drop a P'X5 export at fixtures/<name>/expected.json to wire the real oracle)");
