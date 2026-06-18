// © one52 — affordances: the legal edits the app can offer for a solved scene, derived from the part
// model (dock signatures). For each placed part:
//   swap      -> other component types with the same size + mounting docks (panel <-> glass <-> shelf)
//   removable -> the part is a non-structural element that can be taken out
// All identifiers are one52 (English labels via identity()); no raw USM codes are emitted.
// NOT YET: per-part `configure` (overwritable property options) — the model over-assigns some props
// (e.g. transformer-model to every ball), so it needs PropertyActive evaluation to avoid misleading
// options; deferred rather than shipped noisy.
import { identity } from "./export_ios.ts";
import type { ScenePart } from "./scene.ts";

const sizeTok = (t: string): string => (t.match(/(\d{2,4}[_x]\d{2,4})/) ?? t.match(/(\d{2,4})/) ?? [])[1] ?? "";
const dockCounts = (docks: any[]): Record<string, number> => { const m: Record<string, number> = {}; for (const d of docks ?? []) m[d.type] = (m[d.type] ?? 0) + 1; return m; };

// Families that can be swapped among each other (compartment fillers / structural tubes). Keeps a
// swap list meaningful — a panel won't be offered to "become" a fitting.
const SWAP_GROUP: Record<string, string> = { panel: "fill", glass: "fill", door: "fill", drawer: "fill", tube: "tube" };
const REMOVABLE = new Set(["panel", "glass", "door", "drawer", "fitting", "hardware", "other"]);

export function buildAffordances(scene: ScenePart[], model: any): any[] {
  // precompute per component type: dock-type counts + size
  const sig = new Map<string, { d: Record<string, number>; size: string }>();
  for (const c of model.components) sig.set(c.type, { d: dockCounts(c.docks), size: sizeTok(c.type) });

  const out: any[] = [];
  for (const p of scene) {
    if ((p as any).placed === false) continue;
    const id = identity(p.type);
    const myGroup = SWAP_GROUP[id.family];
    const conn = dockCounts((p.docks ?? []).filter((d: any) => d.connectedPart));
    const mySize = sizeTok(p.type);

    // SWAP: same size, has at least this instance's connected docks, in a compatible swap group.
    // Exclude candidates that resolve to the SAME one52 identity (different USM code, same product).
    const swap = new Map<string, any>();
    if (myGroup && mySize && Object.keys(conn).length) {
      for (const c of model.components) {
        if (c.type === p.type) continue;
        const s = sig.get(c.type)!; if (s.size !== mySize) continue;
        let ok = true; for (const dt in conn) if ((s.d[dt] ?? 0) < conn[dt]) { ok = false; break; }
        if (!ok) continue;
        const cid = identity(c.type);
        if (cid.resolved && cid.part !== id.part && SWAP_GROUP[cid.family] === myGroup && !swap.has(cid.part)) swap.set(cid.part, { part: cid.part, label: cid.label, family: cid.family });
      }
    }

    const removable = REMOVABLE.has(id.family) && id.family !== "tube" && id.family !== "connector";
    if (swap.size || removable)
      out.push({ id: p.id, part: id.part, label: id.label, removable, swap: [...swap.values()].slice(0, 12) });
  }
  return out;
}
