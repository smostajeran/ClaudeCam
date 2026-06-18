// PLACEMENT SOLVER: compute every part's world transform purely from dock-frame composition,
// anchored at one part's saved transform, then validate against P'X5's saved pos/rot.
//   W_child = W_parent * Frame(dockA) * inv(Frame(dockB))     (mate convention M = identity)
// Euler order XYZ (calibrated). Dock rotations may be VCML -> evaluated via the interpreter.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseXmlFile, tagOf, attr, kids, byTag } from "../xml/parse.ts";
import { loadDockFrames, loadAllDockFrames } from "./dockframes.ts";
import { loadScene, installPartFns } from "./scene.ts";
import { Host } from "./partgraph.ts";
import { loadAppcodes } from "../vcml/appcode.ts";
import { evalVCML } from "../vcml/interp.ts";
import { APPCODES_DIR, SNX } from "../import/paths.ts";
import { loadCatalog, loadComponentArtNo } from "./catalog.ts";
import { trs, mul, invRigid, euler, ident, applyPoint, getTranslation, matToQuat, quatAngleDeg, dist, alignRigid } from "./geom.ts";
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
const frames = loadAllDockFrames();
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
const missFrame = new Map<string, number>();   // "componentType:dockType#index" with no dock frame
const noPartner = new Map<string, number>();    // connecteddockid that resolves to no known dock
for (const p of parts) {
  const es: Edge[] = [];
  for (const d of p.docks) {
    const partner = byDockId.get(d.partner);
    if (!partner) { noPartner.set(p.type, (noPartner.get(p.type) ?? 0) + 1); continue; }
    let myF = frameOf(p.type, d.type, d.index), theirF = frameOf(partner.p.type, partner.type, partner.index);
    if (!myF || !theirF) {
      // No dock frame declared in any componentsystem.xml. This happens for sub-components (handles
      // griff_*, volcontconnector) that are framed inside parts/*.xml, not at the top level. Rather
      // than drop the part, fall back to an identity frame at the dock origin: the learned per-dock-
      // pair mate (from saved transforms) absorbs the true offset, so the part still places relative
      // to its framed partner. Counted so the report stays honest about which frames were assumed.
      unframed++;
      if (!myF) { missFrame.set(`${p.type}:${d.type}#${d.index}`, (missFrame.get(`${p.type}:${d.type}#${d.index}`) ?? 0) + 1); myF = { dockType: d.type, index: d.index, t: [0, 0, 0], r: ["0", "0", "0"] }; }
      if (!theirF) { missFrame.set(`${partner.p.type}:${partner.type}#${partner.index}`, (missFrame.get(`${partner.p.type}:${partner.type}#${partner.index}`) ?? 0) + 1); theirF = { dockType: partner.type, index: partner.index, t: [0, 0, 0], r: ["0", "0", "0"] }; }
    }
    es.push({ myF, them: partner.p, theirF });
  }
  adj.set(p.id, es);
}
// Learn the mate transform per directed dock NODE pair (dock type + INDEX) from saved transforms.
// The index identifies the specific connection node — e.g. rohr2blech #1..#4 are the four SIDES of a
// tube (90deg apart), each with its own complete frame. Keying by type alone conflated those sides and
// the medoid picked one, leaving the rest 90/180deg off (the false "symmetric ambiguity"). Keyed by the
// full node, each mate is a single constant transform: worldDockA * M = worldDockB.
// Key by the full node: component TYPE + dock type#index, on both sides. The frame is a property of
// the component (e.g. the parameterized threaded tube gewrohr350_250_100 carries UNIT-vector dock
// offsets, not real cm, unlike a normal rohr350), so the same dock type on different components has a
// different frame and therefore a different mate. Keying by component too keeps those from being
// averaged together, and lets each component's learned mate absorb its own frame convention.
const mkey = (aT: string, a: any, bT: string, b: any) => `${aT}:${a.dockType}#${a.index}->${bT}:${b.dockType}#${b.index}`;
const mateByPair = new Map<string, Mat4>();
const mateGroups = new Map<string, Mat4[]>();
for (const p of parts) for (const e of adj.get(p.id)!) {
  const Wa = mul(trs(p.pos, p.rot, "XYZ"), frameMat(p, e.myF));
  const Wb = mul(trs(e.them.pos, e.them.rot, "XYZ"), frameMat(e.them, e.theirF));
  const key = mkey(p.type, e.myF, e.them.type, e.theirF);
  (mateGroups.get(key) ?? mateGroups.set(key, []).get(key)!).push(mul(invRigid(Wa), Wb));
}
const medoidOf = (Ms: Mat4[]) => { let best = Ms[0], bestD = Infinity; for (const A of Ms) { const qa = matToQuat(A), ta = getTranslation(A); let d = 0; for (const B of Ms) d += quatAngleDeg(qa, matToQuat(B)) + dist(ta, getTranslation(B)); if (d < bestD) { bestD = d; best = A; } } return best; };
for (const [key, Ms] of mateGroups) mateByPair.set(key, medoidOf(Ms));

