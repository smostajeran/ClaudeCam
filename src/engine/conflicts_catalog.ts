// Conflict catalog + severity classification — the error-handler taxonomy, mirroring P'X5's
// conflict panel. Each <conflict> in conflictrepresentation.xml carries a severity (10 = severe,
// 5 = warning, none = info), display/problem/solution text keys, and a VCML detection expression.
// Text keys are resolved to English via gui_language_en.xml so the UI shows readable messages.
import { parseXmlFile, tagOf, attr, kids } from "../xml/parse.ts";
import { FILES } from "../import/paths.ts";

export type Severity = "severe" | "warning" | "info";
export interface ConflictDef {
  type: string;          // machine type, e.g. "safety_kippgefahr_rot"
  severity: number;      // 10 / 5 / 0
  level: Severity;       // severe (10) / warning (5) / info (none)
  category: string;      // grouped domain: Safety, Electrification, Installation, Printing, ...
  name: string;          // resolved English display name
  problem: string;       // resolved English "what is wrong"
  solution: string;      // resolved English "how to fix"
  multi: boolean;        // multiconflicts flag
  hasExpression: boolean;// has a VCML conflictexpression (vs clause-only)
}

// P'X5 prefixes display keys with category tags like "[CO]:[SF]:[KF]:[LBL] ...". The full string is
// the localization key; we strip the tags only for fallback display when a key is unresolved.
const stripTags = (s: string) => s.replace(/^(\s*\[[^\]]+\]:?)+\s*/, "").trim();
const levelOf = (sev: number): Severity => (sev >= 10 ? "severe" : sev >= 5 ? "warning" : "info");

// Domain grouping for the panel — derived from the type + name (USM's own categories).
function categoryOf(type: string, text: string): string {
  const t = type.toLowerCase(), x = text.toLowerCase();
  if (/(^|_)e($|_)|stromkreis|trafo|hallere|usb|electrif|connector.*e|schlitzrohr.*e|gewindestift.*e/.test(t) || /e-conn/.test(x)) return "Electrification";
  if (/safety|kippgefahr|stabilit|bauhaehe|bauhoehe/.test(t)) return "Safety / stability";
  if (/printzone|print/.test(t) || /druck/.test(x)) return "Printing";
  if (/lonely|undocked|unverbunden|not_(properly_)?connected|not_fully_connected|nichtverbunden/.test(t)) return "Connection";
  if (/deprecated|auslauf|no_more_supported|article_no/.test(t)) return "Article availability";
  if (/gewicht|weight/.test(t)) return "Weight";
  if (/pflanze|pflanzen/.test(t)) return "Plants";
  if (/softpanel|soft_panel/.test(t)) return "Soft panel";
  if (/glas|ecken/.test(t)) return "Glass";
  if (/fraesrohr|fraes|end_milling/.test(t)) return "Tubes";
  return "Installation";
}

/** Load gui_language_<lang>.xml -> Map(key -> resolved text). */
export function loadLocalization(file = FILES.language_en): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const root = parseXmlFile(file);
    (function walk(ns: any[]) { for (const n of ns) { if (tagOf(n) === "environment") { const k = attr(n, "key"), v = attr(n, "value"); if (k != null && v != null) m.set(k, v); } const c = kids(n); if (c.length) walk(c); } })(root);
  } catch { /* localization optional; fall back to humanized keys */ }
  return m;
}

/** Load the full conflict catalog with severity + English text. */
export function loadConflictCatalog(opts?: { loc?: Map<string, string>; file?: string }): ConflictDef[] {
  const loc = opts?.loc ?? loadLocalization();
  const resolve = (k?: string | null): string => {
    if (!k) return "";
    return loc.get(k) ?? loc.get(stripTags(k)) ?? stripTags(k);
  };
  const root = parseXmlFile(opts?.file ?? FILES.conflictrepresentation);
  const seen = new Set<string>();
  const defs: ConflictDef[] = [];
  (function walk(ns: any[]) {
    for (const n of ns) {
      if (tagOf(n) === "conflict") {
        const type = attr(n, "type") ?? "";
        const text = attr(n, "text") ?? "";
        const key = type + "|" + text; // a type can appear twice (e.g. safety_kippgefahr_rot) with different text
        if (type && type !== "dummy" && !seen.has(key)) {
          seen.add(key);
          const sev = Number(attr(n, "severity") ?? 0) || 0;
          defs.push({
            type, severity: sev, level: levelOf(sev), category: categoryOf(type, text),
            name: resolve(text) || stripTags(type), problem: resolve(attr(n, "problemtext")), solution: resolve(attr(n, "solutiontext")),
            multi: attr(n, "multiconflicts") === "true", hasExpression: attr(n, "conflictexpression") != null,
          });
        }
      }
      const c = kids(n); if (c.length) walk(c);
    }
  })(root);
  return defs;
}

if (process.argv[1]?.endsWith("conflicts_catalog.ts")) {
  const cat = loadConflictCatalog();
  const by = (l: Severity) => cat.filter((c) => c.level === l);
  console.log(`=== CONFLICT CATALOG (error handler taxonomy) — ${cat.length} definitions ===`);
  for (const lvl of ["severe", "warning", "info"] as Severity[]) {
    const g = by(lvl);
    console.log(`\n  ${lvl.toUpperCase()} (${g.length}):`);
    for (const c of g.slice(0, 12)) console.log(`    [${c.category}] ${c.name}${c.problem ? "  —  " + c.problem.slice(0, 60) : ""}`);
    if (g.length > 12) console.log(`    … +${g.length - 12} more`);
  }
}
