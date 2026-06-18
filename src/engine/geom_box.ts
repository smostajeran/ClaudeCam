// Pragmatic part geometry for COLLISION conflicts. P'X5 uses true meshes; we approximate each part
// with a world-space axis-aligned box:
//   - panels (blech/tablar/...) -> the rectangle defined by the tubes they connect to, thin in the
//     panel's normal axis (exact, no dimension guessing).
//   - pull-out trays / drawers   -> width x depth x thin, from the two numbers in the type, placed at
//     the part's position with its (horizontal) orientation.
// This is enough to detect the "extension shelf collides at the rear with a metal panel" family that
// P'X5 resolves geometrically and that has no data-defined rule to extract.
import type { ScenePart } from "./scene.ts";

export interface Box { min: [number, number, number]; max: [number, number, number]; part: ScenePart }

const PANEL = /^(blech|kurzblech|lochblech|biblioblech|tablar|boden|abdeck|metallverkleidung|perfblech|rueckwand)/;
const TRAY = /^(ausziehtablar|schublade|auszieh|schubladenkorpus|ausziehtuertablar)/;

const twoNums = (type: string): [number, number] | null => {
  const m = type.match(/(\d{2,4})[_x](\d{2,4})/);
  return m ? [Number(m[1]) / 10, Number(m[2]) / 10] : null;
};

// AABB of a panel = bounding box of the tube-connection points, with a thin thickness on the axis
// where those points are coplanar (the panel's normal).
function panelBox(p: ScenePart): Box | null {
  const pts = (p.docks || []).filter((d) => d.connectedPart).map((d) => d.connectedPart!.pos);
  if (pts.length < 2) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const q of pts) { const v = [q.x, q.y, q.z]; for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; } }
  const c = [p.pos.x, p.pos.y, p.pos.z];
  for (let k = 0; k < 3; k++) if (max[k] - min[k] < 2) { min[k] = c[k] - 0.7; max[k] = c[k] + 0.7; } // normal axis -> ~1.4cm thick
  return { min, max, part: p };
}

// AABB of a horizontal pull-out tray/drawer: width (larger number) along X, depth (smaller) along the
// part's facing axis. For the rear-collision check we centre it on its position and use the type depth.
function trayBox(p: ScenePart): Box | null {
  const d = twoNums(p.type); if (!d) return null;
  const w = Math.max(d[0], d[1]), depth = Math.min(d[0], d[1]);
  const rz = ((p.rot.z % 360) + 360) % 360; // trays sit horizontal; rot.z just flips x/y sign (AABB-invariant)
  // width spans X, depth spans Y (front<->back), thin in Z (height). Holds for rot.x ~ 0.
  const c = [p.pos.x, p.pos.y, p.pos.z];
  return {
    min: [c[0] - w / 2, c[1] - depth / 2, c[2] - 1.5],
    max: [c[0] + w / 2, c[1] + depth / 2, c[2] + 1.5],
    part: p,
  };
}

export function partBox(p: ScenePart): Box | null {
  if (PANEL.test(p.type)) return panelBox(p);
  if (TRAY.test(p.type)) return trayBox(p);
  return null; // not boxed yet (tubes/balls/doors/fittings) -> excluded from collision tests
}

const overlap1 = (aMin: number, aMax: number, bMin: number, bMax: number) => Math.min(aMax, bMax) - Math.max(aMin, bMin);
// boxes overlap if they penetrate by > margin on every axis.
export function boxesOverlap(a: Box, b: Box, margin = 0.3): boolean {
  for (let k = 0; k < 3; k++) if (overlap1(a.min[k], a.max[k], b.min[k], b.max[k]) <= margin) return false;
  return true;
}
// the thinnest axis of a box = its face normal (0=X, 1=Y, 2=Z).
export const thinAxis = (b: Box): number => {
  const e = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  return e[0] <= e[1] && e[0] <= e[2] ? 0 : e[1] <= e[2] ? 1 : 2;
};

const connected = (a: ScenePart, b: ScenePart) =>
  (a.docks || []).some((d) => d.connectedPart === b) || (b.docks || []).some((d) => d.connectedPart === a);

export interface Collision { a: ScenePart; b: ScenePart; kind: "tray-rear-panel" }

// A pull-out tray is BLOCKED only by a panel standing across its pull-out direction (the tray's depth
// axis). The floor it rests on (normal Z) and the side walls (normal X) are not blockers — only a
// panel whose normal is the tray's depth axis and that lies within the tray's depth span. Generic
// metal-metal overlap is NOT reported: panels tile the frame and share tubes, so their boxes touch
// everywhere (false positives even on a clean config). This is the one collision we can call reliably.
export function getCollisions(scene: ScenePart[], margin = 0.3): Collision[] {
  const boxes = scene.map(partBox).filter((b): b is Box => !!b);
  const out: Collision[] = [];
  const trays = boxes.filter((b) => TRAY.test(b.part.type));
  const panels = boxes.filter((b) => PANEL.test(b.part.type));
  for (const t of trays) {
    const depthAxis = thinAxis(t) === 2 ? 1 : 0; // tray is thin in Z (height); its depth is the shorter horizontal axis
    for (const p of panels) {
      if (connected(t.part, p.part)) continue;
      if (thinAxis(p) !== depthAxis) continue;            // panel must stand ACROSS the pull-out direction
      if (!boxesOverlap(t, p, margin)) continue;
      out.push({ a: p.part, b: t.part, kind: "tray-rear-panel" });
    }
  }
  return out;
}
