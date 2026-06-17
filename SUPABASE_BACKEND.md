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

## Apply
Schema in `supabase/migrations/0001_init.sql`. Not applied yet — apply to `furniture-pim` only on
your go-ahead (it modifies the live project).
