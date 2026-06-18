// © one52 — the customer-facing configure payload. Combines a solved placement, the classified
// conflicts, and a bill of materials into ONE object the app can render directly. It applies the same
// IP boundary as export_ios.ts: one52 stable ids + English labels + RealityKit geometry only. Raw
// USM/Perspectix codes, article numbers and prices are processed internally and never shipped here.
import { placementToRK, identity, posToRK } from "./export_ios.ts";

// Stable, opaque conflict code derived from the internal type — lets the app switch/localize on a
// kind without exposing the proprietary German identifier.
const hashCode = (s: string): string => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return "c" + (h >>> 0).toString(36); };

export function customerPayload(placement: any, conflicts: any): any {
  const rk = placementToRK(placement); // { meta, parts, catalog } — already IP-safe

  // Bill of materials: aggregate the placed parts by one52 part id.
  const bomMap = new Map<string, any>();
  for (const p of rk.parts) { const e = bomMap.get(p.part) ?? { part: p.part, label: p.label, family: p.family, qty: 0 }; e.qty++; bomMap.set(p.part, e); }
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
  };
}
