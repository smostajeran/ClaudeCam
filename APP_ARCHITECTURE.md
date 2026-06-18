# one52 USM app — architecture

## 1. Scope (decided)
- **Interactive configurator from day one** — users build/edit the shelf in-app, not just view.
- **AR** (place the unit in the customer's room) is a key feature.
- **Staff first, customers later** — build for provisioned staff; design so it can open to the public.
- **3D assets (.usdc): status TBD** — either reuse the current native app's meshes or author them.
  Resolve this first (see §5); it gates rendering.

## 2. System shape
`iOS app (SwiftUI + RealityKit)` ⟷ `Engine (Railway, JWT-gated)` ⟷ `Supabase (auth · private storage · RLS DB)`.
The engine stays the source of truth for geometry + rules and only ever returns the **one52 payload**
(no USM codes/prices). The app renders it from bundled `.usdc`.

## 3. The long pole — engine **Configuration API** (new)
"Interactive from day one" means the engine must go from *"solve a given `.pxpz`"* to *"build + validate
a configuration as the user edits it."* Recommended **stateless** design (app holds the config; engine is
a pure function → scales, no sessions):

`POST /api/configure` (JWT) — body = the current one52 `Configuration` (+ optional pending edit). Returns:
- **placement** — one52 RealityKit payload (geometry) for the valid parts.
- **conflicts** — constraint violations from the model's clauses (the 124 clauses already imported).
- **bom** — one52 catalog rollup.
- **affordances** — for each open dock, the valid partner part-types (from `docksystem` partnerdocks) +
  grid cells where a part may be added. This is what powers "tap an empty slot → ghost preview → add".

Edits (`addPart`, `removePart`, `setFeature/colour`, `connect/disconnect`) are applied to the config
**client-side**, then the config is re-sent (or diffed). Reuses what exists: placement solver, clause
evaluator, feature eval, dockTypes. **New work:** affordance computation + an edit/validation layer + the
endpoint. *(Also fix the project-2 rigid-cluster placement offset before relying on arbitrary configs.)*

## 4. iOS app (clean architecture / MVVM)
- **Presentation (SwiftUI):** Login → Projects → **Configurator** (grid + part palette + inspector) → AR → BOM/quote.
- **Rendering (RealityKit):** `SceneBuilder(payload, manifest)` → entities; ghost previews from `affordances`;
  selection, move/replace gizmos; conflict highlights.
- **AR (ARKit):** plane detection, true-scale placement (engine is mm/m), move/rotate, LiDAR occlusion, snapshot/share.
- **Domain:** `Configuration` (components + connections + features), `Part`, `EditOp`; use-cases (configure, save, list).
- **Services:** `AuthService` (Supabase SDK), `EngineClient` (`/api/configure`, `/api/solve-pxpz`),
  `SupabaseRepo` (projects/placements via PostgREST + Storage), `AssetManager` (`.usdc` + `PART_MANIFEST.md` +
  per-mesh `meshCorrection`).
- **State:** a `ConfiguratorStore` holding the config + last engine response; optimistic local edits, reconcile on response.
- **Cache:** last payloads + assets for offline viewing.

**Interactive loop:** edit → update local `Configuration` → `POST /api/configure` → render placement,
show conflicts, refresh affordances (ghosts).

## 5. Assets (.usdc) — resolve first (gates rendering)
- one52 part id ⟷ `.usdc` via `PART_MANIFEST.md` (443 ids); `meshCorrection` calibrated **once per asset** (§5 of IOS_INTEGRATION.md).
- **First task:** inventory the current native app's `.usdc` against the 443 ids → gap list → decide reuse vs author.
- Bundle in the app for P1; move to on-demand download (Supabase Storage/CDN) when the customer build needs the full set.

## 6. Auth & distribution
- **Staff (now):** provisioned Supabase users, no signup, TestFlight/MDM. Matches the current lock.
- **Customers (later):** add a **role claim** to the JWT (staff vs customer) now so endpoints/RLS can branch later;
  add guest/anonymous mode (configure without save) + account to save/quote; App Store onboarding + review.

## 7. Roadmap
- **Phase 0 — engine:** Configuration API (`/api/configure`: placement + conflicts + bom + affordances); asset gap inventory; fix the placement offset (rigid-cluster solver).
- **Phase 1 — app MVP (staff):** login → configurator (add/remove/recolour on the grid) → 3D render → save projects.
- **Phase 2 — AR:** room placement, true scale, occlusion, share.
- **Phase 3 — quote + customers:** BOM/PDF/share; guest mode; public App Store build.

## 8. Risks / long poles
1. **Engine Configuration API** (affordances + interactive validation) — the biggest new build; everything interactive depends on it.
2. **Asset coverage TBD** — inventory first; missing `.usdc` blocks rendering.
3. **Placement offset on complex configs** (project-2) — needs the rigid-cluster solver before free-form building.
4. **AR** scale/occlusion polish.
