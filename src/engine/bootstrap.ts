// Startup bootstrap (for hosted deploys, e.g. Railway): if the engine's runtime data is missing,
// download `engine-data.zip` from the Supabase 'proprietary' bucket (service_role) and unpack it.
// This keeps proprietary data OUT of the container image — it lives only in the locked bucket and
// is fetched at boot. No-op locally (data already present) or if creds are absent.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAllToDir } from "./pxpz.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function bootstrap(): Promise<void> {
  if (existsSync(join(ROOT, "out", "model.json"))) return; // data already present (local dev / volume)
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.log("[bootstrap] no model.json and no SUPABASE service creds — /api/solve-pxpz will 500 until engine data is provided"); return; }
  const obj = process.env.ENGINE_DATA_OBJECT ?? "engine-data.zip";
  try {
    console.log(`[bootstrap] fetching ${obj} from Supabase 'proprietary' bucket…`);
    const r = await fetch(`${url}/storage/v1/object/proprietary/${obj}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) { console.log(`[bootstrap] download failed: HTTP ${r.status}`); return; }
    const n = extractAllToDir(Buffer.from(await r.arrayBuffer()), ROOT);
    console.log(`[bootstrap] unpacked ${n} files (out/model.json present: ${existsSync(join(ROOT, "out", "model.json"))})`);
  } catch (e: any) { console.log(`[bootstrap] error: ${e?.message ?? e}`); }
}
