# Mapping the USM engine to the iOS (RealityKit) app

**Core idea:** the engine is the single source of truth for *where every part goes and how it is
oriented*. The iOS app should **consume the engine's transforms** and stop hand-deriving
quaternions per part — that hand-derivation is exactly what produced the glass-fitting orientation
bug. The engine's placement is validated **100% against P'X5** (position 0.000 cm; glass fittings
0.000°), so if the app applies those transforms with one consistent coordinate bridge, the fittings
are correct by construction.

```
P'X5 cartridge ──► usm-engine (solve) ──► placement.json ──► iOS app ──► RealityKit scene
   (.snx)            dock-frame solver      (transforms)       load .usdc + apply transform
```

---

## 0. IP separation — internal vs shipped (protect one52's rights)

There are **two** artifacts; keep them apart:

| Artifact | Contents | Audience |
|---|---|---|
| `out/placement.json` (**internal**) | full data incl. raw German codes, USM article numbers, prices, catalog names | one52 tooling only — do **not** bundle in the app |
| `out/placement.ios.json` / `?coords=realitykit` (**shipped**) | one52's own IDs + English labels + geometry only | the iOS app |

The shipped payload is **one52's own derived representation**: our stable IDs, our labels, and the
solved transforms (geometry is a mathematical fact). It deliberately **excludes** the proprietary
Perspectix/USM source identifiers — raw cartridge codes, article numbers, prices — which are
processed internally and never redistributed. (Verified: shipped keys are `id, part, label,
family, pos, quat, role, quad` — no `type`/`artNo`/`price`/`name`.) This protects one52's work
product and keeps USM proprietary data out of the app bundle. (Not legal advice — have counsel
review before distribution.)

## 1. What the app gets (one52 schema)

- **File:** `node src/engine/export_ios.ts` → `out/placement.ios.json`
- **HTTP:** `GET http://<host>:5152/api/placement?coords=realitykit`

```json
{ "meta": { "owner":"one52", "frame":"RealityKit", "units":"m", "up":"Y", "notice":"…" },
  "parts": [
    { "id":"387",
      "part":"glass-hinge-front-upper-left",   // one52 stable id (our own)
      "label":"Glass hinge (front, upper, left)",
      "family":"fitting", "role":"…",
      "pos":[-0.49484,1.8475,0.18957],          // metres, RealityKit (Y-up, right-handed)
      "quat":[0,1,0,0],                          // x,y,z,w
      "quad":[[..],[..],[..],[..]] }             // panels only: 4 world corners (m)
  ],
  "catalog": [ { "part":"tube-350", "label":"Tube 350 mm", "family":"tube" }, … ] }  // distinct parts
```

Coordinate bridge (done by the engine): a single basis change `RotX(-90°)` for **every** part —
`pos(x,y,z)cm → (x, z, -y) m`, `quat' = qR · quat · qR*`, `qR = (-√½,0,0,√½)`. (See
`src/engine/export_ios.ts`.)

---

## 2. Integration architecture — pick one

| Option | How | When |
|---|---|---|
| **A. Batch export (simplest)** | Run `solve.ts` for a config, bundle/fetch `placement.ios.json`, app applies it. | Fixed / pre-defined configurations. **Start here.** |
| **B. Placement service** | Run `server.ts` as an HTTP service; app POSTs a config and fetches `/api/placement?coords=realitykit`. | Live/interactive configuration. |
| **C. Port solver to Swift** | Re-implement `solve.ts` in Swift. | Only if fully offline + interactive is required. Highest cost; the TS engine stays the oracle to test against. |

Recommended: **A now, B when you need live configuration.** Never re-derive transforms in Swift —
consume the engine's.

---

## 3. Applying a part in RealityKit

```swift
struct PlacedPart: Decodable { let id, part, label, family: String; let pos, quat: [Float] }

for p in placement.parts {
    guard let mesh = meshURL(for: p.part) else { continue }       // one52 id → .usdc (see §4)
    let entity = try ModelEntity.load(contentsOf: mesh)

    entity.position    = SIMD3<Float>(p.pos[0], p.pos[1], p.pos[2])  // already metres
    let world = simd_quatf(ix: p.quat[0], iy: p.quat[1], iz: p.quat[2], r: p.quat[3])

    // Per-MESH authored-frame correction (constant per .usdc — see §5):
    entity.orientation = world * meshCorrection(for: p.part)
    anchor.addChild(entity)
}
```

If you fetch the **internal** `placement.json` (P'X5 cm/Z-up) instead, do the basis change yourself:

```swift
let qR = simd_quatf(angle: -.pi/2, axis: [1,0,0])
entity.position    = SIMD3(p.pos[0]*0.01, p.pos[2]*0.01, -p.pos[1]*0.01)
let world = qR * simd_quatf(ix:p.quat[0],iy:p.quat[1],iz:p.quat[2],r:p.quat[3]) * qR.conjugate
```

---

## 4. one52 id → mesh mapping

The shipped payload keys every part by a one52 id (`part`, e.g. `glass-hinge-front-upper-left`,
`tube-350`) — our own stable identifiers, decoupled from USM codes. The `catalog` array lists the
distinct ids in the scene, so the app can build a `part → .usdc` manifest directly from it. Tips:
- Parts sharing a base mesh at different sizes (`tube-350`/`tube-500`/`tube-750`) can map to one
  asset scaled by the dimension carried in the id/label.
- left/right ids are mirror meshes — keep both; the engine's quat already encodes facing.
- `label` + `family` are there for QA overlays and a parts list in the app UI.

---

## 5. The one thing still to calibrate: per-mesh authored frame

The engine's quaternion orients the part's **dock-origin frame** (the frame P'X5 uses). Your `.usdc`
was authored in **some** local frame. If that authored frame ≠ the dock-origin frame, there is a
**fixed rotation per mesh** (`meshCorrection`) — *constant per `.usdc`, NOT per instance*. This is
the real residue of the old bug: it was being guessed per instance; it's actually one constant per
mesh.

**Calibrate once per mesh:**
1. Place one instance with `meshCorrection = identity`.
2. Compare to the same part in P'X5 (or the validated `placement.json` orientation).
3. The constant rotation that aligns them is that mesh's `meshCorrection`. Bake it into the `.usdc`
   (preferred) or store it in the manifest.
4. It then holds for **every** instance and both L/R — verify on a second instance.

Sanity check from this project (RealityKit frame): `glasscharnier_vorne_oben_l` →
`quat [0,1,0,0]` (180° about Y), `glasscharnier_vorne_oben_r` → `quat [0,0,0,1]` (identity). Front
hinges differ L↔R by 180°; **rear** hinges share one frame (mirroring is in the mesh). If your app
reproduces that, the fittings are right.

---

## 6. Checklist
- [ ] Decide A or B (start with A).
- [ ] Load `placement.ios.json` (or fetch `?coords=realitykit`).
- [ ] Build the type → `.usdc` manifest.
- [ ] Apply `position` + `orientation` from the engine; **delete** any per-part quaternion derivation.
- [ ] Calibrate `meshCorrection` once per mesh; verify L/R and a second instance.
- [ ] (Optional) panels: use `quad` corners to validate panel size/orientation; `bom` for a price overlay.
