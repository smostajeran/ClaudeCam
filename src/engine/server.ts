// Rule-editor backend: a tiny zero-dependency HTTP server (node:http) that exposes the imported
// model and the engine's validators to the browser UI in ui/index.html.
//
//   GET  /                  -> the single-file UI
//   GET  /api/model         -> out/model.json with the edit-overlay applied
//   GET  /api/overrides     -> the current overlay (out/overrides.json)
//   POST /api/override      -> {kind:'property'|'clause', key, patch} merged into the overlay
//   POST /api/reset         -> clear the overlay
//   POST /api/run           -> {script:'validate'|'conflicts'} runs the engine validator, returns stdout
//   POST /api/configure     -> customer payload: placement+conflicts+BOM, IP-safe (one52 ids/EN/RealityKit)
//   POST /api/build         -> Path P (widths/heights/depth/cells) -> derived frame geometry+BOM+validation
//
// The overlay is non-destructive: the decoded source model is never mutated. Run: node src/engine/server.ts
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { placementToRK, identity } from "./export_ios.ts";
import { customerPayload } from "./customer_api.ts";
import { addTubeOnEdge, addPanelOnFace, addGlassOnFace, panelFitResidual, removePart, parseConfig } from "./place.ts";
import { buildFrame, gridOptions } from "./build_frame.ts";
import { extractConfigPx5 } from "./pxpz.ts";
import { bootstrap } from "./bootstrap.ts";
import { lowLODMesh, highLODMesh } from "../geom/oio3d.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // usm-engine/
const MODEL = join(ROOT, "out", "model.json");
const OVERLAY = join(ROOT, "out", "overrides.json");
const UI = join(ROOT, "ui", "index.html");
const DEMO = join(ROOT, "data", "demo_configure.json"); // pre-solved demo scene (public, IP-safe)
const START = join(ROOT, "data", "start_configure.json"); // clean base model to start a configuration
const PORT = Number(process.env.PORT ?? 5152);

type Overlay = { properties: Record<string, any>; clauses: Record<string, any> };
const emptyOverlay = (): Overlay => ({ properties: {}, clauses: {} });
const loadOverlay = (): Overlay => (existsSync(OVERLAY) ? { ...emptyOverlay(), ...JSON.parse(readFileSync(OVERLAY, "utf8")) } : emptyOverlay());
const saveOverlay = (o: Overlay) => writeFileSync(OVERLAY, JSON.stringify(o, null, 2));

function mergedModel() {
  const model = JSON.parse(readFileSync(MODEL, "utf8"));
  const ov = loadOverlay();
  for (const p of model.properties) {
    const patch = ov.properties[p.type];
    if (patch) { Object.assign(p, patch); p._edited = Object.keys(patch); }
  }
  for (const c of model.clauses) {
    const patch = ov.clauses[c.type];
    if (patch) { Object.assign(c, patch); c._edited = Object.keys(patch); }
  }
  model._overlay = { properties: Object.keys(ov.properties).length, clauses: Object.keys(ov.clauses).length };
  return model;
}

// ---- real part geometry (INTERNAL ONLY — proprietary USM meshes; not for the shipped app) ----
// resolves a part name to its .obj (mm) or .3d (cm→mm) mesh under the decoded packages and returns
// the parsed geometry + real bounding-box dimensions. Used by the configurator prototype to load
// the actual mesh + properties for a placed part / catalog item.
// proprietary mesh geometry (external to the repo) — override the base dir with USM_GEO_ROOT so no
// symlink is needed; defaults to a sibling `virtual.USM-4/`.
const GEO_BASE = process.env.USM_GEO_ROOT ?? join(ROOT, "..", "virtual.USM-4");
const GEO_DIRS = ["hallerpackage", "addonspackage", "primopackage", "hallertischpackage", "kitospackage", "displaypackage"]
  .map((p) => join(GEO_BASE, "co", "packages", p, "representation", "geometry"));