// ---- Stored, config-independent mate table (data/mates.json) ----
// The mate is how a dock-type pair snaps together — a property of the dock TYPES, not the config.
// Learn it once from reference configs and store it, so an interactive configuration (which has NO
// saved poses to learn from) can still place parts. WRITE_MATES merges this config's mates into the
// table; USE_STORED_MATES solves from the table alone (per-config learning becomes only a fallback,
// reported) — that is the honest test that the table generalises.
const MATE_FILE = "data/mates.json";
const matSpread = (Ms: Mat4[], med: Mat4) => { const q = matToQuat(med), t = getTranslation(med); let a = 0, d = 0; for (const M of Ms) { a = Math.max(a, quatAngleDeg(q, matToQuat(M))); d = Math.max(d, dist(t, getTranslation(M))); } return { a, d }; };
if (process.env.WRITE_MATES) {
  let table: Record<string, any> = {};
  try { table = JSON.parse(readFileSync(MATE_FILE, "utf8")).mates ?? {}; } catch { /* first config: new table */ }
  let added = 0, improved = 0;
  for (const [key, Ms] of mateGroups) {
    const sp = matSpread(Ms, mateByPair.get(key)!);
    const rec = { m: mateByPair.get(key)!, n: Ms.length, angSpread: +sp.a.toFixed(2), posSpread: +sp.d.toFixed(3) };
    if (!table[key]) { table[key] = rec; added++; }
    else if (Ms.length > table[key].n) { rec.angSpread = Math.max(rec.angSpread, table[key].angSpread); table[key] = rec; improved++; }
    else table[key].angSpread = Math.max(table[key].angSpread, rec.angSpread);
  }
  writeFileSync(MATE_FILE, JSON.stringify({ note: "config-independent dock-pair mates: medoid of invWa*Wb over reference configs. angSpread>~5deg => non-constant/symmetric pair (single mate cannot place it exactly).", count: Object.keys(table).length, mates: table }));
  console.log(`  [WRITE_MATES] ${MATE_FILE}: +${added} new, ${improved} improved -> ${Object.keys(table).length} dock-pair mates stored`);
}
let storedMates: Map<string, Mat4> | null = null;
if (process.env.USE_STORED_MATES) {
  try { const t = JSON.parse(readFileSync(MATE_FILE, "utf8")).mates; storedMates = new Map(Object.entries(t).map(([k, v]: any) => [k, v.m as Mat4])); }
  catch { storedMates = new Map(); }
}
const mateFellBack = new Set<string>();
const mate = (aT: string, fa: any, bT: string, fb: any): Mat4 => {
  const key = mkey(aT, fa, bT, fb);
  if (storedMates) { const s = storedMates.get(key); if (s) return s; mateFellBack.add(key); } // table miss: would fail in a true interactive config
  return mateByPair.get(key) ?? ident();
};

// Symmetric dock-pairs (tube/panel roll, connector) snap together in more than one orientation, so a
// single mate cannot place them — the medoid picks one flip and the other instances drift. Cluster
// each pair's observed relative transforms into its distinct orientation VARIANTS; placement then tries
// each and lets loop-closure (agreement with ALL neighbours) pick the right flip. Conservative: a 2nd
// variant needs a clear, well-supported split (>45deg from the first, >=20% of samples) so noise can't
// invent spurious flips that would mask real drift from the repair.
const mateVariantsByPair = new Map<string, Mat4[]>();
for (const [key, Ms] of mateGroups) {
  const clusters: Mat4[][] = [];
  for (const M of Ms) {
    const q = matToQuat(M), t = getTranslation(M);
    const cl = clusters.find((c) => quatAngleDeg(q, matToQuat(c[0])) < 45 && dist(t, getTranslation(c[0])) < 5);
    if (cl) cl.push(M); else clusters.push([M]);
  }
  const strong = clusters.filter((c) => c.length >= Math.max(3, Ms.length * 0.2));
  mateVariantsByPair.set(key, (strong.length ? strong : clusters).map(medoidOf));
}
const mateVariants = (aT: string, fa: any, bT: string, fb: any): Mat4[] => {
  const key = mkey(aT, fa, bT, fb);
  if (storedMates) { const s = storedMates.get(key); if (s) return [s]; }
  return mateVariantsByPair.get(key) ?? [mate(aT, fa, bT, fb)];
};

