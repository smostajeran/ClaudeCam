// Calibrate the dock-mating convention: for each connected edge, the mate transform
//   M = inv(worldFrame(dockA)) * worldFrame(dockB)
// must be CONSTANT if the euler order + mating convention are correct. Search the 6 euler
// orders and report which makes M most constant, plus the canonical M.
import { readdirSync, readFileSync } from "node:fs";
import { parseXmlFile, tagOf, attr, kids, byTag } from "../xml/parse.ts";
import { loadDockFrames } from "./dockframes.ts";
import { trs, mul, invRigid, getTranslation, matToQuat, quatAngleDeg, dist } from "./geom.ts";
import type { Vec3 } from "./geom.ts";

function findFile(dir: string, name: string): string | null {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (f.name === name) return p;
  }
  return null;
}

interface Part { type: string; pos: Vec3; rot: Vec3; docks: { type: string; index: number; dockid: string; partner: string }[] }
const cfg = process.argv[2] ?? findFile("oracle/test_project", "config.px5");
if (!cfg) { console.log("no config.px5"); process.exit(0); }

const root = parseXmlFile(cfg);
function collect(nodes: any[], out: any[]) { for (const n of nodes) { if (tagOf(n) === "componentset") out.push(n); const k = kids(n); if (k.length) collect(k, out); } }
const csNodes: any[] = []; collect(root, csNodes);

const num = (s: string | undefined) => { const n = Number(s); return Number.isNaN(n) ? 0 : n; };
const parts: Part[] = csNodes.map((cs) => {
  const k = kids(cs);
  const pos = byTag(k, "pos")[0], rot = byTag(k, "rot")[0];
  return {
    type: attr(cs, "type")!,
    pos: [num(attr(pos, "x")), num(attr(pos, "y")), num(attr(pos, "z"))],
    rot: [num(attr(rot, "x")), num(attr(rot, "y")), num(attr(rot, "z"))],
    docks: byTag(k, "connecteddock").map((d) => ({ type: attr(d, "type")!, index: num(attr(d, "index")) || 1, dockid: attr(d, "dockid")!, partner: attr(d, "connecteddockid")! })),
  };
});

// global dockid -> {part, dockType, index}
const byDockId = new Map<string, { p: Part; type: string; index: number }>();
for (const p of parts) for (const d of p.docks) byDockId.set(d.dockid, { p, type: d.type, index: d.index });

const frames = loadDockFrames();
const frameOf = (ptype: string, dtype: string, index: number) => (frames.get(ptype) ?? []).find((f) => f.dockType === dtype && f.index === index);

// build edges (each undirected connection once)
const edges: { a: Part; af: any; b: Part; bf: any; key: string }[] = [];
const done = new Set<string>();
for (const p of parts) for (const d of p.docks) {
  const e = [d.dockid, d.partner].sort().join("-");
  if (done.has(e)) continue; done.add(e);
  const partner = byDockId.get(d.partner); if (!partner) continue;
  const af = frameOf(p.type, d.type, d.index), bf = frameOf(partner.p.type, partner.type, partner.index);
  if (!af || !bf) continue;
  // skip docks whose rotation is a VCML expression (handled later via interp); calibrate on literals
  if (af.r.concat(bf.r).some((s: string) => Number.isNaN(Number(s)))) continue;
  edges.push({ a: p, af, b: partner.p, bf, key: `${d.type}->${partner.type}` });
}

const ORDERS = ["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"];
function frameWorld(part: Part, f: any, order: string) {
  const r: Vec3 = [Number(f.r[0]), Number(f.r[1]), Number(f.r[2])];
  return mul(trs(part.pos, part.rot, order), trs(f.t, r, order));
}

console.log(`edges with literal dock rotations: ${edges.length} (of ${[...done].length} connections)`);
let best = { order: "", spread: Infinity, posSpread: 0, M: [] as number[] };
for (const order of ORDERS) {
  const Ms = edges.map((e) => mul(invRigid(frameWorld(e.a, e.af, order)), frameWorld(e.b, e.bf, order)));
  // measure how constant M is: spread of translation + spread of orientation vs the first M
  const q0 = matToQuat(Ms[0]), t0 = getTranslation(Ms[0]);
  let ang = 0, pos = 0;
  for (const M of Ms) { ang += quatAngleDeg(q0, matToQuat(M)); pos += dist(t0, getTranslation(M)); }
  ang /= Ms.length; pos /= Ms.length;
  console.log(`  order ${order}: mean Δangle=${ang.toFixed(2)}°  mean Δpos=${pos.toFixed(3)}cm  M0.t=[${t0.map((x) => x.toFixed(2))}]`);
  if (ang + pos < best.spread) best = { order, spread: ang + pos, posSpread: pos, M: Ms[0] };
}
console.log(`\nBEST euler order: ${best.order}  (mate constant within Δ=${best.spread.toFixed(3)})`);
console.log(`canonical mate M: t=[${getTranslation(best.M).map((x) => x.toFixed(3))}]  quat=[${matToQuat(best.M).map((x) => x.toFixed(3))}]`);

// distribution of mate ROTATION under XYZ: how often is M ~identity vs a flip? group outliers by dock pair.
const order = "XYZ", idq: [number, number, number, number] = [0, 0, 0, 1];
const buckets = new Map<number, number>();         // rounded angle -> count
const pairAngle = new Map<string, Set<number>>();  // dockType pair -> set of rounded angles
let idCount = 0, posOff = 0;
for (const e of edges) {
  const M = mul(invRigid(frameWorld(e.a, e.af, order)), frameWorld(e.b, e.bf, order));
  const ang = Math.round(quatAngleDeg(idq, matToQuat(M)));
  buckets.set(ang, (buckets.get(ang) ?? 0) + 1);
  if (ang <= 1) idCount++;
  posOff += Math.hypot(...getTranslation(M));
  (pairAngle.get(e.key) ?? pairAngle.set(e.key, new Set()).get(e.key)!).add(ang);
}
console.log(`\nmate ROTATION distribution (XYZ), mean |M.t|=${(posOff / edges.length).toFixed(4)}cm:`);
console.log(`  M≈identity (≤1°): ${idCount}/${edges.length} (${(100 * idCount / edges.length).toFixed(1)}%)`);
for (const [a, n] of [...buckets].sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`    ${a}°: ${n}`);
const multi = [...pairAngle].filter(([, s]) => s.size > 1);
console.log(`  dock pairs with NON-constant mate angle: ${multi.length}/${pairAngle.size}`);
for (const [k, s] of multi.slice(0, 8)) console.log(`    ${k}: angles {${[...s].sort((a, b) => a - b).join(",")}}`);