// component type -> geometry file basename (from geometryrepresentation.xml) — resolves solver part types to meshes
let GEOMMAP: Record<string, string> | null = null;
function geomMap() {
  if (GEOMMAP) return GEOMMAP;
  const out: Record<string, string> = {};
  const xml = readCached(join(CART_ROOT, "hallerpackage", "representation", "geometryrepresentation.xml"));
  // NB: `type` is not always the first attribute — many parts are `<component preload="true" type="…">`
  // (scherengelenk hinges, biblio*, klemmzunge_*, …). Match `type=` anywhere, skip optional <localvar>s,
  // then take the component's first geometry file. Missing this dropped ~49/350 parts from the viewer.
  if (xml) { const re = /<component\b[^>]*\btype="([^"]+)"[^>]*>\s*(?:<localvar\b[^>]*>\s*)*<geometry\b[^>]*\bfile="geometry\/([^"]+)\.3d"/g; let m: RegExpExecArray | null; while ((m = re.exec(xml))) out[m[1]] = m[2]; }
  GEOMMAP = out; return out;
}
// candidate filenames for a solver part TYPE (direct, geometryrep mapping, and the known naming heuristics)
function meshCandidates(name: string): string[] {
  const c = [name]; const g = geomMap()[name]; if (g) c.push(g);
  if (/^co_/.test(name)) { const b = name.replace(/^co_/, ""); c.push(b); const gb = geomMap()[b]; if (gb) c.push(gb); }   // co_trafo_E -> trafo_E
  if (/^kugel/i.test(name)) c.push("Kugel", "kugel", "kugel_2");
  if (/fuss/i.test(name)) c.push("fuss", "nivellierfuss");                                   // hallerfuss -> fuss
  if (/klemmhalter/i.test(name)) c.push("klemmhalter");                                       // stdklemmhalter -> klemmhalter
  const gm = name.match(/^glas(\d+)_(\d+)/i); if (gm) c.push(`glas${gm[1]}x${gm[2]}`);
  const gt = name.match(/^glastuer_(?:links|rechts)(\d+)_(\d+)/i); if (gt) c.push(`glas${gt[1]}x${gt[2]}`);  // glass door leaf -> glass slab
  const am = name.match(/^(perfblech|biblioblech|ausziehtablar|schraegtablar|klapptuer|einschubtuer|kurzblech|lochblech)(\d+)_(\d+)/i); if (am) c.push(`${am[1]}${am[2]}x${am[3]}`);
  // A panel sheet exists on disk in only ONE dimension order/separator (perfblech350x750.3d, blech350_750.3d,
  // lochblech750_350.3d, …), but the placed type may be the other order. Try all four label forms so any
  // non-square sheet resolves regardless of how the solver named it.
  const sm = name.match(/^(blech|perfblech|lochblech|kurzblech|biblioblech)(\d+)[_x](\d+)$/i);
  if (sm) { const [, st, a, b] = sm; c.push(`${st}${a}_${b}`, `${st}${b}_${a}`, `${st}${a}x${b}`, `${st}${b}x${a}`); }
  if (/^tuerelement/i.test(name)) { const t = name.match(/(\d+)_(\d+)/); if (t) c.push(`klapptuer${t[1]}x${t[2]}`); }
  // VCML-computed geometry names (geometryrepresentation StrReplace maps; literal geomMap can't see them)
  if (/^einschubtuer\d/.test(name)) c.push("einschubtuer");   // slide-in door, single-size variant -> einschubtuer.3d
  if (/tablarseitenwinkel/.test(name)) c.push(name.replace("tablarseitenwinkel", "tablarwinkel")); // -> tablarwinkel500_l.3d
  if (/normaltrapezvorderwand/.test(name)) c.push(name.replace("normaltrapezvorderwand", "blech"));
  if (/einsatz/.test(name)) c.push(name.replace("einsatz", "buntglas"), name.replace("einsatz", "kelco"));
  return c;
}
function findOneFile(safe: string): string | null {
  for (const ext of [".obj", ".3d"]) for (const d of GEO_DIRS) { const f = join(d, safe + ext); if (existsSync(f)) return f; }
  for (const d of GEO_DIRS) { if (!existsSync(d)) continue;
    const files = readdirSync(d);
    for (const ext of [".obj", ".3d"]) for (const fn of files) if (fn.toLowerCase() === (safe + ext).toLowerCase()) return join(d, fn);
  }
  for (const d of GEO_DIRS) { if (!existsSync(d)) continue;       // recurse ONE level (e.g. geometry/inosbox/*.3d)
    for (const sub of readdirSync(d, { withFileTypes: true })) { if (!sub.isDirectory()) continue; const sd = join(d, sub.name);
      for (const ext of [".obj", ".3d"]) { const f = join(sd, safe + ext); if (existsSync(f)) return f;
        for (const fn of readdirSync(sd)) if (fn.toLowerCase() === (safe + ext).toLowerCase()) return join(sd, fn); } }
  }
  return null;
}
function findMeshFile(name: string): string | null {
  for (const cand of meshCandidates(name)) { const f = findOneFile(cand.replace(/[^A-Za-z0-9_]/g, "")); if (f) return f; }
  return null;
}
function parseObj(file: string) {
  const txt = readFileSync(file, "utf8"); const positions: number[][] = []; const triangles: number[] = [];
  for (const ln of txt.split(/\r?\n/)) {
    if (ln.startsWith("v ")) { const p = ln.slice(2).trim().split(/\s+/).map(Number); positions.push([p[0], p[1], p[2]]); }
    else if (ln.startsWith("f ")) { const idx = ln.slice(2).trim().split(/\s+/).map((t) => parseInt(t, 10) - 1); for (let i = 1; i < idx.length - 1; i++) triangles.push(idx[0], idx[i], idx[i + 1]); }
  }
  return { positions, triangles };
}
function loadMesh(name: string, lod?: string) {
  const file = findMeshFile(name);
  if (!file) return { name, error: "mesh not found" };
  const isObj = file.toLowerCase().endsWith(".obj");
  const wantCoarse = lod === "low";   // .3d packs several SizeLOD levels; default to the FINEST (correct shape, no overlay). ?lod=low for the light asset.
  const m = isObj ? parseObj(file) : (wantCoarse ? lowLODMesh(file) : highLODMesh(file));   // .obj already mm; .3d in cm
  const s = isObj ? 1 : 10;                                     // cm → mm
  const P = s === 1 ? m.positions : m.positions.map((p) => [p[0] * s, p[1] * s, p[2] * s]);   // NATIVE orientation (the solver's quat assumes native mesh axes)
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of P) for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
  const dimsMM = mx.map((v, i) => +(v - mn[i]).toFixed(1));
  return { name, source: file.split(/[\\/]/).slice(-3).join("/"), unit: "mm", verts: P.length, tris: (m.triangles.length / 3) | 0, dimsMM, positions: P, triangles: m.triangles };
}
// available mesh size-sets per kind (scanned from the hallerpackage geometry dir) for size-correct selection.
// pairs are the two grid-dimension TOKENS as named on disk (axis order is not stable — match by unordered set).
let MESH_INDEX: Record<string, any> | null = null;
function meshIndex() {
  if (MESH_INDEX) return MESH_INDEX;
  const dir = GEO_DIRS[0]; // hallerpackage geometry
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const skip = /_export|_perf|ggw|gww|dummy/i;
  const kinds: Array<{ kind: string; re: RegExp; pair: boolean }> = [
    { kind: "blech", re: /^blech(\d+)_(\d+)\.3d$/i, pair: true },
    { kind: "perfblech", re: /^perfblech(\d+)x(\d+)\.3d$/i, pair: true },     // fine-perforation "mesh" panel
    { kind: "lochblech", re: /^lochblech(\d+)_(\d+)\.3d$/i, pair: true },     // round-hole "perforated" panel
    { kind: "vlies", re: /^vlies(\d+)_(\d+)\.3d$/i, pair: true },             // acoustic felt pad (sizes that can be acoustic)
    { kind: "biblioblech", re: /^biblioblech(\d+)x(\d+)\.3d$/i, pair: true }, // library (Biblio) panel
    { kind: "glas", re: /^glas(\d+)x(\d+)\.3d$/i, pair: true },
    { kind: "tablar", re: /^tablar(\d+)_(\d+)\.3d$/i, pair: true },           // intermediate shelf (Zwischentablar)
    { kind: "ausziehtablar", re: /^ausziehtablar(\d+)x(\d+)\.3d$/i, pair: true }, // pull-out shelf
    { kind: "schraegtablar", re: /^schraegtablar(\d+)x(\d+)\.3d$/i, pair: true }, // sloped shelf
    { kind: "klapptuer", re: /^klapptuer(\d+)x(\d+)\.3d$/i, pair: true },
    { kind: "rohr", re: /^rohr(\d+)\.3d$/i, pair: false },
  ];
  const out: Record<string, any> = {};
  for (const k of kinds) { out[k.kind] = []; for (const f of files) { if (skip.test(f)) continue; const m = f.match(k.re); if (m) out[k.kind].push(k.pair ? [+m[1], +m[2]] : +m[1]); } }
  MESH_INDEX = out; return out;
}

