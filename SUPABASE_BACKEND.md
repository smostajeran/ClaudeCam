# Locked-door backend (Supabase)

Goal: keep the **proprietary engine + data** server-side behind authentication; the iOS app signs
in and receives **only the one52 payload**. Nothing proprietary (USM cartridge, `database.xml`
prices/article numbers, raw German codes) ever ships in the app.

```
iOS app ──(Supabase Auth JWT)──► Supabase (the locked door)
                                   ├── Auth            — only signed-in users get in
                                   ├── Storage (private)— proprietary engine data + user .pxpz
                                   ├── Postgres (RLS)   — one52 catalog/placements (per-user)
                                   └── Edge Function    — runs the engine, returns one52 payload
                                          │  (proprietary data never leaves the server)
                                          ▼
                                   one52 placement.ios.json  ──► app renders
```

Existing project to use: **`furniture-pim`** (`uizxbvgvgmeqktuhfzxo`) — no new project needed.

## What sits behind the door
- **Storage (private bucket `proprietary`)** — `model.json`, `database.xml`, `glossary.json`,
  cartridge files, and uploaded `.pxpz`. Not public; only the edge function (service role) reads it.
- **Postgres + RLS**
  - `part_catalog` — one52 parts (id/label/family/dims). Readable by authenticated users (shippable).
  - `private_article` — USM prices/article numbers/names. **service_role only** (RLS denies anon &
    authenticated) — never exposed to the app.
  - `project` — a user's uploaded configuration (`.pxpz` path). Owner-only RLS.
  - `placement` — the solved one52 payload (jsonb). Owner-only RLS.
- **Edge Function `solve`** — verifies the JWT (the lock), reads the `.pxpz`, runs the engine,
  writes/returns the one52 payload.

## Engine-hosting options (the one real decision)
The current engine is Node (reads multi-MB local files, spawns `solve.ts`). To run it server-side:

| Option | What | Trade-off |
|---|---|---|
| **A. Edge Function (Deno)** | Port `solve` to a Supabase Edge Function; load engine data from the private bucket; `fast-xml-parser` via `npm:`. | Fully inside Supabase. Needs porting (no child_process; fetch data from Storage) + edge CPU/time limits (~150s) — 679-part solve is OK. |
| **B. Separate engine host + Supabase front** | Engine runs as-is on a small container (Fly/Render); Supabase does auth+storage+DB; app passes its JWT, the host verifies it. | Least engine change; one more host to run. |
| **C. Proxy** | Thin edge function authenticates and calls a private engine host. | Engine stays Node; edge is just the gatekeeper. |

Recommendation: **B to start** (engine unchanged, fastest to a working locked door), migrate to **A**
later if you want everything inside Supabase.

## Live (provisioned)
Dedicated project **`usm-engine`** created (org `smostajeran's Org`, ap-south-1, $10/mo).
- project id / ref: `jbmbhhbglcclgnpagwhg`
- API URL: `https://jbmbhhbglcclgnpagwhg.supabase.co`
- publishable key (client-safe): `sb_publishable_vQmkcd0V_hXs0HQeFT0lFQ_xwdGzG9x`
- **service_role key is secret** — read it from the Supabase dashboard; it is what the engine host
  uses to read `private_article` + the `proprietary` bucket. Never ship it in the app.

Done: schema applied (`part_catalog`, `private_article` [service-role only], `project`, `placement`
— all RLS); private storage bucket `proprietary` created; `part_catalog` seeded (proof rows; full
443-row seed in `supabase/seed_catalog.sql`). Security advisor clean (the only notice — RLS-enabled-
no-policy on `private_article` — is intentional: that table is locked to service_role).

## Next (engine host — architecture B)
1. Run the engine (`server.ts`) on a small container with the Supabase **service_role** key in env.
2. Verify the caller's Supabase JWT on `/api/solve-pxpz` (the lock), then solve and return the one52
   payload; optionally upsert `placement`.
3. Upload proprietary engine data (`model.json`, `database.xml`, …) to the `proprietary` bucket; the
   host reads them with the service role (or keeps them on the host only).
4. App: sign in with Supabase Auth → call the host with the JWT → render the one52 payload.
