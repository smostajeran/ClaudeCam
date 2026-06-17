// Importers for properties, clauses, assembly/article rules, volumes, geometryrepresentation.
import { parseXmlFile, tagOf, attr, kids, numOrRaw } from "../xml/parse.ts";
import type { XNode } from "../xml/parse.ts";
import type { Property, Clause, AssemblyRule, Morphology, Volume, GeomRep, RawNode, Vec3 } from "../model.ts";
import { FILES } from "./paths.ts";

function attrs(n: XNode): Record<string, string> {
  const a = n[":@"] as Record<string, string> | undefined;
  const o: Record<string, string> = {};
  if (a) for (const k of Object.keys(a)) o[k.replace(/^@_/, "")] = a[k];
  return o;
}
function serialize(n: XNode): RawNode {
  return { tag: tagOf(n), attrs: attrs(n), children: kids(n).filter((c) => tagOf(c)).map(serialize) };
}
function textOf(n: XNode): string {
  for (const c of kids(n)) if (c["#text"] != null) return String(c["#text"]);
  return "";
}
function vec(n: XNode | undefined): Vec3 | undefined {
  if (!n) return undefined;
  return { x: numOrRaw(attr(n, "x")), y: numOrRaw(attr(n, "y")), z: numOrRaw(attr(n, "z")) };
}

// ---- properties.xml ----
export function importProperties(): Property[] {
  const out: Property[] = [];
  const assigned: Array<[string, string]> = []; // [propertyType, partType]
  function walk(nodes: XNode[]): void {
    for (const n of nodes) {
      const t = tagOf(n);
      if (t === "property") {
        const cc = kids(n);
        const feat = cc.find((c) => tagOf(c) === "feature");
        const dom = cc.find((c) => tagOf(c) === "domain");
        out.push({
          type: attr(n, "type") ?? "",
          feature: feat ? attr(feat, "type") ?? "" : "",
          defaultExpr: feat ? numOrRaw(attr(feat, "defaultvalue")) : "",
          evalOnAccess: feat ? attr(feat, "eval_on_access") === "true" : false,
          overwritable: feat ? attr(feat, "overwritable") === "true" : false,
          domain: dom
            ? {
                kind: attr(dom, "type") ?? "discrete",
                numeric: attr(dom, "numericvalues") === "true" || undefined,
                values: kids(dom).filter((c) => tagOf(c) === "value").map(textOf),
                from: attr(dom, "from") != null ? numOrRaw(attr(dom, "from")) : undefined,
                to: attr(dom, "to") != null ? numOrRaw(attr(dom, "to")) : undefined,
              }
            : undefined,
          assignedTo: [],
        });
        walk(cc); // nested properties
      } else if (t === "aggregationassignment") {
        const part = attr(n, "type") ?? "";
        for (const up of kids(n)) if (tagOf(up) === "useproperty") assigned.push([attr(up, "type") ?? "", part]);
        walk(kids(n));
      } else {
        walk(kids(n));
      }
    }
  }
  walk(parseXmlFile(FILES.properties));
  // invert aggregationassignment -> assignedTo (by feature OR property type)
  const byKey = new Map<string, Property[]>();
  for (const p of out) {
    (byKey.get(p.type) ?? byKey.set(p.type, []).get(p.type)!).push(p);
    (byKey.get(p.feature) ?? byKey.set(p.feature, []).get(p.feature)!).push(p);
  }
  for (const [propKey, part] of assigned) for (const p of byKey.get(propKey) ?? []) p.assignedTo.push(part);
  return out;
}

// ---- clauses.xml ----
export function importClauses(): Clause[] {
  const out: Clause[] = [];
  function walk(nodes: XNode[]): void {
    for (const n of nodes) {
      if (tagOf(n) === "clause") {
        const cond = kids(n).find((c) => tagOf(c) === "condition");
        out.push({ type: attr(n, "type") ?? "", condition: cond ? serialize(cond) : undefined });
      }
      walk(kids(n)); // recurse to capture nested clauses (composite defs + refs)
    }
  }
  walk(parseXmlFile(FILES.clauses));
  return out;
}

