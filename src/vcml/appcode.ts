// Load named operations from appcode <code> blocks: `def name(params) { body }`.
// These ARE VCML (my/if/return/{}) so the same interpreter runs them.
import { readFileSync, readdirSync } from "node:fs";

export interface NamedOp { name: string; params: string[]; body: string; ast?: any }

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function extractDefs(text: string, into: Map<string, NamedOp>): void {
  const t = decodeEntities(text);
  const re = /\bdef\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const name = m[1];
    const params = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    // brace-match the body, skipping braces inside ' or ` strings
    let i = re.lastIndex, depth = 1, body = "", q = "";
    while (i < t.length && depth > 0) {
      const c = t[i];
      if (q) { if (c === q) q = ""; body += c; i++; continue; }
      if (c === "'" || c === "`") { q = c; body += c; i++; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
      body += c;
      i++;
    }
    into.set(name, { name, params, body });
    re.lastIndex = i;
  }
}

export function loadAppcodes(dir: string): Map<string, NamedOp> {
  const ops = new Map<string, NamedOp>();
  for (const f of readdirSync(dir)) if (f.endsWith(".xml")) {
    try { extractDefs(readFileSync(`${dir}/${f}`, "utf8"), ops); } catch { /* skip */ }
  }
  return ops;
}
