// Compact VCML expression interpreter (skeleton).
// Supports: numbers, 'single-quoted' strings, locals (my x = ...;), return, function calls
// (Name(..) and call Name(..)), member access expr['k']/expr[i], operators
// (++ + - * /, eq ne lt gt le ge, and or not, ternary ?:), true/false/null, parentheses.
// Part-dependent builtins (Feature/Dock/...) are registered but FAIL LOUD until the
// PartGraph/solver is wired -> coverage gaps are visible, never silent.
import type { Host, Value } from "../engine/partgraph.ts";

// ---------- lexer ----------
type Tok = { k: string; v: string };
const KW = new Set(["my", "call", "return", "eq", "ne", "lt", "gt", "le", "ge", "and", "or", "not", "true", "false", "null"]);
function lex(src: string): Tok[] {
  const t: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "'") { let j = i + 1, s = ""; while (j < n && src[j] !== "'") s += src[j++]; t.push({ k: "str", v: s }); i = j + 1; continue; }
    if (c >= "0" && c <= "9" || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      let j = i; while (j < n && /[0-9.eE+\-]/.test(src[j]) && !(src[j] === "+" || src[j] === "-") || (j > i && (src[j] === "e" || src[j] === "E"))) j++;
      // simpler: consume a numeric token
      let m = src.slice(i).match(/^[0-9]*\.?[0-9]+(?:[eE][+\-]?[0-9]+)?/);
      const num = m ? m[0] : src[i];
      t.push({ k: "num", v: num }); i += num.length; continue;
    }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++; const w = src.slice(i, j); t.push({ k: KW.has(w) ? w : "ident", v: w }); i = j; continue; }
    if (c === "+" && src[i + 1] === "+") { t.push({ k: "op", v: "++" }); i += 2; continue; }
    if (c === "=") { t.push({ k: "op", v: "=" }); i++; continue; }
    if ("+-*/()[],;?:".includes(c)) { t.push({ k: c === "(" || c === ")" || c === "[" || c === "]" || c === "," || c === ";" || c === "?" || c === ":" ? c : "op", v: c }); i++; continue; }
    throw new Error(`VCML lex: unexpected '${c}' at ${i}`);
  }
  t.push({ k: "eof", v: "" });
  return t;
}

// ---------- parser (AST as nested arrays/objects) ----------
type Node = any;
class Parser {
  t: Tok[]; p = 0;
  constructor(t: Tok[]) { this.t = t; }
  peek() { return this.t[this.p]; }
  next() { return this.t[this.p++]; }
  eat(k: string) { const x = this.next(); if (x.k !== k && x.v !== k) throw new Error(`VCML parse: expected ${k}, got ${x.k} '${x.v}'`); return x; }
  is(v: string) { return this.peek().k === v || this.peek().v === v; }

  program(): Node { const stmts: Node[] = []; while (!this.is("eof")) { stmts.push(this.statement()); if (this.is(";")) this.next(); } return { t: "block", stmts }; }
  statement(): Node {
    if (this.is("my")) { this.next(); const name = this.eat("ident").v; this.eat("="); return { t: "let", name, e: this.expr() }; }
    if (this.is("return")) { this.next(); return { t: "ret", e: this.expr() }; }
    return { t: "expr", e: this.expr() };
  }
  expr(): Node { return this.ternary(); }
  ternary(): Node { let c = this.or(); if (this.is("?")) { this.next(); const a = this.expr(); this.eat(":"); const b = this.expr(); return { t: "tern", c, a, b }; } return c; }
  or(): Node { let l = this.and(); while (this.is("or")) { this.next(); l = { t: "bin", op: "or", l, r: this.and() }; } return l; }
  and(): Node { let l = this.cmp(); while (this.is("and")) { this.next(); l = { t: "bin", op: "and", l, r: this.cmp() }; } return l; }
  cmp(): Node { let l = this.add(); const ops = ["eq", "ne", "lt", "gt", "le", "ge"]; if (ops.includes(this.peek().k)) { const op = this.next().k; return { t: "bin", op, l, r: this.add() }; } return l; }
  add(): Node { let l = this.mul(); while (this.is("+") || this.is("-") || this.is("++")) { const op = this.next().v; l = { t: "bin", op, l, r: this.mul() }; } return l; }
  mul(): Node { let l = this.unary(); while (this.is("*") || this.is("/")) { const op = this.next().v; l = { t: "bin", op, l, r: this.unary() }; } return l; }
  unary(): Node { if (this.is("not")) { this.next(); return { t: "not", e: this.unary() }; } if (this.is("-")) { this.next(); return { t: "neg", e: this.unary() }; } return this.postfix(); }
  postfix(): Node { let e = this.primary(); while (this.is("[")) { this.next(); const k = this.expr(); this.eat("]"); e = { t: "index", e, k }; } return e; }
  primary(): Node {
    const x = this.peek();
    if (x.k === "num") { this.next(); return { t: "num", v: Number(x.v) }; }
    if (x.k === "str") { this.next(); return { t: "str", v: x.v }; }
    if (x.k === "true") { this.next(); return { t: "lit", v: true }; }
    if (x.k === "false") { this.next(); return { t: "lit", v: false }; }
    if (x.k === "null") { this.next(); return { t: "lit", v: null }; }
    if (x.k === "(") { this.next(); const e = this.expr(); this.eat(")"); return e; }
    if (x.k === "call") { this.next(); const name = this.eat("ident").v; return this.callTail(name); }
    if (x.k === "ident") { this.next(); if (this.is("(")) return this.callTail(x.v); return { t: "var", name: x.v }; }
    throw new Error(`VCML parse: unexpected ${x.k} '${x.v}'`);
  }
  callTail(name: string): Node { this.eat("("); const args: Node[] = []; if (!this.is(")")) { args.push(this.expr()); while (this.is(",")) { this.next(); args.push(this.expr()); } } this.eat(")"); return { t: "call", name, args }; }
}