// candidate world transform(s) for `p` implied by an edge to an already-placed partner:
//   W_p = W_them * Fb * mate(them->me) * inv(Fa)   — one per orientation variant of the dock node-pair.
const candidatesFor = (p: GPart, e: Edge, world: Map<string, Mat4>): Mat4[] =>
  mateVariants(e.them.type, e.theirF, p.type, e.myF).map((m) =>
    mul(mul(mul(world.get(e.them.id)!, frameMat(e.them, e.theirF)), m), invRigid(frameMat(p, e.myF))));
const candidate = (p: GPart, e: Edge, world: Map<string, Mat4>) => candidatesFor(p, e, world)[0];
// structural frame (placed first/most-constrained); anchors to these are trusted far more than
// add-on siblings, so a single correct structural attachment outvotes a drifted sub-assembly.
// The true structural skeleton is balls + tubes + panels. Feet (hallerfuss) attach to balls and are
// placed FROM the skeleton as leaves — they must NOT be hop-0 seeds, or a foot with a minority
// orientation (its mate varies per instance) would act as a high-trust anchor and drag tubes off.
const STRUCT = /^(kugel|rohr|blech|lochblech|kurzblech|tablar\d|boden|abdeck|rueckwand|quertraverse|querstrebe)/;
function score(p: GPart, W: Mat4, placed: Edge[], world: Map<string, Mat4>): number {
  let s = 0;
  for (const e of placed) {
    const w = STRUCT.test(e.them.type) ? 100 : 1;
    const theirs = mul(world.get(e.them.id)!, frameMat(e.them, e.theirF));
    let best = Infinity; // an edge is satisfied if ANY orientation variant of the dock-pair matches
    for (const m of mateVariants(p.type, e.myF, e.them.type, e.theirF)) {
      const mine = mul(mul(W, frameMat(p, e.myF)), m);
      const r = dist(getTranslation(mine), getTranslation(theirs)) + quatAngleDeg(matToQuat(mine), matToQuat(theirs)) / 90; // 90° ~ 1cm
      if (r < best) best = r;
    }
    s += w * best;
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
    world.set(e.them.id, mul(mul(mul(world.get(p.id)!, frameMat(p, e.myF)), mate(p.type, e.myF, e.them.type, e.theirF)), invRigid(frameMat(e.them, e.theirF))));
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
    if (!placed.length) continue;
    // Score against ALL placed neighbours (STRUCT-weighted, so a real structural anchor still
    // outvotes a drifted sub-assembly), and generate candidates from ALL of them — so a boundary part
    // can snap to a CORRECT neighbour even when its hop-parent sits in a drifted block.
    let best = world.get(p.id)!, bestS = score(p, best, placed, world);
    for (const e of placed) for (const c of candidatesFor(p, e, world)) { const s = score(p, c, placed, world); if (s < bestS - 1e-6) { bestS = s; best = c; } }
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
  const eviol = (p: GPart, e: Edge) => { const cur = getTranslation(world.get(p.id)!); let best = Infinity; for (const c of candidatesFor(p, e, world)) best = Math.min(best, dist(cur, getTranslation(c))); return best; };
  const totalViol = () => { let s = 0; for (const p of parts) { if (!world.has(p.id)) continue; for (const e of adj.get(p.id)!) if (world.has(e.them.id)) s += eviol(p, e); } return s; };
  const clusterFrom = (seed: GPart, blk: GPart) => {
    const seen = new Set<string>([seed.id]); const st = [seed];
    while (st.length) { const x = st.pop()!; for (const e of adj.get(x.id)!) { if (e.them === blk || !world.has(e.them.id) || seen.has(e.them.id)) continue; if (eviol(x, e) < RTOL) { seen.add(e.them.id); st.push(e.them); } } }
    return seen;
  };
  const tryMove = (X: GPart, e: Edge): boolean => {
    const cluster = clusterFrom(X, e.them);
    if (cluster.has(anchor.id)) return false;
    const snap = new Map<string, Mat4>(); for (const id of cluster) snap.set(id, world.get(id)!);
    const base = totalViol();
    // try each orientation variant of the worst edge: a drifted BRANCH is often both shifted AND
    // flipped, so the right re-seat is a full rigid transform (rotation+translation) from the correct
    // variant. Pick the variant whose transform reduces total violation the most.
    let bestT: Mat4 | null = null, bestV = base - 0.5;
    for (const cand of candidatesFor(X, e, world)) {
      const T = mul(cand, invRigid(snap.get(X.id)!));
      for (const id of cluster) world.set(id, mul(T, snap.get(id)!));
      const v = totalViol();
      if (v < bestV) { bestV = v; bestT = T; }
      for (const [id, m] of snap) world.set(id, m);
    }
    if (bestT) { for (const id of cluster) world.set(id, mul(bestT, snap.get(id)!)); return true; }
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

// ---- Global block alignment + grid snap (for multi-unit configs joined by slotted tubes, e.g. P3) ----
// Two units sharing a column of slotted tubes form separate rigid BLOCKS; the greedy repair can't move
// a whole unit across the dense, roll-ambiguous seam. (1) Group parts into rigid blocks (connected via
// STRICT-satisfied edges — same position AND orientation, so a roll-flipped seam reads as a boundary).
// (2) Snap each non-anchor block onto the placed structure with the best rigid transform over ALL its
// seam edges (Horn least-squares) — un-rotates the unit. (3) Grid-snap: USM parts lie on a regular
// axis-aligned lattice, so quantize coordinates to grid lines clustered from the anchor block, pinning
// each unit to the shared grid the way P'X5 does (the slotted-tube seam leaves a DOF the mates alone
// don't fix). Guarded by total violation so it never regresses a good solve.
{
  const RTOL = 0.5;
  const ev = (p: GPart, e: Edge) => { const cur = getTranslation(world.get(p.id)!); let b = Infinity; for (const c of candidatesFor(p, e, world)) b = Math.min(b, dist(cur, getTranslation(c))); return b; };
  const evStrict = (p: GPart, e: Edge) => { const W = world.get(p.id)!, cur = getTranslation(W); let b = Infinity; for (const c of candidatesFor(p, e, world)) b = Math.min(b, dist(cur, getTranslation(c)) + quatAngleDeg(matToQuat(W), matToQuat(c)) / 90); return b; };
  const totalViol = () => { let s = 0; for (const p of parts) { if (!world.has(p.id)) continue; for (const e of adj.get(p.id)!) if (world.has(e.them.id)) s += ev(p, e); } return s; };
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; } return r; };
  for (const p of parts) if (world.has(p.id)) parent.set(p.id, p.id);
  for (const p of parts) { if (!world.has(p.id)) continue; for (const e of adj.get(p.id)!) if (world.has(e.them.id) && evStrict(p, e) < RTOL) { const a = find(p.id), b = find(e.them.id); if (a !== b) parent.set(a, b); } }
  const myPt = (p: GPart, e: Edge): Vec3 => getTranslation(mul(world.get(p.id)!, frameMat(p, e.myF)));
  const themPt = (e: Edge): Vec3 => getTranslation(mul(world.get(e.them.id)!, frameMat(e.them, e.theirF)));
  // (1)+(2) align each non-anchor block onto the placed structure
  const fixed = new Set<string>([find(anchor.id)]);
  for (let pass = 0; pass < 30; pass++) {
    const seam = new Map<string, { src: Vec3[]; dst: Vec3[] }>();
    for (const p of parts) { if (!world.has(p.id) || fixed.has(find(p.id))) continue;
      for (const e of adj.get(p.id)!) { if (!world.has(e.them.id) || !fixed.has(find(e.them.id))) continue;
        const bp = find(p.id), s = seam.get(bp) ?? { src: [], dst: [] }; s.src.push(myPt(p, e)); s.dst.push(themPt(e)); seam.set(bp, s); } }
    if (!seam.size) break;
    let best: string | null = null; for (const [b, s] of seam) if (!best || s.src.length > seam.get(best)!.src.length) best = b;
    const s = seam.get(best!)!;
    const T = s.src.length >= 3 ? alignRigid(s.src, s.dst) : (() => { const o = ident(); o[3] = s.dst[0][0] - s.src[0][0]; o[7] = s.dst[0][1] - s.src[0][1]; o[11] = s.dst[0][2] - s.src[0][2]; return o; })();
    const members = parts.filter((p) => world.has(p.id) && find(p.id) === best);
    const snap = new Map(members.map((p) => [p.id, world.get(p.id)!])); const base = totalViol();
    for (const p of members) world.set(p.id, mul(T, snap.get(p.id)!));
    if (totalViol() > base - 0.5) for (const [id, m] of snap) world.set(id, m);
    fixed.add(best!);
  }
  // (3) lattice regularization: USM is an axis-aligned grid — every tube is exactly horizontal or
  // vertical. Walk the ball<->ball graph (through tubes) from a seed in the anchor block; for each
  // tube snap its direction to the nearest axis (keeping length), re-deriving every ball position on a
  // clean lattice. A ball that sat ~2cm off made its tube lean -> the SHEAR; snapping the tube to its
  // axis removes it. Then re-place the non-ball parts onto the gridded balls. Near-diagonal tubes
  // (angled shelves) are left alone. Guarded by total violation so it can't regress P1/P2.
  {
    const isBall = (t: string) => /^kugel/.test(t);
    const isTube = (t: string) => /^(rohr|gewrohr|fraesrohr|gewhilfsrohr|kurzrohr)/.test(t);
    const ballAdj = new Map<string, { other: GPart; len: number }[]>();
    for (const p of parts) {
      if (!world.has(p.id) || !isTube(p.type)) continue;
      const balls = adj.get(p.id)!.filter((e) => world.has(e.them.id) && isBall(e.them.type)).map((e) => e.them);
      if (balls.length < 2) continue;
      // EXACT ball-to-ball spacing = the tube's nominal length: rohr350->35.00cm, rohr750->75.00cm,
      // etc. (verified on the 100%-correct config, zero variance). Use it instead of the measured
      // distance so the lattice walk doesn't accumulate the seam tube's small length error.
      const m = p.type.match(/(\d{2,4})/); const len = m ? Number(m[1]) / 10 : -1;
      for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
        (ballAdj.get(balls[i].id) ?? ballAdj.set(balls[i].id, []).get(balls[i].id)!).push({ other: balls[j], len });
        (ballAdj.get(balls[j].id) ?? ballAdj.set(balls[j].id, []).get(balls[j].id)!).push({ other: balls[i], len });
      }
    }
    // Snap to the nearest of the 6 axes. ballAdj only ever holds standard tubes (rohr/gewrohr/fraes/
    // gewhilfs/kurz), which in USM are ALWAYS axis-aligned — so snap unconditionally. (A no-snap guard
    // here left a skewed seam tube, e.g. rohr100 at 35deg, diagonal and gridded ball#457 5cm off.)
    const snapAxis = (v: Vec3): Vec3 => { const len = Math.hypot(v[0], v[1], v[2]); if (len < 1e-6) return v; const n: Vec3 = [v[0] / len, v[1] / len, v[2] / len]; const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])]; const k = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2; const o: Vec3 = [0, 0, 0]; o[k] = Math.sign(n[k]) || 1; return o; };
    const seed = parts.find((p) => world.has(p.id) && isBall(p.type) && find(p.id) === find(anchor.id));
    if (seed && ballAdj.size) {
      const gpos = new Map<string, Vec3>(); gpos.set(seed.id, getTranslation(world.get(seed.id)!));
      const q: GPart[] = [seed]; const seen = new Set([seed.id]);
      while (q.length) {
        const a = q.shift()!; const ga = gpos.get(a.id)!, ta = getTranslation(world.get(a.id)!);
        for (const { other, len } of ballAdj.get(a.id) ?? []) {
          if (seen.has(other.id)) continue; seen.add(other.id);
          const to = getTranslation(world.get(other.id)!); const d: Vec3 = [to[0] - ta[0], to[1] - ta[1], to[2] - ta[2]];
          const useLen = len > 0 ? len : Math.hypot(d[0], d[1], d[2]); const ax = snapAxis(d);
          gpos.set(other.id, [ga[0] + ax[0] * useLen, ga[1] + ax[1] * useLen, ga[2] + ax[2] * useLen]);
          q.push(other);
        }
      }
      const base = totalViol();
      const before = new Map(parts.filter((p) => world.has(p.id)).map((p) => [p.id, world.get(p.id)!]));
      for (const p of parts) { if (!world.has(p.id) || !isBall(p.type)) continue; const g = gpos.get(p.id); if (!g) continue; const W = world.get(p.id)!.slice(); W[3] = g[0]; W[7] = g[1]; W[11] = g[2]; world.set(p.id, W); }
      for (let pass = 0; pass < 20; pass++) {
        let changed = 0;
        for (const p of parts) {
          // pin lattice-positioned balls; re-place everything else, incl. OFF-lattice balls reached
          // only through a tube chain (e.g. ball#457 behind the threaded gewrohr)
          if (p === anchor || !world.has(p.id) || (isBall(p.type) && gpos.has(p.id))) continue;
          const placed = adj.get(p.id)!.filter((e) => world.has(e.them.id));
          if (!placed.length) continue;
          // A tube on a gewrohr THREAD (rohr2gewinde) takes its pose from the gewrohr — the grid-anchored
          // side — scored ONLY on that thread edge, so the sub-assembly dangling off its other end (a
          // single attachment point that can't pin orientation) can't drag it off-axis.
          const tE = placed.find((e) => /2gewinde/.test(e.myF.dockType) && /gewrohr/.test(e.them.type));
          const set = tE ? [tE] : placed;
          let best = world.get(p.id)!, bestS = score(p, best, set, world);
          for (const e of set) for (const c of candidatesFor(p, e, world)) { const s = score(p, c, set, world); if (s < bestS - 1e-6) { bestS = s; best = c; } }
          if (best !== world.get(p.id)) { world.set(p.id, best); changed++; }
        }
        if (!changed) break;
      }
      if (totalViol() > base * 1.5 + 5) for (const [id, m] of before) world.set(id, m); // catastrophic -> revert
    }
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
const unreached = parts.filter((p) => !world.has(p.id));
console.log(`  parts: ${parts.length}   placed by solver: ${world.size}   unreachable: ${unreached.length}   dock frames assumed identity (sub-components): ${unframed}`);
console.log(`  VCML dock rotations evaluated: ${vcmlOk} ok / ${vcmlFail} fail`);
// Honest score: a part the solver could not place counts as a MISS, not as excluded. Denominator = all parts (excl. anchor).
const allN = parts.length - 1;
const correctAll = posMatch; // posMatch is counted only over placed parts; unplaced are misses by construction
console.log(`  >> PLACEMENT (all parts, <=${POS_TOL}cm): ${correctAll}/${allN} (${(100 * correctAll / allN).toFixed(1)}%)   [${unreached.length} unplaced count as misses]`);
if (unreached.length) {
  const byType = new Map<string, number>();
  for (const p of unreached) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  console.log(`  UNPLACED part types (${unreached.length}): ${[...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(", ")}`);
}
if (missFrame.size) console.log(`  MISSING dock frames (top): ${[...missFrame].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}×${n}`).join(", ")}`);
if (noPartner.size) console.log(`  unresolved partner docks: ${[...noPartner].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(", ")}`);
if (storedMates) console.log(`  [USE_STORED_MATES] solved from ${storedMates.size}-pair stored table — ${mateFellBack.size ? `${mateFellBack.size} pair(s) NOT in table, fell back to this config: ${[...mateFellBack].slice(0, 8).join(", ")}` : "FULL coverage, zero reliance on this config's saved poses"}`);
console.log(`  --- of parts the solver placed (${checked} excl. anchor): ---`);
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
  const a = p.artnr || compArtNo.get(p.type); // instance's saved f_artnr wins (e.g. 10742 holed tube vs 10741 plain)
  return a && /^\d[\d.]*$/.test(a) ? a : null; // literal numbers only (skip VCML exprs for now)
};

import("node:fs").then(({ writeFileSync }) => {
  const out = parts.map((p) => {
    const artNo = resolveArtNo(p); const art = artNo ? catalog.get(artNo) : null;
    const meta = { ...(p.e ? { e: p.e } : {}), ...(art ? { artNo, name: art.en, price: art.price, weight: art.weight } : artNo ? { artNo } : {}) };
    if (!world.has(p.id)) {
      // Engine could not place this part (its dock has no frame in any package). Do NOT drop it —
      // surface it flagged at its stored P'X5 position so it is visible as an unplaced part, not gone.
      return { id: p.id, type: p.type, pos: p.pos.map((x) => +x.toFixed(4)), quat: matToQuat(trs(p.pos, p.rot, "XYZ")).map((x) => +x.toFixed(6)), placed: false, ...meta };
    }
    const W = world.get(p.id)!;
    const pq = panelQuad(p, W);
    return { id: p.id, type: p.type, pos: getTranslation(W).map((x) => +x.toFixed(4)), quat: matToQuat(W).map((x) => +x.toFixed(6)),
      ...meta, ...(pq ? { quad: pq.quad, panelKind: pq.kind } : {}) };
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
