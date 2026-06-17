// © one52 — iOS export. Produces a one52-OWNED representation of a solved scene for the app:
// our own stable part IDs + English labels + RealityKit transforms (geometry is a mathematical
// fact). It deliberately EXCLUDES the proprietary Perspectix/USM source identifiers — raw German
// cartridge codes, article numbers and prices — which are processed internally only and are NOT
// redistributed in the shipped payload. This both protects one52's work product and keeps USM's
// proprietary data out of the app bundle.
//
// Frame: P'X5 (cm, Z-up, RH) -> RealityKit (m, Y-up, RH) via one RotX(-90°) for every part.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type V3 = [number, number, number];
export type Q = [number, number, number, number]; // x, y, z, w

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const QR: Q = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];  // RotX(-90°)
const QRc: Q = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const S = 0.01; // cm -> m
export const posToRK = (p: V3): V3 => [+(p[0] * S).toFixed(5), +(p[2] * S).toFixed(5), +(-p[1] * S).toFixed(5)];
export const quatToRK = (q: Q): Q => qmul(qmul(QR, q), QRc).map((x) => +x.toFixed(6)) as Q;

// --- one52 identity: derive our own stable id + English label from the glossary (no USM codes) ---
let GLOSS: any = { stems: {}, qualifiers: {}, features: {} };
// resolve glossary.json relative to THIS module (not cwd) so the conversion works when the server
// spawns it from any directory — otherwise labels/ids fall back to raw USM codes (an IP leak).
const GLOSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "glossary.json");
try { GLOSS = JSON.parse(readFileSync(GLOSS_PATH, "utf8")); } catch { /* fall back to slugged code */ }

function prettyName(type: string): string {
  if (!type) return type;
  const low = String(type).toLowerCase();
  let stem = "", eng = "";
  for (const k in GLOSS.stems) if (low.startsWith(k) && k.length > stem.length) { stem = k; eng = GLOSS.stems[k]; }
  if (!eng) return type;
  let size = ""; const m2 = type.match(/(\d{2,4})([_x\/])(\d{2,4})/);
  if (m2) { const a = +m2[1], b = +m2[3]; size = ` ${m2[2] === "_" ? b + " × " + a : a + " × " + b} mm`; }
  else { const m1 = type.match(/(\d{2,4})/); if (m1) size = ` ${+m1[1]} mm`; }
  const rest = low.slice(stem.length).replace(/\d+/g, " ").split(/[_\/\s]/).filter(Boolean);
  const quals = rest.map((t) => GLOSS.qualifiers[t]).filter(Boolean);
  const lr = quals.filter((q) => q === "left" || q === "right"), others = quals.filter((q) => q !== "left" && q !== "right");
  let name = eng + size;
  if (others.length) name += ` (${[...others, ...lr].join(", ")})`;
  else if (lr.length) name = lr.join("/") + " " + name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
const slug = (s: string) => s.toLowerCase().replace(/\s*×\s*/g, "x").replace(/\bmm\b/g, "").replace(/[(),]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
function family(t: string): string {
  const x = t.toLowerCase();
  if (/scharnier|halter/.test(x)) return "fitting";
  if (/glas/.test(x)) return "glass";
  if (/^kugel/.test(x)) return "connector";
  if (/rohr/.test(x)) return "tube";
  if (/blech|tablar|boden|rueckwand|abdeck|verkleidung/.test(x)) return "panel";
  if (/tuer|klapp|einschub|schiebe/.test(x)) return "door";
  if (/schublade|auszug|teleskop|ausziehtablar/.test(x)) return "drawer";
  if (/fuss|rolle/.test(x)) return "support";
  if (/trafo|verbraucher|safety|klemm|griff|schloss|scheren|winkel|zapfen/.test(x)) return "hardware";
  return "other";
}
export const identity = (type: string) => { const label = prettyName(type); return { part: slug(label) || "part", label, family: family(type), resolved: label !== type }; };

// Convert a solved placement to the one52 iOS payload (own ids/labels + RealityKit transforms only).
export function placementToRK(pl: any): any {
  const parts = (pl.parts ?? []).map((p: any) => {
    const id = identity(p.type);
    return {
      id: p.id, part: id.part, label: id.label, family: id.family,
      pos: posToRK(p.pos), quat: quatToRK(p.quat),
      ...(p.e ? { role: p.e } : {}),
      ...(p.quad ? { quad: p.quad.map((c: V3) => posToRK(c)) } : {}),
      // intentionally omitted: USM artNo / price / catalog name / raw German type code
    };
  });
  const cat = new Map<string, any>();
  for (const p of parts) if (!cat.has(p.part)) cat.set(p.part, { part: p.part, label: p.label, family: p.family });
  return {
    meta: {
      owner: "one52",
      notice: "one52 derived representation. Geometry computed by the one52 configurator engine. Proprietary Perspectix/USM source identifiers, article numbers and prices are processed internally and are NOT included here.",
      frame: "RealityKit", units: "m", up: "Y",
    },
    parts,
    catalog: [...cat.values()].sort((a, b) => a.part.localeCompare(b.part)),
  };
}

// CLI: out/placement.json -> out/placement.ios.json (one52 schema)
if (process.argv[1]?.endsWith("export_ios.ts")) {
  const f = "out/placement.json";
  if (!existsSync(f)) { console.log("no out/placement.json (run solve.ts first)"); process.exit(0); }
  const rk = placementToRK(JSON.parse(readFileSync(f, "utf8")));
  writeFileSync("out/placement.ios.json", JSON.stringify(rk, null, 1));
  console.log(`wrote out/placement.ios.json — one52 schema, ${rk.parts.length} parts, ${rk.catalog.length} distinct (metres/Y-up, no USM identifiers)`);
  const s = rk.parts.find((p: any) => p.label?.startsWith("Glass hinge"));
  if (s) console.log(`  sample: part="${s.part}" label="${s.label}" pos=${JSON.stringify(s.pos)} quat=${JSON.stringify(s.quat)}`);
}
