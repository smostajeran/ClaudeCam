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

const send = (r: any, code: number, body: string, type = "application/json") =>
  r.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(body);

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, readFileSync(UI, "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url === "/api/model") return send(res, 200, JSON.stringify(mergedModel()));
    if (req.method === "GET" && url === "/api/overrides") return send(res, 200, JSON.stringify(loadOverlay()));

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

    if (req.method === "POST" && url === "/api/run") {
      const { script } = await readBody(req);
      const file = script === "conflicts" ? "src/engine/clauses.ts" : script === "validate" ? "src/engine/validate.ts" : null;
      if (!file) return send(res, 400, JSON.stringify({ error: "script must be validate|conflicts" }));
      const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
      return send(res, 200, JSON.stringify({ ok: r.status === 0, stdout: (r.stdout ?? "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "") }));
    }

    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e: any) {
    return send(res, 500, JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

server.listen(PORT, () => console.log(`USM rule editor -> http://localhost:${PORT}  (overlay: ${OVERLAY})`));