// ---------- builtins ----------
export type Builtin = (args: Value[], host: Host) => Value;
export const BUILTINS: Record<string, Builtin> = {
  List: (a) => a.slice(),
  ListAdd: (a) => { (a[0] as Value[]).push(a[1]); return a[0]; },
  ListExtend: (a) => (a[0] as Value[]).concat(a[1]),
  Size: (a) => (Array.isArray(a[0]) ? a[0].length : String(a[0]).length),
  InList: (a) => Array.isArray(a[1]) && a[1].includes(a[0]),
  Bool: (a) => a[0] === true || a[0] === "true" || a[0] === 1,
  Round: (a) => Math.round(Number(a[0])),
  StrLen: (a) => String(a[0]).length,
  SubStr: (a) => String(a[0]).substr(Number(a[1]), a[2] != null ? Number(a[2]) : undefined),
  BeginsWith: (a) => String(a[0]).startsWith(String(a[1])),
  EndsWith: (a) => String(a[0]).endsWith(String(a[1])),
  StringContains: (a) => String(a[0]).includes(String(a[1])),
  StrReplace: (a) => String(a[0]).split(String(a[1])).join(String(a[2])),
  StringToList: (a) => String(a[0]).split(String(a[1] ?? "")),
  Vector: (a) => ({ x: Number(a[0]) || 0, y: Number(a[1]) || 0, z: Number(a[2]) || 0 }),
  EnvValue: (a, h) => (h.env.has(String(a[0])) ? h.env.get(String(a[0])) : a[1] ?? null),
  Scenario: (_a, h) => h.env.get("scenario") ?? "co",
  IsSubTypeOf: (a, h) => h.isSubTypeOf(String(a[0]), String(a[1])),
};
// part-dependent builtins: registered, fail loud until PartGraph/solver wired.
for (const name of ["Feature", "PartAttr", "GetTypeName", "Dock", "DockGetConnectedPart", "DockGetConnectedDock",
  "ConnectedDocksOfType", "GetDOFValue", "GetComponentListOfType", "FindPart", "Parent", "ParentOfType",
  "PartPos", "PartRot", "RelativePartPos"]) {
  BUILTINS[name] = () => { throw new Error(`VCML builtin '${name}' requires a live PartGraph (not wired yet)`); };
}

// ---------- evaluator ----------
function truthy(v: Value): boolean { return !(v === false || v == null || v === 0 || v === "" || v === "false"); }
function evalNode(node: Node, env: Map<string, Value>, host: Host): Value {
  switch (node.t) {
    case "block": { let last: Value = null; for (const s of node.stmts) { const v = evalNode(s, env, host); if (s.t === "ret") return v; last = v; } return last; }
    case "let": { const v = evalNode(node.e, env, host); env.set(node.name, v); return v; }
    case "ret": case "expr": return evalNode(node.e, env, host);
    case "num": case "str": case "lit": return node.v;
    case "var": return env.has(node.name) ? env.get(node.name) : null;
    case "neg": return -Number(evalNode(node.e, env, host));
    case "not": return !truthy(evalNode(node.e, env, host));
    case "tern": return truthy(evalNode(node.c, env, host)) ? evalNode(node.a, env, host) : evalNode(node.b, env, host);
    case "index": { const o = evalNode(node.e, env, host); const k = evalNode(node.k, env, host); return o == null ? null : (o as any)[k as any]; }
    case "call": { const fn = BUILTINS[node.name]; if (!fn) throw new Error(`VCML: unknown function '${node.name}' (named-op not loaded)`); return fn(node.args.map((x: Node) => evalNode(x, env, host)), host); }
    case "bin": {
      const op = node.op;
      if (op === "and") return truthy(evalNode(node.l, env, host)) && truthy(evalNode(node.r, env, host));
      if (op === "or") return truthy(evalNode(node.l, env, host)) || truthy(evalNode(node.r, env, host));
      const l = evalNode(node.l, env, host), r = evalNode(node.r, env, host);
      switch (op) {
        case "++": return String(l) + String(r);
        case "+": return Number(l) + Number(r);
        case "-": return Number(l) - Number(r);
        case "*": return Number(l) * Number(r);
        case "/": return Number(l) / Number(r);
        case "eq": return l === r || String(l) === String(r);
        case "ne": return !(l === r || String(l) === String(r));
        case "lt": return Number(l) < Number(r);
        case "gt": return Number(l) > Number(r);
        case "le": return Number(l) <= Number(r);
        case "ge": return Number(l) >= Number(r);
      }
    }
  }
  throw new Error(`VCML eval: unhandled node ${node.t}`);
}

export function evalVCML(src: string, host: Host, locals: Record<string, Value> = {}): Value {
  const ast = new Parser(lex(src)).program();
  return evalNode(ast, new Map(Object.entries(locals)), host);
}