// ---- "allowed parameter" rules per part (INTERNAL) — from volumecontentplausibility.xml + operator.xml ----
// function="size" gives the min/max compartment width·height·depth (mm; "floating"/absent = unbounded);
// need*/noglass* = structural requirements; conflict/usersideconflict = what may not coexist.
let PLAUS: Record<string, any> | null = null;
function plausibility() {
  if (PLAUS) return PLAUS;
  const xml = readCached(join(CART_ROOT, "hallerpackage", "representation", "volumecontentplausibility.xml"));
  const out: Record<string, any> = {};
  if (xml) {
    const num = (v?: string) => (v == null || v === "floating") ? null : Number(v);
    const get = (a: string, k: string) => { const r = new RegExp(k + '="([^"]*)"').exec(a); return r ? r[1] : undefined; };
    const re = /<assembly\s+type="([^"]+)"\s+function="([^"]+)"([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const type = m[1], fn = m[2], rest = m[3];
      const e = (out[type] = out[type] || { type, requires: [], conflicts: [] });
      if (fn === "size") e.size = { minW: num(get(rest, "minwidth")), maxW: num(get(rest, "maxwidth")), minH: num(get(rest, "minheight")), maxH: num(get(rest, "maxheight")), minD: num(get(rest, "mindepth")), maxD: num(get(rest, "maxdepth")) };
      else if (/^(need|noglass)/.test(fn)) e.requires.push(fn);
      else if (/conflict$/.test(fn)) { const p = get(rest, "partnertype"); if (p) e.conflicts.push(p); }
    }
  }
  // vertical mounting-position parameter (source: operator.xml InRange / featurecondition mountingheight) — cm, for a 35-cm bay
  for (const t of ["ausziehtablarset", "ausziehtablarverkehrtset", "ausziehtuertablarset", "azschubladenset"])
    (out[t] = out[t] || { type: t, requires: [], conflicts: [] }).mountingheight = { min: 2, max: 29, unit: "cm", note: "vertical mounting position within a 35-cm bay (varies with bay height)" };
  PLAUS = out; return out;
}

// ---- real snap/dock rules (INTERNAL) — from the decoded VCML docksystem + componentsystem ----
// each component declares <dock type index translation rotation>; each dock type's partner (what it
// snaps INTO) + degrees-of-freedom come from docksystem.xml. This is the authoritative placement rule.
const CART_ROOT = process.env.USM_CART_ROOT ?? join(ROOT, "..", "snx2xml", "co", "packages");   // decoded cartridges (external); override to avoid a symlink
const CART_PKGS = ["hallerpackage", "addonspackage", "primopackage", "hallertischpackage", "kitospackage", "displaypackage", "space_configurator", "shared"];
const FILE_CACHE: Record<string, string | null> = {};
const readCached = (f: string) => (f in FILE_CACHE ? FILE_CACHE[f] : (FILE_CACHE[f] = existsSync(f) ? readFileSync(f, "utf8") : null));
let DOCK_PARTNERS: Record<string, { snapsTo: string; dof: string }> | null = null;
function dockPartners() {                                       // aggregate partner/dof defs across ALL cartridges
  if (DOCK_PARTNERS) return DOCK_PARTNERS;
  const out: Record<string, { snapsTo: string; dof: string }> = {};
  for (const pkg of CART_PKGS) for (const fn of ["docksystem.xml", "docksystem_include.xml"]) {
    const xml = readCached(join(CART_ROOT, pkg, "cartridge", fn)); if (!xml) continue;
    const re = /<dock type="([^"]+)">([\s\S]*?)<\/dock>/g; let m;
    while ((m = re.exec(xml))) {
      if (out[m[1]]) continue; const b = m[2];
      out[m[1]] = {
        snapsTo: (b.match(/<partnerdock type="([^"]+)"/) || [])[1] || (b.match(/<externalpartnerdock type="([^"]+)"/) || [])[1] || "",
        dof: [...b.matchAll(/<dof type="(\w+)" axis="(\w+)"/g)].map((d) => d[1] + ":" + d[2]).join(","),
      };
    }
  }
  DOCK_PARTNERS = out; return out;
}
function loadDocks(part: string) {                             // find the component in ANY cartridge, list its real docks
  const safe = part.replace(/[^A-Za-z0-9_]/g, "");
  let found: { pkg: string; body: string } | null = null, selfClosingPkg: string | null = null;
  for (const pkg of CART_PKGS) {
    const xml = readCached(join(CART_ROOT, pkg, "cartridge", "componentsystem.xml")); if (!xml) continue;
    if (new RegExp(`<component type="${safe}"\\s*/>`).test(xml)) { if (!selfClosingPkg) selfClosingPkg = pkg; continue; }  // self-closing FIRST
    const m = xml.match(new RegExp(`<component type="${safe}"[^>]*>([\\s\\S]*?)</component>`));
    if (m && m[1].includes("<dock")) { found = { pkg, body: m[1] }; break; }
  }
  if (!found) {
    if (selfClosingPkg) return { part, cartridge: selfClosingPkg, dockCount: 0, note: "declared self-closing (base element / alias) — no inline docks; snaps via fuss2kugel → the ball's kugel2bodenelement socket" };
    return { part, error: "component not found in any cartridge" };
  }
  const pm = dockPartners();
  const artnr = (found.body.match(/typeref="art_number" value="([^"]+)"/) || [])[1] || "";
  const docks = [...found.body.matchAll(/<dock type="([^"]+)" index="(\d+)"[^>]*>([\s\S]*?)<\/dock>/g)].map((d) => {
    const tr = d[3].match(/<translation x="([^"]+)" y="([^"]+)" z="([^"]+)"/) || [];
    const ro = d[3].match(/<rotation x="([^"]+)" y="([^"]+)" z="([^"]+)"/) || [];
    const p = pm[d[1]] || { snapsTo: "", dof: "" };
    return { type: d[1], index: +d[2], snapsTo: p.snapsTo, dof: p.dof, translation: tr.slice(1, 4).map(Number), rotation: ro.slice(1, 4).map(Number) };
  });
  return { part, cartridge: found.pkg, artnr, unit: "cm", dockCount: docks.length, docks };
}

