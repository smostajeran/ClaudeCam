// Load a decoded prototype (.par/.snx -> .xml) into a live scene + wire part-dependent builtins.
import { readFileSync } from "node:fs";
import { parseXmlString, tagOf, attr, kids } from "../xml/parse.ts";
import type { XNode } from "../xml/parse.ts";
import { Host } from "./partgraph.ts";

export interface ScenePart {
  id: string;
  type: string;
  features: Map<string, any>;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number };
  docks: { type: string; index: number; connectedPart: ScenePart | null }[];
}

function attrsOf(n: XNode | undefined): Record<string, string> {
  const a = n ? (n[":@"] as Record<string, string> | undefined) : undefined;
  const o: Record<string, string> = {};
  if (a) for (const k of Object.keys(a)) o[k.replace(/^@_/, "")] = a[k];
  return o;
}
const vec = (n: XNode | undefined) => ({ x: Number(attr(n ?? {}, "x") ?? 0), y: Number(attr(n ?? {}, "y") ?? 0), z: Number(attr(n ?? {}, "z") ?? 0) });

export function loadScene(file: string): ScenePart[] {
  const parts: ScenePart[] = [];
  const raw: { part: ScenePart; conns: { type: string; index: number; dockid: string; connId: string }[] }[] = [];
  const ownerByDockId = new Map<string, ScenePart>();

  function walk(nodes: XNode[]): void {
    for (const n of nodes) {
      if (tagOf(n) === "componentset") {
        const cc = kids(n);
        const feats = attrsOf(cc.find((c) => tagOf(c) === "features"));
        const part: ScenePart = {
          id: attr(n, "_PXI_unique_comp_id") ?? String(parts.length),
          type: attr(n, "type") ?? "",
          features: new Map(Object.entries(feats)),
          pos: vec(cc.find((c) => tagOf(c) === "pos")),
          rot: vec(cc.find((c) => tagOf(c) === "rot")),
          docks: [],
        };
        const conns = cc
          .filter((c) => tagOf(c) === "connecteddock")
          .map((c) => ({ type: attr(c, "type") ?? "", index: Number(attr(c, "index") ?? 0), dockid: attr(c, "dockid") ?? "", connId: attr(c, "connecteddockid") ?? "" }));
        for (const cn of conns) if (cn.dockid) ownerByDockId.set(cn.dockid, part);
        parts.push(part);
        raw.push({ part, conns });
      } else walk(kids(n));
    }
  }
  // fast-xml-parser rejects the reserved tag name <prototype>; rename it (we walk for componentset).
  const xml = readFileSync(file, "utf8").replace(/(<\/?)prototype\b/g, "$1protoroot");
  walk(parseXmlString(xml));

  for (const { part, conns } of raw)
    for (const cn of conns)
      part.docks.push({ type: cn.type, index: cn.index, connectedPart: ownerByDockId.get(cn.connId) ?? null });
  return parts;
}

// Install the part-dependent builtins (the 45%-of-calls lever) against a loaded scene.
export function installPartFns(host: Host, scene: ScenePart[]): void {
  const isSub = (t: string, of: string) => t === of || host.isSubTypeOf(t, of);
  const ofType = (t: string) => scene.filter((p) => isSub(p.type, t));
  const featOf = (a: any[]) => (a.length > 1 ? [a[0], a[1]] : [host.current, a[0]]) as [ScenePart, string];

  // connected components over dock links -> connection ids; each cluster is a "volume".
  const idOf = new Map<ScenePart, number>();
  let cid = 0;
  for (const p of scene) {
    if (idOf.has(p)) continue;
    const stack: ScenePart[] = [p];
    idOf.set(p, cid);
    while (stack.length) { const x = stack.pop() as ScenePart; for (const d of x.docks) { const c = d.connectedPart; if (c && !idOf.has(c)) { idOf.set(c, cid); stack.push(c); } } }
    cid++;
  }
  const volumes = new Map<number, any>();
  for (const p of scene) { const c = idOf.get(p) as number; if (!volumes.has(c)) volumes.set(c, { id: "vol" + c, type: "normal_volume", parts: [] }); volumes.get(c).parts.push(p); }
  const volOf = (p: ScenePart) => (p ? volumes.get(idOf.get(p) as number) : null);

  (host as any).partFns = {
    GetTypeName: (a: any[]) => a[0]?.type ?? null,
    Feature: (a: any[]) => { const [p, k] = featOf(a); return p?.features?.get(k) ?? null; },
    PartAttr: (a: any[]) => { const [p, k] = featOf(a); return p?.features?.get(k) ?? null; },
    Dock: (a: any[]) => { const ds = (a[0]?.docks ?? []).filter((d: any) => d.type === a[1]); return a[2] ? ds[Number(a[2]) - 1] ?? null : ds[0] ?? null; },
    DockGetConnectedPart: (a: any[]) => a[0]?.connectedPart ?? null,
    ConnectedDocksOfType: (a: any[]) => (a[0]?.docks ?? []).filter((d: any) => d.type === a[1]),
    PartPos: (a: any[]) => a[0]?.pos ?? null,
    PartRot: (a: any[]) => a[0]?.rot ?? null,
    Parent: () => null,
    ParentOfType: () => null,
    GetComponentListOfType: (a: any[]) => ofType(String(a[0])),
    FindPart: (a: any[]) => (a[0]?.docks ?? []).map((d: any) => d.connectedPart).find((c: ScenePart) => c && isSub(c.type, String(a[1]))) ?? null,
    // volume / connection graph
    GetRefVolumes: (a: any[]) => { const v = volOf(a[0]); return v ? [v] : []; },
    GetVolumeRefParts: (a: any[]) => a[0]?.parts ?? [],
    ConnectionId: (a: any[]) => (a[0] ? idOf.get(a[0]) ?? -1 : -1),
    GetComponentListOfConnectionId: (a: any[]) => scene.filter((p) => idOf.get(p) === Number(a[0])),
    Height: (a: any[]) => (a[0]?.pos ? a[0].pos.z : 0),
    PropertyActive: () => true, // TODO: real property active-condition resolution
    NamedNode: () => null,      // TODO: project-root named nodes (n/a for a single prototype)
    RelativePartPos: (a: any[]) => { const p = a[0]?.pos, q = a[1]?.pos; return p && q ? { x: p.x - q.x, y: p.y - q.y, z: p.z - q.z } : { x: 0, y: 0, z: 0 }; },
    ConnectedDockCount: (a: any[]) => (a[0]?.docks ?? []).filter((d: any) => d.connectedPart).length,
    ChildOfTypeDeep: (a: any[]) => { const v = volOf(a[0]); return v ? v.parts.find((p: ScenePart) => isSub(p.type, String(a[1]))) ?? null : null; },
    ChildCountDeep: (a: any[]) => { const v = volOf(a[0]); return v ? v.parts.filter((p: ScenePart) => isSub(p.type, String(a[1]))).length : 0; },
    RegisteredPart: () => null,                                   // TODO: part registry
    PartBoundingBox: () => ({ extent: { x: 0, y: 0, z: 0 }, min: { x: 0, y: 0, z: 0 } }), // TODO: from mesh geometry
    USMPartPrintZone: () => null,
    GlobalDockPos: (a: any[]) => a[0]?.pos ?? { x: 0, y: 0, z: 0 },
  };
}