// ---- assemblyrules.xml / articlerules.xml ----
function parseRules(file: string): AssemblyRule[] {
  const out: AssemblyRule[] = [];
  function walk(nodes: XNode[]): void {
    for (const n of nodes) {
      if (tagOf(n) === "assemblyrule") {
        const cc = kids(n);
        const coordsNode = cc.find((c) => tagOf(c) === "coordinates");
        let coords: AssemblyRule["coords"];
        if (coordsNode) {
          const cn = kids(coordsNode);
          const pos = cn.find((c) => tagOf(c) === "assemblyposition");
          const rot = cn.find((c) => tagOf(c) === "assemblyrotation");
          const tr = cn.find((c) => tagOf(c) === "translation");
          coords = {
            positionPartId: pos ? attr(kids(pos).find((c) => tagOf(c) === "part") ?? {}, "id") : undefined,
            rotationPartId: rot ? attr(kids(rot).find((c) => tagOf(c) === "part") ?? {}, "id") : undefined,
            translate: vec(tr),
          };
        }
        const morphologies: Morphology[] = cc
          .filter((c) => tagOf(c) === "morphology")
          .map((m) => ({
            targetType: attr(m, "targettype") ?? "",
            activeExpr: attr(m, "active"),
            partContext: kids(m)
              .filter((c) => tagOf(c) === "partcontext")
              .map((c) => ({ id: attr(c, "id") ?? "", type: attr(c, "type") ?? "" })),
          }));
        const cond = cc.find((c) => tagOf(c) === "condition");
        out.push({
          type: attr(n, "type") ?? "",
          targetType: attr(n, "targettype"),
          blockId: attr(n, "blockid"),
          priority: attr(n, "priority"),
          coords,
          morphologies,
          condition: cond ? serialize(cond) : undefined,
        });
      }
      walk(kids(n)); // recurse to capture nested assemblyrules
    }
  }
  walk(parseXmlFile(file));
  return out;
}
export const importAssemblyRules = () => parseRules(FILES.assemblyrules);
export const importArticleRules = () => parseRules(FILES.articlerules);

// ---- volumes.xml ----
export function importVolumes(): Volume[] {
  const out: Volume[] = [];
  function walk(nodes: XNode[]): void {
    for (const n of nodes) {
      if (tagOf(n) === "volumedescription") {
        const cc = kids(n);
        out.push({
          type: attr(n, "type") ?? "",
          volumetype: attr(n, "volumetype") ?? "",
          corner: cc.filter((c) => tagOf(c) === "corner").map((c) => attr(c, "type") ?? attr(c, "name") ?? "")[0],
          occupancy: cc
            .filter((c) => tagOf(c) === "part")
            .map((c) => ({
              type: attr(c, "type") ?? "",
              min: Number(attr(c, "mincount") ?? 0),
              appendage: attr(c, "appendage") === "true" || undefined,
            })),
        });
      } else walk(kids(n));
    }
  }
  walk(parseXmlFile(FILES.volumes));
  return out;
}

// ---- geometryrepresentation.xml ----
export function importGeomReps(): GeomRep[] {
  const out: GeomRep[] = [];
  function walk(nodes: XNode[]): void {
    for (const n of nodes) {
      if (tagOf(n) === "component") {
        const cc = kids(n);
        const geos = cc.filter((c) => tagOf(c) === "geometry");
        if (geos.length) {
          const flat = geos.flatMap((g) => kids(g));
          const rot = flat.find((c) => tagOf(c) === "rotation");
          const sca = flat.find((c) => tagOf(c) === "scale");
          const xf = flat.find((c) => tagOf(c) === "transformation");
          const upd = flat.find((c) => tagOf(c) === "update");
          out.push({
            component: attr(n, "type") ?? "",
            geometryRefs: geos.map((g) => attr(g, "file") ?? "").filter(Boolean),
            material: attr(geos[0], "material"),
            rotation: vec(rot),
            scale: vec(sca),
            transformationExpr: xf ? attr(xf, "expression") : undefined,
            updateTrigger: upd
              ? Object.keys(attrs(upd)).find((k) => k.startsWith("on_"))
              : undefined,
          });
        }
        walk(cc);
      } else walk(kids(n));
    }
  }
  walk(parseXmlFile(FILES.geometryrepresentation));
  return out;
}
