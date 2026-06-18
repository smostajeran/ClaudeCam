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
import { APPCODES_DIR, SNX } from "../import/paths.ts";
import { loadCatalog, loadComponentArtNo } from "./catalog.ts";
import { trs, mul, invRigid, euler, ident, applyPoint, getTranslation, matToQuat, quatAngleDeg, dist } from "./geom.ts";
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

interface GPart { id: string; type: string; pos: Vec3; rot: Vec3; e: string | null; artnr: string; docks: { type: string; index: number; dockid: string; partner: string }[] }
const num = (s: string | undefined) => { const n = Number(s); return Number.isNaN(n) ? 0 : n; };
// Haller-E (electrification) role from a part's saved features: the live electrical path.
function eRole(type: string, f: Record<string, string>): string | null {
  if (/trafo/.test(type)) return "trafo";              // power source
  if (/safety/.test(type)) return "safety";            // safety module
  if (f.f_kugelEinspeisung === "true") return "feed";  // power-feed ball
  if (f.f_rohrtyp === "rohr-leitend") return "live";   // conductive tube
  for (const k of ["f_verbraucherM", "f_verbraucherL", "f_verbraucherR"]) if (f[k] && !/dummy/.test(f[k])) return "consumer";
  return null;
}
const root = parseXmlFile(cfg);
const csNodes: any[] = [];
(function collect(nodes: any[]) { for (const n of nodes) { if (tagOf(n) === "componentset") csNodes.push(n); const k = kids(n); if (k.length) collect(k); } })(root);
const parts: GPart[] = csNodes.map((cs, i) => {
  const k = kids(cs); const pos = byTag(k, "pos")[0], rot = byTag(k, "rot")[0];
  const type = attr(cs, "type")!;
  const fn = byTag(k, "features")[0]; const fa = (fn?.[":@"] ?? {}) as Record<string, string>;
  const feat: Record<string, string> = {}; for (const key in fa) feat[key.replace(/^@_/, "")] = fa[key];
  return {
    id: attr(cs, "_PXI_unique_comp_id") ?? String(i), type,
    pos: [num(attr(pos, "x")), num(attr(pos, "y")), num(attr(pos, "z"))],
    rot: [num(attr(rot, "x")), num(attr(rot, "y")), num(attr(rot, "z"))],
    e: eRole(type, feat), artnr: feat.f_artnr ?? "",
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
// structural frame (placed first/most-constrained); anchors to these are trusted far more than
// add-on siblings, so a single correct structural attachment outvotes a drifted sub-assembly.
const STRUCT = /^(kugel|rohr|blech|lochblech|kurzblech|hallerfuss|fuss|tablar\d|boden|abdeck|rueckwand|quertraverse|querstrebe)/;
function score(p: GPart, W: Mat4, placed: Edge[], world: Map<string, Mat4>): number {
  let s = 0;
  for (const e of placed) {
    const w = STRUCT.test(e.them.type) ? 100 : 1;
    const mine = mul(mul(W, frameMat(p, e.myF)), mate(e.myF.dockType, e.theirF.dockType));
    const theirs = mul(world.get(e.them.id)!, frameMat(e.them, e.theirF));
    s += w * (dist(getTranslation(mine), getTranslation(theirs)) + quatAngleDeg(matToQuat(mine), matToQuat(theirs)) / 90); // 90° ~ 1cm
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
// Trust hierarchy: hop-distance from the structural frame. Each part is anchored to neighbours
// closer to the structure than itself, so correctness propagates outward (panel -> clamp -> slide
// -> drawer -> leaf) and a wrong sub-assembly can't outvote its real anchor.
const hop = new Map<string, number>(); const hq: string[] = [];
for (const p of parts) if (world.has(p.id) && STRUCT.test(p.type)) { hop.set(p.id, 0); hq.push(p.id); }
while (hq.length) { const id = hq.shift()!; const h = hop.get(id)!; for (const e of adj.get(id) ?? []) if (world.has(e.them.id) && !hop.has(e.them.id)) { hop.set(e.them.id, h + 1); hq.push(e.them.id); } }

for (let pass = 0; pass < 20; pass++) {
  let changed = 0;
  for (const p of parts) {
    if (p === anchor || !world.has(p.id)) continue;
    const ph = hop.get(p.id) ?? 99;
    const placed = adj.get(p.id)!.filter((e) => world.has(e.them.id));
    const parents = placed.filter((e) => (hop.get(e.them.id) ?? 99) < ph);
    const use = parents.length ? parents : placed;
    if (!use.length) continue;
    let best = world.get(p.id)!, bestS = score(p, best, use, world);
    for (const e of use) { const c = candidate(p, e, world); const s = score(p, c, use, world); if (s < bestS - 1e-6) { bestS = s; best = c; } }
    if (best !== world.get(p.id)) { world.set(p.id, best); changed++; }
  }
  if (!changed) break;
}

// Rigid-cluster repair: a connected sub-region can settle in a self-consistent but globally-offset
// local minimum (internal edges satisfied, a boundary edge violated). Per-part refinement can't move
// it as a unit. Find the worst-violated edge, grow the rigid cluster on one side via its SATISFIED
// edges, and shift that whole cluster to satisfy the edge — keeping the move only if it reduces TOTAL
// edge violation. So it can never regress a good solve (on a fully-solved scene there are no violated
// edges -> no-op); on a drifted scene it slides the offset block back into place.
{
  const RTOL = 0.5;
  const eviol = (p: GPart, e: Edge) => dist(getTranslation(world.get(p.id)!), getTranslation(candidate(p, e, world)));
  const totalViol = () => { let s = 0; for (const p of parts) { if (!world.has(p.id)) continue; for (const e of adj.get(p.id)!) if (world.has(e.them.id)) s += eviol(p, e); } return s; };
  const clusterFrom = (seed: GPart, blk: GPart) => {
    const seen = new Set<string>([seed.id]); const st = [seed];
    while (st.length) { const x = st.pop()!; for (const e of adj.get(x.id)!) { if (e.them === blk || !world.has(e.them.id) || seen.has(e.them.id)) continue; if (eviol(x, e) < RTOL) { seen.add(e.them.id); st.push(e.them); } } }
    return seen;
  };
  const tryMove = (X: GPart, e: Edge): boolean => {
    const cluster = clusterFrom(X, e.them);
    if (cluster.has(anchor.id)) return false;
    const T = mul(candidate(X, e, world), invRigid(world.get(X.id)!));
    const snap = new Map<string, Mat4>(); for (const id of cluster) snap.set(id, world.get(id)!);
    const base = totalViol();
    for (const id of cluster) world.set(id, mul(T, world.get(id)!));
    if (totalViol() < base - 0.5) return true;
    for (const [id, m] of snap) world.set(id, m);
    return false;
  };
  const black = new Set<string>();
  for (let iter = 0; iter < 400; iter++) {
    let worst: { p: GPart; e: Edge; k: string } | null = null, wv = RTOL;
    for (const p of parts) { if (!world.has(p.id)) continue; for (const e of adj.get(p.id)!) { if (!world.has(e.them.id)) continue; const k = [p.id, e.them.id].sort().join("-"); if (black.has(k)) continue; const v = eviol(p, e); if (v > wv) { wv = v; worst = { p, e, k }; } } }
    if (!worst) break;
    const rev = adj.get(worst.e.them.id)!.find((x) => x.them === worst!.p);
    if (tryMove(worst.p, worst.e) || (rev && tryMove(worst.e.them, rev))) continue;
    black.add(worst.k);
  }
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
  if (ok) posMatch++; else { failByType.set(p.type, (failByType.get(p.type) ?? 0) + 1); const W2 = getTranslation(W); const d = [W2[0] - p.pos[0], W2[1] - p.pos[1], W2[2] - p.pos[2]].map((x) => +x.toFixed(1)); if (worst.length < 10) worst.push(`${p.type}#${p.id}: err=${pe.toFixed(1)}cm Δ=[${d}] ang=${ae.toFixed(0)}°`); }
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
// boundary trace: the first misplaced part's neighbours — a correct (~0cm) neighbour reveals the bad edge.
{
  const bad = parts.find((p) => { const W = world.get(p.id); return W && p !== anchor && dist(getTranslation(W), p.pos) > 0.5; });
  if (bad) {
    console.log(`  boundary trace ${bad.type}#${bad.id}:`);
    for (const e of adj.get(bad.id) ?? []) {
      if (!world.has(e.them.id)) continue;
      const err = dist(getTranslation(world.get(e.them.id)!), e.them.pos);
      console.log(`     <-> ${e.them.type}#${e.them.id}  via ${e.myF.dockType}#${e.myF.index}/${e.theirF.dockType}#${e.theirF.index}  nbrErr=${err.toFixed(1)}cm`);
    }
  }
}

// === FITTING ORIENTATION CONFIRMATION — every glass clamp/hinge vs P'X5, grouped by type ===
const fitTypes = new Map<string, { n: number; maxP: number; maxA: number }>();
for (const p of parts) {
  if (!/^(glashalter|glasscharnier)/.test(p.type)) continue; // clamps + hinges (not panels/doors/drawer clamps)
  const W = world.get(p.id); if (!W || p === anchor) continue;
  const pe = dist(getTranslation(W), p.pos);
  const ae = quatAngleDeg(matToQuat(W), matToQuat(euler(p.rot[0], p.rot[1], p.rot[2], "XYZ")));
  const r = fitTypes.get(p.type) ?? { n: 0, maxP: 0, maxA: 0 };
  r.n++; r.maxP = Math.max(r.maxP, pe); r.maxA = Math.max(r.maxA, ae); fitTypes.set(p.type, r);
}
console.log("\n  === FITTING ORIENTATION CONFIRMATION vs P'X5 (per type) ===");
let fitN = 0, fitOk = true, worstA = 0;
for (const [t, r] of [...fitTypes].sort()) {
  fitN += r.n; if (r.maxA > ANG_TOL || r.maxP > POS_TOL) fitOk = false; worstA = Math.max(worstA, r.maxA);
  console.log(`     ${t.padEnd(30)} ×${String(r.n).padStart(2)}  maxPosErr=${r.maxP.toFixed(2)}cm  maxAngErr=${r.maxA.toFixed(2)}°  ${r.maxA <= ANG_TOL && r.maxP <= POS_TOL ? "OK" : "OFF"}`);
}
console.log(`     -> ${fitN} clamps+hinges, worst orientation error ${worstA.toFixed(3)}°  =>  ${fitOk ? "ALL MATCH P'X5 EXACTLY ✓" : "MISMATCH"}`);

// L vs R hinge orientation (the Phase-2 asymmetry) — world quaternions per family.
const hinge = (t: string) => { const p = parts.find((x) => x.type === t); if (!p) return null; const W = world.get(p.id); return W ? { p, q: matToQuat(W) } : null; };
console.log("  --- L vs R hinge world orientation (engine = P'X5) ---");
for (const fam of ["vorne_oben", "vorne_unten", "hinten_oben", "hinten_unten"]) {
  const L = hinge(`glasscharnier_${fam}_l`), R = hinge(`glasscharnier_${fam}_r`);
  if (L && R) console.log(`     ${fam.padEnd(13)} L=[${L.q.map((x) => x.toFixed(3))}]  R=[${R.q.map((x) => x.toFixed(3))}]  Δ(L,R)=${quatAngleDeg(L.q, R.q).toFixed(1)}°`);
}

// Emit consumable placement: every solved part's computed world transform (pos cm + quaternion).
// Detect a part's panel quad from its dock-frame extents: the dock translations of a flat part
// (glass/sheet/shelf) span a plane; the axis with near-zero spread is the thin axis. Emit the 4
// world-space corners (real plane + real size) so the viewport never has to guess.
function panelQuad(p: GPart, W: Mat4): { quad: number[][]; kind: string } | null {
  const fr = frames.get(p.type) ?? [];
  if (fr.length < 3) return null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const f of fr) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], f.t[i]); mx[i] = Math.max(mx[i], f.t[i]); }
  const rng = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const thin = rng.indexOf(Math.min(...rng));
  const ip = [0, 1, 2].filter((i) => i !== thin);
  if (!(rng[ip[0]] > 8 && rng[ip[1]] > 8 && rng[thin] < 4)) return null; // not a flat panel
  const mid = (mn[thin] + mx[thin]) / 2;
  const corner = (s0: boolean, s1: boolean) => { const v = [0, 0, 0] as [number, number, number]; v[thin] = mid; v[ip[0]] = s0 ? mx[ip[0]] : mn[ip[0]]; v[ip[1]] = s1 ? mx[ip[1]] : mn[ip[1]]; return applyPoint(W, v).map((x) => +x.toFixed(2)); };
  return { quad: [corner(false, false), corner(true, false), corner(true, true), corner(false, true)], kind: /glas/.test(p.type) ? "glass" : "panel" };
}

// Article catalog (database.xml) + component->article-number map: resolve each part to its billable
// article for official naming + a priced BOM. Only parts with a literal article number resolve here
// (tubes via art_number, + f_artnr); composite articles need the article-assignment system (TODO).
const catalog = loadCatalog("database.xml");
const compArtNo = loadComponentArtNo(`${SNX}/cartridge/componentsystem.xml`);
const resolveArtNo = (p: GPart): string | null => {
  const a = compArtNo.get(p.type) ?? p.artnr;
  return a && /^\d[\d.]*$/.test(a) ? a : null; // literal numbers only (skip VCML exprs for now)
};

import("node:fs").then(({ writeFileSync }) => {
  const out = parts.filter((p) => world.has(p.id)).map((p) => {
    const W = world.get(p.id)!;
    const pq = panelQuad(p, W);
    const artNo = resolveArtNo(p); const art = artNo ? catalog.get(artNo) : null;
    return { id: p.id, type: p.type, pos: getTranslation(W).map((x) => +x.toFixed(4)), quat: matToQuat(W).map((x) => +x.toFixed(6)),
      ...(p.e ? { e: p.e } : {}), ...(pq ? { quad: pq.quad, panelKind: pq.kind } : {}),
      ...(art ? { artNo, name: art.en, price: art.price, weight: art.weight } : artNo ? { artNo } : {}) };
  });
  // priced BOM rollup (parts that resolved to a catalog article)
  const bomMap = new Map<string, { artNo: string; name: string; qty: number; price: number; weight: number }>();
  let priced = 0;
  for (const p of out) if ((p as any).price != null) { priced++; const a = (p as any).artNo; const e = bomMap.get(a) ?? { artNo: a, name: (p as any).name, qty: 0, price: (p as any).price, weight: (p as any).weight }; e.qty++; bomMap.set(a, e); }
  const bom = [...bomMap.values()].sort((x, y) => y.qty * y.price - x.qty * x.price);
  const total = bom.reduce((s, b) => s + b.qty * b.price, 0), totalKg = bom.reduce((s, b) => s + b.qty * b.weight, 0);
  console.log(`\n  === BOM (priced from database.xml) — ${priced}/${out.length} parts resolved to a catalog article ===`);
  for (const b of bom) console.log(`     ${b.qty}× ${b.artNo.padEnd(8)} ${b.name.slice(0, 40).padEnd(40)} @ €${b.price.toFixed(2)} = €${(b.qty * b.price).toFixed(2)}`);
  console.log(`     TOTAL (resolved parts): €${total.toFixed(2)}   ${totalKg.toFixed(2)} kg   [composite articles need the article-assignment system]`);
  const eCount: Record<string, number> = {};
  for (const p of parts) if (p.e) eCount[p.e] = (eCount[p.e] ?? 0) + 1;
  console.log(`  Haller-E roles: ${Object.entries(eCount).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  // unique connection edges (the grid skeleton) between solved parts, for the 3D viewport.
  const seen = new Set<string>(), conns: [string, string][] = [];
  for (const p of parts) if (world.has(p.id)) for (const e of adj.get(p.id)!) if (world.has(e.them.id)) {
    const k = [p.id, e.them.id].sort().join("-"); if (seen.has(k)) continue; seen.add(k); conns.push([p.id, e.them.id]);
  }
  writeFileSync("out/placement.json", JSON.stringify({ source: "usm-engine dock solver", parts: out, connections: conns, bom, pricedTotal: +total.toFixed(2), pricedKg: +totalKg.toFixed(2), pricedCount: priced }, null, 1));
  console.log(`\n  wrote out/placement.json (${out.length} parts + ${conns.length} connections) — consumable world transforms`);
});
