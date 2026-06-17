// Rule-editor backend: a tiny zero-dependency HTTP server (node:http) that exposes the imported
// model and the engine's validators to the browser UI in ui/index.html.
//
//   GET  /                  -> the single-file UI
//   GET  /api/model         -> out/model.json with the edit-overlay applied
//   GET  /api/overrides     -> the current overlay (out/overrides.json)
//   POST /api/override      -> {kind:'property'|'clause', key, patch} merged into the overlay
//   POST /api/reset         -> clear the overlay
//   POST /api/run           -> {script:'validate'|'conflicts'} runs the engine validator, returns stdout
//
// The overlay is non-destructive: the decoded source model is never mutated. Run: node src/engine/server.ts
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { placementToRK } from "./export_ios.ts";
import { extractConfigPx5 } from "./pxpz.ts";
import { bootstrap } from "./bootstrap.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // usm-engine/
const MODEL = join(ROOT, "out", "model.json");
const OVERLAY = join(ROOT, "out", "overrides.json");
const UI = join(ROOT, "ui", "index.html");
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

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/health") return send(res, 200, JSON.stringify({ ok: true, model: existsSync(MODEL), auth: !!SUPA_URL }));
    if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, readFileSync(UI, "utf8"), "text/html; charset=utf-8");
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
