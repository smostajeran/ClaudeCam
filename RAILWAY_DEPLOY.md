# Deploy the engine host on Railway

The container ships **code only**. The proprietary runtime data (decoded cartridge, `model.json`,
`database.xml`) is fetched at boot from the Supabase `proprietary` bucket (see `bootstrap.ts`), so
nothing proprietary lives in the image or the repo. Auth is enforced via Supabase JWT (see
[SUPABASE_BACKEND.md](SUPABASE_BACKEND.md)).

## 1. Build the data bundle (once) and upload it
Create `engine-data.zip` with these paths (relative to the container root `/app`):

```
out/model.json                                              ← usm-engine/out/model.json
database.xml                                                ← usm-engine/database.xml
data/co/appcodes/                                           ← snx2xml/co/appcodes/  (all *.xml)
data/co/packages/hallerpackage/cartridge/componentsystem.xml ← from snx2xml/...
```
(`USM_DATA=/app/data`, so the cartridge resolves under `data/`. `glossary.json` is already in the image.)

Upload `engine-data.zip` into the **`proprietary`** bucket of the `usm-engine` Supabase project
(dashboard → Storage → proprietary → upload, or the storage API with the service_role key).

## 2. Deploy
```bash
npm i -g @railway/cli
railway login
railway init           # create a project/service (or `railway link` to an existing one)
railway up             # builds the Dockerfile, deploys
```

## 3. Set environment variables (Railway → Variables)
| Var | Value |
|---|---|
| `SUPABASE_URL` | `https://jbmbhhbglcclgnpagwhg.supabase.co` |
| `SUPABASE_ANON_KEY` | `sb_publishable_vQmkcd0V_hXs0HQeFT0lFQ_xwdGzG9x` (JWT-verify apikey) |
| `SUPABASE_SERVICE_ROLE_KEY` | *(secret — from the Supabase dashboard; lets bootstrap read the bucket)* |
| `ENGINE_DATA_OBJECT` | `engine-data.zip` (default) |
| `USM_DATA` | `/app/data` (already set in the Dockerfile) |

`PORT` is injected by Railway automatically. Redeploy after setting vars so `bootstrap` runs with them.

## 4. Verify
```bash
curl https://<your-service>.up.railway.app/health
# -> {"ok":true,"model":true,"auth":true}   (model:true means the bundle unpacked)
```
Then from the app: sign in with Supabase Auth, `POST /api/solve-pxpz` with `Authorization: Bearer
<jwt>` and the `.pxpz` body → one52 payload. Without a valid token → 401.

## Notes
- **Alternative to bucket-fetch:** attach a Railway Volume at `/app/data` (+ place `out/model.json`
  and `database.xml`) and skip the service_role key. The bucket approach keeps the data in one
  locked place.
- Node 24 runs the `.ts` directly — no build step. One dependency (`fast-xml-parser`).
- Keep the rule-editor endpoints (`/api/model`, overrides, manifest, raw `/api/placement`) off the
  public host or behind a network rule; only `/api/solve-pxpz` + RealityKit placement are meant to
  be app-facing (and they require the JWT).
