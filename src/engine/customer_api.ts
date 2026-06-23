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
    if (clips.length < 3 || !dm) { console.warn(`[glass ${p.id}] ${clips.length} clip(s) — pose NOT corrected (solver pose kept)`); continue; }
    // part-mesh normalizes every glass to a PORTRAIT frame (short edge on local X, long edge on local Y),
    // so align local X to the face's SHORT edge and local Y to its LONG edge. (Glass .3d authoring is
    // inconsistent — some landscape, some portrait — so we can't trust the id's axis order.)
    const q = glassQuatFromCorners(clips.map((c: any) => c.pos), [Math.min(+dm[1], +dm[2]), Math.max(+dm[1], +dm[2])]);
    if (!q) { console.warn(`[glass ${p.id}] degenerate clip geometry (${clips.length} clips) — pose NOT corrected`); continue; }
    p.quat = q;
    // The solver sometimes lays a glass pane out flat (hinged on one edge), so its pos floats off the
    // opening. The clip corners are seated on the real face, so the clip CENTROID is the true face centre.
    const ctr: V3 = [0, 0, 0]; for (const c of clips) for (let k = 0; k < 3; k++) ctr[k] += c.pos[k] / clips.length;
    p.pos = ctr.map((x) => +x.toFixed(5));
    // The iOS client draws glass from part.quad (the razor-thin glass mesh can fail MeshResource.generate,
    // so it falls back to a primitive that uses the quad). The solver's quad is the stale laid-flat one, so
    // overwrite it with the clip-corner rectangle (the real face plane), ordered by clip index to stay cyclic.
    const ordered = clips.slice().sort((a: any, b: any) => (+String(a.id).match(/c(\d+)$/)?.[1]! || 0) - (+String(b.id).match(/c(\d+)$/)?.[1]! || 0));
    if (ordered.length === 4) p.quad = ordered.map((c: any) => c.pos);

    // Per-corner clamp orientation. The solver leaves all clips at one orientation, so 3 of 4 grip the wrong
    // way. The glashalter is a two-jaw fork (asset-derived native frame): the grip points along local
    // [-1,-1,0] (fork body) and the slot/glass-normal is local Z. Orient each clamp so its grip points
    // INWARD (toward the face centre) and its slot axis aligns with the face NORMAL.
    const cc = clips.map((c: any) => c.pos as V3);
    const c0 = cc[0];
    const near = cc.slice(1).map((c) => ({ v: _sub(c, c0), d: Math.hypot(...(_sub(c, c0) as V3)) })).sort((a, b) => a.d - b.d);
    const N = _nrm(_cross(near[0].v, near[1].v));                       // face normal (same for all 4 clips)
    const u1 = _nrm([-1, -1, 0]), u2: V3 = [0, 0, 1], u3 = _cross(u1, u2); // native clamp frame: grip, slot, third
    for (const c of clips) {
      const I = _nrm(_sub(ctr, c.pos as V3));                           // inward (toward face centre)
      const t1 = I, t2 = N, t3 = _cross(t1, t2);                        // target frame
      const colk = (k: number): V3 => [u1[k] * t1[0] + u2[k] * t2[0] + u3[k] * t3[0], u1[k] * t1[1] + u2[k] * t2[1] + u3[k] * t3[1], u1[k] * t1[2] + u2[k] * t2[2] + u3[k] * t3[2]];
      c.quat = quatFromBasis(colk(0), colk(1), colk(2)).map((x) => +x.toFixed(6));
    }
  }
}

const _dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function _qrot(q: number[], v: V3): V3 {
  const [x, y, z, w] = q; const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const _qmul = (a: number[], b: number[]): number[] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
// Solid/perforated panels (metal-panel, perforated-metal-panel) are an asymmetric tray: the flat metal
// face is on local -Y (asset-derived: it covers the full area; the +Y end is just the open lip rim), and
// the lip should tuck INWARD. The solver seats the lip either way per face, so make it consistent: if a
// panel's flat face points toward the structure interior, flip it 180° about local X (swaps flat<->lip,
// keeps the panel in its plane). Glass/shelves/hardware are untouched.
const FLAT_FACE_LOCAL: V3 = [0, -1, 0];
const FLIP_X180 = [1, 0, 0, 0]; // 180° about local X
function fixPanelLip(parts: any[]): void {
  const panels = parts.filter((p) => /^(metal-panel|perforated-metal-panel)-/.test(String(p.part)) && Array.isArray(p.pos) && Array.isArray(p.quat));
  if (panels.length < 2) return;
  const ctr: V3 = [0, 0, 0]; let n = 0;
  for (const p of parts) if (Array.isArray(p.pos)) { for (let k = 0; k < 3; k++) ctr[k] += p.pos[k]; n++; }
  for (let k = 0; k < 3; k++) ctr[k] /= n || 1;
  for (const p of panels) {
    const flatWorld = _qrot(p.quat, FLAT_FACE_LOCAL);
    const outward = _nrm(_sub(p.pos as V3, ctr));
    if (_dot(flatWorld, outward) < 0) p.quat = _qmul(p.quat, FLIP_X180).map((x) => +x.toFixed(6)); // flat face inward -> flip
  }
}

export function customerPayload(placement: any, conflicts: any, configXml?: string): any {
  const rk = placementToRK(placement); // { meta, parts, catalog } — already IP-safe
  fixGlassOrientation(rk.parts);        // override the solver's locked glass quat with a per-face one from its clips
  fixPanelLip(rk.parts);                // make every panel's lip tuck inward (flat metal face outward)

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
