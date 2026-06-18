// Extract per-component dock FRAMES (local translation + rotation) from componentsystem.xml.
// Each dock defines where it sits on its part; the solver composes these along connections.
// Rotation components may be literals or VCML expressions (e.g. "call dockRotationKugel(part,'x');").
import { parseXmlFile, tagOf, attr, kids, byTag } from "../xml/parse.ts";
import { SNX } from "../import/paths.ts";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DockFrame {
  dockType: string;
  index: number;
  t: [number, number, number];   // local translation (cm)
  r: [string, string, string];   // local rotation euler (deg) — raw (literal or VCML)
  active?: string;               // VCML guard expression, if any
}
export type DockFrameMap = Map<string, DockFrame[]>; // componentType -> its docks

function num(s: string | undefined): number { const n = Number(s); return Number.isNaN(n) ? 0 : n; }

function collectComponents(nodes: any[], out: any[]): void {
  for (const n of nodes) {
    if (tagOf(n) === "component" && attr(n, "type")) out.push(n);
    const k = kids(n);
    if (k.length) collectComponents(k, out);
  }
}

export function loadDockFrames(file = `${SNX}/cartridge/componentsystem.xml`): DockFrameMap {
  const root = parseXmlFile(file);
  const comps: any[] = [];
  collectComponents(root, comps);
  const map: DockFrameMap = new Map();
  for (const c of comps) {
    const type = attr(c, "type")!;
    const docks = byTag(kids(c), "dock");
    if (!docks.length) continue;
    const frames: DockFrame[] = [];
    for (const d of docks) {
      const dk = kids(d);
      const tr = byTag(dk, "translation")[0];
      const ro = byTag(dk, "rotation")[0];
      frames.push({
        dockType: attr(d, "type") ?? "",
        index: num(attr(d, "index")) || 1,
        t: tr ? [num(attr(tr, "x")), num(attr(tr, "y")), num(attr(tr, "z"))] : [0, 0, 0],
        r: ro ? [attr(ro, "x") ?? "0", attr(ro, "y") ?? "0", attr(ro, "z") ?? "0"] : ["0", "0", "0"],
        active: attr(d, "active"),
      });
    }
    // a component type can appear under multiple wrappers; merge (first wins per dockType+index)
    const existing = map.get(type) ?? [];
    const seen = new Set(existing.map((f) => f.dockType + "#" + f.index));
    for (const f of frames) if (!seen.has(f.dockType + "#" + f.index)) { existing.push(f); seen.add(f.dockType + "#" + f.index); }
    map.set(type, existing);
  }
  return map;
}

// Merge a source map into a target map, additively (first definition of a dockType#index wins).
function mergeInto(target: DockFrameMap, src: DockFrameMap): void {
  for (const [type, frames] of src) {
    const existing = target.get(type) ?? [];
    const seen = new Set(existing.map((f) => f.dockType + "#" + f.index));
    for (const f of frames) if (!seen.has(f.dockType + "#" + f.index)) { existing.push(f); seen.add(f.dockType + "#" + f.index); }
    target.set(type, existing);
  }
}

// Load and merge dock frames from EVERY package under the packages root, not just hallerpackage.
// USM splits component definitions across packages (feet/plants/handles live in addonspackage, etc.);
// loading one package silently drops every part whose docks are defined elsewhere. hallerpackage is
// loaded first so it wins for any shared type (in practice the type sets are disjoint).
export function loadAllDockFrames(packagesRoot = join(SNX, "..")): DockFrameMap {
  const map: DockFrameMap = new Map();
  let dirs: string[] = [];
  try { dirs = readdirSync(packagesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* root absent */ }
  dirs.sort((a, b) => (a === "hallerpackage" ? -1 : b === "hallerpackage" ? 1 : a.localeCompare(b)));
  for (const pkg of dirs) {
    const file = join(packagesRoot, pkg, "cartridge", "componentsystem.xml");
    if (existsSync(file)) mergeInto(map, loadDockFrames(file));
  }
  return map;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("dockframes.ts")) {
  const m = loadDockFrames();
  let docks = 0; for (const v of m.values()) docks += v.length;
  console.log(`dock frames: ${m.size} component types, ${docks} docks`);
  for (const t of ["kugel_std", "rohr350"]) {
    const f = m.get(t) ?? [];
    console.log(`\n${t} (${f.length} docks):`);
    for (const d of f.slice(0, 6)) console.log(`  ${d.dockType}#${d.index}  t=[${d.t}]  r=[${d.r}]${d.active ? "  active?" : ""}`);
  }
}
