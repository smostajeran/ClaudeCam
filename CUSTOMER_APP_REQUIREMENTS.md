# one52 USM — Customer-facing app requirements

A spec to **start the customer app fresh**. The app is a thin client over the engine: it renders and
edits a one52-owned payload and never touches proprietary USM data. Build the frontend and the one
missing engine endpoint in parallel against the contract in §4.

## 1. Goal
A customer designs a USM Haller unit in 3D on their phone, sees **price** and **validity** update live,
previews it in **AR** at true scale, then **saves / shares / requests a quote** — guest-first, no login
required to design.

## 2. Core loop (the MVP)
`Start` → `Configure (3D grid)` → `Validate + price (live)` → `AR preview` → `Save / quote`.
Everything else is around this loop.

## 3. Functional requirements
- **FR1 Start** — choose a template/preset, a blank frame, or (later) a room photo. Always lands the user in an editable configuration.
- **FR2 Configure** — tap an open grid cell → see the **valid parts** for it (affordances) → add; select a placed part → recolour / replace / remove; grow or shrink the frame (bays × heights). Optimistic local edits.
- **FR3 Validate live** — after every edit, show conflicts **classified by severity** (the error handler we built): **severe blocks** the order, **warning/advice** informs. An invalid configuration can never be quoted or ordered.
- **FR4 Price live** — running total + itemised BOM + delivery estimate, recomputed per edit.
- **FR5 AR** — place at true scale (engine is mm/m), walk around, LiDAR occlusion, snapshot + share.
- **FR6 Persistence** — save configurations to an account; shareable link; resume later; version a saved design.
- **FR7 Handoff** — "request quote" / "add to cart" / "contact" produces an order payload for sales/commerce.
- **FR8 Account** — **guest mode** (configure + AR, no save); optional sign-up to save, share, and quote.

## 4. Engine contract (the enabler — build the app against this)
The app calls only these. Stateless: the **app holds the Configuration**; the engine is a pure function.

- **`POST /api/configure`** — *the one missing piece, not built yet.* Body = current `Configuration`
  (+ optional pending edit). Returns:
  - `placement` — one52 RealityKit payload (geometry) for the valid parts.
  - `conflicts` — severity-classified list from the error handler (name, problem, solution, parts).
  - `bom` — priced rollup (customer catalog).
  - `affordances` — for each open dock, the valid partner part-types + grid cells where a part may be added (this powers "tap empty slot → ghost → add").
- **`GET /api/catalog`** *(customer-safe)* — purchasable parts: one52 id, English name, finishes/colours, retail price. **No** German codes, article numbers, or internal pricing.
- **`POST /api/quote`** — `Configuration` → order summary.
- **Already built & reusable:** placement solver (P1 99.5% / P2 95.4%), conflict error-handler
  (46/53 rules live, severity-classified, EN), BOM, JWT auth, Railway deploy behind Supabase.

`Configuration` (client-owned) = components (one52 part ids + finishes) + connections + frame size +
features. Edits applied locally (`addPart`, `removePart`, `setColour`, `connect/disconnect`, `resize`)
then re-sent (or diffed) to `/api/configure`.

## 5. Rendering & assets (gates everything visual)
- Render the one52 payload (`id / part / label / family / pos / quat / role / quad`).
- Each part id ⟷ a `.usdc` mesh via `PART_MANIFEST.md` (443 ids); `meshCorrection` calibrated once per asset.
- **Prerequisite:** inventory the 443 ids against available `.usdc` → author/source the gaps. Until this is done the app can't render arbitrary configurations.

## 6. IP / data boundary (hard requirement, enforced server-side)
The customer app must **never** receive: raw German type codes, USM article numbers, internal
prices/margins, `.snx`/cartridge files, or VCML. It receives only the one52 payload + the customer
catalog (English, retail price). This is non-negotiable and checked at the API layer.

## 7. Non-functional
- **Live feel:** `/api/configure` round-trip target < ~300 ms.
- **Offline:** cache last configuration + its assets for AR/viewing without signal.
- **Localisation:** English first; structure strings for DE/FR/IT later (the engine already resolves EN).
- **Accessibility** + App Store compliance.
- **Auth:** Supabase; anonymous guest + account; add a JWT **role claim** (guest/customer/staff) now so endpoints/RLS can branch later.

## 8. Build order (so the team can start fresh, in parallel)
**P0 — engine (unblocks the app):**
1. `POST /api/configure` (placement + conflicts + bom + **affordances**).
2. `GET /api/catalog` customer-safe subset.
3. Asset gap inventory (443 ids vs `.usdc`).
**P1 — app MVP:** the configure loop (FR2–FR4) + render + save.
**P2 — AR** (FR5). **P3 — quote/checkout + public release** (FR7, guest→account).

## 9. Definition of done (customer MVP)
A guest can start from a template, add/remove/recolour parts on the grid with **live validity + price**,
be **blocked when the design is invalid**, view it in **AR at true scale**, and **request a quote** —
with zero proprietary USM data leaving the server.

## 10. What already exists vs what's new
- **Exists:** placement geometry, conflict detection (error handler), BOM, one52 payload + manifest, auth, deploy.
- **New for customers:** `/api/configure` (esp. **affordances**), customer catalog endpoint, asset coverage, the SwiftUI/RealityKit/ARKit client, guest→account + quote/commerce.
- **The single biggest long pole:** affordances (valid next-parts per open dock) — everything interactive depends on it.
