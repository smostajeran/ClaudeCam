// © one52 — the customer-facing configure payload. Combines a solved placement, the classified
// conflicts, and a bill of materials into ONE object the app can render directly. It applies the same
// IP boundary as export_ios.ts: one52 stable ids + English labels + RealityKit geometry only. Raw
// USM/Perspectix codes, article numbers and prices are processed internally and never shipped here.
import { placementToRK, identity, posToRK } from "./export_ios.ts";
import { openFaceSlots } from "./slots.ts";

// Stable, opaque conflict code derived from the internal type — lets the app switch/localize on a
// kind without exposing the proprietary German identifier.
const hashCode = (s: string): string => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return "c" + (h >>> 0).toString(36); };

// The solver locks a glass leaf's orientation (its glashalter dock-frame mate doesn't reorient per face),
// so glass renders perpendicular on side faces. Its 4 corner clips ARE seated correctly per face, so derive
// the glass render quat from the clip corners + the glass's own W×H. Robust on every face, survives re-solve.
type V3 = [number, number, number];
const _sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _nrm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
function quatFromBasis(X: V3, Y: V3, Z: V3): number[] {
  const m00 = X[0], m01 = Y[0], m02 = Z[0], m10 = X[1], m11 = Y[1], m12 = Z[1], m20 = X[2], m21 = Y[2], m22 = Z[2];
  const tr = m00 + m11 + m22; let w, x, y, z;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; w = .25 * S; x = (m21 - m12) / S; y = (m02 - m20) / S; z = (m10 - m01) / S; }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / S; x = .25 * S; y = (m01 + m10) / S; z = (m02 + m20) / S; }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / S; x = (m01 + m10) / S; y = .25 * S; z = (m12 + m21) / S; }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / S; x = (m02 + m20) / S; y = (m12 + m21) / S; z = .25 * S; }
  return [x, y, z, w];
}
// corners: >=3 clip corner positions (RK m), any order; dimsMM: glass native [X,Y] lengths from its id.
// Robust to corner ORDER: the two edges of the rectangle at corner[0] are its two NEAREST neighbours (the
// farthest is the diagonal), so order doesn't matter and a non-cyclic clip list still resolves correctly.
function glassQuatFromCorners(corners: V3[], dimsMM: number[]): number[] | null {
  if (corners.length < 3) return null;
  const c0 = corners[0];
  const rest = corners.slice(1).map((c) => ({ v: _sub(c, c0), d: Math.hypot(...(_sub(c, c0) as V3)) })).sort((a, b) => a.d - b.d);
  const eA = rest[0].v, eB = rest[1].v;                                          // two adjacent edges (nearest)
  const Z = _nrm(_cross(eA, eB));                                                // face normal -> native local Z
  if (Math.hypot(...Z) < 1e-6 || !isFinite(Z[0])) return null;                   // collinear / degenerate
  let X = Math.abs(Math.hypot(...(eA as V3)) * 1000 - dimsMM[0]) <= Math.abs(Math.hypot(...(eB as V3)) * 1000 - dimsMM[0]) ? _nrm(eA as V3) : _nrm(eB as V3);
  const Y = _nrm(_cross(Z, X)); X = _nrm(_cross(Y, Z));                          // re-orthonormalize, right-handed
  if (!isFinite(Z[0] + Y[0] + X[0])) return null;
  return quatFromBasis(X, Y, Z);
}
function fixGlassOrientation(parts: any[]): void {
  for (const p of parts) {
    if (p.family !== "glass") continue;
    const clips = parts.filter((c) => String(c.id).startsWith(`${p.id}c`) && Array.isArray(c.pos)); // prefix: robust to count/naming
    const dm = String(p.part).match(/(\d+)x(\d+)/);
    if (clips.length < 3 || !dm) { console.warn(`[glass ${p.id}] ${clips.length} clip(s) — orientation NOT corrected (solver quat kept)`); continue; }
    const q = glassQuatFromCorners(clips.map((c: any) => c.pos), [+dm[1], +dm[2]]);
    if (q) p.quat = q; else console.warn(`[glass ${p.id}] degenerate clip geometry (${clips.length} clips) — orientation NOT corrected`);
  }
}

export function customerPayload(placement: any, conflicts: any, configXml?: string): any {
  const rk = placementToRK(placement); // { meta, parts, catalog } — already IP-safe
  fixGlassOrientation(rk.parts);        // override the solver's locked glass quat with a per-face one from its clips

  // Bill of materials: aggregate the placed parts by one52 part id.
  // Acoustic panels carry the Akustik feature in the config (the solver drops it from the placement, so we
  // read it back here). Flag those parts so the client requests the felt-backed mesh and labels them acoustic.
  const acousticIds = new Set<string>();
  if (configXml) {
    for (const block of configXml.split("<componentset").slice(1)) {
      const end = block.indexOf("</componentset>");
      const head = end >= 0 ? block.slice(0, end) : block;
      const idm = head.match(/_PXI_unique_comp_id="(\d+)"/);
      if (idm && /Akustik="yes"/i.test(head)) acousticIds.add(idm[1]);
    }
  }
  for (const p of rk.parts) if (acousticIds.has(String(p.id))) { p.acoustic = true; if (!/acoustic/i.test(p.label)) p.label = `${p.label} (acoustic)`; }

  const bomMap = new Map<string, any>();
  for (const p of rk.parts) { const key = p.part + (p.acoustic ? "+acoustic" : ""); const e = bomMap.get(key) ?? { part: p.part, label: p.label, family: p.family, acoustic: p.acoustic || undefined, qty: 0 }; e.qty++; bomMap.set(key, e); }
  const bom = [...bomMap.values()].sort((a, b) => a.label.localeCompare(b.label));

  // Conflicts: English title/detail/fix + severity, offending parts mapped to one52 ids/labels.
  const items = (conflicts?.fired ?? []).map((f: any) => ({
    code: hashCode(f.type),
    level: f.level,                         // severe | warning | info  -> app severity/color
    category: f.category,
    title: f.name,
    detail: f.problem || undefined,
    fix: f.solution || undefined,
    parts: (f.parts ?? []).map((q: any) => { const id = identity(q.type); return { id: q.id, part: id.part, label: id.label, pos: q.pos ? posToRK(q.pos) : undefined }; }),
  }));

  return {
    meta: { ...rk.meta, generated: "configure" },
    parts: rk.parts,
    catalog: rk.catalog,
    bom,
    conflicts: { counts: conflicts?.counts ?? { severe: 0, warning: 0, info: 0 }, items },
    affordances: conflicts?.affordances ?? [], // legal edits per part: { id, label, removable, swap[] }
    slots: configXml ? openFaceSlots(configXml, placement) : [], // open faces a panel can be dropped onto
  };
}
