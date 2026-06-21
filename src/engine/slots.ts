// Open placement slots for the interactive client. A "face slot" is a rectangular bay bounded by 4
// edge tubes that has NO panel on its inward side yet — i.e. somewhere the user can drop a sheet panel.
// We find it from the SOLVED config graph (balls + tubes) and reuse place.ts's exact openness test
// (inwardBlechIndex): a bay is open iff all 4 bounding tubes have a FREE inward rohr2blech socket — the
// same condition addPanelOnFace requires to place a panel. So every emitted slot is one the engine can
// actually fill, and every fillable face is emitted. IP-safe: only opaque part ids (the same Part.id the
// payload already exposes) + RealityKit-frame corners cross the boundary — no German types, no .px5.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseConfig, dockMap, tubeBalls, findEdgeTube, inwardBlechIndex } from "./place.ts";
import type { CPart } from "./place.ts";
import type { Vec3 } from "./geom.ts";
import { posToRK } from "./export_ios.ts";

export interface FaceSlot {
  slotId: string;            // stable, opaque: "face:" + sorted corner ids
  kind: "face";
  corners: string[];         // 4 corner ball ids in rect cycle order (= Part.id, what /api/place wants)
  quad: number[][];          // 4 world corners, RealityKit metres/Y-up (for the ghost drop-target)
  dims: [number, number];    // bay edge lengths in cm (so the client offers only sizes that fit)
  accepts: string[];         // one52 families that drop into a tube-bounded face
}

const SHEET_FAMILIES = ["panel"]; // solid + perforated + biblio sheets are all family "panel"
const len = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// All open (panel-less) tube-bounded faces in a solved scene. `placement` supplies world positions for
// the output quad; the config graph (`xml`) supplies topology + dock occupancy for the openness test.
export function openFaceSlots(xml: string, placement: any): FaceSlot[] {
  const { parts } = parseConfig(xml);
  const byDock = dockMap(parts);
  const balls = parts.filter((p) => /^kugel/i.test(p.type));
  const tubes = parts.filter((p) => /^rohr/.test(p.type));

  // ball-adjacency via tubes (each structural tube joins exactly two balls)
  const adj = new Map<string, Set<string>>();
  for (const b of balls) adj.set(b.id, new Set());
  for (const t of tubes) { const bs = tubeBalls(t, byDock); if (bs.length === 2) { adj.get(bs[0])?.add(bs[1]); adj.get(bs[1])?.add(bs[0]); } }

  const cpos = new Map<string, Vec3>(); for (const b of balls) cpos.set(b.id, b.pos);     // config frame (cm) — for the geometry test
  const wpos = new Map<string, number[]>(); for (const pp of placement.parts ?? []) wpos.set(pp.id, posToRK(pp.pos)); // solved → metres

  const seen = new Set<string>();
  const out: FaceSlot[] = [];
  for (const [v, ns] of adj) {
    const neigh = [...ns];
    for (let i = 0; i < neigh.length; i++) for (let j = i + 1; j < neigh.length; j++) {
      const n1 = neigh[i], n2 = neigh[j];
      // 4th corner = a common neighbour of n1 and n2 other than v -> rectangle v-n1-w-n2
      for (const w of adj.get(n1) ?? []) {
        if (w === v || !adj.get(n2)?.has(w)) continue;
        const cyc = [v, n1, w, n2];
        const key = [...cyc].sort().join("-");
        if (seen.has(key)) continue; seen.add(key);

        // all 4 edges must carry a tube
        const edgeTubes: CPart[] = [];
        let ok = true;
        for (let k = 0; k < 4 && ok; k++) { const t = findEdgeTube(parts, byDock, cyc[k], cyc[(k + 1) % 4]); if (t) edgeTubes.push(t); else ok = false; }
        if (!ok) continue;

        // bay centre (config cm) — same as addPanelOnFace
        const ctr: Vec3 = [0, 0, 0]; for (const id of cyc) { const p = cpos.get(id)!; ctr[0] += p[0] / 4; ctr[1] += p[1] / 4; ctr[2] += p[2] / 4; }
        // OPEN iff every bounding tube still has a free inward panel face toward the centre
        if (!edgeTubes.every((t) => inwardBlechIndex(t, ctr) != null)) continue;

        const e0 = Math.round(len(cpos.get(v)!, cpos.get(n1)!)), e1 = Math.round(len(cpos.get(n1)!, cpos.get(w)!));
        const quad = cyc.map((id) => wpos.get(id) ?? posToRK(cpos.get(id)!));
        out.push({ slotId: "face:" + key, kind: "face", corners: cyc, quad, dims: [e0, e1], accepts: SHEET_FAMILIES });
      }
    }
  }
  return out;
}

// self-test: solve a config, list its open face slots, and assert each is one addPanelOnFace would accept
if (process.argv[1]?.endsWith("slots.ts")) {
  const CFG = process.argv[2];
  if (!CFG) { console.log("usage: node src/engine/slots.ts <config.px5>"); process.exit(0); }
  const xml = readFileSync(CFG, "utf8");
  const r = spawnSync(process.execPath, ["src/engine/solve.ts", CFG], { encoding: "utf8", timeout: 120000, env: { ...process.env, USE_STORED_MATES: "1" } });
  if (r.status !== 0) { console.log("solve failed:\n" + (r.stdout ?? "").slice(-600) + (r.stderr ?? "")); process.exit(1); }
  const placement = JSON.parse(readFileSync("out/placement.json", "utf8"));
  const slots = openFaceSlots(xml, placement);
  console.log(`${slots.length} open face slot(s):`);
  for (const s of slots) console.log(`  ${s.slotId.padEnd(22)} dims=${s.dims[0]}x${s.dims[1]}cm corners=[${s.corners}] quad0=[${s.quad[0].map((x) => +x.toFixed(2))}]`);
  // count existing panels for context
  const panels = (placement.parts ?? []).filter((p: any) => /^(blech|lochblech|perfblech|kurzblech|biblioblech)\d/.test(p.type) && p.placed !== false).length;
  console.log(`(scene has ${panels} panel(s) already placed)`);
}
