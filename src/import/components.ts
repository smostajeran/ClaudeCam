// Import componentsystem.xml (nested -> supertype) + docksystem.xml (types/partners/DOF).
import { parseXmlFile, tagOf, attr, kids, byTag, numOrRaw } from "../xml/parse.ts";
import type { XNode } from "../xml/parse.ts";
import type { Component, Dock, Dof, DockType, Vec3, Axis } from "../model.ts";
import { FILES } from "./paths.ts";

function vec(n: XNode | undefined): Vec3 {
  if (!n) return { x: 0, y: 0, z: 0 };
  return { x: numOrRaw(attr(n, "x")), y: numOrRaw(attr(n, "y")), z: numOrRaw(attr(n, "z")) };
}
function isDyn(v: Vec3): boolean {
  return typeof v.x === "string" || typeof v.y === "string" || typeof v.z === "string";
}
function parseDof(n: XNode): Dof | undefined {
  const d = kids(n).find((c) => tagOf(c) === "dof");
  if (!d) return undefined;
  const dom = kids(d).find((c) => tagOf(c) === "domain");
  const vecNode = kids(d).find((c) => tagOf(c) === "vector");
  const def = attr(d, "default");
  return {
    kind: attr(d, "type") === "trans" ? "trans" : "rota",
    axis: (attr(d, "axis") ?? "z") as Axis,
    vector: vecNode ? vec(vecNode) : undefined,
    domain: dom
      ? {
          kind: attr(dom, "type") === "step" ? "step" : "continuous",
          from: numOrRaw(attr(dom, "from")),
          to: numOrRaw(attr(dom, "to")),
          step: attr(dom, "stepwidth") != null ? numOrRaw(attr(dom, "stepwidth")) : undefined,
        }
      : undefined,
    default: def != null && def !== "" && !Number.isNaN(Number(def)) ? Number(def) : undefined,
  };
}
function extractDocks(children: XNode[]): Dock[] {
  const out: Dock[] = [];
  for (const c of children) {
    if (tagOf(c) !== "dock") continue;
    const cc = kids(c);
    const tr = vec(cc.find((k) => tagOf(k) === "translation"));
    const ro = vec(cc.find((k) => tagOf(k) === "rotation"));
    const incNode = cc.find((k) => tagOf(k) === "increment");
    const incTr = incNode ? vec(kids(incNode).find((k) => tagOf(k) === "translation")) : undefined;
    const amountStr = attr(c, "amount");
    const dof = parseDof(c);
    out.push({
      index: Number(attr(c, "index") ?? 0),
      type: attr(c, "type") ?? "",
      partnerTypes: [],
      translate: tr,
      euler: ro,
      amount: amountStr && incTr ? { count: Number(amountStr), increment: incTr } : undefined,
      activeExpr: attr(c, "active"),
      dof,
      hasDynamic: isDyn(tr) || isDyn(ro) || undefined,
    });
  }
  return out;
}

// Descend through ANY wrapper element; record every <component>; supertype = nearest component ancestor.
function walk(nodes: XNode[], ancestor: string | null, out: Component[]): void {
  for (const n of nodes) {
    const tag = tagOf(n);
    if (tag === "component") {
      const type = attr(n, "type") ?? "";
      const include = attr(n, "include");
      const children = kids(n);
      out.push({ type, supertype: ancestor, include, docks: extractDocks(children) });
      if (!include) walk(children, type, out); // nested components inherit this as supertype
    } else if (tag && tag !== "#comment" && tag !== "#text" && tag !== "dock") {
      walk(kids(n), ancestor, out); // pass through wrapper elements, keep ancestor
    }
  }
}

function importComponents(): Component[] {
  const out: Component[] = [];
  walk(parseXmlFile(FILES.componentsystem), null, out);
  return out;
}

// docksystem nests dock TYPES inside group docks (e.g. dt_hallerE) -> collect recursively.
function collectDockTypes(nodes: XNode[], out: DockType[]): void {
  for (const n of nodes) {
    if (tagOf(n) === "dock") {
      const cc = kids(n);
      out.push({
        type: attr(n, "type") ?? "",
        partnerTypes: cc
          .filter((c) => tagOf(c) === "partnerdock" || tagOf(c) === "externalpartnerdock")
          .map((c) => attr(c, "type") ?? "")
          .filter(Boolean),
        dof: parseDof(n),
        snappable: attr(n, "snappable") === "true" || undefined,
      });
      collectDockTypes(cc, out); // nested dock types
    } else {
      collectDockTypes(kids(n), out);
    }
  }
}

function importDockTypes(): DockType[] {
  const out: DockType[] = [];
  collectDockTypes(parseXmlFile(FILES.docksystem), out);
  return out;
}

export function importComponentsAndDocks(): { components: Component[]; dockTypes: DockType[] } {
  const components = importComponents();
  const dockTypes = importDockTypes();
  // merge partner types + dof from dock TYPE onto each component dock instance
  const byType = new Map(dockTypes.map((d) => [d.type, d]));
  for (const comp of components) {
    for (const dk of comp.docks) {
      const t = byType.get(dk.type);
      if (t) {
        dk.partnerTypes = t.partnerTypes;
        if (!dk.dof && t.dof) dk.dof = t.dof;
      }
    }
  }
  return { components, dockTypes };
}
