// Interactive placement by CONFIG MUTATION + RE-SOLVE. The engine is a batch .px5 -> solve pipeline,
// so a "drop" = add the part as a <componentset> + <connecteddock> wiring to a working config.px5 and
// re-run the REAL solver (USE_STORED_MATES). No reinvented placement math — the dock solver + mate
// table place the added part exactly as they place any saved part. This module owns only the wiring:
// resolve the target slot to FREE sockets on existing parts, allocate dock ids, and emit the XML.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { loadAllDockFrames } from "./dockframes.ts";
import { euler, applyPoint } from "./geom.ts";
import type { Vec3 } from "./geom.ts";

const FRAMES = loadAllDockFrames();

// ---- config parsing (componentsets are flat siblings; one <connecteddock> per occupied socket) ----
export interface Dock { type: string; index: number; dockid: number; connId: number }
export interface CPart { id: string; type: string; pos: Vec3; rot: Vec3; docks: Dock[]; block: string }
const attrOf = (s: string, name: string) => (s.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

export function parseConfig(xml: string): { parts: CPart[]; maxDockId: number } {
  const parts: CPart[] = []; let maxDockId = 0;
  const re = /<componentset\b[\s\S]*?<\/componentset>/g; let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const open = block.slice(0, block.indexOf(">") + 1);
    const id = attrOf(open, "_PXI_unique_comp_id") ?? "";
    const type = attrOf(open, "type") ?? "";
    const pm = block.match(/<pos\b[^>]*\/>/)?.[0] ?? "", rm = block.match(/<rot\b[^>]*\/>/)?.[0] ?? "";
    const pos: Vec3 = [+(attrOf(pm, "x") ?? 0), +(attrOf(pm, "y") ?? 0), +(attrOf(pm, "z") ?? 0)];
    const rot: Vec3 = [+(attrOf(rm, "x") ?? 0), +(attrOf(rm, "y") ?? 0), +(attrOf(rm, "z") ?? 0)];
    const docks: Dock[] = [];
    for (const dm of block.match(/<connecteddock\b[^>]*\/>/g) ?? []) {
      const d: Dock = { type: attrOf(dm, "type") ?? "", index: +(attrOf(dm, "index") ?? 1), dockid: +(attrOf(dm, "dockid") ?? 0), connId: +(attrOf(dm, "connecteddockid") ?? 0) };
      docks.push(d); maxDockId = Math.max(maxDockId, d.dockid, d.connId);
    }
    parts.push({ id, type, pos, rot, docks, block });
  }
  return { parts, maxDockId };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The ball socket (kugel2rohr#i, i in 1..6) whose WORLD direction points at `target`. A socket is
// FREE iff no <connecteddock> sits at that index on the ball (any directional dock TYPE shares the
// index space — kugel2rohr#1 and kugel2bodenelement#1 are the same physical +Y socket).
export function facingSocket(ball: CPart, target: Vec3): number | null {
  const R = euler(ball.rot[0], ball.rot[1], ball.rot[2], "XYZ");
  const want = norm(sub(target, ball.pos));
  const sockets = (FRAMES.get(ball.type) ?? []).filter((f) => f.dockType === "kugel2rohr");
  let best: number | null = null, bd = 0.9;                  // require real alignment (cos > 0.9 ~ within 25°)
  for (const s of sockets) {
    const wd = norm(applyPoint(R, s.t as Vec3));             // euler() has no translation -> pure rotation
    const c = dot(wd, want);
    if (c > bd) { bd = c; best = s.index; }
  }
  if (best == null) return null;
  if (ball.docks.some((d) => d.index === best)) return null; // socket occupied (by a tube, foot, etc.)
  return best;
}

const ownerOfDockId = (parts: CPart[], dockid: number) => parts.find((p) => p.docks.some((d) => d.dockid === dockid));
const addDock = (block: string, line: string) => block.replace(/\n(\s*)<\/componentset>/, `\n\t\t\t${line}\n$1</componentset>`);

function tubeBlock(id: string, type: string, pos: Vec3, tA: number, dA: number, tB: number, dB: number): string {
  return `\t\t<componentset type="${type}" dockconnections="true" _PXI_unique_comp_id="${id}" uuid="added-${id}-0000-0000-000000000000">\n` +
    `\t\t\t<pos x="${pos[0]}" y="${pos[1]}" z="${pos[2]}"/>\n` +
    `\t\t\t<rot x="-90" y="0" z="0"/>\n` +
    `\t\t\t<features f_artnr="10736" Mounted="true" calculated="true"/>\n` +
    `\t\t\t<connecteddock type="rohr2kugel" index="1" dockid="${tA}" connecteddockid="${dA}"/>\n` +
    `\t\t\t<connecteddock type="rohr2kugel" index="2" dockid="${tB}" connecteddockid="${dB}"/>\n` +
    `\t\t</componentset>`;
}

// Add a tube on the EDGE between two existing balls (both ends fully constrained = deterministic).
export function addTubeOnEdge(xml: string, idA: string, idB: string, tubeType = "rohr350"): { xml: string; newId: string } {
  const { parts, maxDockId } = parseConfig(xml);
  const A = parts.find((p) => p.id === idA), B = parts.find((p) => p.id === idB);
  if (!A || !B) throw new Error(`ball not found: ${!A ? idA : idB}`);
  const iA = facingSocket(A, B.pos), iB = facingSocket(B, A.pos);
  if (iA == null) throw new Error(`ball ${idA} has no free socket facing ${idB}`);
  if (iB == null) throw new Error(`ball ${idB} has no free socket facing ${idA}`);
  let nid = maxDockId; const dA = ++nid, tA = ++nid, dB = ++nid, tB = ++nid;
  const newId = String(Math.max(0, ...parts.map((p) => +p.id || 0)) + 1);
  const mid: Vec3 = [(A.pos[0] + B.pos[0]) / 2, (A.pos[1] + B.pos[1]) / 2, (A.pos[2] + B.pos[2]) / 2];
  const tube = tubeBlock(newId, tubeType, mid, tA, dA, tB, dB);
  let out = xml.replace(A.block, addDock(A.block, `<connecteddock type="kugel2rohr" index="${iA}" dockid="${dA}" connecteddockid="${tA}"/>`));
  const modB = addDock(B.block, `<connecteddock type="kugel2rohr" index="${iB}" dockid="${dB}" connecteddockid="${tB}"/>`);
  out = out.replace(B.block, modB + "\n" + tube);
  return { xml: out, newId };
}

// Remove a part: delete its componentset and any <connecteddock> on OTHER parts that point into it.
export function removePart(xml: string, partId: string): string {
  const { parts } = parseConfig(xml);
  const T = parts.find((p) => p.id === partId);
  if (!T) throw new Error(`part not found: ${partId}`);
  const theirIds = new Set(T.docks.map((d) => d.dockid));
  let out = xml;
  for (const p of parts) {
    if (p.id === partId) continue;
    let mod = p.block;
    for (const d of p.docks) if (theirIds.has(d.connId)) mod = mod.replace(new RegExp(`\\n\\s*<connecteddock\\b[^>]*\\bdockid="${d.dockid}"[^>]*/>`), "");
    if (mod !== p.block) out = out.replace(p.block, mod);
  }
  return out.replace("\n" + T.block, "").replace(T.block, "");
}

// ---- panels/sheets on a FACE: 4 corner balls -> 4 edge tubes, each wired via its INWARD rohr2blech ----
const dockMap = (parts: CPart[]) => { const m = new Map<number, CPart>(); for (const p of parts) for (const d of p.docks) m.set(d.dockid, p); return m; };
const tubeBalls = (t: CPart, byDock: Map<number, CPart>) => t.docks.filter((d) => d.type === "rohr2kugel").map((d) => byDock.get(d.connId)?.id).filter(Boolean) as string[];
function findEdgeTube(parts: CPart[], byDock: Map<number, CPart>, a: string, b: string): CPart | null {
  for (const p of parts) { if (!/^rohr/.test(p.type)) continue; const bs = tubeBalls(p, byDock); if (bs.length === 2 && bs.includes(a) && bs.includes(b)) return p; }
  return null;
}
// The tube's FREE rohr2blech socket whose WORLD direction points toward the rect centre (the panel side).
export function inwardBlechIndex(tube: CPart, center: Vec3): number | null {
  const R = euler(tube.rot[0], tube.rot[1], tube.rot[2], "XYZ");
  const want = norm(sub(center, tube.pos));
  let best: number | null = null, bd = 0.5;
  for (const s of (FRAMES.get(tube.type) ?? []).filter((f) => f.dockType === "rohr2blech")) {
    const c = dot(norm(applyPoint(R, s.t as Vec3)), want);
    if (c > bd) { bd = c; best = s.index; }
  }
  if (best == null) return null;
  if (tube.docks.some((d) => d.type === "rohr2blech" && d.index === best)) return null; // that face already clad (occupancy by tube+index)
  return best;
}

// Add a flat part (metal panel) on the face bounded by 4 corner balls given in rect cycle order.
// `rotation` (0..3) shifts which panel edge-dock maps to which tube — for a NON-square panel only the
// dimension-matching rotations place (the others wire a long-edge dock to a short tube whose mate is
// absent). The caller (route) re-solves each rotation and keeps the one that lands at the rect centre.
export function addPanelOnFace(xml: string, corners: string[], panelType = "blech350_350", rotation = 0): { xml: string; newId: string; center: Vec3 } {
  if (corners.length !== 4) throw new Error("a face needs exactly 4 corner ball ids (rect order)");
  const { parts, maxDockId } = parseConfig(xml);
  const byDock = dockMap(parts);
  const tubes: CPart[] = [];
  for (let i = 0; i < 4; i++) { const t = findEdgeTube(parts, byDock, corners[i], corners[(i + 1) % 4]); if (!t) throw new Error(`no edge tube between ${corners[i]} and ${corners[(i + 1) % 4]}`); tubes.push(t); }
  const balls = corners.map((id) => { const p = parts.find((x) => x.id === id); if (!p) throw new Error(`corner ball not found: ${id}`); return p; });
  const center: Vec3 = [0, 0, 0]; for (const b of balls) for (let k = 0; k < 3; k++) center[k] += b.pos[k] / 4;
  // gap-vs-length guard: the compartment's two edge lengths must match the panel's nominal size, else
  // a 350×750 sheet would be wired into a 350×350 bay (the solver can't make that fit).
  const dm = panelType.match(/(\d+)_(\d+)/);
  if (dm) {
    const pa = +dm[1] / 10, pb = +dm[2] / 10;
    const e0 = Math.hypot(...(sub(balls[1].pos, balls[0].pos))), e1 = Math.hypot(...(sub(balls[2].pos, balls[1].pos)));
    const near = (a: number, b: number) => Math.abs(a - b) < 2.5;
    if (!((near(e0, pa) && near(e1, pb)) || (near(e0, pb) && near(e1, pa))))
      throw new Error(`panel ${pa}×${pb}cm doesn't fit compartment ${e0.toFixed(0)}×${e1.toFixed(0)}cm`);
  }
  const idx = tubes.map((t) => inwardBlechIndex(t, center));
  for (let i = 0; i < 4; i++) if (idx[i] == null) throw new Error(`tube #${tubes[i].id} has no free inward panel face (already clad?)`);
  let nid = maxDockId; const pd = [++nid, ++nid, ++nid, ++nid], td = [++nid, ++nid, ++nid, ++nid];
  const newId = String(Math.max(0, ...parts.map((p) => +p.id || 0)) + 1);
  let panel = `\t\t<componentset type="${panelType}" dockconnections="true" _PXI_unique_comp_id="${newId}" uuid="added-${newId}-0000-0000-000000000000">\n` +
    `\t\t\t<pos x="${center[0]}" y="${center[1]}" z="${center[2]}"/>\n\t\t\t<rot x="-90" y="0" z="0"/>\n\t\t\t<features Mounted="true" calculated="true"/>\n`;
  // tube i ↔ panel edge-dock #(((i+rotation)%4)+1)
  for (let i = 0; i < 4; i++) panel += `\t\t\t<connecteddock type="blech2rohr" index="${((i + rotation) % 4) + 1}" dockid="${pd[i]}" connecteddockid="${td[i]}"/>\n`;
  panel += `\t\t</componentset>`;
  let out = xml;
  for (let i = 0; i < 4; i++) out = out.replace(tubes[i].block, addDock(tubes[i].block, `<connecteddock type="rohr2blech" index="${idx[i]}" dockid="${td[i]}" connecteddockid="${pd[i]}"/>`));
  out = out.replace(balls[0].block, balls[0].block + "\n" + panel);
  const wiring = tubes.map((t, i) => ({ panelDock: ((i + rotation) % 4) + 1, tubeId: t.id, tubeIndex: idx[i]! }));
  return { xml: out, newId, center, wiring };
}

// LOOP-CLOSURE check: max gap between each wired panel-dock and its tube-dock in the SOLVED scene.
// Catches a centred-but-rotated panel (right pos, wrong orientation) that a position check misses.
const qrot = (q: number[], v: Vec3): Vec3 => { const x = q[0], y = q[1], z = q[2], w = q[3], a = v[0], b = v[1], c = v[2];
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)]; };
export function panelFitResidual(placement: any, addedId: string, wiring: { panelDock: number; tubeId: string; tubeIndex: number }[]): number {
  const byId = new Map<string, any>((placement.parts ?? []).map((p: any) => [p.id, p]));
  const panel = byId.get(addedId);
  if (!panel || panel.placed === false) return Infinity;
  let maxd = 0;
  for (const w of wiring) {
    const tube = byId.get(w.tubeId); if (!tube) return Infinity;
    const pf = (FRAMES.get(panel.type) ?? []).find((f) => f.dockType === "blech2rohr" && f.index === w.panelDock);
    const tf = (FRAMES.get(tube.type) ?? []).find((f) => f.dockType === "rohr2blech" && f.index === w.tubeIndex);
    if (!pf || !tf) return Infinity;
    const pw = qrot(panel.quat, pf.t as Vec3), tw = qrot(tube.quat, tf.t as Vec3);
    maxd = Math.max(maxd, Math.hypot(panel.pos[0] + pw[0] - tube.pos[0] - tw[0], panel.pos[1] + pw[1] - tube.pos[1] - tw[1], panel.pos[2] + pw[2] - tube.pos[2] - tw[2]));
  }
  return maxd;
}

