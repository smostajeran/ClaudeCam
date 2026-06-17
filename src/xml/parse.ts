// Thin wrapper over fast-xml-parser in preserveOrder mode (keeps nesting + attribute fidelity).
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

export type XNode = Record<string, any>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  commentPropName: "#comment",
});

export function parseXmlFile(path: string): XNode[] {
  return parser.parse(readFileSync(path, "utf8")) as XNode[];
}

export function tagOf(n: XNode): string {
  for (const k of Object.keys(n)) {
    if (k !== ":@" && k !== "#text" && k !== "#comment") return k;
  }
  return "";
}
export function attr(n: XNode, name: string): string | undefined {
  const a = n[":@"] as Record<string, string> | undefined;
  return a ? a["@_" + name] : undefined;
}
export function kids(n: XNode): XNode[] {
  const t = tagOf(n);
  const v = n[t];
  return Array.isArray(v) ? (v as XNode[]) : [];
}
export function byTag(nodes: XNode[], tag: string): XNode[] {
  return nodes.filter((n) => tagOf(n) === tag);
}
// number when the attribute is a literal, otherwise the verbatim string (VCML expression).
export function numOrRaw(s: string | undefined): number | string {
  if (s == null || s === "") return 0;
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}
