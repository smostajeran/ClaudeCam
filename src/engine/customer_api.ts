// © one52 — the customer-facing configure payload. Combines a solved placement, the classified
// conflicts, and a bill of materials into ONE object the app can render directly. It applies the same
// IP boundary as export_ios.ts: one52 stable ids + English labels + RealityKit geometry only. Raw
// USM/Perspectix codes, article numbers and prices are processed internally and never shipped here.
import { placementToRK, identity, posToRK } from "./export_ios.ts";
import { openFaceSlots } from "./slots.ts";

// Stable, opaque conflict code derived from the internal type — lets the app switch/localize on a
// kind without exposing the proprietary German identifier.
const hashCode = (s: string): string => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return "c" + (h >>> 0).toString(36); };

export function customerPayload(placement: any, conflicts: any, configXml?: string): any {
  const rk = placementToRK(placement); // { meta, parts, catalog } — already IP-safe

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
