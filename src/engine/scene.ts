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
  };
}
