// PLACEMENT SOLVER: compute every part's world transform purely from dock-frame composition,
// anchored at one part's saved transform, then validate against P'X5's saved pos/rot.
//   W_child = W_parent * Frame(dockA) * inv(Frame(dockB))     (mate convention M = identity)
// Euler order XYZ (calibrated). Dock rotations may be VCML -> evaluated via the interpreter.
import { readdirSync, readFileSync } from "node:fs";
import { parseXmlFile, tagOf, attr, kids, byTag } from "../xml/parse.ts";
import { loadDockFrames } from "./dockframes.ts";
import { loadScene, installPartFns } from "./scene.ts";
import { Host } from "./partgraph.ts";
import { loadAppcodes } from "../vcml/appcode.ts";
import { evalVCML } from "../vcml/interp.ts";
import { APPCODES_DIR } from "../import/paths.ts";
import { trs, mul, invRigid, euler, ident, getTranslation, matToQuat, quatAngleDeg, dist } from "./geom.ts";
import type { Mat4, Vec3 } from "./geom.ts";

function findFile(dir: string, name: string): string | null {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (f.name === name) return p;
  }
  return null;
}
const cfg = process.argv[2] ?? findFile("oracle/test_project", "config.px5");
if (!cfg) { console.log("no config.px5 (extract a .pxpz into oracle/test_project)"); process.exit(0); }

interface GPart { id: string; type: string; pos: Vec3; rot: Vec3; docks: { type: string; index: number; dockid: string; partner: string }[] }
const num = (s: string | undefined) => { const n = Number(s); return Number.isNaN(n) ? 0 : n; };
const root = parseXmlFile(cfg);
const csNodes: any[] = [];
(function collect(nodes: any[]) { for (const n of nodes) { if (tagOf(n) === "componentset") csNodes.push(n); const k = kids(n); if (k.length) collect(k); } })(root);
const parts: GPart[] = csNodes.map((cs, i) => {
  const k = kids(cs); const pos = byTag(k, "pos")[0], rot = byTag(k, "rot")[0];
  return {
    id: attr(cs, "_PXI_unique_comp_id") ?? String(i), type: attr(cs, "type")!,
    pos: [num(attr(pos, "x")), num(attr(pos, "y")), num(attr(pos, "z"))],
    rot: [num(attr(rot, "x")), num(attr(rot, "y")), num(attr(rot, "z"))],
    docks: byTag(k, "connecteddock").map((d) => ({ type: attr(d, "type")!, index: num(attr(d, "index")) || 1, dockid: attr(d, "dockid")!, partner: attr(d, "connecteddockid")! })),
  };
});
const byId = new Map(parts.map((p) => [p.id, p]));
const byDockId = new Map<string, { p: GPart; type: string; index: number }>();
for (const p of parts) for (const d of p.docks) byDockId.set(d.dockid, { p, type: d.type, index: d.index });

// host (for VCML dock rotations) + dock frames
const frames = loadDockFrames();
const frameOf = (ptype: string, dtype: string, index: number) => (frames.get(ptype) ?? []).find((f) => f.dockType === dtype && f.index === index);
const model = JSON.parse(readFileSync("out/model.json", "utf8"));
const host = new Host(model.components, { scenario: "co" });
(host as any).namedOps = loadAppcodes(APPCODES_DIR);
const scene = loadScene(cfg);
installPartFns(host, scene);
const sceneById = new Map(scene.map((s) => [s.id, s]));

let vcmlOk = 0, vcmlFail = 0;
const matCache = new Map<string, Mat4>();
function frameMat(p: GPart, f: any): Mat4 {
  const key = `${p.id}|${f.dockType}#${f.index}`;
  const hit = matCache.get(key); if (hit) return hit;
  const r = f.r.map((s: string) => {
    const n = Number(s); if (!Number.isNaN(n)) return n;
    try { const sp = sceneById.get(p.id); if (sp) host.current = sp as any; const v = Number(evalVCML(String(s), host, { part: host.current })); vcmlOk++; return Number.isNaN(v) ? 0 : v; }
    catch { vcmlFail++; return 0; }
  }) as Vec3;
  const m = trs(f.t as Vec3, r, "XYZ"); matCache.set(key, m); return m;
}

