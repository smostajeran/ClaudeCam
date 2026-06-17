// Load named operations from appcode <code> blocks: `def name(params) { body }`.
// These ARE VCML (my/if/return/{}) so the same interpreter runs them.
import { readFileSync, readdirSync } from "node:fs";

export interface NamedOp { name: string; params: string[]; body: string; ast?: any }

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function extractDefs(text: string, into: Map<string, NamedOp>): void {
  const t = decodeEntities(text);
  // 1) discover ALL def headers first (so a bad body can't skip later defs)
  const re = /\bdef\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
  const heads: { name: string; params: string[]; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) heads.push({ name: m[1], params: m[2].split(",").map((s) => s.trim()).filter(Boolean), start: re.lastIndex });
  // 2) brace-match each body independently, skipping braces inside ' ` " strings
  for (const h of heads) {
    let i = h.start, depth = 1, body = "", q = "";
    while (i < t.length && depth > 0) {
      const c = t[i];
      if (q) { if (c === q) q = ""; body += c; i++; continue; }
      if (c === "'" || c === "`" || c === '"') { q = c; body += c; i++; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
      body += c; i++;
    }
    into.set(h.name, { name: h.name, params: h.params, body });
  }
}

export function loadAppcodes(dir: string): Map<string, NamedOp> {
  const ops = new Map<string, NamedOp>();
  for (const f of readdirSync(dir)) if (f.endsWith(".xml")) {
    try { extractDefs(readFileSync(`${dir}/${f}`, "utf8"), ops); } catch { /* skip */ }
  }
  return ops;
}