// derive corner balls of an existing panel in rect cycle order (test helper)
function cycleCorners(parts: CPart[], byDock: Map<number, CPart>, panel: CPart): string[] {
  const tubes = panel.docks.filter((d) => d.type === "blech2rohr").map((d) => byDock.get(d.connId)).filter(Boolean) as CPart[];
  const edges = tubes.map((t) => tubeBalls(t, byDock));
  const order: string[] = [edges[0][0], edges[0][1]]; const used = new Set([0]);
  while (order.length < 4) { const last = order[order.length - 1]; let adv = false;
    for (let i = 0; i < edges.length; i++) { if (used.has(i)) continue; if (edges[i].includes(last)) { const nxt = edges[i][0] === last ? edges[i][1] : edges[i][0]; if (!order.includes(nxt)) { order.push(nxt); used.add(i); adv = true; break; } } }
    if (!adv) break;
  }
  return order;
}

// ---- self-test: remove an existing tube, re-add it via our wiring, re-solve, expect it back ----
if (process.argv[1]?.endsWith("place.ts")) {
  const CFG = process.argv[2] ?? "oracle/test_project/K4_admi_2026061780565/5/config.px5";
  const xml = readFileSync(CFG, "utf8");
  const { parts } = parseConfig(xml);
  // a pure structural tube: two ball ends, no panel/glass attachments (clean remove)
  const tube = parts.find((p) => /^rohr\d+$/.test(p.type) && p.docks.filter((d) => d.type === "rohr2kugel").length === 2 && !p.docks.some((d) => d.type !== "rohr2kugel"));
  if (!tube) { console.log("no clean structural tube found"); process.exit(0); }
  const ballIds = tube.docks.filter((d) => d.type === "rohr2kugel").map((d) => ownerOfDockId(parts, d.connId)?.id).filter(Boolean) as string[];
  console.log(`round-trip: tube #${tube.id} (${tube.type}) between balls ${ballIds.join(", ")}  saved pos=[${tube.pos.map((x) => +x.toFixed(2))}]`);
  const removed = removePart(xml, tube.id);
  const { xml: readded, newId } = addTubeOnEdge(removed, ballIds[0], ballIds[1], tube.type);
  const WORK = "out/place_test.px5"; writeFileSync(WORK, readded);
  console.log(`re-added as #${newId}; re-solving (USE_STORED_MATES)…`);
  const r = spawnSync(process.execPath, ["src/engine/solve.ts", WORK], { encoding: "utf8", timeout: 120000, env: { ...process.env, USE_STORED_MATES: "1" } });
  if (r.status !== 0) { console.log("solve failed:\n" + (r.stdout ?? "").slice(-800) + (r.stderr ?? "")); process.exit(1); }
  const pl = JSON.parse(readFileSync("out/placement.json", "utf8"));
  const placed = pl.parts.find((p: any) => p.id === newId);
  if (!placed) { console.log("re-added tube not in placement output"); process.exit(1); }
  const d = Math.hypot(placed.pos[0] - tube.pos[0], placed.pos[1] - tube.pos[1], placed.pos[2] - tube.pos[2]);
  console.log(`re-added tube placed at [${placed.pos.map((x: number) => +x.toFixed(2))}]  placed=${placed.placed !== false}  Δ vs original = ${d.toFixed(2)} cm`);
  console.log(d < 1 ? "  ✓ ROUND-TRIP OK — config-mutation wiring places the tube where it was" : "  ✗ off — wiring or mate-coverage issue");

  // panel round-trip incl. NON-SQUARE: re-place via addPanelOnFace, rotation-retry VALIDATED BY THE
  // loop-closure residual (catches centred-but-rotated), mirroring the route.
  console.log("\npanel round-trips (residual-validated rotation-retry):");
  const byDock = dockMap(parts);
  const place = (srcXml: string, corners: string[], type: string) => {
    for (let rot = 0; rot < 4; rot++) {
      let cand; try { cand = addPanelOnFace(srcXml, corners, type, rot); } catch (e: any) { return { rot: -1, res: Infinity, msg: String(e?.message ?? e) }; }
      writeFileSync(WORK, cand.xml);
      if (spawnSync(process.execPath, ["src/engine/solve.ts", WORK], { encoding: "utf8", timeout: 120000, env: { ...process.env, USE_STORED_MATES: "1" } }).status !== 0) continue;
      const res = panelFitResidual(JSON.parse(readFileSync("out/placement.json", "utf8")), cand.newId, cand.wiring);
      if (res < 0.5) return { rot, res, msg: "" };
    }
    return { rot: -1, res: Infinity, msg: "no rotation fits" };
  };
  const seen = new Set<string>();
  for (const panel of parts.filter((p) => /^blech\d/.test(p.type) && p.docks.filter((d) => d.type === "blech2rohr").length === 4)) {
    if (seen.has(panel.type)) continue; seen.add(panel.type);
    const corners = cycleCorners(parts, byDock, panel);
    const removed2 = removePart(xml, panel.id);
    const a = place(removed2, corners, panel.type);
    console.log(`  ${panel.type.padEnd(13)} corners=[${corners}]: ${a.rot >= 0 ? `✓ rotation ${a.rot}  residual=${a.res.toFixed(2)}cm` : `✗ ${a.msg}`}`);
    if (panel.type !== "blech350_350") {   // exercise retry on a misaligned start (non-square only)
      const mis = [corners[1], corners[2], corners[3], corners[0]];
      const b = place(removed2, mis, panel.type);
      console.log(`     misaligned [${mis}]: ${b.rot >= 0 ? `✓ recovered at rotation ${b.rot}  residual=${b.res.toFixed(2)}cm` : `✗ ${b.msg}`}`);
    }
  }
}