function readBody(req: any): Promise<any> {
  return new Promise((res) => { let b = ""; req.on("data", (c: any) => (b += c)); req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });
}
function readRawBody(req: any): Promise<Buffer> {
  return new Promise((res) => { const cs: Buffer[] = []; req.on("data", (c: Buffer) => cs.push(c)); req.on("end", () => res(Buffer.concat(cs))); });
}

// The lock: verify the caller's Supabase JWT against /auth/v1/user. Enforced only when SUPABASE_URL
// is set (production host); unset => local dev, open. Result cached 60s to avoid a round-trip/request.
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY ?? "";
// public Supabase config for the login page (client-safe; defaults to the usm-engine project).
const PUB_URL = process.env.SUPABASE_URL ?? "https://jbmbhhbglcclgnpagwhg.supabase.co";
const PUB_KEY = process.env.SUPABASE_ANON_KEY ?? "sb_publishable_vQmkcd0V_hXs0HQeFT0lFQ_xwdGzG9x";
const authCache = new Map<string, { exp: number; user: any }>();
async function verifyJwt(req: any): Promise<any | null> {
  if (!SUPA_URL) return { dev: true }; // auth not configured -> local dev
  const h = String(req.headers["authorization"] ?? "");
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return null;
  const now = Date.now(), c = authCache.get(tok);
  if (c && c.exp > now) return c.user;
  try {
    const r = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${tok}`, apikey: SUPA_KEY } });
    if (!r.ok) return null;
    const user = await r.json();
    authCache.set(tok, { exp: now + 60000, user });
    return user;
  } catch { return null; }
}

const send = (r: any, code: number, body: string, type = "application/json") =>
  r.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(body);

// ---- interactive editing sessions: a per-session working config.px5 that /api/place mutates + re-solves ----
const SESS_DIR = join(ROOT, "out", "sessions");
const SESSIONS = new Map<string, string>();          // sessionId -> working config path
const SEED_CFG = join(ROOT, "oracle", "test_project", "K4_admi_2026061780565", "5", "config.px5"); // dev seed
let SOLVE_CHAIN: Promise<any> = Promise.resolve();    // global serialize: one solve at a time (shared out/placement.json)
const serialize = <T,>(fn: () => T | Promise<T>): Promise<T> => { const p = SOLVE_CHAIN.then(fn, fn); SOLVE_CHAIN = p.catch(() => {}); return p as Promise<T>; };
const newSessionId = () => "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

// one52 part-id -> internal component type, learned from every solve (so /api/part-mesh can resolve a
// mesh by the IP-safe id without any German type crossing the wire). Populated by joining the internal
// placement (id->type) with the customer payload (id->part).
const PART_TYPE = new Map<string, string>();
function recordPartTypes(placement: any, payload: any) {
  const byId = new Map<string, string>((placement?.parts ?? []).map((p: any) => [String(p.id), p.type]));
  for (const p of payload?.parts ?? []) { const t = byId.get(String(p.id)); if (t) PART_TYPE.set(p.part, t); }
}
// Per-asset orientation calibration (the meshCorrection PART_MANIFEST calls for). Tubes (`rohr`) and the
// flat sheets (`blech`/perf/loch/kurz/biblio + glass `glas`) share a native .3d frame rotated +90° about
// X from RealityKit's (a tube reads long along local Y, a sheet lies in the X-Z plane) — so the solver's
// pos+quat seats them edge-/face-on. Rotate y->z so they stand on their faces. Anchored on a trailing
// digit so clips/hinges (glashalter, glasscharnier) are NOT caught. Feet/connectors need no correction.
function meshCorrect(type: string, v: number[]): number[] {
  // Source .3d frames are NOT uniform, so the correction is per-family (an allow-list — default is raw):
  //  • Tubes (rohr) + the flat metal sheets (blech/perf/loch/kurz/biblio) are authored Z-up; rotate y<-z so
  //    they stand on their faces in RealityKit's Y-up world. Verified flush on every face orientation.
  //  • Leveling feet (hallerfuss) need that PLUS a 180° flip (authored stem-up) -> [x, z, -y].
  //  • Glass, glashalter clips, hardware and ball connectors are authored in / symmetric about the Y-up
  //    frame already and their solved quat assumes the RAW mesh — correcting glass stands it 90° on edge
  //    (perpendicular to the opening). So they stay as-is.
  if (/^(rohr|blech|perfblech|lochblech|kurzblech|biblioblech)\d/.test(type)) return [v[0], -v[2], v[1]];
  if (/fuss/i.test(type)) return [v[0], v[2], -v[1]];
  return v;
}
// smooth per-vertex normals (average of incident face normals) so the client can light the mesh
function vertexNormals(pos: number[][], tri: number[]): number[][] {
  const n = pos.map(() => [0, 0, 0]);
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const a = pos[tri[i]], b = pos[tri[i + 1]], c = pos[tri[i + 2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const k of [tri[i], tri[i + 1], tri[i + 2]]) { n[k][0] += fx; n[k][1] += fy; n[k][2] += fz; }
  }
  return n.map((v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; });
}

// Attach the exact droppable options to each open face slot. A tube-bounded bay takes a panel that
// spans the WHOLE opening (not "anything that fits within" it), so the only real choice is the material —
// the size is fixed by the face's own dims. We emit one ready-to-place one52 id per material that has a
// mesh at exactly this size, so the client renders these directly and can never offer a mismatched size.
function withSlotOptions(payload: any): any {
  const idx = meshIndex();
  const has = (kind: string, e0: number, e1: number) =>
    (idx[kind] ?? []).some(([a, b]: number[]) => (a === e0 * 10 && b === e1 * 10) || (a === e1 * 10 && b === e0 * 10));
  for (const s of payload?.slots ?? []) {
    if (s.kind !== "face" || !Array.isArray(s.dims) || s.dims.length < 2) continue;
    const [e0, e1] = s.dims, W = e0 * 10, H = e1 * 10;   // bay edge cm -> panel id mm
    // `material` tells the client how to render each sheet: solid metal, fine "mesh" perforation, or
    // round-hole "perforated". (Acoustic = any of these + a felt pad; that's a feature toggle, not yet wired.)
    // One perforated product (mesh and perforated are the same panel — prefer "Perforated"). Acoustic is the
    // same panel + a felt pad, offered only where a vlies pad exists at this size.
    const canAcoustic = has("vlies", e0, e1);
    const opts: Array<{ part: string; family: string; label: string; material: string; acoustic?: boolean }> = [];
    if (has("blech", e0, e1)) opts.push({ part: `metal-panel-${W}x${H}`, family: "panel", label: "Metal", material: "metal" });
    if (has("lochblech", e0, e1)) {
      opts.push({ part: `perforated-metal-panel-${W}x${H}`, family: "panel", label: "Perforated", material: "perforated" });
      if (canAcoustic) opts.push({ part: `perforated-metal-panel-${W}x${H}`, family: "panel", label: "Perforated + Acoustic", material: "perforated", acoustic: true });
    }
    if (has("glas", e0, e1)) opts.push({ part: `glass-${W}x${H}`, family: "glass", label: "Glass", material: "glass" });
    s.options = opts;   // [] when nothing has a mesh at this size -> client shows no placeable material
  }
  return payload;
}

// re-solve + re-classify the session config; returns { placement, payload } (IP-safe) or null on solver failure.
function resolveConfig(cfgPath: string): { placement: any; payload: any } | null {
  const r = spawnSync(process.execPath, ["src/engine/solve.ts", cfgPath], { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, USE_STORED_MATES: "1" } });
  const pf = join(ROOT, "out", "placement.json");
  if (r.status !== 0 || !existsSync(pf)) return null;
  spawnSync(process.execPath, ["src/engine/clauses.ts", cfgPath], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  const placement = JSON.parse(readFileSync(pf, "utf8"));
  const cf = join(ROOT, "out", "conflicts.json");
  const conflicts = existsSync(cf) ? JSON.parse(readFileSync(cf, "utf8")) : null;
  const xml = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : undefined;
  const payload = withSlotOptions(customerPayload(placement, conflicts, xml));
  recordPartTypes(placement, payload);
  return { placement, payload };
}
// one52 part-id -> internal component type. Prefer a type already in the scene (exact); otherwise
// reconstruct the internal type for the v1-droppable families and confirm it round-trips through
// identity() — so an unknown id resolves to null, never a fabricated type. This is what lets the
// FIRST metal panel (or a tube of a size not yet present) be dropped onto a scene that lacks it.
function candidateTypes(partId: string): string[] {
  let m: RegExpMatchArray | null;
  if ((m = partId.match(/^tube-(\d+)$/))) return [`rohr${m[1]}`];
  if ((m = partId.match(/^metal-panel-(\d+)x(\d+)$/))) return [`blech${m[1]}_${m[2]}`, `blech${m[2]}_${m[1]}`];
  if ((m = partId.match(/^glass-(\d+)x(\d+)$/))) return [`glas${m[1]}_${m[2]}`, `glas${m[2]}_${m[1]}`];
  // "Mesh" and "Perforated" are the SAME product (a holed metal panel); we prefer "Perforated" and back it
  // with lochblech (round holes). typeForPart normalises the legacy `mesh-panel-*` id to this one.
  if ((m = partId.match(/^perforated-metal-panel-(\d+)x(\d+)$/))) return [`lochblech${m[1]}_${m[2]}`, `lochblech${m[2]}_${m[1]}`];
  return [];
}
function typeForPart(xml: string, partId: string): string | null {
  partId = partId.replace(/^mesh-panel-/, "perforated-metal-panel-");   // legacy alias: mesh == perforated
  for (const p of parseConfig(xml).parts) if (identity(p.type).part === partId) return p.type;
  for (const t of candidateTypes(partId)) if (identity(t).part === partId) return t;
  return null;
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/health") return send(res, 200, JSON.stringify({ ok: true, model: existsSync(MODEL), auth: !!SUPA_URL }));
    if (req.method === "GET" && url === "/login") return send(res, 200, readFileSync(join(ROOT, "ui", "login.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/api/config") return send(res, 200, JSON.stringify({ supabaseUrl: PUB_URL, supabaseAnonKey: PUB_KEY, authEnforced: !!SUPA_URL }));
    // Public demo scene — a pre-solved, IP-safe /api/configure payload. No auth, so a live demo can
    // never be blocked by sign-in. Same shape as POST /api/configure.
    if (req.method === "GET" && url === "/api/demo")
      return send(res, 200, existsSync(DEMO) ? readFileSync(DEMO, "utf8") : JSON.stringify({ error: "no demo payload bundled" }));
    // Public base model to start a configuration from (no auth).
    if (req.method === "GET" && url === "/api/start")
      return send(res, 200, existsSync(START) ? readFileSync(START, "utf8") : JSON.stringify({ error: "no start payload bundled" }));
    if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, readFileSync(UI, "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/configurator") return send(res, 200, readFileSync(join(ROOT, "ui", "configurator.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/matrix") return send(res, 200, readFileSync(join(ROOT, "ui", "matrix.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/api/mesh") {           // INTERNAL: real part geometry + dims for the configurator
      const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const name = q.get("name") ?? "", lod = q.get("lod") ?? undefined;
      try { return send(res, 200, JSON.stringify(loadMesh(name, lod))); } catch (e: any) { return send(res, 200, JSON.stringify({ name, error: String(e?.message ?? e) })); }
    }
    if (req.method === "GET" && url === "/api/meshindex") return send(res, 200, JSON.stringify(meshIndex()));  // available sizes per kind
    if (req.method === "GET" && url === "/api/placement") {      // the engine's SOLVED scene: every part's world transform (pos+quat), validated EXACT vs P'X5
      const f = join(ROOT, "out", "placement.json");
      return send(res, 200, existsSync(f) ? readFileSync(f, "utf8") : JSON.stringify({ error: "no placement.json — run `node src/engine/solve.ts`" }));
    }
    if (req.method === "GET" && url === "/api/plausibility") {   // INTERNAL: per-part allowed-parameter rules (size/mountingheight/requires/conflicts)
      const t = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("type");
      const all = plausibility();
      return send(res, 200, JSON.stringify(t ? (all[t] ?? { type: t, error: "no plausibility rule for this type" }) : all));
    }
    if (req.method === "GET" && url === "/api/docks") {          // INTERNAL: real snap/dock rules for a component
      const part = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("part") ?? "";
      try { return send(res, 200, JSON.stringify(loadDocks(part))); } catch (e: any) { return send(res, 200, JSON.stringify({ part, error: String(e?.message ?? e) })); }
    }
    if (req.method === "GET" && url === "/api/model") return send(res, 200, JSON.stringify(mergedModel()));
    if (req.method === "GET" && url === "/api/overrides") return send(res, 200, JSON.stringify(loadOverlay()));

    if (req.method === "GET" && url === "/api/manifest") {
      const mf = join(ROOT, "out", "part_manifest.json");
      if (!existsSync(mf)) spawnSync(process.execPath, ["src/engine/manifest.ts"], { cwd: ROOT, timeout: 60000 });
      return send(res, 200, existsSync(mf) ? readFileSync(mf, "utf8") : JSON.stringify({ owner: "one52", parts: [] }));
    }

    if (req.method === "GET" && url === "/api/glossary") {
      const gf = join(ROOT, "glossary.json");
      return send(res, 200, existsSync(gf) ? readFileSync(gf, "utf8") : JSON.stringify({ stems: {}, qualifiers: {}, features: {} }));
    }

    if (req.method === "GET" && url === "/api/placement") {
      const pf = join(ROOT, "out", "placement.json");
      if (!existsSync(pf)) {
        const r = spawnSync(process.execPath, ["src/engine/solve.ts"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
        if (!existsSync(pf)) return send(res, 200, JSON.stringify({ parts: [], connections: [], error: "solver produced no placement", log: r.stdout }));
      }
      const pl = JSON.parse(readFileSync(pf, "utf8"));
      const query = (req.url ?? "").split("?")[1] ?? "";
      if (/coords=(realitykit|ios)/.test(query)) { // app-facing one52 payload -> require auth
        if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
        return send(res, 200, JSON.stringify(placementToRK(pl)));
      }
      return send(res, 200, JSON.stringify(pl)); // raw (internal/editor; expose only on localhost)
    }

    if (req.method === "POST" && url === "/api/override") {
      const { kind, key, patch } = await readBody(req);
      if (!["property", "clause"].includes(kind) || !key) return send(res, 400, JSON.stringify({ error: "kind+key required" }));
      const ov = loadOverlay();
      const bucket = kind === "property" ? ov.properties : ov.clauses;
      if (patch == null || (typeof patch === "object" && Object.keys(patch).length === 0)) delete bucket[key];
      else bucket[key] = { ...(bucket[key] ?? {}), ...patch };
      saveOverlay(ov);
      return send(res, 200, JSON.stringify({ ok: true, overlay: { properties: Object.keys(ov.properties).length, clauses: Object.keys(ov.clauses).length } }));
    }

    if (req.method === "POST" && url === "/api/reset") { saveOverlay(emptyOverlay()); return send(res, 200, JSON.stringify({ ok: true })); }

    // Ingest an uploaded .pxpz project: extract config.px5 server-side, solve, return the one52
    // (RealityKit) payload. The app uploads the proprietary file and gets back one52-only data.
    if (req.method === "POST" && url === "/api/solve-pxpz") {
      if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
      const buf = await readRawBody(req);
      const cfg = extractConfigPx5(buf);
      if (!cfg) return send(res, 400, JSON.stringify({ error: "no config.px5 found in .pxpz" }));
      const tmp = join(ROOT, "out", "upload_config.px5");
      writeFileSync(tmp, cfg.data);
      const r = spawnSync(process.execPath, ["src/engine/solve.ts", tmp], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
      const pf = join(ROOT, "out", "placement.json");
      if (r.status !== 0 || !existsSync(pf)) return send(res, 500, JSON.stringify({ error: "solver failed", log: (r.stdout ?? "") + (r.stderr ?? "") }));
      return send(res, 200, JSON.stringify(placementToRK(JSON.parse(readFileSync(pf, "utf8")))));
    }

    // Configurator core: Path P (columnWidths/rowHeights/depth/cells/...) -> derived frame geometry +
    // quantity BOM + dimension validation, IP-safe. No auth (the dimensions editor calls this live).
    if (req.method === "POST" && url === "/api/build") {
      const p = await readBody(req);
      const { parts, issues } = buildFrame(p);
      const counts = { severe: issues.filter((i: any) => i.level === "severe").length, warning: issues.filter((i: any) => i.level === "warning").length, info: 0 };
      const fired = issues.map((it: any, k: number) => ({ type: "build_" + k, level: it.level, category: "Configuration", name: it.title, problem: it.detail, solution: "", parts: [] }));
      const payload = customerPayload({ parts }, { counts, fired, affordances: [] });
      return send(res, 200, JSON.stringify({ ...payload, options: gridOptions(p) }));
    }

    // Customer app: ONE IP-safe payload = placement + conflicts + BOM (one52 ids/EN labels/RealityKit
    // geometry; no USM codes/article numbers/prices). POST a .pxpz to solve it; empty body returns the
    // last-solved scene. This is the contract the iOS app consumes.
    if (req.method === "POST" && url === "/api/configure") {
      if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
      const buf = await readRawBody(req);
      const pf = join(ROOT, "out", "placement.json"), cf = join(ROOT, "out", "conflicts.json");
      let cfgXml: string | undefined; // emit slots only when THIS request solved a known config (not the last-scene fallback)
      if (buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) { // "PK" -> a .pxpz upload: re-solve both on it
        const cfg = extractConfigPx5(buf);
        if (!cfg) return send(res, 400, JSON.stringify({ error: "no config.px5 found in .pxpz" }));
        const tmp = join(ROOT, "out", "upload_config.px5");
        writeFileSync(tmp, cfg.data);
        cfgXml = cfg.data.toString("utf8");
        const r = spawnSync(process.execPath, ["src/engine/solve.ts", tmp], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
        if (r.status !== 0 || !existsSync(pf)) return send(res, 500, JSON.stringify({ error: "solver failed", log: (r.stdout ?? "") + (r.stderr ?? "") }));
        spawnSync(process.execPath, ["src/engine/clauses.ts", tmp], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
      } else if (!existsSync(pf)) {
        // nothing solved yet on this host -> fall back to the bundled demo scene rather than erroring
        if (existsSync(DEMO)) return send(res, 200, readFileSync(DEMO, "utf8"));
        return send(res, 400, JSON.stringify({ error: "no solved scene — POST a .pxpz to configure" }));
      }
      const placement = JSON.parse(readFileSync(pf, "utf8"));
      const conflicts = existsSync(cf) ? JSON.parse(readFileSync(cf, "utf8")) : null;
      const payload = withSlotOptions(customerPayload(placement, conflicts, cfgXml));
      recordPartTypes(placement, payload);
      return send(res, 200, JSON.stringify(payload));
    }

    // App-facing real geometry: the actual part mesh for a one52 part id, so the client renders real
    // tubes/panels/hardware instead of primitives. Auth-gated; IP-safe (keyed by one52 id, returns only
    // positions/triangles in metres with the per-asset orientation baked in — the client applies just
    // pos+quat). The part must have appeared in a solved scene this session (so its type is known).
    if (req.method === "GET" && url === "/api/part-mesh") {
      if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
      const qp = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const part = qp.get("part") ?? "";
      const acoustic = qp.get("acoustic") === "1";   // request the felt-backed (Akustik) variant of this panel
      const type = PART_TYPE.get(part);
      if (!type) return send(res, 404, JSON.stringify({ error: "unknown part — solve a scene containing it first", part }));
      try {
        const m = loadMesh(type) as any;
        if (!m.positions) return send(res, 404, JSON.stringify({ error: "no mesh for part", part }));
        let nativePos = m.positions as number[][];
        let tris = m.triangles as number[];
        // Acoustic panel = the sheet PLUS a felt (vlies) pad authored to sit inside its lip tray. The bare
        // sheet alone leaves an acoustic panel looking hollow, so when the acoustic variant is requested we
        // merge the matching vlies{L}_{W} pad into the same mesh (same native frame -> it lands in the tray;
        // one meshCorrect covers both). padTriStart marks where the felt triangles begin so the client can
        // give them a matte-fabric material (the merged mesh otherwise renders single-material); -1 = no pad.
        let padTriStart = -1;
        const dm = acoustic ? part.match(/(\d+)x(\d+)$/) : null;   // panel ids end in WxH (mm)
        if (dm) {
          const pad = [loadMesh(`vlies${dm[1]}_${dm[2]}`), loadMesh(`vlies${dm[2]}_${dm[1]}`)].find((p: any) => p?.positions) as any;
          if (pad) { padTriStart = tris.length / 3 | 0; const base = nativePos.length; nativePos = nativePos.concat(pad.positions); tris = tris.concat(pad.triangles.map((i: number) => i + base)); }
        }
        const positions = nativePos.map((v: number[]) => { const c = meshCorrect(type, v); return [c[0] * 0.001, c[1] * 0.001, c[2] * 0.001]; }); // mm -> m, corrected
        const normals = vertexNormals(positions, tris);   // per-vertex, so RealityKit can light it
        return send(res, 200, JSON.stringify({ part, units: "m", verts: positions.length, tris: (tris.length / 3) | 0, padTriStart, positions, normals, triangles: tris }));
      } catch (e: any) { return send(res, 500, JSON.stringify({ error: String(e?.message ?? e), part })); }
    }

    // ---- interactive editing: a working scene the app drags catalog parts onto (config mutation + re-solve) ----
    // POST /api/session: seed a working scene from an uploaded .pxpz (or the dev seed). Returns { sessionId, ...payload }.
    if (req.method === "POST" && url === "/api/session") {
      if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
      const buf = await readRawBody(req);
      let baseXml: string | null = null;
      if (buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) { const cfg = extractConfigPx5(buf); if (cfg) baseXml = cfg.data.toString("utf8"); }
      if (!baseXml) baseXml = existsSync(SEED_CFG) ? readFileSync(SEED_CFG, "utf8") : null;
      if (!baseXml) return send(res, 400, JSON.stringify({ error: "no base scene (POST a .pxpz; no dev seed present)" }));
      mkdirSync(SESS_DIR, { recursive: true });
      const id = newSessionId(), cfgPath = join(SESS_DIR, id + ".px5");
      writeFileSync(cfgPath, baseXml); SESSIONS.set(id, cfgPath);
      const out = await serialize(() => resolveConfig(cfgPath));
      if (!out) { SESSIONS.delete(id); return send(res, 500, JSON.stringify({ error: "seed scene failed to solve" })); }
      return send(res, 200, JSON.stringify({ sessionId: id, ...out.payload }));
    }

    // POST /api/place: drop a catalog part onto the scene. Body { sessionId, part, target }. Re-solves; on
    // an invalid joint it reverts the mutation and returns { ok:false, rejected:{ reason } }.
    if (req.method === "POST" && url === "/api/place") {
      if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
      const { sessionId, part, target, acoustic } = await readBody(req);
      const cfgPath = SESSIONS.get(String(sessionId));
      if (!cfgPath || !existsSync(cfgPath)) return send(res, 400, JSON.stringify({ ok: false, error: "unknown session" }));
      const result = await serialize(() => {
        const xml = readFileSync(cfgPath, "utf8");
        const type0 = typeForPart(xml, String(part));
        if (!type0) return { ok: false, rejected: { reason: `unknown part '${part}'` } };
        const corners = Array.isArray(target?.corners) ? target.corners.map(String) : [];
        // Ordered (internal type, rotation) attempts; the first that seats wins. Sheet panels all dock
        // via blech2rohr (solid blech + perforated lochblech/perfblech + kurz/biblio place identically);
        // glass docks via 4 glashalter clips; tubes via addTubeOnEdge. Doors aren't wired yet.
        let attempts: { type: string; rot: number; kind: "tube" | "panel" | "glass" }[] = [];
        if (target?.kind === "edge" && Array.isArray(target.between) && target.between.length === 2 && /^rohr/.test(type0)) {
          attempts = [{ type: type0, rot: 0, kind: "tube" }];
        } else if (target?.kind === "face" && corners.length === 4 && /^(blech|lochblech|perfblech|kurzblech|biblioblech)\d/.test(type0)) {
          // Try BOTH dimension orders × 4 rotations: a face emitted as 35×75 resolves to blechW_H whose
          // learned mates may only exist for the swapped order (same panel, other label).
          const swapped = type0.replace(/(\d+)_(\d+)/, (_m, w, h) => `${h}_${w}`);
          const types = swapped === type0 ? [type0] : [type0, swapped];
          attempts = types.flatMap((t) => [0, 1, 2, 3].map((rot) => ({ type: t, rot, kind: "panel" as const })));
        } else if (target?.kind === "face" && corners.length === 4 && /^glas\d+_\d+$/.test(type0)) {
          attempts = [{ type: type0, rot: 0, kind: "glass" }];
        } else {
          return { ok: false, rejected: { reason: `slot kind '${target?.kind}' for ${type0} not supported yet (edge/tube, face/sheet-panel incl. perforated, face/glass; doors need hardware wiring)` } };
        }
        console.log(`[place] part='${part}' target=${target?.kind} corners=[${corners}] -> ${attempts.length} attempt(s)`);
        let reason = "could not place — no valid joint, or the part doesn't fit this face";
        for (const a of attempts) {
          let cand: { xml: string; newId: string; wiring?: { panelDock: number; tubeId: string; tubeIndex: number }[] };
          try {
            cand = a.kind === "tube" ? addTubeOnEdge(xml, String(target.between[0]), String(target.between[1]), a.type)
                 : a.kind === "glass" ? addGlassOnFace(xml, corners, a.type)
                 : addPanelOnFace(xml, corners, a.type, a.rot, acoustic === true);
          } catch (e: any) { reason = String(e?.message ?? e); console.log(`[place]   ${a.type} rot${a.rot}: skip — ${reason}`); continue; }
          writeFileSync(cfgPath, cand.xml);
          const out = resolveConfig(cfgPath);
          if (!out) { reason = "the solver failed on the resulting configuration"; console.log(`[place]   ${a.type} rot${a.rot}: solver failed`); writeFileSync(cfgPath, xml); continue; }
          const added = out.placement.parts.find((p: any) => p.id === cand.newId);
          const placed = added && added.placed !== false;
          const resid = cand.wiring ? panelFitResidual(out.placement, cand.newId, cand.wiring) : (placed ? 0 : Infinity);
          if (placed && resid < 0.5) { console.log(`[place]   ${a.type} rot${a.rot}: OK (residual ${resid.toFixed(2)}cm) -> id ${cand.newId}`); return { ok: true, addedId: cand.newId, ...out.payload }; }
          reason = !placed ? `no mate to seat '${a.type}' on these tubes`
                 : `'${a.type}' seated off-alignment (${resid.toFixed(1)}cm gap)`;
          console.log(`[place]   ${a.type} rot${a.rot}: ${reason}`);
          writeFileSync(cfgPath, xml); // revert, try the next attempt
        }
        console.log(`[place] REJECT '${part}': ${reason}`);
        return { ok: false, rejected: { reason } };
      });
      return send(res, result.ok ? 200 : 422, JSON.stringify(result));
    }

    // POST /api/remove: delete a part (and its dock wiring) from the session scene. Body { sessionId, partId }.
    if (req.method === "POST" && url === "/api/remove") {
      if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
      const { sessionId, partId } = await readBody(req);
      const cfgPath = SESSIONS.get(String(sessionId));
      if (!cfgPath || !existsSync(cfgPath)) return send(res, 400, JSON.stringify({ ok: false, error: "unknown session" }));
      const result = await serialize(() => {
        const xml = readFileSync(cfgPath, "utf8");
        let nx: string; try { nx = removePart(xml, String(partId)); } catch (e: any) { return { ok: false, rejected: { reason: String(e?.message ?? e) } }; }
        writeFileSync(cfgPath, nx);
        const out = resolveConfig(cfgPath);
        if (!out) { writeFileSync(cfgPath, xml); return { ok: false, rejected: { reason: "solver failed" } }; }
        return { ok: true, ...out.payload };
      });
      return send(res, result.ok ? 200 : 422, JSON.stringify(result));
    }

    // GET /api/scene/:id: the current IP-safe payload for a session (re-sync).
    if (req.method === "GET" && url.startsWith("/api/scene/")) {
      if (!(await verifyJwt(req))) return send(res, 401, JSON.stringify({ error: "unauthorized — Supabase JWT required" }));
      const id = url.slice("/api/scene/".length);
      const cfgPath = SESSIONS.get(id);
      if (!cfgPath || !existsSync(cfgPath)) return send(res, 404, JSON.stringify({ error: "unknown session" }));
      const out = await serialize(() => resolveConfig(cfgPath));
      return send(res, out ? 200 : 500, JSON.stringify(out ? { sessionId: id, ...out.payload } : { error: "solve failed" }));
    }

    // Error handler: classified conflict catalog + any fired on the last-solved scene.
    if (req.method === "GET" && url === "/api/conflicts") {
      const cf = join(ROOT, "out", "conflicts.json");
      if (!existsSync(cf)) spawnSync(process.execPath, ["src/engine/clauses.ts"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
      if (!existsSync(cf)) return send(res, 200, JSON.stringify({ catalog: [], fired: [], counts: { severe: 0, warning: 0, info: 0 }, error: "no conflicts.json" }));
      return send(res, 200, readFileSync(cf, "utf8"));
    }

    if (req.method === "POST" && url === "/api/run") {
      const { script } = await readBody(req);
      const file = script === "conflicts" ? "src/engine/clauses.ts" : script === "validate" ? "src/engine/validate.ts" : script === "solve" ? "src/engine/solve.ts" : null;
      if (!file) return send(res, 400, JSON.stringify({ error: "script must be validate|conflicts|solve" }));
      const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
      return send(res, 200, JSON.stringify({ ok: r.status === 0, stdout: (r.stdout ?? "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "") }));
    }

    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e: any) {
    return send(res, 500, JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

await bootstrap(); // hosted deploys: fetch engine data from the locked bucket if missing (no-op locally)
server.listen(PORT, () => console.log(`USM engine -> http://localhost:${PORT}  (auth: ${SUPA_URL ? "Supabase JWT" : "open/local"})`));