// adjacency: for each part, the dock edges to framed partners (both dock frames resolved).
interface Edge { myF: any; them: GPart; theirF: any }
const adj = new Map<string, Edge[]>(); let unframed = 0;
for (const p of parts) {
  const es: Edge[] = [];
  for (const d of p.docks) {
    const partner = byDockId.get(d.partner); if (!partner) continue;
    const myF = frameOf(p.type, d.type, d.index), theirF = frameOf(partner.p.type, partner.type, partner.index);
    if (!myF || !theirF) { unframed++; continue; }
    es.push({ myF, them: partner.p, theirF });
  }
  adj.set(p.id, es);
}
// Learn the constant mate transform per directed dock-type pair from saved transforms. The mate
// is a fixed property of the dock TYPES (how they snap together), so one representative (the medoid,
// robust to symmetric-pair outliers) defines it: worldDockA * M = worldDockB.
const mateByPair = new Map<string, Mat4>();
{
  const groups = new Map<string, Mat4[]>();
  for (const p of parts) for (const e of adj.get(p.id)!) {
    const Wa = mul(trs(p.pos, p.rot, "XYZ"), frameMat(p, e.myF));
    const Wb = mul(trs(e.them.pos, e.them.rot, "XYZ"), frameMat(e.them, e.theirF));
    const key = `${e.myF.dockType}->${e.theirF.dockType}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(mul(invRigid(Wa), Wb));
  }
  for (const [key, Ms] of groups) {
    let best = Ms[0], bestD = Infinity;
    for (const A of Ms) { const qa = matToQuat(A), ta = getTranslation(A); let d = 0; for (const B of Ms) d += quatAngleDeg(qa, matToQuat(B)) + dist(ta, getTranslation(B)); if (d < bestD) { bestD = d; best = A; } }
    mateByPair.set(key, best);
  }
}
const mate = (myType: string, theirType: string) => mateByPair.get(`${myType}->${theirType}`) ?? ident();

// candidate world transform for `p` implied by an edge to an already-placed partner: W_p = W_them * Fb * mate(them->me) * inv(Fa).
const candidate = (p: GPart, e: Edge, world: Map<string, Mat4>) =>
  mul(mul(mul(world.get(e.them.id)!, frameMat(e.them, e.theirF)), mate(e.theirF.dockType, e.myF.dockType)), invRigid(frameMat(p, e.myF)));
// score: how well a candidate world for `p` satisfies ALL its placed-neighbor dock connections (W_p*Fa*mate == W_them*Fb).
function score(p: GPart, W: Mat4, placed: Edge[], world: Map<string, Mat4>): number {
  let s = 0;
  for (const e of placed) {
    const mine = mul(mul(W, frameMat(p, e.myF)), mate(e.myF.dockType, e.theirF.dockType));
    const theirs = mul(world.get(e.them.id)!, frameMat(e.them, e.theirF));
    s += dist(getTranslation(mine), getTranslation(theirs)) + quatAngleDeg(matToQuat(mine), matToQuat(theirs)) / 90; // 90° ~ 1cm
  }
  return s;
}

// BFS from an anchor part for initial placement + connectivity.
const anchor = parts[0];
const world = new Map<string, Mat4>();
world.set(anchor.id, trs(anchor.pos, anchor.rot, "XYZ"));
const q: GPart[] = [anchor];
while (q.length) {
  const p = q.shift()!;
  for (const e of adj.get(p.id)!) if (!world.has(e.them.id)) {
    // partner from placed p: W_them = W_p * Fa * mate(me->them) * inv(Fb)
    world.set(e.them.id, mul(mul(mul(world.get(p.id)!, frameMat(p, e.myF)), mate(e.myF.dockType, e.theirF.dockType)), invRigid(frameMat(e.them, e.theirF))));
    q.push(e.them);
  }
}

// Iterative multi-constraint refinement: re-place each part with the candidate (from any placed
// neighbor edge) that best satisfies ALL its placed-neighbor connections. Loops in the grid
// (a ball ties 4 tubes) over-determine and thus pin symmetric tube roll. Gauss-Seidel to fixpoint.
for (let pass = 0; pass < 12; pass++) {
  let changed = 0;
  for (const p of parts) {
    if (p === anchor || !world.has(p.id)) continue;
    const placed = adj.get(p.id)!.filter((e) => world.has(e.them.id));
    if (placed.length < 2) continue; // single constraint can't resolve a free DOF
    let best = world.get(p.id)!, bestS = score(p, best, placed, world);
    for (const e of placed) { const c = candidate(p, e, world); const s = score(p, c, placed, world); if (s < bestS - 1e-6) { bestS = s; best = c; } }
    if (best !== world.get(p.id)) { world.set(p.id, best); changed++; }
  }
  if (!changed) break;
}

// validate computed world transforms vs saved
const POS_TOL = 0.5, ANG_TOL = 1.0;        // cm, degrees
const symOk = (a: number) => a <= ANG_TOL || Math.abs(a - 90) <= ANG_TOL || Math.abs(a - 180) <= ANG_TOL || Math.abs(a - 270) <= ANG_TOL;
// structural frame (the grid: balls/tubes/panels/feet) vs functional add-ons (drawers/doors/pull-outs).
const isStructural = (t: string) => /^(kugel|rohr|blech|hallerfuss|fuss|quertraverse|bodenelement|tablar350|tablar500|abdeck|rueckwand)/.test(t);
let posMatch = 0, oriMatch = 0, oriSym = 0, checked = 0, maxPos = 0;
let structN = 0, structOk = 0, addonN = 0, addonOk = 0;
const failByType = new Map<string, number>();
const worst: string[] = [];
for (const p of parts) {
  const W = world.get(p.id); if (!W || p === anchor) continue;
  checked++;
  const pe = dist(getTranslation(W), p.pos);
  const ae = quatAngleDeg(matToQuat(W), matToQuat(euler(p.rot[0], p.rot[1], p.rot[2], "XYZ")));
  const ok = pe <= POS_TOL;
  if (isStructural(p.type)) { structN++; if (ok) structOk++; } else { addonN++; if (ok) addonOk++; }
  if (ok) posMatch++; else { failByType.set(p.type, (failByType.get(p.type) ?? 0) + 1); if (worst.length < 6) worst.push(`${p.type}#${p.id}: posErr=${pe.toFixed(2)}cm angErr=${ae.toFixed(1)}°`); }
  if (ae <= ANG_TOL) oriMatch++;
  if (symOk(ae)) oriSym++;
  maxPos = Math.max(maxPos, pe);
}

console.log("=== PLACEMENT SOLVER vs P'X5 (dock-frame composition, M=identity, euler XYZ) ===");
console.log(`  parts: ${parts.length}   placed by solver: ${world.size}   unreachable: ${parts.length - world.size}   unframed docks skipped: ${unframed}`);
console.log(`  VCML dock rotations evaluated: ${vcmlOk} ok / ${vcmlFail} fail`);
console.log(`  validated (excl. anchor): ${checked}`);
console.log(`  POSITION match (<=${POS_TOL}cm): ${posMatch}/${checked} (${(100 * posMatch / checked).toFixed(1)}%)   max posErr=${maxPos.toFixed(3)}cm`);
console.log(`  ORIENTATION exact (<=${ANG_TOL}°): ${oriMatch}/${checked} (${(100 * oriMatch / checked).toFixed(1)}%)`);
console.log(`  ORIENTATION incl. tube-symmetry (0/90/180/270°): ${oriSym}/${checked} (${(100 * oriSym / checked).toFixed(1)}%)`);
console.log(`  by family -> structural frame: ${structOk}/${structN} (${(100 * structOk / structN).toFixed(1)}%)   functional add-ons: ${addonOk}/${addonN} (${addonN ? (100 * addonOk / addonN).toFixed(1) : 0}%)`);
const fails = [...failByType].sort((a, b) => b[1] - a[1]);
if (fails.length) console.log(`  position-fail part types (${fails.length}): ${fails.slice(0, 12).map(([t, n]) => `${t}×${n}`).join(", ")}`);
if (worst.length) { console.log("  worst position cases:"); for (const w of worst) console.log("     " + w); }

// focused report: the GLASS FITTINGS (the Phase-2 orientation bug) — clamps & hinges, L/R.
console.log("\n  --- glass fittings (glashalter / glasscharnier / glas door) ---");
let gN = 0, gPos = 0, gOri = 0;
for (const p of parts) {
  if (!/glas|halter|scharnier/.test(p.type)) continue;
  const W = world.get(p.id); if (!W || p === anchor) continue;
  gN++;
  const pe = dist(getTranslation(W), p.pos);
  const ae = quatAngleDeg(matToQuat(W), matToQuat(euler(p.rot[0], p.rot[1], p.rot[2], "XYZ")));
  if (pe <= POS_TOL) gPos++; if (ae <= ANG_TOL) gOri++;
  console.log(`     ${p.type}#${p.id}: posErr=${pe.toFixed(2)}cm angErr=${ae.toFixed(1)}°  ${pe <= POS_TOL && ae <= ANG_TOL ? "OK" : "off"}`);
}
console.log(`     glass fittings: ${gN}  position OK ${gPos}/${gN}  orientation-exact ${gOri}/${gN}`);

// L/R hinge orientation — the Phase-2 question: print the engine-computed world quaternion for a
// representative left and right hinge of the same family, plus their relative rotation.
const hinge = (t: string) => { const p = parts.find((x) => x.type === t); if (!p) return null; const W = world.get(p.id); return W ? { p, q: matToQuat(W) } : null; };
const L = hinge("glasscharnier_vorne_oben_l"), R = hinge("glasscharnier_vorne_oben_r");
if (L && R) {
  console.log("\n  --- glass hinge L vs R (engine-computed world orientation, = P'X5) ---");
  console.log(`     vorne_oben_L #${L.p.id}: quat=[${L.q.map((x) => x.toFixed(4))}]`);
  console.log(`     vorne_oben_R #${R.p.id}: quat=[${R.q.map((x) => x.toFixed(4))}]`);
  console.log(`     L vs R relative rotation: ${quatAngleDeg(L.q, R.q).toFixed(1)}°  (this is the L/R asymmetry the native app must reproduce)`);
}

// Emit consumable placement: every solved part's computed world transform (pos cm + quaternion).
import("node:fs").then(({ writeFileSync }) => {
  const out = parts.filter((p) => world.has(p.id)).map((p) => {
    const W = world.get(p.id)!;
    return { id: p.id, type: p.type, pos: getTranslation(W).map((x) => +x.toFixed(4)), quat: matToQuat(W).map((x) => +x.toFixed(6)) };
  });
  // unique connection edges (the grid skeleton) between solved parts, for the 3D viewport.
  const seen = new Set<string>(), conns: [string, string][] = [];
  for (const p of parts) if (world.has(p.id)) for (const e of adj.get(p.id)!) if (world.has(e.them.id)) {
    const k = [p.id, e.them.id].sort().join("-"); if (seen.has(k)) continue; seen.add(k); conns.push([p.id, e.them.id]);
  }
  writeFileSync("out/placement.json", JSON.stringify({ source: "usm-engine dock solver", parts: out, connections: conns }, null, 1));
  console.log(`\n  wrote out/placement.json (${out.length} parts + ${conns.length} connections) — consumable world transforms`);
});
